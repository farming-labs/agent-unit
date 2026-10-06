import { defineAgent } from "agent-unit";

export default defineAgent(async (input, run) => {
  const messages = (input.messages ?? []) as { content: string }[];
  const name = messages.at(-1)?.content ?? String(input.name ?? "world");
  const secret = run.secrets.get("GREETING") ?? "hello";
  return `${secret} ${name}`;
});
