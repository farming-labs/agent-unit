import type { Manifest } from "../types";

/** An A2A agent card for the app: one skill per agent (spec/manifest.md). */
export function agentCardDocument(manifest: Manifest, url: string, version = "0.0.0") {
  return {
    protocolVersion: "0.3.0",
    name: manifest.name,
    description: `Agents served by ${manifest.name} with agent-unit.`,
    url,
    version,
    preferredTransport: "JSONRPC",
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: manifest.agents.map((agent) => ({
      id: agent.name,
      name: agent.name,
      description: agent.description ?? `A ${agent.framework} agent.`,
      tags: [agent.framework, ...agent.tools.map((tool) => tool.name)],
    })),
  };
}
