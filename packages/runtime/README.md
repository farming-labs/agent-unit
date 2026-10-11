# @agent-unit/runtime

agent-unit's run engine: journaled runs that survive restarts, pauses for approval, the `/runs` API, MCP and A2A endpoints, and adapters for the AI SDK, Mastra, OpenAI Agents and LangGraph.

`agent-unit` is the compiler that builds an agent server for any host. Today it depends on this package and builds it as the server, so installing `agent-unit` is enough: every path here is also available as `agent-unit/server`, `agent-unit/testing`, `agent-unit/adapters/*` and so on. Later releases make the engine optional, for apps whose framework already has its own server and storage.

See the [agent-unit README](https://github.com/farming-labs/agent-unit#readme).
