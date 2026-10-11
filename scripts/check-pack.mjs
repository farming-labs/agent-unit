// Packs agent-unit and @agent-unit/runtime as they would be published, installs both tarballs into
// an empty app with npm, and checks what a user gets: matching versions, no workspace: ranges, one
// copy of the runtime behind every agent-unit import path, and a working CLI.
// Usage: node scripts/check-pack.mjs (after pnpm build)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  run("pnpm", ["pack", "--pack-destination", packs], repo);
  const tarballs = readdirSync(packs).map((file) => join(packs, file));
  const runtimeTgz = tarballs.find((file) => file.includes("agent-unit-runtime-"));
  const rootTgz = tarballs.find((file) => file !== runtimeTgz);
  if (!runtimeTgz || !rootTgz) throw new Error(`expected two tarballs, got ${tarballs.join(", ")}`);

  const listing = run("tar", ["-tzf", runtimeTgz], work);
  if (!listing.includes("package/LICENSE")) fail("@agent-unit/runtime is packed without LICENSE");

  const app = join(work, "app");
  run("node", ["-e", `require("fs").mkdirSync(${JSON.stringify(app)})`], work);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "pack-check", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", runtimeTgz, rootTgz], app);

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
  if (!process.exitCode) console.log(`check-pack: agent-unit ${rootVersion} and @agent-unit/runtime ${runtimeVersion} install and resolve to one runtime`);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
