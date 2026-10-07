import { Agent, tool, type Model, type ModelRequest, type ModelResponse } from "@openai/agents";
import { Usage } from "@openai/agents";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { functionAdapter } from "../src/agents";
import { openAIAgentsAdapter } from "../src/adapters/openai-agents";
import { collect, createEngine, memoryStore, types } from "./helpers";

const adapters = [openAIAgentsAdapter, functionAdapter];

type Output = ModelResponse["output"];
const usage = { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const callTool = (callId: string, name: string, args: unknown): Output => [
  { type: "function_call", callId, name, arguments: JSON.stringify(args), status: "completed" } as never,
];
const say = (text: string, id = "msg_1"): Output => [
  { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text }] } as never,
];

/** A scripted model: each call returns the next output, streamed as text deltas when asked to stream. */
function scriptedModel(script: Output[], calls: { count: number }): Model {
  const next = () => {
    const output = script[calls.count++];
    if (!output) throw new Error(`model called ${calls.count} times, script has ${script.length}`);
    return output;
  };
  return {
    async getResponse(_request: ModelRequest): Promise<ModelResponse> {
      return { usage: new Usage(usage), output: next(), responseId: `resp_${calls.count}` };
    },
    async *getStreamedResponse(_request: ModelRequest) {
      const output = next();
      yield { type: "response_started" };
      for (const { text, id } of output.flatMap((item) => {
        const message = item as { type: string; id?: string; content?: { text: string }[] };
        return message.type === "message" ? (message.content ?? []).map((part) => ({ text: part.text, id: message.id })) : [];
      })) {
        for (const word of text.split(/(?<= )/)) yield { type: "output_text_delta", delta: word, itemId: id };
      }
      yield { type: "response_done", response: { id: `resp_${calls.count}`, usage, output } };
    },
  } as unknown as Model;
}

function refundAgent(model: Model, effects: { refunds: number }) {
  const refund = tool({
    name: "refund",
    description: "Refunds an order.",
    parameters: z.object({ orderId: z.string() }),
    needsApproval: true,
    execute: async ({ orderId }) => {
      effects.refunds++;
      return `refunded ${orderId}`;
    },
  });
  return new Agent({ name: "Support", instructions: "Help with refunds.", model, tools: [refund] });
}

describe("OpenAI Agents adapter", () => {
  it("recognises SDK agents and describes their tools", () => {
    const agent = refundAgent(scriptedModel([], { count: 0 }), { refunds: 0 });
    expect(openAIAgentsAdapter.match(agent)).toBe(true);
    expect(openAIAgentsAdapter.match({ name: "x", tools: [] })).toBe(false);
    const engine = createEngine({ support: agent }, {}, adapters);
    expect(engine.manifest().agents[0]).toEqual({
      name: "support",
      framework: "openai-agents",
      description: "Help with refunds.",
      tools: [{ name: "refund", description: "Refunds an order." }],
    });
  });

  it("parks on a tool approval, survives a restart and runs the tool once", async () => {
    const calls = { count: 0 };
    const effects = { refunds: 0 };
    const script = [callTool("call_1", "refund", { orderId: "o_1" }), say("Your refund for o_1 is done.")];
    const store = memoryStore();

    const first = createEngine({ support: refundAgent(scriptedModel(script, calls), effects) }, { store }, adapters);
    const { run, done } = await first.start("support", { prompt: "refund o_1" });
    const parked = await done;
    expect(parked).toMatchObject({
      status: "interrupted",
      interrupt: { name: "tool-approval", payload: { callId: "call_1", tool: "refund", arguments: { orderId: "o_1" }, agent: "Support" } },
    });
    expect(effects.refunds).toBe(0);
    expect(calls.count).toBe(1);

    // A new process: same script position, fresh agent objects.
    const second = createEngine({ support: refundAgent(scriptedModel(script, calls), effects) }, { store }, adapters);
    const finished = await (await second.resume(run.id, { approved: true })).done;
    expect(finished).toMatchObject({ status: "completed", output: "Your refund for o_1 is done." });
    expect(effects.refunds).toBe(1);
    expect(calls.count).toBe(2);

    const events = await collect(second.events(run.id));
    const text = events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => (event as { delta: string }).delta);
    expect(text.join("")).toBe("Your refund for o_1 is done.");
    expect(types(events).filter((type) => type.startsWith("TOOL_CALL") || type.startsWith("RUN_"))).toEqual([
      "RUN_STARTED",
      "RUN_INTERRUPTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_FINISHED",
    ]);
    expect(events.find((event) => event.type === "TOOL_CALL_ARGS")).toMatchObject({ toolCallId: "call_1", delta: '{"orderId":"o_1"}' });
  });

  it("rejects a tool when the approval is declined", async () => {
    const calls = { count: 0 };
    const effects = { refunds: 0 };
    const script = [callTool("call_2", "refund", { orderId: "o_2" }), say("I could not refund o_2.")];
    const engine = createEngine({ support: refundAgent(scriptedModel(script, calls), effects) }, {}, adapters);
    const { run, done } = await engine.start("support", { prompt: "refund o_2" });
    await done;
    const finished = await (await engine.resume(run.id, false)).done;
    expect(finished).toMatchObject({ status: "completed", output: "I could not refund o_2." });
    expect(effects.refunds).toBe(0);
  });

  it("replays model responses and tool results after a crash inside a turn", async () => {
    const calls = { count: 0 };
    let lookups = 0;
    const lookup = tool({
      name: "lookup",
      description: "Looks up an order.",
      parameters: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => `order ${orderId} #${++lookups}`,
    });
    const script = [callTool("call_3", "lookup", { orderId: "o_3" }), say("Order o_3 is paid.")];
    const store = memoryStore();
    let crash = true;
    // The second model call fails once, the way a dying process would leave the turn unfinished.
    const model = scriptedModel(script, calls);
    const flaky = {
      ...model,
      getStreamedResponse(request: ModelRequest) {
        if (calls.count === 1 && crash) {
          crash = false;
          throw new Error("connection reset");
        }
        return model.getStreamedResponse(request);
      },
    } as Model;
    const engine = createEngine({ support: new Agent({ name: "Support", model: flaky, tools: [lookup] }) }, { store }, adapters);
    const { run, done } = await engine.start("support", { prompt: "is o_3 paid?" });
    expect((await done)?.status).toBe("failed");

    // Recover the turn the way the sweep does: the failed turn's outcome is not journaled.
    expect(Object.keys(await store.getJournal(run.id))).toContain("step:openai-agents#0");
    await store.deleteJournalEntry(run.id, "step:openai-agents#0");
    const record = (await store.getRun(run.id))!;
    await store.putRun({ ...record, status: "running", error: undefined });
    const recovered = await engine.continue(run.id);
    expect(recovered).toMatchObject({ status: "completed", output: "Order o_3 is paid." });
    expect(lookups).toBe(1);
    expect(calls.count).toBe(2);
  });

  it("follows handoffs with durable tools on the receiving agent", async () => {
    const calls = { count: 0 };
    const effects = { refunds: 0 };
    const model = scriptedModel(
      [
        callTool("call_h", "transfer_to_Refunds", {}),
        callTool("call_r", "refund", { orderId: "o_4" }),
        say("Refunded o_4."),
      ],
      calls,
    );
    const refunds = refundAgent(model, effects);
    refunds.name = "Refunds";
    const triage = new Agent({ name: "Triage", model, handoffs: [refunds] });
    const engine = createEngine({ triage }, {}, adapters);
    const { run, done } = await engine.start("triage", { prompt: "refund o_4" });
    expect(await done).toMatchObject({ status: "interrupted", interrupt: { payload: { tool: "refund", agent: "Refunds" } } });
    const finished = await (await engine.resume(run.id, { call_r: { approved: true } })).done;
    expect(finished).toMatchObject({ status: "completed", output: "Refunded o_4." });
    expect(effects.refunds).toBe(1);
  });
});

describe("OpenAI Agents adapter: handoff()", () => {
  it("makes agents reached through handoff() durable, and runs onHandoff once", async () => {
    const { handoff } = await import("@openai/agents");
    const calls = { count: 0 };
    let lookups = 0;
    let handoffs = 0;
    let crash = true;
    const model = scriptedModel(
      [callTool("call_t", "transfer_to_Refunds", {}), callTool("call_l", "lookup", { orderId: "o_9" }), say("Order o_9 is refunded.")],
      calls,
    );
    // The third model call fails once, as if the process died before the turn was recorded.
    const flaky = {
      ...model,
      getStreamedResponse(request: ModelRequest) {
        if (calls.count === 2 && crash) {
          crash = false;
          throw new Error("connection reset");
        }
        return model.getStreamedResponse(request);
      },
    } as Model;
    const lookup = tool({
      name: "lookup",
      description: "Looks up an order.",
      parameters: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => `order ${orderId} #${++lookups}`,
    });
    const refunds = new Agent({ name: "Refunds", model: flaky, tools: [lookup] });
    const triage = new Agent({ name: "Triage", model: flaky, handoffs: [handoff(refunds, { onHandoff: () => void ++handoffs })] });
    const store = memoryStore();
    const engine = createEngine({ triage }, { store }, adapters);
    const { run, done } = await engine.start("triage", { prompt: "refund o_9" });
    expect((await done)?.status).toBe("failed");
    expect([lookups, handoffs]).toEqual([1, 1]);

    // Recover the turn the way the sweep does after a crash.
    await store.deleteJournalEntry(run.id, "step:openai-agents#0");
    const record = (await store.getRun(run.id))!;
    await store.putRun({ ...record, status: "running", error: undefined });
    const recovered = await engine.continue(run.id);
    expect(recovered).toMatchObject({ status: "completed", output: "Order o_9 is refunded." });
    // The specialist's tool and the app's onHandoff callback each ran exactly once.
    expect([lookups, handoffs]).toEqual([1, 1]);
    expect(calls.count).toBe(3);
  });
});
