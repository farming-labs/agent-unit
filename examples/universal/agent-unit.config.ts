import { defineConfig } from "agent-unit";

export default defineConfig({
  name: "universal",
  // Servers keep runs on disk. Serverless hosts need shared storage in production (redis, upstash,
  // cloudflare-kv-binding, netlify-blobs, ...); the demo sets one per host in `presets`.
  storage: { driver: "fs-lite", base: process.env.AGENT_DATA ?? ".data/agent-unit" },
  presets: {
    // A Worker has no disk: the demo keeps its runs in memory there.
    "cloudflare-module": { storage: { driver: "memory" } },
  },
});
