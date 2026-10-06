import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, collect, createAgentClient, prepareFixture, startServer, tempDir, type RunningServer } from "./helpers";

// agent-unit mounted inside an existing Nitro app with the module, next to the app's own routes.

describe("agent-unit/nitro module in an existing Nitro app", () => {
  let root: string;
  let out: string;
  let data: string;
  let server: RunningServer;

  beforeAll(async () => {
    root = prepareFixture("nitro-app");
    out = tempDir("nitro-app-out");
    data = tempDir("nitro-app-data");
    process.env.AGENT_UNIT_DATA = data;
    try {
      const { createNitro, prepare, copyPublicAssets, build } = await import("nitro/builder");
      const nitro = await createNitro({ rootDir: root, dev: false, preset: "node-server", output: { dir: out }, logLevel: 1 } as never);
      await prepare(nitro);
      await copyPublicAssets(nitro);
      await build(nitro);
      await nitro.close();
    } finally {
      delete process.env.AGENT_UNIT_DATA;
    }
    server = await startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: root, readyPath: "/hello" });
  });

  afterAll(async () => {
    await server?.stop();
    cleanup(out, data);
  });

  it("keeps the app's own routes", async () => {
    expect(await (await fetch(`${server.url}/hello`)).json()).toEqual({ hello: "from the app" });
  });

  it("serves agents under the base path, with interrupts across requests", async () => {
    const client = createAgentClient({ baseUrl: `${server.url}/api/agents` });
    expect((await client.manifest()).agents.map((agent) => agent.name)).toEqual(["approver"]);
    const card = await (await fetch(`${server.url}/api/agents/.well-known/agent.json`)).json();
    expect(card.url).toBe(`${server.url}/api/agents`);

    const first = await collect(client.run("approver", { item: "laptop" }));
    expect(first.at(-1)).toMatchObject({ type: "RUN_INTERRUPTED", interrupt: { name: "approve", payload: { item: "laptop" } } });
    const second = await collect(client.resume(first[0]!.runId, { approved: true }));
    expect(second.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: "approved laptop" });
  });
});
