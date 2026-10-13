import { defineAgent } from "agent-unit";

export default defineAgent(async (input: { name?: string }, run) => {
  const name = await run.step("name", () => input.name ?? "world");
  return `hello ${name}`;
});
