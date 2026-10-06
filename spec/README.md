# The agent-unit contract

Version 1. This folder is the contract every agent-unit server implements and every client, UI and
service can rely on. It is independent of the agent framework inside and of the host it runs on.

| Document | What it defines |
| --- | --- |
| [runs.md](./runs.md) | Runs and threads, run states, the HTTP API |
| [events.md](./events.md) | The event stream (AG-UI event types plus three extensions) |
| [manifest.md](./manifest.md) | The manifest, the A2A agent card and the MCP surface |
| [durability.md](./durability.md) | Steps, interrupts, sleep, state, replay and the determinism rule |
| [adapters.md](./adapters.md) | How a framework plugs in |

## The model in one paragraph

An **agent** is code written with any framework. Each invocation is a **run**, identified by a run
id and belonging to a **thread** (a conversation; memory and state scope to it). A run produces an
ordered stream of **events**. A run can stop without finishing: it **interrupts** to ask a human
something, **sleeps** until a time, or **yields** because its host is about to time out. Its progress
is saved as a **journal** of completed steps, so it can continue in a later process, on a later
deploy, from the last completed step, without repeating work that already happened.

## Stability

The contract is versioned (`"version": 1` in the manifest). Additive changes (new optional fields,
new event types) do not change the version. Clients must ignore unknown fields and event types.
