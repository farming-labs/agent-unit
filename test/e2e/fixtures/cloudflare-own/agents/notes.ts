import { defineAgent } from "agent-unit";
import { env } from "agent-unit/env";

// Uses the app's own Durable Object from inside a run, next to agent-unit's.
export default defineAgent(async (_input, run) =>
  run.step("store", async () => {
    const store = env.NOTES.get(env.NOTES.idFromName("demo"));
    return (await store.fetch("https://notes/save")).text();
  }),
);
