import { defineConfig } from "agent-unit";

export default defineConfig({
  name: "universal",
  // Servers keep runs on disk. Serverless hosts need shared storage in production (redis, upstash,
  // cloudflare-kv-binding, vercel-kv, netlify-blobs, ...); the demo passes a driver per preset.
  storage: process.env.AGENT_STORAGE === "memory" ? { driver: "memory" } : { driver: "fs-lite", base: process.env.AGENT_DATA ?? ".data/agent-unit" },
});
