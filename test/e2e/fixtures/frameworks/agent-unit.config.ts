import { defineConfig } from "agent-unit";

export default defineConfig({
  name: "frameworks",
  runtime: process.env.AGENT_UNIT_RUNTIME === "durable-objects" ? "durable-objects" : "default",
  storage: { driver: "fs-lite", base: process.env.AGENT_UNIT_DATA ?? ".data/agent-unit" },
});
