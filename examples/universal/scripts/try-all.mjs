// Builds the same agents for every host, then runs each build and drives one durable flow through it:
// a greeting, a refund that pauses for approval, a restart where the host allows one, and the resume.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildAll } from "./build-all.mjs";

const ORIGIN = "https://agents.example.com";
const has = (binary) => spawnSync(binary, ["--version"], { stdio: "ignore" }).status === 0;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Starts a built server as its own process and waits until it answers. */
async function serve(command, args, port) {
  const child = spawn(command, args, { env: { ...process.env, PORT: String(port), NITRO_PORT: String(port) }, stdio: "ignore" });
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`${command} exited early`);
    if (await fetch(`http://127.0.0.1:${port}/manifest.json`).then((r) => r.ok, () => false)) break;
    await sleep(50);
  }
  return {
    call: (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init),
    stop: () => new Promise((done) => (child.once("exit", done), child.kill("SIGKILL"))),
  };
}

const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The same flow on every host. `restart` swaps in a fresh process mid-run where the host has one. */
async function flow(host) {
  const greet = await (await host.call("/agents/greeter/runs", post({ input: { name: "universal" } }))).json();
  let greeting = greet.output;
  for (let i = 0; greeting === undefined && i < 100; i++, await sleep(20)) greeting = (await (await host.call(`/runs/${greet.id}`)).json()).output;

  const started = await (await host.call("/agents/refund/runs", post({ input: { orderId: "o_42" } }))).json();
  let run = started;
  for (let i = 0; run.status !== "interrupted" && i < 100; i++, await sleep(20)) run = await (await host.call(`/runs/${started.id}`)).json();
  if (run.status !== "interrupted") throw new Error(`refund did not pause (${run.status})`);

  const restarted = host.restart ? (await host.restart(), true) : false;
  await host.call(`/runs/${started.id}/resume`, post({ answer: { approved: true } }));
  for (let i = 0; run.status !== "completed" && i < 100; i++, await sleep(20)) run = await (await host.call(`/runs/${started.id}`)).json();
  if (run.status !== "completed") throw new Error(`refund did not finish (${run.status})`);

  const tools = await (await host.call("/mcp", post({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).json();
  return { greeting, refund: run.output.status, restarted, attempts: run.attempt, mcp: tools.result.tools.length };
}

/** The Cloudflare build in workerd, the open-source Workers runtime, when it is installed. */
function workerd() {
  let binary;
  try {
    binary = createRequire(import.meta.url).resolve("workerd/bin/workerd");
  } catch {
    return undefined;
  }
  return async () => {
    const serverDir = "dist/cloudflare/server";
    const wrangler = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8"));
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const modules = walk(serverDir)
      .filter((file) => /\.m?js$/.test(file))
      .map((file) => relative(serverDir, file).replaceAll("\\", "/"))
      .sort((a, b) => (a === wrangler.main ? -1 : b === wrangler.main ? 1 : a.localeCompare(b)))
      .map((name) => `(name = ${JSON.stringify(name)}, esModule = embed ${JSON.stringify(`server/${name}`)})`);
    writeFileSync(
      "dist/cloudflare/workerd.capnp",
      `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "main", worker = .worker)], sockets = [(name = "http", address = "127.0.0.1:4404", http = (), service = "main")]);
const worker :Workerd.Worker = (modules = [${modules.join(", ")}], compatibilityDate = ${JSON.stringify(wrangler.compatibility_date)}, compatibilityFlags = ${JSON.stringify(wrangler.compatibility_flags)});
`,
    );
    const host = await serve(binary, ["serve", "dist/cloudflare/workerd.capnp"], 4404);
    try {
      return await flow(host);
    } finally {
      await host.stop();
    }
  };
}

/** A long-lived server: run it, kill it in the middle of the refund, start it again. */
function server(command, args, port) {
  return async () => {
    let current = await serve(command, args, port);
    const host = {
      call: (path, init) => current.call(path, init),
      restart: async () => {
        await current.stop();
        current = await serve(command, args, port);
      },
    };
    try {
      return await flow(host);
    } finally {
      await current.stop();
    }
  };
}

/** A serverless bundle: call its exported function the way the platform does, one invocation per request. */
function fn(entry, invoke) {
  return async () => {
    const module = await import(pathToFileURL(resolve(entry)).href);
    const pending = [];
    return flow({
      call: async (path, init) => {
        const response = await invoke(module, new Request(`${ORIGIN}${path}`, init), (work) => pending.push(work));
        await Promise.allSettled(pending.splice(0));
        return response;
      },
    });
  };
}

async function lambdaEvent(request) {
  const url = new URL(request.url);
  return {
    version: "2.0",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: Object.fromEntries(request.headers),
    requestContext: { domainName: url.host, http: { method: request.method, path: url.pathname, sourceIp: "127.0.0.1" } },
    body: request.body ? await request.text() : undefined,
    isBase64Encoded: false,
  };
}

const RUNNERS = {
  "node-server": has("node") && server("node", ["dist/node/server/index.mjs"], 4401),
  bun: has("bun") && server("bun", ["dist/bun/server/index.mjs"], 4402),
  "deno-server": has("deno") && server("deno", ["run", "-A", "dist/deno/server/index.mjs"], 4403),
  "cloudflare-module": workerd(),
  vercel: fn("dist/vercel/functions/__server.func/index.mjs", (m, request, waitUntil) => m.default.fetch(request, { waitUntil })),
  netlify: fn("dist/netlify/server/server.mjs", (m, request) => m.default(request, {})),
  "aws-lambda": fn("dist/lambda/server/index.mjs", async (m, request) => {
    const result = await m.handler(await lambdaEvent(request), {});
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  }),
};

rmSync(".data", { recursive: true, force: true });
console.log("Building one agents/ folder for every host…\n");
const builds = await buildAll();
console.log("\nRunning each build…\n");

const rows = [];
for (const { preset, out, ms } of builds) {
  const runner = RUNNERS[preset];
  if (!runner) {
    const missing = preset === "cloudflare-module" ? "workerd" : preset.split("-")[0];
    rows.push([preset, out, `${ms} ms`, `built; skipped running (${missing} not installed)`]);
    continue;
  }
  try {
    const result = await runner();
    const how = result.restarted ? `paused → killed → restarted → resumed (attempt ${result.attempts})` : "paused → resumed across invocations";
    rows.push([preset, out, `${ms} ms`, `✓ ${result.greeting} · refund ${result.refund} · ${how} · ${result.mcp} MCP tools`]);
  } catch (error) {
    rows.push([preset, out, `${ms} ms`, `✗ ${error.message}`]);
    process.exitCode = 1;
  }
}

const widths = [0, 1, 2].map((i) => Math.max(...rows.map((row) => row[i].length)));
for (const row of rows) console.log(row.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell)).join("   "));
