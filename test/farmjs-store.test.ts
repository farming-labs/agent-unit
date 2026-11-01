import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineAgent, functionAdapter, resolveAgent } from "../packages/runtime/src/agents";
import { RunEngine } from "../packages/runtime/src/runtime/engine";
import type { RunRecord } from "../packages/runtime/src/types";
import { createAgentUnit } from "../packages/runtime/src/server";
import { FARMJS_KEY_MISSING, FarmjsStoreClient, farmjsCoordination, farmjsStore } from "../packages/runtime/src/server/farmjs-store";
import { freePort } from "./e2e/helpers";
import { startFakeFarmjsStore, type FakeFarmjsStore } from "./fakes/farmjs-store";

// Farm.js storage: an unstorage driver, compare-and-set and leases over `POST {url}/v1/ops`, with a
// token from Farm.js Infra, against an in-memory store that keeps the contract's semantics.

let fake: FakeFarmjsStore;
const closers: (() => void | Promise<void>)[] = [];

beforeEach(async () => {
  // A key per test: tokens are cached per process, by Infra and key.
  fake = await startFakeFarmjsStore({ key: `farmjs_key_${Math.random().toString(36).slice(2)}` });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
  await fake.close();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (version?: number): RunRecord => {
  const now = new Date().toISOString();
  return { id: "run_farmjs000000000000", agent: "x", threadId: "t", status: "running", input: {}, attempt: 1, eventCount: 0, createdAt: now, updatedAt: now, version };
};
const coordination = (env: Record<string, string | undefined> = fake.env) => farmjsCoordination(new FarmjsStoreClient(() => env));

describe("Farm.js storage driver", () => {
  it("gets, sets, deletes and lists keys, keeping each value as written", async () => {
    const { storage } = farmjsStore({ env: fake.env });
    await storage.setItem("runs:b", { id: "b", version: 1 } as never);
    await storage.setItem("runs:a", { id: "a", nested: { list: [1, 2] } } as never);
    await storage.setItem("state:note", "plain text" as never);
    await storage.setItem("index:version", 1 as never);
    expect(await storage.getItem("runs:a")).toEqual({ id: "a", nested: { list: [1, 2] } });
    expect(await storage.getItem("state:note")).toBe("plain text");
    expect(await storage.getItem("index:version")).toBe(1);
    expect(await storage.hasItem("runs:a")).toBe(true);
    expect(await storage.hasItem("runs:missing")).toBe(false);
    expect(await storage.getItem("runs:missing")).toBeNull();
    expect(await storage.getKeys("runs")).toEqual(["runs:a", "runs:b"]);
    expect((await storage.getKeys()).sort()).toEqual(["index:version", "runs:a", "runs:b", "state:note"]);
    await storage.removeItem("runs:a");
    expect(await storage.getItem("runs:a")).toBeNull();
    expect(await storage.getKeys("runs")).toEqual(["runs:b"]);
    // Records travel as JSON values, so the store compares the version a `set` wrote as a `cas` would.
    expect(fake.opsRequests.flat().find((op) => op.op === "set" && op.key === "runs:b")).toMatchObject({ value: { id: "b", version: 1 } });
    expect(fake.values().get("state:note")).toBe("plain text");
  });

  it("writes a run record only over the version it read, and creates it only once", async () => {
    const writers = Array.from({ length: 6 }, () => coordination().atomic);
    expect(await writers[0]!.compareAndSet("runs:a", undefined, record(1))).toBe(true);
    expect(await writers[1]!.compareAndSet("runs:a", undefined, record(1))).toBe(false);
    const results = await Promise.all(writers.map((writer) => writer.compareAndSet("runs:a", 1, record(2))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fake.values().get("runs:a")).toMatchObject({ version: 2 });
    expect(await writers[2]!.compareAndSet("runs:a", 1, record(2))).toBe(false);
    // A record without a version counts as version 0, also when a plain `set` wrote it.
    const { storage } = farmjsStore({ env: fake.env });
    await storage.setItem("runs:old", { ...record(), version: undefined } as never);
    expect(await writers[0]!.compareAndSet("runs:old", 1, record(2))).toBe(false);
    expect(await writers[0]!.compareAndSet("runs:old", 0, record(1))).toBe(true);
  });

  it("gives a lease to one owner at a time, renews it only for its owner, and lets it expire", async () => {
    const [a, b] = [coordination().leases, coordination().leases];
    const wins = await Promise.all([a.acquire("r", "a", 5_000), b.acquire("r", "b", 5_000)]);
    expect(wins.filter(Boolean)).toHaveLength(1);
    const [holder, other] = wins[0] ? [a, b] : [b, a];
    const [owner, stranger] = wins[0] ? ["a", "b"] : ["b", "a"];
    expect(await holder.acquire("r", owner, 5_000)).toBe(true);
    expect(await other.renew("r", stranger, 5_000)).toBe(false);
    await other.release("r", stranger);
    expect(await other.expired("r")).toBe(false);
    expect(fake.leases().get("r")?.owner).toBe(owner);
    expect(await holder.renew("r", owner, 50)).toBe(true);
    await pause(120);
    expect(await other.expired("r")).toBe(true);
    expect(await holder.renew("r", owner, 5_000)).toBe(false);
    expect(await other.acquire("r", stranger, 5_000)).toBe(true);
    await other.release("r", stranger);
    // Checking a free lease leaves nobody holding it.
    expect(await holder.expired("r")).toBe(true);
    expect(fake.leases().has("r")).toBe(false);
    expect(await holder.acquire("r", owner, 5_000)).toBe(true);
  });

  it("gets a token once and shares it, sending the key, environment and project as the clock does", async () => {
    const env = { ...fake.env, FARMJS_ENVIRONMENT: "staging", FARMJS_PROJECT_ID: "proj_42" };
    const [one, two] = [farmjsStore({ env }), farmjsStore({ env })];
    await Promise.all([one.storage.setItem("a", "1" as never), two.storage.setItem("b", "2" as never), one.storage.getItem("b")]);
    await two.storage.getKeys();
    expect(fake.tokenRequests).toHaveLength(1);
    const [headers] = fake.tokenRequests;
    expect(headers!.get("authorization")).toBe(`Bearer ${fake.env.FARMJS_API_KEY}`);
    expect(headers!.get("x-farm-environment")).toBe("staging");
    expect(headers!.get("x-farm-project")).toBe("proj_42");
    expect([...fake.namespaces.keys()]).toEqual(["proj_42:staging"]);
  });

  it("gets a new token once 80% of its life has passed", async () => {
    await fake.close();
    fake = await startFakeFarmjsStore({ key: "farmjs_refresh_key", tokenLifeMs: 60_000 });
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const { storage } = farmjsStore({ env: fake.env });
    await storage.setItem("a", "1" as never);
    vi.setSystemTime(start + 47_000);
    await storage.getItem("a");
    expect(fake.tokenRequests).toHaveLength(1);
    vi.setSystemTime(start + 49_000);
    await storage.getItem("a");
    expect(fake.tokenRequests).toHaveLength(2);
  });

  it("keeps a token that has time left when Infra fails to replace it, and fails once it expires", async () => {
    await fake.close();
    fake = await startFakeFarmjsStore({ key: "farmjs_outage_key", tokenLifeMs: 60_000 });
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const { storage } = farmjsStore({ env: fake.env });
    await storage.setItem("a", "1" as never);
    fake.failTokens(503);
    vi.setSystemTime(start + 55_000);
    expect(await storage.getItem("a")).toBe(1);
    vi.setSystemTime(start + 61_000);
    await expect(storage.getItem("a")).rejects.toThrow(
      "agent-unit: Farm.js storage got no token from Farm.js Infra (HTTP 503): Farm.js storage is not available on this Farm.js Infra.",
    );
    fake.failTokens(undefined);
    expect(await storage.getItem("a")).toBe(1);
  });

  it("gets a new token once after a 401, and fails when the store refuses that one too", async () => {
    const { storage } = farmjsStore({ env: fake.env });
    await storage.setItem("a", "1" as never);
    fake.revokeTokens();
    expect(await storage.getItem("a")).toBe(1);
    expect(fake.tokenRequests).toHaveLength(2);
    fake.refuseAllTokens();
    await expect(storage.getItem("a")).rejects.toThrow("agent-unit: Farm.js storage answered HTTP 401 to get a: it refused the token Farm.js Infra gave, even a fresh one.");
    expect(fake.tokenRequests).toHaveLength(3);
    fake.refuseAllTokens(false);
    // The refused token is not kept: the next call asks for another.
    expect(await storage.getItem("a")).toBe(1);
    expect(fake.tokenRequests).toHaveLength(4);
  });

  it("says what went wrong, naming Farm.js storage and the status", async () => {
    await expect(farmjsStore({ env: {} }).getRun("run_a")).rejects.toThrow(FARMJS_KEY_MISSING);
    expect(FARMJS_KEY_MISSING).toContain("add FARMJS_API_KEY (from app.farmjs.dev)");
    expect(FARMJS_KEY_MISSING).toContain(`storage: "memory"`);
    await expect(farmjsStore({ env: { ...fake.env, FARMJS_API_KEY: "wrong" } }).getRun("run_a")).rejects.toThrow(
      "agent-unit: Farm.js storage got no token from Farm.js Infra (HTTP 401): FARMJS_API_KEY is unknown, revoked or expired.",
    );
    fake.failTokens(403);
    await expect(farmjsStore({ env: fake.env }).getRun("run_a")).rejects.toThrow(
      "(HTTP 403): the key needs the agents:runtime permission, and FARMJS_PROJECT_ID set for an organization-wide key.",
    );
    fake.failTokens(500);
    await expect(farmjsStore({ env: fake.env }).getRun("run_a")).rejects.toThrow("(HTTP 500): failing on purpose.");
    fake.failTokens(undefined);
    const closed = `http://127.0.0.1:${await freePort()}`;
    await expect(farmjsStore({ env: { ...fake.env, FARMJS_API_URL: closed } }).getRun("run_a")).rejects.toThrow(
      new RegExp(`^agent-unit: Farm.js storage was unreachable: no token from ${closed.replaceAll(".", "\\.")} \\(fetch failed, ECONNREFUSED\\)\\.$`),
    );
    const { storage } = farmjsStore({ env: fake.env });
    await expect(storage.setItem("state:big", "x".repeat(1024 * 1024 + 1) as never)).rejects.toThrow(
      "agent-unit: Farm.js storage answered HTTP 413 to set state:big: a value is over its 1 MiB limit.",
    );
    await expect(storage.setItem(`state:${"k".repeat(600)}`, "v" as never)).rejects.toThrow(/answered HTTP 400 to set state:k+: bad key\.$/);
  });

  it("stops at the store when it cannot be reached", async () => {
    const { storage } = farmjsStore({ env: fake.env });
    await storage.setItem("a", "1" as never);
    await fake.close();
    await expect(storage.getItem("a")).rejects.toThrow(new RegExp(`^agent-unit: Farm.js storage was unreachable at ${fake.storeUrl.replaceAll(".", "\\.")} \\(fetch failed`));
    fake = await startFakeFarmjsStore();
  });
});

describe("createAgentUnit with Farm.js storage", () => {
  const hello = defineAgent(async () => "hello");
  const unit = (options: Partial<Parameters<typeof createAgentUnit>[0]>) => {
    const created = createAgentUnit({ agents: { hello }, ...options });
    closers.push(() => created.close());
    return created;
  };

  it("keeps runs there when FARMJS_API_KEY is set and no storage is given, and finished runs 30 days", async () => {
    const { engine } = unit({ env: fake.env });
    expect(engine.options.retentionMs).toBe(30 * 86_400_000);
    expect(engine.store.atomicWrites).toBe(true);
    const { run, done } = await engine.start("hello");
    expect(await done).toMatchObject({ status: "completed", output: "hello" });
    expect(fake.values().get(`runs:${run.id}`)).toMatchObject({ status: "completed", output: "hello" });
    expect(unit({ storage: "farmjs", env: fake.env, retention: "7d" }).engine.options.retentionMs).toBe(7 * 86_400_000);
    expect(unit({ storage: farmjsStore({ env: fake.env }), env: fake.env }).engine.options.retentionMs).toBe(30 * 86_400_000);
  });

  it("keeps runs in memory or in the given storage, with no retention by default", async () => {
    const { engine } = unit({ storage: "memory", env: fake.env });
    expect(engine.options.retentionMs).toBeUndefined();
    expect(await (await engine.start("hello")).done).toMatchObject({ status: "completed" });
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("refuses to start without storage or FARMJS_API_KEY, saying how to give it some", () => {
    expect(() => unit({ env: {} })).toThrow(/^agent-unit: runs need storage, and none is set\. Either:\n {2}- add FARMJS_API_KEY \(from app\.farmjs\.dev\)/);
    expect(() => unit({ env: {} })).toThrow(`or storage: "memory" if runs may be lost between requests`);
    expect(() => unit({ storage: "redis" as never, env: {} })).toThrow(`storage is "farmjs", "memory", an unstorage instance or a RunStore, not "redis"`);
  });

  it("says once at startup that FARMJS_API_KEY is missing, and fails each request until it is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env: Record<string, string | undefined> = {};
    const first = unit({ storage: "farmjs", env });
    unit({ storage: "farmjs", env });
    expect(warn.mock.calls).toEqual([[FARMJS_KEY_MISSING]]);
    const response = await first.handler(new Request("https://app.example.com/agents/hello/runs", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(500);
    expect(error.mock.calls.flat().join(" ")).toContain("FARMJS_API_KEY is not set");
    Object.assign(env, fake.env);
    expect(await (await first.engine.start("hello")).done).toMatchObject({ status: "completed" });
  });
});

describe("the engine over Farm.js storage", () => {
  const engines = (agents: Record<string, unknown>, count: number, options: Partial<ConstructorParameters<typeof RunEngine>[0]> = {}) =>
    Array.from({ length: count }, () => {
      // Separate stores (and so separate processes, as far as coordination goes) over one Farm.js store.
      const engine = new RunEngine({
        store: farmjsStore({ env: fake.env }),
        agents: Object.entries(agents).map(([name, agent]) => resolveAgent(name, agent, [functionAdapter])),
        ...options,
      });
      closers.push(() => engine.close());
      return engine;
    });

  it("parks a sleeping run in the store, and another engine wakes and finishes it", async () => {
    const agents = {
      napper: defineAgent(async (_input, run) => {
        const before = await run.step("before", () => "rested");
        await run.sleep("150ms");
        return `${before} and awake`;
      }),
    };
    const [a, b, c] = engines(agents, 3);
    const { run, done } = await a!.start("napper");
    expect(await done).toMatchObject({ status: "sleeping" });
    // This process stops: its timer never fires.
    a!.close();
    expect(await b!.sweep()).toMatchObject({ woken: [] });
    await pause(200);
    const swept = await b!.sweep();
    expect(swept.woken).toEqual([run.id]);
    await swept.settled;
    expect(await c!.getRun(run.id)).toMatchObject({ status: "completed", output: "rested and awake" });
    const events = await c!.store.readEvents(run.id);
    expect(events.map((event) => event.type)).toContain("RUN_SLEEPING");
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: "rested and awake" });
    expect(await c!.listRuns({ status: "completed" })).toMatchObject([{ id: run.id }]);
  });

  it("lets one of two engines win a resume race, with its own answer", async () => {
    let charges = 0;
    const [a, b] = engines(
      {
        refund: defineAgent(async (_input, run) => {
          const answer = await run.interrupt<string>("approve");
          await run.step("charge", () => ++charges);
          return answer;
        }),
      },
      2,
    );
    expect(a!.store.atomicWrites).toBe(true);
    const { run, done } = await a!.start("refund");
    await done;
    const results = await Promise.allSettled([a!.resume(run.id, "from-a"), b!.resume(run.id, "from-b")]);
    const winner = results.findIndex((result) => result.status === "fulfilled");
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results[1 - winner]).toMatchObject({ status: "rejected", reason: { status: 409 } });
    await (results[winner] as PromiseFulfilledResult<{ done: Promise<unknown> }>).value.done;
    expect(await b!.getRun(run.id)).toMatchObject({ status: "completed", output: winner === 0 ? "from-a" : "from-b" });
    expect(charges).toBe(1);
    // The loser's write was refused by the store's compare-and-set, not by a check in this process.
    const cas = fake.opsRequests.flat().filter((op) => op.op === "cas");
    expect(cas.length).toBeGreaterThan(0);
  });

  it("lets only one of several engines continue a yielded run", async () => {
    const runs = { first: 0, second: 0 };
    const agents = {
      long: defineAgent(async (_input, run) => {
        await run.step("first", async () => {
          await pause(20);
          return ++runs.first;
        });
        await run.step("second", async () => {
          await pause(50);
          return ++runs.second;
        });
        return "done";
      }),
    };
    // The first engine yields after one step and hands the run to no one: four others race for it.
    const [starter] = engines(agents, 1, { budgetMs: 5, continueRun: () => {} });
    const racers = engines(agents, 4);
    const { run, done } = await starter!.start("long");
    expect(await done).toMatchObject({ status: "running" });
    expect(await racers[0]!.store.leaseExpired(run.id)).toBe(true);
    await Promise.all(racers.map((engine) => engine.continue(run.id)));
    expect(runs).toEqual({ first: 1, second: 1 });
    expect(await starter!.getRun(run.id)).toMatchObject({ status: "completed", output: "done" });
    // Leases are the store's own, taken and given back atomically, not records beside the run.
    const ops = fake.opsRequests.flat();
    expect(ops.filter((op) => op.op === "lease.acquire" && op.run === run.id && !String(op.owner).startsWith("probe_")).length).toBeGreaterThanOrEqual(2);
    expect(ops.some((op) => op.op === "set" && op.key === `lease:${run.id}`)).toBe(false);
    expect(fake.leases().has(run.id)).toBe(false);
  });
});
