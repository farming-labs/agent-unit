import { currentInternals, RunHalted, type RunInternals } from "../runtime/context";
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

type StreamPart = { type: string; id?: string; delta?: string };

/** Emits AG-UI text events for AI SDK stream parts. */
function textEvents(run: RunInternals, key: string) {
  const open = new Set<string>();
  const messageId = (id = "0") => `${key}:${id}`;
  return {
    part(part: StreamPart) {
      if (part.type === "text-start") {
        open.add(messageId(part.id));
        run.emitEvent({ type: "TEXT_MESSAGE_START", messageId: messageId(part.id), role: "assistant" });
      } else if (part.type === "text-delta" && part.delta) {
        if (!open.has(messageId(part.id))) this.part({ type: "text-start", id: part.id });
        run.emitEvent({ type: "TEXT_MESSAGE_CONTENT", messageId: messageId(part.id), delta: part.delta });
      } else if (part.type === "text-end" && open.delete(messageId(part.id))) {
        run.emitEvent({ type: "TEXT_MESSAGE_END", messageId: messageId(part.id) });
      }
    },
    close() {
      for (const id of open) run.emitEvent({ type: "TEXT_MESSAGE_END", messageId: id });
      open.clear();
    },
  };
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
  doGenerate(options: unknown): PromiseLike<{ content?: Array<{ type: string; text?: string }> } & Record<string, unknown>>;
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
          const events = textEvents(run, key);
          (value.content ?? []).forEach((part, index) => {
            if (part.type !== "text" || !part.text) return;
            events.part({ type: "text-delta", id: String(index), delta: part.text });
          });
          events.close();
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
        const events = textEvents(run, key);
        const stream = result.stream.pipeThrough(
          new TransformStream<StreamPart, StreamPart>({
            transform(part, controller) {
              parts.push(part);
              events.part(part);
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
  options: { toolCallId?: (...args: A) => string | undefined } = {},
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
        run.emitEvent({ type: "TOOL_CALL_START", toolCallId, toolCallName: name });
        run.emitEvent({ type: "TOOL_CALL_ARGS", toolCallId, delta: stringify(args[0]) });
        run.emitEvent({ type: "TOOL_CALL_END", toolCallId });
        const result: Awaited<R> = await execute(...args);
        return result;
      });
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

export function durableStep<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const run = currentInternals();
  if (!run) return Promise.resolve(fn());
  return run.durableCall({ name: `step:${name}` }, fn).then((result) => result.value);
}

export function createDurable(): Durable {
  return { step: durableStep, model: durableModel, tools: durableTools, tool: durableTool };
}
