# Manifest, agent card and MCP

## Manifest

`GET /manifest.json`, also written to the build output as `agent-unit.json`.

```ts
interface Manifest {
  version: 1;
  name: string;              // the app name from config
  agents: AgentCard[];
}

interface AgentCard {
  name: string;              // the key in config, URL-safe
  description?: string;
  framework: string;         // the adapter name: "ai-sdk", "mastra", "langgraph", …
  tools: { name: string; description?: string }[];
  input?: unknown;           // JSON Schema of the start input, when the adapter knows it
}
```

Services discover what an app runs from the manifest alone: names, frameworks and tools.

## A2A agent card

`GET /.well-known/agent.json` returns an [A2A](https://a2a-protocol.org) agent card describing the
app, with one skill per agent. Calling an agent over A2A is not part of version 1; the card exists so
A2A registries can discover the agents.

## MCP

`POST /mcp` speaks MCP over streamable HTTP (JSON responses). Each agent is one MCP tool:

- name: the agent name
- input: `{ "message": string, "threadId"?: string }`
- result: the run's final text, or a structured `{ status, runId, interrupt }` when the run parks

`initialize`, `tools/list` and `tools/call` are supported.
