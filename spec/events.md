# Events

Runs stream [AG-UI](https://docs.ag-ui.com) events, so existing AG-UI clients render them. Three
extension types cover what AG-UI does not define: a run parking for a human, a run sleeping, and a
run being cancelled.

## Envelope

Every event carries:

```ts
interface EventBase {
  type: string;
  seq: number;        // 1-based, strictly increasing per run, never reused
  runId: string;
  timestamp: number;  // ms since epoch
}
```

Over SSE each event is one message: `id:` is `seq`, `data:` is the JSON event.

## Types

| Type | Fields | Meaning |
| --- | --- | --- |
| `RUN_STARTED` | `threadId`, `agent` | Emitted once, when the run is created |
| `TEXT_MESSAGE_START` | `messageId`, `role: "assistant"` | A message begins |
| `TEXT_MESSAGE_CONTENT` | `messageId`, `delta` | Streamed text |
| `TEXT_MESSAGE_END` | `messageId` | The message is complete |
| `TOOL_CALL_START` | `toolCallId`, `toolCallName` | A tool call begins |
| `TOOL_CALL_ARGS` | `toolCallId`, `delta` | Tool arguments (JSON text) |
| `TOOL_CALL_END` | `toolCallId` | Arguments are complete |
| `TOOL_CALL_RESULT` | `toolCallId`, `content` | The tool's result (JSON text) |
| `STEP_STARTED` / `STEP_FINISHED` | `stepName` | A durable step began or finished (not emitted on replay) |
| `CUSTOM` | `name`, `value` | Emitted by agent code via `run.emit` |
| `RUN_FINISHED` | `result` | Terminal: the run completed |
| `RUN_ERROR` | `message`, `code?` | Terminal: the run failed |
| **`RUN_INTERRUPTED`** | `interrupt: { key, name, payload }` | Parked: waiting for an answer |
| **`RUN_SLEEPING`** | `wakeAt` | Parked: waiting for a time |
| **`RUN_CANCELLED`** | | Terminal: the run was cancelled |

`RUN_INTERRUPTED`, `RUN_SLEEPING` and `RUN_CANCELLED` are the agent-unit extensions. AG-UI clients
that do not know them ignore them, as AG-UI requires.

## Delivery rules

1. Events are stored as they are emitted, so a reader that connects late receives the full history.
2. A resumed run continues the same sequence: the first event after a resume has the next `seq`.
3. Replay never duplicates events. Work replayed from the journal (see
   [durability.md](./durability.md)) does not emit again.
4. A stream ends after a terminal or parked event.
