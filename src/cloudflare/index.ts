import { DurableObject } from "cloudflare:workers";
import { createStorage, type Storage } from "unstorage";
import nullDriver from "unstorage/drivers/null";
import type { AgentAdapter } from "../adapter/types";
import { functionAdapter, resolveAgent } from "../agents";
import { AgentUnitError, RunEngine, type LoadedAgent } from "../runtime/engine";
import { RunStore, type ListRunsFilter } from "../runtime/store";
import { parseDuration, randomId } from "../runtime/util";
import { createHandler, type HandlerOptions, type RequestContext } from "../server/handler";
import type { RunService } from "../server/service";
import type { AgentEvent, Manifest, RunInput, RunRecord } from "../types";
import { durableStorageDriver, indexStorageDriver, type IndexStub } from "./storage";
import type { DurableObjectNamespaceLike, DurableObjectStateLike, ExecutionContextLike } from "./types";

export { durableStorageDriver, indexStorageDriver } from "./storage";
export type * from "./types";

// One Durable Object per run executes it: the object's storage holds the run's journal and events,
// only that object ever runs it (no leases to race), and its alarm wakes sleepers, continues
// yields and recovers a run whose isolate died. One shared index object holds what spans runs:
// the run list, thread/agent/app state and adapter storage.

export interface DurableAgentUnitOptions extends Pick<HandlerOptions, "basePath" | "authorize" | "heartbeatMs" | "version"> {
  name?: string;
  agents: Record<string, unknown>;
  /** Adapters tried before the built-in function adapter. */
  adapters?: AgentAdapter<any>[];
  /**
   * Yield and continue from an alarm after this long. Default `"10m"`, under the 15-minute limit of
   * an alarm invocation. `false` never yields.
   */
  budget?: string | number | false;
  /** Binding names in wrangler.json. Default `AGENT_UNIT_RUNS` and `AGENT_UNIT_INDEX`. */
  bindings?: { runs?: string; index?: string };
}

type Envelope<T> = { ok: T } | { error: { status: 400 | 404 | 409; code: string; message: string } };

async function envelope<T>(work: () => Promise<T>): Promise<Envelope<T>> {
  try {
    return { ok: await work() };
  } catch (error) {
    // Typed errors cross the RPC boundary as data; anything else is a real failure and throws.
    if (error instanceof AgentUnitError) return { error: { status: error.status, code: error.code, message: error.message } };
    throw error;
  }
}

function unwrap<T>(result: Envelope<T>): T {
  if ("error" in result) throw new AgentUnitError(result.error.status, result.error.code, result.error.message);
  return result.ok;
}

interface RunStub {
  start(agent: string, input: RunInput, options: { threadId?: string }, id: string): Promise<Envelope<RunRecord>>;
  resume(id: string, answer: unknown): Promise<Envelope<RunRecord>>;
  cancel(id: string): Promise<Envelope<RunRecord>>;
  getRun(id: string): Promise<Envelope<RunRecord>>;
  settled(id: string): Promise<Envelope<RunRecord | undefined>>;
  events(id: string, after: number): Promise<Envelope<ReadableStream<Uint8Array>>>;
}

type Bindings = Record<string, unknown>;

/** A Durable Object class, typed without depending on the Workers type package. */
export type DurableObjectClass = new (ctx: DurableObjectStateLike, env: any) => object;

export interface DurableAgentUnit {
  /** One Durable Object per run. Export it from your Worker under this name. */
  AgentUnitRun: DurableObjectClass;
  /** The shared index object. Export it from your Worker under this name. */
  AgentUnitIndex: DurableObjectClass;
  /** A Worker `fetch` handler for the agent-unit HTTP API. */
  fetch(request: Request, env: Record<string, unknown>, ctx?: ExecutionContextLike): Promise<Response>;
  /** The wrangler.json entries for the two objects. */
  wrangler: {
    durable_objects: { bindings: { name: string; class_name: string }[] };
    migrations: { tag: string; new_sqlite_classes: string[] }[];
  };
}

const RUN_ID = /^run_[a-z0-9]{8,64}$/;
const SELF_KEY = "agent-unit:run-id";

export function createDurableAgentUnit(options: DurableAgentUnitOptions): DurableAgentUnit {
  const runsBinding = options.bindings?.runs ?? "AGENT_UNIT_RUNS";
  const indexBinding = options.bindings?.index ?? "AGENT_UNIT_INDEX";
  const adapters = [...(options.adapters ?? []), functionAdapter];
  let loaded: LoadedAgent[] | undefined;
  const agents = () => (loaded ??= Object.entries(options.agents).map(([name, agent]) => resolveAgent(name, agent, adapters)));
  const budget = options.budget === false ? undefined : parseDuration(options.budget ?? "10m");

  const namespace = <Stub>(env: Bindings, binding: string) => {
    const value = env[binding] as DurableObjectNamespaceLike<Stub> | undefined;
    if (!value?.idFromName) throw new Error(`agent-unit: the Durable Object binding "${binding}" is missing. Add it to wrangler.json.`);
    return value;
  };
  const indexStub = (env: Bindings) => {
    const ns = namespace<IndexStub>(env, indexBinding);
    return ns.get(ns.idFromName("index"));
  };
  /** Storage where `runs`, `state` and `kv` live in the shared index; anything else in `local`. */
  const sharedStorage = (env: Bindings, local: ReturnType<typeof durableStorageDriver> | undefined): Storage => {
    const storage = createStorage({ driver: local ?? nullDriver() });
    for (const base of ["runs", "state", "kv"]) storage.mount(base, indexStorageDriver(() => indexStub(env), base));
    return storage;
  };

  /** The shared index: a strongly consistent key-value store every run object and the Worker reach by RPC. */
  class AgentUnitIndex extends DurableObject<Bindings> {
    async kvGet(key: string): Promise<unknown> {
      return (await this.ctx.storage.get(key)) ?? null;
    }
    async kvSet(key: string, value: unknown): Promise<void> {
      await this.ctx.storage.put(key, value);
    }
    async kvDelete(key: string): Promise<void> {
      await this.ctx.storage.delete(key);
    }
    async kvKeys(base?: string): Promise<string[]> {
      return [...(await this.ctx.storage.list(base ? { prefix: base } : {})).keys()];
    }
  }

  /** One run: executes it, stores its journal and events, and owns its alarm. */
  class AgentUnitRun extends DurableObject<Bindings> {
    #engine: RunEngine | undefined;
    readonly #pending = new Map<string, Promise<RunRecord | undefined>>();

    constructor(ctx: DurableObjectStateLike, env: Bindings) {
      super(ctx, env);
    }

    get engine(): RunEngine {
      return (this.#engine ??= new RunEngine({
        store: new RunStore(sharedStorage(this.env, durableStorageDriver(this.ctx.storage))),
        agents: agents(),
        name: options.name,
        budgetMs: budget,
        env: this.env as Record<string, string | undefined>,
        waitUntil: (promise) => this.ctx.waitUntil(promise),
        scheduleWake: (_id, at) => this.ctx.storage.setAlarm(at),
      }));
    }

    #track(id: string, done: Promise<RunRecord | undefined>) {
      this.#pending.set(id, done);
      void done.finally(() => {
        if (this.#pending.get(id) === done) this.#pending.delete(id);
      });
    }

    start(agent: string, input: RunInput, startOptions: { threadId?: string }, id: string) {
      return envelope(async () => {
        if (!RUN_ID.test(id)) throw new AgentUnitError(400, "invalid_run_id", `Invalid run id "${id}".`);
        await this.ctx.storage.put(SELF_KEY, id);
        const { run, done } = await this.engine.start(agent, input, { ...startOptions, id });
        this.#track(id, done);
        return run;
      });
    }

    resume(id: string, answer: unknown) {
      return envelope(async () => {
        const { run, done } = await this.engine.resume(id, answer);
        this.#track(id, done);
        return run;
      });
    }

    cancel(id: string) {
      return envelope(() => this.engine.cancel(id));
    }

    getRun(id: string) {
      return envelope(() => this.engine.getRun(id));
    }

    /** Resolves when the current execution stops (finished, failed, parked or yielded). */
    settled(id: string) {
      return envelope(async () => (await this.#pending.get(id)) ?? this.engine.getRun(id));
    }

    /** The run's events as newline-delimited JSON, live until it settles. */
    events(id: string, after: number) {
      return envelope(async () => {
        await this.engine.getRun(id);
        const controller = new AbortController();
        const iterator = this.engine.events(id, after, controller.signal)[Symbol.asyncIterator]();
        const encoder = new TextEncoder();
        return new ReadableStream<Uint8Array>({
          async pull(stream) {
            const next = await iterator.next();
            if (next.done) stream.close();
            else stream.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
          },
          cancel() {
            controller.abort();
            void iterator.return?.(undefined);
          },
        });
      });
    }

    /** Wakes a due sleeper, continues a yielded run, or recovers one whose isolate died mid-execution. */
    async alarm(): Promise<void> {
      const id = await this.ctx.storage.get<string>(SELF_KEY);
      if (!id) return;
      const engine = this.engine;
      const run = await engine.store.getRun(id);
      if (!run) return;
      if (run.status === "sleeping") {
        const due = run.wakeAt ? Date.parse(run.wakeAt) : 0;
        if (due > Date.now()) return this.ctx.storage.setAlarm(due);
        await (await engine.wakeRun(id))?.done;
      } else if (run.status === "running") {
        if (await engine.store.leaseExpired(id)) {
          await engine.continue(id);
        } else {
          // An execution in this isolate still holds the run: check again when its lease lapses.
          await this.ctx.storage.setAlarm(Date.now() + engine.leaseMs);
        }
      }
    }
  }

  /** The Worker side: routes each run to its object and reads lists from the index. */
  class DurableRunService implements RunService {
    constructor(private readonly bindings: Bindings) {}

    private stub(id: string): RunStub {
      if (!RUN_ID.test(id)) throw new AgentUnitError(404, "run_not_found", `No run with id "${id}".`);
      const ns = namespace<RunStub>(this.bindings, runsBinding);
      return ns.get(ns.idFromName(id));
    }

    manifest(): Manifest {
      return { version: 1, name: options.name ?? "agent-unit", agents: agents().map((agent) => agent.card) };
    }

    agentCard(name: string) {
      const agent = agents().find((candidate) => candidate.name === name);
      if (!agent) throw new AgentUnitError(404, "agent_not_found", `No agent named "${name}".`);
      return agent.card;
    }

    async start(agent: string, input: RunInput = {}, startOptions: { threadId?: string } = {}) {
      this.agentCard(agent);
      const id = randomId("run");
      const stub = this.stub(id);
      const run = unwrap(await stub.start(agent, input, { threadId: startOptions.threadId }, id));
      return { run, done: stub.settled(id).then(unwrap) };
    }

    async resume(id: string, answer: unknown) {
      const stub = this.stub(id);
      const run = unwrap(await stub.resume(id, answer));
      return { run, done: stub.settled(id).then(unwrap) };
    }

    async cancel(id: string) {
      return unwrap(await this.stub(id).cancel(id));
    }

    async getRun(id: string) {
      return unwrap(await this.stub(id).getRun(id));
    }

    listRuns(filter?: ListRunsFilter) {
      return new RunStore(sharedStorage(this.bindings, undefined)).listRuns(filter);
    }

    async *events(id: string, after = 0, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
      const stream = unwrap(await this.stub(id).events(id, after));
      const reader = stream.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
      const onAbort = () => void reader.cancel().catch(() => undefined);
      signal?.addEventListener("abort", onAbort);
      let buffer = "";
      try {
        while (!signal?.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line) yield JSON.parse(line) as AgentEvent;
          }
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        reader.releaseLock();
      }
    }

    env(): Record<string, string | undefined> {
      return this.bindings as Record<string, string | undefined>;
    }
  }

  const handlers = new WeakMap<object, (request: Request, context?: RequestContext) => Promise<Response>>();
  const handlerFor = (env: Bindings) => {
    let handler = handlers.get(env);
    if (!handler) {
      handler = createHandler(new DurableRunService(env), {
        basePath: options.basePath,
        authorize: options.authorize,
        heartbeatMs: options.heartbeatMs,
        version: options.version,
      });
      handlers.set(env, handler);
    }
    return handler;
  };

  return {
    AgentUnitRun,
    AgentUnitIndex,
    fetch(request: Request, env: Bindings, ctx?: ExecutionContextLike): Promise<Response> {
      return handlerFor(env)(request, ctx ? { waitUntil: (promise) => ctx.waitUntil(promise) } : {});
    },
    wrangler: {
      durable_objects: {
        bindings: [
          { name: runsBinding, class_name: "AgentUnitRun" },
          { name: indexBinding, class_name: "AgentUnitIndex" },
        ],
      },
      migrations: [{ tag: "agent-unit-v1", new_sqlite_classes: ["AgentUnitRun", "AgentUnitIndex"] }],
    },
  };
}
