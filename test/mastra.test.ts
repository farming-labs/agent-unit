import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { functionAdapter } from "../src/agents";
import { aiSdkAdapter } from "../src/adapters/ai-sdk";
import { mastraAdapter } from "../src/adapters/mastra";
import { useRun } from "../src/runtime/context";
import { collect, createEngine, memoryStore, types } from "./helpers";

const adapters = [mastraAdapter, aiSdkAdapter, functionAdapter];

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const streamOf = (parts: unknown[]) => ({
  stream: new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  }),
});

function scriptedModel(calls: { count: number }) {
  return new MockLanguageModelV4({
    doStream: async () => {
      calls.count++;
      if (calls.count === 1) {
        return streamOf([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call_m1", toolName: "refund", input: JSON.stringify({ orderId: "o_m" }) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
        ]);
      }
      return streamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Refunded " },
        { type: "text-delta", id: "t1", delta: "o_m." },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ]);
    },
  }) as never;
}

function supportAgent(calls: { count: number }, effects: { refunds: number }) {
  const refund = createTool({
    id: "refund",
    description: "Refunds an order after approval.",
    inputSchema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => {
      const decision = await useRun().interrupt<{ approved: boolean }>("approve-refund", { orderId });
      if (!decision.approved) return { status: "declined" };
      effects.refunds++;
      return { status: "refunded", orderId };
    },
  });
  return new Agent({
    id: "support",
    name: "Support",
    description: "Handles refunds.",
    instructions: "You handle refunds.",
    model: scriptedModel(calls),
    tools: { refund },
  });
}

describe("Mastra adapter", () => {
  it("recognises Mastra agents before the AI SDK adapter does", () => {
    const agent = supportAgent({ count: 0 }, { refunds: 0 });
    expect(mastraAdapter.match(agent)).toBe(true);
    expect(aiSdkAdapter.match(agent)).toBe(false);
    expect(mastraAdapter.match({ stream() {} })).toBe(false);
    const engine = createEngine({ support: agent }, {}, adapters);
    expect(engine.manifest().agents[0]).toMatchObject({ name: "support", framework: "mastra", description: "Handles refunds." });
  });

  it("parks on an interrupt inside a tool, survives a restart and never repeats the model or the tool", async () => {
    const calls = { count: 0 };
    const effects = { refunds: 0 };
    const store = memoryStore();
    const first = createEngine({ support: supportAgent(calls, effects) }, { store }, adapters);
    const { run, done } = await first.start("support", { prompt: "refund o_m" });
    expect(await done).toMatchObject({ status: "interrupted", interrupt: { name: "approve-refund", payload: { orderId: "o_m" } } });
    expect(calls.count).toBe(1);

    const second = createEngine({ support: supportAgent(calls, effects) }, { store }, adapters);
    const finished = await (await second.resume(run.id, { approved: true })).done;
    expect(finished).toMatchObject({ status: "completed", output: "Refunded o_m." });
    expect(calls.count).toBe(2);
    expect(effects.refunds).toBe(1);

    const events = await collect(second.events(run.id));
    expect(types(events).filter((type) => !type.startsWith("TEXT_MESSAGE_CONTENT"))).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_INTERRUPTED",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
  });

  it("does not mutate the app's agent", async () => {
    const calls = { count: 0 };
    const agent = supportAgent(calls, { refunds: 0 });
    const before = (await agent.listTools()).refund;
    const engine = createEngine({ support: agent }, {}, adapters);
    await (await engine.start("support", { prompt: "refund" })).done;
    const after = (await agent.listTools()).refund;
    expect(after).toBe(before);
    expect(after?.execute).toBe(before?.execute);
  });
});
