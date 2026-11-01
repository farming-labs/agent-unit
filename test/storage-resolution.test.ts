import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentUnitConfig } from "../src/config";
import { DEFAULT_STORAGE, missingStorageError, prepareEngine, resolveStorage } from "../src/build/engine";
import { createEngineApp } from "../src/build/engine-dev";
import { configForPreset, loadProject, type LoadedProject } from "../src/build/load";
import { agentUnit } from "../src/nitro";

// Where runs are kept when the config does not say: Farm.js storage with FARMJS_API_KEY, the disk on
// servers, and a build error on hosts without a durable disk. The config's own choice always wins.

const KEY = { FARMJS_API_KEY: "farmjs_build_key" };
const SERVERS = ["node-server", "bun", "deno-server"];
const NO_DISK = ["vercel", "netlify", "aws-lambda", "cloudflare-module"];

const project = (config: AgentUnitConfig, preset = "node-server"): LoadedProject => ({
  root: "/app",
  name: "app",
  config: configForPreset(config, preset),
  agentFiles: {},
});

function resolve(config: AgentUnitConfig, preset: string, env: Record<string, string> = {}, dev = false) {
  const warnings: string[] = [];
  const storage = resolveStorage(project(config, preset), preset, (message) => warnings.push(message), { env, dev });
  return { storage, warnings };
}

describe("storage resolution", () => {
  it("keeps runs on this machine's disk in dev, with no Farm.js calls, whatever the key", () => {
    for (const env of [{}, KEY]) {
      expect(resolve({}, "dev", env, true)).toEqual({ storage: DEFAULT_STORAGE, warnings: [] });
      expect(resolve({ storage: "farmjs" }, "dev", env, true)).toEqual({ storage: DEFAULT_STORAGE, warnings: [] });
      // Nitro's prerenderer runs during the build, on the build machine.
      expect(resolve({}, "nitro-prerender", env)).toEqual({ storage: DEFAULT_STORAGE, warnings: [] });
    }
    // A driver or memory, chosen on purpose, is still what dev uses.
    expect(resolve({ storage: "memory" }, "dev", KEY, true).storage).toEqual({ driver: "memory" });
    expect(resolve({ storage: { driver: "redis", url: "redis://x" } }, "dev", KEY, true).storage).toEqual({ driver: "redis", url: "redis://x" });
  });

  it("uses Farm.js storage on every host when the build has FARMJS_API_KEY", () => {
    for (const preset of [...SERVERS, ...NO_DISK]) expect(resolve({}, preset, KEY)).toEqual({ storage: { driver: "farmjs" }, warnings: [] });
  });

  it("keeps runs on disk on servers without the key, and says what a container loses", () => {
    for (const preset of SERVERS) {
      const { storage, warnings } = resolve({}, preset);
      expect(storage).toEqual(DEFAULT_STORAGE);
      expect(warnings).toEqual([
        "agent-unit: runs are kept on disk in .data/agent-unit, which a container without a volume loses on every redeploy. Add FARMJS_API_KEY (from app.farmjs.dev) to the build's environment to keep them in Farm.js storage, or set `storage`.",
      ]);
    }
  });

  it("stops the build on hosts without a durable disk, listing every way to give runs storage", () => {
    for (const preset of NO_DISK) expect(() => resolve({}, preset)).toThrow(missingStorageError(preset));
    expect(missingStorageError("vercel")).toBe(
      [
        "agent-unit: runs on vercel need storage that outlives a request, and none is set. Either:",
        `  - add FARMJS_API_KEY (from app.farmjs.dev) to the build's environment to use Farm.js storage, or set storage: "farmjs"`,
        `  - set storage, e.g. { driver: "upstash" } or { driver: "redis", url: process.env.REDIS_URL }`,
        "  - set it per target: presets: { vercel: { storage: { ... } } }",
        `  - or storage: "memory" if runs may be lost between requests`,
      ].join("\n"),
    );
    expect(missingStorageError("aws-lambda")).toContain(`presets: { "aws-lambda": { storage: { ... } } }`);
    expect(missingStorageError("netlify")).toContain("runs on netlify need storage");
    // On Workers, the Durable Objects runtime is one more way.
    const workers = missingStorageError("cloudflare-module");
    expect(workers).toContain(`presets: { "cloudflare-module": { storage: { ... } } }`);
    expect(workers).toContain(`  - use runtime: "durable-objects", which keeps each run in its own Durable Object`);
    expect(missingStorageError("vercel")).not.toContain("durable-objects");
  });

  it("lets an explicit choice win, with or without the key", () => {
    for (const preset of [...SERVERS, ...NO_DISK]) {
      for (const env of [{}, KEY]) {
        expect(resolve({ storage: "farmjs" }, preset, env)).toEqual({ storage: { driver: "farmjs" }, warnings: [] });
        expect(resolve({ storage: "memory" }, preset, env)).toEqual({ storage: { driver: "memory" }, warnings: [] });
        expect(resolve({ storage: { driver: "upstash" } }, preset, env)).toEqual({ storage: { driver: "upstash" }, warnings: [] });
        expect(resolve({ storage: { driver: "fs-lite", base: ".runs" } }, preset, env).storage).toEqual({ driver: "fs-lite", base: ".runs", atomic: true });
      }
    }
    expect(() => resolve({ storage: "redis" as never }, "vercel")).toThrow(`storage is "farmjs", "memory" or an unstorage driver such as { driver: "redis", url: process.env.REDIS_URL }, not "redis"`);
  });

  it("takes each target's own storage from presets", () => {
    const config: AgentUnitConfig = { presets: { vercel: { storage: "memory" }, netlify: { storage: "farmjs" }, "node-server": { storage: { driver: "redis" } } } };
    expect(resolve(config, "vercel").storage).toEqual({ driver: "memory" });
    expect(resolve(config, "netlify").storage).toEqual({ driver: "farmjs" });
    expect(resolve(config, "node-server").storage).toEqual({ driver: "redis" });
    expect(resolve(config, "bun").warnings).toHaveLength(1);
    expect(() => resolve(config, "aws-lambda")).toThrow("runs on aws-lambda need storage");
    expect(resolve(config, "aws-lambda", KEY).storage).toEqual({ driver: "farmjs" });
    // A preset's storage replaces the top-level one whole, a string as well as a driver.
    expect(resolve({ storage: { driver: "redis" }, presets: { vercel: { storage: "farmjs" } } }, "vercel").storage).toEqual({ driver: "farmjs" });
  });
});

const dirs: string[] = [];
const saved = process.env.FARMJS_API_KEY;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.FARMJS_API_KEY;
  else process.env.FARMJS_API_KEY = saved;
});

function app(config: string) {
  const dir = mkdtempSync(join(tmpdir(), "agent-unit-storage-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "storage-app", type: "module" }));
  writeFileSync(join(dir, "agent-unit.config.mjs"), `export default ${config};`);
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "agents/greeter.mjs"), `export default { [Symbol.for("agent-unit.agent")]: true, run: async () => "hi" };`);
  return dir;
}

describe("the generated server's storage", () => {
  async function nitroRuntime(root: string, preset: string, dev = false) {
    const options = { preset, dev, rootDir: root, buildDir: join(root, ".nitro"), storage: {}, handlers: [], experimental: {}, tasks: {}, scheduledTasks: {} };
    await agentUnit().setup!({ options, logger: { warn() {} } } as never);
    return readFileSync(join(root, ".nitro/agent-unit", preset, "runtime.mjs"), "utf8");
  }

  it("keeps runs in Farm.js storage when the build has the key, with no unstorage mount", async () => {
    process.env.FARMJS_API_KEY = KEY.FARMJS_API_KEY;
    const runtime = await nitroRuntime(app(`{}`), "vercel");
    expect(runtime).toContain(`const storage = "farmjs";`);
    expect(runtime).not.toContain("storageDriver");
    expect(runtime).not.toContain(KEY.FARMJS_API_KEY);
    // A config that chooses other storage where the server runs is still caught there.
    expect(runtime).toContain(`?? {"driver":"farmjs"};`);
    expect(runtime).toContain(`if (storageConfig?.driver !== "farmjs")`);
  });

  it("checks where it runs that the config still chooses Farm.js storage, or memory", async () => {
    const farmjs = await nitroRuntime(app(`{ storage: "farmjs" }`), "netlify");
    expect(farmjs).toContain(`const storageConfig = (typeof settings.storage === "string" ? { driver: settings.storage } : settings.storage) ?? undefined;`);
    expect(farmjs).toContain(`if (storageConfig?.driver !== "farmjs")`);
    expect(farmjs).toContain(`const storage = "farmjs";`);
    const memory = await nitroRuntime(app(`{ presets: { vercel: { storage: "memory" } } }`), "vercel");
    expect(memory).toMatch(/import storageDriver from ".*unstorage\/dist\/drivers\/memory\.mjs";/);
    expect(memory).toContain(`if (storageConfig?.driver !== "memory")`);
  });

  it("keeps runs on disk under nitro dev even when the config chooses Farm.js storage", async () => {
    process.env.FARMJS_API_KEY = KEY.FARMJS_API_KEY;
    const runtime = await nitroRuntime(app(`{ storage: "farmjs" }`), "nitro-dev", true);
    expect(runtime).toMatch(/drivers\/fs-lite\.mjs";/);
    expect(runtime).toContain(`const storageConfig = {"driver":"fs-lite","base":".data/agent-unit","atomic":true};`);
    expect(runtime).not.toContain(`"farmjs"`);
  });

  it("stops the Nitro module's production build without storage on a host with no disk", async () => {
    delete process.env.FARMJS_API_KEY;
    await expect(nitroRuntime(app(`{}`), "netlify")).rejects.toThrow(missingStorageError("netlify"));
  });

  it("leaves the Durable Objects runtime alone", async () => {
    delete process.env.FARMJS_API_KEY;
    const root = app(`{ runtime: "durable-objects" }`);
    const loaded = await loadProject(root);
    const engine = prepareEngine(loaded, "cloudflare-module", join(root, ".agent-unit/cloudflare-module"), () => {});
    expect(engine.storage).toEqual({ driver: "durable-objects" });
  });

  it("serves `agent-unit dev` from disk when the config chooses Farm.js storage", async () => {
    process.env.FARMJS_API_KEY = KEY.FARMJS_API_KEY;
    const dev = await createEngineApp(await loadProject(app(`{ storage: "farmjs" }`)));
    try {
      expect(dev.storage).toEqual(DEFAULT_STORAGE);
      expect(dev.unit!.engine.options.retentionMs).toBeUndefined();
    } finally {
      dev.close();
    }
  });
});
