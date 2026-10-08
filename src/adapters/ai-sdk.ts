import { defineAdapter, type Durable } from "../adapter/types";
import type { RunInput } from "../types";

interface StreamResult {
  text: PromiseLike<string>;
  output?: PromiseLike<unknown>;
  fullStream?: AsyncIterable<{ type: string; error?: unknown }>;
}

/**
 * Drains a stream result and returns its text, or its structured output when the agent asks for
 * one (`output: Output.object(...)`). When the stream fails, the AI SDK reports only "No output
 * generated"; the cause (a 401 from the provider, a rate limit…) is in the stream's error part, so
 * that is what the run fails with.
 */
async function finish(result: StreamResult, structured: boolean): Promise<unknown> {
  let cause: unknown;
  if (result.fullStream) {
    for await (const part of result.fullStream) if (part.type === "error" && cause === undefined) cause = part.error;
  }
  try {
    return structured && result.output ? await result.output : await result.text;
  } catch (error) {
    throw cause ?? error;
  }
}

/** A ToolLoopAgent (`Agent` / `Experimental_Agent`) from the AI SDK. */
interface ToolLoopAgentLike {
  version: string;
  stream(options: Record<string, unknown>): Promise<StreamResult>;
  settings?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  id?: string;
}

/** A plain object of `streamText` settings: `{ model, tools, instructions, stopWhen, … }`. */
export interface AiSdkAgentConfig {
  model: unknown;
  tools?: Record<string, unknown>;
  instructions?: string;
  system?: string;
  description?: string;
  [setting: string]: unknown;
}

type AiSdkAgent = ToolLoopAgentLike | AiSdkAgentConfig;

function isToolLoopAgent(value: unknown): value is ToolLoopAgentLike {
  return typeof value === "object" && value !== null && (value as ToolLoopAgentLike).version === "agent-v1" && typeof (value as ToolLoopAgentLike).stream === "function";
}

function isPlainConfig(value: unknown): value is AiSdkAgentConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    "model" in value
  );
}

function callInput(input: RunInput): Record<string, unknown> {
  if (Array.isArray(input.messages)) return { messages: input.messages };
  if (typeof input.prompt === "string") return { prompt: input.prompt };
  if (typeof input.message === "string") return { prompt: input.message };
  return { prompt: "" };
}

function toolCards(tools: Record<string, unknown> | undefined) {
  return Object.entries(tools ?? {}).map(([name, tool]) => {
    const description = (tool as { description?: unknown })?.description;
    return typeof description === "string" ? { name, description } : { name };
  });
}

// One durable copy per agent: wrappers resolve the current run when called.
const durableAgents = new WeakMap<object, ToolLoopAgentLike>();

function durableToolLoopAgent(agent: ToolLoopAgentLike, durable: Durable): ToolLoopAgentLike {
  let copy = durableAgents.get(agent);
  if (copy) return copy;
  const settings = agent.settings;
  if (!settings) return agent;
  const Ctor = agent.constructor as new (settings: Record<string, unknown>) => ToolLoopAgentLike;
  copy = new Ctor({
    ...settings,
    model: durable.model(settings.model),
    tools: durable.tools((settings.tools as Record<string, unknown>) ?? {}),
  });
  durableAgents.set(agent, copy);
  return copy;
}

/**
 * The Vercel AI SDK: `ToolLoopAgent` instances and plain `streamText` settings objects. Model calls
 * and tool calls become durable steps. (A model given as a gateway string id cannot be wrapped, so
 * its calls repeat on replay; pass a provider model to make them durable too.)
 */
export const aiSdkAdapter = defineAdapter<AiSdkAgent>({
  name: "ai-sdk",
  apiVersion: 1,
  match: (value): value is AiSdkAgent => isToolLoopAgent(value) || isPlainConfig(value),
  describe(agent) {
    if (isToolLoopAgent(agent)) {
      return { tools: toolCards(agent.tools ?? (agent.settings?.tools as Record<string, unknown>)) };
    }
    return { description: agent.description, tools: toolCards(agent.tools) };
  },
  async run(agent, { input, signal, durable }) {
    if (isToolLoopAgent(agent)) {
      const result = await durableToolLoopAgent(agent, durable).stream({ ...callInput(input), abortSignal: signal });
      return finish(result, agent.settings?.output !== undefined);
    }
    const { streamText } = await import("ai");
    const { description: _description, ...settings } = agent;
    const result = streamText({
      ...settings,
      model: durable.model(agent.model),
      tools: durable.tools(agent.tools ?? {}),
      ...callInput(input),
      abortSignal: signal,
    } as Parameters<typeof streamText>[0]);
    return finish(result, agent.output !== undefined);
  },
});

export default aiSdkAdapter;
