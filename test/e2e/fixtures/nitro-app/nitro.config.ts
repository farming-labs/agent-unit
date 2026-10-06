import { defineConfig } from "nitro";
import { agentUnit } from "agent-unit/nitro";

// An existing Nitro app that mounts its agents with the agent-unit module.
export default defineConfig({
  serverDir: "server",
  modules: [agentUnit({ basePath: "/api/agents" })],
});
