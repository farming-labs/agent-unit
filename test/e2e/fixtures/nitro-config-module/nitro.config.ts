import { defineConfig } from "nitro";
import { agentUnit } from "agent-unit/nitro";
import app from "./app.config";

// A host framework that keeps the agent-unit config in its own config, evaluated by its server.
export default defineConfig({
  plugins: ["./host-plugin.ts"],
  modules: [agentUnit({ basePath: "/api/agents", config: app.agents, configFile: "integration/agents.ts" })],
});
