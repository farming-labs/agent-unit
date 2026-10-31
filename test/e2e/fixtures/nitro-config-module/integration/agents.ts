import type { AgentUnitConfig } from "agent-unit";

// The module the host points agent-unit at. The host hands its settings over as its server starts
// (host-plugin.ts), so this is read when agent-unit's engine is first used, not at import.
export default () => {
  const config = (globalThis as Record<symbol, AgentUnitConfig | undefined>)[Symbol.for("host.agents")];
  if (!config) throw new Error("the host has not started");
  return config;
};
