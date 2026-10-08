import { Agent } from "@mastra/core/agent";
import { InMemoryStore } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
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

describe("Mastra adapter: memory", () => {
  const say = (text: string) =>
    streamOf([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ]);
  const callRefund = () =>
    streamOf([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "call_mem", toolName: "refund", input: "{}" },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
    ]);
  const texts = (prompt: { role: string; content: unknown }[]) =>
    prompt.filter((message) => message.role !== "system").map((message) => `${message.role}: ${JSON.stringify(message.content).match(/"text":"([^"]*)"/)?.[1] ?? "(tool)"}`);
  const stored = async (memory: Memory, threadId: string, resourceId = threadId) =>
    (await memory.recall({ threadId, resourceId })).messages.map((message) => `${message.role}: ${JSON.stringify(message.content).match(/"(?:text|state)":"([^"]*)"/)?.[1]}`);

  it("gives the agent the conversation so far on the run's thread", async () => {
    const prompts: { role: string; content: unknown }[][] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt as never);
        return say(`answer ${prompts.length}`) as never;
      },
    });
    const memory = new Memory({ storage: new InMemoryStore() });
    const engine = createEngine({ chat: new Agent({ id: "chat", name: "Chat", instructions: "Be brief.", model: model as never, memory }) }, {}, adapters);
    await (await engine.start("chat", { prompt: "my name is Kinfe" }, { threadId: "t1" })).done;
    await (await engine.start("chat", { prompt: "what is my name?" }, { threadId: "t1" })).done;
    expect(texts(prompts[1]!)).toEqual(["user: my name is Kinfe", "assistant: answer 1", "user: what is my name?"]);
    // Another thread starts fresh; input.resourceId names the user.
    await (await engine.start("chat", { prompt: "hello", resourceId: "user_1" }, { threadId: "t2" })).done;
    expect(texts(prompts[2]!)).toEqual(["user: hello"]);
    expect(await stored(memory, "t2", "user_1")).toEqual(["user: hello", "assistant: answer 3"]);
  });

  it("stores a turn once, even when the run pauses and resumes or recovers from a crash", async () => {
    const memory = new Memory({ storage: new InMemoryStore() });
    const model = new MockLanguageModelV4({ doStream: async ({ prompt }) => (prompt.some((message) => message.role === "tool") ? say("refunded") : callRefund()) as never });
    const refund = createTool({
      id: "refund",
      description: "Refunds",
      inputSchema: z.object({}),
      execute: async () => ((await useRun().interrupt<boolean>("approve")) ? "ok" : "no"),
    });
    const store = memoryStore();
    const engine = createEngine({ support: new Agent({ id: "support", name: "Support", instructions: "x", model: model as never, tools: { refund }, memory }) }, { store }, adapters);
    const { run, done } = await engine.start("support", { prompt: "refund please" }, { threadId: "t3" });
    expect((await done)?.status).toBe("interrupted");
    const resumed = await engine.resume(run.id, true);
    expect((await resumed.done)?.status).toBe("completed");
    expect(await stored(memory, "t3")).toEqual(["user: refund please", "assistant: result"]);

    // The process died after saving the turn but before journaling that it did: saving again overwrites.
    await store.deleteJournalEntry(run.id, "step:mastra:memory#0");
    const record = (await store.getRun(run.id))!;
    await store.putRun({ ...record, status: "running", output: undefined });
    expect((await engine.continue(run.id))?.status).toBe("completed");
    expect(await stored(memory, "t3")).toEqual(["user: refund please", "assistant: result"]);
  });

  it("keeps working memory available to agents that use it", async () => {
    let tools: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        tools = (options.tools ?? []).map((tool) => tool.name);
        return say("ok") as never;
      },
    });
    const memory = new Memory({ storage: new InMemoryStore(), options: { workingMemory: { enabled: true } } });
    const engine = createEngine({ chat: new Agent({ id: "wm", name: "WM", instructions: "x", model: model as never, memory }) }, {}, adapters);
    expect((await (await engine.start("chat", { prompt: "hi" }, { threadId: "t4" })).done)?.status).toBe("completed");
    expect(tools).toContain("updateWorkingMemory");
    expect(await stored(memory, "t4")).toEqual(["user: hi", "assistant: ok"]);
  });
});

describe("Mastra adapter: approvals and suspend()", () => {
  const finish = (reason: "stop" | "tool-calls") => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
  /** Calls `tool` with `input` until the conversation holds its result, then says what the result was. */
  const modelCalling = (tool: string, input: unknown, prompts: unknown[][] = []) =>
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        const result = prompt.find((message) => message.role === "tool");
        return (
          result
            ? streamOf([
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: `tool said ${JSON.stringify(result.content).match(/"value":("[^"]*"|\{[^}]*\})/)?.[1]}` },
                { type: "text-end", id: "t" },
                finish("stop"),
              ])
            : streamOf([{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "call_ap", toolName: tool, input: JSON.stringify(input) }, finish("tool-calls")])
        ) as never;
      },
    }) as never;

  /** Two processes over one store, as a restart between the pause and the answer would be. */
  const twoProcesses = (agent: () => unknown) => {
    const store = memoryStore();
    return [createEngine({ support: agent() }, { store }, adapters), createEngine({ support: agent() }, { store }, adapters)] as const;
  };

  it("pauses a tool that requires approval as tool-approval, across a restart, and runs it once when approved", async () => {
    let refunds = 0;
    const agent = () =>
      new Agent({
        id: "support",
        name: "Support",
        instructions: "x",
        model: modelCalling("refund", { orderId: "o_9" }),
        tools: { refund: createTool({ id: "refund", description: "Refunds", inputSchema: z.object({ orderId: z.string() }), requireApproval: true, execute: async () => `refunded #${++refunds}` }) },
      });
    const [first, second] = twoProcesses(agent);
    const { run, done } = await first.start("support", { prompt: "refund o_9" });
    expect(await done).toMatchObject({
      status: "interrupted",
      interrupt: { name: "tool-approval", payload: { callId: "call_ap", tool: "refund", arguments: { orderId: "o_9" }, agent: "Support" } },
    });
    expect(refunds).toBe(0);
    const resumed = await second.resume(run.id, { approved: true });
    expect(await resumed.done).toMatchObject({ status: "completed", output: 'tool said "refunded #1"' });
    expect(refunds).toBe(1);
  });

  it("tells the model when a call is declined, without running the tool", async () => {
    let refunds = 0;
    const prompts: unknown[][] = [];
    const agent = () =>
      new Agent({
        id: "support",
        name: "Support",
        instructions: "x",
        model: modelCalling("refund", { orderId: "o_9" }, prompts),
        tools: { refund: createTool({ id: "refund", description: "Refunds", inputSchema: z.object({ orderId: z.string() }), requireApproval: true, execute: async () => `refunded #${++refunds}` }) },
      });
    const engine = createEngine({ support: agent() }, {}, adapters);
    const { run, done } = await engine.start("support", { prompt: "refund o_9" });
    await done;
    const resumed = await engine.resume(run.id, false);
    expect(await resumed.done).toMatchObject({ status: "completed", output: 'tool said "Tool call was not approved by the user"' });
    expect(refunds).toBe(0);
  });

  it("asks only when a conditional rule or the agent's requireToolApproval says so", async () => {
    let calls = 0;
    const conditional = (amount: number) =>
      new Agent({
        id: "pay",
        name: "Pay",
        instructions: "x",
        model: modelCalling("pay", { amount }),
        tools: {
          pay: createTool({
            id: "pay",
            description: "Pays",
            inputSchema: z.object({ amount: z.number() }),
            requireApproval: async (input: { amount: number }) => input.amount > 100,
            execute: async () => `paid #${++calls}`,
          }),
        },
      });
    expect((await (await createEngine({ pay: conditional(50) }, {}, adapters).start("pay", { prompt: "pay" })).done)?.status).toBe("completed");
    expect((await (await createEngine({ pay: conditional(500) }, {}, adapters).start("pay", { prompt: "pay" })).done)?.status).toBe("interrupted");

    const everyCall = new Agent({
      id: "all",
      name: "All",
      instructions: "x",
      model: modelCalling("lookup", { orderId: "o_1" }),
      tools: { lookup: createTool({ id: "lookup", description: "Looks up", inputSchema: z.object({ orderId: z.string() }), execute: async () => "found" }) },
      defaultOptions: { requireToolApproval: true },
    });
    const parked = await (await createEngine({ all: everyCall }, {}, adapters).start("all", { prompt: "look" })).done;
    expect(parked).toMatchObject({ status: "interrupted", interrupt: { name: "tool-approval", payload: { tool: "lookup" } } });
  });

  it("pauses on suspend() under the tool's name and resumes it with resumeData, as often as it asks", async () => {
    const asked: unknown[] = [];
    const agent = () =>
      new Agent({
        id: "booker",
        name: "Booker",
        instructions: "x",
        model: modelCalling("book", { city: "Addis" }),
        tools: {
          book: createTool({
            id: "book",
            description: "Books a trip, asking for the date and then a seat",
            inputSchema: z.object({ city: z.string() }),
            execute: async (_input, context) => {
              const answer = context.resumeData as { date?: string; seat?: string } | undefined;
              if (!answer?.date) return context.suspend?.({ ask: "date" });
              if (!answer.seat) return context.suspend?.({ ask: "seat", date: answer.date });
              asked.push(answer);
              return { booked: `${answer.date} ${answer.seat}` };
            },
          }),
        },
      });
    const [first, second] = twoProcesses(agent);
    const { run, done } = await first.start("support", { prompt: "book a trip" });
    expect(await done).toMatchObject({ status: "interrupted", interrupt: { name: "book", payload: { ask: "date" } } });
    const dated = await second.resume(run.id, { date: "2026-11-01" });
    expect(await dated.done).toMatchObject({ status: "interrupted", interrupt: { name: "book", payload: { ask: "seat", date: "2026-11-01" } } });
    const seated = await first.resume(run.id, { date: "2026-11-01", seat: "12A" });
    expect(await seated.done).toMatchObject({ status: "completed", output: 'tool said {"booked":"2026-11-01 12A"}' });
    expect(asked).toEqual([{ date: "2026-11-01", seat: "12A" }]);
  });
});
