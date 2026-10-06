import { defineConfig } from "agent-unit";

export default defineConfig({
  name: "frameworks",
  storage: { driver: "fs-lite", base: process.env.AGENT_UNIT_DATA ?? ".data/agent-unit" },
});
