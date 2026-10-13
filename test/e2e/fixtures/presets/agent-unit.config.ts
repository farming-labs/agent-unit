import { defineConfig } from "agent-unit";

// One config for every host, no environment variables: runs on disk on servers (the default), one
// Durable Object per run on Workers, and the storage set here on Vercel.
export default defineConfig({
  name: "presets",
  retention: "30d",
  presets: {
    "cloudflare-module": { runtime: "durable-objects" },
    // Read where the server runs, like every setting: only Vercel asks for this header.
    vercel: { storage: { driver: "memory" }, budget: "30s", authorize: (request) => request.headers.get("x-team") === "presets" },
  },
});
