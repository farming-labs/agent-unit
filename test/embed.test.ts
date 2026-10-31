import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAdapters } from "../src/build/adapters";
import { createDevHandler } from "../src/build/dev";
import { loadProject } from "../src/build/load";

// What a framework integration needs to embed agent-unit: its own config module, an explicit
// framework, and the agents served from source inside its dev server.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function app(files: Record<string, string>, dependencies: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-unit-embed-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "embed-app", type: "module", dependencies }));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

// What defineAgent returns, written out: a temp dir cannot import agent-unit by name.
const APPROVER = `export default {
  [Symbol.for("agent-unit.agent")]: true,
  async run(input, run) {
    const decision = await run.interrupt("approve", input);
    return decision.approved ? "approved " + input.item : "declined";
  },
};`;

describe("framework", () => {
  it("serves only the chosen framework's adapter", () => {
    const root = app({}, { ai: "^5.0.0", "@mastra/core": "^0.20.0" });
    expect(detectAdapters(root).map((adapter) => adapter.framework)).toEqual(["mastra", "ai-sdk"]);
    expect(detectAdapters(root, "ai-sdk").map((adapter) => adapter.framework)).toEqual(["ai-sdk"]);
  });

  it("names the package to install when the chosen framework is missing", () => {
    expect(() => detectAdapters(app({}), "langgraph")).toThrow(/npm install @langchain\/langgraph/);
  });

  it("rejects a framework it has no adapter for", () => {
    expect(() => detectAdapters(app({}), "crewai" as never)).toThrow(/unknown framework "crewai"/);
  });
});

describe("a config module", () => {
  it("is read instead of agent-unit.config.*", async () => {
    const root = app({
      "agent-unit.config.mjs": `export default { name: "from-the-file" };`,
      "integration/agents.mjs": `export default { name: "from-the-module", agentsDir: "src/agents" };`,
      "src/agents/approver.mjs": APPROVER,
    });
    const project = await loadProject(root, { configFile: "integration/agents.mjs" });
    expect(project.name).toBe("from-the-module");
    expect(project.configFile).toBe(join(root, "integration/agents.mjs"));
    expect(Object.keys(project.agentFiles)).toEqual(["approver"]);
  });

  it("must exist", async () => {
    await expect(loadProject(app({}), { configFile: "missing.mjs" })).rejects.toThrow(/missing\.mjs does not exist/);
  });
});

describe("createDevHandler", () => {
  it("serves the agents from source as a Fetch handler, interrupts included", async () => {
    const root = app({
      "agent-config.mjs": `export default { basePath: "/api/agent", storage: { driver: "memory" } };`,
      "agents/approver.mjs": APPROVER,
    });
    const handler = await createDevHandler({ root, configFile: "agent-config.mjs", watch: false, logger: { info() {}, warn() {}, error() {} } });
    try {
      const manifest = await (await handler.fetch(new Request("http://localhost/api/agent/manifest.json"))).json();
      expect(manifest.agents.map((agent: { name: string }) => agent.name)).toEqual(["approver"]);

      const pending: Promise<unknown>[] = [];
      const started = await handler.fetch(
        new Request("http://localhost/api/agent/agents/approver/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { item: "laptop" } }) }),
        (promise) => void pending.push(promise),
      );
      const { id } = await started.json();
      const read = async () => {
        await Promise.all(pending.splice(0));
        return (await handler.fetch(new Request(`http://localhost/api/agent/runs/${id}`))).json();
      };
      expect(await read()).toMatchObject({ status: "interrupted" });
      await handler.fetch(
        new Request(`http://localhost/api/agent/runs/${id}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: { approved: true } }) }),
        (promise) => void pending.push(promise),
      );
      expect(await read()).toMatchObject({ status: "completed", output: "approved laptop" });
      expect(handler.describe()).toContain("approver");
    } finally {
      handler.close();
    }
  });

  it("takes the config itself from a host that has already evaluated it", async () => {
    const root = app({ "agents/approver.mjs": APPROVER });
    const handler = await createDevHandler({ root, config: { name: "inline", basePath: "/api/agent", storage: { driver: "memory" } }, watch: false, logger: { info() {}, warn() {}, error() {} } });
    try {
      const manifest = await (await handler.fetch(new Request("http://localhost/api/agent/manifest.json"))).json();
      expect(manifest).toMatchObject({ name: "inline", agents: [{ name: "approver" }] });
    } finally {
      handler.close();
    }
    await expect(loadProject(root, { config: {}, configFile: "x.mjs" })).rejects.toThrow(/not both/);
  });
});
