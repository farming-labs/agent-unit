import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { Redis } from "ioredis";
import { createStorage } from "unstorage";
import redisDriver from "unstorage/drivers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineAgent, functionAdapter, resolveAgent } from "../../src/agents";
import { redisCoordination } from "../../src/redis";
import { RunEngine } from "../../src/runtime/engine";
import { RunStore } from "../../src/runtime/store";
import type { RunRecord } from "../../src/types";
import { ROOT, buildFixture, cleanup, createAgentClient, hasBinary, prepareFixture, startServer, tempDir, waitForStatus, type RunningServer } from "./helpers";

// Real Redis: REDIS_URL (CI runs a Redis service), or a throwaway redis-server when one is installed.
// CI sets AGENT_UNIT_REQUIRE_REDIS so this suite can never be skipped there by accident.
const available = Boolean(process.env.REDIS_URL) || hasBinary("redis-server");
if (process.env.AGENT_UNIT_REQUIRE_REDIS && !available) throw new Error("Redis is required for this suite.");

describe.skipIf(!available)("Redis coordination", () => {
  let url: string;
  let server: ChildProcess | undefined;
  const clients: Redis[] = [];
  const connect = () => {
    const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
    clients.push(client);
    return client;
  };
  let prefix = 0;
  const base = () => `agent-unit-test-${process.pid}-${++prefix}`;

  beforeAll(async () => {
    if (process.env.REDIS_URL) {
      url = process.env.REDIS_URL;
    } else {
      const port = 30_000 + Math.floor(Math.random() * 20_000);
      server = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
      url = `redis://127.0.0.1:${port}`;
    }
    const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    probe.on("error", () => {});
    for (let i = 0; ; i++) {
      try {
        await probe.connect();
        await probe.ping();
        break;
      } catch (error) {
        if (i > 100) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    probe.disconnect();
  });

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    if (server && server.exitCode === null) {
      const gone = new Promise((resolve) => server!.once("exit", resolve));
      server.kill("SIGKILL");
      await gone;
    }
  });

  const record = (version?: number): RunRecord => {
    const now = new Date().toISOString();
    return { id: "run_redis0000000000000", agent: "x", threadId: "t", status: "running", input: {}, attempt: 1, eventCount: 0, createdAt: now, updatedAt: now, version };
  };

  it("compare-and-set lets exactly one of many concurrent writers win, from separate connections", async () => {
    const prefixKey = base();
    const writers = Array.from({ length: 8 }, () => redisCoordination({ client: connect(), base: prefixKey }).atomic);
    expect(await writers[0]!.compareAndSet("runs:a", undefined, record(1))).toBe(true);
    // Creating a run that exists is refused.
    expect(await writers[1]!.compareAndSet("runs:a", undefined, record(1))).toBe(false);
    const results = await Promise.all(writers.map((writer) => writer.compareAndSet("runs:a", 1, record(2))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(JSON.parse((await connect().get(`${prefixKey}:runs:a`))!)).toMatchObject({ version: 2 });
    // A record without a version (written before versions existed) counts as version 0.
    await connect().set(`${prefixKey}:runs:b`, JSON.stringify({ ...record(), version: undefined }));
    expect(await writers[0]!.compareAndSet("runs:b", 1, record(2))).toBe(false);
    expect(await writers[0]!.compareAndSet("runs:b", 0, record(1))).toBe(true);
  });

  it("gives a lease to one owner at a time, and lets it expire", async () => {
    const prefixKey = base();
    const [a, b] = [redisCoordination({ client: connect(), base: prefixKey }).leases, redisCoordination({ client: connect(), base: prefixKey }).leases];
    const wins = await Promise.all([a.acquire("r", "a", 5_000), b.acquire("r", "b", 5_000)]);
    expect(wins.filter(Boolean)).toHaveLength(1);
    const [holder, other] = wins[0] ? [a, b] : [b, a];
    const [owner, stranger] = wins[0] ? ["a", "b"] : ["b", "a"];
    expect(await holder.acquire("r", owner, 5_000)).toBe(true);
    expect(await other.renew("r", stranger, 5_000)).toBe(false);
    await other.release("r", stranger);
    expect(await other.expired("r")).toBe(false);
    expect(await holder.renew("r", owner, 50)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await other.expired("r")).toBe(true);
    expect(await other.acquire("r", stranger, 5_000)).toBe(true);
    await other.release("r", stranger);
    expect(await holder.expired("r")).toBe(true);
  });

  it("honours a lease left by the storage-backed default until it expires", async () => {
    const prefixKey = base();
    const leases = redisCoordination({ client: connect(), base: prefixKey }).leases;
    await connect().set(`${prefixKey}:lease:r`, JSON.stringify({ owner: "old-process", until: Date.now() + 60_000 }));
    expect(await leases.expired("r")).toBe(false);
    expect(await leases.acquire("r", "new-process", 5_000)).toBe(false);
    await connect().set(`${prefixKey}:lease:r`, JSON.stringify({ owner: "old-process", until: Date.now() - 1 }));
    expect(await leases.expired("r")).toBe(true);
    expect(await leases.acquire("r", "new-process", 5_000)).toBe(true);
  });

  it("lets one of two processes on the redis driver win a resume race", async () => {
    const prefixKey = base();
    let charges = 0;
    const agents = [
      resolveAgent(
        "refund",
        defineAgent(async (_input, run) => {
          const answer = await run.interrupt<string>("approve");
          await run.step("charge", () => ++charges);
          return answer;
        }),
        [functionAdapter],
      ),
    ];
    // Two "processes": separate drivers, connections, stores and engines over one Redis.
    const engines = [0, 1].map(() => {
      const driver = redisDriver({ url, base: prefixKey });
      const coordination = redisCoordination({ client: () => driver.getInstance!() as never, base: prefixKey });
      return new RunEngine({ store: new RunStore(createStorage({ driver }), coordination), agents });
    });
    expect(engines[0]!.store.atomicWrites).toBe(true);
    const { run, done } = await engines[0]!.start("refund");
    await done;
    const results = await Promise.allSettled([engines[0]!.resume(run.id, "from-0"), engines[1]!.resume(run.id, "from-1")]);
    const winner = results.findIndex((result) => result.status === "fulfilled");
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results[1 - winner]).toMatchObject({ status: "rejected", reason: { status: 409 } });
    await (results[winner] as PromiseFulfilledResult<{ done: Promise<unknown> }>).value.done;
    expect(await engines[1]!.getRun(run.id)).toMatchObject({ status: "completed", output: `from-${winner}` });
    expect(charges).toBe(1);
    for (const engine of engines) await engine.store.storage.dispose();
  });

  it("wires Redis coordination in for `agent-unit dev` too", async () => {
    const env = { AGENT_UNIT_STORAGE: "redis", REDIS_URL: url, AGENT_UNIT_DATA: base() };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    const { startDev } = (await import(join(ROOT, "dist/build.mjs"))) as typeof import("../../src/build");
    const dev = await startDev({ root: prepareFixture("basic"), port: 0, watch: false, logger: { info() {}, warn() {}, error() {} } });
    try {
      const monitor = await connect().monitor();
      const commands: string[] = [];
      monitor.on("monitor", (_time: string, args: string[]) => commands.push(String(args[0]).toLowerCase()));
      const client = createAgentClient({ baseUrl: dev.url });
      const run = await client.start("refund", { orderId: "o_dev" });
      await waitForStatus(client, run.id, "interrupted");
      expect(commands).toContain("eval");
      monitor.disconnect();
    } finally {
      await dev.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  describe("built node server", () => {
    let root: string;
    let out: string;
    let env: Record<string, string>;
    const servers: RunningServer[] = [];

    beforeAll(async () => {
      root = prepareFixture("basic");
      out = tempDir("redis-out");
      // The storage config is evaluated at build time, so the URL and prefix go in here.
      env = { AGENT_UNIT_STORAGE: "redis", REDIS_URL: url, AGENT_UNIT_DATA: base() };
      const result = await buildFixture(root, "node-server", out, env);
      expect(result.storage).toMatchObject({ driver: "redis" });
    });

    afterAll(async () => {
      for (const server of servers) await server.stop();
      cleanup(out);
    });

    it("wires Redis coordination in automatically, so two instances never both take one approval", async () => {
      for (let i = 0; i < 2; i++) servers.push(await startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: root, env }));
      const [a, b] = servers.map((server) => createAgentClient({ baseUrl: server.url }));
      const resume = (server: RunningServer, id: string, approved: boolean) =>
        fetch(`${server.url}/runs/${id}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: { approved } }) });
      // The servers coordinate through atomic scripts, not plain GET/SET: watch what they send.
      const monitor = await connect().monitor();
      const commands: string[] = [];
      monitor.on("monitor", (_time: string, args: string[]) => commands.push(String(args[0]).toLowerCase()));
      // Many races, because one approval racing over HTTP rarely lands both reads before either write.
      const runs = await Promise.all(Array.from({ length: 20 }, (_, i) => a!.start("refund", { orderId: `o_redis_${i}` })));
      await Promise.all(runs.map((run) => waitForStatus(a!, run.id, "interrupted")));
      await Promise.all(
        runs.map(async (run) => {
          const results = await Promise.all([resume(servers[0]!, run.id, true), resume(servers[1]!, run.id, false)]);
          expect(results.map((response) => response.status).sort()).toEqual([202, 409]);
          const final = await waitForStatus(b!, run.id, "completed");
          expect(final.output).toMatchObject(results[0]!.status === 202 ? { status: "refunded", charges: 1 } : { status: "declined" });
        }),
      );
      expect(commands.filter((command) => command === "eval").length).toBeGreaterThanOrEqual(runs.length * 2);
      monitor.disconnect();
    });
  });
});
