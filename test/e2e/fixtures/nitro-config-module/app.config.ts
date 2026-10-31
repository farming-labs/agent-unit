import { defineConfig } from "agent-unit";

// A host framework's own config, holding the agent-unit config among its other settings.
export default {
  title: "host app",
  agents: defineConfig({
    name: "from-the-host",
    storage: { driver: "fs-lite", base: process.env.AGENT_UNIT_DATA ?? ".data/agent-unit" },
  }),
};
