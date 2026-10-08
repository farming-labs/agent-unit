import { AIMessage } from "@langchain/core/messages";
import { END, interrupt, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { Agent as MastraAgent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { Agent as OpenAIAgent, tool as openAITool, Usage, type Model, type ModelRequest } from "@openai/agents";
import { jsonSchema, tool, ToolLoopAgent } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ADAPTER_API_VERSION, defineAdapter, validateAdapter } from "../src/adapter";
import { aiSdkAdapter } from "../src/adapters/ai-sdk";
import { langGraphAdapter } from "../src/adapters/langgraph";
import { mastraAdapter } from "../src/adapters/mastra";
import { openAIAgentsAdapter } from "../src/adapters/openai-agents";
import { useRun } from "../src/runtime/context";
import { assertAdapter, checkAdapter, type AdapterCheckKit } from "../src/testing";

/** A small framework agent-unit knows nothing about, and the adapter its authors would publish. */
class TinyAgent {
  constructor(readonly steps: Record<string, (value: string) => string | Promise<string>>) {}
  async run(input: Record<string, unknown>, options: { step(name: string, fn: () => unknown): Promise<unknown> }) {
    let value = String(input.prompt ?? "");
    for (const [name, fn] of Object.entries(this.steps)) value = (await options.step(name, () => fn(value))) as string;
    return value;
  }
}

const tinyAdapter = () =>
  defineAdapter<TinyAgent>({
    name: "tiny-agents",
    apiVersion: 1,
    match: (value): value is TinyAgent => value instanceof TinyAgent,
    run: (agent, ctx) => agent.run(ctx.input, { step: (name, fn) => ctx.durable.step(name, fn) }),
  });

const tinyAgent = (kit: AdapterCheckKit) =>
  new TinyAgent({
    upper: (text) => kit.effect("upper", () => text.toUpperCase()),
    mark: (text) => kit.effect("mark", () => `${text}!`),
  });

describe("adapter checks", () => {
  it("passes an adapter a third party wrote, including a pause across a restart", async () => {
    const report = await assertAdapter({
      adapter: tinyAdapter(),
      agent: tinyAgent,
      pause: {
        agent: (kit) =>
          new TinyAgent({
            ask: async (text) => `${text} ${(await useRun().interrupt<string>("approve")) === "yes" ? "approved" : "declined"}`,
            charge: (text) => kit.effect("charge", () => `${text}, charged`),
          }),
        answer: "yes",
      },
    });
    expect(report.checks.map((check) => check.name)).toEqual([
      "is a valid adapter",
      "recognises its own agents",
      "ignores everything else",
      "completes a run",
      "does its work inside journaled calls",
      "replays a finished run without repeating work",
      "pauses, survives a restart and resumes without repeating work",
    ]);
  });

  it("fails an adapter that runs the framework without journaling its work, and says what to change", async () => {
    const forgetful = defineAdapter<TinyAgent>({
      name: "forgetful",
      match: (value): value is TinyAgent => value instanceof TinyAgent,
      // Calls the steps directly: nothing is journaled, so recovery repeats everything.
      run: (agent, ctx) => agent.run(ctx.input, { step: async (_name, fn) => fn() }),
    });
    const report = await checkAdapter({ adapter: forgetful, agent: tinyAgent });
    expect(report.ok).toBe(false);
    const failed = Object.fromEntries(report.checks.filter((check) => !check.ok).map((check) => [check.name, check.message]));
    expect(Object.keys(failed)).toEqual(["does its work inside journaled calls", "replays a finished run without repeating work"]);
    expect(failed["does its work inside journaled calls"]).toMatch(/kit.effect\("upper", "mark"\) ran outside any journaled call.*ctx.durable/);
    // assertAdapter throws one error listing every failed check.
    await expect(assertAdapter({ adapter: forgetful, agent: tinyAgent })).rejects.toThrow(
      /failed agent-unit's checks:\n  ✗ does its work inside journaled calls: .*\n  ✗ replays a finished run without repeating work: Recovery did work again \(upper, mark\)/,
    );
  });

  it("catches adapters that claim other frameworks' agents, or throw on them", async () => {
    const greedy = await checkAdapter({ adapter: { ...tinyAdapter(), match: (_value: unknown): _value is TinyAgent => true }, agent: tinyAgent });
    expect(greedy.checks.find((check) => check.name === "ignores everything else")).toMatchObject({ ok: false, message: expect.stringMatching(/claimed null/) });
    const fragile = await checkAdapter({
      adapter: { ...tinyAdapter(), match: (value: unknown): value is TinyAgent => (value as TinyAgent).steps !== undefined && value instanceof TinyAgent },
      agent: tinyAgent,
    });
    expect(fragile.checks.find((check) => check.name === "ignores everything else")).toMatchObject({ ok: false, message: expect.stringMatching(/threw for null/) });
  });
});

describe("adapter validation", () => {
  it("explains what is wrong with something that is not a usable adapter", () => {
    expect(() => validateAdapter(tinyAdapter, "adapters[0]")).toThrow(/adapters\[0\] is a function, not an adapter.*adapters: \[myAdapter\(\)\]/);
    expect(() => validateAdapter({ name: "half" }, "adapters[0]")).toThrow(/Adapter "half" is missing `match` \(a function\), `run` \(a function\)/);
    expect(() => validateAdapter({ ...tinyAdapter(), apiVersion: ADAPTER_API_VERSION + 1 })).toThrow(
      /Adapter "tiny-agents" was written for adapter API 2, and this agent-unit supports up to 1\. Upgrade agent-unit\./,
    );
    expect(validateAdapter({ ...tinyAdapter(), apiVersion: undefined }).name).toBe("tiny-agents");
  });
});

// Our own adapters meet the bar we ask of others.
describe("built-in adapters pass the adapter checks", () => {
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
  /** Asks for the refund tool until the conversation holds its result, then answers. Stateless, like a real model. */
  const refundModel = () =>
    new MockLanguageModelV4({
      doStream: async ({ prompt }) =>
        prompt.some((message) => message.role === "tool")
          ? streamOf([
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "Refunded." },
              { type: "text-end", id: "t1" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ])
          : streamOf([
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "refund", input: JSON.stringify({ orderId: "o_1" }) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ]),
    }) as never;

  const refund = (kit: AdapterCheckKit, approval: boolean) => async () => {
    if (approval && !(await useRun().interrupt<{ approved: boolean }>("approve-refund")).approved) return "declined";
    return kit.effect("refund", () => "refunded");
  };

  it("ai-sdk", async () => {
    const agent = (approval: boolean) => (kit: AdapterCheckKit) =>
      new ToolLoopAgent({
        model: refundModel(),
        tools: {
          refund: tool({
            inputSchema: jsonSchema<{ orderId: string }>({ type: "object", properties: { orderId: { type: "string" } } }),
            execute: refund(kit, approval),
          }),
        },
      });
    await assertAdapter({ adapter: aiSdkAdapter, agent: agent(false), pause: { agent: agent(true), answer: { approved: true } } });
  });

  it("mastra", async () => {
    const agent = (approval: boolean) => (kit: AdapterCheckKit) =>
      new MastraAgent({
        id: "support",
        name: "Support",
        instructions: "Refund orders.",
        model: refundModel(),
        // Mastra's own approval option, not useRun().interrupt(): the adapter turns it into a pause.
        tools: {
          refund: createTool({
            id: "refund",
            description: "Refunds",
            inputSchema: z.object({ orderId: z.string() }),
            requireApproval: approval,
            execute: refund(kit, false),
          }),
        },
      });
    await assertAdapter({ adapter: mastraAdapter, agent: agent(false), pause: { agent: agent(true), answer: { approved: true } } });
  });

  it("openai-agents", async () => {
    const output = (request: ModelRequest) =>
      (Array.isArray(request.input) ? request.input : []).some((item) => (item as { type?: string }).type === "function_call_result")
        ? [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Refunded." }] }]
        : [{ type: "function_call", callId: "call_1", name: "refund", arguments: JSON.stringify({ orderId: "o_1" }), status: "completed" }];
    const model = {
      async getResponse(request: ModelRequest) {
        return { usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 }), output: output(request) as never, responseId: "r" };
      },
      async *getStreamedResponse(request: ModelRequest) {
        const items = output(request);
        yield { type: "response_started" };
        yield { type: "response_done", response: { id: "r", usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output: items } };
      },
    } as unknown as Model;
    const agent = (approval: boolean) => (kit: AdapterCheckKit) =>
      new OpenAIAgent({
        name: "Support",
        model,
        tools: [openAITool({ name: "refund", description: "Refunds", parameters: z.object({ orderId: z.string() }), needsApproval: approval, execute: () => kit.effect("refund", () => "refunded") })],
      });
    await assertAdapter({ adapter: openAIAgentsAdapter, agent: agent(false), pause: { agent: agent(true), answer: { approved: true } } });
  });

  it("langgraph", async () => {
    const graph = (approval: boolean) => (kit: AdapterCheckKit) =>
      new StateGraph(MessagesAnnotation)
        .addNode("plan", () => ({ messages: [new AIMessage(kit.effect("plan", () => "planned"))] }))
        .addNode("review", () => ({ messages: [new AIMessage(approval ? String(interrupt({ question: "ok?" })) : "auto")] }))
        .addNode("refund", () => ({ messages: [new AIMessage(kit.effect("refund", () => "refunded"))] }))
        .addEdge(START, "plan")
        .addEdge("plan", "review")
        .addEdge("review", "refund")
        .addEdge("refund", END)
        .compile();
    await assertAdapter({ adapter: langGraphAdapter, agent: graph(false), pause: { agent: graph(true), answer: "yes" } });
  });
});
