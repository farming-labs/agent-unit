// Writes an app with `agent-unit init` for each framework, runner and host it offers, and checks it
// the way a new user gets it: agent-unit from its packed tarballs, every other dependency from npm at
// the ranges the templates pin. Each app has to install with npm (no peer conflicts), typecheck,
// build for every host it chose, and resolve one copy of its framework, so `instanceof` checks hold.
// The e2e suite checks the same apps against the SDK versions in agent-unit's lockfile; this catches
// what npm resolves today. Usage: node scripts/check-init.mjs [name ...] (after pnpm build)
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const shell = process.platform === "win32";
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", shell, stdio: ["ignore", "pipe", "pipe"] });

/** Each combination once, with hosts chosen so every per-host branch of the templates is written. */
const APPS = [
  { name: "mastra", args: ["--framework", "mastra", "--runner", "server", "--hosts", "node,cloudflare", "--store", "libsql", "--extras", "task"] },
  { name: "mastra-pg", args: ["--framework", "mastra", "--runner", "server", "--hosts", "vercel", "--store", "postgres", "--provider", "anthropic"] },
  { name: "mastra-engine", args: ["--framework", "mastra", "--runner", "engine", "--hosts", "node,vercel", "--extras", "auth"] },
  { name: "ai-sdk-engine", args: ["--framework", "ai-sdk", "--runner", "engine", "--hosts", "node,cloudflare,vercel,netlify,lambda", "--extras", "task,auth"] },
  { name: "ai-sdk-server", args: ["--framework", "ai-sdk", "--runner", "server", "--hosts", "node,cloudflare", "--provider", "google", "--extras", "auth"] },
  { name: "langgraph", args: ["--framework", "langgraph", "--hosts", "node,cloudflare", "--provider", "anthropic"] },
  { name: "openai-agents", args: ["--framework", "openai-agents", "--hosts", "node,lambda"] },
  { name: "define-agent", args: ["--framework", "agent-unit", "--hosts", "node,cloudflare,vercel", "--extras", "task"] },
  { name: "hono", args: ["--framework", "hono", "--hosts", "node,bun,deno"] },
];

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
      const builds = Object.keys(manifest.scripts).filter((script) => /^build(:|$)/.test(script));
      for (const build of builds.length > 1 ? builds.filter((script) => script !== "build") : builds) step(`npm run ${build}`, "npm", ["run", build]);
      const duplicated = SINGLE.map((name) => [name, [...versions(root, name)]]).filter(([, found]) => found.length > 1);
      if (duplicated.length) throw new Error(`more than one copy of ${duplicated.map(([name, found]) => `${name} (${found.join(", ")})`).join(", ")}`);
      const resolved = ["@mastra/core", "@langchain/core", "@openai/agents", "ai", "hono"].flatMap((name) => [...versions(root, name)].map((version) => `${name}@${version}`));
      console.log(`check-init: ${app.name} installs, typechecks and builds for ${builds.length > 1 ? builds.length - 1 : 1} host(s)${resolved.length ? ` (${resolved.join(", ")})` : ""}`);
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
