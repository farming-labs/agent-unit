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

/** What a step's function receives. */
export interface StepInfo {
  /**
   * A key that is the same every time this step runs, including when it runs again after a crash,
   * and different for every other step and run. Pass it to the API the step calls (Stripe's
   * `idempotencyKey`, an `Idempotency-Key` header, a unique column) so a repeated call has no
   * second effect. 32 characters from `A-Z a-z 0-9 - _`.
   */
  idempotencyKey: string;
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
  step<T>(name: string, fn: (step: StepInfo) => T | Promise<T>, options?: StepOptions): Promise<T>;
  /**
   * The idempotency key of the step or tool call running now (see `StepInfo`). Use it inside a tool
   * the framework calls for you. Throws outside a step or tool call, where no stable key exists.
   */
  idempotencyKey(): string;
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
  durableCall<T>(
    key: string | { name: string },
    fn: (step: StepInfo) => T | Promise<T>,
    options?: { journalErrors?: boolean; step?: boolean },
  ): Promise<{ value: T; replayed: boolean }>;
  allocate(name: string): string;
  /**
   * When the next `interrupt(name)` here was already answered, takes it and returns the answer;
   * otherwise returns undefined and takes nothing. For frameworks whose code re-runs with the
   * answer instead of waiting at the pause (Mastra's `suspend()` and `resumeData`).
   */
  answeredInterrupt<T = unknown>(name: string): { answer: T } | undefined;
  /**
   * For adapters whose framework resumes mid-turn from its own checkpoint (LangGraph): names the
   * framework task running now, so steps inside it are numbered per task, not per turn.
   */
  scopeSteps(resolve: () => string | undefined): void;
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
  return storage.run(context, () => frames.run(undefined, fn));
}

/**
 * The journaled call running now. `scope` is its journal key: steps started inside it are numbered
 * within it, so they keep their keys whatever else replays. `step` is set only for a single step or
 * tool call, for useRun().idempotencyKey(); calls that span many side effects (a framework turn)
 * leave it unset, so those never share one key.
 */
export interface Frame {
  scope: string;
  step?: StepInfo;
}

const FRAME = Symbol.for("agent-unit.frame");
const frames: AsyncLocalStorage<Frame | undefined> = ((globalThis as Record<symbol, unknown>)[FRAME] ??=
  new AsyncLocalStorage<Frame | undefined>()) as AsyncLocalStorage<Frame | undefined>;

/** @internal */
export function runInFrame<T>(frame: Frame | undefined, fn: () => T): T {
  return frames.run(frame, fn);
}

/** @internal */
export function currentFrame(): Frame | undefined {
  return frames.getStore();
}

/** An idempotency key for one step of one run: SHA-256, base64url, 32 characters. */
export async function idempotencyKey(runId: string, stepKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(`agent-unit\0${runId}\0${stepKey}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest.subarray(0, 24)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
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
