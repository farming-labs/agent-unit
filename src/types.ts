// The contract types from spec/. Everything a client, UI or service can rely on.

export type RunStatus = "running" | "interrupted" | "sleeping" | "completed" | "failed" | "cancelled";

export interface PendingInterrupt {
  key: string;
  name: string;
  payload: unknown;
}

export interface RunRecord {
  id: string;
  agent: string;
  threadId: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  error?: { name: string; message: string };
  interrupt?: PendingInterrupt;
  wakeAt?: string;
  /** Set when a cancel arrived while another process was executing the run; that executor finishes the cancel. */
  cancelRequested?: boolean;
  attempt: number;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EventBase {
  type: string;
  seq: number;
  runId: string;
  timestamp: number;
}

export type AgentEventBody =
  | { type: "RUN_STARTED"; threadId: string; agent: string }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string }
  | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string }
  | { type: "TOOL_CALL_RESULT"; toolCallId: string; content: string }
  | { type: "STEP_STARTED"; stepName: string }
  | { type: "STEP_FINISHED"; stepName: string }
  | { type: "CUSTOM"; name: string; value: unknown }
  | { type: "RUN_FINISHED"; result: unknown }
  | { type: "RUN_ERROR"; message: string; code?: string }
  | { type: "RUN_INTERRUPTED"; interrupt: PendingInterrupt }
  | { type: "RUN_SLEEPING"; wakeAt: string }
  | { type: "RUN_CANCELLED" };

export type AgentEvent = AgentEventBody & EventBase;

/** Events after which a stream ends: the run finished or parked. */
export const SETTLING_EVENTS: ReadonlySet<string> = new Set([
  "RUN_FINISHED",
  "RUN_ERROR",
  "RUN_INTERRUPTED",
  "RUN_SLEEPING",
  "RUN_CANCELLED",
]);

export interface ToolCard {
  name: string;
  description?: string;
}

export interface AgentCard {
  name: string;
  description?: string;
  framework: string;
  tools: ToolCard[];
  input?: unknown;
}

export interface Manifest {
  version: 1;
  name: string;
  agents: AgentCard[];
}

export interface RunInput {
  messages?: Array<{ role: string; content: unknown }>;
  [key: string]: unknown;
}
