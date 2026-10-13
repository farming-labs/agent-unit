import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configForPreset, loadProject } from "../src/build/load";
import { resolvePreset } from "../src/build/nitro";
import { agentUnit } from "../src/nitro";

// `presets`: settings for one Nitro preset over the top-level ones.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function app(config: string, files: Record<string, string> = { "agents/greeter.mjs": `export default { run: () => "hi" };` }) {
  const dir = mkdtempSync(join(tmpdir(), "agent-unit-presets-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "presets-app", type: "module" }));
  writeFileSync(join(dir, "agent-unit.config.mjs"), `export default ${config};`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe("per-preset settings", () => {
  const config = {
    storage: { driver: "fs-lite", base: ".data" },
    retention: "30d",
    presets: {
      cloudflare_module: { runtime: "durable-objects" as const },
      vercel: { storage: { driver: "upstash" } },
    },
  };

  it("puts the preset's entry over the top level, each setting replacing the top-level value whole", () => {
    expect(configForPreset(config, "vercel")).toMatchObject({ storage: { driver: "upstash" }, retention: "30d" });
    expect(configForPreset(config, "vercel").storage).not.toHaveProperty("base");
    expect(configForPreset(config, "cloudflare-module")).toMatchObject({ runtime: "durable-objects", storage: { driver: "fs-lite" } });
    expect(configForPreset(config, "node-server")).toBe(config);
  });

  it("builds for presets in Nitro's spelling", () => {
    expect(resolvePreset({ config: {} }, "cloudflare_module")).toBe("cloudflare-module");
    expect(resolvePreset({ config: { preset: "aws_lambda" } })).toBe("aws-lambda");
  });

  it("accepts settings that can differ per preset, for agents and for an app's own server", async () => {
    const engine = await loadProject(app(`{ presets: { "cloudflare-module": { runtime: "durable-objects", sweep: false }, vercel: { storage: { driver: "memory" } } } }`));
    expect(Object.keys(engine.config.presets!)).toEqual(["cloudflare-module", "vercel"]);
    const own = await loadProject(
      app(`{ server: "./server.mjs", presets: { "cloudflare-module": { tasks: { digest: { schedule: "0 8 * * *", handler: "./digest.mjs" } } } } }`, { "server.mjs": "" }),
    );
    expect(configForPreset(own.config, "cloudflare-module").tasks).toHaveProperty("digest");
    expect(configForPreset(own.config, "node-server").tasks).toBeUndefined();
  });

  it("refuses settings that cannot differ per preset, malformed entries and one preset named twice", async () => {
    await expect(loadProject(app(`{ presets: { vercel: { agentsDir: "./other" } } }`))).rejects.toThrow(
      /`agentsDir` in `presets\["vercel"\]` cannot differ per preset\. Settings that can: storage, runtime/,
    );
    await expect(loadProject(app(`{ presets: [] }`))).rejects.toThrow(/`presets` maps preset names to settings/);
    await expect(loadProject(app(`{ presets: { vercel: true } }`))).rejects.toThrow(/`presets\["vercel"\]` must be an object of settings/);
    await expect(loadProject(app(`{ presets: { cloudflare_module: {}, "cloudflare-module": {} } }`))).rejects.toThrow(
      /names "cloudflare_module" and "cloudflare-module", which are the same preset/,
    );
  });

  it("refuses engine settings for a preset when the app brings its own server", async () => {
    await expect(loadProject(app(`{ server: "./server.mjs", presets: { vercel: { storage: { driver: "memory" } } } }`, { "server.mjs": "" }))).rejects.toThrow(
      /`presets\["vercel"\]\.storage` configure agent-unit's engine, which does not run when `server` is set/,
    );
  });
});

describe("per-preset settings in the agent-unit/nitro module", () => {
  async function setup(root: string, preset: string, dev = false, storage: Record<string, unknown> = {}) {
    const options = { preset, dev, rootDir: root, buildDir: join(root, ".nitro"), storage, handlers: [], experimental: {}, tasks: {}, scheduledTasks: {} };
    const warnings: string[] = [];
    await agentUnit().setup!({ options, logger: { warn: (message: string) => warnings.push(message) } } as never);
    const runtime = readFileSync(join(root, ".nitro/agent-unit", preset, "runtime.mjs"), "utf8");
    return { options: options as typeof options & { scheduledTasks: Record<string, unknown>; tasks: Record<string, unknown> }, runtime, warnings };
  }

  it("keeps runs on disk under nitro dev when the config sets no storage, without a warning", async () => {
    const { runtime, warnings } = await setup(app(`{}`), "nitro-dev", true);
    expect(runtime).toContain(`"driver":"fs-lite"`);
    expect(warnings).toEqual([]);
  });

  it("runs the app's tasks beside the sweep, refuses the Durable Objects runtime, and points Workers and Nitro settings at nitro.config", async () => {
    const root = app(`{ tasks: { digest: { schedule: "0 8 * * *", handler: "./digest.mjs" } }, cloudflare: { wrangler: {} } }`, {
      "agents/greeter.mjs": `export default { run: () => "hi" };`,
      "digest.mjs": "export default async () => {};",
    });
    const { options, warnings } = await setup(root, "node-server");
    expect(Object.keys(options.tasks).sort()).toEqual(["agent-unit:sweep", "digest"]);
    expect(options.scheduledTasks).toMatchObject({ "0 8 * * *": ["digest"], "* * * * *": ["agent-unit:sweep"] });
    expect(warnings).toEqual(["agent-unit: `cloudflare` in agent-unit.config.ts do not apply with the agent-unit/nitro module: set them in your nitro.config."]);
    await expect(setup(app(`{ presets: { "cloudflare-module": { runtime: "durable-objects" } } }`), "cloudflare-module")).rejects.toThrow(
      `runtime "durable-objects" is built by \`agent-unit build\`, not by the agent-unit/nitro module`,
    );
  });

  it("uses the entry for the app's Nitro preset, and the top-level settings in dev", async () => {
    const root = app(`{ storage: { driver: "fs-lite", base: ".data" }, presets: { vercel: { storage: { driver: "memory" }, sweep: "*/5 * * * *" } } }`);
    const vercel = await setup(root, "vercel");
    // The runtime mounts the storage the config chooses where it runs, with that preset's entry over it.
    expect(vercel.runtime).toMatch(/import storageDriver from ".*unstorage\/dist\/drivers\/memory\.mjs";/);
    expect(vercel.runtime).toContain(`const settings = { ...config, ...config.presets?.["vercel"] };`);
    expect(vercel.options.storage).toEqual({});
    expect(vercel.options.scheduledTasks).toEqual({ "*/5 * * * *": ["agent-unit:sweep"] });
    expect((await setup(root, "node-server")).runtime).toMatch(/drivers\/fs-lite\.mjs";[\s\S]*const settings = config;/);
    expect((await setup(root, "nitro-dev", true)).runtime).toMatch(/drivers\/fs-lite\.mjs";/);
  });

  it("leaves run storage to the app when it mounts its own", async () => {
    const root = app(`{ storage: { driver: "fs-lite", base: ".data" } }`);
    const { runtime, options } = await setup(root, "node-server", false, { "agent-unit": { driver: "redis" } });
    expect(runtime).not.toContain("storageDriver");
    expect(options.storage).toEqual({ "agent-unit": { driver: "redis" } });
  });

  it("keeps the production runtime when Nitro's prerenderer sets the module up again", async () => {
    // No storage in the config: the production preset's default (disk on Node) is the one to keep.
    const root = app(`{}`);
    const { runtime } = await setup(root, "node-server");
    expect(runtime).toContain(`"driver":"fs-lite"`);
    await setup(root, "nitro-prerender");
    expect(readFileSync(join(root, ".nitro/agent-unit/node-server/runtime.mjs"), "utf8")).toBe(runtime);
  });
});
