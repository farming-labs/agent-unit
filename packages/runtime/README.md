# @agent-unit/runtime

agent-unit's optional run engine: journaled runs that survive restarts, pauses for approval, the `/runs` API, MCP and A2A endpoints, and adapters for the AI SDK, Mastra, OpenAI Agents and LangGraph.

`agent-unit` itself is the compiler that builds an agent server for any host. Install this package when you want agent-unit's engine as that server. If your framework already has its own server and storage, you do not need it.

Every import path is also available through `agent-unit` (`agent-unit/server`, `agent-unit/testing`, ...) while the two packages finish separating. See the [agent-unit README](https://github.com/farming-labs/agent-unit#readme).
