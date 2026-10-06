import type { AgentAdapter } from "../adapter/types";
import { createDurable } from "../adapter/durable";
import {
  SETTLING_EVENTS,
  type AgentCard,
  type AgentEvent,
  type AgentEventBody,
  type Manifest,
  type PendingInterrupt,
  type RunInput,
  type RunRecord,
} from "../types";
import { RunHalted, runWithContext, type RunInternals, type RunState, type StepOptions } from "./context";
import { decode, encode, toJsonSafe } from "./serialize";
import type { Journal, ListRunsFilter, RunStore, StateScope } from "./store";
import { errorInfo, nowIso, parseDuration, randomId, settle } from "./util";

export interface LoadedAgent {
  name: string;
  adapter: AgentAdapter<any>;
  agent: unknown;
  card: AgentCard;
}

export interface EngineOptions {
  store: RunStore;
  agents: LoadedAgent[];
  name?: string;
  /** Yield to a fresh invocation after this long, at a step boundary. Default: no limit. */
  budgetMs?: number;
  /** How long an execution holds a run before another process may take it over. */
  leaseMs?: number;
  /** Keeps background work alive after a response is sent (serverless `waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Starts a run's continuation in a fresh invocation after it yields. Default: continue in-process. */
  continueRun?: (runId: string) => void | Promise<void>;
  /** Where `run.secrets.get` reads from. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** How often a reader polls storage for events written by another process. */
  pollMs?: number;
  /**
   * Schedules `continue` or `wake` for a run at a time, on hosts with their own scheduler (a Durable
   * Object alarm). It replaces in-process sleep timers and in-process continuation after a yield, and
   * is armed as a watchdog while a run executes, so a run whose process dies is picked up again.
   */
  scheduleWake?: (runId: string, at: number) => void | Promise<void>;
}

export class AgentUnitError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentUnitError";
  }
}

type Parked =
  | { kind: "interrupt"; interrupt: PendingInterrupt }
  | { kind: "sleep"; key: string; wakeAt: number }
  | { kind: "yield" };

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MAX_LOCAL_SLEEP_MS = 15 * 60_000;

class RunExecution implements RunInternals {
  private counters = new Map<string, number>();
  private pending: AgentEvent[] = [];
  private flushing: Promise<void> = Promise.resolve();
  private lastRemoteCheck = 0;
  readonly controller = new AbortController();
  parked?: Parked;
  cancelled = false;
  private readonly startedAt = Date.now();

  constructor(
    private readonly engine: RunEngine,
    readonly run: RunRecord,
    private readonly journal: Journal,
  ) {}

  get id() { return this.run.id; }
  get agent() { return this.run.agent; }
  get threadId() { return this.run.threadId; }
  get attempt() { return this.run.attempt; }
  get input() { return this.run.input as RunInput; }
  get signal() { return this.controller.signal; }

  allocate(name: string): string {
    const n = this.counters.get(name) ?? 0;
    this.counters.set(name, n + 1);
    return `${name}#${n}`;
  }

  isReplay(key: string): boolean {
    return this.journal[key]?.kind === "step";
  }

  readStep(key: string) {
    const entry = this.journal[key];
    if (entry?.kind !== "step") return undefined;
    if (entry.error !== undefined) throw decode(entry.error);
    return { value: decode(entry.value), replayed: true as const };
  }

  async record(key: string, value: unknown): Promise<void> {
    this.journal[key] = { kind: "step", value: encode(value) };
    await this.persistJournal();
  }

  private journalWrites: Promise<void> = Promise.resolve();
  private journalDirty = false;

  /**
   * Writes the journal, one write at a time: model and tool records can land together, and two
   * overlapping writes to one key are not safe on every driver (a file can end up interleaved).
   * Each caller resolves once a write that includes its entry has finished.
   */
  private persistJournal(): Promise<void> {
    this.journalDirty = true;
    const write = async () => {
      if (!this.journalDirty) return;
      this.journalDirty = false;
      await this.engine.store.putJournal(this.run.id, this.journal);
    };
    this.journalWrites = this.journalWrites.then(write, write);
    return this.journalWrites;
  }

  /** Throws when the run may not start new live work: parked, cancelled or out of budget. */
  async assertLive(): Promise<void> {
    if (this.parked) throw new RunHalted(this.parked.kind === "interrupt" ? "interrupt" : this.parked.kind);
    if (this.cancelled) throw new RunHalted("cancel");
    const now = Date.now();
    if (now - this.lastRemoteCheck > 1000) {
      this.lastRemoteCheck = now;
      const stored = await this.engine.store.getRun(this.run.id);
      if (stored?.status === "cancelled") this.cancel();
      if (this.cancelled) throw new RunHalted("cancel");
      await this.engine.store.renewLease(this.run.id, this.engine.owner, this.engine.leaseMs);
    }
    const budget = this.engine.options.budgetMs;
    if (budget !== undefined && now - this.startedAt > budget) {
      this.park({ kind: "yield" });
      throw new RunHalted("yield");
    }
  }

  async durableCall<T>(
    key: string | { name: string },
    fn: () => T | Promise<T>,
    options: { journalErrors?: boolean } = {},
  ): Promise<{ value: T; replayed: boolean }> {
    const stepKey = typeof key === "string" ? key : this.allocate(key.name);
    const replayed = this.readStep(stepKey);
    if (replayed) return { value: replayed.value as T, replayed: true };
    await this.assertLive();
    let value: T;
    try {
      value = await fn();
    } catch (error) {
      if (error instanceof RunHalted || this.parked || this.cancelled) throw error;
      if (options.journalErrors !== false) {
        this.journal[stepKey] = { kind: "step", error: encode(error) };
        await this.persistJournal();
      }
      throw error;
    }
    await this.record(stepKey, value);
    return { value, replayed: false };
  }

  async step<T>(name: string, fn: () => T | Promise<T>, options: StepOptions = {}): Promise<T> {
    const key = this.allocate(name);
    const announce = options.announce !== false && !this.isReplay(key);
    if (announce) this.emitEvent({ type: "STEP_STARTED", stepName: name });
    const { value } = await this.durableCall(key, fn);
    if (announce) this.emitEvent({ type: "STEP_FINISHED", stepName: name });
    return value;
  }

  async interrupt<T>(name: string, payload?: unknown): Promise<T> {
    const key = this.allocate(`interrupt:${name}`);
    const entry = this.journal[key];
    if (entry?.kind === "interrupt" && entry.answered) return decode(entry.answer) as T;
    this.park({ kind: "interrupt", interrupt: { key, name, payload: toJsonSafe(payload) } });
    throw new RunHalted("interrupt");
  }

  async sleep(duration: number | string): Promise<void> {
    const ms = parseDuration(duration);
    const key = this.allocate("sleep");
    const entry = this.journal[key];
    if (entry?.kind === "sleep") {
      if (entry.woke || Date.now() >= entry.wakeAt) return;
      this.park({ kind: "sleep", key, wakeAt: entry.wakeAt });
      throw new RunHalted("sleep");
    }
    await this.assertLive();
    const wakeAt = Date.now() + ms;
    this.journal[key] = { kind: "sleep", wakeAt };
    await this.persistJournal();
    if (ms === 0) return;
    this.park({ kind: "sleep", key, wakeAt });
    throw new RunHalted("sleep");
  }

  readonly state: RunState = {
    get: (key, options) => this.engine.store.getState(...this.scope(options?.scope), key),
    set: (key, value, options) => this.engine.store.setState(...this.scope(options?.scope), key, toJsonSafe(value)),
    delete: (key, options) => this.engine.store.deleteState(...this.scope(options?.scope), key),
  };

  private scope(scope: StateScope = "thread"): [StateScope, string] {
    if (scope === "agent") return ["agent", this.run.agent];
    if (scope === "app") return ["app", "app"];
    return ["thread", this.run.threadId];
  }

  readonly secrets = {
    get: (name: string) => this.engine.env()[name],
  };

  emit(name: string, value?: unknown): void {
    this.emitEvent({ type: "CUSTOM", name, value: toJsonSafe(value) });
  }

  emitEvent(body: AgentEventBody): void {
    const event = { ...body, seq: ++this.run.eventCount, runId: this.run.id, timestamp: Date.now() } as AgentEvent;
    this.pending.push(event);
    this.engine.publish(event);
    this.flushing = this.flushing.then(async () => {
      const batch = this.pending.splice(0);
      if (batch.length) await this.engine.store.appendEvents(this.run.id, batch);
    });
  }

  flush(): Promise<void> {
    return this.flushing;
  }

  park(parked: Parked) {
    if (this.parked || this.cancelled) return;
    this.parked = parked;
    this.controller.abort(new RunHalted(parked.kind === "interrupt" ? "interrupt" : parked.kind));
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.controller.abort(new RunHalted("cancel"));
  }
}

/**
 * Executes runs durably: journals every step, parks runs that interrupt or sleep, continues them
 * later in any process, and never repeats completed work.
 */
export class RunEngine {
  #owner: string | undefined;
  /** This process's lease identity. Lazy: Workers forbid random values at module scope, where engines are built. */
  get owner(): string {
    return (this.#owner ??= randomId("worker", 10));
  }
  readonly leaseMs: number;
  private readonly agents = new Map<string, LoadedAgent>();
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  private readonly active = new Map<string, RunExecution>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(readonly options: EngineOptions) {
    for (const agent of options.agents) this.agents.set(agent.name, agent);
    this.leaseMs = options.leaseMs ?? 60_000;
  }

  get store(): RunStore {
    return this.options.store;
  }

  env(): Record<string, string | undefined> {
    return this.options.env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  }

  manifest(): Manifest {
    return { version: 1, name: this.options.name ?? "agent-unit", agents: [...this.agents.values()].map((a) => a.card) };
  }

  agentCard(name: string): AgentCard {
    const agent = this.agents.get(name);
    if (!agent) throw new AgentUnitError(404, "agent_not_found", `No agent named "${name}".`);
    return agent.card;
  }

  async getRun(id: string): Promise<RunRecord> {
    const run = await this.store.getRun(id);
    if (!run) throw new AgentUnitError(404, "run_not_found", `No run with id "${id}".`);
    return run;
  }

  listRuns(filter?: ListRunsFilter): Promise<RunRecord[]> {
    return this.store.listRuns(filter);
  }

  /** Creates a run and starts executing it. `done` settles when this execution stops. */
  async start(agentName: string, input: RunInput = {}, options: { threadId?: string; id?: string } = {}) {
    this.agentCard(agentName);
    // A caller may choose the id when it routes runs by id (one Durable Object per run).
    const id = options.id ?? randomId("run");
    if (options.id !== undefined) {
      if (!/^run_[a-z0-9]{8,64}$/.test(id)) throw new AgentUnitError(400, "invalid_run_id", `Invalid run id "${id}".`);
      if (await this.store.getRun(id)) throw new AgentUnitError(409, "run_exists", `Run "${id}" already exists.`);
    }
    const createdAt = nowIso();
    const run: RunRecord = {
      id,
      agent: agentName,
      threadId: options.threadId || id,
      status: "running",
      input: toJsonSafe(input),
      attempt: 0,
      eventCount: 1,
      createdAt,
      updatedAt: createdAt,
    };
    const started = { type: "RUN_STARTED", threadId: run.threadId, agent: agentName, seq: 1, runId: id, timestamp: Date.now() } as AgentEvent;
    await this.store.putRun(run);
    await this.store.appendEvents(id, [started]);
    this.publish(started);
    return { run, done: this.schedule(id) };
  }

  /** Answers a parked interrupt and continues the run. */
  async resume(id: string, answer: unknown) {
    const run = await this.getRun(id);
    if (run.status !== "interrupted" || !run.interrupt) {
      throw new AgentUnitError(409, "run_not_interrupted", `Run "${id}" is ${run.status}, not interrupted.`);
    }
    const journal = await this.store.getJournal(id);
    journal[run.interrupt.key] = { kind: "interrupt", answered: true, answer: encode(answer) };
    await this.store.putJournal(id, journal);
    delete run.interrupt;
    run.status = "running";
    run.updatedAt = nowIso();
    await this.store.putRun(run);
    return { run, done: this.schedule(id) };
  }

  async cancel(id: string): Promise<RunRecord> {
    const run = await this.getRun(id);
    if (TERMINAL.has(run.status)) return run;
    const execution = this.active.get(id);
    if (execution) {
      execution.cancel();
      await this.idle(id);
      return this.getRun(id);
    }
    // Parked here or running elsewhere: mark it; a remote execution notices at its next step.
    run.status = "cancelled";
    delete run.interrupt;
    delete run.wakeAt;
    const event = { type: "RUN_CANCELLED", seq: ++run.eventCount, runId: id, timestamp: Date.now() } as AgentEvent;
    run.updatedAt = nowIso();
    await this.store.putRun(run);
    await this.store.appendEvents(id, [event]);
    this.publish(event);
    this.clearTimer(id);
    return run;
  }

  /** Continues a running run whose execution stopped: after a yield, or a crash. */
  async continue(id: string): Promise<RunRecord | undefined> {
    const run = await this.store.getRun(id);
    if (!run || run.status !== "running" || this.active.has(id)) return run;
    if (!(await this.store.leaseExpired(id))) return run;
    return this.schedule(id);
  }

  /**
   * Wakes due sleepers and recovers stalled runs. Run it on a schedule on serverless hosts.
   * `settled` resolves when the executions it started stop; pass it to the host's `waitUntil`.
   */
  async sweep(now = Date.now()) {
    const woken: string[] = [];
    const recovered: string[] = [];
    const work: Promise<unknown>[] = [];
    for (const run of await this.store.listRuns({ status: "sleeping", limit: 1000 })) {
      if (!run.wakeAt || Date.parse(run.wakeAt) > now) continue;
      const execution = await this.wakeRun(run.id);
      if (execution) {
        woken.push(run.id);
        work.push(execution.done);
      }
    }
    for (const run of await this.store.listRuns({ status: "running", limit: 1000 })) {
      if (this.active.has(run.id) || !(await this.store.leaseExpired(run.id))) continue;
      recovered.push(run.id);
      work.push(this.schedule(run.id));
    }
    return { woken, recovered, settled: Promise.allSettled(work).then(() => undefined) };
  }

  async wake(id: string): Promise<boolean> {
    return (await this.wakeRun(id)) !== undefined;
  }

  /** Wakes a sleeping run now and starts it; `done` settles when that execution stops. */
  async wakeRun(id: string): Promise<{ done: Promise<RunRecord | undefined> } | undefined> {
    const run = await this.store.getRun(id);
    if (!run || run.status !== "sleeping") return undefined;
    const journal = await this.store.getJournal(id);
    // A run parks on one sleep at a time, so waking it (on time or early) ends every pending sleep.
    for (const entry of Object.values(journal)) {
      if (entry.kind === "sleep" && !entry.woke) entry.woke = true;
    }
    await this.store.putJournal(id, journal);
    run.status = "running";
    delete run.wakeAt;
    run.updatedAt = nowIso();
    await this.store.putRun(run);
    return { done: this.schedule(id) };
  }

  /** Events from `after`, then live ones, until the run settles. */
  async *events(id: string, after = 0, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    await this.getRun(id);
    let cursor = after;
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const listener = (event: AgentEvent) => {
      queue.push(event);
      wake?.();
    };
    this.subscribe(id, listener);
    const onAbort = () => wake?.();
    signal?.addEventListener("abort", onAbort);
    // A settling event ends the stream only when it is the run's current state: a run that was
    // interrupted and later resumed has later events, and a reader replaying history wants them.
    const settled = async (event: AgentEvent) => {
      if (!SETTLING_EVENTS.has(event.type) || this.active.has(id)) return false;
      const run = await this.store.getRun(id);
      return !run || (run.status !== "running" && run.eventCount <= event.seq);
    };
    try {
      for (const event of await this.store.readEvents(id, cursor)) {
        cursor = event.seq;
        yield event;
        if (await settled(event)) return;
      }
      while (!signal?.aborted) {
        while (queue.length) {
          const event = queue.shift()!;
          if (event.seq <= cursor) continue;
          cursor = event.seq;
          yield event;
          if (SETTLING_EVENTS.has(event.type) && (await settled(event))) return;
        }
        if (!this.active.has(id)) {
          // Not executing here: another process may be, so read what it stored.
          for (const event of await this.store.readEvents(id, cursor)) {
            cursor = event.seq;
            yield event;
            if (await settled(event)) return;
          }
          const run = await this.store.getRun(id);
          if (!run || (run.status !== "running" && !this.active.has(id) && run.eventCount <= cursor)) return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, this.options.pollMs ?? 250);
        });
        wake = undefined;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.unsubscribe(id, listener);
    }
  }

  /** Resolves when no execution of this run is active in this process. */
  async idle(id: string): Promise<void> {
    while (this.active.has(id)) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  publish(event: AgentEvent) {
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
  }

  private subscribe(id: string, listener: (event: AgentEvent) => void) {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(listener);
  }

  private unsubscribe(id: string, listener: (event: AgentEvent) => void) {
    const set = this.listeners.get(id);
    set?.delete(listener);
    if (set?.size === 0) this.listeners.delete(id);
  }

  private schedule(id: string): Promise<RunRecord | undefined> {
    const promise = this.execute(id);
    this.options.waitUntil?.(promise);
    return promise;
  }

  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private async execute(id: string): Promise<RunRecord | undefined> {
    const run = await this.store.getRun(id);
    if (!run || run.status !== "running" || this.active.has(id)) return run;
    const loaded = this.agents.get(run.agent);
    if (!loaded) return run;
    if (!(await this.store.acquireLease(id, this.owner, this.leaseMs))) return run;

    run.attempt += 1;
    run.updatedAt = nowIso();
    await this.store.putRun(run);
    const execution = new RunExecution(this, run, await this.store.getJournal(id));
    this.active.set(id, execution);
    // Watchdog: if this process dies mid-run, the host's scheduler continues the run once the lease lapses.
    await this.options.scheduleWake?.(id, Date.now() + this.leaseMs);
    let yielded = false;
    try {
      const durable = createDurable();
      let output: unknown;
      let failure: unknown;
      try {
        output = await runWithContext(execution, () =>
          settle(
            loaded.adapter.run(loaded.agent, {
              input: execution.input,
              signal: execution.signal,
              run: execution,
              durable,
              kv: this.store.kv(`adapter:${loaded.adapter.name}`),
              emit: (event) => execution.emitEvent(event),
            }),
          ),
        );
      } catch (error) {
        failure = error;
      }

      if (execution.cancelled) {
        run.status = "cancelled";
        execution.emitEvent({ type: "RUN_CANCELLED" });
      } else if (execution.parked?.kind === "interrupt") {
        run.status = "interrupted";
        run.interrupt = execution.parked.interrupt;
        execution.emitEvent({ type: "RUN_INTERRUPTED", interrupt: execution.parked.interrupt });
      } else if (execution.parked?.kind === "sleep") {
        run.status = "sleeping";
        run.wakeAt = new Date(execution.parked.wakeAt).toISOString();
        execution.emitEvent({ type: "RUN_SLEEPING", wakeAt: run.wakeAt });
        await this.armTimer(id, execution.parked.wakeAt);
      } else if (execution.parked?.kind === "yield") {
        yielded = true;
      } else if (failure !== undefined) {
        run.status = "failed";
        run.error = errorInfo(failure);
        execution.emitEvent({ type: "RUN_ERROR", message: run.error.message, code: run.error.name });
      } else {
        run.status = "completed";
        run.output = toJsonSafe(output);
        execution.emitEvent({ type: "RUN_FINISHED", result: run.output });
      }
      await execution.flush();
      run.updatedAt = nowIso();
      await this.store.putRun(run);
    } finally {
      this.active.delete(id);
      await this.store.releaseLease(id, this.owner);
    }
    if (yielded) {
      if (this.options.continueRun) await this.options.continueRun(id);
      else if (this.options.scheduleWake) await this.options.scheduleWake(id, Date.now());
      else return this.schedule(id);
    }
    return run;
  }

  private async armTimer(id: string, wakeAt: number) {
    if (this.options.scheduleWake) {
      await this.options.scheduleWake(id, wakeAt);
      return;
    }
    const delay = wakeAt - Date.now();
    if (delay > MAX_LOCAL_SLEEP_MS) return;
    this.clearTimer(id);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.wake(id);
    }, Math.max(0, delay));
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(id, timer);
  }

  /** Stops timers. Call when the process shuts down. */
  close() {
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
  }
}
