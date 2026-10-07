import { useRun } from "agent-unit";

/** Counts a side effect in app state, so tests can prove it ran once across restarts. */
export async function countEffect(name: string): Promise<number> {
  const run = useRun();
  const count = ((await run.state.get<number>(name, { scope: "app" })) ?? 0) + 1;
  await run.state.set(name, count, { scope: "app" });
  return count;
}

/** Records the idempotency key of the step or tool call running now, so tests can check it exists on every host. */
export async function recordKey(name: string, key = useRun().idempotencyKey()): Promise<void> {
  await useRun().state.set(name, key, { scope: "app" });
}

export async function readEffect(name: string): Promise<number | string> {
  return (await useRun().state.get<number | string>(name, { scope: "app" })) ?? 0;
}
