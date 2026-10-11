import { defineConfig } from "agent-unit";

export default defineConfig({
  server: "./src/server.ts",
  tasks: {
    // Tests build servers with a seconds field (every second) and Workers with five fields.
    tick: { schedule: process.env.TICK_SCHEDULE ?? "* * * * *", handler: "./src/tasks/tick.ts", description: "Records each run." },
  },
});
