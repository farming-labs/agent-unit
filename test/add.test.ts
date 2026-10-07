import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addAdapters, addToConfigSource, adapterIdentifier } from "../src/build/add";
import { buildManifest } from "../src/build/agents";
import { loadProject } from "../src/build/load";

const IMPORT = `import tinyAdapter from "agent-unit-adapter-tiny";`;

describe("adding an adapter to a config file", () => {
  it("names adapters after their package", () => {
    expect(adapterIdentifier("agent-unit-adapter-tiny")).toBe("tinyAdapter");
    expect(adapterIdentifier("agent-unit-adapter-super-agents")).toBe("superAgentsAdapter");
    expect(adapterIdentifier("@acme/agent-unit")).toBe("acmeAdapter");
    expect(adapterIdentifier("@acme/agent-unit-adapter-crew")).toBe("crewAdapter");
  });

  it("adds an import after the last one and an adapters entry to defineConfig", () => {
    const source = `import { defineConfig } from "agent-unit";\nimport {\n  thing,\n} from "./thing";\n\nexport default defineConfig({\n  name: "app",\n});\n`;
    expect(addToConfigSource(source, IMPORT, "tinyAdapter()", "agent-unit-adapter-tiny")).toBe(
      `import { defineConfig } from "agent-unit";\nimport {\n  thing,\n} from "./thing";\n${IMPORT}\n\nexport default defineConfig({\n  adapters: [tinyAdapter()],\n  name: "app",\n});\n`,
    );
  });

  it("adds to an existing adapters list, empty or not, and to a plain default export", () => {
    expect(addToConfigSource(`export default defineConfig({ adapters: [] });`, IMPORT, "tinyAdapter()", "agent-unit-adapter-tiny")).toBe(
      `${IMPORT}\nexport default defineConfig({ adapters: [tinyAdapter()] });`,
    );
    expect(addToConfigSource(`import a from "a";\nexport default { adapters: [a()] };`, IMPORT, "tinyAdapter()", "agent-unit-adapter-tiny")).toBe(
      `import a from "a";\n${IMPORT}\nexport default { adapters: [tinyAdapter(), a()] };`,
    );
  });

  it("does nothing twice, and gives up on shapes it cannot edit safely", () => {
    const once = addToConfigSource(`export default defineConfig({});`, IMPORT, "tinyAdapter()", "agent-unit-adapter-tiny")!;
    expect(addToConfigSource(once, IMPORT, "tinyAdapter()", "agent-unit-adapter-tiny")).toBe(once);
    expect(addToConfigSource(`const config = makeConfig();\nexport default config;`, IMPORT, "tinyAdapter()", "agent-unit-adapter-tiny")).toBeUndefined();
  });
});

describe("agent-unit add", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const quiet = { info() {}, warn() {} };

  /** An app with a third-party framework and its adapter package already installed. */
  function app(adapterSource: string) {
    dir = mkdtempSync(join(tmpdir(), "agent-unit-add-"));
    const pkg = (name: string, source: string) => {
      mkdirSync(join(dir, "node_modules", name), { recursive: true });
      writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", exports: "./index.js" }));
      writeFileSync(join(dir, "node_modules", name, "index.js"), source);
    };
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(resolve("."), join(dir, "node_modules", "agent-unit"), process.platform === "win32" ? "junction" : "dir");
    pkg("tiny-agents", `export class TinyAgent { constructor(fn) { this.fn = fn; } }`);
    pkg("agent-unit-adapter-tiny", adapterSource);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module", dependencies: { "tiny-agents": "1", "agent-unit-adapter-tiny": "1" } }));
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, "agents", "hello.ts"), `import { TinyAgent } from "tiny-agents";\nexport default new TinyAgent(() => "hi");\n`);
    return dir;
  }

  const adapterPackage = `import { TinyAgent } from "tiny-agents";
export default function tinyAdapter() {
  return { name: "tiny-agents", apiVersion: 1, match: (value) => value instanceof TinyAgent, run: (agent, ctx) => ctx.durable.step("call", () => agent.fn()) };
}`;

  it("registers an installed adapter package in a new config, and the build then uses it", async () => {
    const root = app(adapterPackage);
    const result = await addAdapters({ root, packages: ["agent-unit-adapter-tiny"], yes: true, install: false, logger: quiet });
    expect(result.added).toEqual([{ package: "agent-unit-adapter-tiny", changed: true, name: "tiny-agents", importLine: IMPORT, entry: "tinyAdapter()" }]);
    expect(readFileSync(join(root, "agent-unit.config.ts"), "utf8")).toBe(
      `import { defineConfig } from "agent-unit";\n${IMPORT}\n\nexport default defineConfig({\n  adapters: [tinyAdapter()],\n});\n`,
    );
    const manifest = await buildManifest(await loadProject(root));
    expect(manifest.agents).toEqual([{ name: "hello", framework: "tiny-agents", tools: [] }]);
  });

  it("refuses a package that is not an adapter, and points built-in frameworks to their package", async () => {
    const root = app(`export default { name: "not-quite" };`);
    await expect(addAdapters({ root, packages: ["agent-unit-adapter-tiny"], yes: true, install: false, logger: quiet })).rejects.toThrow(
      /agent-unit-adapter-tiny does not export an agent-unit adapter[\s\S]*Adapter "not-quite" is missing `match`/,
    );
    const builtin = await addAdapters({ root, packages: ["mastra"], yes: true, install: false, logger: quiet });
    expect(builtin).toEqual({ added: [], builtin: ["@mastra/core"] });
  });
});
