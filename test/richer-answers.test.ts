import { AIMessage } from "@langchain/core/messages";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { Agent as MastraAgent } from "@mastra/core/agent";
import { Agent as OpenAIAgent, type Model } from "@openai/agents";
import { jsonSchema, Output, tool, ToolLoopAgent } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { functionAdapter } from "../src/agents";
import { aiSdkAdapter } from "../src/adapters/ai-sdk";
import { langGraphAdapter } from "../src/adapters/langgraph";
import { mastraAdapter } from "../src/adapters/mastra";
import { openAIAgentsAdapter } from "../src/adapters/openai-agents";
import { useRun } from "../src/runtime/context";
import type { AgentEvent } from "../src/types";
import { collect, createEngine, memoryStore, types } from "./helpers";

// Reasoning, token usage and structured output reach clients the way AG-UI defines them.

const usage = {
  inputTokens: { total: 10, noCache: 7, cacheRead: 3, cacheWrite: undefined },
  outputTokens: { total: 5, text: 3, reasoning: 2 },
};
const streamOf = (parts: unknown[]) => ({
  stream: new ReadableStream({
    start(controller) {
      for (const part of [{ type: "stream-start", warnings: [] }, ...parts]) controller.enqueue(part);
      controller.close();
    },
  }),
});
const thinkThenSay = (text: string) =>
  streamOf([
    { type: "reasoning-start", id: "r1" },
    { type: "reasoning-delta", id: "r1", delta: "The user wants " },
    { type: "reasoning-delta", id: "r1", delta: "a refund." },
    { type: "reasoning-end", id: "r1" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ]);
const ofType = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) => events.filter((event) => event.type === type) as Extract<AgentEvent, { type: T }>[];
const MOCK_USAGE = { provider: "mock-provider", model: "mock-model-id", inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 2, cachedInputTokens: 3 };

describe("reasoning, usage and structured output", () => {
  it("streams an AI SDK model's reasoning as AG-UI REASONING_* events and reports token usage", async () => {
    const engine = createEngine({ support: new ToolLoopAgent({ model: new MockLanguageModelV4({ doStream: async () => thinkThenSay("Refunded.") as never }) }) });
    const { run, done } = await engine.start("support", { prompt: "refund o_1" });
    const final = (await done)!;
    const events = await collect(engine.events(run.id));
    expect(types(events)).toEqual([
      "RUN_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(ofType(events, "REASONING_MESSAGE_START")[0]).toMatchObject({ role: "reasoning" });
    expect(ofType(events, "REASONING_MESSAGE_CONTENT")[0]).toMatchObject({ delta: "The user wants a refund." });
    expect(ofType(events, "RUN_FINISHED")[0]).toMatchObject({ result: "Refunded.", usage: [MOCK_USAGE] });
    expect(final.usage).toEqual([MOCK_USAGE]);
  });

  it("counts each model call once, even when a run pauses and replays", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        calls++;
        return (
          prompt.some((message) => message.role === "tool")
            ? thinkThenSay("Refunded.")
            : streamOf([{ type: "tool-call", toolCallId: "c1", toolName: "refund", input: "{}" }, { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage }])
        ) as never;
      },
    });
    const refund = tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => useRun().interrupt("approve") });
    const store = memoryStore();
    const engine = createEngine({ support: new ToolLoopAgent({ model, tools: { refund } }) }, { store });
    const { run, done } = await engine.start("support", { prompt: "refund" });
    expect((await done)?.usage).toEqual([MOCK_USAGE]);
    // Resuming replays the first model call from the journal: only the second one is new.
    const resumed = await createEngine({ support: new ToolLoopAgent({ model, tools: { refund } }) }, { store }).resume(run.id, true);
    const final = (await resumed.done)!;
    expect(calls).toBe(2);
    expect(final.usage).toEqual([{ ...MOCK_USAGE, inputTokens: 20, outputTokens: 10, totalTokens: 30, reasoningTokens: 4, cachedInputTokens: 6 }]);
  });

  it("returns an AI SDK agent's structured output as the run's output", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () =>
        streamOf([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: JSON.stringify({ orderId: "o_1", refunded: true }) },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ]) as never,
    });
    const agent = new ToolLoopAgent({ model, output: Output.object({ schema: z.object({ orderId: z.string(), refunded: z.boolean() }) }) });
    const final = await (await createEngine({ support: agent }).start("support", { prompt: "refund o_1" })).done;
    expect(final).toMatchObject({ status: "completed", output: { orderId: "o_1", refunded: true } });
  });

  it("does the same for Mastra: reasoning, usage, and structuredOutput as the output", async () => {
    const adapters = [mastraAdapter, aiSdkAdapter, functionAdapter];
    const talker = new MastraAgent({ id: "t", name: "T", instructions: "x", model: new MockLanguageModelV4({ doStream: async () => thinkThenSay("Refunded.") as never }) as never });
    const engine = createEngine({ support: talker }, {}, adapters);
    const { run, done } = await engine.start("support", { prompt: "refund" });
    const final = (await done)!;
    const events = await collect(engine.events(run.id));
    expect(ofType(events, "REASONING_MESSAGE_CONTENT").map((event) => event.delta).join("")).toBe("The user wants a refund.");
    expect(final.usage).toEqual([MOCK_USAGE]);

    const structured = new MastraAgent({
      id: "s",
      name: "S",
      instructions: "x",
      model: new MockLanguageModelV4({
        doStream: async () =>
          streamOf([
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: JSON.stringify({ refunded: true }) },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ]) as never,
      }) as never,
      defaultOptions: { structuredOutput: { schema: z.object({ refunded: z.boolean() }) } },
    });
    const answer = await (await createEngine({ support: structured }, {}, adapters).start("support", { prompt: "refund" })).done;
    expect(answer).toMatchObject({ status: "completed", output: { refunded: true } });
  });

  it("reports OpenAI Agents reasoning (streamed deltas or whole items) and usage", async () => {
    const response = (withDeltas: boolean) => ({
      async getResponse() {
        throw new Error("streamed only");
      },
      async *getStreamedResponse() {
        yield { type: "response_started" };
        if (withDeltas) yield { type: "model", event: { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Checking the order." } };
        yield { type: "output_text_delta", delta: "Done.", itemId: "msg_1" };
        yield {
          type: "response_done",
          response: {
            id: "r",
            usage: { requests: 1, inputTokens: 12, outputTokens: 6, totalTokens: 18, inputTokensDetails: [{ cached_tokens: 4 }], outputTokensDetails: [{ reasoning_tokens: 2 }] },
            output: [
              { type: "reasoning", id: "rs_1", content: [{ type: "input_text", text: "Checking the order." }] },
              { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done." }] },
            ],
          },
        };
      },
    }) as unknown as Model;
    for (const withDeltas of [true, false]) {
      const engine = createEngine({ support: new OpenAIAgent({ name: "Support", model: response(withDeltas) }) }, {}, [openAIAgentsAdapter, functionAdapter]);
      const { run, done } = await engine.start("support", { prompt: "status?" });
      const final = (await done)!;
      const events = await collect(engine.events(run.id));
      // Once, whether streamed or taken from the finished response.
      expect(ofType(events, "REASONING_MESSAGE_CONTENT").map((event) => event.delta)).toEqual(["Checking the order."]);
      expect(ofType(events, "REASONING_END")).toHaveLength(1);
      expect(final.usage).toEqual([{ inputTokens: 12, outputTokens: 6, totalTokens: 18, reasoningTokens: 2, cachedInputTokens: 4 }]);
    }
  });

  it("returns an OpenAI Agents outputType answer as the run's output", async () => {
    const model = {
      async getResponse() {
        return {
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ refunded: true }) }] }],
          responseId: "r",
        };
      },
      async *getStreamedResponse() {
        const output = [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ refunded: true }) }] }];
        yield { type: "response_started" };
        yield { type: "response_done", response: { id: "r", usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output } };
      },
    } as unknown as Model;
    const agent = new OpenAIAgent({ name: "Support", model, outputType: z.object({ refunded: z.boolean() }) });
    const final = await (await createEngine({ support: agent }, {}, [openAIAgentsAdapter, functionAdapter]).start("support", { prompt: "refund" })).done;
    expect(final).toMatchObject({ status: "completed", output: { refunded: true } });
  });

  it("reports LangGraph reasoning blocks and usage_metadata", async () => {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("agent", () => ({
        messages: [
          new AIMessage({
            content: [
              { type: "reasoning", reasoning: "Thinking it over." },
              { type: "text", text: "All done." },
            ],
            usage_metadata: { input_tokens: 8, output_tokens: 4, total_tokens: 12, output_token_details: { reasoning: 1 } },
            response_metadata: { model_name: "gpt-x", model_provider: "openai" },
          }),
        ],
      }))
      .addEdge(START, "agent")
      .addEdge("agent", END)
      .compile();
    const engine = createEngine({ support: graph }, {}, [langGraphAdapter, functionAdapter]);
    const { run, done } = await engine.start("support", { prompt: "go" });
    const final = (await done)!;
    const events = await collect(engine.events(run.id));
    expect(types(events).filter((type) => type.startsWith("REASONING") || type.startsWith("TEXT"))).toEqual([
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
    ]);
    expect(final.usage).toEqual([{ provider: "openai", model: "gpt-x", inputTokens: 8, outputTokens: 4, totalTokens: 12, reasoningTokens: 1 }]);
  });
});
