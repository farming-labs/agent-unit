import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineAgent } from "../packages/runtime/src/agents";
import { createHandler } from "../packages/runtime/src/server";
import { farmClock, farmjsSignature, verifyFarmjsSignature } from "../packages/runtime/src/server/farmjs";
import { createEngine } from "./helpers";

// Farm.js Infra as the clock: it registers wake-ups, and calls back signed with FARMJS_API_KEY.

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

const post = { method: "POST" };
const napper = (duration = "2h") =>
  defineAgent(async (_input, run) => {
    await run.sleep(duration);
    return "rested";
  });

/** A handler under /api/agent, and a signed call to one of its internal routes. */
function app(env: Record<string, string | undefined>, agents: Record<string, unknown> = { nap: napper() }) {
  const engine = createEngine(agents, { env });
  engines.push(engine);
  const handler = createHandler(engine, { basePath: "/api/agent" });
  const pending: Promise<unknown>[] = [];
  const call = (path: string, init: RequestInit = post, waitUntil = true) =>
    handler(new Request(`${SITE}/api/agent${path}`, init), waitUntil ? { waitUntil: (promise) => pending.push(promise) } : {});
  const signed = async (path: string, key = KEY, now = Date.now()) =>
    call(path, { method: "POST", headers: { "farmjs-signature": await farmjsSignature(key, "POST", `/api/agent${path}`, now) } });
  const settle = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  return { engine, handler, call, signed, settle };
}

/** Records the requests sent to Infra, answering each with `answer`. */
function infra(answer: () => Response | Promise<Response> = () => Response.json({ accepted: 1 }, { status: 202 })) {
  const calls: { url: string; headers: Headers; body: { endpoint: string; wakes: { run: string; at: string }[] } }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, headers: request.headers, body: await request.json() });
    return answer();
  }) as typeof fetch;
  return calls;
}

describe("farmjs-signature", () => {
  it("matches the pinned test vector", async () => {
    const at = 1793544000 * 1000;
    const path = "/api/agent/__agent-unit/wake/run_test";
    const header = await farmjsSignature(KEY, "POST", path, at);
    expect(header).toBe("t=1793544000,v1=d0c936e993defca884a076e3282886b8d37bce439616ddd889a207fb328da181");
    expect(await verifyFarmjsSignature(KEY, header, "POST", path, at)).toBe(true);
    expect(await verifyFarmjsSignature(KEY, header, "GET", path, at)).toBe(false);
  });

  it("accepts the test vector on the wake route, as Infra sends it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1793544000 * 1000 + 30_000);
    const { call } = app({ FARMJS_API_KEY: KEY });
    const response = await call("/__agent-unit/wake/run_test", {
      method: "POST",
      headers: { "farmjs-signature": "t=1793544000,v1=d0c936e993defca884a076e3282886b8d37bce439616ddd889a207fb328da181" },
    });
    // Signed, but no run the engine could have made: nothing to check again.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: null });
  });

  it("refuses a wrong key, another path, a stale or future time and malformed headers", async () => {
    const { call, signed } = app({ FARMJS_API_KEY: KEY });
    const path = "/__agent-unit/sweep";
    expect((await signed(path)).status).toBe(200);
    expect((await signed(path, "farmjs_other_key")).status).toBe(401);
    expect((await signed(path, KEY, Date.now() - 301_000)).status).toBe(401);
    expect((await signed(path, KEY, Date.now() + 301_000)).status).toBe(401);
    expect((await signed(path, KEY, Date.now() - 295_000)).status).toBe(200);
    // A signature for one run's wake-up does not wake another.
    const other = await farmjsSignature(KEY, "POST", "/api/agent/__agent-unit/wake/run_aaaaaaaaaaaa");
    expect((await call("/__agent-unit/wake/run_bbbbbbbbbbbb", { method: "POST", headers: { "farmjs-signature": other } })).status).toBe(401);
    // Nor does it carry over to the path without the base path.
    const unprefixed = await farmjsSignature(KEY, "POST", path);
    expect((await call(path, { method: "POST", headers: { "farmjs-signature": unprefixed } })).status).toBe(401);
    const valid = await farmjsSignature(KEY, "POST", `/api/agent${path}`);
    const t = valid.slice(2, valid.indexOf(","));
    const v1 = valid.slice(valid.indexOf("v1=") + 3);
    for (const header of ["", "t=,v1=", `t=${t}`, `v1=${v1}`, `t=${t},v1=${v1.toUpperCase()}`, `t=${t},v1=${v1.slice(1)}`, `t=${t}.5,v1=${v1}`, `t=-${t},v1=${v1}`, `${v1}`]) {
      expect((await call(path, { method: "POST", headers: { "farmjs-signature": header } })).status, header).toBe(401);
    }
    expect((await call(path, { method: "POST", headers: { "farmjs-signature": `v1=${v1}, t=${t}` } })).status).toBe(200);
  });

  it("refuses signatures without FARMJS_API_KEY, and still takes the bearer secret", async () => {
    const without = app({});
    const header = await farmjsSignature("", "POST", "/api/agent/__agent-unit/sweep");
    expect((await without.call("/__agent-unit/sweep", { method: "POST", headers: { "farmjs-signature": header } })).status).toBe(401);
    const both = app({ FARMJS_API_KEY: KEY, AGENT_UNIT_SECRET: "s3cret" });
    expect((await both.call("/__agent-unit/sweep", { method: "POST", headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
    expect((await both.signed("/__agent-unit/sweep")).status).toBe(200);
    expect((await both.call("/__agent-unit/sweep", { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });
});

describe("wake route", () => {
  it("runs handleWake and answers when to check again", async () => {
    const { engine, call, signed, settle } = app({ FARMJS_API_KEY: KEY, AGENT_UNIT_CLOCK: "local" });
    const run = await (await call("/agents/nap/runs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    await settle();
    const { wakeAt } = await engine.getRun(run.id);
    const handleWake = vi.spyOn(engine, "handleWake");

    // Not due: the run's own wake time.
    const early = await signed(`/__agent-unit/wake/${run.id}`);
    expect(early.status).toBe(200);
    expect(await early.json()).toEqual({ next: wakeAt });
    expect(handleWake).toHaveBeenCalledWith(run.id, expect.objectContaining({ background: expect.any(Function) }));

    // Due: it wakes in the background, so check again once its lease could lapse.
    const record = await engine.store.getRun(run.id);
    record!.wakeAt = new Date(Date.now() - 1000).toISOString();
    await engine.store.putRun(record!);
    const due = await (await signed(`/__agent-unit/wake/${run.id}`)).json();
    expect(Date.parse(due.next)).toBeGreaterThan(Date.now() + 50_000);
    await settle();
    expect(await engine.getRun(run.id)).toMatchObject({ status: "completed", output: "rested" });

    // Finished: nothing more to check.
    expect(await (await signed(`/__agent-unit/wake/${run.id}`)).json()).toEqual({ next: null });
    expect(await (await signed("/__agent-unit/wake/run_doesnotexist")).json()).toEqual({ next: null });
    expect((await call(`/__agent-unit/wake/${run.id}`)).status).toBe(401);
  });

  it("answers the run's next sleep when it sleeps again before answering", async () => {
    // Without waitUntil the request carries the run; the clock replaces its time with the answer.
    const { engine, handler } = app(
      { FARMJS_API_KEY: KEY, AGENT_UNIT_CLOCK: "local" },
      {
        twice: defineAgent(async (_input, run) => {
          await run.sleep("1h");
          await run.sleep("3h");
          return "done";
        }),
      },
    );
    const { run, done } = await engine.start("twice");
    await done;
    const record = await engine.store.getRun(run.id);
    record!.wakeAt = new Date(Date.now() - 1000).toISOString();
    await engine.store.putRun(record!);
    const path = `/api/agent/__agent-unit/wake/${run.id}`;
    const response = await handler(new Request(`${SITE}${path}`, { method: "POST", headers: { "farmjs-signature": await farmjsSignature(KEY, "POST", path) } }));
    const { next } = await response.json();
    expect(await engine.getRun(run.id)).toMatchObject({ status: "sleeping", wakeAt: next });
    expect(Date.parse(next)).toBeGreaterThan(Date.now() + 2.9 * 3_600_000);
  });

  it("leaves an engine with a scheduler of its own without the clock", () => {
    const engine = createEngine({ nap: napper() }, { env: { FARMJS_API_KEY: KEY, AGENT_UNIT_URL: SITE }, scheduleWake: () => undefined });
    createHandler(engine);
    expect(engine.options.clock).toBeUndefined();
  });
});

describe("Farm.js clock", () => {
  const env = {
    FARMJS_API_KEY: KEY,
    FARMJS_API_URL: "https://infra.example.com/",
    FARMJS_ENVIRONMENT: "staging",
    FARMJS_PROJECT_ID: "proj_123",
    AGENT_UNIT_URL: SITE,
  };

  it("registers a sleeping run's wake-up with Infra, and keeps in-process timers on a server", async () => {
    const calls = infra();
    const { engine, call, settle } = app(env, { nap: napper("300ms") });
    const run = await (await call("/agents/nap/runs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    await settle();
    const { wakeAt } = await engine.getRun(run.id);
    expect(calls.map((c) => c.url)).toEqual(["https://infra.example.com/api/agents/wakes", "https://infra.example.com/api/agents/wakes"]);
    const [watchdog, sleep] = calls;
    expect(Object.fromEntries(watchdog!.headers)).toMatchObject({
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      "x-farm-environment": "staging",
      "x-farm-project": "proj_123",
    });
    // The watchdog while it runs, then the end of its sleep.
    expect(watchdog!.body).toEqual({ endpoint: `${SITE}/api/agent`, wakes: [{ run: run.id, at: expect.any(String) }] });
    expect(Date.parse(watchdog!.body.wakes[0]!.at)).toBeGreaterThan(Date.now() + 50_000);
    expect(sleep!.body).toEqual({ endpoint: `${SITE}/api/agent`, wakes: [{ run: run.id, at: wakeAt }] });
    // A long-lived server wakes it on time by itself too.
    await vi.waitFor(async () => expect(await engine.getRun(run.id)).toMatchObject({ status: "completed" }), { timeout: 3000 });
    engine.close();
  });

  it("only registers on serverless hosts", async () => {
    for (const host of [{ VERCEL: "1" }, { NETLIFY: "true" }, { AWS_LAMBDA_FUNCTION_NAME: "agents" }]) {
      const calls = infra();
      const { engine } = app({ ...env, ...host }, { nap: napper("30ms") });
      const { run, done } = await engine.start("nap");
      await done;
      expect(calls.at(-1)!.body.wakes).toEqual([{ run: run.id, at: (await engine.getRun(run.id)).wakeAt }]);
      // No in-process timer: the run sleeps until Infra calls.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect((await engine.getRun(run.id)).status).toBe("sleeping");
    }
  });

  it("sends wake-ups made together as one request, at most 100 to a request", async () => {
    const calls = infra();
    const clock = farmClock({ env: () => env, endpoint: () => SITE });
    await Promise.all([clock.schedule("run_a", 1_000), clock.schedule("run_b", 2_000), clock.schedule("run_a", 3_000)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      endpoint: SITE,
      wakes: [
        { run: "run_a", at: new Date(3_000).toISOString() },
        { run: "run_b", at: new Date(2_000).toISOString() },
      ],
    });
    const at = Date.now() + 60_000;
    await Promise.all(Array.from({ length: 150 }, (_, i) => clock.schedule(`run_${i}`, at)));
    expect(calls.slice(1).map((c) => c.body.wakes.length)).toEqual([100, 50]);
    // A sleep longer than Infra takes is registered at its limit.
    await clock.schedule("run_far", Date.now() + 400 * 86_400_000);
    expect(Date.parse(calls.at(-1)!.body.wakes[0]!.at)).toBeLessThanOrEqual(Date.now() + 366 * 86_400_000);
  });

  it("gives up on Infra after 2s without failing the run, and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    globalThis.fetch = (() => new Promise(() => undefined)) as typeof fetch;
    const { engine } = app(env, { quick: defineAgent(async () => "ok") });
    const started = Date.now();
    const { done } = await engine.start("quick");
    expect(await done).toMatchObject({ status: "completed", output: "ok" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(4_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/Farm\.js Infra did not take the runs' wake-ups \(no answer in 2s\)/);
  });

  it("logs a failing Infra once, however often it fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls = infra(() => new Response("down", { status: 503 }));
    const clock = farmClock({ env: () => env, endpoint: () => SITE });
    await clock.schedule("run_a", Date.now());
    await clock.schedule("run_b", Date.now());
    globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    await expect(clock.schedule("run_c", Date.now())).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("(HTTP 503)");
  });

  it("is off with AGENT_UNIT_CLOCK=local, without FARMJS_API_KEY, and without an https site URL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls = infra();
    const clock = (overrides: Record<string, string | undefined>, endpoint: string | undefined = SITE) =>
      farmClock({ env: () => ({ ...env, ...overrides }), endpoint: () => endpoint });
    expect(clock({ AGENT_UNIT_CLOCK: "local" }).mode()).toBe("off");
    expect(clock({ AGENT_UNIT_CLOCK: "local", VERCEL: "1" }).mode()).toBe("off");
    expect(clock({ FARMJS_API_KEY: undefined }).mode()).toBe("off");
    expect(warn).not.toHaveBeenCalled();
    expect(clock({ FARMJS_API_KEY: undefined, AGENT_UNIT_CLOCK: "farmjs" }).mode()).toBe("off");
    expect(String(warn.mock.calls.at(-1)![0])).toMatch(/AGENT_UNIT_CLOCK is farmjs, but FARMJS_API_KEY is not set/);
    expect(clock({ AGENT_UNIT_CLOCK: "farmjs" }).mode()).toBe("backstop");
    expect(clock({ AGENT_UNIT_CLOCK: "farmjs", VERCEL: "1" }).mode()).toBe("only");
    expect(clock({}, "http://localhost:3000").mode()).toBe("off");

    // With the engine: a run still sleeps and wakes in-process, and Infra hears nothing.
    const local = app({ ...env, AGENT_UNIT_CLOCK: "local" }, { nap: napper("30ms") });
    const { run } = await local.engine.start("nap");
    await vi.waitFor(async () => expect(await local.engine.getRun(run.id)).toMatchObject({ status: "completed" }), { timeout: 2000 });
    expect(calls).toEqual([]);
  });

  it("skips registering, and says so once, when the site URL is unknown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls = infra();
    const { engine } = app({ ...env, AGENT_UNIT_URL: undefined, VERCEL: "1" }, { nap: napper("30ms") });
    for (let i = 0; i < 2; i++) {
      const { run, done } = await engine.start("nap");
      await done;
      // As without the clock: the in-process timer still wakes it.
      await vi.waitFor(async () => expect(await engine.getRun(run.id)).toMatchObject({ status: "completed" }), { timeout: 2000 });
    }
    expect(calls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/this deployment's URL is unknown.*Set AGENT_UNIT_URL/);
  });

  it("registers at Vercel's and Netlify's own URL", async () => {
    const calls = infra();
    for (const [host, endpoint] of [
      [{ VERCEL: "1", VERCEL_URL: "app-abc.vercel.app" }, "https://app-abc.vercel.app/api/agent"],
      [{ NETLIFY: "true", URL: "https://agents.netlify.app" }, "https://agents.netlify.app/api/agent"],
      // Production wakes go to the production domain, not the protected per-deployment URL.
      [
        { VERCEL: "1", VERCEL_ENV: "production", VERCEL_URL: "app-abc.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "agents.example.com" },
        "https://agents.example.com/api/agent",
      ],
      [{ VERCEL: "1", VERCEL_ENV: "preview", VERCEL_URL: "app-def.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "agents.example.com" }, "https://app-def.vercel.app/api/agent"],
      [{ VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "agents.example.com", AGENT_UNIT_URL: "https://wake.example.com" }, "https://wake.example.com/api/agent"],
    ] as const) {
      const { engine } = app({ FARMJS_API_KEY: KEY, ...host });
      await (await engine.start("nap")).done;
      expect(calls.at(-1)!.body.endpoint).toBe(endpoint);
    }
  });
});

describe("self-continuation", () => {
  it("is signed with FARMJS_API_KEY when there is no AGENT_UNIT_SECRET", async () => {
    let steps = 0;
    const engine = createEngine(
      {
        long: defineAgent(async (_input, run) => {
          for (let i = 0; i < 3; i++) {
            await run.step(`part-${i}`, async () => {
              await new Promise((resolve) => setTimeout(resolve, 15));
              return ++steps;
            });
          }
          return steps;
        }),
      },
      { budgetMs: 10, env: { FARMJS_API_KEY: KEY, AGENT_UNIT_URL: SITE, AGENT_UNIT_CLOCK: "local" } },
    );
    const handler = createHandler(engine);
    const continued: Request[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      continued.push(request.clone());
      return handler(request);
    }) as typeof fetch;
    const { run, done } = await engine.start("long");
    await done;
    await vi.waitFor(async () => expect(await engine.getRun(run.id)).toMatchObject({ status: "completed", output: 3 }), { timeout: 5000 });
    expect(continued.length).toBeGreaterThan(0);
    for (const request of continued) {
      expect(new URL(request.url).pathname).toMatch(/^\/__agent-unit\/continue\/run_/);
      expect(request.headers.get("authorization")).toBeNull();
      expect(await verifyFarmjsSignature(KEY, request.headers.get("farmjs-signature")!, "POST", new URL(request.url).pathname)).toBe(true);
    }
  });
});

describe("Netlify's scheduled sweep", () => {
  it("is signed with FARMJS_API_KEY when there is no AGENT_UNIT_SECRET", async () => {
    const { prepareEngine } = await import("../src/build/engine");
    const root = mkdtempSync(join(tmpdir(), "agent-unit-netlify-sweep-"));
    const saved = { URL: process.env.URL, AGENT_UNIT_SECRET: process.env.AGENT_UNIT_SECRET, FARMJS_API_KEY: process.env.FARMJS_API_KEY };
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sweep", type: "module" }));
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const build = prepareEngine({ root, name: "sweep", config: { basePath: "/api/agent", storage: "memory" }, agentFiles: {} }, "netlify", join(root, ".agent-unit"), () => {});
      mkdirSync(join(root, "out"));
      await build.finish({ outDir: join(root, "out"), serverDir: join(root, "functions", "server") }, () => {});
      const sweep = await import(pathToFileURL(join(root, "functions", "agent-unit-sweep", "agent-unit-sweep.mjs")).href);

      const engine = createEngine({ nap: napper() }, { env: { FARMJS_API_KEY: KEY } });
      const handler = createHandler(engine, { basePath: "/api/agent" });
      const statuses: number[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await handler(new Request(input, init));
        statuses.push(response.status);
        return response;
      }) as typeof fetch;
      Object.assign(process.env, { URL: SITE, FARMJS_API_KEY: KEY });
      delete process.env.AGENT_UNIT_SECRET;
      expect((await sweep.default()).status).toBe(204);
      expect(statuses).toEqual([200]);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
