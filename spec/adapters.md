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
| `ctx.durable.step(name, fn)` | Journals any other call |
| `ctx.run` | The run context (state, interrupt, emit, …) |

`run` returns the final result (a value, a promise, or an async iterable that is drained). Text and
tool events come from the durable wrappers, so most adapters never emit events themselves.

## Two shapes

- **Wrapped:** the framework has no durability of its own. The adapter wraps the model and tools,
  and agent-unit makes the run durable.
- **Native:** the framework already persists and resumes (for example LangGraph's checkpointer or
  the OpenAI Agents SDK's run state). The adapter stores that state through `ctx.durable.step` or
  the run's state, and maps the framework's own pauses onto `run.interrupt`.

## Rules

1. An adapter is small. If it needs storage, HTTP or a queue, that belongs in agent-unit.
2. The framework's objects stay the framework's. Wrap calls; do not replace the agent.
3. `match` must be cheap and must not import optional SDKs that may be missing.
