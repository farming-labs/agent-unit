import { describe, expect, it } from "vitest";
import { defineAgent } from "../src/agents";
import { parseEventStream } from "../src/client";
import { createDurableAgentUnit } from "../src/cloudflare";
import type { AgentEvent } from "../src/types";
import { FakeNamespace } from "./fakes/durable-objects";

const ORIGIN = "https://agents.example.com";

function setup(budget?: string | false) {
  const effects = { loads: 0, charges: 0, parts: 0 };
  const unit = createDurableAgentUnit({
    name: "shop",
    budget,
    agents: {
      refund: defineAgent(async (input, run) => {
        const order = await run.step("load", () => ({ id: String(input.orderId), amount: 42, n: ++effects.loads }));
        const decision = await run.interrupt<{ approved: boolean }>("approve", order);
        if (!decision.approved) return "declined";
        await run.step("charge", () => ++effects.charges);
        await run.state.set("last-refund", order.id, { scope: "app" });
        return `refunded ${order.id}`;
      }),
      nap: defineAgent(async (input, run) => {
        await run.sleep(Number(input.ms ?? 10));
        return "rested";
      }),
      long: defineAgent(async (_input, run) => {
        for (let i = 0; i < 3; i++) {
          await run.step(`part-${i}`, () => new Promise((resolve) => setTimeout(() => resolve(++effects.parts), 15)));
        }
        return effects.parts;
      }),
    },
  });
  const runs = new FakeNamespace(unit.AgentUnitRun as never);
  const index = new FakeNamespace(unit.AgentUnitIndex as never);
  const env = { AGENT_UNIT_RUNS: runs, AGENT_UNIT_INDEX: index };
  runs.env = env;
  index.env = env;
  const pending: Promise<unknown>[] = [];
  const call = (path: string, init?: RequestInit) =>
    unit.fetch(new Request(`${ORIGIN}${path}`, init), env, { waitUntil: (promise) => void pending.push(promise) });
  const settle = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
    await runs.settle();
  };
  return { unit, runs, index, call, settle, effects };
}

const post = (body: unknown, accept?: string) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(accept ? { accept } : {}) },
  body: JSON.stringify(body),
});

async function sse(response: Response) {
  const events: AgentEvent[] = [];
  for await (const message of parseEventStream(response.body!)) events.push(JSON.parse(message.data));
  return events;
}

describe("Durable Objects runtime", () => {
  it("runs each run in its own object, lists from the index, and survives a redeploy mid-pause", async () => {
    const { call, settle, runs, index, effects } = setup();
    const started = await call("/agents/refund/runs", post({ input: { orderId: "o_1" } }));
    expect(started.status).toBe(202);
    const run = await started.json();
    await settle();

    // The run lives in the object named by its id; the index only knows the record.
    expect([...runs.storages.keys()]).toEqual([run.id]);
    expect([...runs.storages.get(run.id)!.data.keys()].some((key) => key.startsWith("steps:"))).toBe(true);
    expect([...index.storages.get("index")!.data.keys()]).toContain(`runs:${run.id}`);

    const listed = await (await call("/runs?status=interrupted")).json();
    expect(listed.runs.map((r: { id: string }) => r.id)).toEqual([run.id]);

    // Redeploy: every object instance is gone, storage stays.
    runs.restart();
    index.restart();
    const resumed = await sse(await call(`/runs/${run.id}/resume`, post({ answer: { approved: true } }, "text/event-stream")));
    expect(resumed.map((event) => event.type)).toEqual(["STEP_STARTED", "STEP_FINISHED", "RUN_FINISHED"]);
    expect(resumed.at(-1)).toMatchObject({ seq: 7, result: "refunded o_1" });
    expect(effects).toMatchObject({ loads: 1, charges: 1 });
    expect(await (await call(`/runs/${run.id}`)).json()).toMatchObject({ status: "completed", attempt: 2 });

    // App-scoped state is shared through the index.
    const encoded = Buffer.from("last-refund").toString("base64url");
    expect([...index.storages.get("index")!.data.keys()].some((key) => key.startsWith("state:app:") && key.endsWith(encoded))).toBe(true);
  });

  it("streams a run through the Worker with seq ids, and answers 404 and 409 like the local runtime", async () => {
    const { call } = setup();
    const events = await sse(await call("/agents/refund/runs", post({ input: { orderId: "o_2" } }, "text/event-stream")));
    expect(events.map((event) => event.type)).toEqual(["RUN_STARTED", "STEP_STARTED", "STEP_FINISHED", "RUN_INTERRUPTED"]);
    const id = events[0]!.runId;
    expect((await call(`/runs/${id}/events`, { headers: { "last-event-id": "2" } })).ok).toBe(true);
    expect((await call("/runs/run_doesnotexist000000")).status).toBe(404);
    expect((await call("/runs/not-a-run-id")).status).toBe(404);
    expect((await call("/agents/ghost/runs", post({}))).status).toBe(404);
    await sse(await call(`/runs/${id}/resume`, post({ answer: { approved: false } }, "text/event-stream")));
    expect((await call(`/runs/${id}/resume`, post({ answer: {} }))).status).toBe(409);
  });

  it("sleeps on the object's alarm and wakes when it fires", async () => {
    const { call, settle, runs } = setup();
    const run = await (await call("/agents/nap/runs", post({ input: { ms: 20 } }))).json();
    await settle();
    expect(await (await call(`/runs/${run.id}`)).json()).toMatchObject({ status: "sleeping" });
    const alarm = runs.storages.get(run.id)!.alarm!;
    expect(alarm).toBeGreaterThan(Date.now() - 1000);

    // Firing early re-arms instead of waking.
    await runs.fireAlarm(run.id);
    if ((await (await call(`/runs/${run.id}`)).json()).status === "sleeping") {
      expect(runs.storages.get(run.id)!.alarm).toBe(alarm);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, alarm - Date.now() + 5)));
      await runs.fireAlarm(run.id);
    }
    expect(await (await call(`/runs/${run.id}`)).json()).toMatchObject({ status: "completed", output: "rested" });
  });

  it("continues a yielded run from its alarm", async () => {
    const yielding = setup("10ms");
    const run = await (await yielding.call("/agents/long/runs", post({}))).json();
    await yielding.settle();
    for (let i = 0; i < 10; i++) {
      const record = await (await yielding.call(`/runs/${run.id}`)).json();
      if (record.status === "completed") break;
      expect(yielding.runs.storages.get(run.id)!.alarm).toBeLessThanOrEqual(Date.now());
      await yielding.runs.fireAlarm(run.id);
    }
    expect(await (await yielding.call(`/runs/${run.id}`)).json()).toMatchObject({ status: "completed", output: 3 });
  });

  it("recovers a run whose isolate died mid-execution once its lease lapses", async () => {
    const { call, runs, effects } = setup();
    // An isolate died while executing: the record says running, a lease from the dead isolate
    // remains, nothing was journaled. That is exactly what its watchdog alarm finds.
    const id = "run_orphaned0000000000";
    const object = runs.instance(id) as unknown as { engine: import("../src/runtime/engine").RunEngine };
    const now = new Date().toISOString();
    await runs.storages.get(id)!.put("agent-unit:run-id", id);
    await object.engine.store.putRun({ id, agent: "long", threadId: id, status: "running", input: {}, attempt: 1, eventCount: 1, createdAt: now, updatedAt: now });
    await object.engine.store.acquireLease(id, "dead-isolate", 60_000);
    runs.restart();

    // Before the lease lapses the alarm only re-arms.
    await runs.fireAlarm(id);
    expect(await (await call(`/runs/${id}`)).json()).toMatchObject({ status: "running" });
    expect(runs.storages.get(id)!.alarm).toBeGreaterThan(Date.now());

    // After it lapses, the alarm continues the run from its journal.
    const lease = [...runs.storages.get(id)!.data.keys()].find((key) => key.startsWith("lease"))!;
    await runs.storages.get(id)!.put(lease, JSON.stringify({ owner: "dead-isolate", until: Date.now() - 1 }));
    await runs.fireAlarm(id);
    expect(await (await call(`/runs/${id}`)).json()).toMatchObject({ status: "completed", output: 3, attempt: 2 });
    expect(effects.parts).toBe(3);
  });

  it("serves MCP tool calls by starting runs in their own objects", async () => {
    const { call, runs } = setup();
    const response = await call(
      "/mcp",
      post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "refund", arguments: { message: "refund o_4" } } }),
    );
    const body = await response.json();
    expect(body.result.structuredContent).toMatchObject({ status: "interrupted", interrupt: { name: "approve" } });
    expect(runs.storages.has(body.result.structuredContent.runId)).toBe(true);
  });

  it("emits the wrangler config for its bindings", () => {
    const { unit } = setup();
    expect(unit.wrangler.durable_objects.bindings.map((binding) => binding.class_name)).toEqual(["AgentUnitRun", "AgentUnitIndex"]);
  });
});

describe("Durable Objects runtime: deletion", () => {
  it("deletes a finished run's object data and its index entry", async () => {
    const unit = createDurableAgentUnit({ agents: { hi: defineAgent(() => "hi") } });
    const runs = new FakeNamespace(unit.AgentUnitRun as never);
    const index = new FakeNamespace(unit.AgentUnitIndex as never);
    const env = { AGENT_UNIT_RUNS: runs, AGENT_UNIT_INDEX: index };
    runs.env = env;
    index.env = env;
    const call = (path: string, init?: RequestInit) => unit.fetch(new Request(`${ORIGIN}${path}`, init), env);
    const run = await (await call("/agents/hi/runs", post({}))).json();
    expect(run.status).toBe("completed");
    expect((await call(`/runs/${run.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await call(`/runs/${run.id}`)).status).toBe(404);
    expect([...runs.storages.get(run.id)!.data.keys()]).toEqual([]);
    expect((await (await call("/runs")).json()).runs).toEqual([]);
  });
});

describe("Durable Objects runtime: versioned writes", () => {
  it("changes run records in the index through an atomic compare-and-set", async () => {
    const { call, settle, runs, index } = setup();
    const run = await (await call("/agents/refund/runs", post({ input: { orderId: "o_5" } }))).json();
    await settle();
    const store = (runs.instance(run.id) as unknown as { engine: import("../src/runtime/engine").RunEngine }).engine.store;
    expect(store.atomicWrites).toBe(true);
    const read = (await store.getRun(run.id))!;
    expect(read).toMatchObject({ status: "interrupted", version: expect.any(Number) });

    // A write based on the current version lands; a second one based on the same read is refused.
    expect(await store.putRun({ ...read, status: "cancelled" }, read)).toBe(true);
    expect(await store.putRun({ ...read, status: "completed" }, read)).toBe(false);
    expect(await store.putRun({ ...read }, null)).toBe(false);
    expect(await (await call(`/runs/${run.id}`)).json()).toMatchObject({ status: "cancelled", version: read.version! + 1 });

    const kv = index.instance("index") as unknown as { kvCompareAndSet(key: string, version: number | null, value: string): Promise<boolean> };
    expect(await kv.kvCompareAndSet("runs:run_new000000000000", null, JSON.stringify({ version: 1 }))).toBe(true);
    expect(await kv.kvCompareAndSet("runs:run_new000000000000", null, JSON.stringify({ version: 1 }))).toBe(false);
    expect(await kv.kvCompareAndSet("runs:run_new000000000000", 1, JSON.stringify({ version: 2 }))).toBe(true);
  });
});
