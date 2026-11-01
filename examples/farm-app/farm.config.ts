import { agent } from "@farm.js/agent";
import { defineConfig } from "@farm.js/core";
import { devtools } from "@farm.js/devtools";

export default defineConfig({
  plugins: [devtools()],
  integrations: {
    // The agents in src/agents, served at /api/ai in farm dev and built into the server.
    // Runs live in .data/agent-unit here; on Vercel, set a shared driver (redis, upstash, ...).
    agent: agent({
      name: "farm-app",
      basePath: "/api/ai",
      storage: { driver: "fs-lite", base: ".data/agent-unit" },
    }),
  },
  theme: {
    default: "dark",
  },
  deploy: {
    target: "vercel",
  },
});
