import type { ListRunsFilter } from "../runtime/store";
import type { AgentCard, AgentEvent, Manifest, RunInput, RunRecord } from "../types";

/**
 * What the HTTP API needs from a runtime. `RunEngine` implements it in-process; the Durable Objects
 * runtime implements it by routing each run to its own object.
 */
export interface RunService {
  manifest(): Manifest;
  agentCard(name: string): AgentCard;
  start(agent: string, input?: RunInput, options?: { threadId?: string; id?: string }): Promise<{ run: RunRecord; done: Promise<RunRecord | undefined> }>;
  resume(id: string, answer: unknown): Promise<{ run: RunRecord; done: Promise<RunRecord | undefined> }>;
  cancel(id: string): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord>;
  listRuns(filter?: ListRunsFilter): Promise<RunRecord[]>;
  events(id: string, after?: number, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  env(): Record<string, string | undefined>;
  /** Internal: continue a yielded or stalled run. Runtimes with their own scheduler omit it. */
  continue?(id: string): Promise<RunRecord | undefined>;
  /** Internal: wake due sleepers and recover stalled runs. Runtimes with their own scheduler omit it. */
  sweep?(): Promise<{ woken: string[]; recovered: string[]; deleted: string[]; settled: Promise<void> }>;
  /** Deletes a finished run with its journal and events. */
  deleteRun?(id: string): Promise<void>;
}
