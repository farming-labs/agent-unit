import type { RunContext } from "../runtime/context";
import type { KeyValueStore } from "../runtime/store";
import type { AgentCard, AgentEventBody, RunInput } from "../types";

export interface Durable {
  /** Journals any call: runs once, replays from the journal afterwards. */
  step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  /** Wraps an AI SDK provider model (`doGenerate` / `doStream`): every call is a step that streams text events. */
  model<M>(model: M): M;
  /** Wraps a record of tools with `execute`: every call is a step that emits tool events. */
  tools<T extends Record<string, unknown>>(tools: T): T;
  /** Wraps one tool function. `toolCallId` (when the framework provides one) keys the step. */
  tool<A extends unknown[], R>(name: string, execute: (...args: A) => R, options?: { toolCallId?: (...args: A) => string | undefined }): (...args: A) => Promise<Awaited<R>>;
}

export interface AdapterContext {
  input: RunInput;
  signal: AbortSignal;
  run: RunContext;
  durable: Durable;
  /**
   * Persistent storage private to this adapter, for state the framework keeps itself (LangGraph
   * checkpoints, for example). Lives in the app's agent-unit storage.
   */
  kv: KeyValueStore;
  /**
   * Emits an AG-UI event. Call it from live work (inside a step): code outside steps runs again
   * when a run continues, and would repeat its events.
   */
  emit(event: AgentEventBody): void;
}

export interface AgentAdapter<TAgent> {
  /** The framework name shown in the manifest. */
  name: string;
  /** Recognises this framework's agents. Must be cheap and must not import optional SDKs. */
  match(value: unknown): value is TAgent;
  /** Name, description, tools and input schema for the manifest. Optional. */
  describe?(agent: TAgent): Partial<Omit<AgentCard, "name" | "framework">>;
  /** Runs the agent and returns its result: a value, a promise or an async iterable that is drained. */
  run(agent: TAgent, ctx: AdapterContext): unknown;
}

/** Declares a framework adapter. */
export function defineAdapter<TAgent>(adapter: AgentAdapter<TAgent>): AgentAdapter<TAgent> {
  return adapter;
}
