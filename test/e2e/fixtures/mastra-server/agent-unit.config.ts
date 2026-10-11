import { defineConfig } from "agent-unit";
import { mastra } from "agent-unit/presets/mastra";

// Mastra's own server and storage; agent-unit only builds it for each host.
export default defineConfig({
  server: mastra(),
  // On Workers the store is D1 (see package.json "imports"): the Worker's DB binding.
  cloudflare: { wrangler: { d1_databases: [{ binding: "DB", database_name: "refunds", database_id: "00000000-0000-0000-0000-000000000000" }] } },
});
