#!/usr/bin/env node
// `npm create agent-unit [dir] [flags]` (also pnpm, yarn and bun create): the same as
// `npx agent-unit init`, run by the agent-unit this package depends on so both write the same app.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Its own version, not a new app called --version.
if (process.argv.slice(2).some((arg) => arg === "--version" || arg === "-v")) {
  console.log(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version);
  process.exit(0);
}

const manifest = createRequire(import.meta.url).resolve("agent-unit/package.json");
const cli = join(dirname(manifest), JSON.parse(readFileSync(manifest, "utf8")).bin["agent-unit"]);
const result = spawnSync(process.execPath, [cli, "init", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
