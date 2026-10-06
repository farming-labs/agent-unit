# Adapters

An adapter teaches agent-unit one framework. It translates; it never implements storage, transport
or scheduling.

```ts
import { defineAdapter } from "agent-unit/adapter";

export default defineAdapter<TAgent>({
  name: "my-framework",
  match(value): value is TAgent,                       // is this one of mine?
  describe?(agent): { description?, tools?, input? },  // optional; defaults are derived
  run(agent, ctx): unknown | Promise<unknown> | AsyncIterable<unknown>,
});
```

`ctx` gives the adapter:

| Field | Purpose |
| --- | --- |
| `ctx.input` | The run input (`{ messages, … }`) |
| `ctx.signal` | Fires on cancel |
| `ctx.durable.model(model)` | Wraps a model so every call is a journaled step that also streams text events |
| `ctx.durable.tools(tools)` | Wraps tools so every call is a journaled step that emits tool events |
| `ctx.durable.tool(name, fn, { toolCallId, input })` | Wraps one tool function, keyed by the framework's tool call id |
| `ctx.durable.step(name, fn)` | Journals any other call |
| `ctx.run` | The run context (state, interrupt, emit, …) |
| `ctx.kv` | Persistent key-value storage private to the adapter, for state the framework keeps itself (checkpoints) |
| `ctx.emit(event)` | Emits an AG-UI event; call it from live work (inside a step) so a replay does not repeat it |

`run` returns the final result (a value, a promise, or an async iterable that is drained). Text and
tool events come from the durable wrappers, so most adapters never emit events themselves.

## Two shapes

- **Wrapped:** the framework has no durability of its own. The adapter wraps the model and tools,
  and agent-unit makes the run durable.
- **Native:** the framework already persists and resumes (for example LangGraph's checkpointer or
  the OpenAI Agents SDK's run state). The adapter stores that state through `ctx.durable.step` or
  `ctx.kv`, and maps the framework's own pauses onto `run.interrupt`.

A step that wraps a whole framework turn must key any calls journaled inside it by that turn: a
journaled turn is not executed on replay, so its inner calls are never allocated, and an
allocation-numbered key would hand the next turn the previous turn's results.

## Built-in adapters

| Adapter | Recognises | Durability | Pauses |
| --- | --- | --- | --- |
| `ai-sdk` | `ToolLoopAgent`, plain `streamText` settings | Model and tool calls journaled | `run.interrupt()` in tools |
| `mastra` | Mastra `Agent` | Model and tool calls journaled on a fork of the agent | `run.interrupt()` in tools |
| `openai-agents` | OpenAI Agents SDK `Agent` | `RunState` per turn; model responses and function tools journaled per turn | Tool approvals (`needsApproval`) |
| `langgraph` | Compiled LangGraph graphs | LangGraph checkpoints on agent-unit storage, one journaled step per turn | `interrupt()` in nodes, resumed with `Command({ resume })` |

## Rules

1. An adapter is small. If it needs storage, HTTP or a queue, that belongs in agent-unit.
2. The framework's objects stay the framework's. Wrap calls; do not replace the agent.
3. `match` must be cheap and must not import optional SDKs that may be missing.
