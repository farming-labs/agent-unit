import { durableModel, durableTool } from "../adapter/durable";
import { currentInternals } from "../runtime/context";
import { defineAdapter, type AdapterContext } from "../adapter/types";

// Mastra agents run on AI SDK models, so durability comes from the same journaled model and tool
// wrappers as the AI SDK adapter. The adapter works on a fork of the agent (Mastra's own lightweight
// clone), so the app's agent instance is never mutated. Pauses use agent-unit's run.interrupt()
// inside tools, tool approvals (`requireApproval`, `requireToolApproval`) and `suspend()`. An agent
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
  getDefaultOptions?(): Record<string, unknown> | Promise<Record<string, unknown>>;
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

type ApprovalRule = boolean | ((...args: unknown[]) => boolean | Promise<boolean>);
type MastraTool = {
  execute?: (...args: unknown[]) => unknown;
  description?: string;
  id?: string;
  requireApproval?: ApprovalRule;
  needsApprovalFn?: (input: unknown, context?: unknown) => boolean | Promise<boolean>;
};
type ToolContext = {
  toolCallId?: string;
  requestContext?: { entries?(): Iterable<[string, unknown]> };
  resumeData?: unknown;
  agent?: { toolCallId?: string; resumeData?: unknown };
};

/** Mastra's own result for a declined call, so the model sees what it would without agent-unit. */
const DECLINED = "Tool call was not approved by the user";

const plain = (requestContext: ToolContext["requestContext"]) =>
  typeof requestContext?.entries === "function" ? Object.fromEntries(requestContext.entries()) : undefined;

/** Whether a call needs approval: the tool's `requireApproval` or the agent's `requireToolApproval`, as Mastra decides it. */
async function needsApproval(tool: MastraTool, global: ApprovalRule | undefined, name: string, input: unknown, context: ToolContext | undefined) {
  const requestContext = plain(context?.requestContext);
  const own = tool.needsApprovalFn ?? tool.requireApproval;
  if (typeof own === "function" ? await own(input, { requestContext }) : own === true) return true;
  if (typeof global === "function") return Boolean(await global({ toolName: name, args: input, requestContext }));
  return global === true;
}

/** `true`/`false`, `{ approved }`, or a map from tool call id to either: the same answers as OpenAI Agents approvals. */
function approves(answer: unknown, callId: string): boolean {
  const verdict = (value: unknown): boolean | undefined =>
    typeof value === "boolean" ? value : value && typeof value === "object" && "approved" in value ? Boolean((value as { approved: unknown }).approved) : undefined;
  return verdict(answer) ?? (answer && typeof answer === "object" ? (verdict((answer as Record<string, unknown>)[callId]) ?? false) : false);
}

/**
 * Wraps each tool in a journaled call, and runs Mastra's pauses through agent-unit, so they survive
 * restarts and resume over the runs API: a call that needs approval pauses as "tool-approval" (the
 * same as OpenAI Agents approvals), and `suspend(payload)` pauses under the tool's name; resuming
 * runs the tool again with the answer as `resumeData`, as Mastra's own resume does.
 */
function durableMastraTools(tools: Record<string, unknown>, agentName: string, global: ApprovalRule | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(tools)) {
    const tool = value as MastraTool | undefined;
    const execute = tool?.execute;
    if (!tool || typeof execute !== "function") {
      out[name] = value;
      continue;
    }
    // Keep the prototype: Mastra recognises its own tool instances. Mastra's own approval pause would
    // need Mastra storage to resume; agent-unit asks instead.
    const copy = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool) as MastraTool;
    copy.requireApproval = false;
    copy.needsApprovalFn = undefined;
    const call = async (input: unknown, context?: ToolContext) => {
      const run = currentInternals();
      if (!run) return execute.call(tool, input, context);
      const callId = context?.agent?.toolCallId ?? context?.toolCallId ?? "";
      if (await needsApproval(tool, global, name, input, context)) {
        const answer = await run.interrupt("tool-approval", { callId, tool: name, arguments: input, agent: agentName });
        if (!approves(answer, callId)) return DECLINED;
      }
      // Every suspension already answered hands its answer on; the next suspend() pauses the run.
      let resumeData = context?.resumeData ?? context?.agent?.resumeData;
      for (let answered = run.answeredInterrupt(name); answered; answered = run.answeredInterrupt(name)) resumeData = answered.answer;
      const suspend = async (payload?: unknown) => {
        await run.interrupt(name, payload);
      };
      const next = { ...context, resumeData, suspend, ...(context?.agent ? { agent: { ...context.agent, resumeData, suspend } } : {}) };
      return execute.call(tool, input, next);
    };
    copy.execute = durableTool(name, call, {
      toolCallId: (_input, context) => context?.agent?.toolCallId ?? context?.toolCallId,
    }) as MastraTool["execute"];
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
      const defaults = await agent.getDefaultOptions?.();
      forked.__setTools(durableMastraTools(await agent.listTools(), agent.name, defaults?.requireToolApproval as ApprovalRule | undefined));
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
      // Approvals are asked through agent-unit by the tools themselves (see durableMastraTools).
      requireToolApproval: false,
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
