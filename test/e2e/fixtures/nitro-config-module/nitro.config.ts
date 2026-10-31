import { defineConfig } from "nitro";
import { agentUnit } from "agent-unit/nitro";

// A host framework that keeps the agent-unit config in its own config module.
export default defineConfig({
  modules: [agentUnit({ basePath: "/api/agents", configFile: "integration/agents.ts" })],
});
