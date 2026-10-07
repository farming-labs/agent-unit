import { Agent, Handoff, Runner, RunState, Usage, type Model, type ModelProvider, type ModelRequest, type ModelResponse } from "@openai/agents";
import { durableTool } from "../adapter/durable";
import { defineAdapter, type AdapterContext } from "../adapter/types";
import { currentInternals, type RunInternals } from "../runtime/context";
import { toJsonSafe } from "../runtime/serialize";

// The OpenAI Agents SDK pauses for tool approvals with a serializable RunState. This adapter
// journals one step per run turn (the state at each pause), and inside a turn journals every model
// response and every tool call, so a crash mid-turn replays them instead of calling again. Model
// keys carry the turn number: a replayed turn never re-allocates its own calls.

type AnyAgent = Agent<any, any>;

interface Approval {
  callId: string;
  tool: string;
  arguments: unknown;
  agent: string;
}

type TurnOutcome = { output: unknown } | { state: string; approvals: Approval[] };

const turns = new WeakMap<RunInternals, number>();
const modelKey = (run: RunInternals) => run.allocate(`openai-agents:${turns.get(run) ?? 0}:model`);

type StreamEvent = { type: string; delta?: string; itemId?: string; response?: { output?: unknown[] } };

function textEmitter(run: RunInternals, key: string) {
  let open: string | undefined;
  return {
    delta(delta: string, itemId = "0") {
      const messageId = `${key}:${itemId}`;
      if (open !== messageId) {
        this.close();
        open = messageId;
        run.emitEvent({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
      }
      run.emitEvent({ type: "TEXT_MESSAGE_CONTENT", messageId, delta });
    },
    close() {
      if (open) run.emitEvent({ type: "TEXT_MESSAGE_END", messageId: open });
      open = undefined;
    },
  };
}

function outputText(output: unknown[] | undefined): { id?: string; text: string }[] {
  const texts: { id?: string; text: string }[] = [];
  for (const item of output ?? []) {
    const message = item as { type?: string; id?: string; content?: { type?: string; text?: string }[] };
    if (message.type !== "message") continue;
    const text = (message.content ?? []).map((part) => (part.type === "output_text" ? (part.text ?? "") : "")).join("");
    if (text) texts.push({ id: message.id, text });
  }
  return texts;
}

const wrappedModels = new WeakMap<object, Model>();

/** Journals a model's responses: live calls run once, replays return the recorded response. */
function durableAgentsModel(model: Model): Model {
  const cached = wrappedModels.get(model);
  if (cached) return cached;
  const wrapped: Model = Object.create(model, {
    getResponse: {
      async value(request: ModelRequest): Promise<ModelResponse> {
        const run = currentInternals();
        if (!run) return model.getResponse(request);
        const key = modelKey(run);
        const { value, replayed } = await run.durableCall(key, async () => toJsonSafe(await model.getResponse(request)) as ModelResponse, {
          journalErrors: false,
        });
        if (!replayed) {
          const text = textEmitter(run, key);
          for (const { id, text: chunk } of outputText(value.output)) text.delta(chunk, id);
          text.close();
        }
        return { ...value, usage: new Usage(value.usage as never) };
      },
    },
    getStreamedResponse: {
      value: async function* (request: ModelRequest): AsyncIterable<StreamEvent> {
        const run = currentInternals();
        if (!run) {
          yield* model.getStreamedResponse(request) as AsyncIterable<StreamEvent>;
          return;
        }
        const key = modelKey(run);
        const stored = run.readStep(key);
        if (stored) {
          yield* (stored.value as { events: StreamEvent[] }).events;
          return;
        }
        await run.assertLive();
        const events: StreamEvent[] = [];
        const text = textEmitter(run, key);
        let completed = false;
        try {
          for await (const event of model.getStreamedResponse(request) as AsyncIterable<StreamEvent>) {
            events.push(toJsonSafe(event) as StreamEvent);
            if (event.type === "output_text_delta" && event.delta) text.delta(event.delta, event.itemId);
            if (event.type === "response_done") completed = true;
            yield event;
          }
        } finally {
          text.close();
        }
        // Recorded only once the whole response arrived: a cut-off stream is re-requested on replay.
        if (completed) await run.record(key, { events });
      },
    },
  });
  wrappedModels.set(model, wrapped);
  return wrapped;
}

const isModel = (value: unknown): value is Model =>
  typeof value === "object" && value !== null && typeof (value as Model).getResponse === "function";

type FunctionToolLike = { type: string; name: string; invoke: (...args: any[]) => Promise<unknown> };

const durableAgents = new WeakMap<AnyAgent, AnyAgent>();

/** A clone of the agent (and the agents it hands off to) with durable model and function tools. */
function durableAgent(agent: AnyAgent, seen = new Map<AnyAgent, AnyAgent>()): AnyAgent {
  const cached = durableAgents.get(agent) ?? seen.get(agent);
  if (cached) return cached;
  const tools = agent.tools.map((tool) => {
    const fn = tool as unknown as FunctionToolLike;
    if (fn.type !== "function" || typeof fn.invoke !== "function") return tool;
    const copy = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool) as FunctionToolLike;
    copy.invoke = durableTool(fn.name, fn.invoke.bind(tool), {
      toolCallId: (_context: unknown, _input: unknown, details?: { toolCall?: { callId?: string } }) => details?.toolCall?.callId,
      input: (_context: unknown, input: unknown) => input,
    });
    return copy as unknown as typeof tool;
  });
  const clone = agent.clone({ tools, ...(isModel(agent.model) ? { model: durableAgentsModel(agent.model) } : {}) });
  seen.set(agent, clone);
  clone.handoffs = agent.handoffs.map((target) => {
    if (target instanceof Agent) return durableAgent(target, seen);
    if (target instanceof Handoff) return durableHandoff(target, seen);
    return target;
  });
  durableAgents.set(agent, clone);
  return clone;
}

/**
 * A `handoff(agent, { onHandoff, … })` aimed at a durable copy of its agent. The SDK's own
 * `clone({ agent })` keeps the tool name, description, input schema and filters; `onHandoff` (the
 * app's callback) is journaled like a tool call, so a replayed turn does not run it again.
 */
function durableHandoff(target: Handoff<any, any>, seen: Map<AnyAgent, AnyAgent>): Handoff<any, any> {
  const agent = durableAgent(target.agent, seen);
  return target.clone({
    agent,
    onInvokeHandoff: async (context, args) => {
      const run = currentInternals();
      const invoke = async () => {
        await target.onInvokeHandoff(context, args);
        return null;
      };
      if (run) await run.durableCall({ name: `openai-agents:${turns.get(run) ?? 0}:handoff:${target.agentName}` }, invoke);
      else await invoke();
      return agent;
    },
  });
}

/** Wraps the provider that resolves string model names, so those models are durable too. */
function durableProvider(base: ModelProvider): ModelProvider {
  return { getModel: async (name?: string) => durableAgentsModel(await base.getModel(name)) } as ModelProvider;
}

function agentInput(input: Record<string, unknown>): string | Record<string, unknown>[] {
  if (typeof input.prompt === "string") return input.prompt;
  if (typeof input.message === "string") return input.message;
  if (Array.isArray(input.messages)) {
    return (input.messages as { role: string; content: unknown }[]).map((message) =>
      message.role === "assistant" && typeof message.content === "string"
        ? { role: "assistant", status: "completed", content: [{ type: "output_text", text: message.content }] }
        : { role: message.role, content: message.content },
    );
  }
  throw new TypeError("OpenAI Agents runs take `prompt`, `message` or `messages` input.");
}

/**
 * Applies an answer to pending approvals: `true`/`false` or `{ approved }` for all of them, or a map
 * from tool call id to either.
 */
function approves(answer: unknown, callId: string): boolean {
  const verdict = (value: unknown): boolean | undefined =>
    typeof value === "boolean" ? value : value && typeof value === "object" && "approved" in value ? Boolean((value as { approved: unknown }).approved) : undefined;
  const all = verdict(answer);
  if (all !== undefined) return all;
  if (answer && typeof answer === "object") return verdict((answer as Record<string, unknown>)[callId]) ?? false;
  return false;
}

export const openAIAgentsAdapter = defineAdapter<AnyAgent>({
  name: "openai-agents",
  apiVersion: 1,
  match: (value): value is AnyAgent => value instanceof Agent,
  describe(agent) {
    const tools = agent.tools.map((tool) => {
      const { name, description } = tool as unknown as { name: string; description?: string };
      return description ? { name, description } : { name };
    });
    const description = agent.handoffDescription || (typeof agent.instructions === "string" ? agent.instructions : "");
    return description ? { description, tools } : { tools };
  },
  async run(source, ctx: AdapterContext) {
    const agent = durableAgent(source);
    const runner = new Runner({ modelProvider: durableProvider(new Runner().config.modelProvider) });
    const internals = currentInternals()!;
    let previous: { state: string; answer: unknown } | undefined;

    for (let turn = 0; ; turn++) {
      turns.set(internals, turn);
      const outcome = await ctx.durable.step<TurnOutcome>("openai-agents", async () => {
        let input: string | Record<string, unknown>[] | RunState<unknown, AnyAgent> = agentInput(ctx.input);
        if (previous) {
          const state = await RunState.fromString(agent, previous.state);
          for (const item of state.getInterruptions()) {
            const callId = (item.rawItem as { callId?: string; id?: string }).callId ?? (item.rawItem as { id?: string }).id ?? "";
            if (approves(previous.answer, callId)) state.approve(item);
            else state.reject(item);
          }
          input = state;
        }
        const result = await runner.run(agent, input as never, { stream: true, signal: ctx.signal });
        for await (const _event of result);
        await result.completed;
        if (result.error) throw result.error;
        if (result.interruptions?.length) {
          return {
            state: result.state.toString(),
            approvals: result.interruptions.map((item) => {
              const raw = item.rawItem as { callId?: string; id?: string; name?: string; arguments?: string };
              let args: unknown = raw.arguments;
              try {
                args = raw.arguments ? JSON.parse(raw.arguments) : undefined;
              } catch {}
              return { callId: raw.callId ?? raw.id ?? "", tool: item.toolName ?? raw.name ?? "tool", arguments: args, agent: item.agent.name };
            }),
          };
        }
        return { output: toJsonSafe(result.finalOutput) };
      });

      if ("output" in outcome) return outcome.output;
      const [first] = outcome.approvals;
      const answer =
        outcome.approvals.length === 1
          ? await ctx.run.interrupt("tool-approval", first)
          : await ctx.run.interrupt("tool-approval", { approvals: outcome.approvals });
      previous = { state: outcome.state, answer };
    }
  },
});

export default openAIAgentsAdapter;
