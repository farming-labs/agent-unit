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
| `REASONING_START` / `REASONING_END` | `messageId` | The model's reasoning begins / ends |
| `REASONING_MESSAGE_START` | `messageId`, `role: "reasoning"` | A reasoning message begins |
| `REASONING_MESSAGE_CONTENT` | `messageId`, `delta` | Streamed reasoning |
| `REASONING_MESSAGE_END` | `messageId` | The reasoning message is complete |
| `TOOL_CALL_START` | `toolCallId`, `toolCallName` | A tool call begins |
| `TOOL_CALL_ARGS` | `toolCallId`, `delta` | Tool arguments (JSON text) |
| `TOOL_CALL_END` | `toolCallId` | Arguments are complete |
| `TOOL_CALL_RESULT` | `toolCallId`, `content` | The tool's result (JSON text) |
| `STEP_STARTED` / `STEP_FINISHED` | `stepName` | A durable step began or finished (not emitted on replay) |
| `CUSTOM` | `name`, `value` | Emitted by agent code via `run.emit` |
| `RUN_FINISHED` | `result`, `usage?` | Terminal: the run completed. `usage` lists token usage per provider and model (AG-UI `TokenUsage`) |
| `RUN_ERROR` | `message`, `code?` | Terminal: the run failed |
| **`RUN_INTERRUPTED`** | `interrupt: { key, name, payload }` | Parked: waiting for an answer |
| **`RUN_SLEEPING`** | `wakeAt` | Parked: waiting for a time |
| **`RUN_CANCELLED`** | | Terminal: the run was cancelled |

Reasoning comes from every adapter that sees it: AI SDK and Mastra reasoning parts, OpenAI Agents
reasoning items and summary deltas, LangGraph reasoning and thinking blocks. Token usage counts the
model calls a run made live (a replayed call was counted when it ran) and is also on the run record
as `usage`; after a crash, calls the crashed execution finished are not counted.

Consecutive `TEXT_MESSAGE_CONTENT` deltas of one message (and `REASONING_MESSAGE_CONTENT` deltas, and `TOOL_CALL_ARGS` deltas of one call)
that arrive within a short window (50ms by default) are merged into one event before it gets its
`seq`, so live and replayed streams are identical and a long answer is a few events, not one per
token. Concatenating the deltas of a message always gives its full text.

`RUN_INTERRUPTED`, `RUN_SLEEPING` and `RUN_CANCELLED` are the agent-unit extensions. AG-UI clients
that do not know them ignore them, as AG-UI requires.

## Delivery rules

1. Events are stored as they are emitted, so a reader that connects late receives the full history.
2. A resumed run continues the same sequence: the first event after a resume has the next `seq`.
3. Replay never duplicates events. Work replayed from the journal (see
   [durability.md](./durability.md)) does not emit again.
4. A stream ends after a terminal or parked event.
