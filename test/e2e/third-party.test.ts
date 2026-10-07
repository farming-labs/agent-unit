import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, collect, createAgentClient, prepareFixture, startServer, tempDir, type RunningServer } from "./helpers";

// A framework agent-unit does not know, with an adapter its own authors publish: registered in the
// app's config, built for production and run, with no change to agent-unit.

describe("an adapter published by a third party", () => {
  let root: string;
  let out: string;
  let server: RunningServer;

  beforeAll(async () => {
    root = prepareFixture("third-party");
    // Install the two packages the way npm links local ones.
    for (const name of ["tiny-agents", "agent-unit-adapter-tiny"]) {
      const link = join(root, "node_modules", name);
      mkdirSync(join(root, "node_modules"), { recursive: true });
      if (!existsSync(link)) symlinkSync(join(root, "vendor", name), link, process.platform === "win32" ? "junction" : "dir");
    }
    out = tempDir("third-party-out");
    await buildFixture(root, "node-server", out);
    server = await startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: root });
  });

  afterAll(async () => {
    await server?.stop();
    if (out) cleanup(out);
  });

  it("is bundled into the production server and runs its framework's agents", async () => {
    const client = createAgentClient({ baseUrl: server.url });
    expect((await client.manifest()).agents).toEqual([{ name: "shout", framework: "tiny-agents", tools: [], description: "A tiny agent" }]);
    const events = await collect(client.run("shout", { prompt: "hello" }));
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: "HELLO!" });
  });
});
