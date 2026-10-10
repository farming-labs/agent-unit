import { defineAgent } from "agent-unit";
import { env } from "agent-unit/env";

export default defineAgent(async (input, run) => {
  const messages = (input.messages ?? []) as { content: string }[];
  const name = messages.at(-1)?.content ?? String(input.name ?? "world");
  // The host's environment through agent-unit/env, on every host this fixture is built for, agreeing with run.secrets.
  const greeting = env.GREETING ?? "hello";
  if (greeting !== (run.secrets.get("GREETING") ?? "hello")) throw new Error("agent-unit/env and run.secrets disagree");
  return `${greeting} ${name}`;
});
