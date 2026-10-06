import { defineAgent } from "agent-unit";

// Sleeps without holding a process, then continues.
export default defineAgent({
  description: "Waits, then sends a reminder.",
  async run(input, run) {
    const seconds = Number(input.seconds ?? 5);
    await run.sleep(seconds * 1000);
    return { reminded: true, after: `${seconds}s` };
  },
});
