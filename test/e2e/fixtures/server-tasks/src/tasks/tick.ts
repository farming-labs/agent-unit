import { waitUntil } from "agent-unit/env";
import { followUps, runs } from "../state";

export default ({ name, scheduledTime }: { name: string; scheduledTime: number }) => {
  runs.push({ name, scheduledTime });
  // Follow-up work outlives the task's own run.
  waitUntil(new Promise((resolve) => setTimeout(resolve, 20)).then(() => void followUps.push(scheduledTime)));
  return { run: runs.length };
};
