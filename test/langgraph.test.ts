import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { END, interrupt, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { functionAdapter } from "../src/agents";
import { langGraphAdapter } from "../src/adapters/langgraph";
import { collect, createEngine, memoryStore, types } from "./helpers";

const adapters = [langGraphAdapter, functionAdapter];

function approvalGraph(calls: { plan: number; act: number }, checkpointer?: MemorySaver) {
  return new StateGraph(MessagesAnnotation)
    .addNode("plan", () => {
      calls.plan++;
      return { messages: [new AIMessage("I will refund order o_1.")] };
    })
    .addNode("review", () => {
      const decision = interrupt<{ question: string }, { approved: boolean }>({ question: "Refund o_1?" });
      return { messages: [new AIMessage(decision.approved ? "approved" : "declined")] };
    })
    .addNode("act", () => {
      calls.act++;
      return { messages: [new AIMessage("refunded")] };
    })
    .addEdge(START, "plan")
    .addEdge("plan", "review")
    .addEdge("review", "act")
    .addEdge("act", END)
    .compile(checkpointer ? { checkpointer } : undefined);
}

describe("LangGraph adapter", () => {
  it("recognises compiled graphs only", () => {
    const graph = approvalGraph({ plan: 0, act: 0 });
    expect(langGraphAdapter.match(graph)).toBe(true);
    expect(langGraphAdapter.match({ stream() {} })).toBe(false);
    expect(langGraphAdapter.match(null)).toBe(false);
  });

  it("maps interrupt() to a durable interrupt that survives a restart, without re-running nodes", async () => {
    const calls = { plan: 0, act: 0 };
    const graph = approvalGraph(calls);
    const store = memoryStore();

    const first = createEngine({ refunds: graph }, { store }, adapters);
    expect(first.manifest().agents[0]).toMatchObject({ name: "refunds", framework: "langgraph" });
    const { run, done } = await first.start("refunds", { prompt: "refund o_1" });
    const parked = await done;
    expect(parked).toMatchObject({ status: "interrupted", interrupt: { name: "review", payload: { question: "Refund o_1?" } } });
    expect(calls).toEqual({ plan: 1, act: 0 });

    // A new engine on the same storage: LangGraph's checkpoints come back from agent-unit storage.
    const second = createEngine({ refunds: approvalGraph(calls) }, { store }, adapters);
    const resumed = await second.resume(run.id, { approved: true });
    const finished = await resumed.done;
    expect(calls).toEqual({ plan: 1, act: 1 });
    expect(finished?.status).toBe("completed");
    const messages = (finished?.output as { messages: { type: string; content: string }[] }).messages;
    expect(messages.map((message) => [message.type, message.content])).toEqual([
      ["human", "refund o_1"],
      ["ai", "I will refund order o_1."],
      ["ai", "approved"],
      ["ai", "refunded"],
    ]);
  });

  it("keeps a thread's conversation across runs", async () => {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("count", (state) => ({ messages: [new AIMessage(`seen ${state.messages.length}`)] }))
      .addEdge(START, "count")
      .addEdge("count", END)
      .compile();
    const engine = createEngine({ counter: graph }, {}, adapters);
    const a = await (await engine.start("counter", { prompt: "one" }, { threadId: "t1" })).done;
    const b = await (await engine.start("counter", { prompt: "two" }, { threadId: "t1" })).done;
    const last = (output: unknown) => (output as { messages: { content: string }[] }).messages.at(-1)?.content;
    expect(last(a?.output)).toBe("seen 1");
    expect(last(b?.output)).toBe("seen 3");
  });

  it("uses an app-owned checkpointer when the graph has one", async () => {
    const saver = new MemorySaver();
    const calls = { plan: 0, act: 0 };
    const engine = createEngine({ refunds: approvalGraph(calls, saver) }, {}, adapters);
    const { run, done } = await engine.start("refunds", { prompt: "refund" });
    await done;
    expect(saver.storage[run.threadId]).toBeDefined();
    const finished = await (await engine.resume(run.id, { approved: false })).done;
    expect((finished?.output as { messages: { content: string }[] }).messages.at(-1)?.content).toBe("refunded");
  });

  it("streams model text and tool calls as AG-UI events", async () => {
    const lookup = tool(async ({ orderId }: { orderId: string }) => `order ${orderId} is paid`, {
      name: "lookup_order",
      description: "Looks up an order.",
      schema: z.object({ orderId: z.string() }),
    });
    const model = new FakeListChatModel({ responses: ["The order is paid."] });
    let step = 0;
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("agent", async (state) => {
        if (step++ === 0) {
          return { messages: [new AIMessage({ content: "", tool_calls: [{ id: "call_1", name: "lookup_order", args: { orderId: "o_9" } }] })] };
        }
        return { messages: [await model.invoke(state.messages)] };
      })
      .addNode("tools", new ToolNode([lookup]))
      .addEdge(START, "agent")
      .addConditionalEdges("agent", (state) => ((state.messages.at(-1) as AIMessage).tool_calls?.length ? "tools" : END))
      .addEdge("tools", "agent")
      .compile();

    const engine = createEngine({ support: graph }, {}, adapters);
    expect(engine.manifest().agents[0]?.tools).toEqual([{ name: "lookup_order", description: "Looks up an order." }]);
    const { run, done } = await engine.start("support", { prompt: "is o_9 paid?" });
    const final = await done;
    expect(final?.status).toBe("completed");
    const events = await collect(engine.events(run.id));
    expect(types(events)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      ...Array(events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").length).fill("TEXT_MESSAGE_CONTENT"),
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(events.find((event) => event.type === "TOOL_CALL_RESULT")).toMatchObject({ toolCallId: "call_1", content: "order o_9 is paid" });
    const text = events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => (event as { delta: string }).delta);
    expect(text.join("")).toBe("The order is paid.");
  });

  it("continues a turn that crashed mid-graph instead of sending the input again", async () => {
    const calls = { plan: 0, act: 0 };
    let crash = true;
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("plan", () => {
        calls.plan++;
        return { messages: [new AIMessage("planned")] };
      })
      .addNode("act", () => {
        if (crash) {
          crash = false;
          throw new Error("process died");
        }
        calls.act++;
        return { messages: [new AIMessage("done")] };
      })
      .addEdge(START, "plan")
      .addEdge("plan", "act")
      .addEdge("act", END)
      .compile();
    const store = memoryStore();
    const engine = createEngine({ flaky: graph }, { store }, adapters);
    const { run, done } = await engine.start("flaky", { prompt: "go" });
    expect((await done)?.status).toBe("failed");

    // A real crash dies before the turn is journaled: drop the journaled outcome, mark the run
    // running again and let recovery continue it, as the sweep does after a lease expires.
    const record = (await store.getRun(run.id))!;
    await store.putRun({ ...record, status: "running", error: undefined });
    expect(Object.keys(await store.getJournal(run.id))).toEqual(["step:langgraph#0"]);
    await store.putJournal(run.id, {});
    const recovered = await engine.continue(run.id);
    expect(recovered?.status).toBe("completed");
    expect(calls).toEqual({ plan: 1, act: 1 });
    const messages = (recovered?.output as { messages: { content: string }[] }).messages.map((message) => message.content);
    expect(messages).toEqual(["go", "planned", "done"]);
  });
});
