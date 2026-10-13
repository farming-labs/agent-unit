import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, prepareFixture, startServer, tempDir } from "./helpers";

describe("explicit output directories", () => {
  const root = prepareFixture("basic");
  const out = tempDir("outputs");
  afterAll(() => cleanup(out, join(root, "dist")));

  it("keeps builds for several presets side by side", async () => {
    await buildFixture(root, "node-server", join(out, "node"), { AGENT_UNIT_STORAGE: "memory" });
    // Netlify's preset puts static files in <root>/dist by default; with --out they stay inside it.
    await buildFixture(root, "netlify", join(out, "netlify"), { AGENT_UNIT_STORAGE: "memory" });
    await buildFixture(root, "vercel", join(out, "vercel"), { AGENT_UNIT_STORAGE: "memory" });
    expect(existsSync(join(out, "node/server/index.mjs"))).toBe(true);
    expect(existsSync(join(out, "netlify/server/server.mjs"))).toBe(true);
    expect(existsSync(join(out, "netlify/public"))).toBe(true);
    expect(existsSync(join(out, "vercel/functions/__server.func/index.mjs"))).toBe(true);
    // The manifest is written beside every build, without running the server.
    const manifest = JSON.parse(readFileSync(join(out, "node/agent-unit.json"), "utf8"));
    expect(manifest).toMatchObject({ version: 1, name: "basic" });
    expect(manifest.agents.map((agent: { name: string }) => agent.name).sort()).toEqual(["greeter", "napper", "refund"]);
  });
});

describe("run storage where the server runs", () => {
  it("stops with a message when the config chooses another driver there than at build", async () => {
    const root = prepareFixture("basic");
    const out = tempDir("outputs-storage");
    try {
      await buildFixture(root, "node-server", out, { AGENT_UNIT_STORAGE: "memory" });
      // Started without AGENT_UNIT_STORAGE, the config chooses fs-lite, which this build does not include.
      await expect(startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: out })).rejects.toThrow(
        `this build keeps runs in "memory" storage, but agent-unit.config.ts chooses "fs-lite" where it runs`,
      );
      // With the environment it was built with, it starts.
      const server = await startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: out, env: { AGENT_UNIT_STORAGE: "memory" } });
      await server.stop();
    } finally {
      cleanup(out);
    }
  });
});

