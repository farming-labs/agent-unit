import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// agent-unit keeps every import path it had before the engine moved to @agent-unit/runtime.

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const root = json("../package.json");
const runtime = json("../packages/runtime/package.json");

const REEXPORTS: Record<string, [() => Promise<object>, () => Promise<object>]> = {
  runtime: [() => import("../src/exports/runtime"), () => import("../packages/runtime/src/runtime/index")],
  adapter: [() => import("../src/exports/adapter"), () => import("../packages/runtime/src/adapter/index")],
  server: [() => import("../src/exports/server"), () => import("../packages/runtime/src/server/index")],
  client: [() => import("../src/exports/client"), () => import("../packages/runtime/src/client/index")],
  testing: [() => import("../src/exports/testing"), () => import("../packages/runtime/src/testing/index")],
  cloudflare: [() => import("../src/exports/cloudflare"), () => import("../packages/runtime/src/cloudflare/index")],
  redis: [() => import("../src/exports/redis"), () => import("../packages/runtime/src/redis")],
  "adapters/ai-sdk": [() => import("../src/exports/adapters/ai-sdk"), () => import("../packages/runtime/src/adapters/ai-sdk")],
  "adapters/langgraph": [() => import("../src/exports/adapters/langgraph"), () => import("../packages/runtime/src/adapters/langgraph")],
  "adapters/mastra": [() => import("../src/exports/adapters/mastra"), () => import("../packages/runtime/src/adapters/mastra")],
  "adapters/openai-agents": [() => import("../src/exports/adapters/openai-agents"), () => import("../packages/runtime/src/adapters/openai-agents")],
};

describe("agent-unit and @agent-unit/runtime", () => {
  it("re-exports every runtime entry whole, default exports included", async () => {
    for (const [entry, [ours, theirs]] of Object.entries(REEXPORTS)) {
      const [a, b] = [await ours(), await theirs()] as Record<string, unknown>[];
      expect(Object.keys(a!).sort(), `agent-unit/${entry}`).toEqual(Object.keys(b!).sort());
      for (const key of Object.keys(b!)) expect(a![key], `agent-unit/${entry} ${key}`).toBe(b![key]);
    }
  });

  it("publishes every runtime subpath under agent-unit too", () => {
    const ours = Object.keys(root.exports);
    for (const subpath of Object.keys(runtime.exports)) expect(ours, subpath).toContain(subpath);
  });

  it("releases both packages at one version", () => {
    expect(runtime.version).toBe(root.version);
    expect(root.dependencies["@agent-unit/runtime"]).toBe("workspace:^");
  });
});
