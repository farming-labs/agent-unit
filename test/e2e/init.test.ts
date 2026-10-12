import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, prepareFixture, ROOT, startServer, tempDir, type RunningServer } from "./helpers";
import { startMiniflare, vercel } from "./hosts";

// Apps written by `agent-unit init`, as a new user gets them: each typechecks against the real SDKs,
// builds for its hosts and answers there. They are generated inside the repo so they resolve the
// SDKs agent-unit is tested with; CI does not install them from npm.

const GENERATED = join(ROOT, "test/e2e/.init");

type InitOptions = Parameters<typeof import("../../src/build/init").init>[0];

async function generate(name: string, options: Omit<InitOptions, "dir" | "version" | "install">): Promise<string> {
  prepareFixture("server"); // builds agent-unit once if dist/ is missing
  const { init } = (await import(join(ROOT, "dist/build.mjs"))) as typeof import("../../src/build");
  const root = join(GENERATED, name);
  cleanup(root);
  await init({ ...options, dir: root, install: false, version: "0.0.0", logger: { info() {}, warn() {} } });
  const link = join(root, "node_modules/agent-unit");
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(ROOT, link, process.platform === "win32" ? "junction" : "dir");
  return root;
}

function typecheck(root: string) {
  const result = spawnSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", root], { encoding: "utf8" });
  expect(result.stdout + result.stderr, "tsc output").toBe("");
  expect(result.status).toBe(0);
}

afterAll(() => cleanup(GENERATED));

describe("agent-unit init: a Mastra app for Node and Workers", () => {
  let root: string;
  const outs: string[] = [];
  beforeAll(async () => {
    root = await generate("mastra", { framework: "mastra", hosts: "node,cloudflare", store: "libsql", provider: "openai", extras: "task" });
  });
  afterAll(() => cleanup(...outs));

  it("typechecks against Mastra's packages", () => typecheck(root));

  it("serves Mastra's own routes on Node, on its LibSQL store", async () => {
    const out = tempDir("init-out");
    outs.push(out);
    await buildFixture(root, "node-server", out);
    const data = tempDir("init-data");
    outs.push(data);
    const server: RunningServer = await startServer(process.execPath, [join(out, "server/index.mjs")], {
      cwd: root,
      env: { MASTRA_DB_URL: `file:${join(data, "mastra.db")}` },
      readyPath: "/health",
    });
    try {
      const agents = (await (await fetch(`${server.url}/api/agents`)).json()) as Record<string, { name: string; tools: Record<string, unknown> }>;
      expect(agents.assistant).toMatchObject({ name: "Assistant" });
      expect(Object.keys(agents.assistant!.tools)).toContain("clock");
    } finally {
      await server.stop();
    }
  });

  it("serves them on Workers, on D1, with the daily task as a Cron Trigger", async () => {
    const out = tempDir("init-out");
    outs.push(out);
    await buildFixture(root, "cloudflare-module", out);
    const worker = await startMiniflare(out, out);
    try {
      expect(worker.wrangler.d1_databases).toEqual([expect.objectContaining({ binding: "DB" })]);
      expect(worker.wrangler.triggers?.crons).toEqual(["0 8 * * *"]);
      const agents = (await (await worker.fetch("/api/agents")).json()) as Record<string, unknown>;
      expect(agents).toHaveProperty("assistant");
      expect((await worker.scheduled("0 8 * * *")).status).toBe(200);
    } finally {
      await worker.stop();
    }
  });
});

describe("agent-unit init: an AI SDK agent on Hono for Node and Vercel", () => {
  let root: string;
  const outs: string[] = [];
  beforeAll(async () => {
    root = await generate("ai-sdk", { framework: "ai-sdk", hosts: "node,vercel", provider: "openai", extras: "auth" });
  });
  afterAll(() => cleanup(...outs));

  it("typechecks against the AI SDK", () => typecheck(root));

  it("answers on Node, and the agent route needs the token", async () => {
    const out = tempDir("init-out");
    outs.push(out);
    await buildFixture(root, "node-server", out);
    const server = await startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: root, env: { API_TOKEN: "secret" }, readyPath: "/" });
    try {
      const chat = (headers: Record<string, string>) =>
        fetch(`${server.url}/chat`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ prompt: "hi" }) });
      expect((await chat({})).status).toBe(401);
      expect((await chat({ authorization: "Bearer wrong" })).status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  it("answers as a Vercel function", async () => {
    const out = tempDir("init-out");
    outs.push(out);
    await buildFixture(root, "vercel", out);
    const module = (await import(pathToFileURL(join(out, vercel.entry)).href)) as Record<string, any>;
    const response = await vercel.invoke(module, new Request("https://app.example.com/"), () => {});
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("agent-unit init: the other choices", () => {
  const outs: string[] = [];
  afterAll(() => cleanup(...outs));

  it("a plain Hono server answers on Node", async () => {
    const root = await generate("hono", { framework: "hono", hosts: "node", extras: "none" });
    typecheck(root);
    const out = tempDir("init-out");
    outs.push(out);
    await buildFixture(root, "node-server", out);
    const server = await startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: root, env: { GREETING: "hey" }, readyPath: "/" });
    try {
      expect(await (await fetch(`${server.url}/hello`)).json()).toEqual({ hello: "hey" });
    } finally {
      await server.stop();
    }
  });

  it("a Mastra app on Postgres builds for Vercel", async () => {
    const root = await generate("mastra-pg", { framework: "mastra", hosts: "vercel", store: "postgres", provider: "anthropic", extras: "none" });
    typecheck(root);
    const out = tempDir("init-out");
    outs.push(out);
    await buildFixture(root, "vercel", out);
    expect(existsSync(join(out, vercel.entry))).toBe(true);
  });

  for (const provider of ["anthropic", "google"]) {
    it(`an AI SDK app on ${provider} typechecks`, async () => {
      typecheck(await generate(`ai-sdk-${provider}`, { framework: "ai-sdk", hosts: "cloudflare", provider, extras: "task,auth" }));
    });
  }
});
