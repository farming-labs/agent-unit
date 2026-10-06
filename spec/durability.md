# Durability

A run's progress is a **journal**: an ordered record of completed steps, interrupt answers and
wake times, stored with the run. When a run continues (after an interrupt, a sleep, a host timeout or
a crash) the agent code runs again from the top, and every step that already completed returns its
journaled result immediately instead of executing again. Execution catches up to where it stopped
and carries on.

## Primitives

Inside a run, `useRun()` (from `agent-unit/runtime`) returns the run context:

| Primitive | Behaviour |
| --- | --- |
| `run.step(name, fn)` | Runs `fn` once. Its result is journaled; on replay the result is returned without calling `fn`. |
| `run.interrupt(name, payload)` | Parks the run with `RUN_INTERRUPTED`. After `resume`, returns the answer. |
| `run.sleep(duration)` | Parks the run with `RUN_SLEEPING` until the time passes. `duration` is ms or `"30s"`, `"5m"`, `"2h"`, `"1d"`. |
| `run.state` | Key–value storage scoped to the `thread` (default), the `agent` or the whole `app`. |
| `run.secrets.get(name)` | Reads a secret from the host environment. |
| `run.emit(name, value)` | Emits a `CUSTOM` event. |
| `run.signal` | An `AbortSignal` that fires when the run is cancelled. |
| `run.id`, `run.threadId`, `run.agent`, `run.attempt` | Identity |

Adapters wrap a framework's model calls and tool calls in steps automatically, so most agents need
none of these explicitly. Agent code calls them where it wants a pause or a side effect that must not
repeat.

## Step identity

A step is identified by its name and how many times that name has run before in this run:
`charge#0`, `charge#1`, … The same code path produces the same identities on replay.

## The determinism rule

Between steps, agent code must make the same decisions given the same journaled results. Anything
non-deterministic or with side effects (network calls, random numbers, the current time, writes)
belongs inside a step. Model calls and tool calls already are, through the adapter.

## Serialisation

Step results are stored as JSON with support for `undefined`, `Date`, `BigInt`, `Map`, `Set`,
`Uint8Array` and `Error`. Anything else must be converted inside the step.

## Continuation on any host

- **Interrupt:** the run parks; `POST /runs/:id/resume` continues it.
- **Sleep:** the run parks; a scheduled sweep (every minute, using the host's scheduler) wakes
  runs whose time has passed. Long-lived servers also wake them with an in-process timer.
- **Host time limit:** a run configured with a time budget yields before the host's limit, at a step
  boundary, and continues in a fresh invocation. Nothing is lost because everything completed is
  in the journal.
- **Crash:** a run left `running` without progress for longer than its lease is picked up by the
  sweep and continued from its journal.

## Storage

Everything lives in one unstorage namespace: `runs:`, `journal:`, `events:<run>:<seq>`, `state:`,
`lease:` and `kv:` (adapter storage). Any driver works; serverless hosts need a shared one (Redis,
Upstash, Cloudflare KV, Vercel KV, Netlify Blobs, a database), because their filesystem does not
survive between invocations. Filesystem drivers write atomically by default, so a crash never leaves
a torn record, and an execution writes its journal one write at a time.

Only one process executes a run at a time: an execution holds a lease, renews it while it works and
releases it when it stops. A duplicate resume, a continuation and the sweep can race; the loser
backs off.

## Runtimes

A runtime decides where runs live and what wakes them; agent code and the HTTP contract are the same
in every runtime.

- **Default:** runs, journals and events in any unstorage driver; leases for exclusivity; in-process
  timers plus a scheduled sweep (or `POST /__agent-unit/sweep`) for wake-ups and recovery.
- **Durable Objects** (Cloudflare): one object per run, named by its id, holds the journal and events
  and is the only executor. The object's alarm is armed as a watchdog while the run executes, set to
  the wake time when it sleeps, and set to now when it yields; when it fires, the object wakes,
  continues or recovers the run. One shared index object holds `runs:`, `state:` and `kv:`.
