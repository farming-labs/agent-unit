import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, collect, createAgentClient, prepareFixture, startServer, tempDir, type RunningServer } from "./helpers";

// Runs the cloudflare-module build in workerd, the open-source Workers runtime, rather than through
// wrangler's dev proxy (which buffers streamed responses).

// The binary itself, not the package's Node launcher: killing the launcher would leave the
// runtime running, and a "restart" would quietly keep talking to the old process.
const workerd: string | undefined = await import("workerd").then(
  // Node's CommonJS interop wraps the export; Vite's unwraps it.
  (module) => (typeof module.default === "string" ? module.default : (module.default as unknown as { default: string }).default),
  () => undefined,
);

const SECRET = "e2e-secret";
const TOKEN = "e2e-token";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** A workerd config for the built worker: every module embedded, wrangler's compat settings, env as text bindings. */
function writeWorkerdConfig(out: string, port: number) {
  const serverDir = join(out, "server");
  const wrangler = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8"));
  const modules = files(serverDir)
    .filter((file) => /\.m?js$/.test(file))
    .map((file) => relative(serverDir, file).replaceAll("\\", "/"))
    .sort((a, b) => (a === wrangler.main ? -1 : b === wrangler.main ? 1 : a.localeCompare(b)))
    .map((name) => `(name = ${JSON.stringify(name)}, esModule = embed ${JSON.stringify(`server/${name}`)})`);
  const bindings = Object.entries({ AGENT_UNIT_SECRET: SECRET, API_TOKEN: TOKEN, GREETING: "hey" }).map(
    ([name, value]) => `(name = ${JSON.stringify(name)}, text = ${JSON.stringify(value)})`,
  );
  const config = join(out, "workerd.capnp");
  writeFileSync(
    config,
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .worker)],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
const worker :Workerd.Worker = (
  modules = [${modules.join(",\n    ")}],
  compatibilityDate = ${JSON.stringify(wrangler.compatibility_date)},
  compatibilityFlags = ${JSON.stringify(wrangler.compatibility_flags)},
  bindings = [${bindings.join(", ")}],
);
`,
  );
  return { config, wrangler };
}

describe.skipIf(!workerd)("cloudflare-module worker in workerd", () => {
  let out: string;
  let server: RunningServer;
  let wrangler: { triggers?: { crons?: string[] }; compatibility_flags?: string[] };
  const client = () => createAgentClient({ baseUrl: server.url, headers: { authorization: `Bearer ${TOKEN}` } });

  beforeAll(async () => {
    const root = prepareFixture("basic");
    out = tempDir("cloudflare-out");
    const result = await buildFixture(root, "cloudflare-module", out, { AGENT_UNIT_STORAGE: "memory" });
    expect(result.budgetMs).toBe(25_000);
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const written = writeWorkerdConfig(out, port);
    wrangler = written.wrangler;
    server = await startServer(workerd!, ["serve", written.config], { cwd: out, port });
  });

  afterAll(async () => {
    await server?.stop();
    cleanup(out);
  });

  it("schedules the sweep and enables Node compatibility", () => {
    expect(wrangler.triggers?.crons).toEqual(["* * * * *"]);
    expect(wrangler.compatibility_flags).toContain("nodejs_compat");
  });

  it("serves the manifest with bindings as secrets", async () => {
    expect((await fetch(`${server.url}/manifest.json`)).status).toBe(401);
    expect((await client().manifest()).agents).toHaveLength(3);
    const greeting = await collect(client().run("greeter", { name: "worker" }));
    expect(greeting.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: "hey worker" });
  });

  it("streams an interrupt and a resume with useRun inside the worker", async () => {
    const first = await collect(client().run("refund", { orderId: "o_cf" }));
    expect(first.map((event) => event.type)).toEqual(["RUN_STARTED", "STEP_STARTED", "STEP_FINISHED", "RUN_INTERRUPTED"]);
    const second = await collect(client().resume(first[0]!.runId, { approved: true }));
    expect(second.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: { status: "refunded", loads: 1, charges: 1 } });
  });

  it("guards the sweep endpoint with the secret binding", async () => {
    expect((await fetch(`${server.url}/__agent-unit/sweep`, { method: "POST" })).status).toBe(401);
    const swept = await fetch(`${server.url}/__agent-unit/sweep`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
    expect(await swept.json()).toEqual({ woken: [], recovered: [], deleted: [] });
  });
});
