import type { RunContext, StepInfo } from "../runtime/context";
import type { KeyValueStore } from "../runtime/store";
import type { AgentCard, AgentEventBody, RunInput } from "../types";

export interface Durable {
  /** Journals any call: runs once, replays from the journal afterwards. */
  step<T>(name: string, fn: (step: StepInfo) => T | Promise<T>): Promise<T>;
  /** Wraps an AI SDK provider model (`doGenerate` / `doStream`): every call is a step that streams text events. */
  model<M>(model: M): M;
  /** Wraps a record of tools with `execute`: every call is a step that emits tool events. */
  tools<T extends Record<string, unknown>>(tools: T): T;
  /** Wraps one tool function. `toolCallId` (when the framework provides one) keys the step. */
  tool<A extends unknown[], R>(
    name: string,
    execute: (...args: A) => R,
    options?: { toolCallId?: (...args: A) => string | undefined; input?: (...args: A) => unknown },
  ): (...args: A) => Promise<Awaited<R>>;
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

/**
 * The adapter interface this agent-unit implements. An adapter states the version it was written
 * for in `apiVersion`; agent-unit refuses, with a clear error, one written for a newer interface.
 */
export const ADAPTER_API_VERSION = 1;

export interface AgentAdapter<TAgent> {
  /** The framework name shown in the manifest. */
  name: string;
  /** The adapter interface this adapter was written for: `1`. Default 1. */
  apiVersion?: number;
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

/**
 * Checks that a value is an adapter this agent-unit can run, and says what to fix when it is not.
 * `source` names where it came from (a package, a config entry) in the error.
 */
export function validateAdapter(value: unknown, source = "An adapter"): AgentAdapter<any> {
  if (typeof value === "function") {
    throw new TypeError(`${source} is a function, not an adapter. Adapter packages export a function that returns the adapter: call it, as in \`adapters: [myAdapter()]\`.`);
  }
  if (!value || typeof value !== "object") {
    const kind = value === null || value === undefined ? String(value) : `a ${typeof value}`;
    throw new TypeError(`${source} is ${kind}, not an adapter.`);
  }
  const adapter = value as Partial<AgentAdapter<unknown>>;
  const label = typeof adapter.name === "string" && adapter.name ? `Adapter "${adapter.name}"` : source;
  const missing = [
    typeof adapter.name !== "string" || !adapter.name ? "`name` (a string)" : undefined,
    typeof adapter.match !== "function" ? "`match` (a function)" : undefined,
    typeof adapter.run !== "function" ? "`run` (a function)" : undefined,
    adapter.describe !== undefined && typeof adapter.describe !== "function" ? "`describe` (a function, when set)" : undefined,
  ].filter(Boolean);
  if (missing.length) throw new TypeError(`${label} is missing ${missing.join(", ")}.`);
  const version = adapter.apiVersion ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new TypeError(`${label} has an invalid \`apiVersion\` (${String(adapter.apiVersion)}); use ${ADAPTER_API_VERSION}.`);
  if (version > ADAPTER_API_VERSION) {
    throw new Error(
      `${label} was written for adapter API ${version}, and this agent-unit supports up to ${ADAPTER_API_VERSION}. Upgrade agent-unit.`,
    );
  }
  return adapter as AgentAdapter<any>;
}
