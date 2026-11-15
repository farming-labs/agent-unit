import { afterEach, describe, expect, it, vi } from "vitest";
import { defineAgent } from "../packages/runtime/src/agents";
import { createDurableAgentUnit } from "../packages/runtime/src/cloudflare";
import { createHandler } from "../packages/runtime/src/server";
import { farmApprovals, farmClock, farmjsSignature, verifyFarmjsSignature } from "../packages/runtime/src/server/farmjs";
import type { PendingInterrupt, RunRecord } from "../packages/runtime/src/types";
import { FakeNamespace } from "./fakes/durable-objects";
import { createEngine } from "./helpers";

// Farm.js Infra as the place people answer interrupts: the engine registers each pause, and Infra
// answers it through a signed internal route.

const KEY = "farmjs_test_vector_key";
const SITE = "https://app.example.com";
const realFetch = globalThis.fetch;
const engines: { close(): void }[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.close();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const env = {
  FARMJS_API_KEY: KEY,
  FARMJS_API_URL: "https://infra.example.com",
  FARMJS_ENVIRONMENT: "staging",
  FARMJS_PROJECT_ID: "proj_123",
  AGENT_UNIT_URL: SITE,
};

type Approval = { run: string; key: string; agent?: string; interrupt: string; payload?: unknown; status: "open" | "closed" };

/** Records what is sent to Infra: approvals, and the wake-ups beside them. */
function infra(answer: () => Response | Promise<Response> = () => Response.json({ accepted: 1 }, { status: 202 })) {
  const approvals: { headers: Headers; body: { endpoint: string; approvals: Approval[] } }[] = [];
  const wakes: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.json();
    if (request.url === "https://infra.example.com/api/agents/approvals") approvals.push({ headers: request.headers, body });
    else if (request.url === "https://infra.example.com/api/agents/wakes") wakes.push(body);
    else throw new Error(`unexpected call to ${request.url}`);
    return answer();
  }) as typeof fetch;
  const entries = () => approvals.flatMap((call) => call.body.approvals);
  return { approvals, wakes, entries };
}

const refund = () =>
  defineAgent(async (input, run) => {
    const decision = await run.interrupt<{ approved: boolean; by?: string; note?: string }>("approve-refund", { amount: input.amount ?? 18400 });
    if (!decision.approved) return "declined";
    // The same interrupt name can pause the run again: its own key tells the two apart.
    if (input.twice) {
      const again = await run.interrupt<{ approved: boolean }>("approve-refund", { amount: 1 });
      if (!again.approved) return "declined twice";
    }
    return `refunded by ${decision.by ?? "someone"}`;
  });

function app(overrides: Record<string, string | undefined> = {}, agents: Record<string, unknown> = { refund: refund() }) {
  const engine = createEngine(agents, { env: { ...env, ...overrides } });
  engines.push(engine);
  const handler = createHandler(engine, { basePath: "/api/agent" });
  const pending: Promise<unknown>[] = [];
  const call = (path: string, init: RequestInit = { method: "POST" }) =>
    handler(new Request(`${SITE}/api/agent${path}`, init), { waitUntil: (promise) => pending.push(promise) });
  const answer = async (id: string, body: unknown, key = KEY) => {
    const path = `/__agent-unit/answer/${encodeURIComponent(id)}`;
    return call(path, {
      method: "POST",
      headers: { "content-type": "application/json", "farmjs-signature": await farmjsSignature(key, "POST", `/api/agent${path}`) },
      body: JSON.stringify(body),
    });
  };
  const settle = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  return { engine, handler, call, answer, settle };
}

const approve = (key: string, note?: string) => ({ key, interrupt: "approve-refund", answer: { approved: true, by: "kinfe@example.com", ...(note ? { note } : {}) } });

describe("answer route signature", () => {
  it("matches the pinned test vector", async () => {
    const at = 1793544000 * 1000;
    const path = "/api/agent/__agent-unit/answer/run_test";
    const header = await farmjsSignature(KEY, "POST", path, at);
    expect(header).toBe("t=1793544000,v1=7979280f67345da0fef8183010f99ac22c6a4cb9e3b48e54b2ff8aa797c08840");
    expect(await verifyFarmjsSignature(KEY, header, "POST", path, at)).toBe(true);
  });

  it("accepts the test vector, as Infra sends it, and answers 404 for a run it does not know", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1793544000 * 1000 + 30_000);
    const { call } = app();
    const response = await call("/__agent-unit/answer/run_test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "farmjs-signature": "t=1793544000,v1=7979280f67345da0fef8183010f99ac22c6a4cb9e3b48e54b2ff8aa797c08840",
      },
      body: JSON.stringify(approve("interrupt:approve-refund#0")),
    });
    expect(response.status).toBe(404);
  });

  it("takes only Infra's signature, never the bearer secret", async () => {
    infra();
    const { engine, call, answer } = app({ AGENT_UNIT_SECRET: "s3cret" });
    const { run, done } = await engine.start("refund");
    await done;
    const key = (await engine.getRun(run.id)).interrupt!.key;
    const body = JSON.stringify(approve(key));
    const path = `/__agent-unit/answer/${run.id}`;
    const bearer = await call(path, { method: "POST", headers: { authorization: "Bearer s3cret", "content-type": "application/json" }, body });
    expect(bearer.status).toBe(401);
    expect((await answer(run.id, approve(key), "farmjs_other_key")).status).toBe(401);
    // A signature for another run's answer does not answer this one.
    const other = await farmjsSignature(KEY, "POST", "/api/agent/__agent-unit/answer/run_aaaaaaaaaaaa");
    expect((await call(path, { method: "POST", headers: { "farmjs-signature": other }, body })).status).toBe(401);
    expect((await engine.getRun(run.id)).status).toBe("interrupted");
    // Without FARMJS_API_KEY nothing can answer here.
    const keyless = app({ FARMJS_API_KEY: undefined, AGENT_UNIT_SECRET: "s3cret" });
    const unsigned = await keyless.call(path, { method: "POST", headers: { authorization: "Bearer s3cret" }, body });
    expect(unsigned.status).toBe(401);
  });
});

describe("Farm.js approvals", () => {
  it("registers the pause, resumes the run with Infra's answer, and sends no close for it", async () => {
    const sent = infra();
    const { engine, call, answer, settle } = app();
    const started = await call("/agents/refund/runs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const run = (await started.json()) as RunRecord;
    await settle();
    const waiting = await engine.getRun(run.id);
    expect(waiting.status).toBe("interrupted");
    const key = waiting.interrupt!.key;

    expect(sent.approvals).toHaveLength(1);
    expect(Object.fromEntries(sent.approvals[0]!.headers)).toMatchObject({
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      "x-farm-environment": "staging",
      "x-farm-project": "proj_123",
    });
    expect(sent.approvals[0]!.body).toEqual({
      endpoint: `${SITE}/api/agent`,
      approvals: [{ run: run.id, key, agent: "refund", interrupt: "approve-refund", payload: { amount: 18400 }, status: "open" }],
    });

    const response = await answer(run.id, approve(key, "ok"));
    expect(response.status).toBe(200);
    // With waitUntil the run continues after the answer: it is running when Infra hears back.
    expect(await response.json()).toEqual({ status: "running" });
    await settle();
    expect(await engine.getRun(run.id)).toMatchObject({ status: "completed", output: "refunded by kinfe@example.com" });
    // Infra already knows it answered: no close for that pause.
    expect(sent.entries().map((entry) => entry.status)).toEqual(["open"]);

    // Answered: the same answer again is not waiting any more.
    const again = await answer(run.id, approve(key));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "not_waiting" });
  });

  it("answers with the run's status after the resume when the host has no waitUntil", async () => {
    infra();
    const { engine, handler } = app();
    const { run, done } = await engine.start("refund");
    await done;
    const key = (await engine.getRun(run.id)).interrupt!.key;
    const path = `/api/agent/__agent-unit/answer/${run.id}`;
    const response = await handler(
      new Request(`${SITE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "farmjs-signature": await farmjsSignature(KEY, "POST", path) },
        body: JSON.stringify({ key, interrupt: "approve-refund", answer: { approved: false, by: "kinfe@example.com" } }),
      }),
    );
    expect(await response.json()).toEqual({ status: "completed" });
    expect((await engine.getRun(run.id)).output).toBe("declined");
  });

  it("tells a second pause on the same interrupt name apart by its key", async () => {
    const sent = infra();
    const { engine, answer, settle } = app();
    const { run, done } = await engine.start("refund", { twice: true });
    await done;
    const first = (await engine.getRun(run.id)).interrupt!.key;
    expect((await answer(run.id, approve(first))).status).toBe(200);
    await settle();
    await vi.waitFor(async () => expect((await engine.getRun(run.id)).interrupt?.key).toBeDefined());
    const second = (await engine.getRun(run.id)).interrupt!.key;
    expect(second).not.toBe(first);

    // A late retry of the first answer must not answer the second pause.
    const stale = await answer(run.id, approve(first));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "not_waiting" });
    expect((await engine.getRun(run.id)).status).toBe("interrupted");
    expect(sent.entries().map((entry) => [entry.key, entry.status])).toEqual([
      [first, "open"],
      [second, "open"],
    ]);

    expect((await answer(run.id, approve(second))).status).toBe(200);
    await settle();
    expect((await engine.getRun(run.id)).status).toBe("completed");
  });

  it("answers 409 for a run that is not waiting, a wrong key or name, and 400 for a malformed answer", async () => {
    infra();
    const { engine, answer } = app({}, { refund: refund(), quick: defineAgent(async () => "done") });
    const quick = await engine.start("quick");
    await quick.done;
    expect((await answer(quick.run.id, approve("interrupt:approve-refund#0"))).status).toBe(409);

    const { run, done } = await engine.start("refund");
    await done;
    const key = (await engine.getRun(run.id)).interrupt!.key;
    expect((await answer(run.id, approve("interrupt:approve-refund#7"))).status).toBe(409);
    expect((await answer(run.id, { ...approve(key), interrupt: "approve-other" })).status).toBe(409);
    for (const body of [
      {},
      { interrupt: "approve-refund", answer: { approved: true, by: "x" } },
      { key, interrupt: "approve-refund" },
      { key, interrupt: "approve-refund", answer: { approved: "yes", by: "x" } },
      { key, interrupt: "approve-refund", answer: { approved: true } },
      { key, interrupt: "approve-refund", answer: { approved: true, by: "x", note: "n".repeat(501) } },
      { key, interrupt: "approve-refund", answer: [true] },
    ]) {
      expect((await answer(run.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await answer("run_doesnotexist00", approve(key))).status).toBe(404);
    expect((await engine.getRun(run.id)).status).toBe("interrupted");
  });

  it("closes the pause in Infra when the app's own resume answers it, or a cancel ends it", async () => {
    const sent = infra();
    const { engine, call, settle } = app();
    const resumed = await engine.start("refund");
    await resumed.done;
    const resumedKey = (await engine.getRun(resumed.run.id)).interrupt!.key;
    const response = await call(`/runs/${resumed.run.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: { approved: true, by: "app" }, interrupt: resumedKey }),
    });
    expect(response.status).toBe(202);
    await settle();

    const cancelled = await engine.start("refund");
    await cancelled.done;
    const cancelledKey = (await engine.getRun(cancelled.run.id)).interrupt!.key;
    expect((await call(`/runs/${cancelled.run.id}/cancel`)).status).toBe(200);

    expect(sent.entries().filter((entry) => entry.status === "closed")).toEqual([
      { run: resumed.run.id, key: resumedKey, interrupt: "approve-refund", status: "closed" },
      { run: cancelled.run.id, key: cancelledKey, interrupt: "approve-refund", status: "closed" },
    ]);
  });

  it("registers on a long-lived server, and with AGENT_UNIT_CLOCK=local, which turns off only the clock", async () => {
    const sent = infra();
    const { engine } = app({ AGENT_UNIT_CLOCK: "local" });
    const { run, done } = await engine.start("refund");
    await done;
    expect(sent.entries()).toEqual([expect.objectContaining({ run: run.id, status: "open" })]);
    expect(sent.wakes).toEqual([]);
  });

  it("sends nothing without FARMJS_API_KEY", async () => {
    const sent = infra();
    const { engine } = app({ FARMJS_API_KEY: undefined });
    await (await engine.start("refund")).done;
    expect(sent.approvals).toEqual([]);
  });

  it("never fails a run when Infra is down, and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    infra(() => new Response("down", { status: 503 }));
    const { engine } = app({ AGENT_UNIT_CLOCK: "local" });
    for (let i = 0; i < 2; i++) expect(await (await engine.start("refund")).done).toMatchObject({ status: "interrupted" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/Farm\.js Infra did not take the runs' approvals \(HTTP 503\)/);
  });
});

describe("farmApprovals", () => {
  const run = { id: "run_aaaaaaaaaaaa", agent: "refund" } as RunRecord;
  const pause = (overrides: Partial<PendingInterrupt> = {}): PendingInterrupt => ({ key: "interrupt:approve#0", name: "approve", payload: { amount: 1 }, ...overrides });
  const registry = (overrides: Record<string, string | undefined> = {}, endpoint: string | undefined = SITE) =>
    farmApprovals({ env: () => ({ ...env, ...overrides }), endpoint: () => endpoint });

  it("drops a payload over 16 KB of UTF-8 JSON, and keeps one at the limit", async () => {
    const sent = infra();
    const approvals = registry();
    // Under 16 KB in characters, twice that in UTF-8.
    const wide = "é".repeat(8_200);
    // Exactly 16 KB once stringified: the quotes count.
    const exact = "a".repeat(16 * 1024 - 2);
    await Promise.all([
      approvals.open({ ...run, id: "run_wide00000000" }, pause({ payload: wide })),
      approvals.open({ ...run, id: "run_exact0000000" }, pause({ payload: exact })),
      approvals.open({ ...run, id: "run_none00000000" }, pause({ payload: undefined })),
    ]);
    const [over, at, none] = sent.entries();
    expect(over!.payload).toEqual({ omitted: "payload larger than 16 KB" });
    expect(at!.payload).toBe(exact);
    expect(none).not.toHaveProperty("payload");
  });

  it("skips an interrupt name or key outside 1 to 120 characters, says so once, and sends the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sent = infra();
    const approvals = registry();
    await Promise.all([
      approvals.open(run, pause({ name: "n".repeat(121), key: "interrupt:long#0" })),
      approvals.open(run, pause({ key: `${"s".repeat(110)}/interrupt:approve#0` })),
      approvals.open(run, pause({ name: "n".repeat(120), key: "interrupt:ok#0" })),
    ]);
    expect(sent.entries().map((entry) => entry.key)).toEqual(["interrupt:ok#0"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/interrupt names and keys of 1 to 120 characters/);
  });

  it("keeps a close over an open of the same pause in one batch, whichever came first", async () => {
    const sent = infra();
    const approvals = registry();
    await Promise.all([approvals.close(run, pause()), approvals.open(run, pause())]);
    await Promise.all([approvals.open(run, pause({ key: "interrupt:approve#1" })), approvals.close(run, pause({ key: "interrupt:approve#1" }))]);
    expect(sent.entries().map((entry) => [entry.key, entry.status])).toEqual([
      ["interrupt:approve#0", "closed"],
      ["interrupt:approve#1", "closed"],
    ]);
  });

  it("sends at most 100 approvals to a request", async () => {
    const sent = infra();
    const approvals = registry();
    await Promise.all(Array.from({ length: 150 }, (_, i) => approvals.open(run, pause({ key: `interrupt:approve#${i}` }))));
    expect(sent.approvals.map((call) => call.body.approvals.length)).toEqual([100, 50]);
  });

  it("takes a local http URL only while Infra is local too, like the clock", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ accepted: 1 }, { status: 202 });
    }) as typeof fetch;
    for (const endpoint of ["http://localhost:3000/api/agent", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      await registry({ FARMJS_API_URL: "http://localhost:4000/" }, endpoint).open(run, pause());
      expect(farmClock({ env: () => ({ ...env, FARMJS_API_URL: "http://127.0.0.1:4000" }), endpoint: () => endpoint }).mode()).toBe("backstop");
    }
    expect(urls).toEqual(Array(3).fill("http://localhost:4000/api/agents/approvals"));
    expect(warn).not.toHaveBeenCalled();

    // Hosted Infra cannot call a local URL, and a local Infra does not make a remote http URL fine.
    for (const [api, endpoint] of [
      ["https://infra.example.com", "http://localhost:3000"],
      ["http://localhost:4000", "http://app.example.com"],
      ["http://localhost.example.com", "http://localhost:3000"],
    ] as const) {
      await registry({ FARMJS_API_URL: api }, endpoint).open(run, pause());
      expect(farmClock({ env: () => ({ ...env, FARMJS_API_URL: api }), endpoint: () => endpoint }).mode()).toBe("off");
    }
    expect(urls).toHaveLength(3);
    expect(String(warn.mock.calls[0]![0])).toMatch(/https URLs only \(a localhost one too when FARMJS_API_URL is local\)/);
  });
});

describe("Durable Objects runtime", () => {
  it("registers pauses from the run's object at AGENT_UNIT_URL, and takes Infra's answer", async () => {
    const sent = infra();
    const unit = createDurableAgentUnit({ basePath: "/api/agent/", agents: { refund: refund() } });
    const runs = new FakeNamespace(unit.AgentUnitRun as never);
    const index = new FakeNamespace(unit.AgentUnitIndex as never);
    const bindings = { ...env, AGENT_UNIT_URL: "https://agents.example.com/ignored/path", AGENT_UNIT_RUNS: runs, AGENT_UNIT_INDEX: index };
    runs.env = bindings;
    index.env = bindings;
    const pending: Promise<unknown>[] = [];
    const call = (path: string, init?: RequestInit) =>
      unit.fetch(new Request(`https://agents.example.com/api/agent${path}`, init), bindings, { waitUntil: (promise) => void pending.push(promise) });
    const settle = async () => {
      while (pending.length) await Promise.allSettled(pending.splice(0));
      await runs.settle();
    };

    const run = await (await call("/agents/refund/runs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    await settle();
    expect(sent.approvals.map((c) => c.body)).toEqual([
      {
        endpoint: "https://agents.example.com/api/agent",
        approvals: [{ run: run.id, key: "interrupt:approve-refund#0", agent: "refund", interrupt: "approve-refund", payload: { amount: 18400 }, status: "open" }],
      },
    ]);

    const path = `/api/agent/__agent-unit/answer/${run.id}`;
    const response = await call(`/__agent-unit/answer/${run.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "farmjs-signature": await farmjsSignature(KEY, "POST", path) },
      body: JSON.stringify(approve("interrupt:approve-refund#0")),
    });
    expect(response.status).toBe(200);
    await settle();
    expect(await (await call(`/runs/${run.id}`, { method: "GET" })).json()).toMatchObject({ status: "completed", output: "refunded by kinfe@example.com" });
    expect(sent.entries().map((entry) => entry.status)).toEqual(["open"]);
  });
});
