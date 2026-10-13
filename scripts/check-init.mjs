// Writes an app with `agent-unit init` for each framework, runner and host it offers, and checks it
// the way a new user gets it: agent-unit from its packed tarballs, every other dependency from npm at
// the ranges the templates pin. Each app has to install with npm (no peer conflicts), typecheck,
// build for every host it chose, resolve one copy of its framework (so `instanceof` checks hold), and
// answer a request from its Node build, and from its Bun and Deno builds when it chose those hosts
// and they are installed.
// The e2e suite checks the same apps against the SDK versions in agent-unit's lockfile; this catches
// what npm resolves today. Usage: node scripts/check-init.mjs [name ...] (after pnpm build)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const shell = process.platform === "win32";
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", shell, stdio: ["ignore", "pipe", "pipe"] });

/**
 * Each combination once, with hosts chosen so every per-host branch of the templates is written, and
 * the request its Node build must answer: the route the app's README tells a new user to try first,
 * or the agent list.
 */
const APPS = [
  { name: "mastra", args: ["--framework", "mastra", "--runner", "server", "--hosts", "node,cloudflare", "--store", "libsql", "--extras", "task"], smoke: ["/api/agents", '"assistant"'] },
  { name: "mastra-pg", args: ["--framework", "mastra", "--runner", "server", "--hosts", "vercel", "--store", "postgres", "--provider", "anthropic"], smoke: ["/health", ""] },
  { name: "mastra-engine", args: ["--framework", "mastra", "--runner", "engine", "--hosts", "node,vercel", "--extras", "auth,test"], smoke: ["/agents", '"assistant"'] },
  { name: "ai-sdk-engine", args: ["--framework", "ai-sdk", "--runner", "engine", "--hosts", "node,cloudflare,vercel,netlify,lambda", "--extras", "task,auth,test"], smoke: ["/agents", '"refund"'] },
  { name: "ai-sdk-server", args: ["--framework", "ai-sdk", "--runner", "server", "--hosts", "node,cloudflare", "--provider", "google", "--extras", "auth,background,test"], smoke: ["/", '"ok":true'] },
  { name: "langgraph", args: ["--framework", "langgraph", "--hosts", "node,cloudflare", "--provider", "anthropic", "--extras", "test"], smoke: ["/agents", '"refund"'] },
  { name: "openai-agents", args: ["--framework", "openai-agents", "--hosts", "node,lambda", "--extras", "test"], smoke: ["/agents", '"refund"'] },
  { name: "define-agent", args: ["--framework", "agent-unit", "--hosts", "node,cloudflare,vercel,deno", "--extras", "task,test"], smoke: ["/agents", '"refund"'] },
  { name: "hono", args: ["--framework", "hono", "--hosts", "node,bun,deno"], smoke: ["/hello", '"hello":"world"'] },
];

/** What a new user fills in from .env.example: placeholders, since no request reaches a model. */
const ENV = {
  OPENAI_API_KEY: "sk-check-init",
  ANTHROPIC_API_KEY: "sk-check-init",
  GOOGLE_GENERATIVE_AI_API_KEY: "check-init",
  API_TOKEN: "check-init",
  DATABASE_URL: "postgres://127.0.0.1:1/check-init",
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** Runtimes besides Node that an app may choose, each started on its own build. */
const RUNTIMES = {
  bun: { preset: "bun", command: "bun", args: (entry) => ["run", entry] },
  deno: { preset: "deno-server", command: "deno", args: (entry) => ["run", "-A", entry] },
};
const has = (command) => spawnSync(command, ["--version"], { stdio: "ignore", shell }).status === 0;

/** Starts a server build and checks the first answer to `path` contains `expected`. */
async function smoke(root, [path, expected], command = process.execPath, args = [join(root, ".output/server/index.mjs")], label = "Node") {
  const port = await freePort();
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...ENV, PORT: String(port), NITRO_PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  let exited = false;
  child.once("exit", () => (exited = true));
  const tail = () => output.trim().split("\n").slice(-20).join("\n");
  try {
    for (const deadline = Date.now() + 30_000; ; ) {
      if (exited) throw new Error(`its ${label} build exited before answering:\n${tail()}`);
      if (Date.now() > deadline) throw new Error(`its ${label} build did not answer ${path} within 30s:\n${tail()}`);
      // Polls until the server accepts the connection; the first answer is the one checked.
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${ENV.API_TOKEN}` } }).catch(() => undefined);
      if (response) {
        const body = await response.text();
        if (!response.ok || !body.includes(expected)) throw new Error(`GET ${path} on its ${label} build answered ${response.status}: ${body.slice(0, 300)}`);
        return `GET ${path} ${response.status}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    child.kill("SIGKILL");
  }
}

/** Packages that must resolve to one copy: a second one breaks the framework's own `instanceof` checks. */
const SINGLE = ["agent-unit", "@agent-unit/runtime", "@mastra/core", "@langchain/core", "@langchain/langgraph", "@openai/agents-core", "ai", "zod"];

/** Every version of `name` installed anywhere under node_modules. */
function versions(dir, name, found = new Set()) {
  const modules = join(dir, "node_modules");
  if (!existsSync(modules)) return found;
  const manifest = join(modules, name, "package.json");
  if (existsSync(manifest)) found.add(JSON.parse(readFileSync(manifest, "utf8")).version);
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith(".")) continue;
    const scoped = entry.startsWith("@") ? readdirSync(join(modules, entry)).map((child) => join(entry, child)) : [entry];
    for (const child of scoped) versions(join(modules, child), name, found);
  }
  return found;
}

const only = process.argv.slice(2);
const unknown = only.filter((name) => !APPS.some((app) => app.name === name));
if (unknown.length) {
  console.error(`check-init: no app named ${unknown.join(", ")}; the apps are ${APPS.map(({ name }) => name).join(", ")}`);
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), "agent-unit-init-"));
const failures = [];
try {
  const packs = join(work, "packs");
  run("pnpm", ["pack", "--pack-destination", packs], join(repo, "packages/runtime"));
  run("pnpm", ["pack", "--pack-destination", packs], repo);
  const tarballs = readdirSync(packs).map((file) => join(packs, file));
  const runtimeTgz = tarballs.find((file) => file.includes("agent-unit-runtime-"));
  const rootTgz = tarballs.find((file) => file !== runtimeTgz);

  for (const app of APPS.filter(({ name }) => !only.length || only.includes(name))) {
    const root = join(work, app.name);
    const step = (label, command, args) => {
      try {
        return run(command, args, root);
      } catch (error) {
        throw new Error(`${label} failed:\n${[error.stdout, error.stderr].filter(Boolean).join("\n").trim().split("\n").slice(-30).join("\n")}`);
      }
    };
    try {
      run("node", [join(repo, "dist/cli.mjs"), "init", root, ...app.args, "--yes", "--no-install"], work);
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      // agent-unit as it would be published; the rest of the app's dependencies stay as written.
      manifest.dependencies = { ...manifest.dependencies, "agent-unit": `file:${rootTgz}`, "@agent-unit/runtime": `file:${runtimeTgz}` };
      writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

      step("npm install", "npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"]);
      step("typecheck", "npm", ["run", "typecheck"]);
      // The app's own test, on the vitest npm resolves.
      if (manifest.scripts.test) step("npm test", "npm", ["test"]);
      const builds = Object.keys(manifest.scripts).filter((script) => /^build(:|$)/.test(script));
      for (const build of builds.length > 1 ? builds.filter((script) => script !== "build") : builds) step(`npm run ${build}`, "npm", ["run", build]);
      const duplicated = SINGLE.map((name) => [name, [...versions(root, name)]]).filter(([, found]) => found.length > 1);
      if (duplicated.length) throw new Error(`more than one copy of ${duplicated.map(([name, found]) => `${name} (${found.join(", ")})`).join(", ")}`);
      // The Node build last, so its .output is the one served (Workers, Bun and Deno builds use the same directory).
      step("node build", "npx", ["--no-install", "agent-unit", "build", "--preset", "node-server"]);
      const answered = await smoke(root, app.smoke);
      // The same request on the other runtimes the app chose, each from its own build.
      const runtimes = [];
      for (const [host, runtime] of Object.entries(RUNTIMES)) {
        if (!manifest.scripts[`build:${host}`]) continue;
        if (!has(runtime.command)) {
          runtimes.push(`${host} skipped (${runtime.command} not installed)`);
          continue;
        }
        const out = `.output-${host}`;
        step(`${host} build`, "npx", ["--no-install", "agent-unit", "build", "--preset", runtime.preset, "--out", out]);
        await smoke(root, app.smoke, runtime.command, runtime.args(join(root, out, "server/index.mjs")), host);
        runtimes.push(`${host} too`);
      }
      const resolved = ["@mastra/core", "@langchain/core", "@openai/agents", "ai", "hono"].flatMap((name) => [...versions(root, name)].map((version) => `${name}@${version}`));
      console.log(`check-init: ${app.name} installs, typechecks, builds for ${builds.length > 1 ? builds.length - 1 : 1} host(s) and answers ${answered}${runtimes.length ? ` (${runtimes.join(", ")})` : ""}${resolved.length ? ` [${resolved.join(", ")}]` : ""}`);
    } catch (error) {
      failures.push(app.name);
      console.error(`check-init: ${app.name}: ${error.message}`);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (failures.length) {
  console.error(`check-init: ${failures.length} app(s) failed: ${failures.join(", ")}`);
  process.exitCode = 1;
}
