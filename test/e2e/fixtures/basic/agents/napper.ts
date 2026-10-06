import { defineAgent } from "agent-unit";

export default defineAgent(async (input, run) => {
  const before = await run.step("before", () => Date.now());
  await run.sleep(Number(input.ms ?? 300));
  const after = await run.step("after", () => Date.now());
  return { slept: after - before >= Number(input.ms ?? 300) };
});
