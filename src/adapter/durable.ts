import { currentInternals, RunHalted, type RunInternals, type StepInfo } from "../runtime/context";
import type { TokenUsage } from "../types";
import type { Durable } from "./types";

// Wrappers are created once per agent and find the current run through async context when they
// are called, so one wrapped model or tool serves every run.

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify(String(value));
  }
}

type StreamPart = { type: string; id?: string; delta?: string; usage?: unknown };

/** AG-UI events for AI SDK stream parts: text as TEXT_MESSAGE_*, reasoning as REASONING_*. */
function streamEvents(run: RunInternals, key: string) {
  const text = new Set<string>();
  const reasoning = new Set<string>();
  const messageId = (id = "0") => `${key}:${id}`;
  const reasoningId = (id = "0") => `${key}:reasoning:${id}`;
  const endReasoning = (id: string) => {
    run.emitEvent({ type: "REASONING_MESSAGE_END", messageId: id });
    run.emitEvent({ type: "REASONING_END", messageId: id });
  };
  return {
    part(part: StreamPart) {
      if (part.type === "text-start") {
        text.add(messageId(part.id));
        run.emitEvent({ type: "TEXT_MESSAGE_START", messageId: messageId(part.id), role: "assistant" });
      } else if (part.type === "text-delta" && part.delta) {
        if (!text.has(messageId(part.id))) this.part({ type: "text-start", id: part.id });
        run.emitEvent({ type: "TEXT_MESSAGE_CONTENT", messageId: messageId(part.id), delta: part.delta });
      } else if (part.type === "text-end" && text.delete(messageId(part.id))) {
        run.emitEvent({ type: "TEXT_MESSAGE_END", messageId: messageId(part.id) });
      } else if (part.type === "reasoning-start") {
        reasoning.add(reasoningId(part.id));
        run.emitEvent({ type: "REASONING_START", messageId: reasoningId(part.id) });
        run.emitEvent({ type: "REASONING_MESSAGE_START", messageId: reasoningId(part.id), role: "reasoning" });
      } else if (part.type === "reasoning-delta" && part.delta) {
        if (!reasoning.has(reasoningId(part.id))) this.part({ type: "reasoning-start", id: part.id });
        run.emitEvent({ type: "REASONING_MESSAGE_CONTENT", messageId: reasoningId(part.id), delta: part.delta });
      } else if (part.type === "reasoning-end" && reasoning.delete(reasoningId(part.id))) {
        endReasoning(reasoningId(part.id));
      }
    },
    close() {
      for (const id of text) run.emitEvent({ type: "TEXT_MESSAGE_END", messageId: id });
      for (const id of reasoning) endReasoning(id);
      text.clear();
      reasoning.clear();
    },
  };
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** AG-UI token usage from an AI SDK usage object: the nested form (`inputTokens.total`) or the flat one. */
export function aiSdkUsage(usage: unknown, model: { provider?: unknown; modelId?: unknown }): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as Record<string, unknown>;
  const input = raw.inputTokens && typeof raw.inputTokens === "object" ? (raw.inputTokens as Record<string, unknown>) : undefined;
  const output = raw.outputTokens && typeof raw.outputTokens === "object" ? (raw.outputTokens as Record<string, unknown>) : undefined;
  const inputTokens = input ? count(input.total) : count(raw.inputTokens);
  const outputTokens = output ? count(output.total) : count(raw.outputTokens);
  const result: TokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: count(raw.totalTokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined),
    reasoningTokens: output ? count(output.reasoning) : count(raw.reasoningTokens),
    cachedInputTokens: input ? count(input.cacheRead) : count(raw.cachedInputTokens),
    cacheWriteInputTokens: input ? count(input.cacheWrite) : undefined,
  };
  if (typeof model.provider === "string") result.provider = model.provider;
  if (typeof model.modelId === "string") result.model = model.modelId;
  for (const name of Object.keys(result) as (keyof TokenUsage)[]) if (result[name] === undefined) delete result[name];
  return result;
}

function streamFromParts(parts: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

interface ProviderModel {
  provider?: string;
  modelId?: string;
  doGenerate(options: unknown): PromiseLike<{ content?: Array<{ type: string; text?: string }>; usage?: unknown } & Record<string, unknown>>;
  doStream(options: unknown): PromiseLike<{ stream: ReadableStream<StreamPart> } & Record<string, unknown>>;
}

function isProviderModel(value: unknown): value is ProviderModel {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProviderModel).doGenerate === "function" &&
    typeof (value as ProviderModel).doStream === "function"
  );
}

const wrappedModels = new WeakMap<object, unknown>();

/** Wraps an AI SDK provider model so every call is a journaled step that streams text events. */
export function durableModel<M>(model: M): M {
  if (!isProviderModel(model)) return model;
  const cached = wrappedModels.get(model);
  if (cached) return cached as M;
  const wrapped = Object.create(model as object, {
    doGenerate: {
      value: async (options: unknown) => {
        const run = currentInternals();
        if (!run) return model.doGenerate(options);
        const key = run.allocate("model");
        const { value, replayed } = await run.durableCall(key, async () => await model.doGenerate(options), { journalErrors: false });
        if (!replayed) {
          const events = streamEvents(run, key);
          (value.content ?? []).forEach((part, index) => {
            if ((part.type !== "text" && part.type !== "reasoning") || !part.text) return;
            events.part({ type: `${part.type}-delta`, id: String(index), delta: part.text });
            events.part({ type: `${part.type}-end`, id: String(index) });
          });
          events.close();
          const usage = aiSdkUsage(value.usage, model);
          if (usage) run.addUsage(usage);
        }
        return value;
      },
    },
    doStream: {
      value: async (options: unknown) => {
        const run = currentInternals();
        if (!run) return model.doStream(options);
        const key = run.allocate("model");
        const replayed = run.readStep(key);
        if (replayed) {
          const stored = replayed.value as { parts: unknown[]; response?: unknown };
          return { stream: streamFromParts(stored.parts), response: stored.response };
        }
        await run.assertLive();
        const result = await model.doStream(options);
        const parts: unknown[] = [];
        const events = streamEvents(run, key);
        const stream = result.stream.pipeThrough(
          new TransformStream<StreamPart, StreamPart>({
            transform(part, controller) {
              parts.push(part);
              events.part(part);
              if (part.type === "finish") {
                const usage = aiSdkUsage(part.usage, model);
                if (usage) run.addUsage(usage);
              }
              controller.enqueue(part);
            },
            async flush() {
              events.close();
              // Recorded only once the whole response arrived: a cut-off stream is simply re-requested on replay.
              if (!parts.some((part) => (part as StreamPart).type === "error")) await run.record(key, { parts, response: result.response });
            },
          }),
        );
        return { ...result, stream };
      },
    },
  });
  wrappedModels.set(model as object, wrapped);
  return wrapped as M;
}

/** Wraps one tool function so each call is a journaled step that emits AG-UI tool events. */
export function durableTool<A extends unknown[], R>(
  name: string,
  execute: (...args: A) => R,
  options: {
    toolCallId?: (...args: A) => string | undefined;
    /** The tool's input among the arguments, for the TOOL_CALL_ARGS event. Default: the first argument. */
    input?: (...args: A) => unknown;
  } = {},
): (...args: A) => Promise<Awaited<R>> {
  return async (...args: A): Promise<Awaited<R>> => {
    const run = currentInternals();
    if (!run) return (await execute(...args)) as Awaited<R>;
    const callId = options.toolCallId?.(...args);
    const key = callId ? `tool:${name}:${callId}` : run.allocate(`tool:${name}`);
    const toolCallId = callId ?? key;
    let started = false;
    try {
      const { value, replayed } = await run.durableCall<Awaited<R>>(key, async (): Promise<Awaited<R>> => {
        started = true;
        // A call that paused (for an approval) and continues later was already announced.
        const announced = `${key}:announced`;
        if (!run.isReplay(announced)) {
          run.emitEvent({ type: "TOOL_CALL_START", toolCallId, toolCallName: name });
          const input = options.input ? options.input(...args) : args[0];
          run.emitEvent({ type: "TOOL_CALL_ARGS", toolCallId, delta: typeof input === "string" ? input : stringify(input) });
          run.emitEvent({ type: "TOOL_CALL_END", toolCallId });
          await run.record(announced, true);
        }
        const result: Awaited<R> = await execute(...args);
        return result;
      }, { step: true });
      if (!replayed) run.emitEvent({ type: "TOOL_CALL_RESULT", toolCallId, content: stringify(value) });
      return value;
    } catch (error) {
      if (started && !(error instanceof RunHalted)) {
        run.emitEvent({ type: "TOOL_CALL_RESULT", toolCallId, content: stringify({ error: error instanceof Error ? error.message : String(error) }) });
      }
      throw error;
    }
  };
}

type ToolLike = { execute?: (...args: unknown[]) => unknown };

/** Wraps every tool in a record that has an `execute` function. */
export function durableTools<T extends Record<string, unknown>>(tools: T): T {
  if (!tools || typeof tools !== "object") return tools;
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as ToolLike | undefined)?.execute;
    if (typeof execute !== "function") {
      out[name] = tool;
      continue;
    }
    const copy = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool);
    copy.execute = durableTool(name, execute.bind(tool), {
      // AI SDK and Mastra pass the model's tool call id in the second argument; replay reproduces it.
      toolCallId: (_input: unknown, callOptions?: unknown) =>
        (callOptions as { toolCallId?: string } | undefined)?.toolCallId,
    });
    out[name] = copy;
  }
  return out as T;
}

export function durableStep<T>(name: string, fn: (step: StepInfo) => T | Promise<T>): Promise<T> {
  const run = currentInternals();
  // Outside a run nothing is journaled or retried: a fresh key per call.
  if (!run) return Promise.resolve(fn({ idempotencyKey: crypto.randomUUID() }));
  // Adapters journal a whole framework turn this way, so useRun().idempotencyKey() stays unavailable
  // inside (one key for many side effects would make a provider drop all but the first); the
  // function still receives the key for a step that is one side effect.
  return run.durableCall({ name: `step:${name}` }, fn).then((result) => result.value);
}

export function createDurable(): Durable {
  return { step: durableStep, model: durableModel, tools: durableTools, tool: durableTool };
}
