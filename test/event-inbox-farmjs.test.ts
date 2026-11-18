import { afterEach, describe, expect, it } from "vitest";
import { farmjsStore } from "../packages/runtime/src/server/farmjs-store";
import { defineAgent, functionAdapter, resolveAgent } from "../packages/runtime/src/agents";
import { RunEngine } from "../packages/runtime/src/runtime/engine";
import { startFakeFarmjsStore } from "./fakes/farmjs-store";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

describe("event inbox over the Farm.js store HTTP contract", () => {
  it("uses atomic claims across independent HTTP clients", async () => {
    const server = await startFakeFarmjsStore();
    cleanup.push(() => server.close());
    const stores = [farmjsStore({ env: server.env }), farmjsStore({ env: server.env })];
    const event = { id: "same", name: "paid", data: 42, sentAt: new Date().toISOString() };
    const accepted = await Promise.all(stores.map((store) => store.putEvent(event)));
    expect(accepted.filter(Boolean)).toHaveLength(1);
    expect(await stores[0]!.eventsSince("paid", 0)).toEqual([event]);
    expect(
      server.opsRequests
        .flat()
        .some((op) => op.op === "cas" && String(op.key).startsWith("inbox:by-id:")),
    ).toBe(true);
  });

  it("parks and resumes with a maximum-length ASCII name and ID", async () => {
    const server = await startFakeFarmjsStore();
    cleanup.push(() => server.close());
    const name = "a".repeat(200);
    const agent = defineAgent(async (_input, run) => run.waitFor(name));
    const engine = new RunEngine({
      store: farmjsStore({ env: server.env }),
      agents: [resolveAgent("checkout", agent, [functionAdapter])],
    });
    cleanup.push(() => engine.close());
    const started = await engine.start("checkout", {});
    expect((await started.done)?.status).toBe("waiting");
    const sent = await engine.send(name, { paid: true }, { id: "b".repeat(200) });
    await sent.done;
    expect((await engine.getRun(started.run.id)).output).toEqual({ paid: true });
  });
});
