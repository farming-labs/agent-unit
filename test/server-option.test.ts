import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDev, type DevServer } from "../src/build/dev";
import { loadProject } from "../src/build/load";
import { build } from "../src/build/nitro";
import { mastra } from "../src/presets/mastra";

// `server`: the app brings its own server and agent-unit only builds and serves it.

const dirs: string[] = [];
const servers: DevServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function app(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "agent-unit-server-option-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "own-server", type: "module" }));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const quiet = { info() {}, warn() {}, error() {} };

describe("the server option", () => {
  it("needs no agents, and rejects engine settings that would be ignored", async () => {
    const own = await loadProject(app({ "agent-unit.config.mjs": `export default { server: "./server.mjs" };` }));
    expect(own.config.server).toBe("./server.mjs");
    expect(own.agentFiles).toEqual({});

    await expect(
      loadProject(app({ "agent-unit.config.mjs": `export default { server: "./server.mjs", storage: { driver: "memory" }, retention: "7d" };` })),
    ).rejects.toThrow(/`storage`, `retention` configure agent-unit's engine, which does not run when `server` is set/);
    await expect(loadProject(app({ "agent-unit.config.mjs": `export default { server: 42 };` }))).rejects.toThrow(/`server` must be the path of your server file/);
    await expect(loadProject(app({}))).rejects.toThrow(/or set `server` to your own server file/);
  });

  it("fails the build clearly when the server file is missing", async () => {
    const root = app({ "agent-unit.config.mjs": `export default { server: "./src/server.ts" };` });
    await expect(build({ root, logger: quiet })).rejects.toThrow(/the server file "\.\/src\/server\.ts" does not exist/);
  });

  // TypeScript, as most servers are: jiti compiles it fresh on every reload. (Plain .js/.mjs files go
  // through Node's own import, which caches them until the process restarts.)
  it("serves an app's own server in dev, an object with fetch or a plain function, and reloads it", async () => {
    const object = app({
      "agent-unit.config.mjs": `export default { server: "./server.ts" };`,
      "server.ts": `export default { fetch: (request, env, ctx) => Response.json({ path: new URL(request.url).pathname, waitUntil: typeof ctx.waitUntil }) };`,
    });
    const dev = await startDev({ root: object, port: 0, watch: false, logger: quiet });
    servers.push(dev);
    expect(dev.server).toBe("./server.ts");
    expect(() => dev.unit()).toThrow(/brings its own `server`/);
    expect(await (await fetch(new URL("/orders/1", dev.url))).json()).toEqual({ path: "/orders/1", waitUntil: "function" });

    writeFileSync(join(object, "server.ts"), `export default (request: Request) => new Response("reloaded " + request.method);`);
    await dev.reload();
    expect(await (await fetch(dev.url, { method: "POST" })).text()).toBe("reloaded POST");

    writeFileSync(join(object, "server.ts"), `export default { nope: true };`);
    await dev.reload();
    // A broken edit keeps the last working server.
    expect(await (await fetch(dev.url)).text()).toBe("reloaded GET");
  });

  it("reads the app's .env in dev, without overriding variables already set", async () => {
    const root = app({
      "agent-unit.config.mjs": `export default { server: "./server.ts" };`,
      "server.ts": `export default () => Response.json({ key: process.env.INIT_TEST_KEY, set: process.env.INIT_TEST_SET });`,
      ".env": `# from agent-unit init\nINIT_TEST_KEY="from .env"\nINIT_TEST_SET=from .env\n`,
    });
    process.env.INIT_TEST_SET = "from the shell";
    try {
      const dev = await startDev({ root, port: 0, watch: false, logger: quiet });
      servers.push(dev);
      expect(await (await fetch(dev.url)).json()).toEqual({ key: "from .env", set: "from the shell" });
    } finally {
      delete process.env.INIT_TEST_KEY;
      delete process.env.INIT_TEST_SET;
    }
  });

  it("accepts a framework preset: a plain object that writes the server module", async () => {
    const root = app({
      "agent-unit.config.mjs": `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default {
  server: {
    name: "tiny-framework",
    entry({ genDir, preset }) {
      const file = join(genDir, "tiny-server.mjs");
      writeFileSync(file, \`export default { fetch: () => new Response("tiny on \${preset}") };\`);
      return file;
    },
  },
};`,
    });
    const dev = await startDev({ root, port: 0, watch: false, logger: quiet });
    servers.push(dev);
    expect(dev.server).toBe("tiny-framework");
    expect(await (await fetch(dev.url)).text()).toBe("tiny on dev");

    const broken = app({ "agent-unit.config.mjs": `export default { server: { name: "broken", entry: () => "/nowhere/server.mjs" } };` });
    await expect(build({ root: broken, logger: quiet })).rejects.toThrow(/the broken preset returned "\/nowhere\/server\.mjs", which does not exist/);
    await expect(loadProject(app({ "agent-unit.config.mjs": `export default { server: { name: "half" } };` }))).rejects.toThrow(/or a framework preset such as mastra\(\)/);
  });

  it("builds a Mastra app as Mastra's own server without any config", async () => {
    const mastraApp = (files: Record<string, string> = {}) => {
      const root = app(files);
      mkdirSync(join(root, "src/mastra"), { recursive: true });
      writeFileSync(join(root, "src/mastra/index.ts"), `export const mastra = {};`);
      return root;
    };
    const found = await loadProject(mastraApp());
    expect(typeof found.config.server === "object" && found.config.server.name).toBe("mastra");
    // Engine settings mean the app wanted the engine: say so instead of choosing for it.
    await expect(loadProject(mastraApp({ "agent-unit.config.mjs": `export default { storage: { driver: "memory" } };` }))).rejects.toThrow(
      /looks like a Mastra app\. agent-unit builds Mastra's own server on its own unless the config sets agent-unit's engine settings \(`storage`\)/,
    );
    // Agents in agents\/ keep using the engine.
    const both = mastraApp({ "agent-unit.config.mjs": "export default {};" });
    mkdirSync(join(both, "agents"));
    writeFileSync(join(both, "agents/greeter.mjs"), "export default { run: () => 'hi' };");
    expect((await loadProject(both)).config.server).toBeUndefined();
  });

  it("leaves the TypeScript compiler out of Mastra's Workers builds only, and keeps its deployer stand-ins everywhere", () => {
    const root = app({ "mastra.ts": "export const mastra = {};" });
    for (const pkg of ["@mastra/hono", "hono"]) {
      mkdirSync(join(root, "node_modules", pkg), { recursive: true });
      writeFileSync(join(root, "node_modules", pkg, "package.json"), "{}");
    }
    mkdirSync(join(root, ".agent-unit")); // the build creates it before calling the preset
    const entry = (preset: string) => mastra({ entry: "./mastra.ts" }).entry({ root, genDir: join(root, ".agent-unit"), preset }) as { alias: Record<string, string> };
    const workers = entry("cloudflare-module").alias;
    expect(workers.typescript).toBe(join(root, ".agent-unit/typescript.mjs"));
    expect(readFileSync(workers.typescript!, "utf8")).toContain("leaves the TypeScript compiler out of Workers builds");
    expect(workers["@mastra/deployer-cloudflare"]).toBeDefined();
    expect(entry("vercel").alias).not.toHaveProperty("typescript");
    expect(entry("node-server").alias).not.toHaveProperty("typescript");
  });

  it("explains what the Mastra preset needs", () => {
    const context = (root: string) => ({ root, genDir: join(root, ".agent-unit"), preset: "node-server" });
    const empty = app({});
    expect(() => mastra().entry(context(empty))).toThrow(/could not find your Mastra instance \(src\/mastra\/index\.ts\)\. Pass its file: mastra\(\{ entry/);
    const withInstance = app({ "agents.ts": "export const mastra = {};" });
    expect(() => mastra({ entry: "./agents.ts" }).entry(context(withInstance))).toThrow(/Install @mastra\/hono and hono: npm install @mastra\/hono hono/);
  });
});

describe("agent-unit dev with a framework's agent", () => {
  it("runs an AI SDK agent exported as the default, as the build does", async () => {
    const dev = await startDev({ root: join(import.meta.dirname, "fixtures/dev-ai-sdk"), port: 0, watch: false, logger: quiet });
    try {
      const response = await fetch(`${dev.url}agents/assistant/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ input: { prompt: "hi" } }),
      });
      const events = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as { type: string; result?: unknown; message?: string });
      expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: "hello from dev" });
    } finally {
      await dev.close();
    }
  });
});

