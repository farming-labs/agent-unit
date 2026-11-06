import { setImmediate } from "node:timers/promises";
import { createStorage } from "unstorage";
import memory from "unstorage/drivers/memory";
import { expect, it } from "vitest";
import { defineAgent, functionAdapter, resolveAgent } from "../packages/runtime/src/agents";
import { RunEngine } from "../packages/runtime/src/runtime/engine";
import { RunStore } from "../packages/runtime/src/runtime/store";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("resumes after an interrupt is visible while its execution is still settling", async () => {
  const published = deferred();
  const release = deferred();
  const store = new RunStore(createStorage({ driver: memory() }));
  const putRun = store.putRun.bind(store);
  let held = false;
  store.putRun = async (...args) => {
    const result = await putRun(...args);
    if (result && args[0].status === "interrupted" && !held) {
      held = true;
      published.resolve();
      await release.promise;
    }
    return result;
  };
  const agent = defineAgent(async (input, run) => {
    const order = await run.step("look up order", () => ({ id: input.orderId }));
    const { approved } = await run.interrupt<{ approved: boolean }>("approve-refund", order);
    return approved ? `refunded ${order.id}` : `kept ${order.id}`;
  });
  const engine = new RunEngine({
    store,
    agents: [resolveAgent("refund", agent, [functionAdapter])],
  });
  try {
    const first = await engine.start("refund", { orderId: "A1" });
    await published.promise;
    expect((await engine.getRun(first.run.id)).status).toBe("interrupted");
    const resuming = engine.resume(first.run.id, { approved: true });
    // Drain the in-memory storage operations while the prior execution is held at its write.
    await setImmediate();
    release.resolve();
    await first.done;
    const resumed = await resuming;
    expect(await resumed.done).toMatchObject({
      status: "completed",
      output: "refunded A1",
      attempt: 2,
    });
  } finally {
    release.resolve();
    engine.close();
  }
});
