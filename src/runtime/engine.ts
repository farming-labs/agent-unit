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
import { currentFrame, idempotencyKey, RunHalted, runInFrame, runWithContext, type RunInternals, type RunState, type StepInfo, type StepOptions } from "./context";
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
  /**
   * Check storage about once a second, while a run executes, for a cancel sent to another process.
   * Default true. Runtimes that deliver every cancel to the executing process turn it off.
   */
  remoteCancelCheck?: boolean;
  /** Fail a run whose executions crash (start but never finish) this many times in a row. Default 5. */
  maxCrashes?: number;
  /** Delete finished runs (with their journal and events) this long after they finish, in the sweep. */
  retentionMs?: number;
  /** How long `cancel` waits for an executing run to stop before answering. Default 2s. */
  cancelWaitMs?: number;
}

export class AgentUnitError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415,
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
  /** Another execution took the lease over: this one stops and writes nothing more. */
  leaseLost = false;
  private readonly startedAt = Date.now();
  private renewTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly engine: RunEngine,
    readonly run: RunRecord,
    private readonly journal: Journal,
    /** This execution's own lease token, so even two executions in one process never share one. */
    readonly leaseOwner: string,
  ) {}

  /** Keeps the lease alive while the run executes, including during one long step. */
  startRenewing() {
    const interval = Math.max(10, Math.floor(this.engine.leaseMs / 3));
    this.renewTimer = setInterval(() => {
      void this.engine.store.renewLease(this.run.id, this.leaseOwner, this.engine.leaseMs).then(
        (held) => {
          if (!held) this.loseLease();
        },
        () => undefined,
      );
    }, interval);
    (this.renewTimer as { unref?: () => void }).unref?.();
  }

  stopRenewing() {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = undefined;
  }

  loseLease() {
    if (this.leaseLost) return;
    this.leaseLost = true;
    this.stopRenewing();
    this.controller.abort(new RunHalted("lost"));
  }

  get id() { return this.run.id; }
  get agent() { return this.run.agent; }
  get threadId() { return this.run.threadId; }
  get attempt() { return this.run.attempt; }
  get input() { return this.run.input as RunInput; }
  get signal() { return this.controller.signal; }

  private taskScope?: () => string | undefined;

  scopeSteps(resolve: () => string | undefined) {
    this.taskScope = resolve;
  }

  allocate(name: string): string {
    // Runs started before scoped keys keep numbering steps across the whole run, so their journals still match.
    const frame = this.run.stepKeys === "scoped" ? currentFrame() : undefined;
    const task = frame ? this.taskScope?.() : undefined;
    const prefix = frame ? `${frame.scope}/${task ? `${task}/` : ""}` : "";
    const counter = `${prefix}${name}`;
    const n = this.counters.get(counter) ?? 0;
    this.counters.set(counter, n + 1);
    return `${counter}#${n}`;
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
    await this.persistEntry(key);
  }

  /** Writes one journal entry: a step costs one write, however long the run's history. */
  private persistEntry(key: string): Promise<void> {
    return this.engine.store.putJournalEntry(this.run.id, key, this.journal[key]!);
  }

  /** Throws when the run may not start new live work: parked, cancelled or out of budget. */
  async assertLive(): Promise<void> {
    if (this.leaseLost) throw new RunHalted("lost");
    if (this.parked) throw new RunHalted(this.parked.kind === "interrupt" ? "interrupt" : this.parked.kind);
    if (this.cancelled) throw new RunHalted("cancel");
    const now = Date.now();
    if (this.engine.options.remoteCancelCheck !== false && now - this.lastRemoteCheck > 1000) {
      this.lastRemoteCheck = now;
      // A cancel sent to another process is recorded on the run; this executor carries it out.
      const stored = await this.engine.store.getRun(this.run.id);
      if (stored?.status === "cancelled" || stored?.cancelRequested) this.cancel();
      if (this.cancelled) throw new RunHalted("cancel");
    }
    const budget = this.engine.options.budgetMs;
    if (budget !== undefined && now - this.startedAt > budget) {
      this.park({ kind: "yield" });
      throw new RunHalted("yield");
    }
  }

  async durableCall<T>(
    key: string | { name: string },
    fn: (step: StepInfo) => T | Promise<T>,
    options: { journalErrors?: boolean; step?: boolean } = {},
  ): Promise<{ value: T; replayed: boolean }> {
    const stepKey = typeof key === "string" ? key : this.allocate(key.name);
    const replayed = this.readStep(stepKey);
    if (replayed) return { value: replayed.value as T, replayed: true };
    await this.assertLive();
    const step = { idempotencyKey: await idempotencyKey(this.run.id, stepKey) };
    let value: T;
    try {
      // Only a single step or tool call exposes its key; a call spanning a whole turn does not.
      value = await runInFrame({ scope: stepKey, step: options.step ? step : undefined }, () => fn(step));
    } catch (error) {
      if (error instanceof RunHalted || this.parked || this.cancelled) throw error;
      if (options.journalErrors !== false) {
        this.journal[stepKey] = { kind: "step", error: encode(error) };
        await this.persistEntry(stepKey);
      }
      throw error;
    }
    await this.record(stepKey, value);
    return { value, replayed: false };
  }

  async step<T>(name: string, fn: (step: StepInfo) => T | Promise<T>, options: StepOptions = {}): Promise<T> {
    const key = this.allocate(name);
    const announce = options.announce !== false && !this.isReplay(key);
    if (announce) this.emitEvent({ type: "STEP_STARTED", stepName: name });
    const { value } = await this.durableCall(key, fn, { step: true });
    if (announce) this.emitEvent({ type: "STEP_FINISHED", stepName: name });
    return value;
  }

  idempotencyKey(): string {
    const step = currentFrame()?.step;
    if (!step) {
      throw new Error(
        "useRun().idempotencyKey() is only available inside run.step() or a tool call agent-unit journals. Wrap the side effect in run.step().",
      );
    }
    return step.idempotencyKey;
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
    await this.persistEntry(key);
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
    // Events from an execution that lost its lease would collide with the new executor's.
    if (this.leaseLost) return;
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
  /** Runs an execution has claimed but not started yet: claimed before the first await, so two triggers never both start. */
  private readonly claimed = new Set<string>();
  private executions = 0;
  private readonly locks = new Map<string, Promise<void>>();

  /**
   * Serializes state changes of one run (resume, cancel, wake) in this process, so two requests
   * racing on one run see each other's change: the second resume of an interrupt gets 409.
   */
  private async locked<T>(id: string, change: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
    this.locks.set(id, current);
    await previous;
    try {
      return await change();
    } finally {
      release();
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }
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
      stepKeys: "scoped",
      createdAt,
      updatedAt: createdAt,
    };
    const started = { type: "RUN_STARTED", threadId: run.threadId, agent: agentName, seq: 1, runId: id, timestamp: Date.now() } as AgentEvent;
    if (!(await this.store.putRun(run, null))) throw new AgentUnitError(409, "run_exists", `Run "${id}" already exists.`);
    await this.store.appendEvents(id, [started]);
    this.publish(started);
    return { run, done: this.schedule(id) };
  }

  /** Answers a parked interrupt and continues the run. */
  async resume(id: string, answer: unknown) {
    return this.locked(id, async () => {
      const run = await this.getRun(id);
      if (run.status !== "interrupted" || !run.interrupt) {
        throw new AgentUnitError(409, "run_not_interrupted", `Run "${id}" is ${run.status}, not interrupted.`);
      }
      const previous = structuredClone(run);
      const key = run.interrupt.key;
      delete run.interrupt;
      run.status = "running";
      run.updatedAt = nowIso();
      // Conditional: another process may have resumed or cancelled it since we read it.
      if (!(await this.store.putRun(run, previous))) {
        const current = await this.getRun(id);
        throw new AgentUnitError(409, "run_not_interrupted", `Run "${id}" is ${current.status}, not interrupted; another request changed it first.`);
      }
      // Only the winner writes its answer, so a losing resume can never replace it.
      await this.store.putJournalEntry(id, key, { kind: "interrupt", answered: true, answer: encode(answer) });
      return { run, done: this.schedule(id) };
    });
  }

  async cancel(id: string): Promise<RunRecord> {
    return this.locked(id, () => this.cancelNow(id));
  }

  private async cancelNow(id: string, tries = 0): Promise<RunRecord> {
    const run = await this.getRun(id);
    if (TERMINAL.has(run.status)) return run;
    const previous = structuredClone(run);
    // Another process changed the run between our read and our write: decide again on what it did.
    const retry = () => {
      if (tries >= 5) throw new AgentUnitError(409, "run_conflict", `Run "${id}" kept changing; try again.`);
      return this.cancelNow(id, tries + 1);
    };
    const execution = this.active.get(id);
    if (execution) {
      execution.cancel();
      // A step that ignores the abort signal may run on; answer anyway and let it end in the background.
      const timeout = new Promise((resolve) => setTimeout(resolve, this.options.cancelWaitMs ?? 2000));
      await Promise.race([this.idle(id), timeout]);
      const current = await this.getRun(id);
      return current.status === "running" ? { ...current, cancelRequested: true } : current;
    }
    // Executing in another process: ask that executor to cancel. Writing the cancel here would race
    // its events and its final write; it notices within a second, at its next step.
    if (run.status === "running" && !(await this.store.leaseExpired(id))) {
      run.cancelRequested = true;
      run.updatedAt = nowIso();
      if (!(await this.store.putRun(run, previous))) return retry();
      return run;
    }
    // Parked, or its executor died: cancel it here, after the last event actually stored.
    run.status = "cancelled";
    delete run.interrupt;
    delete run.wakeAt;
    delete run.cancelRequested;
    run.eventCount = await this.store.lastEventSeq(id, run.eventCount);
    const event = { type: "RUN_CANCELLED", seq: ++run.eventCount, runId: id, timestamp: Date.now() } as AgentEvent;
    run.updatedAt = nowIso();
    if (!(await this.store.putRun(run, previous))) return retry();
    await this.store.appendEvents(id, [event]);
    this.publish(event);
    this.clearTimer(id);
    return run;
  }

  /** Deletes a finished run with its journal and events. Running or parked runs must be cancelled first. */
  async deleteRun(id: string): Promise<void> {
    return this.locked(id, async () => {
      const run = await this.getRun(id);
      if (!TERMINAL.has(run.status)) {
        throw new AgentUnitError(409, "run_not_finished", `Run "${id}" is ${run.status}; cancel it before deleting it.`);
      }
      this.clearTimer(id);
      await this.store.deleteRun(id);
    });
  }

  /** Continues a running run whose execution stopped: after a yield, or a crash. */
  async continue(id: string): Promise<RunRecord | undefined> {
    const run = await this.store.getRun(id);
    if (!run || run.status !== "running" || this.busy(id)) return run;
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
    const deleted: string[] = [];
    const work: Promise<unknown>[] = [];
    // Earliest wake time first, every due sleeper, not just the newest runs.
    for (const id of await this.store.dueSleepers(now)) {
      const execution = await this.wakeRun(id);
      if (execution) {
        woken.push(id);
        work.push(execution.done);
      }
    }
    for (const id of await this.store.runningRuns()) {
      if (this.busy(id) || !(await this.store.leaseExpired(id))) continue;
      recovered.push(id);
      work.push(this.schedule(id));
    }
    if (this.options.retentionMs !== undefined) {
      for (const id of await this.store.finishedBefore(now - this.options.retentionMs)) {
        await this.store.deleteRun(id);
        deleted.push(id);
      }
    }
    return { woken, recovered, deleted, settled: Promise.allSettled(work).then(() => undefined) };
  }

  async wake(id: string): Promise<boolean> {
    return (await this.wakeRun(id)) !== undefined;
  }

  /**
   * What a scheduled wake-up (`scheduleWake`) should do for a run: wake it if its sleep is due,
   * continue it if it yielded or its executor died. Returns when to check again, if ever.
   */
  async handleWake(id: string): Promise<number | undefined> {
    const run = await this.store.getRun(id);
    if (!run) return undefined;
    if (run.status === "sleeping") {
      const due = run.wakeAt ? Date.parse(run.wakeAt) : 0;
      if (due > Date.now()) return due;
      await (await this.wakeRun(id))?.done;
    } else if (run.status === "running") {
      // Still executing here or held by a live lease elsewhere: look again once that lease could lapse.
      if (this.busy(id) || !(await this.store.leaseExpired(id))) return Date.now() + this.leaseMs;
      await this.continue(id);
    }
    return undefined;
  }

  /** Wakes a sleeping run now and starts it; `done` settles when that execution stops. */
  async wakeRun(id: string): Promise<{ done: Promise<RunRecord | undefined> } | undefined> {
    return this.locked(id, async () => {
      const run = await this.store.getRun(id);
      if (!run || run.status !== "sleeping") return undefined;
      const previous = structuredClone(run);
      run.status = "running";
      delete run.wakeAt;
      run.updatedAt = nowIso();
      // Another process woke or cancelled it first: leave it to that one.
      if (!(await this.store.putRun(run, previous))) return undefined;
      const journal = await this.store.getJournal(id);
      // A run parks on one sleep at a time, so waking it (on time or early) ends every pending sleep.
      for (const [key, entry] of Object.entries(journal)) {
        if (entry.kind === "sleep" && !entry.woke) await this.store.putJournalEntry(id, key, { ...entry, woke: true });
      }
      return { done: this.schedule(id) };
    });
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
          // Not executing here: another process may be, so read what it stored, in order.
          for (const event of await this.store.readEvents(id, cursor)) {
            cursor = event.seq;
            yield event;
            if (await settled(event)) return;
          }
          const run = await this.store.getRun(id);
          if (!run) return;
          if (run.status !== "running" && !this.active.has(id)) {
            // Settled: its last events are final, so read past any gap that will never fill.
            for (const event of await this.store.readEvents(id, cursor, run.eventCount)) {
              cursor = event.seq;
              yield event;
            }
            if (run.eventCount <= cursor) return;
          }
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
    // Callers may drop this promise (a timer, a sweep); a storage error must be reported, not crash the process.
    promise.catch((error) => console.error(`[agent-unit] run ${id} could not execute:`, error));
    this.options.waitUntil?.(promise);
    return promise;
  }

  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  /** An execution of this run is starting or running in this process. */
  private busy(id: string): boolean {
    return this.active.has(id) || this.claimed.has(id);
  }

  private async execute(id: string): Promise<RunRecord | undefined> {
    // Claimed before the first await: a double resume, or a timer firing during a sweep, must not
    // start a second execution of the same run in this process.
    if (this.busy(id)) return this.store.getRun(id);
    this.claimed.add(id);
    let started: { execution: RunExecution } | { record: RunRecord | undefined };
    try {
      const run = await this.store.getRun(id);
      if (!run || run.status !== "running") return run;
      if (!this.agents.has(run.agent)) return run;
      const leaseOwner = `${this.owner}:${++this.executions}`;
      if (!(await this.store.acquireLease(id, leaseOwner, this.leaseMs))) return run;
      started = await this.startExecution(id, run, leaseOwner);
    } finally {
      // Released once the execution is active (or did not start), so its own continuation can claim the run.
      this.claimed.delete(id);
    }
    return "execution" in started ? this.runExecution(id, started.execution) : started.record;
  }

  /** Records the start of an execution (attempt, crash count, event numbering), retrying if another write lands first. */
  private async startExecution(
    id: string,
    run: RunRecord,
    leaseOwner: string,
    tries = 0,
  ): Promise<{ execution: RunExecution } | { record: RunRecord | undefined }> {
    const previous = structuredClone(run);
    // An execution that started but never finished crashed (or its process was stopped).
    if (run.executing) run.crashes = (run.crashes ?? 0) + 1;
    run.attempt += 1;
    // After a crash the record can lag the events already stored; numbering resumes after them.
    run.eventCount = await this.store.lastEventSeq(id, run.eventCount);
    run.updatedAt = nowIso();
    if ((run.crashes ?? 0) >= (this.options.maxCrashes ?? 5)) {
      // Retrying forever would never end; fail it so someone looks at it.
      run.status = "failed";
      run.error = { name: "RunCrashed", message: `The run crashed ${run.crashes} times in a row; giving up.` };
      delete run.executing;
      const event = { type: "RUN_ERROR", message: run.error.message, code: run.error.name, seq: ++run.eventCount, runId: id, timestamp: Date.now() } as AgentEvent;
      if (await this.store.putRun(run, previous)) {
        await this.store.appendEvents(id, [event]);
        this.publish(event);
      }
      await this.store.releaseLease(id, leaseOwner);
      return { record: await this.store.getRun(id) };
    }
    run.executing = true;
    if (!(await this.store.putRun(run, previous))) {
      // Changed underneath us (a cancel request, say): read it again and start from what it is now.
      const current = await this.store.getRun(id);
      if (!current || current.status !== "running" || tries >= 5) {
        await this.store.releaseLease(id, leaseOwner);
        return { record: current };
      }
      return this.startExecution(id, current, leaseOwner, tries + 1);
    }
    const execution = new RunExecution(this, run, await this.store.getJournal(id), leaseOwner);
    this.active.set(id, execution);
    execution.startRenewing();
    return { execution };
  }

  private async runExecution(id: string, execution: RunExecution): Promise<RunRecord | undefined> {
    const run = execution.run;
    const loaded = this.agents.get(run.agent)!;
    let yielded = false;
    try {
      // Watchdog: if this process dies mid-run, the host's scheduler continues the run once the lease lapses.
      await this.options.scheduleWake?.(id, Date.now() + this.leaseMs);
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

      execution.stopRenewing();
      if (execution.leaseLost) {
        // Another execution owns the run now; anything written here would overwrite its work.
        return undefined;
      }
      // A cancel that arrived from another process while this one executed.
      const latest = (await this.store.getRun(id)) ?? null;
      if (latest?.cancelRequested && !execution.cancelled && (execution.parked || failure !== undefined)) execution.cancel();
      delete run.cancelRequested;

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
      delete run.executing;
      delete run.crashes;
      let expected = latest;
      for (let tries = 0; !(await this.store.putRun(run, expected)); tries++) {
        // Only a cancel request can land while a run executes. A parked run takes it now; a finished one already finished.
        expected = (await this.store.getRun(id)) ?? null;
        if (expected?.cancelRequested && (run.status === "interrupted" || run.status === "sleeping" || yielded)) {
          run.status = "cancelled";
          delete run.interrupt;
          delete run.wakeAt;
          yielded = false;
          execution.emitEvent({ type: "RUN_CANCELLED" });
          await execution.flush();
        }
        if (tries >= 5) {
          console.error(`[agent-unit] run ${id}: could not record the end of its execution after repeated conflicts; writing it anyway.`);
          await this.store.putRun(run);
          break;
        }
      }
    } finally {
      execution.stopRenewing();
      this.active.delete(id);
      if (!execution.leaseLost) await this.store.releaseLease(id, execution.leaseOwner);
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
      this.wake(id).catch((error) => console.error(`[agent-unit] run ${id} could not wake:`, error));
    }, Math.max(0, delay));
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(id, timer);
  }

  /** Stops timers. Call when the process shuts down. */
  close() {
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
  }
}
