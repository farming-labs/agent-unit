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
  attempt: number;           // how many times the run has been (re)started
  eventCount: number;        // events stored so far; the next event's seq is eventCount + 1
  createdAt: string;
  updatedAt: string;
}
```

Terminal states are `completed`, `failed` and `cancelled`. `interrupted` and `sleeping` are parked:
the run uses no compute until it is answered or woken.

## HTTP API

All paths are relative to the configured base path (default `/`). Bodies are JSON. Errors are
`{ "error": { "code": string, "message": string } }` with status 400 (bad input), 404 (unknown agent
or run) or 409 (wrong run state, for example resuming a run that is not interrupted).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/agents` | `{ agents: AgentCard[] }` |
| `GET` | `/agents/:agent` | One `AgentCard` |
| `POST` | `/agents/:agent/runs` | Start a run |
| `GET` | `/runs` | List runs, filtered by `agent`, `status`, `threadId`; `limit` (default 50) |
| `GET` | `/runs/:id` | One `RunRecord` |
| `GET` | `/runs/:id/events` | The run's events (SSE), from `after` or `Last-Event-ID` |
| `POST` | `/runs/:id/resume` | Answer the pending interrupt |
| `POST` | `/runs/:id/cancel` | Cancel a running, interrupted or sleeping run |
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
- Otherwise the response is `202` with the `RunRecord`, and the run continues in the background.

### Resume

```http
POST /runs/run_…/resume
{ "answer": { "approved": true } }
```

Only valid while the run is `interrupted` (otherwise 409). Responds like the start request: a stream
with `Accept: text/event-stream`, or `202` with the record.

### Read events

`GET /runs/:id/events?after=12` streams every stored event with `seq > 12`, then live events until
the run settles. It also honours the SSE `Last-Event-ID` header, so a browser `EventSource` resumes
where it left off after a dropped connection or a closed tab.
