import { defineConfig } from "agent-unit";

// No `server`: agent-unit finds src/mastra/index.ts and builds Mastra's own server, as mastra() would.
export default defineConfig({
  // On Workers the store is D1 (see package.json "imports"): the Worker's DB binding, also declared in
  // wrangler.jsonc, as an app moving from wrangler might.
  cloudflare: { wrangler: { d1_databases: [{ binding: "DB", database_name: "refunds", database_id: "00000000-0000-0000-0000-000000000000" }] } },
});
