import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    build: "src/build/index.ts",
    runtime: "src/runtime/index.ts",
    adapter: "src/adapter/index.ts",
    server: "src/server/index.ts",
    client: "src/client/index.ts",
    testing: "src/testing/index.ts",
    "adapters/ai-sdk": "src/adapters/ai-sdk.ts",
    "adapters/langgraph": "src/adapters/langgraph.ts",
    "adapters/openai-agents": "src/adapters/openai-agents.ts",
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
  // Framework SDKs are optional peers: each adapter imports its own, nothing else does.
  external: [/^node:/, "ai", /^@ai-sdk\//, /^@mastra\//, /^@langchain\//, /^@openai\//, "nitro", /^nitro\//, "h3", "unstorage", /^unstorage\//, "jiti", "citty", "srvx", /^srvx\//],
});
