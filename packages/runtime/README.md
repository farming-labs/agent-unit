# @agent-unit/runtime

agent-unit's run engine: journaled runs that survive restarts, pauses for approval, the `/runs` API, MCP and A2A endpoints, and adapters for the AI SDK, Mastra, OpenAI Agents and LangGraph.

`agent-unit` is the compiler that builds an agent server for any host. It builds this engine as the server when an app has no `server` of its own, and installs it, so installing `agent-unit` is enough: every path here is also available as `agent-unit/server`, `agent-unit/testing`, `agent-unit/adapters/*` and so on. An app with its own server (a Hono app, Mastra's server) is built without it.

See the [agent-unit README](https://github.com/farming-labs/agent-unit#readme).
