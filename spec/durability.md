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

A step is identified by its name and how many times that name has run before in its scope:
`charge#0`, `charge#1`, … At the top level of the agent the scope is the run. Inside a journaled
call (a tool call, a framework turn) the scope is that call, and inside a LangGraph turn it is also
the graph task, so a step's identity does not depend on whether earlier calls replayed or ran:
`tool:refund:call_1/charge#0`. The same code path produces the same identities on replay. Runs
started before 0.1.7 keep run-wide numbering, so their journals still match.

## Idempotency keys

A step is journaled when it finishes, so a step that was running when its process died runs again
on recovery. Every step and tool call has an idempotency key: the first 24 bytes of
SHA-256(`agent-unit`, run id, step identity), base64url, 32 characters. It is the same on every
attempt of that step and different for every other step and run. A step's function receives it
(`run.step(name, ({ idempotencyKey }) => …)`); `useRun().idempotencyKey()` returns it inside a step
or a journaled tool call. A framework turn spans many side effects and has no key of its own:
`useRun().idempotencyKey()` throws there.

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
  sweep and continued from its journal. A run whose executions crash five times in a row (the
  engine's `maxCrashes`) fails with `RunCrashed` instead of being retried forever.
- **Retention:** with `retention` set, finished runs are deleted (with their journal and events)
  that long after they finish: by the sweep, or in the Durable Objects runtime by the run's own
  alarm, which is set to the deletion time when the run finishes.

## Storage

Everything lives in one unstorage namespace: `runs:`, `steps:<run>:<entry>` (one key per journal
entry), `events:<run>:<seq>`, `index:` (runs by recency and status, sleepers by wake time, finished
runs by finish time), `state:`, `lease:` and `kv:` (adapter storage). Events are read in seq order
and a reader stops at a gap until the run settles, so a reader never skips an event that is still
being written. Any driver works; serverless hosts need a shared one (Redis,
Upstash, Cloudflare KV, Vercel KV, Netlify Blobs, a database), because their filesystem does not
survive between invocations. Filesystem drivers write atomically by default, so a crash never leaves
a torn record, and an execution writes its journal one write at a time.

Only one execution runs a run at a time. Within a process, an execution claims the run before its
first await. Across processes, it holds a lease under its own token, renews it on a timer for as long
as it works (including during one long step), and releases it when it stops. An execution whose
lease was taken over stops at once and writes nothing more. When an execution starts, event
numbering resumes after the highest event already stored, so events from a crashed execution are
never overwritten. Leases are pluggable (`LeaseBackend`); the default is best effort, and an atomic
backend or the Durable Objects runtime makes overlap impossible.

Every run record carries a `version`. Each change (start, resume, cancel, wake, the start and end
of an execution) is saved only if the stored record still has the version that was read
(`AtomicWrites.compareAndSet`); otherwise the writer reads the run again and decides from what it is
now. A second resume of the same interrupt gets a 409 instead of replacing the first one's answer,
and a cancel that lands while a run is executing is folded into its final save instead of being
overwritten. Redis (`agent-unit/redis`, wired in automatically for the `redis` driver) and the
Durable Objects index save atomically; other stores fall back to check-then-write, serialized within
a process.

## Runtimes

A runtime decides where runs live and what wakes them; agent code and the HTTP contract are the same
in every runtime.

- **Default:** runs, journals and events in any unstorage driver; leases for exclusivity; in-process
  timers plus a scheduled sweep (or `POST /__agent-unit/sweep`) for wake-ups and recovery.
- **Durable Objects** (Cloudflare): one object per run, named by its id, holds the journal and events
  and is the only executor. The object's alarm is armed as a watchdog while the run executes, set to
  the wake time when it sleeps, and set to now when it yields; when it fires, the object wakes,
  continues or recovers the run. One shared index object holds `runs:`, `state:` and `kv:`.
