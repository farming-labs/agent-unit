import { generateText, jsonSchema, stepCountIs, tool, ToolLoopAgent } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { defineAgent } from "../src/agents";
import { aiSdkAdapter } from "../src/adapters/ai-sdk";
import { useRun } from "../src/runtime/context";
import { collect, createEngine, types } from "./helpers";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function streamOf(parts: unknown[]) {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

/** A scripted model: the first call asks for the refund tool, the second answers in text. */
function refundModel() {
  const calls = { provider: 0 };
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls.provider++;
      if (calls.provider === 1) {
        return streamOf([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call_1", toolName: "refund", input: JSON.stringify({ orderId: "123" }) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
        ]);
      }
      return streamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Refunded " },
        { type: "text-delta", id: "t1", delta: "order 123." },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ]);
    },
  }) as any;
  return { model, calls };
}

function refundTool(sideEffects: { count: number }) {
  return tool({
    description: "Refund an order",
    inputSchema: jsonSchema<{ orderId: string }>({
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
    }),
    execute: async ({ orderId }) => {
      const decision = await useRun().interrupt<{ approved: boolean }>("approve-refund", { orderId });
      if (!decision.approved) return { status: "declined" };
      sideEffects.count++;
      return { status: "refunded", orderId };
    },
  });
}

describe("AI SDK adapter", () => {
  it("matches ToolLoopAgent instances and plain settings objects, not other objects", () => {
    const { model } = refundModel();
    expect(aiSdkAdapter.match(new ToolLoopAgent({ model }))).toBe(true);
    expect(aiSdkAdapter.match({ model })).toBe(true);
    expect(aiSdkAdapter.match(new (class Other { model = model })())).toBe(false);
    expect(aiSdkAdapter.match(null)).toBe(false);
  });

  it("makes a ToolLoopAgent durable: an interrupt in a tool parks the run and resume never repeats work", async () => {
    const { model, calls } = refundModel();
    const sideEffects = { count: 0 };
    const agent = new ToolLoopAgent({ model, tools: { refund: refundTool(sideEffects) } });
    const engine = createEngine({ support: agent });

    expect(engine.manifest().agents[0]).toMatchObject({ name: "support", framework: "ai-sdk", tools: [{ name: "refund", description: "Refund an order" }] });

    const { run, done } = await engine.start("support", { messages: [{ role: "user", content: "Refund order 123" }] });
    const parked = await done;
    expect(parked).toMatchObject({ status: "interrupted", interrupt: { name: "approve-refund", payload: { orderId: "123" } } });
    expect(calls.provider).toBe(1);
    expect(sideEffects.count).toBe(0);

    const resumed = await engine.resume(run.id, { approved: true });
    expect(await resumed.done).toMatchObject({ status: "completed", output: "Refunded order 123." });
    // The first model response came from the journal: only the second call reached the provider.
    expect(calls.provider).toBe(2);
    expect(sideEffects.count).toBe(1);

    const events = await collect(engine.events(run.id));
    expect(types(events)).toEqual([
      "RUN_STARTED",
      // The tool call is announced once, before it pauses for approval…
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_INTERRUPTED",
      // …and continues after the resume without being announced again.
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(events.find((event) => event.type === "TOOL_CALL_START")).toMatchObject({ toolCallId: "call_1", toolCallName: "refund" });
    expect(events.find((event) => event.type === "TOOL_CALL_RESULT")).toMatchObject({ content: JSON.stringify({ status: "refunded", orderId: "123" }) });
    expect(events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => (event as any).delta).join("")).toBe("Refunded order 123.");
  });

  it("runs plain streamText settings durably", async () => {
    const { model, calls } = refundModel();
    const sideEffects = { count: 0 };
    const engine = createEngine({
      support: { model, tools: { refund: refundTool(sideEffects) }, stopWhen: stepCountIs(5), description: "Refunds" },
    });
    expect(engine.manifest().agents[0]).toMatchObject({ framework: "ai-sdk", description: "Refunds" });
    const { run, done } = await engine.start("support", { prompt: "Refund order 123" });
    expect((await done)?.status).toBe("interrupted");
    const resumed = await engine.resume(run.id, { approved: false });
    expect(await resumed.done).toMatchObject({ status: "completed", output: "Refunded order 123." });
    expect(calls.provider).toBe(2);
    expect(sideEffects.count).toBe(0);
  });

  it("journals generate calls too, through durable.model in a custom agent", async () => {
    let providerCalls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        providerCalls++;
        return {
          content: [{ type: "text", text: `draft ${providerCalls}` }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        };
      },
    }) as any;
    const engine = createEngine({
      writer: defineAgent(async (_input, run, ctx) => {
        const { text } = await generateText({ model: ctx.durable.model(model), prompt: "write" });
        const approved = await run.interrupt<boolean>("publish", { text });
        return approved ? text : "rejected";
      }),
    });
    const { run, done } = await engine.start("writer");
    expect(await done).toMatchObject({ status: "interrupted", interrupt: { payload: { text: "draft 1" } } });
    const resumed = await engine.resume(run.id, true);
    expect(await resumed.done).toMatchObject({ status: "completed", output: "draft 1" });
    expect(providerCalls).toBe(1);
  });
});
