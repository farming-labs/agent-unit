import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, collect, createAgentClient, freePort, hasBinary, prepareFixture, ROOT, startServer, tempDir, type RunningServer } from "./helpers";
import { startMiniflare, vercel, workerd, writeDurableConfig } from "./hosts";

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
    root = await generate("mastra", { framework: "mastra", runner: "server", hosts: "node,cloudflare", store: "libsql", provider: "openai", extras: "task" });
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
    root = await generate("ai-sdk", { framework: "ai-sdk", runner: "server", hosts: "node,vercel", provider: "openai", extras: "auth" });
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

describe("agent-unit init: the extras", () => {
  const outs: string[] = [];
  afterAll(() => cleanup(...outs));

  /** Runs the app's own `npm test` (vitest, from agent-unit's node_modules). */
  function vitest(root: string) {
    const result = spawnSync(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--root", root], { encoding: "utf8", env: { ...process.env, CI: "1" } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  }

  it("a defineAgent app's test runs offline", async () => {
    const root = await generate("extras-agent", { framework: "agent-unit", hosts: "node", extras: "test" });
    typecheck(root);
    expect(vitest(root)).toMatch(/Tests\s+2 passed/);
  });

  it("an AI SDK server's test covers its routes with auth and background work", async () => {
    const root = await generate("extras-ai-sdk", { framework: "ai-sdk", runner: "server", hosts: "node", provider: "openai", extras: "auth,background,test" });
    typecheck(root);
    expect(vitest(root)).toMatch(/Tests\s+3 passed/);
  });

  it("a Hono server forwards feedback after it answers, from its Node build", async () => {
    const root = await generate("extras-hono", { framework: "hono", hosts: "node", extras: "background,test" });
    typecheck(root);
    expect(vitest(root)).toMatch(/Tests\s+3 passed/);

    // The webhook answers only once the test lets it: the 202 has to come first.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const received: unknown[] = [];
    const webhook = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      received.push(JSON.parse(body));
      await held;
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const out = tempDir("init-out");
    outs.push(out);
    await buildFixture(root, "node-server", out);
    const server = await startServer(process.execPath, [join(out, "server/index.mjs")], {
      cwd: root,
      env: { FEEDBACK_WEBHOOK_URL: `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/hook` },
      readyPath: "/",
    });
    try {
      const response = await fetch(`${server.url}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rating: 5 }) });
      expect(response.status).toBe(202);
      for (let i = 0; i < 100 && !received.length; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toEqual([{ rating: 5 }]);
    } finally {
      release();
      await server.stop();
      await new Promise((resolve) => webhook.close(resolve));
    }
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
    const root = await generate("mastra-pg", { framework: "mastra", runner: "server", hosts: "vercel", store: "postgres", provider: "anthropic", extras: "none" });
    typecheck(root);
    const out = tempDir("init-out");
    outs.push(out);
    await buildFixture(root, "vercel", out);
    expect(existsSync(join(out, vercel.entry))).toBe(true);
  });

  for (const provider of ["anthropic", "google"]) {
    it(`an AI SDK agent on ${provider} typechecks`, async () => {
      typecheck(await generate(`ai-sdk-${provider}`, { framework: "ai-sdk", runner: "engine", hosts: "cloudflare", provider, extras: "task,auth" }));
    });
  }
});

// Upstash's REST API in front of a real Redis: commands as JSON arrays, results base64-encoded when
// the client asks (it does by default). Generated apps keep runs in Upstash on serverless hosts.
const redisAvailable = Boolean(process.env.REDIS_URL) || hasBinary("redis-server");
if (process.env.AGENT_UNIT_REQUIRE_REDIS && !redisAvailable) throw new Error("Redis is required for this suite.");

async function startUpstash(token: string) {
  let server: ChildProcess | undefined;
  let url = process.env.REDIS_URL;
  if (!url) {
    const port = await freePort();
    server = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
    url = `redis://127.0.0.1:${port}`;
  }
  const redis = new Redis(url, { maxRetriesPerRequest: 2 });
  redis.on("error", () => {}); // refused until a fresh redis-server listens; ping retries
  await redis.ping();
  const encode = (value: unknown, base64: boolean): unknown =>
    Array.isArray(value) ? value.map((item) => encode(item, base64)) : typeof value === "string" && base64 ? Buffer.from(value).toString("base64") : value;
  const run = async (command: (string | number)[]) => {
    try {
      return { result: await redis.call(String(command[0]), ...command.slice(1).map(String)) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  };
  const http = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.headers.authorization !== `Bearer ${token}`) return void response.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
    const base64 = request.headers["upstash-encoding"] === "base64";
    const command = JSON.parse(body) as (string | number)[] | (string | number)[][];
    const reply = (value: { result?: unknown; error?: string }) => ("error" in value && value.error ? value : { result: encode(value.result, base64) });
    const result = request.url === "/" ? reply(await run(command as (string | number)[])) : await Promise.all((command as (string | number)[][]).map(async (item) => reply(await run(item))));
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    redis,
    async stop() {
      await new Promise((resolve) => http.close(resolve));
      redis.disconnect();
      server?.kill("SIGKILL");
    },
  };
}

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));

describe("agent-unit init: agents on agent-unit's engine, one config for every host", () => {
  let root: string;
  const outs: string[] = [];
  const out = () => {
    const dir = tempDir("init-out");
    outs.push(dir);
    return dir;
  };
  const headers = { authorization: "Bearer secret" };
  beforeAll(async () => {
    root = await generate("engine", { framework: "agent-unit", hosts: "node,cloudflare,vercel", extras: "auth" });
  });
  afterAll(() => cleanup(...outs));

  /** Starts a refund, which pauses for approval, then approves it: the run finishes after the resume. */
  async function refund(baseUrl: string, fetchImpl?: typeof fetch) {
    const client = createAgentClient({ baseUrl, headers, fetch: fetchImpl });
    const first = await collect(client.run("refund", { orderId: "o_42" }));
    expect(first.at(-1)).toMatchObject({ type: "RUN_INTERRUPTED", interrupt: { name: "approve-refund", payload: { id: "o_42", amount: 42 } } });
    const second = await collect(client.resume(first[0]!.runId, { approved: true }));
    expect(second.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: "refunded o_42" });
    return first[0]!.runId;
  }

  it("typechecks", () => typecheck(root));

  it("keeps runs on disk on Node, behind the token", async () => {
    const dir = out();
    expect(await buildFixture(root, "node-server", dir)).toMatchObject({ runtime: "default", storage: { driver: "fs-lite" } });
    const server = await startServer(process.execPath, [join(dir, "server/index.mjs")], { cwd: dir, env: { API_TOKEN: "secret" } });
    try {
      expect((await fetch(`${server.url}/agents`)).status).toBe(401);
      await refund(server.url);
    } finally {
      await server.stop();
    }
  });

  it.skipIf(!workerd)("gives every run its own Durable Object on Workers", async () => {
    const dir = out();
    expect(await buildFixture(root, "cloudflare-module", dir)).toMatchObject({ runtime: "durable-objects" });
    const disk = join(dir, "disk");
    mkdirSync(disk, { recursive: true });
    const port = await freePort();
    const { config } = writeDurableConfig(dir, disk, port, { API_TOKEN: "secret" });
    const server = await startServer(workerd!, ["serve", config], { cwd: dir, port });
    try {
      await refund(server.url);
    } finally {
      await server.stop();
    }
  });

  it.skipIf(!redisAvailable)("keeps runs in Upstash on Vercel, with no credentials in the build", async () => {
    const upstash = await startUpstash("upstash-token");
    const dir = out();
    const env = { UPSTASH_REDIS_REST_URL: upstash.url, UPSTASH_REDIS_REST_TOKEN: "upstash-token", API_TOKEN: "secret" };
    try {
      // Built with the variables set, as on Vercel: they still must not end up in the output.
      expect(await buildFixture(root, "vercel", dir, env)).toMatchObject({ storage: { driver: "upstash" } });
      for (const file of files(dir)) expect(readFileSync(file, "utf8"), file).not.toContain("upstash-token");
      Object.assign(process.env, env);
      const module = (await import(pathToFileURL(join(dir, vercel.entry)).href)) as Record<string, any>;
      const pending: Promise<unknown>[] = [];
      const runId = await refund("https://app.example.com", async (input, init) => {
        const response = await vercel.invoke(module, new Request(input, init), (promise) => pending.push(promise));
        await Promise.all(pending.splice(0));
        return response;
      });
      expect(await upstash.redis.keys(`*${runId}*`)).not.toEqual([]);
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
      await upstash.stop();
    }
  });

  for (const framework of ["ai-sdk", "mastra", "langgraph", "openai-agents"] as const) {
    it(`serves its ${framework} agent on Node and on Workers`, async () => {
      const app = await generate(`engine-${framework}`, { framework, runner: "engine", hosts: "node,cloudflare,lambda", provider: "openai", extras: "none" });
      typecheck(app);
      const check = async (url: string) => {
        const { agents } = await createAgentClient({ baseUrl: url }).manifest();
        expect(agents).toEqual([expect.objectContaining({ name: "assistant", framework })]);
        // Mastra's adapter does not list tools, which Mastra can resolve per request.
        if (framework !== "mastra") expect(agents[0]!.tools).toEqual([expect.objectContaining({ name: "refund" })]);
      };
      const node = out();
      await buildFixture(app, "node-server", node);
      const server = await startServer(process.execPath, [join(node, "server/index.mjs")], { cwd: node, env: { OPENAI_API_KEY: "sk-test" } });
      try {
        await check(server.url);
      } finally {
        await server.stop();
      }
      if (!workerd) return;
      // The SDK loads in a Worker: one module it imports that Workers lack would stop it starting.
      const worker = out();
      await buildFixture(app, "cloudflare-module", worker);
      const disk = join(worker, "disk");
      mkdirSync(disk, { recursive: true });
      const port = await freePort();
      const { config } = writeDurableConfig(worker, disk, port, { OPENAI_API_KEY: "sk-test" });
      const served = await startServer(workerd, ["serve", config], { cwd: worker, port });
      try {
        await check(served.url);
      } finally {
        await served.stop();
      }
    });
  }

  for (const provider of ["anthropic", "google"]) {
    it(`a LangGraph agent on ${provider} typechecks`, async () => {
      typecheck(await generate(`langgraph-${provider}`, { framework: "langgraph", hosts: "node", provider, extras: "none" }));
    });
  }
});

describe("agent-unit init in an app that is already there", () => {
  const outs: string[] = [];
  afterAll(() => cleanup(...outs));

  /** An app written by hand, then `agent-unit init` in it with the defaults. */
  async function existing(name: string, files: Record<string, string>, options: Omit<InitOptions, "dir" | "version" | "install"> = {}) {
    prepareFixture("server");
    const { init } = (await import(join(ROOT, "dist/build.mjs"))) as typeof import("../../src/build");
    const root = join(GENERATED, name);
    cleanup(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const result = await init({ yes: true, hosts: "node", ...options, dir: root, install: false, version: "0.0.0", logger: { info() {}, warn() {} } });
    expect(result.existing).toBe(true);
    const link = join(root, "node_modules/agent-unit");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(ROOT, link, process.platform === "win32" ? "junction" : "dir");
    return root;
  }

  it("builds the app's own Hono server", async () => {
    const root = await existing("existing-hono", {
      "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { build: "tsc" }, dependencies: { hono: "^4.0.0" } }),
      "src/server.ts": `import { Hono } from "hono";\n\nexport default new Hono().get("/", (c) => c.json({ shop: "open" }));\n`,
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, noEmit: true }, include: ["src", "agent-unit.config.ts"] }),
    });
    typecheck(root);
    const out = tempDir("init-out");
    outs.push(out);
    await buildFixture(root, "node-server", out);
    const server = await startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: root, readyPath: "/" });
    try {
      expect(await (await fetch(server.url)).json()).toEqual({ shop: "open" });
    } finally {
      await server.stop();
    }
  });

  it("serves an existing Mastra instance, on its own storage", async () => {
    const root = await existing("existing-mastra", {
      "package.json": JSON.stringify({ name: "desk", type: "module", dependencies: { "@mastra/core": "^1.74.0" } }),
      "src/mastra/index.ts": `import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";

export const mastra = new Mastra({
  agents: { helper: new Agent({ id: "helper", name: "Helper", instructions: "Help.", model: "openai/gpt-5-mini" }) },
});
`,
    });
    expect(readdirSync(join(root, "src"))).toEqual(["mastra"]);
    const out = tempDir("init-out");
    outs.push(out);
    await buildFixture(root, "node-server", out);
    const server = await startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: root, readyPath: "/health" });
    try {
      expect(await (await fetch(`${server.url}/api/agents`)).json()).toHaveProperty("helper");
    } finally {
      await server.stop();
    }
  });
});

