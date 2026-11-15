import type { RunInput, RunRecord } from "@agent-unit/runtime";
import { startScheduledRun, type RunService } from "@agent-unit/runtime/server";
import { Cron } from "croner";

// Internal: what a generated agent task runs on each fire. Not a package export; the generated task
// imports this file by path, as it does the server and runtime entries.

/** A fire this much before a scheduled time (at most half the interval) still counts for that time. */
const EARLY_MS = 30_000;

/**
 * The scheduled time a fire at `now` belongs to: the schedule's latest time at or before `now`, read
 * the way the host's scheduler reads it (the process's time zone, which is UTC on Workers and Vercel).
 * Schedulers pass no scheduled time of their own, and some fire late, so the time comes from the
 * schedule. A fire slightly early counts for the time it is about to reach.
 */
export function scheduledTime(schedule: string, now = Date.now()): number {
  const cron = new Cron(schedule, { paused: true });
  try {
    const [next, after] = cron.nextRuns(2, new Date(now - 1));
    const early = next && after ? Math.min(EARLY_MS, (after.getTime() - next.getTime()) / 2) : 0;
    // previousRuns drops the reference's milliseconds and returns times strictly before that second,
    // so ask from the start of the next second: a time in the limit's own second then counts.
    const [previous] = cron.previousRuns(1, new Date(Math.floor((now + early) / 1000) * 1000 + 1000));
    if (!previous) throw new Error(`agent-unit: the schedule "${schedule}" has no time at or before ${new Date(now).toISOString()}.`);
    return previous.getTime();
  } finally {
    cron.stop();
  }
}

export interface AgentTask {
  name: string;
  agent: string;
  schedule: string;
  input?: RunInput;
}

export interface AgentTaskResult {
  run: string;
  /** The run's status when this fire stops waiting on it. */
  status: RunRecord["status"];
  scheduledAt: string;
  /** False when an earlier fire for the same scheduled time had started the run. */
  started: boolean;
}

/** One fire of an agent task: starts the agent for this scheduled time, once, and waits for this execution to stop. */
export async function runAgentTask(service: RunService, task: AgentTask, now = Date.now()): Promise<AgentTaskResult> {
  const scheduledAt = scheduledTime(task.schedule, now);
  const { run, done, started } = await startScheduledRun(service, task, scheduledAt);
  const settled = (await done) ?? run;
  return { run: run.id, status: settled.status, scheduledAt: new Date(scheduledAt).toISOString(), started };
}
