// Runs the Cloudflare build in workerd (the open-source Workers runtime) with Durable Objects on
// disk, and drives a real model through it: ask for a refund, wait for the approval pause, kill the
// runtime, start it again, approve, and read the answer.
//
//   OPENAI_API_KEY=… ANTHROPIC_API_KEY=… npm run verify
//
// Keys reach the Worker through workerd's `fromEnvironment` bindings; they are never written to disk.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const OUT = resolve(".output");
const PORT = 4891;
const BASE = `http://127.0.0.1:${PORT}`;
const AGENTS = [
  { agent: "openai", key: "OPENAI_API_KEY" },
  { agent: "claude", key: "ANTHROPIC_API_KEY" },
].filter(({ key }) => process.env[key]);

if (AGENTS.length === 0) {
  console.error("Set OPENAI_API_KEY and/or ANTHROPIC_API_KEY to verify against real models.");
  process.exit(1);
}

// The workerd binary itself (its package's default export), so killing it really stops the runtime.
const workerdModule = await import("workerd");
const workerd = typeof workerdModule.default === "string" ? workerdModule.default : workerdModule.default.default;
const disk = mkdtempSync(join(tmpdir(), "agent-unit-do-"));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function writeConfig() {
  const serverDir = join(OUT, "server");
  const wrangler = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8"));
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const modules = walk(serverDir)
    .filter((file) => /\.m?js$/.test(file))
    .map((file) => relative(serverDir, file).replaceAll("\\", "/"))
    .sort((a, b) => (a === wrangler.main ? -1 : b === wrangler.main ? 1 : a.localeCompare(b)))
    .map((name) => `(name = ${JSON.stringify(name)}, esModule = embed ${JSON.stringify(`server/${name}`)})`);
  const objects = wrangler.durable_objects.bindings;
  const bindings = [
    ...objects.map((o) => `(name = ${JSON.stringify(o.name)}, durableObjectNamespace = ${JSON.stringify(o.class_name)})`),
    ...AGENTS.map(({ key }) => `(name = "${key}", fromEnvironment = "${key}")`),
  ];
  const config = join(OUT, "workerd.capnp");
  writeFileSync(
    config,
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .worker),
    (name = "do-disk", disk = (path = ${JSON.stringify(disk)}, writable = true)),
    (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${PORT}", http = (), service = "main")],
);
const worker :Workerd.Worker = (
  modules = [${modules.join(", ")}],
  compatibilityDate = ${JSON.stringify(wrangler.compatibility_date)},
  compatibilityFlags = ${JSON.stringify(wrangler.compatibility_flags)},
  bindings = [${bindings.join(", ")}],
  durableObjectNamespaces = [${objects.map((o) => `(className = ${JSON.stringify(o.class_name)}, uniqueKey = "verify-${o.class_name}", enableSql = true)`).join(", ")}],
  durableObjectStorage = (localDisk = "do-disk"),
  globalOutbound = "internet",
);
`,
  );
  return config;
}

async function startWorkerd(config) {
  if (await fetch(`${BASE}/manifest.json`).then(() => true, () => false)) {
    throw new Error(`Something is already listening on port ${PORT}; stop it first (an earlier workerd?).`);
  }
  const child = spawn(workerd, ["serve", config, "--verbose"], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stdout.on("data", (chunk) => (errors += chunk));
  child.stderr.on("data", (chunk) => (errors += chunk));
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`workerd exited:\n${errors}`);
    if (await fetch(`${BASE}/manifest.json`).then((r) => r.ok, () => false)) return { child, errors: () => errors };
    await sleep(50);
  }
  throw new Error(`workerd did not start:\n${errors}`);
}
const stop = (child) => new Promise((done) => (child.once("exit", done), child.kill("SIGKILL")));

/** Streams a run's events from an SSE response, printing what the agent does. */
async function stream(response, label) {
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error(`${label}: expected an event stream, got ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const events = [];
  let text = "";
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      events.push(event);
      if (event.type === "TOOL_CALL_START") console.log(`  ${label} → calls ${event.toolCallName}`);
      if (event.type === "TOOL_CALL_RESULT") console.log(`  ${label} ← ${event.content.slice(0, 110)}`);
      if (event.type === "TEXT_MESSAGE_CONTENT") text += event.delta;
      if (event.type === "RUN_INTERRUPTED") console.log(`  ${label} ⏸ paused: ${event.interrupt.name} ${JSON.stringify(event.interrupt.payload)}`);
      if (event.type === "RUN_ERROR") console.log(`  ${label} ✗ ${event.message}`);
    }
  }
  if (text) console.log(`  ${label} says: "${text.trim()}"`);
  return events;
}

const post = (body, accept = "text/event-stream") => ({
  method: "POST",
  headers: { "content-type": "application/json", accept },
  body: JSON.stringify(body),
});

const config = writeConfig();
let server = await startWorkerd(config);
let failed = false;
try {
  for (const { agent } of AGENTS) {
    console.log(`\n${agent}: "Hi, order o_1001 arrived broken. Can I get a refund?"`);
    const first = await stream(
      await fetch(`${BASE}/agents/${agent}/runs`, post({ input: { prompt: "Hi, order o_1001 arrived broken. Can I get a refund?" } })),
      agent,
    );
    const parked = first.at(-1);
    if (parked?.type !== "RUN_INTERRUPTED") throw new Error(`${agent}: expected a pause for approval, got ${parked?.type}`);
    const runId = parked.runId;

    const before = server.child.pid;
    await stop(server.child);
    server = await startWorkerd(config);
    console.log(`  … killed workerd (pid ${before}) and started a new one (pid ${server.child.pid}); approving`);

    const second = await stream(await fetch(`${BASE}/runs/${runId}/resume`, post({ answer: { approved: true } })), agent);
    const run = await (await fetch(`${BASE}/runs/${runId}`)).json();
    const history = [...first, ...second];
    const lookups = history.filter((e) => e.type === "TOOL_CALL_START" && e.toolCallName === "lookup_order").length;
    const refunds = history.filter((e) => e.type === "TOOL_CALL_RESULT" && e.content.includes('"refunded":true')).length;
    const ok = run.status === "completed" && run.attempt === 2 && refunds === 1;
    console.log(
      `  ${ok ? "✓" : "✗"} status=${run.status} attempt=${run.attempt} events=${run.eventCount} lookups=${lookups} refunds=${refunds}`,
    );
    failed ||= !ok;
  }
} catch (error) {
  console.error(`\n${error.message}\n\nworkerd log:\n${server.errors().slice(-3000)}`);
  failed = true;
} finally {
  await stop(server.child);
  rmSync(disk, { recursive: true, force: true });
  rmSync(config, { force: true });
}
process.exit(failed ? 1 : 0);
