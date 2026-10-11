import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    build: "src/build/index.ts",
    nitro: "src/nitro.ts",
    env: "src/env/index.ts",
    "env.workerd": "src/env/workerd.ts",
    // agent-unit/runtime, agent-unit/server, ... keep working: each re-exports @agent-unit/runtime.
    runtime: "src/exports/runtime.ts",
    adapter: "src/exports/adapter.ts",
    server: "src/exports/server.ts",
    client: "src/exports/client.ts",
    testing: "src/exports/testing.ts",
    cloudflare: "src/exports/cloudflare.ts",
    redis: "src/exports/redis.ts",
    "adapters/ai-sdk": "src/exports/adapters/ai-sdk.ts",
    "adapters/langgraph": "src/exports/adapters/langgraph.ts",
    "adapters/mastra": "src/exports/adapters/mastra.ts",
    "adapters/openai-agents": "src/exports/adapters/openai-agents.ts",
  },
  format: "esm",
  platform: "neutral",
  target: "es2022",
  dts: true,
  clean: true,
  fixedExtension: true,
  // Shared chunks live apart from entries, so a chunk can never take an entry's file name.
  // (Declaration entries are emitted as chunks too, flagged isEntry.)
  outputOptions: { chunkFileNames: (chunk) => (chunk.isEntry ? "[name].mjs" : "_chunks/[name]-[hash].mjs") },
  // The runtime stays its own package: one copy of the engine, whichever entry imports it.
  external: [/^@agent-unit\//, /^node:/, /^cloudflare:/, "ai", /^@ai-sdk\//, /^@mastra\//, /^@langchain\//, /^@openai\//, "nitro", /^nitro\//, "h3", "unstorage", /^unstorage\//, "jiti", "citty", "srvx", /^srvx\//],
});
