import { createStorage } from "unstorage";
import memory from "unstorage/drivers/memory";
import { expect, it } from "vitest";
import { RunStore } from "../packages/runtime/src/runtime/store";
import type { RunRecord, RunStatus } from "../packages/runtime/src/types";

const createdAt = "2026-11-18T00:00:00.000Z";
const record = (status: RunStatus): RunRecord => ({
  id: "run_a",
  agent: "refund",
  threadId: "thread_a",
  status,
  input: { orderId: "A1" },
  attempt: 1,
  eventCount: 0,
  createdAt,
  updatedAt: createdAt,
});

/** A store that lists runs by status at the moment each write of the run's record lands. */
async function watchRecordWrites() {
  const storage = createStorage({ driver: memory() });
  const store = new RunStore(storage);
  // In a running app the index is built already, so the first listing does not rebuild it.
  await store.listRuns();
  const seen: { status: RunStatus; listed: string[] }[] = [];
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (async (key: string, value: unknown, options?: unknown) => {
    await setItem(key, value as never, options as never);
    if (key !== "runs:run_a") return;
    const { status } = value as RunRecord;
    seen.push({ status, listed: (await store.listRuns({ status })).map((run) => run.id) });
  }) as typeof storage.setItem;
  return { store, seen };
}

it("lists a run under its new status as soon as its record shows that status", async () => {
  const { store, seen } = await watchRecordWrites();
  await store.putRun(record("running"), null);
  expect(await store.putRun(record("interrupted"), await store.getRun("run_a"))).toBe(true);
  await store.putRun(record("completed"));

  expect(seen).toEqual([
    { status: "running", listed: ["run_a"] },
    { status: "interrupted", listed: ["run_a"] },
    { status: "completed", listed: ["run_a"] },
  ]);
});

it("takes back the index entries of a conditional write that lost", async () => {
  const store = new RunStore(createStorage({ driver: memory() }));
  await store.putRun(record("running"), null);
  const previous = (await store.getRun("run_a"))!;
  expect(await store.putRun(record("completed"), previous)).toBe(true);
  expect(await store.putRun(record("interrupted"), previous)).toBe(false);

  expect(await store.listRuns({ status: "interrupted" })).toEqual([]);
  expect(await store.listRuns({ status: "running" })).toEqual([]);
  expect((await store.listRuns()).map((run) => run.status)).toEqual(["completed"]);
  expect((await store.listRuns({ status: "completed" })).map((run) => run.version)).toEqual([2]);
});
