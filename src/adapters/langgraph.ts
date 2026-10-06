import { BaseCheckpointSaver, Command, type Checkpoint, type CheckpointMetadata, type CheckpointTuple } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { defineAdapter, type AdapterContext } from "../adapter/types";
import type { KeyValueStore } from "../runtime/store";
import type { AgentEventBody } from "../types";

// LangGraph keeps its own durable state in checkpoints, so this adapter does not journal model or
// tool calls. It gives the graph a checkpointer on agent-unit storage, journals one step per graph
// turn, and maps LangGraph interrupts onto agent-unit interrupts, resuming with `Command({ resume })`.

interface CompiledGraph {
  lg_is_pregel: true;
  name?: string;
  description?: string;
  checkpointer?: unknown;
  nodes: Record<string, unknown>;
  stream(input: unknown, config: Record<string, unknown>): Promise<AsyncIterable<unknown>>;
  getState(config: RunnableConfig): Promise<{
    values: unknown;
    next: string[];
    config: RunnableConfig;
    tasks: { id: string; name: string; interrupts?: { id?: string; value?: unknown }[] }[];
  }>;
}

// Pending-write indexes for LangGraph's special channels (WRITES_IDX_MAP in the checkpoint package).
const SPECIAL_WRITES: Record<string, number> = { __error__: -1, __scheduled__: -2, __interrupt__: -3, __resume__: -4 };

const segment = (value: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") || "_";
};
const unsegment = (value: string) => {
  if (value === "_") return "";
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};
const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = (data: string) => Uint8Array.from(atob(data), (char) => char.charCodeAt(0));

type Serialized = [type: string, data: string];
interface StoredCheckpoint {
  checkpoint: Serialized;
  metadata: Serialized;
  parent?: string;
}

/** A LangGraph checkpointer on agent-unit storage: any unstorage driver, the same semantics as MemorySaver. */
export class AgentUnitCheckpointer extends BaseCheckpointSaver {
  constructor(private readonly kv: KeyValueStore) {
    super();
  }

  private async dump(value: unknown): Promise<Serialized> {
    const [type, data] = await this.serde.dumpsTyped(value);
    return [type, toBase64(typeof data === "string" ? new TextEncoder().encode(data) : data)];
  }

  private load<T>([type, data]: Serialized): Promise<T> {
    return this.serde.loadsTyped(type, fromBase64(data)) as Promise<T>;
  }

  private async tuple(threadId: string, ns: string, id: string, stored: StoredCheckpoint, config?: RunnableConfig): Promise<CheckpointTuple> {
    const writeKeys = await this.kv.keys(`wr:${segment(threadId)}:${segment(ns)}:${segment(id)}`);
    const pendingWrites = await Promise.all(
      writeKeys.map(async (key) => {
        const [taskId, channel, value] = (await this.kv.get<[string, string, Serialized]>(key))!;
        return [taskId, channel, await this.load(value)] as [string, string, unknown];
      }),
    );
    const tuple: CheckpointTuple = {
      config: config ?? { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: id } },
      checkpoint: await this.load<Checkpoint>(stored.checkpoint),
      metadata: await this.load<CheckpointMetadata>(stored.metadata),
      pendingWrites,
    };
    if (stored.parent) tuple.parentConfig = { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: stored.parent } };
    return tuple;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (threadId === undefined) return undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    let id = (config.configurable?.checkpoint_id as string | undefined) ?? "";
    const prefix = `cp:${segment(threadId)}:${segment(ns)}`;
    if (!id) {
      const latest = (await this.kv.keys(prefix)).map((key) => unsegment(key.slice(prefix.length + 1))).sort().at(-1);
      if (!latest) return undefined;
      id = latest;
      config = { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: id } };
    }
    const stored = await this.kv.get<StoredCheckpoint>(`${prefix}:${segment(id)}`);
    return stored ? this.tuple(threadId, ns, id, stored, config) : undefined;
  }

  async *list(
    config: RunnableConfig,
    options: { before?: RunnableConfig; limit?: number; filter?: Record<string, unknown> } = {},
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const nsFilter = config.configurable?.checkpoint_ns as string | undefined;
    const idFilter = config.configurable?.checkpoint_id as string | undefined;
    const before = options.before?.configurable?.checkpoint_id as string | undefined;
    let limit = options.limit;
    const entries = (await this.kv.keys(threadId === undefined ? "cp" : `cp:${segment(threadId)}`))
      .map((key) => {
        const [, thread, ns, id] = key.split(":");
        return { key, threadId: unsegment(thread!), ns: unsegment(ns!), id: unsegment(id!) };
      })
      .filter((entry) => (nsFilter === undefined || entry.ns === nsFilter) && (!idFilter || entry.id === idFilter) && (!before || entry.id < before))
      .sort((a, b) => b.id.localeCompare(a.id));
    for (const entry of entries) {
      const stored = await this.kv.get<StoredCheckpoint>(entry.key);
      if (!stored) continue;
      if (options.filter) {
        const metadata = await this.load<Record<string, unknown>>(stored.metadata);
        if (!Object.entries(options.filter).every(([key, value]) => metadata[key] === value)) continue;
      }
      if (limit !== undefined && limit-- <= 0) break;
      yield await this.tuple(entry.threadId, entry.ns, entry.id, stored);
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (threadId === undefined) throw new Error('LangGraph checkpoint is missing "thread_id".');
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const stored: StoredCheckpoint = { checkpoint: await this.dump(checkpoint), metadata: await this.dump(metadata) };
    const parent = config.configurable?.checkpoint_id as string | undefined;
    if (parent) stored.parent = parent;
    await this.kv.set(`cp:${segment(threadId)}:${segment(ns)}:${segment(checkpoint.id)}`, stored);
    return { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: [string, unknown][], taskId: string): Promise<void> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const id = config.configurable?.checkpoint_id as string | undefined;
    if (threadId === undefined || !id) throw new Error('LangGraph writes are missing "thread_id" or "checkpoint_id".');
    const prefix = `wr:${segment(threadId)}:${segment(ns)}:${segment(id)}:${segment(taskId)}`;
    await Promise.all(
      writes.map(async ([channel, value], index) => {
        const slot = SPECIAL_WRITES[channel] ?? index;
        const key = `${prefix}:${slot < 0 ? `n${-slot}` : `p${String(slot).padStart(6, "0")}`}`;
        // Regular writes are written once; special channels (errors, interrupts, resumes) overwrite.
        if (slot >= 0 && (await this.kv.get(key)) !== undefined) return;
        await this.kv.set(key, [taskId, channel, await this.dump(value)]);
      }),
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    for (const prefix of [`cp:${segment(threadId)}`, `wr:${segment(threadId)}`]) {
      for (const key of await this.kv.keys(prefix)) await this.kv.delete(key);
    }
  }
}

type MessageLike = {
  id?: string;
  content?: unknown;
  tool_calls?: { id?: string; name: string; args?: unknown }[];
  tool_call_chunks?: { id?: string; name?: string; args?: string; index?: number }[];
  tool_call_id?: string;
  name?: string;
  type?: string;
  getType?(): string;
  _getType?(): string;
};

const messageType = (message: MessageLike) => message.getType?.() ?? message._getType?.() ?? message.type ?? "unknown";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (typeof block === "string" ? block : block?.type === "text" ? String(block.text ?? "") : "")).join("");
  }
  return "";
}

const isMessage = (value: unknown): value is MessageLike =>
  typeof value === "object" && value !== null && (typeof (value as MessageLike).getType === "function" || typeof (value as MessageLike)._getType === "function");

/** LangChain messages as plain JSON: role, content and tool calls. */
function plain(value: unknown): unknown {
  if (isMessage(value)) {
    const message: Record<string, unknown> = { type: messageType(value), content: value.content };
    if (value.id) message.id = value.id;
    if (value.name) message.name = value.name;
    if (value.tool_calls?.length) message.tool_calls = value.tool_calls.map(({ id, name, args }) => ({ id, name, args }));
    if (value.tool_call_id) message.tool_call_id = value.tool_call_id;
    return message;
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)]));
  }
  return value;
}

/** Turns LangGraph `messages` stream chunks into AG-UI text and tool events. */
function messageEvents(emit: (event: AgentEventBody) => void) {
  let openText: string | undefined;
  const openTools = new Map<string, string>(); // tool call id -> name
  const chunkIds = new Map<string, string>(); // `${messageId}:${index}` -> tool call id
  const closeText = () => {
    if (openText) emit({ type: "TEXT_MESSAGE_END", messageId: openText });
    openText = undefined;
  };
  const closeTool = (id: string) => {
    if (openTools.delete(id)) emit({ type: "TOOL_CALL_END", toolCallId: id });
  };
  return {
    message(message: MessageLike) {
      const type = messageType(message);
      if (type === "tool" && message.tool_call_id) {
        closeTool(message.tool_call_id);
        emit({ type: "TOOL_CALL_RESULT", toolCallId: message.tool_call_id, content: textOf(message.content) || JSON.stringify(message.content) });
        return;
      }
      if (type !== "ai" && type !== "AIMessageChunk") return;
      const messageId = message.id ?? "ai";
      const text = textOf(message.content);
      if (text) {
        if (openText !== messageId) {
          closeText();
          openText = messageId;
          emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
        }
        emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: text });
      }
      if (message.tool_call_chunks?.length) {
        for (const chunk of message.tool_call_chunks) {
          const slot = `${messageId}:${chunk.index ?? 0}`;
          const id = chunk.id ?? chunkIds.get(slot);
          if (!id) continue;
          if (!openTools.has(id)) {
            closeText();
            chunkIds.set(slot, id);
            openTools.set(id, chunk.name ?? "tool");
            emit({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: chunk.name ?? "tool" });
          }
          if (chunk.args) emit({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: chunk.args });
        }
      } else if (message.tool_calls?.length) {
        for (const call of message.tool_calls) {
          if (!call.id || openTools.has(call.id)) continue;
          closeText();
          openTools.set(call.id, call.name);
          emit({ type: "TOOL_CALL_START", toolCallId: call.id, toolCallName: call.name });
          emit({ type: "TOOL_CALL_ARGS", toolCallId: call.id, delta: JSON.stringify(call.args ?? {}) });
        }
      }
    },
    end() {
      closeText();
      for (const id of [...openTools.keys()]) closeTool(id);
    },
  };
}

function graphInput(input: Record<string, unknown>): Record<string, unknown> {
  const text = typeof input.prompt === "string" ? input.prompt : typeof input.message === "string" ? input.message : undefined;
  const { prompt: _prompt, message: _message, ...rest } = input;
  if (text !== undefined && !Array.isArray(rest.messages)) return { ...rest, messages: [{ role: "user", content: text }] };
  return rest;
}

interface TurnOutcome {
  values: unknown;
  interrupts: { id?: string; task: string; value: unknown }[];
}

/** The graph with an agent-unit checkpointer, unless the app gave it one of its own. */
function withCheckpointer(graph: CompiledGraph, kv: KeyValueStore): CompiledGraph {
  if (graph.checkpointer instanceof BaseCheckpointSaver) return graph;
  return Object.create(graph, { checkpointer: { value: new AgentUnitCheckpointer(kv), enumerable: true } }) as CompiledGraph;
}

export const langGraphAdapter = defineAdapter<CompiledGraph>({
  name: "langgraph",
  match: (value): value is CompiledGraph =>
    typeof value === "object" && value !== null && (value as CompiledGraph).lg_is_pregel === true && typeof (value as CompiledGraph).stream === "function",
  describe(graph) {
    const tools: { name: string; description?: string }[] = [];
    for (const node of Object.values(graph.nodes ?? {})) {
      const bound = (node as { bound?: { tools?: unknown } })?.bound?.tools;
      const list = Array.isArray(bound) ? bound : bound instanceof Map ? [...bound.values()] : [];
      for (const tool of list as { name?: string; description?: string }[]) {
        if (tool?.name) tools.push(tool.description ? { name: tool.name, description: tool.description } : { name: tool.name });
      }
    }
    const description = graph.description;
    return description ? { description, tools } : { tools };
  },
  async run(source, ctx: AdapterContext) {
    const graph = withCheckpointer(source, ctx.kv);
    const config = { configurable: { thread_id: ctx.run.threadId } };
    let resume: { answer: unknown } | undefined;

    for (let turn = 0; ; turn++) {
      const outcome = await ctx.durable.step<TurnOutcome>("langgraph", async () => {
        // Remember where the thread stood before this turn: if the process dies mid-turn, the retry
        // continues the graph from its last checkpoint instead of sending the input twice.
        const marker = `turn:${ctx.run.id}:${turn}`;
        const before = await graph.getState(config);
        const beforeId = before.config?.configurable?.checkpoint_id as string | undefined;
        const started = await ctx.kv.get<{ base: string | null }>(marker);
        let payload: unknown;
        if (!started || (started.base ?? undefined) === beforeId) {
          if (!started) await ctx.kv.set(marker, { base: beforeId ?? null });
          payload = resume ? new Command({ resume: resume.answer }) : graphInput(ctx.input);
        } else if (before.tasks.some((task) => task.interrupts?.length) || before.next.length === 0) {
          payload = undefined;
        } else {
          payload = null;
        }

        if (payload !== undefined) {
          const events = messageEvents(ctx.emit);
          const stream = await graph.stream(payload, { ...config, streamMode: ["messages"], signal: ctx.signal });
          try {
            for await (const chunk of stream) {
              const [, data] = chunk as [string, [MessageLike, unknown]];
              if (Array.isArray(data) && data[0]) events.message(data[0]);
            }
          } finally {
            events.end();
          }
        }
        const state = await graph.getState(config);
        return {
          values: plain(state.values),
          interrupts: state.tasks.flatMap((task) => (task.interrupts ?? []).map((item) => ({ id: item.id, task: task.name, value: plain(item.value) }))),
        };
      });
      // Only after the turn is journaled: until then a retry needs the marker.
      await ctx.kv.delete(`turn:${ctx.run.id}:${turn}`);

      if (outcome.interrupts.length === 0) return outcome.values;
      // One pending interrupt resumes with the answer; several resume with a map of interrupt id to answer.
      const [first] = outcome.interrupts;
      const answer =
        outcome.interrupts.length === 1
          ? await ctx.run.interrupt(first!.task, first!.value)
          : await ctx.run.interrupt("langgraph", { interrupts: outcome.interrupts });
      resume = { answer };
    }
  },
});

export default langGraphAdapter;
