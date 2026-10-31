import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, collect, createAgentClient, prepareFixture, startServer, tempDir, type RunningServer } from "./helpers";

// agent-unit mounted inside an existing Nitro app with the module, next to the app's own routes.

async function buildNitro(root: string, out: string, data: string) {
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
}

describe("agent-unit/nitro module in an existing Nitro app", () => {
  let root: string;
  let out: string;
  let data: string;
  let server: RunningServer;

  beforeAll(async () => {
    root = prepareFixture("nitro-app");
    out = tempDir("nitro-app-out");
    data = tempDir("nitro-app-data");
    await buildNitro(root, out, data);
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

// A host framework that keeps the agent-unit config in its own config module (Farm's agent integration).
describe("agent-unit/nitro module with a config module", () => {
  let root: string;
  let out: string;
  let data: string;
  let server: RunningServer;

  beforeAll(async () => {
    root = prepareFixture("nitro-config-module");
    out = tempDir("nitro-config-module-out");
    data = tempDir("nitro-config-module-data");
    await buildNitro(root, out, data);
    server = await startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: root, readyPath: "/api/agents/manifest.json" });
  });

  afterAll(async () => {
    await server?.stop();
    cleanup(out, data);
  });

  it("reads the config from the module and serves its agents", async () => {
    const client = createAgentClient({ baseUrl: `${server.url}/api/agents` });
    const manifest = await client.manifest();
    expect(manifest.name).toBe("from-the-host");
    expect(manifest.agents.map((agent) => agent.name)).toEqual(["approver"]);

    const first = await collect(client.run("approver", { item: "laptop" }));
    expect(first.at(-1)).toMatchObject({ type: "RUN_INTERRUPTED" });
    const second = await collect(client.resume(first[0]!.runId, { approved: true }));
    expect(second.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: "approved laptop" });
  });
});
