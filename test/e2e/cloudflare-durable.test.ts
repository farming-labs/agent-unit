import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, collect, createAgentClient, prepareFixture, startServer, tempDir, waitForStatus, type RunningServer } from "./helpers";

// The cloudflare-module build with runtime "durable-objects", in workerd with Durable Objects kept on
// disk, so the runtime can be killed mid-run and started again from the same storage.

// The binary itself, not the package's Node launcher: killing the launcher would leave the
// runtime running, and a "restart" would quietly keep talking to the old process.
const workerd: string | undefined = await import("workerd").then((module) => module.default, () => undefined);

const TOKEN = "e2e-token";
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));

/** A workerd config from the generated wrangler.json: its Durable Object bindings, kept on local disk. */
function writeConfig(out: string, disk: string, port: number) {
  const serverDir = join(out, "server");
  const wrangler = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8"));
  const modules = files(serverDir)
    .filter((file) => /\.m?js$/.test(file))
    .map((file) => relative(serverDir, file).replaceAll("\\", "/"))
    .sort((a, b) => (a === wrangler.main ? -1 : b === wrangler.main ? 1 : a.localeCompare(b)))
    .map((name) => `(name = ${JSON.stringify(name)}, esModule = embed ${JSON.stringify(`server/${name}`)})`);
  const objects: { name: string; class_name: string }[] = wrangler.durable_objects.bindings;
  const sqlite = new Set<string>(wrangler.migrations.flatMap((migration: { new_sqlite_classes?: string[] }) => migration.new_sqlite_classes ?? []));
  const bindings = [
    ...objects.map((object) => `(name = ${JSON.stringify(object.name)}, durableObjectNamespace = ${JSON.stringify(object.class_name)})`),
    ...Object.entries({ API_TOKEN: TOKEN, GREETING: "hey" }).map(([name, value]) => `(name = ${JSON.stringify(name)}, text = ${JSON.stringify(value)})`),
  ];
  const namespaces = objects.map(
    (object) => `(className = ${JSON.stringify(object.class_name)}, uniqueKey = ${JSON.stringify(`e2e-${object.class_name}`)}, enableSql = ${sqlite.has(object.class_name)})`,
  );
  const config = join(out, "workerd.capnp");
  writeFileSync(
    config,
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .worker), (name = "do-disk", disk = (path = ${JSON.stringify(disk)}, writable = true))],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
const worker :Workerd.Worker = (
  modules = [${modules.join(",\n    ")}],
  compatibilityDate = ${JSON.stringify(wrangler.compatibility_date)},
  compatibilityFlags = ${JSON.stringify(wrangler.compatibility_flags)},
  bindings = [${bindings.join(", ")}],
  durableObjectNamespaces = [${namespaces.join(", ")}],
  durableObjectStorage = (localDisk = "do-disk"),
);
`,
  );
  return { config, wrangler };
}

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
    ({ config, wrangler } = writeConfig(out, disk, port));
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
