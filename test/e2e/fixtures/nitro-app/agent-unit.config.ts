import { defineConfig } from "agent-unit";

export default defineConfig({
  name: "nitro-app",
  storage: { driver: "fs-lite", base: process.env.AGENT_UNIT_DATA ?? ".data/agent-unit" },
  tasks: {
    // An agent task inside the app's Nitro build, as Farm's agent integration builds one. Once a year
    // unless a test that starts the scheduler sets a schedule.
    "scheduled-approval": {
      schedule: process.env.APPROVAL_SCHEDULE ?? "0 0 1 1 *",
      agent: "approver",
      input: { item: process.env.APPROVAL_ITEM ?? "unset" },
    },
  },
});
