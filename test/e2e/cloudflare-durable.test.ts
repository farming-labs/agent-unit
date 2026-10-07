import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, collect, createAgentClient, prepareFixture, startServer, tempDir, waitForStatus, type RunningServer } from "./helpers";
import { workerd, writeDurableConfig } from "./hosts";

// The cloudflare-module build with runtime "durable-objects", in workerd with Durable Objects kept on
// disk, so the runtime can be killed mid-run and started again from the same storage.

const TOKEN = "e2e-token";

describe.skipIf(!workerd)("Durable Objects runtime in workerd", () => {
  let out: string;
  let disk: string;
  let port: number;
  let config: string;
  let wrangler: { durable_objects: { bindings: unknown[] }; triggers?: { crons?: string[] } };
  let server: RunningServer;
  let result: Awaited<ReturnType<typeof buildFixture>>;
  const client = () => createAgentClient({ baseUrl: server.url, headers: { authorization: `Bearer ${TOKEN}` } });
  const start = () => startServer(workerd!, ["serve", config], { cwd: out, port, readyPath: "/.well-known/agent.json" });
  const restart = async () => {
    await server.stop();
    server = await start();
  };

  beforeAll(async () => {
    const root = prepareFixture("basic");
    out = tempDir("cf-durable-out");
    disk = tempDir("cf-durable-disk");
    mkdirSync(disk, { recursive: true });
    result = await buildFixture(root, "cloudflare-module", out, { AGENT_UNIT_RUNTIME: "durable-objects" });
    port = 20_000 + Math.floor(Math.random() * 20_000);
    ({ config, wrangler } = writeDurableConfig(out, disk, port, { API_TOKEN: TOKEN, GREETING: "hey" }));
    server = await start();
  });

  afterAll(async () => {
    await server?.stop();
    cleanup(out, disk);
  });

  it("builds Durable Object bindings instead of a storage driver and a cron sweep", () => {
    expect(result.runtime).toBe("durable-objects");
    expect(result.budgetMs).toBe(600_000);
    expect(wrangler.durable_objects.bindings).toHaveLength(2);
    expect(wrangler.triggers?.crons ?? []).toEqual([]);
  });

  it("pauses a run, survives killing the runtime, and resumes it without repeating side effects", async () => {
    const first = await collect(client().run("refund", { orderId: "o_do" }));
    expect(first.map((event) => event.type)).toEqual(["RUN_STARTED", "STEP_STARTED", "STEP_FINISHED", "RUN_INTERRUPTED"]);
    const runId = first[0]!.runId;
    expect((await client().list({ status: "interrupted" })).map((run) => run.id)).toContain(runId);

    await restart();

    const second = await collect(client().resume(runId, { approved: true }));
    expect(second.map((event) => event.type)).toEqual(["STEP_STARTED", "STEP_FINISHED", "RUN_FINISHED"]);
    expect(second.at(-1)).toMatchObject({ seq: 7, result: { status: "refunded", order: "o_do", loads: 1, charges: 1 } });
    expect(await client().get(runId)).toMatchObject({ status: "completed", attempt: 2 });
  });

  it("wakes a sleeping run from its alarm, even when the runtime restarts during the sleep", async () => {
    const run = await client().start("napper", { ms: 2500 });
    await waitForStatus(client(), run.id, "sleeping");
    await restart();
    // No request reaches the run after the restart: its own alarm must wake it.
    const deadline = Date.now() + 15_000;
    let record = await client().get(run.id);
    while (record.status === "sleeping" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      record = await client().get(run.id);
    }
    expect(record).toMatchObject({ status: "completed", output: { slept: true } });
  });

  it("reads secrets from bindings, enforces authorize and answers MCP", async () => {
    expect((await fetch(`${server.url}/manifest.json`)).status).toBe(401);
    const greeting = await collect(client().run("greeter", { name: "objects" }));
    expect(greeting.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: "hey objects" });
    const call = await (
      await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "greeter", arguments: { message: "mcp" } } }),
      })
    ).json();
    expect(call.result.content).toEqual([{ type: "text", text: "hey mcp" }]);
  });
});

describe.skipIf(!workerd)("Durable Objects runtime in workerd: retention", () => {
  let out: string;
  let disk: string;
  let server: RunningServer;

  beforeAll(async () => {
    const root = prepareFixture("basic");
    out = tempDir("cf-retention-out");
    disk = tempDir("cf-retention-disk");
    await buildFixture(root, "cloudflare-module", out, { AGENT_UNIT_RUNTIME: "durable-objects", AGENT_UNIT_RETENTION: "1s" });
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const { config } = writeDurableConfig(out, disk, port, { API_TOKEN: TOKEN, GREETING: "hey", AGENT_UNIT_RETENTION: "1s" });
    server = await startServer(workerd!, ["serve", config], { cwd: out, port, readyPath: "/.well-known/agent.json" });
  });

  afterAll(async () => {
    await server?.stop();
    cleanup(out, disk);
  });

  it("deletes a finished run from its alarm once retention passes", async () => {
    const client = createAgentClient({ baseUrl: server.url, headers: { authorization: `Bearer ${TOKEN}` } });
    const finished = await collect(client.run("greeter", { name: "retention" }));
    const runId = finished[0]!.runId;
    expect(await client.get(runId)).toMatchObject({ status: "completed" });
    // Its own alarm deletes it; nothing else touches the run.
    const deadline = Date.now() + 15_000;
    let status = 200;
    while (status !== 404 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = (await fetch(`${server.url}/runs/${runId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status;
    }
    expect(status).toBe(404);
    expect((await client.list()).map((run) => run.id)).not.toContain(runId);
  });
});
