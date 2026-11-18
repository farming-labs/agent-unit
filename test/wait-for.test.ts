import { afterEach, describe, expect, it, vi } from "vitest";
import { defineAgent } from "../packages/runtime/src/agents";
import { createAgentClient, parseEventStream } from "../packages/runtime/src/client";
import { createDurableAgentUnit } from "../packages/runtime/src/cloudflare";
import { EventTimeoutError } from "../packages/runtime/src/runtime/context";
import { eventMatches } from "../packages/runtime/src/runtime/engine";
import { createHandler } from "../packages/runtime/src/server";
import { createTestUnit } from "../packages/runtime/src/testing";
import type { HandlerOptions } from "../packages/runtime/src/server/handler";
import type { AgentEvent } from "../packages/runtime/src/types";
import { FakeNamespace } from "./fakes/durable-objects";
import { collect, createEngine, memoryStore, types } from "./helpers";

// `run.waitFor(event, { match, timeout })` parks a run until `send` (POST /events) delivers an event
// with that name whose data matches. Events are kept, so one sent before the run parks still counts.

const engines: { close(): void }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.close();
});

const HOUR = 3_600_000;

/** Waits for the payment of the order it was started with; reports a timeout. */
const checkout = (timeout?: number | string) =>
  defineAgent(async (input: { orderId: string }, run) => {
    await run.step("create checkout", () => ({ orderId: input.orderId }));
    try {
      const paid = await run.waitFor<{ orderId: string; amount: number }>("payment.succeeded", {
        match: { orderId: input.orderId },
        ...(timeout === undefined ? {} : { timeout }),
      });
      return `paid ${paid.amount}`;
    } catch (error) {
      if (!(error instanceof EventTimeoutError)) throw error;
      return `no payment by ${error.expiresAt}`;
    }
  });

function engineWith(agents: Record<string, unknown>, options: Parameters<typeof createEngine>[1] = {}) {
  const engine = createEngine(agents, options);
  engines.push(engine);
  return engine;
}

describe("run.waitFor", () => {
  it("parks the run until a matching event comes, and returns its data", async () => {
    const engine = engineWith({ checkout: checkout() });
    const { run, done } = await engine.start("checkout", { orderId: "o_1" });
    const parked = await done;
    expect(parked).toMatchObject({
      status: "waiting",
      wait: { key: "event:payment.succeeded#0", event: "payment.succeeded", match: { orderId: "o_1" } },
    });
    expect(parked!.wait!.expiresAt).toBeUndefined();
    expect(parked!.wakeAt).toBeUndefined();
    expect((await engine.listRuns({ status: "waiting" })).map((record) => record.id)).toEqual([run.id]);

    // Another order's payment, and another event, leave it waiting.
    expect((await engine.send("payment.succeeded", { orderId: "o_2", amount: 1 })).runs).toEqual([]);
    expect((await engine.send("payment.failed", { orderId: "o_1" })).runs).toEqual([]);
    expect((await engine.getRun(run.id)).status).toBe("waiting");

    const sent = await engine.send("payment.succeeded", { orderId: "o_1", amount: 1840 });
    expect(sent).toMatchObject({ id: expect.stringMatching(/^evt_/), runs: [run.id] });
    await sent.done;
    const finished = await engine.getRun(run.id);
    expect(finished).toMatchObject({ status: "completed", output: "paid 1840" });
    expect(finished.wait).toBeUndefined();
    expect(await engine.store.waitingFor("payment.succeeded")).toEqual([]);

    const events = await collect(engine.events(run.id));
    expect(types(events)).toEqual(["RUN_STARTED", "STEP_STARTED", "STEP_FINISHED", "RUN_WAITING", "RUN_FINISHED"]);
    expect(events.find((event) => event.type === "RUN_WAITING")).toMatchObject({ wait: { event: "payment.succeeded", match: { orderId: "o_1" } } });
  });

  it("takes an event sent after the run started but before it waited, without parking", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const engine = engineWith({
      checkout: defineAgent(async (input: { orderId: string }, run) => {
        await run.step("create checkout", () => gate);
        const paid = await run.waitFor<{ amount: number }>("payment.succeeded", { match: { orderId: input.orderId } });
        return `paid ${paid.amount}`;
      }),
    });
    const { run, done } = await engine.start("checkout", { orderId: "o_1" });
    // The webhook beats the run to its wait.
    expect((await engine.send("payment.succeeded", { orderId: "o_1", amount: 7 })).runs).toEqual([]);
    release();
    expect(await done).toMatchObject({ status: "completed", output: "paid 7" });
    expect(types(await collect(engine.events(run.id)))).not.toContain("RUN_WAITING");
  });

  it("takes an event sent between its first look and the save of the waiting run", async () => {
    const engine = engineWith({ checkout: checkout() });
    const look = engine.store.eventsSince.bind(engine.store);
    let sent: Promise<unknown> | undefined;
    vi.spyOn(engine.store, "eventsSince").mockImplementationOnce(async (name, since) => {
      const kept = await look(name, since);
      // Lands after waitFor read the kept events, while the run is still running: no one waits yet.
      sent = engine.send("payment.succeeded", { orderId: "o_1", amount: 9 });
      expect(await sent).toMatchObject({ runs: [] });
      return kept;
    });
    const { run, done } = await engine.start("checkout", { orderId: "o_1" });
    // The run parked, then found the kept event and continued: `done` covers that execution too.
    expect(await done).toMatchObject({ status: "completed", output: "paid 9" });
    expect(sent).toBeDefined();
    expect(types(await collect(engine.events(run.id)))).toEqual(["RUN_STARTED", "STEP_STARTED", "STEP_FINISHED", "RUN_WAITING", "RUN_FINISHED"]);
  });

  it("does not take an event sent before the run started", async () => {
    const engine = engineWith({ checkout: checkout() });
    await engine.send("payment.succeeded", { orderId: "o_1", amount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const { done } = await engine.start("checkout", { orderId: "o_1" });
    expect((await done)?.status).toBe("waiting");
  });

  it("takes a later event for each wait of the same name, and delivers an event id once", async () => {
    const engine = engineWith({
      tally: defineAgent(async (_input, run) => {
        const first = await run.waitFor<number>("tick");
        const second = await run.waitFor<number>("tick");
        return [first, second];
      }),
    });
    const { run, done } = await engine.start("tally");
    expect((await done)?.status).toBe("waiting");
    const one = await engine.send("tick", 1, { id: "evt_source_1" });
    expect(one.runs).toEqual([run.id]);
    await one.done;
    // A retried webhook: the same id is not delivered to the second wait.
    expect(await engine.send("tick", 1, { id: "evt_source_1" })).toMatchObject({ id: "evt_source_1", runs: [], duplicate: true });
    expect((await engine.getRun(run.id)).wait?.key).toBe("event:tick#1");
    const two = await engine.send("tick", 2);
    expect(two.runs).toEqual([run.id]);
    await two.done;
    expect(await engine.getRun(run.id)).toMatchObject({ status: "completed", output: [1, 2] });
  });

  it("hands one event to every run waiting for it that matches", async () => {
    const engine = engineWith({
      watch: defineAgent(async (input: { region?: string }, run) =>
        run.waitFor<{ region: string; version: number }>("deploy.finished", input.region ? { match: { region: input.region } } : {}),
      ),
    });
    const eu = await engine.start("watch", { region: "eu" });
    const us = await engine.start("watch", { region: "us" });
    const any = await engine.start("watch", {});
    await Promise.all([eu.done, us.done, any.done]);

    const sent = await engine.send("deploy.finished", { region: "eu", version: 3 });
    expect(sent.runs.sort()).toEqual([eu.run.id, any.run.id].sort());
    await sent.done;
    expect((await engine.getRun(eu.run.id)).output).toEqual({ region: "eu", version: 3 });
    expect((await engine.getRun(any.run.id)).output).toEqual({ region: "eu", version: 3 });
    expect((await engine.getRun(us.run.id)).status).toBe("waiting");
  });

  it("matches each key of `match` against the event's data by JSON value", () => {
    expect(eventMatches({ orderId: "o_1" }, { orderId: "o_1", amount: 3 })).toBe(true);
    expect(eventMatches({ customer: { id: 7, tier: "pro" } }, { customer: { tier: "pro", id: 7 } })).toBe(true);
    expect(eventMatches({ customer: { id: 7 } }, { customer: { id: 7, tier: "pro" } })).toBe(false);
    expect(eventMatches({ tags: ["a", "b"] }, { tags: ["b", "a"] })).toBe(false);
    expect(eventMatches({ orderId: "o_1" }, { orderid: "o_1" })).toBe(false);
    expect(eventMatches({ missing: null }, {})).toBe(false);
    expect(eventMatches({ orderId: "o_1" }, "o_1")).toBe(false);
    expect(eventMatches(undefined, "anything")).toBe(true);
  });

  it("ends the wait with EventTimeoutError once its timeout passes, and ignores a later event", async () => {
    const engine = engineWith({ checkout: checkout("1h") });
    const before = Date.now();
    const { run, done } = await engine.start("checkout", { orderId: "o_1" });
    const parked = await done;
    const expiresAt = Date.parse(parked!.wait!.expiresAt!);
    expect(expiresAt).toBeGreaterThanOrEqual(before + HOUR);
    expect(parked!.wakeAt).toBe(parked!.wait!.expiresAt);

    expect((await engine.sweep()).woken).toEqual([]);
    const { woken, settled } = await engine.sweep(expiresAt + 1);
    expect(woken).toEqual([run.id]);
    await settled;
    expect(await engine.getRun(run.id)).toMatchObject({ status: "completed", output: `no payment by ${parked!.wait!.expiresAt}` });
    expect((await engine.send("payment.succeeded", { orderId: "o_1", amount: 1 })).runs).toEqual([]);
  });

  it("fails the run with EventTimeoutError when the agent does not catch it", async () => {
    const engine = engineWith({ strict: defineAgent(async (_input, run) => run.waitFor("never", { timeout: 30 })) });
    const { run, done } = await engine.start("strict");
    expect((await done)?.status).toBe("waiting");
    // A short timeout ends in-process, with the sleep timer.
    await vi.waitFor(async () => expect((await engine.getRun(run.id)).status).toBe("failed"), { timeout: 2000 });
    expect((await engine.getRun(run.id)).error).toMatchObject({ name: "EventTimeoutError" });
  });

  it("cancels a waiting run at once, and a later event finds no one", async () => {
    const engine = engineWith({ checkout: checkout() });
    const { run, done } = await engine.start("checkout", { orderId: "o_1" });
    await done;
    expect(await engine.cancel(run.id)).toMatchObject({ status: "cancelled" });
    expect((await engine.getRun(run.id)).wait).toBeUndefined();
    expect(await engine.store.waitingFor("payment.succeeded")).toEqual([]);
    expect((await engine.send("payment.succeeded", { orderId: "o_1", amount: 1 })).runs).toEqual([]);
  });

  it("still delivers after the process restarts mid-wait", async () => {
    const store = memoryStore();
    const first = engineWith({ checkout: checkout() }, { store });
    const { run, done } = await first.start("checkout", { orderId: "o_1" });
    await done;
    first.close();
    const second = engineWith({ checkout: checkout() }, { store });
    const sent = await second.send("payment.succeeded", { orderId: "o_1", amount: 5 });
    expect(sent.runs).toEqual([run.id]);
    await sent.done;
    expect(await second.getRun(run.id)).toMatchObject({ status: "completed", output: "paid 5", attempt: 2 });
  });

  it("keeps events only for eventRetentionMs, and the sweep deletes older ones", async () => {
    const engine = engineWith({ checkout: checkout() }, { eventRetentionMs: 50 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = engineWith(
      {
        checkout: defineAgent(async (_input, run) => {
          await run.step("slow", () => gate);
          return run.waitFor("payment.succeeded");
        }),
      },
      { store: engine.store, eventRetentionMs: 50 },
    );
    const { done } = await slow.start("checkout", {});
    await slow.send("payment.succeeded", { amount: 1 }, { id: "evt_old" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    release();
    // Kept past its retention: not taken.
    expect((await done)?.status).toBe("waiting");
    await engine.sweep();
    expect(await engine.store.eventsSince("payment.succeeded", 0)).toEqual([]);
    // Its id is free again once it expired.
    expect((await engine.send("payment.succeeded", { amount: 2 }, { id: "evt_old" })).duplicate).toBeUndefined();
  });

  it("refuses event names and ids that are empty, too long or hold control characters", async () => {
    const engine = engineWith({ checkout: checkout() });
    await expect(engine.send("", {})).rejects.toMatchObject({ status: 400, code: "invalid_event" });
    await expect(engine.send("a".repeat(201), {})).rejects.toMatchObject({ status: 400, code: "invalid_event" });
    await expect(engine.send("tick\n", {})).rejects.toMatchObject({ status: 400, code: "invalid_event" });
    await expect(engine.send("tick", {}, { id: "" })).rejects.toMatchObject({ status: 400, code: "invalid_event" });

    const bad = engineWith({ bad: defineAgent(async (_input, run) => run.waitFor("tick", { match: ["orderId"] as never })) });
    const { done } = await bad.start("bad");
    expect((await done)?.error?.message).toMatch(/`match` of run.waitFor\("tick"\) must be a plain object/);
  });
});

describe("createTestUnit", () => {
  it("sends an event and returns the runs that took it once they settle", async () => {
    const unit = createTestUnit({ checkout: checkout() });
    const parked = await unit.run("checkout", { orderId: "o_1" });
    expect(parked.status).toBe("waiting");
    const [paid] = await unit.send("payment.succeeded", { orderId: "o_1", amount: 30 });
    expect(paid).toMatchObject({ id: parked.id, status: "completed", output: "paid 30" });
    expect(await unit.send("payment.succeeded", { orderId: "o_1", amount: 30 })).toEqual([]);
  });
});

describe("POST /events", () => {
  function app(authorize?: HandlerOptions["authorize"]) {
    const engine = engineWith({ checkout: checkout() });
    const pending: Promise<unknown>[] = [];
    const handler = createHandler(engine, { basePath: "/api/agent", authorize });
    const call = (path: string, init?: RequestInit) =>
      handler(new Request(`https://app.example${path}`, init), { waitUntil: (promise) => void pending.push(promise) });
    const settle = async () => {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    };
    return { engine, call, settle };
  }
  const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("delivers the event to the waiting runs and answers 202 with them", async () => {
    const { engine, call, settle } = app();
    const { run, done } = await engine.start("checkout", { orderId: "o_1" });
    await done;
    const waiting = await (await call("/api/agent/runs?status=waiting")).json();
    expect(waiting.runs.map((record: { id: string }) => record.id)).toEqual([run.id]);

    const response = await call("/api/agent/events", post({ name: "payment.succeeded", data: { orderId: "o_1", amount: 12 }, id: "evt_1" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: "evt_1", runs: [run.id] });
    await settle();
    expect(await engine.getRun(run.id)).toMatchObject({ status: "completed", output: "paid 12" });

    const again = await call("/api/agent/events", post({ name: "payment.succeeded", data: { orderId: "o_1", amount: 12 }, id: "evt_1" }));
    expect(await again.json()).toEqual({ id: "evt_1", runs: [], duplicate: true });
  });

  it("asks authorize with action send and the event's name, and refuses bad bodies", async () => {
    const seen: unknown[] = [];
    const { call } = app((request, context) => {
      seen.push(context);
      return request.headers.get("authorization") === "Bearer ok";
    });
    const denied = await call("/api/agent/events", post({ name: "payment.succeeded" }));
    expect(denied.status).toBe(401);
    expect(seen).toEqual([{ action: "send", event: "payment.succeeded" }]);

    const allowed = { "content-type": "application/json", authorization: "Bearer ok" };
    const missing = await call("/api/agent/events", { method: "POST", headers: allowed, body: "{}" });
    expect(missing.status).toBe(400);
    const badId = await call("/api/agent/events", { method: "POST", headers: allowed, body: JSON.stringify({ name: "tick", id: 3 }) });
    expect((await badId.json()).error.code).toBe("invalid_event");
    expect((await call("/api/agent/events", { method: "GET", headers: allowed })).status).toBe(404);
  });

  it("is what the client's send calls", async () => {
    const { engine, call, settle } = app();
    const { run, done } = await engine.start("checkout", { orderId: "o_9" });
    await done;
    const client = createAgentClient({ baseUrl: "https://app.example/api/agent", fetch: ((input: RequestInfo | URL, init?: RequestInit) => call(new URL(String(input)).pathname, init)) as typeof fetch });
    expect(await client.send("payment.succeeded", { orderId: "o_9", amount: 3 })).toMatchObject({ runs: [run.id] });
    await settle();
    expect((await engine.getRun(run.id)).output).toBe("paid 3");
  });
});

describe("run.waitFor on the Durable Objects runtime", () => {
  function setup() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const unit = createDurableAgentUnit({
      agents: {
        checkout: checkout(),
        slow: defineAgent(async (input: { orderId: string }, run) => {
          await run.step("create checkout", () => gate);
          const paid = await run.waitFor<{ amount: number }>("payment.succeeded", { match: { orderId: input.orderId } });
          return `paid ${paid.amount}`;
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
      unit.fetch(new Request(`https://agents.example.com${path}`, init), env, { waitUntil: (promise) => void pending.push(promise) });
    const settle = async () => {
      while (pending.length) await Promise.allSettled(pending.splice(0));
      await runs.settle();
    };
    return { call, settle, index, release };
  }
  const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("finds the waiting run in the index object and hands the event to the run's own object", async () => {
    const { call, settle, index } = setup();
    const run = await (await call("/agents/checkout/runs", post({ input: { orderId: "o_1" } }))).json();
    await settle();
    expect(await (await call(`/runs/${run.id}`)).json()).toMatchObject({ status: "waiting", wait: { event: "payment.succeeded" } });
    const keys = [...index.storages.get("index")!.data.keys()];
    expect(keys.some((key) => key.startsWith("index:wait:") && key.endsWith(run.id))).toBe(true);

    const sent = await (await call("/events", post({ name: "payment.succeeded", data: { orderId: "o_1", amount: 21 } }))).json();
    expect(sent.runs).toEqual([run.id]);
    await settle();
    expect(await (await call(`/runs/${run.id}`)).json()).toMatchObject({ status: "completed", output: "paid 21" });
    // The kept event lives in the index object too, for runs that wait for it later.
    expect([...index.storages.get("index")!.data.keys()].some((key) => key.startsWith("inbox:by-name:"))).toBe(true);
  });

  it("takes an event the Worker kept before the run waited", async () => {
    const { call, settle, release } = setup();
    const run = await (await call("/agents/slow/runs", post({ input: { orderId: "o_2" } }))).json();
    const sent = await (await call("/events", post({ name: "payment.succeeded", data: { orderId: "o_2", amount: 4 } }))).json();
    expect(sent.runs).toEqual([]);
    release();
    await settle();
    const finished = await (await call(`/runs/${run.id}`)).json();
    expect(finished).toMatchObject({ status: "completed", output: "paid 4" });
    const events: AgentEvent[] = [];
    for await (const message of parseEventStream((await call(`/runs/${run.id}/events`)).body!)) events.push(JSON.parse(message.data));
    expect(types(events)).not.toContain("RUN_WAITING");
  });
});
