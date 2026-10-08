import { durableModel, durableTool } from "../adapter/durable";
import { defineAdapter, type AdapterContext } from "../adapter/types";

// Mastra agents run on AI SDK models, so durability comes from the same journaled model and tool
// wrappers as the AI SDK adapter. The adapter works on a fork of the agent (Mastra's own lightweight
// clone), so the app's agent instance is never mutated. Pauses use agent-unit's run.interrupt()
// inside tools; Mastra's suspend/approval flows need Mastra storage and are left to Mastra. An agent
// with memory gets the run's thread (and `input.resourceId`, or the thread, as its resource).

interface MastraAgent {
  id: string;
  name: string;
  getDescription?(): string;
  getModel(): Promise<unknown>;
  listTools(): Promise<Record<string, unknown>> | Record<string, unknown>;
  __fork(): MastraAgent;
  __updateModel(options: { model: unknown }): void;
  __setTools(tools: Record<string, unknown>): void;
  getMemory?(): Promise<MastraMemory | undefined>;
  stream(
    messages: unknown,
    options?: Record<string, unknown>,
  ): Promise<{ consumeStream(): Promise<void>; text: Promise<string>; error?: Error; messageList?: MastraMessageList }>;
}

type MastraMessage = Record<string, unknown> & { id: string };
interface MastraMessageList {
  get: { input: { db(): MastraMessage[] }; response: { db(): MastraMessage[] } };
}
interface MastraMemory {
  getMergedThreadConfig?(): { workingMemory?: { enabled?: boolean }; observationalMemory?: boolean | { enabled?: boolean } };
  getThreadById(args: { threadId: string }): Promise<unknown>;
  saveThread(args: { thread: Record<string, unknown> }): Promise<unknown>;
  saveMessages(args: { messages: MastraMessage[] }): Promise<unknown>;
}

type MastraTool = { execute?: (...args: unknown[]) => unknown; description?: string; id?: string };

function durableMastraTools(tools: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as MastraTool | undefined)?.execute;
    if (typeof execute !== "function") {
      out[name] = tool;
      continue;
    }
    // Keep the prototype: Mastra recognises its own tool instances.
    const copy = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool) as MastraTool;
    copy.execute = durableTool(name, execute.bind(tool), {
      toolCallId: (_input: unknown, context?: unknown) => {
        const ctx = context as { agent?: { toolCallId?: string }; toolCallId?: string } | undefined;
        return ctx?.agent?.toolCallId ?? ctx?.toolCallId;
      },
    });
    out[name] = copy;
  }
  return out;
}

const forks = new WeakMap<MastraAgent, Promise<MastraAgent>>();

/** A fork of the agent with a durable model and durable tools; the wrappers find the run per call. */
function durableFork(agent: MastraAgent): Promise<MastraAgent> {
  let fork = forks.get(agent);
  if (!fork) {
    fork = (async () => {
      const forked = agent.__fork();
      forked.__updateModel({ model: durableModel(await agent.getModel()) });
      forked.__setTools(durableMastraTools(await agent.listTools()));
      return forked;
    })();
    forks.set(agent, fork);
    fork.catch(() => forks.delete(agent));
  }
  return fork;
}

function mastraMessages(input: Record<string, unknown>): unknown {
  if (typeof input.prompt === "string") return input.prompt;
  if (typeof input.message === "string") return input.message;
  if (Array.isArray(input.messages)) return input.messages;
  throw new TypeError("Mastra runs take `prompt`, `message` or `messages` input.");
}

export const mastraAdapter = defineAdapter<MastraAgent>({
  name: "mastra",
  apiVersion: 1,
  match: (value): value is MastraAgent => {
    const agent = value as Partial<MastraAgent> | null;
    return (
      typeof agent === "object" &&
      agent !== null &&
      typeof agent.__fork === "function" &&
      typeof agent.__updateModel === "function" &&
      typeof agent.stream === "function" &&
      typeof agent.listTools === "function"
    );
  },
  describe(agent) {
    const description = agent.getDescription?.() || undefined;
    return description ? { description } : {};
  },
  async run(agent, ctx: AdapterContext) {
    const fork = await durableFork(agent);
    const memory = await fork.getMemory?.();
    const thread = ctx.run.threadId;
    const resource = typeof ctx.input.resourceId === "string" ? ctx.input.resourceId : thread;
    // A run that pauses or restarts replays from the top, and Mastra saving messages as it goes would
    // store the turn again on every replay. So memory is read-only while the run executes, and the
    // finished turn is saved once at the end. Read-only also turns off working and observational
    // memory, so agents using those keep Mastra's own saving (a replayed turn may then be stored twice).
    const config = memory?.getMergedThreadConfig?.() ?? {};
    const observational = config.observationalMemory;
    const saveAtEnd =
      memory !== undefined &&
      !config.workingMemory?.enabled &&
      !(observational && (typeof observational !== "object" || observational.enabled !== false));
    const result = await fork.stream(mastraMessages(ctx.input), {
      abortSignal: ctx.signal,
      // The run's thread is Mastra's thread, so an agent with memory sees the conversation so far.
      ...(memory ? { memory: { thread, resource, ...(saveAtEnd ? { options: { readOnly: true } } : {}) } } : {}),
    });
    await result.consumeStream();
    if (result.error) throw result.error;
    if (saveAtEnd && result.messageList) {
      const list = result.messageList;
      // Journaled, under ids derived from the run: a crash mid-save overwrites instead of adding copies.
      await ctx.durable.step("mastra:memory", async () => {
        const turn = [...list.get.input.db(), ...list.get.response.db()].map((message, index) => ({
          ...message,
          id: `${ctx.run.id}-${index}`,
          threadId: thread,
          resourceId: resource,
        }));
        if (!(await memory!.getThreadById({ threadId: thread }))) {
          const now = new Date();
          await memory!.saveThread({ thread: { id: thread, resourceId: resource, title: "", createdAt: now, updatedAt: now } });
        }
        await memory!.saveMessages({ messages: turn });
        return turn.length;
      });
    }
    return await result.text;
  },
});

export default mastraAdapter;
