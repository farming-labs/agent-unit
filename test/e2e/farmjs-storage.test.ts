import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { missingStorageError } from "../../src/build/engine";
import { startFakeFarmjsStore, type FakeFarmjsStore } from "../fakes/farmjs-store";
import { buildFixture, cleanup, createAgentClient, prepareFixture, ROOT, startServer, tempDir, waitForStatus } from "./helpers";
import { lambda, netlify, vercel, type FunctionHost } from "./hosts";

// Farm.js storage from FARMJS_API_KEY alone: a build with the key and no storage config keeps runs in
// Farm.js storage, and each built bundle runs a run across invocations against a store that keeps the
// contract (test/fakes/farmjs-store.ts). Without the key, hosts with no durable disk do not build.

const KEY = "farmjs_e2e_key";
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));

describe("Farm.js storage", () => {
  let root: string;
  let fake: FakeFarmjsStore;
  const dirs: string[] = [];
  const out = (name: string) => {
    const dir = tempDir(`farmjs-${name}`);
    dirs.push(dir);
    return dir;
  };

  // Whatever this machine has set, each build here sees the key only when it is given one.
  const saved = process.env.FARMJS_API_KEY;
  beforeAll(async () => {
    delete process.env.FARMJS_API_KEY;
    root = prepareFixture("farmjs-storage");
    fake = await startFakeFarmjsStore({ key: KEY });
  });
  afterAll(async () => {
    if (saved !== undefined) process.env.FARMJS_API_KEY = saved;
    await fake.close();
    cleanup(...dirs, join(root, ".data"));
  });

  const resume = async (call: typeof fetch, base: string, id: string) => {
    const response = await call(`${base}/runs/${id}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: { approved: true } }) });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
  };

  /** A refund that pauses for approval, answered in a later invocation, read back from the store. */
  async function refund(call: typeof fetch, base: string, orderId: string, settle: () => Promise<void> = async () => {}) {
    const client = createAgentClient({ baseUrl: base, fetch: call });
    const { id } = await client.start("refund", { orderId });
    await settle();
    expect(await waitForStatus(client, id, "interrupted")).toMatchObject({ interrupt: { name: "approve-refund" } });
    await resume(call, base, id);
    await settle();
    expect(await waitForStatus(client, id, "completed")).toMatchObject({ output: { status: "refunded", order: orderId, loads: 1, charges: 1 } });
    // In Farm.js storage, not in the invocation: the run, its journal and the app state it counted.
    const values = fake.values();
    expect(values.get(`runs:${id}`)).toMatchObject({ status: "completed" });
    expect([...values.keys()].some((key) => key.startsWith(`steps:${id}:`))).toBe(true);
    return id;
  }

  for (const host of [vercel, netlify, lambda] as FunctionHost[]) {
    it(`keeps runs in Farm.js storage on ${host.preset} with only FARMJS_API_KEY`, async () => {
      const dir = out(host.preset);
      const result = await buildFixture(root, host.preset, dir, { FARMJS_API_KEY: KEY });
      expect(result.storage).toEqual({ driver: "farmjs" });
      // The key is read where the function runs, never written into the build.
      for (const file of files(dir)) expect(readFileSync(file, "utf8"), file).not.toContain(KEY);
      const env = { ...fake.env };
      Object.assign(process.env, env);
      try {
        const module = (await import(pathToFileURL(join(dir, host.entry)).href)) as Record<string, any>;
        const pending: Promise<unknown>[] = [];
        const call = ((input: RequestInfo | URL, init?: RequestInit) => host.invoke(module, new Request(input, init), (promise) => pending.push(promise))) as typeof fetch;
        const settle = async () => {
          while (pending.length) await Promise.allSettled(pending.splice(0));
        };
        await refund(call, "https://app.example.com", `o_${host.preset}`, settle);
      } finally {
        for (const key of Object.keys(env)) delete process.env[key];
      }
    });
  }

  it("keeps runs in Farm.js storage on a Node server, across a restart, with nothing on disk", async () => {
    const dir = out("node");
    expect((await buildFixture(root, "node-server", dir, { FARMJS_API_KEY: KEY })).storage).toEqual({ driver: "farmjs" });
    const start = () => startServer(process.execPath, [join(dir, "server/index.mjs")], { cwd: root, env: fake.env });
    let server = await start();
    try {
      const client = () => createAgentClient({ baseUrl: server.url });
      const { id } = await client().start("refund", { orderId: "o_node" });
      await waitForStatus(client(), id, "interrupted");
      await server.stop();
      server = await start();
      await resume(fetch, server.url, id);
      expect(await waitForStatus(client(), id, "completed")).toMatchObject({ output: { status: "refunded", loads: 1, charges: 1 } });
      expect(fake.values().get(`runs:${id}`)).toMatchObject({ status: "completed" });
      expect(existsSync(join(root, ".data"))).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("does not build for a host without a durable disk when there is neither storage nor FARMJS_API_KEY", async () => {
    for (const preset of ["vercel", "netlify", "aws-lambda", "cloudflare-module"]) {
      await expect(buildFixture(root, preset, out(`${preset}-nokey`))).rejects.toThrow(missingStorageError(preset));
    }
  });

  it("keeps runs on disk on a Node server without the key, and says so", async () => {
    const warnings: string[] = [];
    const { build } = (await import(join(ROOT, "dist/build.mjs"))) as typeof import("../../src/build");
    const result = await build({ root, preset: "node-server", outDir: out("node-nokey"), logger: { info() {}, warn: (message) => void warnings.push(message) } });
    expect(result.storage).toMatchObject({ driver: "fs-lite", base: ".data/agent-unit" });
    expect(warnings).toContainEqual(expect.stringContaining("which a container without a volume loses on every redeploy. Add FARMJS_API_KEY (from app.farmjs.dev)"));
  });
});
