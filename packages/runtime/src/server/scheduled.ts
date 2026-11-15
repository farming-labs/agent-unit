import type { AgentUnitError } from "../runtime/engine";
import type { RunInput, RunRecord } from "../types";
import type { RunService } from "./service";

// A task that runs an agent on a schedule: each scheduled time starts one run. The run's id comes
// from the task's name and that time, so a scheduler that fires twice for the same time (a retry, one
// scheduler per process in a cluster) finds the run the first fire started instead of starting another.

export interface ScheduledRunTask {
  /** The task's name in `tasks`. */
  name: string;
  /** The agent each fire runs. */
  agent: string;
  input?: RunInput;
}

export interface ScheduledRunResult {
  run: RunRecord;
  /** Settles when this execution stops. Already settled when `started` is false. */
  done: Promise<RunRecord | undefined>;
  /** False when an earlier fire for the same scheduled time already started the run. */
  started: boolean;
}

const encoder = new TextEncoder();

/** `run_` and 32 hex characters of the SHA-256 of the task and its scheduled time, in UTC. */
export async function scheduledRunId(task: string, scheduledAt: number): Promise<string> {
  if (!Number.isFinite(scheduledAt)) throw new TypeError(`agent-unit: the scheduled time of task "${task}" is not a time.`);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`agent-unit-task-v1\n${task}\n${new Date(scheduledAt).toISOString()}`));
  return `run_${Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Starts the task's agent for `scheduledAt` (ms since the epoch), once per scheduled time. */
export async function startScheduledRun(service: RunService, task: ScheduledRunTask, scheduledAt: number): Promise<ScheduledRunResult> {
  const id = await scheduledRunId(task.name, scheduledAt);
  let started: { run: RunRecord; done: Promise<RunRecord | undefined> };
  try {
    started = await service.start(task.agent, task.input ?? {}, { id });
  } catch (error) {
    // By code, not class: a runtime that routes runs elsewhere (a Durable Object) rebuilds its errors.
    if ((error as Partial<AgentUnitError> | undefined)?.code !== "run_exists") throw error;
    const run = await service.getRun(id);
    return { run, done: Promise.resolve(run), started: false };
  }
  // A runtime that chose its own id would let a second fire start a second run.
  if (started.run.id !== id) {
    throw new Error(`agent-unit: this runtime started task "${task.name}" as run ${started.run.id} instead of ${id}, so a repeated fire could start the agent twice.`);
  }
  return { ...started, started: true };
}
