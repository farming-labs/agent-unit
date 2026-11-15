import { defineConfig } from "agent-unit";

export default defineConfig({
  name: "engine-tasks",
  storage: { driver: "fs-lite", base: process.env.AGENT_UNIT_DATA ?? ".data/agent-unit" },
  // Workers have no filesystem: the e2e suite runs workerd with in-isolate memory storage.
  presets: {
    "cloudflare-module": { storage: { driver: "memory" } },
    vercel: { storage: { driver: "memory" } },
  },
  sweep: false,
  tasks: {
    // Tests build servers with a seconds field (every second), and Workers with one yearly time so two
    // triggers always fall on the same scheduled time.
    digest: {
      schedule: process.env.TICK_SCHEDULE ?? "* * * * *",
      agent: "digest",
      // Read where the server runs, not at build.
      input: { team: process.env.DIGEST_TEAM ?? "unset" },
      description: "Starts the digest agent.",
    },
  },
});
