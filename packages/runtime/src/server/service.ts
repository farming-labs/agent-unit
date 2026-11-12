import type { HandleWakeOptions, ResumeOptions } from "../runtime/engine";
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
  /** `options.interrupt`: the key of the interrupt being answered; another one pending is a 409. */
  resume(id: string, answer: unknown, options?: ResumeOptions): Promise<{ run: RunRecord; done: Promise<RunRecord | undefined> }>;
  cancel(id: string): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord>;
  listRuns(filter?: ListRunsFilter): Promise<RunRecord[]>;
  events(id: string, after?: number, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  env(): Record<string, string | undefined>;
  /** Internal: continue a yielded or stalled run. Runtimes with their own scheduler omit it. */
  continue?(id: string): Promise<RunRecord | undefined>;
  /** Internal: what a clock's wake-up does for a run, and when to check it again. Runtimes with their own scheduler omit it. */
  handleWake?(id: string, options?: HandleWakeOptions): Promise<number | undefined>;
  /** Internal: wake due sleepers and recover stalled runs. Runtimes with their own scheduler omit it. */
  sweep?(): Promise<{ woken: string[]; recovered: string[]; deleted: string[]; settled: Promise<void> }>;
  /** Deletes a finished run with its journal and events. */
  deleteRun?(id: string): Promise<void>;
}
