import { defineAgent } from "agent-unit";

export default defineAgent(async (input, run) => {
  const decision = await run.interrupt<{ approved: boolean }>("approve", { item: input.item });
  return decision.approved ? `approved ${input.item}` : `declined ${input.item}`;
});
