# Runs and the HTTP API

## Identity

- **Run id**: `run_` followed by 20 lowercase base-32 characters. Unique per invocation.
- **Thread id**: chosen by the caller (`threadId` in the start request) or, when omitted, equal to
  the run id. Conversation memory and `thread`-scoped state belong to the thread, so several runs
  can continue one conversation.

## Run record

```ts
interface RunRecord {
  id: string;
  agent: string;
  threadId: string;
  status: "running" | "interrupted" | "sleeping" | "completed" | "failed" | "cancelled";
  input: unknown;
  output?: unknown;          // when completed
  error?: { name: string; message: string };   // when failed
  interrupt?: { key: string; name: string; payload: unknown };   // when interrupted
  wakeAt?: string;           // ISO time, when sleeping
  cancelRequested?: boolean; // a cancel reached another process while this run executed
  executing?: boolean;       // an execution started and has not finished
  crashes?: number;          // executions in a row that crashed; the run fails at the limit (default 5)
  attempt: number;           // how many times the run has been (re)started
  eventCount: number;        // events stored so far; the next event's seq is eventCount + 1
  createdAt: string;
  updatedAt: string;
}
```

Terminal states are `completed`, `failed` and `cancelled`. `interrupted` and `sleeping` are parked:
the run uses no compute until it is answered or woken.

## HTTP API

All paths are relative to the configured base path (default `/`). Request bodies must be sent as
`application/json` and are limited to 1 MB by default; an MCP batch holds at most 20 messages.
Errors are `{ "error": { "code": string, "message": string } }` with status 400 (bad input), 404
(unknown agent or run), 409 (wrong run state, for example resuming a run that is not interrupted, or
a second resume racing the first), 413 (body too large) or 415 (body not JSON).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/agents` | `{ agents: AgentCard[] }` |
| `GET` | `/agents/:agent` | One `AgentCard` |
| `POST` | `/agents/:agent/runs` | Start a run |
| `GET` | `/runs` | List runs, filtered by `agent`, `status`, `threadId`; `limit` (default 50) |
| `GET` | `/runs/:id` | One `RunRecord` |
| `GET` | `/runs/:id/events` | The run's events (SSE), from `after` or `Last-Event-ID` |
| `POST` | `/runs/:id/resume` | Answer the pending interrupt |
| `POST` | `/runs/:id/cancel` | Cancel a running, interrupted or sleeping run (see below) |
| `DELETE` | `/runs/:id` | Delete a finished run with its journal and events (`204`; `409` while it is running or parked) |
| `GET` | `/manifest.json` | The manifest |
| `GET` | `/.well-known/agent.json` | The A2A agent card |
| `POST` | `/mcp` | MCP (JSON-RPC over streamable HTTP) |

### Start a run

```http
POST /agents/support/runs
Content-Type: application/json
Accept: text/event-stream

{ "input": { "messages": [{ "role": "user", "content": "Refund order 123" }] }, "threadId": "t_42" }
```

- With `Accept: text/event-stream` the response is the event stream (see [events.md](./events.md)),
  which ends when the run settles (finishes, fails, interrupts, sleeps or is cancelled).
- Otherwise, on hosts that keep work alive after the response (`waitUntil`: Node, Bun, Deno,
  Cloudflare, Vercel), the response is `202` with the `RunRecord` and the run continues in the
  background.
- On hosts that freeze once the response is sent (AWS Lambda, Netlify Functions), the request carries
  the run: the response is `200` with the `RunRecord` once it finishes or parks.

### Resume

```http
POST /runs/run_…/resume
{ "answer": { "approved": true } }
```

Only valid while the run is `interrupted` (otherwise 409). Responds like the start request: a stream
with `Accept: text/event-stream`, otherwise `202` (or `200` once settled, on hosts without
`waitUntil`) with the record.

### Cancel

A run executing in the same process is asked to stop and the response comes within about two
seconds, with `cancelRequested: true` if its current step has not stopped yet. A parked run, or one
whose executor has died, is cancelled at once: the response has
`status: "cancelled"` and a `RUN_CANCELLED` event follows the last stored event. A run that another
process is executing gets `cancelRequested: true` instead; that executor notices within a second, at
its next step, emits `RUN_CANCELLED` and records `cancelled`. If it finishes first, the run completes.

### Read events

`GET /runs/:id/events?after=12` streams every stored event with `seq > 12`, then live events until
the run settles. It also honours the SSE `Last-Event-ID` header, so a browser `EventSource` resumes
where it left off after a dropped connection or a closed tab.

## Internal endpoints

Two endpoints let a host continue work without a long-lived process. A yielded run is continued by
POSTing to this deployment's own URL, which comes from configuration (`AGENT_UNIT_URL`, the
platform's URL variable or the `origin` option), never from a request header. Both require
`Authorization: Bearer <AGENT_UNIT_SECRET>` and are disabled when no secret is configured. They are
not affected by the app's `authorize` hook.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/__agent-unit/continue/:id` | Continue a run that yielded at its time budget |
| `POST` | `/__agent-unit/sweep` | Wake due sleepers and recover stalled runs; returns `{ woken, recovered }` |

The build schedules the sweep with the platform's own scheduler where Nitro supports one (Node, Bun,
Deno, Cloudflare Cron Triggers, Vercel Cron) and generates a scheduled function on Netlify. Elsewhere
(AWS Lambda), point a scheduler such as EventBridge at the sweep endpoint.
