import { useRun } from "agent-unit";

/** Counts a side effect in app state, so tests can prove it ran once across restarts. */
export async function countEffect(name: string): Promise<number> {
  const run = useRun();
  const count = ((await run.state.get<number>(name, { scope: "app" })) ?? 0) + 1;
  await run.state.set(name, count, { scope: "app" });
  return count;
}

export async function readEffect(name: string): Promise<number> {
  return (await useRun().state.get<number>(name, { scope: "app" })) ?? 0;
}
