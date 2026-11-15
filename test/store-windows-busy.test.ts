import { createStorage, type Driver } from "unstorage";
import memory from "unstorage/drivers/memory";
import { afterEach, describe, expect, it } from "vitest";
import { defineAgent, functionAdapter, resolveAgent } from "../packages/runtime/src/agents";
import { RunEngine } from "../packages/runtime/src/runtime/engine";
import { RunStore, retryBusyWrites } from "../packages/runtime/src/runtime/store";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
function asPlatform(name: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { ...platform, value: name });
}
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
});

function codedError(code: string) {
  return Object.assign(new Error(`${code}: operation not permitted, rename '.unstorage-tmp' -> 'run'`), { code });
}

/**
 * Memory storage whose run record writes fail like a Windows rename over a file a reader holds open:
 * the first `failures` writes of each `runs:` key throw `code`.
 */
function busyStorage(code: string, failures: number) {
  const driver = memory();
  const counts = new Map<string, number>();
  let thrown = 0;
  const busy: Driver = {
    ...driver,
    setItem(key, value, options) {
      if (key.startsWith("runs:")) {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (count <= failures) {
          thrown++;
          throw codedError(code);
        }
      }
      return driver.setItem!(key, value, options);
    },
  };
  return { storage: createStorage({ driver: busy }), thrown: () => thrown };
}

function refundEngine(store: RunStore) {
  const agent = defineAgent(async (input: { orderId: string }, run) => {
    const order = await run.step("look up order", () => ({ id: input.orderId }));
    const { approved } = await run.interrupt<{ approved: boolean }>("approve-refund", order);
    return approved ? `refunded ${order.id}` : `kept ${order.id}`;
  });
  return new RunEngine({ store, agents: [resolveAgent("refund", agent, [functionAdapter])] });
}

describe("run writes on Windows", () => {
  it("retries a run write that a concurrent reader made busy", async () => {
    asPlatform("win32");
    const { storage, thrown } = busyStorage("EPERM", 3);
    const engine = refundEngine(new RunStore(storage));
    try {
      const first = await engine.start("refund", { orderId: "A1" });
      expect(await first.done).toMatchObject({ status: "interrupted" });
      const resumed = await engine.resume(first.run.id, { approved: true });
      expect(await resumed.done).toMatchObject({ status: "completed", output: "refunded A1" });
      expect(thrown()).toBe(3);
    } finally {
      engine.close();
    }
  });

  it("rethrows a busy error unchanged once the retry budget is spent", async () => {
    const { storage, thrown } = busyStorage("EBUSY", Number.POSITIVE_INFINITY);
    const wrapped = retryBusyWrites(storage, "win32");
    const started = Date.now();
    await expect(wrapped.setItem("runs:run_a", { id: "run_a" })).rejects.toMatchObject({ code: "EBUSY" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(thrown()).toBeGreaterThan(1);
  });

  it("does not retry errors that are not busy-file errors", async () => {
    const { storage, thrown } = busyStorage("ENOSPC", 1);
    const wrapped = retryBusyWrites(storage, "win32");
    await expect(wrapped.setItem("runs:run_a", { id: "run_a" })).rejects.toMatchObject({ code: "ENOSPC" });
    expect(thrown()).toBe(1);
  });

  it("does not retry on other platforms", async () => {
    asPlatform("linux");
    const { storage, thrown } = busyStorage("EPERM", 1);
    const store = new RunStore(storage);
    expect(store.storage).toBe(storage);
    await expect(store.storage.setItem("runs:run_a", { id: "run_a" })).rejects.toMatchObject({ code: "EPERM" });
    expect(thrown()).toBe(1);
  });

  it("keeps one wrapper per storage so stores share one write queue", () => {
    const { storage } = busyStorage("EPERM", 0);
    const wrapped = retryBusyWrites(storage, "win32");
    expect(wrapped).not.toBe(storage);
    expect(retryBusyWrites(storage, "win32")).toBe(wrapped);
    expect(retryBusyWrites(wrapped, "win32")).toBe(wrapped);
  });

  it("lets a write replaced on the wrapper call through without looping", async () => {
    const { storage } = busyStorage("EPERM", 0);
    const wrapped = retryBusyWrites(storage, "win32");
    const writes: string[] = [];
    const setItem = wrapped.setItem.bind(wrapped);
    wrapped.setItem = ((key: string, value: never) => {
      writes.push(key);
      return setItem(key, value);
    }) as typeof wrapped.setItem;
    await wrapped.setItem("runs:run_a", { id: "run_a" });
    expect(writes).toEqual(["runs:run_a"]);
    expect(await storage.getItem("runs:run_a")).toEqual({ id: "run_a" });
  });
});
