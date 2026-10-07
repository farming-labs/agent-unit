import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentEventBody, RunInput } from "../types";
import type { StateScope } from "./store";

/**
 * Thrown inside a run when it must stop executing now: it was interrupted, put to sleep, yielded
 * to a fresh invocation or cancelled. Frameworks may catch it (the AI SDK turns tool errors into
 * results), so the engine also records the reason on the run and refuses all further live work.
 */
const HALTED = Symbol.for("agent-unit.halted");

export class RunHalted extends Error {
  readonly [HALTED] = true;
  constructor(readonly reason: "interrupt" | "sleep" | "yield" | "cancel" | "lost") {
    super(`agent-unit run halted (${reason})`);
    this.name = "RunHalted";
  }

  // Branded, so `instanceof` holds when a bundler or loader duplicates this module.
  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as { [HALTED]?: boolean })[HALTED] === true;
  }
}

export interface StepOptions {
  /** Emit STEP_STARTED / STEP_FINISHED for this step. Default: true for `run.step`. */
  announce?: boolean;
}

export interface RunState {
  get<T = unknown>(key: string, options?: { scope?: StateScope }): Promise<T | undefined>;
  set(key: string, value: unknown, options?: { scope?: StateScope }): Promise<void>;
  delete(key: string, options?: { scope?: StateScope }): Promise<void>;
}

/** The run context agent code reaches with `useRun()`. */
export interface RunContext {
  readonly id: string;
  readonly agent: string;
  readonly threadId: string;
  readonly attempt: number;
  readonly input: RunInput;
  readonly signal: AbortSignal;
  /** Runs `fn` once; on replay returns its journaled result. */
  step<T>(name: string, fn: () => T | Promise<T>, options?: StepOptions): Promise<T>;
  /** Parks the run until `POST /runs/:id/resume` answers; returns the answer. */
  interrupt<T = unknown>(name: string, payload?: unknown): Promise<T>;
  /** Parks the run until the duration passes. */
  sleep(duration: number | string): Promise<void>;
  readonly state: RunState;
  readonly secrets: { get(name: string): string | undefined };
  /** Emits a CUSTOM event. */
  emit(name: string, value?: unknown): void;
}

/** Internal surface the durable wrappers use. */
export interface RunInternals extends RunContext {
  durableCall<T>(key: string | { name: string }, fn: () => T | Promise<T>, options?: { journalErrors?: boolean }): Promise<{ value: T; replayed: boolean }>;
  allocate(name: string): string;
  isReplay(key: string): boolean;
  readStep(key: string): { value: unknown; replayed: true } | undefined;
  record(key: string, value: unknown): Promise<void>;
  assertLive(): Promise<void>;
  emitEvent(body: AgentEventBody): void;
}

// One store per process, even when two copies of agent-unit are loaded (a dev loader and the
// app's own install), so useRun() in agent code sees the run the engine started.
const STORAGE = Symbol.for("agent-unit.context");
const storage: AsyncLocalStorage<RunInternals> = ((globalThis as Record<symbol, unknown>)[STORAGE] ??=
  new AsyncLocalStorage<RunInternals>()) as AsyncLocalStorage<RunInternals>;

export function runWithContext<T>(context: RunInternals, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current run. Throws outside a run. */
export function useRun(): RunContext {
  const context = storage.getStore();
  if (!context) throw new Error("useRun() was called outside an agent-unit run.");
  return context;
}

/** The current run, or undefined outside a run. */
export function tryUseRun(): RunContext | undefined {
  return storage.getStore();
}

/** @internal */
export function currentInternals(): RunInternals | undefined {
  return storage.getStore();
}
