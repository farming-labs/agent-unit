import { describe, expect, it, vi } from "vitest";
import { createStorage } from "unstorage";
import { RunStore } from "../packages/runtime/src/runtime/store";

const event = (id = "retry", name = "paid", sentAt = 1000) => ({
  id,
  name,
  sentAt: new Date(sentAt).toISOString(),
  data: { amount: 42 },
});

describe("event inbox coordination", () => {
  it("accepts one concurrent send across stores sharing storage", async () => {
    const storage = createStorage();
    const stores = [new RunStore(storage), new RunStore(storage)];
    const accepted = await Promise.all(
      stores.map((store, i) => store.putEvent({ ...event(), data: { amount: i } })),
    );
    expect(accepted.filter(Boolean)).toHaveLength(1);
    expect(await stores[0]!.eventsSince("paid", 0)).toEqual([
      { ...event(), data: { amount: accepted.indexOf(true) } },
    ]);
  });

  it.each(["a".repeat(200), "界".repeat(200)])(
    "bounds keys for maximum-length input %s",
    async (text) => {
      const storage = createStorage();
      const write = storage.setItem.bind(storage);
      vi.spyOn(storage, "setItem").mockImplementation(async (key, value) => {
        if (new TextEncoder().encode(key).length > 512) throw new Error("Infra key limit");
        return write(key, value);
      });
      const store = new RunStore(storage);
      const sent = event(text, text);
      expect(await store.putEvent(sent)).toBe(true);
      expect(await store.eventsSince(text, 0)).toEqual([sent]);
    },
  );

  it("does not expose a losing payload with a different timestamp or name", async () => {
    const storage = createStorage();
    const store = new RunStore(storage);
    const accepted = await Promise.all([
      store.putEvent(event()),
      store.putEvent(event("retry", "other", 1001)),
    ]);
    expect(accepted.filter(Boolean)).toHaveLength(1);
    const kept = [
      ...(await store.eventsSince("paid", 0)),
      ...(await store.eventsSince("other", 0)),
    ];
    expect(kept).toHaveLength(1);
    expect(kept[0]!.name).toBe(accepted[0] ? "paid" : "other");
  });

  it("retries after an index write fails without reserving the ID", async () => {
    const storage = createStorage();
    const store = new RunStore(storage);
    vi.spyOn(storage, "setItem").mockRejectedValueOnce(new Error("unavailable"));
    await expect(store.putEvent(event())).rejects.toThrow("unavailable");
    expect(await store.putEvent(event())).toBe(true);
    expect(await store.eventsSince("paid", 0)).toEqual([event()]);
  });

  it("ignores an unclaimed index and retries a failed conditional write", async () => {
    const storage = createStorage();
    const broken = new RunStore(storage, {
      atomic: {
        compareAndSet: async () => {
          throw new Error("unavailable");
        },
      },
    });
    await expect(broken.putEvent(event())).rejects.toThrow("unavailable");
    expect(await broken.eventsSince("paid", 0)).toEqual([]);
    const store = new RunStore(storage);
    expect(await store.putEvent(event())).toBe(true);
    expect(await store.eventsSince("paid", 0)).toEqual([event()]);
  });

  it("prunes events and permits reuse after retention", async () => {
    const storage = createStorage();
    const store = new RunStore(storage);
    await store.putEvent(event());
    await store.pruneEvents(1001);
    expect(await storage.getKeys("inbox")).toEqual([]);
    expect(await store.putEvent(event("retry", "paid", 1002))).toBe(true);
    expect(await store.eventsSince("paid", 1001)).toEqual([event("retry", "paid", 1002)]);
  });
});
