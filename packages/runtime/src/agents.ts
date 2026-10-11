import { defineAdapter, type AdapterContext, type AgentAdapter } from "./adapter/types";
import type { RunContext } from "./runtime/context";
import type { AgentCard, RunInput } from "./types";

const AGENT = Symbol.for("agent-unit.agent");

export interface AgentDefinition<TOutput = unknown> {
  description?: string;
  tools?: { name: string; description?: string }[];
  /** Your agent loop. Wrap side effects in `run.step`, pause with `run.interrupt`, wait with `run.sleep`. */
  run(input: RunInput, run: RunContext, ctx: AdapterContext): TOutput | Promise<TOutput> | AsyncIterable<unknown>;
}

export interface DefinedAgent<TOutput = unknown> extends AgentDefinition<TOutput> {
  readonly [AGENT]: true;
}

/** An agent written without a framework, as one async function. */
export function defineAgent<TOutput>(definition: AgentDefinition<TOutput> | AgentDefinition<TOutput>["run"]): DefinedAgent<TOutput> {
  const normalized = typeof definition === "function" ? { run: definition } : definition;
  return { ...normalized, [AGENT]: true };
}

export const functionAdapter: AgentAdapter<DefinedAgent> = defineAdapter<DefinedAgent>({
  name: "agent-unit",
  apiVersion: 1,
  match: (value): value is DefinedAgent => typeof value === "object" && value !== null && (value as DefinedAgent)[AGENT] === true,
  describe: (agent) => ({ description: agent.description, tools: agent.tools ?? [] }),
  run: (agent, ctx) => agent.run(ctx.input, ctx.run, ctx),
});

export interface ResolvedAgent {
  name: string;
  adapter: AgentAdapter<any>;
  agent: unknown;
  card: AgentCard;
}

/** Finds the adapter that recognises an agent and builds its manifest card. */
export function resolveAgent(name: string, value: unknown, adapters: AgentAdapter<any>[]): ResolvedAgent {
  // A module namespace resolves to its default export when the namespace itself is not an agent.
  const candidates = [value];
  if (value && typeof value === "object" && "default" in value) candidates.push((value as { default: unknown }).default);
  for (const agent of candidates) {
    const resolved = matchAdapter(name, agent, adapters);
    if (resolved) return resolved;
  }
  const agent = candidates.at(-1);
  const kind = agent === null ? "null" : typeof agent === "object" ? ((agent as object).constructor?.name ?? "object") : typeof agent;
  throw new Error(
    `No adapter recognises agent "${name}" (${kind}). Export an agent from a supported framework, wrap it with defineAgent(), or add an adapter in agent-unit.config.ts.`,
  );
}

function matchAdapter(name: string, agent: unknown, adapters: AgentAdapter<any>[]): ResolvedAgent | undefined {
  for (const adapter of adapters) {
    if (!adapter.match(agent)) continue;
    const described = adapter.describe?.(agent) ?? {};
    const card: AgentCard = { name, framework: adapter.name, tools: described.tools ?? [] };
    if (described.description) card.description = described.description;
    if (described.input !== undefined) card.input = described.input;
    return { name, adapter, agent, card };
  }
  return undefined;
}
