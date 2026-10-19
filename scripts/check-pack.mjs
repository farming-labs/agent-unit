// Packs agent-unit, @agent-unit/runtime and create-agent-unit as they would be published, installs the
// tarballs into an empty app with npm, and checks what a user gets: matching versions, no workspace:
// ranges, one copy of the runtime behind every agent-unit import path, a working CLI, and
// `npm create agent-unit` writing an app. Then installs an app with pnpm, builds it and starts it.
// Usage: node scripts/check-pack.mjs (after pnpm build)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "agent-unit-pack-"));
const shell = process.platform === "win32";
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", shell, stdio: ["ignore", "pipe", "inherit"] });
const fail = (message) => {
  console.error(`check-pack: ${message}`);
  process.exitCode = 1;
};

try {
  const packs = join(work, "packs");
  run("pnpm", ["pack", "--pack-destination", packs], join(repo, "packages/runtime"));
  run("pnpm", ["pack", "--pack-destination", packs], join(repo, "packages/create-agent-unit"));
  run("pnpm", ["pack", "--pack-destination", packs], repo);
  const tarballs = readdirSync(packs).map((file) => join(packs, file));
  const runtimeTgz = tarballs.find((file) => file.includes("agent-unit-runtime-"));
  const createTgz = tarballs.find((file) => file.includes("create-agent-unit-"));
  const rootTgz = tarballs.find((file) => file !== runtimeTgz && file !== createTgz);
  if (!runtimeTgz || !createTgz || !rootTgz) throw new Error(`expected three tarballs, got ${tarballs.join(", ")}`);

  for (const [name, tarball] of [["@agent-unit/runtime", runtimeTgz], ["create-agent-unit", createTgz]]) {
    if (!run("tar", ["-tzf", tarball], work).includes("package/LICENSE")) fail(`${name} is packed without LICENSE`);
  }

  const app = join(work, "app");
  run("node", ["-e", `require("fs").mkdirSync(${JSON.stringify(app)})`], work);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "pack-check", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", runtimeTgz, rootTgz, createTgz], app);

  const report = JSON.parse(
    run(
      "node",
      [
        "--input-type=module",
        "-e",
        `
import { readFileSync } from "node:fs";
const pkg = (name) => JSON.parse(readFileSync("node_modules/" + name + "/package.json", "utf8"));
const root = pkg("agent-unit"), runtime = pkg("@agent-unit/runtime");
const same = async (ours, theirs) => {
  const [a, b] = [await import(ours), await import(theirs)];
  const keys = Object.keys(b);
  return JSON.stringify(Object.keys(a).sort()) === JSON.stringify(keys.sort()) && keys.every((key) => a[key] === b[key]);
};
console.log(JSON.stringify({
  versions: [root.version, runtime.version],
  range: root.dependencies["@agent-unit/runtime"],
  workspace: JSON.stringify([root, runtime]).includes("workspace:"),
  // agent-unit's index adds defineConfig, so compare what it takes from the runtime.
  index: await Promise.all([import("agent-unit"), import("@agent-unit/runtime")]).then(([a, b]) => a.useRun === b.useRun && a.defineAgent === b.defineAgent),
  server: await same("agent-unit/server", "@agent-unit/runtime/server"),
  runtime: await same("agent-unit/runtime", "@agent-unit/runtime/runtime"),
  testing: await same("agent-unit/testing", "@agent-unit/runtime/testing"),
}));
`,
      ],
      app,
    ),
  );
  const [rootVersion, runtimeVersion] = report.versions;
  if (rootVersion !== runtimeVersion) fail(`versions differ: agent-unit ${rootVersion}, @agent-unit/runtime ${runtimeVersion}`);
  if (report.range !== `^${runtimeVersion}`) fail(`agent-unit depends on @agent-unit/runtime "${report.range}", expected "^${runtimeVersion}"`);
  if (report.workspace) fail("a packed package.json still contains a workspace: range");
  for (const entry of ["index", "server", "runtime", "testing"]) {
    if (!report[entry]) fail(`agent-unit's ${entry} entry is not the same module as @agent-unit/runtime's`);
  }
  const version = run("npx", ["--no-install", "agent-unit", "--version"], app).trim();
  if (!version.includes(rootVersion)) fail(`agent-unit --version printed "${version}"`);
  const createVersion = run("npx", ["--no-install", "create-agent-unit", "--version"], app).trim();
  if (createVersion !== rootVersion) fail(`create-agent-unit --version printed "${createVersion}"`);
  // Node 20.19+ can require() an ES module; the exports must let it (a "default" condition, not only "import").
  const required = run("node", ["-e", `console.log(typeof require("agent-unit/server").createAgentUnit, typeof require("@agent-unit/runtime").defineAgent)`], app).trim();
  if (required !== "function function") fail(`require() of agent-unit's entries gave "${required}"`);

  // `npm create agent-unit` runs create-agent-unit's bin, which runs agent-unit init.
  const create = JSON.parse(readFileSync(join(app, "node_modules/create-agent-unit/package.json"), "utf8"));
  if (create.version !== rootVersion) fail(`versions differ: agent-unit ${rootVersion}, create-agent-unit ${create.version}`);
  if (create.dependencies["agent-unit"] !== `^${rootVersion}`) fail(`create-agent-unit depends on agent-unit "${create.dependencies["agent-unit"]}", expected "^${rootVersion}"`);
  run("npx", ["--no-install", "create-agent-unit", "created", "--framework", "agent-unit", "--hosts", "node", "--yes", "--no-install"], app);
  const created = JSON.parse(readFileSync(join(app, "created/package.json"), "utf8"));
  if (created.dependencies?.["agent-unit"] !== `^${rootVersion}`) fail(`create-agent-unit wrote an app depending on agent-unit "${created.dependencies?.["agent-unit"]}"`);

  // pnpm gives an app only the packages it names, so a build that imports one of agent-unit's own
  // dependencies (Nitro) by name crashes there on start, although npm's flat node_modules hides it.
  // Outside `app`, whose node_modules would hide it too.
  const pnpmApp = join(work, "pnpm-app");
  run("npx", ["--no-install", "create-agent-unit", pnpmApp, "--framework", "agent-unit", "--hosts", "node", "--yes", "--no-install"], app);
  const manifest = JSON.parse(readFileSync(join(pnpmApp, "package.json"), "utf8"));
  manifest.dependencies["agent-unit"] = `file:${rootTgz}`;
  writeFileSync(join(pnpmApp, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(pnpmApp, "pnpm-workspace.yaml"), `packages: []\noverrides:\n  "@agent-unit/runtime": ${JSON.stringify(`file:${runtimeTgz}`)}\n`);
  run("pnpm", ["install", "--reporter=silent"], pnpmApp);
  run("pnpm", ["exec", "agent-unit", "build", "--preset", "node-server"], pnpmApp);
  const started = await new Promise((done) => {
    const server = spawn("node", [".output/server/index.mjs"], { cwd: pnpmApp, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const finish = (result) => (server.kill("SIGKILL"), done(result));
    const read = (chunk) => ((output += chunk), output.includes("Listening") && finish(true));
    server.stdout.on("data", read);
    server.stderr.on("data", read);
    server.on("exit", () => done(output));
    setTimeout(() => finish(output || "no output in 20s"), 20_000);
  });
  if (started !== true) fail(`an app installed with pnpm builds, but its server does not start:\n${started}`);
  if (!process.exitCode) console.log(`check-pack: agent-unit ${rootVersion} and @agent-unit/runtime ${runtimeVersion} install and resolve to one runtime; create-agent-unit writes an app; a pnpm app builds and starts`);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
