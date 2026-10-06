// One agents/ folder, one build per host. Each output is what you would deploy there.
import { rmSync } from "node:fs";
import { build } from "agent-unit/build";

export const PRESETS = [
  { preset: "node-server", out: "dist/node", run: "node dist/node/server/index.mjs" },
  { preset: "bun", out: "dist/bun", run: "bun dist/bun/server/index.mjs" },
  { preset: "deno-server", out: "dist/deno", run: "deno run -A dist/deno/server/index.mjs" },
  { preset: "cloudflare-module", out: "dist/cloudflare", run: "npx wrangler deploy --config dist/cloudflare/server/wrangler.json", env: { AGENT_STORAGE: "memory" } },
  { preset: "vercel", out: "dist/vercel", run: "vercel deploy --prebuilt (after copying to .vercel/output)" },
  { preset: "netlify", out: "dist/netlify", run: "netlify deploy" },
  { preset: "aws-lambda", out: "dist/lambda", run: "zip dist/lambda/server and upload as a Lambda" },
];

export async function buildAll({ quiet = false } = {}) {
  rmSync("dist", { recursive: true, force: true });
  const results = [];
  for (const { preset, out, env = {} } of PRESETS) {
    Object.assign(process.env, env);
    const started = performance.now();
    const result = await build({ preset, outDir: out, logger: { info() {}, warn() {} } });
    for (const key of Object.keys(env)) delete process.env[key];
    const ms = Math.round(performance.now() - started);
    results.push({ preset, out, ms, agents: result.agents.join(", ") });
    if (!quiet) console.log(`✓ ${preset.padEnd(18)} ${out.padEnd(16)} ${ms} ms`);
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildAll();
  console.log("\nSame agents, seven deployable outputs. Run `npm run try` to exercise each one.");
}
