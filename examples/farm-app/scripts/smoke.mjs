// Builds the app for Node and checks the agents end to end on the real production server:
// the page renders, a refund pauses, the server is killed, a new process resumes the refund.
import { execSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";

const PORT = 4870;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const post = (body, accept) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(accept ? { accept } : {}) },
  body: JSON.stringify(body),
});

async function start() {
  const child = spawn(process.execPath, [".farm/.output/server/index.mjs"], { env: { ...process.env, PORT: String(PORT) }, stdio: "inherit" });
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error("server exited early");
    if (await fetch(`${BASE}/api/ai/manifest.json`).then((r) => r.ok, () => false)) return child;
    await sleep(50);
  }
  throw new Error("server did not start");
}
const stop = (child) => new Promise((done) => (child.once("exit", done), child.kill("SIGKILL")));
const check = (ok, message) => {
  if (!ok) throw new Error(message);
  console.log(`✓ ${message}`);
};

execSync("npx farm build --preset node-server", { stdio: "inherit" });
rmSync(".data", { recursive: true, force: true });

let server = await start();
check((await fetch(`${BASE}/agents`)).ok, "the /agents page renders");
const manifest = await (await fetch(`${BASE}/api/ai/manifest.json`)).json();
check(manifest.agents.map((a) => a.name).join() === "refund,reminder", "the manifest lists refund and reminder");

const stream = await (await fetch(`${BASE}/api/ai/agents/refund/runs`, post({ input: { orderId: "o_smoke" } }, "text/event-stream"))).text();
check(stream.includes("event: RUN_INTERRUPTED"), "a refund streams until it pauses for approval");
const { runs } = await (await fetch(`${BASE}/api/ai/runs?status=interrupted`)).json();
const runId = runs[0].id;

const first = server.pid;
await stop(server);
server = await start();
check(server.pid !== first, `the server was killed and a new process started (${first} → ${server.pid})`);

await (await fetch(`${BASE}/api/ai/runs/${runId}/resume`, post({ answer: { approved: true } }, "text/event-stream"))).text();
const run = await (await fetch(`${BASE}/api/ai/runs/${runId}`)).json();
check(run.status === "completed" && run.output.status === "refunded", "the new process resumed the refund and finished it");
check(run.attempt === 2 && run.eventCount === 7, "no step ran twice (7 events, one continuous stream)");
await stop(server);
