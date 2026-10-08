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
| `mastra` | Mastra `Agent` | Model and tool calls journaled on a fork of the agent; with memory, read-only during the run and the finished turn saved once, journaled | Tool approvals as `tool-approval`; `suspend()` under the tool's name, resumed with `resumeData`; `run.interrupt()` in tools |
| `openai-agents` | OpenAI Agents SDK `Agent` | `RunState` per turn; model responses and function tools journaled per turn | Tool approvals (`needsApproval`) |
| `langgraph` | Compiled LangGraph graphs | LangGraph checkpoints on agent-unit storage, one journaled step per turn | `interrupt()` in nodes, resumed with `Command({ resume })` |

## Publishing an adapter

Adapters for frameworks agent-unit does not ship are ordinary npm packages that the framework's
authors (or anyone) maintain:

- The default export is a function returning the adapter: `export default function myAdapter(options?)`.
  `agent-unit add <package>` installs the package, checks the adapter it returns, and adds it to
  `agent-unit.config.ts`. A named export ending in `Adapter` is also accepted.
- Name: `agent-unit-adapter-<framework>` or `@scope/agent-unit`; keyword `agent-unit-adapter`.
- `agent-unit` and the framework are peer dependencies.
- Adapters in the config are tried before the built-in ones, so a framework's own adapter replaces
  agent-unit's.

## Adapter API versions

`apiVersion` states the adapter interface an adapter was written for (currently `1`, exported as
`ADAPTER_API_VERSION` from `agent-unit/adapter`). agent-unit validates every configured adapter when
it starts: one missing `name`, `match` or `run`, or written for a newer interface than it supports,
is refused with an error that says what to change (for a newer one: upgrade agent-unit). A change
that existing adapters cannot follow raises the version; agent-unit keeps running older ones for as
long as it can and refuses them with a clear message when it no longer can.

## Checking an adapter

`checkAdapter` (a report) and `assertAdapter` (throws) in `agent-unit/testing` run the checks every
built-in adapter passes, in memory and with any test runner. The agent under test reports each real
side effect through `kit.effect(name, fn?)`; the checks are:

| Check | Fails when |
| --- | --- |
| is a valid adapter | `name`, `match` or `run` is missing, or `apiVersion` is newer than agent-unit |
| recognises its own agents | `match` rejects the agent, or another adapter claims it |
| ignores everything else | `match` accepts or throws on `null`, strings, plain objects, functions or `defineAgent()` agents |
| completes a run | the run fails, or its events do not run RUN_STARTED … RUN_FINISHED with consecutive `seq` |
| does its work inside journaled calls | a side effect runs outside any journaled call, so recovery would repeat it |
| replays a finished run without repeating work | a restarted process does any work again, or returns a different result |
| pauses, survives a restart and resumes without repeating work | (with `pause`) the run does not pause, a fresh process cannot resume it, or resuming repeats work |

## Rules

1. An adapter is small. If it needs storage, HTTP or a queue, that belongs in agent-unit.
2. The framework's objects stay the framework's. Wrap calls; do not replace the agent.
3. `match` must be cheap and must not import optional SDKs that may be missing.
