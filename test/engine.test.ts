import { describe, expect, it } from "vitest";
import { defineAgent } from "../src/agents";
import { durableTool } from "../src/adapter/durable";
import { useRun } from "../src/runtime/context";
import { decode, encode } from "../src/runtime/serialize";
import { RunStore } from "../src/runtime/store";
import { collect, createEngine, memoryStore, types } from "./helpers";

describe("durable run engine", () => {
  it("runs an agent to completion and streams its events", async () => {
    const engine = createEngine({
      hello: defineAgent(async (input, run) => {
        const name = await run.step("lookup", () => String(input.name ?? "world"));
        return `hello ${name}`;
      }),
    });
    const { run, done } = await engine.start("hello", { name: "farm" });
    const events = await collect(engine.events(run.id));
    const final = await done;

    expect(types(events)).toEqual(["RUN_STARTED", "STEP_STARTED", "STEP_FINISHED", "RUN_FINISHED"]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(final).toMatchObject({ status: "completed", output: "hello farm", attempt: 1, eventCount: 4 });
  });

  it("parks on an interrupt and resumes without repeating completed steps", async () => {
    const calls = { charge: 0, email: 0 };
    const engine = createEngine({
      refund: defineAgent(async (input, run) => {
        const order = await run.step("load-order", () => ({ id: input.orderId, amount: 40 }));
        const decision = await run.interrupt<{ approved: boolean }>("approve-refund", order);
        if (!decision.approved) return "declined";
        await run.step("charge", () => ++calls.charge);
        await run.step("email", () => ++calls.email);
        return "refunded";
      }),
    });

    const { run, done } = await engine.start("refund", { orderId: "o_1" });
    const parked = await done;
    expect(parked).toMatchObject({ status: "interrupted", interrupt: { name: "approve-refund", payload: { id: "o_1", amount: 40 } } });
    expect(calls).toEqual({ charge: 0, email: 0 });

    const resumed = await engine.resume(run.id, { approved: true });
    const finished = await resumed.done;
    expect(finished).toMatchObject({ status: "completed", output: "refunded", attempt: 2 });
    expect(calls).toEqual({ charge: 1, email: 1 });

    const events = await collect(engine.events(run.id));
    // The second execution replays load-order silently: no duplicate STEP events, one continuous sequence.
    expect(types(events)).toEqual([
      "RUN_STARTED",
      "STEP_STARTED",
      "STEP_FINISHED",
      "RUN_INTERRUPTED",
      "STEP_STARTED",
      "STEP_FINISHED",
      "STEP_STARTED",
      "STEP_FINISHED",
      "RUN_FINISHED",
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("continues a parked run in a brand-new engine (a restart) from the shared store", async () => {
    let sideEffects = 0;
    const agent = defineAgent(async (_input, run) => {
      await run.step("side-effect", () => ++sideEffects);
      const answer = await run.interrupt<string>("confirm");
      await run.step("after", () => ++sideEffects);
      return answer;
    });
    const store = memoryStore();
    const first = createEngine({ agent }, { store });
    const { run, done } = await first.start("agent");
    await done;
    expect(sideEffects).toBe(1);

    const second = createEngine({ agent }, { store });
    const resumed = await second.resume(run.id, "yes");
    expect(await resumed.done).toMatchObject({ status: "completed", output: "yes" });
    expect(sideEffects).toBe(2);
  });

  it("rejects resuming a run that is not interrupted", async () => {
    const engine = createEngine({ quick: defineAgent(async () => "done") });
    const { run, done } = await engine.start("quick");
    await done;
    await expect(engine.resume(run.id, true)).rejects.toMatchObject({ status: 409, code: "run_not_interrupted" });
  });

  it("parks a sleeping run and wakes it with the sweep", async () => {
    let woke = 0;
    const engine = createEngine({
      napper: defineAgent(async (_input, run) => {
        await run.sleep("1h");
        await run.step("after-sleep", () => ++woke);
        return "rested";
      }),
    });
    const { run, done } = await engine.start("napper");
    const parked = await done;
    expect(parked?.status).toBe("sleeping");
    expect(Date.parse(parked!.wakeAt!)).toBeGreaterThan(Date.now() + 3_500_000);

    expect((await engine.sweep()).woken).toEqual([]);
    const { woken } = await engine.sweep(Date.now() + 3_700_000);
    expect(woken).toEqual([run.id]);
    await engine.idle(run.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await engine.getRun(run.id)).toMatchObject({ status: "completed", output: "rested" });
    expect(woke).toBe(1);
    engine.close();
  });

  it("wakes short sleeps in-process with a timer", async () => {
    const engine = createEngine({
      napper: defineAgent(async (_input, run) => {
        await run.sleep(30);
        return "awake";
      }),
    });
    const { run, done } = await engine.start("napper");
    expect((await done)?.status).toBe("sleeping");
    const events = await collect(engine.events(run.id, 0));
    expect(types(events).at(-1)).toBe("RUN_SLEEPING");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await engine.idle(run.id);
    expect(await engine.getRun(run.id)).toMatchObject({ status: "completed", output: "awake" });
  });

  it("yields at a step boundary when over budget and continues without repeating work", async () => {
    const executed: number[] = [];
    const engine = createEngine(
      {
        long: defineAgent(async (_input, run) => {
          for (let i = 0; i < 5; i++) {
            await run.step(`chunk-${i}`, async () => {
              await new Promise((resolve) => setTimeout(resolve, 15));
              executed.push(i);
            });
          }
          return "all chunks";
        }),
      },
      { budgetMs: 20 },
    );
    const { done } = await engine.start("long");
    const final = await done;
    expect(final).toMatchObject({ status: "completed", output: "all chunks" });
    expect(executed).toEqual([0, 1, 2, 3, 4]);
    expect(final!.attempt).toBeGreaterThan(1);
  });

  it("hands a yielded run to continueRun instead of continuing in-process", async () => {
    const continued: string[] = [];
    const engine = createEngine(
      {
        long: defineAgent(async (_input, run) => {
          await run.step("a", () => new Promise((resolve) => setTimeout(resolve, 20)));
          await run.step("b", () => 1);
          return "ok";
        }),
      },
      { budgetMs: 5, continueRun: (id) => void continued.push(id) },
    );
    const { run, done } = await engine.start("long");
    expect((await done)?.status).toBe("running");
    expect(continued).toEqual([run.id]);
    // The continuation (a fresh invocation) picks it up and finishes.
    const engine2 = createEngine({ long: engine["agents"].get("long")!.agent }, { store: engine.store });
    expect(await engine2.continue(run.id)).toMatchObject({ status: "completed", output: "ok" });
  });

  it("cancels an interrupted run", async () => {
    const engine = createEngine({ waiter: defineAgent(async (_input, run) => run.interrupt("never")) });
    const { run, done } = await engine.start("waiter");
    await done;
    const cancelled = await engine.cancel(run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(types(await collect(engine.events(run.id))).at(-1)).toBe("RUN_CANCELLED");
  });

  it("cancels a running run through its abort signal", async () => {
    const engine = createEngine({
      slow: defineAgent(async (_input, run) => {
        await run.step("wait", () => new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          run.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(run.signal.reason);
          });
        }));
        return "never";
      }),
    });
    const { run, done } = await engine.start("slow");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await engine.cancel(run.id);
    expect(await done).toMatchObject({ status: "cancelled" });
  });

  it("records failures with RUN_ERROR", async () => {
    const engine = createEngine({
      broken: defineAgent(async () => {
        throw new TypeError("boom");
      }),
    });
    const { run, done } = await engine.start("broken");
    expect(await done).toMatchObject({ status: "failed", error: { name: "TypeError", message: "boom" } });
    expect(types(await collect(engine.events(run.id))).at(-1)).toBe("RUN_ERROR");
  });

  it("replays a journaled step error instead of re-running the step", async () => {
    let attempts = 0;
    const engine = createEngine({
      flaky: defineAgent(async (_input, run) => {
        try {
          await run.step("fails", () => {
            attempts++;
            throw new Error("nope");
          });
        } catch (error) {
          await run.interrupt("after-error", (error as Error).message);
        }
        return "handled";
      }),
    });
    const { run, done } = await engine.start("flaky");
    expect(await done).toMatchObject({ status: "interrupted", interrupt: { payload: "nope" } });
    const resumed = await engine.resume(run.id, null);
    expect(await resumed.done).toMatchObject({ status: "completed", output: "handled" });
    expect(attempts).toBe(1);
  });

  it("streams events after a cursor, as a reconnecting client would", async () => {
    const engine = createEngine({
      chatty: defineAgent(async (_input, run) => {
        run.emit("progress", { pct: 50 });
        run.emit("progress", { pct: 100 });
        return "ok";
      }),
    });
    const { run, done } = await engine.start("chatty");
    await done;
    const tail = await collect(engine.events(run.id, 2));
    expect(tail.map((event) => event.seq)).toEqual([3, 4]);
    expect(tail[0]).toMatchObject({ type: "CUSTOM", name: "progress", value: { pct: 100 } });
  });

  it("scopes state to the thread, the agent or the app", async () => {
    const engine = createEngine({
      counter: defineAgent(async (_input, run) => {
        const count = ((await run.state.get<number>("count")) ?? 0) + 1;
        await run.state.set("count", count);
        await run.state.set("total", ((await run.state.get<number>("total", { scope: "app" })) ?? 0) + 1, { scope: "app" });
        return count;
      }),
    });
    const a1 = await (await engine.start("counter", {}, { threadId: "a" })).done;
    const a2 = await (await engine.start("counter", {}, { threadId: "a" })).done;
    const b1 = await (await engine.start("counter", {}, { threadId: "b" })).done;
    expect([a1?.output, a2?.output, b1?.output]).toEqual([1, 2, 1]);
    expect(await engine.store.getState("app", "app", "total")).toBe(3);
  });

  it("lists runs by agent, status and thread", async () => {
    const engine = createEngine({ a: defineAgent(async () => 1), b: defineAgent(async (_i, run) => run.interrupt("x")) });
    await (await engine.start("a", {}, { threadId: "t" })).done;
    await (await engine.start("b")).done;
    expect((await engine.listRuns({ agent: "a" })).length).toBe(1);
    expect((await engine.listRuns({ status: "interrupted" }))[0]?.agent).toBe("b");
    expect((await engine.listRuns({ threadId: "t" })).length).toBe(1);
  });
});

describe("serialisation", () => {
  it("round-trips values JSON cannot hold", () => {
    const value = {
      when: new Date("2026-10-06T00:00:00.000Z"),
      big: 12345678901234567890n,
      map: new Map([["a", 1]]),
      set: new Set(["x"]),
      bytes: new Uint8Array([1, 2, 3]),
      missing: undefined,
      list: [undefined, 1],
      error: new RangeError("bad"),
    };
    const restored = decode(JSON.parse(JSON.stringify(encode(value)))) as typeof value;
    expect(restored.when).toEqual(value.when);
    expect(restored.big).toBe(value.big);
    expect(restored.map.get("a")).toBe(1);
    expect(restored.set.has("x")).toBe(true);
    expect([...restored.bytes]).toEqual([1, 2, 3]);
    expect(restored.list).toEqual([undefined, 1]);
    expect(restored.error).toBeInstanceOf(Error);
    expect(restored.error.name).toBe("RangeError");
  });
});

describe("module-scope construction", () => {
  it("builds an engine without random values or timers (Workers forbid both at global scope)", () => {
    const random = crypto.getRandomValues;
    const realSetTimeout = globalThis.setTimeout;
    crypto.getRandomValues = (() => {
      throw new Error("random at global scope");
    }) as typeof crypto.getRandomValues;
    globalThis.setTimeout = (() => {
      throw new Error("timer at global scope");
    }) as unknown as typeof setTimeout;
    try {
      expect(() => createEngine({ agent: defineAgent(() => "ok") })).not.toThrow();
    } finally {
      crypto.getRandomValues = random;
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe("host scheduling", () => {
  it("accepts a caller-chosen run id and rejects duplicates and malformed ids", async () => {
    const engine = createEngine({ hello: defineAgent(() => "hi") });
    const { run, done } = await engine.start("hello", {}, { id: "run_customid00000000000" });
    expect(run.id).toBe("run_customid00000000000");
    expect(await done).toMatchObject({ status: "completed" });
    await expect(engine.start("hello", {}, { id: "run_customid00000000000" })).rejects.toMatchObject({ status: 409 });
    await expect(engine.start("hello", {}, { id: "../escape" })).rejects.toMatchObject({ status: 400 });
  });

  it("uses scheduleWake for sleeps, yields and the execution watchdog instead of in-process timers", async () => {
    const wakes: { id: string; at: number }[] = [];
    let steps = 0;
    const engine = createEngine(
      {
        nap: defineAgent(async (_input, run) => {
          await run.step("before", () => ++steps);
          await run.sleep("3h");
          return "rested";
        }),
        long: defineAgent(async (_input, run) => {
          for (let i = 0; i < 3; i++) await run.step(`part-${i}`, () => new Promise((resolve) => setTimeout(() => resolve(++steps), 15)));
          return "done";
        }),
      },
      { budgetMs: 10, scheduleWake: (id, at) => void wakes.push({ id, at }) },
    );

    const before = Date.now();
    const nap = await engine.start("nap");
    expect(await nap.done).toMatchObject({ status: "sleeping" });
    // One watchdog while executing, then the wake time: no local timer, whatever the duration.
    const napWakes = wakes.filter((wake) => wake.id === nap.run.id);
    expect(napWakes).toHaveLength(2);
    expect(napWakes[0]!.at).toBeGreaterThanOrEqual(before + engine.leaseMs);
    expect(napWakes[1]!.at).toBeGreaterThanOrEqual(before + 3 * 3_600_000);

    // A yield asks the host to continue now rather than continuing in this process.
    const long = await engine.start("long");
    expect(await long.done).toMatchObject({ status: "running" });
    const yielded = wakes.filter((wake) => wake.id === long.run.id).at(-1)!;
    expect(yielded.at).toBeLessThanOrEqual(Date.now());
    // The host's alarm then continues it.
    let run = await engine.continue(long.run.id);
    while (run?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 0));
      run = await engine.continue(long.run.id);
    }
    expect(run).toMatchObject({ status: "completed", output: "done" });
    engine.close();
  });
});

describe("custom schedulers", () => {
  it("drives sleeps and yields through handleWake from any scheduler", async () => {
    // A stand-in for a queue or job runner: it records wake-ups, and the test fires them.
    const scheduled: { id: string; at: number }[] = [];
    let parts = 0;
    const engine = createEngine(
      {
        nap: defineAgent(async (_input, run) => {
          await run.sleep(30);
          return "rested";
        }),
        long: defineAgent(async (_input, run) => {
          for (let i = 0; i < 3; i++) await run.step(`part-${i}`, () => new Promise((resolve) => setTimeout(() => resolve(++parts), 15)));
          return parts;
        }),
      },
      { budgetMs: 10, scheduleWake: (id, at) => void scheduled.push({ id, at }) },
    );
    const fire = async (id: string) => {
      const next = await engine.handleWake(id);
      if (next !== undefined) scheduled.push({ id, at: next });
    };

    const nap = await engine.start("nap");
    await nap.done;
    // Too early: nothing happens, and it asks to be called again at the wake time.
    await fire(nap.run.id);
    expect((await engine.getRun(nap.run.id)).status).toBe("sleeping");
    expect(scheduled.at(-1)!.at).toBe(Date.parse((await engine.getRun(nap.run.id)).wakeAt!));
    await new Promise((resolve) => setTimeout(resolve, 40));
    await fire(nap.run.id);
    expect(await engine.getRun(nap.run.id)).toMatchObject({ status: "completed", output: "rested" });

    const long = await engine.start("long");
    await long.done;
    for (let i = 0; i < 10 && (await engine.getRun(long.run.id)).status === "running"; i++) await fire(long.run.id);
    expect(await engine.getRun(long.run.id)).toMatchObject({ status: "completed", output: 3 });
    expect(await engine.handleWake(long.run.id)).toBeUndefined();
    engine.close();
  });
});

describe("exactly-once execution", () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const orphan = async (engine: ReturnType<typeof createEngine>, agent: string, extra: Partial<import("../src/types").RunRecord> = {}) => {
    const id = "run_orphan000000000000";
    const now = new Date().toISOString();
    await engine.store.putRun({ id, agent, threadId: id, status: "running", input: {}, attempt: 1, eventCount: 1, createdAt: now, updatedAt: now, ...extra });
    return id;
  };

  it("never executes one run twice when triggers race in one process", async () => {
    let charges = 0;
    const engine = createEngine({
      charge: defineAgent(async (_input, run) => {
        await run.step("charge", async () => {
          await pause(20);
          return ++charges;
        });
        return charges;
      }),
    });
    const id = await orphan(engine, "charge");
    // A double resume, a timer and a sweep all landing at once.
    await Promise.all([engine.continue(id), engine.continue(id), engine.handleWake(id)]);
    await engine.idle(id);
    expect(charges).toBe(1);
    expect(await engine.getRun(id)).toMatchObject({ status: "completed", output: 1 });
  });

  it("keeps the lease alive through a step longer than the lease, so no one else repeats it", async () => {
    let charges = 0;
    const store = memoryStore();
    const agent = defineAgent(async (_input, run) => {
      await run.step("slow-charge", async () => {
        await pause(250);
        return ++charges;
      });
      return charges;
    });
    const a = createEngine({ agent }, { store, leaseMs: 60 });
    const b = createEngine({ agent }, { store, leaseMs: 60 });
    const { run, done } = await a.start("agent");
    await pause(150); // well past one lease length, mid-step
    await b.continue(run.id);
    await b.handleWake(run.id);
    expect(await done).toMatchObject({ status: "completed", output: 1 });
    expect(charges).toBe(1);
  });

  it("stops writing once another execution takes its lease", async () => {
    const store = memoryStore();
    const engine = createEngine(
      {
        slow: defineAgent(async (_input, run) => {
          await run.step("first", () => pause(200));
          await run.step("second", () => 2);
          return "done";
        }),
      },
      { store, leaseMs: 60 },
    );
    const { run, done } = await engine.start("slow");
    await pause(30);
    // Another process took the run over (its lease, its turn to write).
    await store.storage.setItem(`lease:${run.id}`, { owner: "other-process", until: Date.now() + 60_000 } as never);
    expect(await done).toBeUndefined();
    const record = await store.getRun(run.id);
    expect(record?.status).toBe("running");
    const events = await store.readEvents(run.id);
    expect(events.map((event) => event.type)).not.toContain("RUN_FINISHED");
  });

  it("numbers events after the ones already stored when it recovers from a crash", async () => {
    const engine = createEngine({ quick: defineAgent(async (_input, run) => run.step("one", () => 1)) });
    const id = await orphan(engine, "quick");
    // The crashed execution had stored events 2..5 but never updated the record (eventCount: 1).
    await engine.store.appendEvents(id, [{ type: "RUN_STARTED", threadId: id, agent: "quick", seq: 1, runId: id, timestamp: Date.now() }]);
    const crashed = [2, 3, 4, 5].map((seq) => ({ type: "CUSTOM", name: "before-crash", value: seq, seq, runId: id, timestamp: Date.now() }));
    await engine.store.appendEvents(id, crashed as never);
    const final = await engine.continue(id);
    const events = await engine.store.readEvents(id);
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...new Set(seqs)].sort((x, y) => x - y));
    expect(events.filter((event) => event.type === "CUSTOM")).toHaveLength(4);
    expect(seqs.at(-1)).toBe(final?.eventCount);
    // The recovered execution's first event comes after the crashed one's last.
    const recovered = events.filter((event) => event.type !== "CUSTOM" && event.type !== "RUN_STARTED");
    expect(Math.min(...recovered.map((event) => event.seq))).toBe(6);
  });

  it("lets the executing process carry out a cancel sent to another process", async () => {
    const store = memoryStore();
    const agent = defineAgent(async (_input, run) => {
      for (let i = 0; i < 40; i++) await run.step(`part-${i}`, () => pause(30));
      return "finished";
    });
    const a = createEngine({ agent }, { store });
    const b = createEngine({ agent }, { store });
    const { run, done } = await a.start("agent");
    await pause(100);
    const requested = await b.cancel(run.id);
    expect(requested).toMatchObject({ status: "running", cancelRequested: true });
    const final = await done;
    expect(final).toMatchObject({ status: "cancelled" });
    expect(final?.cancelRequested).toBeUndefined();
    const events = await store.readEvents(run.id);
    const seqs = events.map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events.filter((event) => event.type === "RUN_CANCELLED")).toHaveLength(1);
    expect(events.map((event) => event.type)).not.toContain("RUN_FINISHED");
  });
});

describe("hardening (0.1.4)", () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("logs a storage failure during a timed wake instead of crashing the process", async () => {
    const { vi } = await import("vitest");
    const store = memoryStore();
    const engine = createEngine({ nap: defineAgent(async (_input, run) => run.sleep(20)) }, { store });
    await (await engine.start("nap")).done;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getItem = store.storage.getItem.bind(store.storage);
    store.storage.getItem = (async () => {
      throw new Error("redis is down");
    }) as typeof store.storage.getItem;
    await pause(60);
    store.storage.getItem = getItem;
    expect(errors.mock.calls.some((call) => String(call[0]).includes("could not wake"))).toBe(true);
    errors.mockRestore();
    engine.close();
  });

  it("lets only one of two racing resumes through", async () => {
    let charges = 0;
    const engine = createEngine({
      refund: defineAgent(async (_input, run) => {
        const decision = await run.interrupt<string>("approve");
        await run.step("charge", () => ++charges);
        return decision;
      }),
    });
    const { run, done } = await engine.start("refund");
    await done;
    const results = await Promise.allSettled([engine.resume(run.id, "first"), engine.resume(run.id, "second")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    const winner = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{ done: Promise<unknown> }>;
    await winner.value.done;
    expect(charges).toBe(1);
    expect((await engine.getRun(run.id)).output).toBe("first");
  });

  it("answers a cancel promptly even when the running step ignores the abort signal", async () => {
    const engine = createEngine(
      { stubborn: defineAgent(async (_input, run) => run.step("slow", () => pause(400))) },
      { cancelWaitMs: 50 },
    );
    const { run, done } = await engine.start("stubborn");
    await pause(20);
    const started = Date.now();
    const answer = await engine.cancel(run.id);
    expect(Date.now() - started).toBeLessThan(300);
    expect(answer).toMatchObject({ status: "running", cancelRequested: true });
    expect(await done).toMatchObject({ status: "cancelled" });
  });

  it("fails a run whose executions keep crashing instead of retrying forever", async () => {
    const engine = createEngine({ quick: defineAgent(() => "ok") }, { maxCrashes: 3 });
    const now = new Date().toISOString();
    const id = "run_crashloop000000000";
    await engine.store.putRun({ id, agent: "quick", threadId: id, status: "running", input: {}, attempt: 2, eventCount: 1, createdAt: now, updatedAt: now, executing: true, crashes: 2 });
    const final = await engine.continue(id);
    expect(final).toMatchObject({ status: "failed", error: { name: "RunCrashed" }, crashes: 3 });
    // A clean execution clears the streak.
    const ok = await (await engine.start("quick")).done;
    expect(ok?.executing).toBeUndefined();
    expect(ok?.crashes).toBeUndefined();
  });

  it("wakes every due sleeper, oldest first, even with more than a thousand of them", async () => {
    const store = memoryStore();
    const engine = createEngine({ nap: defineAgent(async (_input, run) => run.sleep("1h")) }, { store });
    const base = Date.now() - 10 * 60_000;
    for (let i = 0; i < 1005; i++) {
      const id = `run_sleeper${String(i).padStart(10, "0")}`;
      const created = new Date(base + i * 100).toISOString();
      // Older runs wake earlier; the newest five are not due yet.
      const wakeAt = new Date(i < 1000 ? base + i : Date.now() + 3_600_000).toISOString();
      await store.putRun({ id, agent: "nap", threadId: id, status: "sleeping", wakeAt, input: {}, attempt: 1, eventCount: 2, createdAt: created, updatedAt: created });
    }
    const due = await store.dueSleepers();
    expect(due).toHaveLength(1000);
    expect(due[0]).toBe("run_sleeper0000000000");
    expect(await store.listRuns({ status: "sleeping", limit: 3 })).toHaveLength(3);
    engine.close();
  });

  it("reads events in order and stops at a gap until the run has settled", async () => {
    const store = memoryStore();
    const event = (seq: number) => ({ type: "CUSTOM", name: "e", value: seq, seq, runId: "run_gaps00000000000000", timestamp: 0 });
    await store.appendEvents("run_gaps00000000000000", [event(1), event(2), event(4)] as never);
    expect((await store.readEvents("run_gaps00000000000000")).map((e) => e.seq)).toEqual([1, 2]);
    expect((await store.readEvents("run_gaps00000000000000", 0, 4)).map((e) => e.seq)).toEqual([1, 2, 4]);
  });

  it("writes one journal entry per step and still reads journals stored as one key", async () => {
    const store = memoryStore();
    const writes: string[] = [];
    const setItem = store.storage.setItem.bind(store.storage);
    store.storage.setItem = ((key: string, value: never) => {
      writes.push(key);
      return setItem(key, value);
    }) as typeof store.storage.setItem;
    const engine = createEngine(
      { steps: defineAgent(async (_input, run) => { for (let i = 0; i < 5; i++) await run.step(`s${i}`, () => i); return "ok"; }) },
      { store },
    );
    const run = (await (await engine.start("steps")).done)!;
    expect(writes.filter((key) => key.startsWith(`steps:${run.id}`))).toHaveLength(5);
    expect(writes.filter((key) => key === `journal:${run.id}`)).toHaveLength(0);

    await store.storage.setItem("journal:run_legacy00000000000", { "legacy#0": { kind: "step", value: 1 } } as never);
    await store.putJournalEntry("run_legacy00000000000", "new#0", { kind: "step", value: 2 });
    expect(Object.keys(await store.getJournal("run_legacy00000000000")).sort()).toEqual(["legacy#0", "new#0"]);
  });

  it("indexes runs stored before the index existed", async () => {
    const store = memoryStore();
    const now = new Date().toISOString();
    await store.storage.setItem("runs:run_old000000000000000", { id: "run_old000000000000000", agent: "a", threadId: "t", status: "completed", input: {}, attempt: 1, eventCount: 2, createdAt: now, updatedAt: now } as never);
    expect((await store.listRuns()).map((run) => run.id)).toEqual(["run_old000000000000000"]);
    expect(await store.listRuns({ status: "completed" })).toHaveLength(1);
  });
});

describe("state keys", () => {
  it("keeps threads apart even when their ids contain characters storage keys treat specially", async () => {
    const engine = createEngine({
      note: defineAgent(async (input, run) => {
        await run.state.set("note", input.note);
        return run.state.get("note");
      }),
    });
    const a = await (await engine.start("note", { note: "a" }, { threadId: "t?x" })).done;
    const b = await (await engine.start("note", { note: "b" }, { threadId: "t?y" })).done;
    const c = await (await engine.start("note", { note: "c" }, { threadId: "t:x/z" })).done;
    expect([a?.output, b?.output, c?.output]).toEqual(["a", "b", "c"]);
    expect(await engine.store.getState("thread", "t?x", "note")).toBe("a");
    expect(await engine.store.getState("thread", "t?y", "note")).toBe("b");
  });

  it("still reads state stored before keys were encoded", async () => {
    const store = memoryStore();
    await store.storage.setItem("state:app:shop:counter", 7 as never);
    expect(await store.getState("app", "shop", "counter")).toBe(7);
    await store.deleteState("app", "shop", "counter");
    expect(await store.getState("app", "shop", "counter")).toBeUndefined();
  });
});

describe("two processes, one run", () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const twoProcesses = (agents: Record<string, unknown>) => {
    const shared = memoryStore().storage;
    // Separate engines and stores over one storage: two servers sharing Redis, say.
    return [createEngine(agents, { store: new RunStore(shared) }), createEngine(agents, { store: new RunStore(shared) })] as const;
  };

  it("lets one of two resumes from different processes win, with its own answer", async () => {
    let charges = 0;
    const [a, b] = twoProcesses({
      refund: defineAgent(async (_input, run) => {
        const decision = await run.interrupt<string>("approve");
        await run.step("charge", () => ++charges);
        return decision;
      }),
    });
    const { run, done } = await a.start("refund");
    await done;
    const results = await Promise.allSettled([a.resume(run.id, "from-a"), b.resume(run.id, "from-b")]);
    const winners = results.filter((result) => result.status === "fulfilled") as PromiseFulfilledResult<{ done: Promise<unknown> }>[];
    expect(winners).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    await winners[0]!.value.done;
    const final = await a.getRun(run.id);
    expect(final.status).toBe("completed");
    expect(final.output).toBe(results[0]!.status === "fulfilled" ? "from-a" : "from-b");
    expect(charges).toBe(1);
  });

  it("never loses an approve or a cancel that race from different processes", async () => {
    for (let round = 0; round < 5; round++) {
      let finished = 0;
      const [a, b] = twoProcesses({
        refund: defineAgent(async (_input, run) => {
          await run.interrupt("approve");
          for (let i = 0; i < 30; i++) await run.step(`work-${i}`, () => pause(15));
          return ++finished;
        }),
      });
      const { run, done } = await a.start("refund");
      await done;
      const [resumed] = await Promise.allSettled([a.resume(run.id, "yes"), b.cancel(run.id)]);
      if (resumed.status === "fulfilled") await (resumed.value as { done: Promise<unknown> }).done;
      // Either the cancel came first (and the resume got 409), or the run took the cancel while working.
      const final = await a.getRun(run.id);
      expect(final.status).toBe("cancelled");
      expect(finished).toBe(0);
      const events = await a.store.readEvents(run.id, 0, final.eventCount);
      const seqs = events.map((event) => event.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(events.filter((event) => event.type === "RUN_CANCELLED")).toHaveLength(1);
    }
  });

  it("refuses a write based on a stale read", async () => {
    const store = memoryStore();
    const now = new Date().toISOString();
    const base = { id: "run_versioned000000000", agent: "x", threadId: "t", status: "interrupted" as const, input: {}, attempt: 1, eventCount: 2, createdAt: now, updatedAt: now };
    expect(await store.putRun({ ...base }, null)).toBe(true);
    const read = (await store.getRun(base.id))!;
    expect(await store.putRun({ ...read, status: "running" }, read)).toBe(true);
    // A second writer still holding the old read is refused instead of overwriting.
    expect(await store.putRun({ ...read, status: "cancelled" }, read)).toBe(false);
    expect((await store.getRun(base.id))!.status).toBe("running");
    expect(await store.putRun({ ...base }, null)).toBe(false);
  });
});

describe("storage leases", () => {
  it("does not recreate a lease on renew once it was released", async () => {
    const store = memoryStore();
    expect(await store.acquireLease("run_a", "owner-1", 60_000)).toBe(true);
    expect(await store.renewLease("run_a", "owner-1", 60_000)).toBe(true);
    await store.releaseLease("run_a", "owner-1");
    expect(await store.renewLease("run_a", "owner-1", 60_000)).toBe(false);
    expect(await store.leaseExpired("run_a")).toBe(true);
  });
});

describe("idempotency keys", () => {
  /** A stand-in for a payment API that honours idempotency keys, like Stripe. */
  function paymentProvider() {
    const charges = new Map<string, number>();
    return {
      charges,
      charge(amount: number, key: string) {
        if (!charges.has(key)) charges.set(key, amount);
        return { id: `ch_${key.slice(0, 6)}`, amount: charges.get(key)! };
      },
    };
  }

  it("gives a step the same key when it runs again after a crash, so the provider charges once", async () => {
    const provider = paymentProvider();
    const keys: string[] = [];
    const store = memoryStore();
    const engine = createEngine(
      {
        pay: defineAgent(async (_input, run) =>
          run.step("charge", ({ idempotencyKey }) => {
            keys.push(idempotencyKey);
            return provider.charge(42, idempotencyKey);
          }),
        ),
      },
      { store },
    );
    const { run, done } = await engine.start("pay");
    expect(await done).toMatchObject({ status: "completed" });

    // The process died after the charge but before the step was journaled: the step runs again.
    await store.deleteJournalEntry(run.id, "charge#0");
    const record = (await store.getRun(run.id))!;
    await store.putRun({ ...record, status: "running", output: undefined });
    expect(await engine.continue(run.id)).toMatchObject({ status: "completed" });

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(provider.charges.size).toBe(1);
  });

  it("gives every step, repeat and run its own key", async () => {
    const keys: string[] = [];
    const engine = createEngine({
      many: defineAgent(async (_input, run) => {
        await run.step("a", ({ idempotencyKey }) => void keys.push(idempotencyKey));
        await run.step("a", ({ idempotencyKey }) => void keys.push(idempotencyKey));
        await run.step("b", ({ idempotencyKey }) => void keys.push(idempotencyKey));
        // Inside a step, useRun() reports the same key the step received.
        await run.step("c", ({ idempotencyKey }) => void keys.push(idempotencyKey === useRun().idempotencyKey() ? idempotencyKey : "mismatch"));
      }),
    });
    await (await engine.start("many")).done;
    await (await engine.start("many")).done;
    expect(keys).toHaveLength(8);
    expect(keys).not.toContain("mismatch");
    expect(new Set(keys).size).toBe(8);
  });

  it("exposes the key inside journaled tool calls, and refuses outside a step", async () => {
    const provider = paymentProvider();
    const keys: string[] = [];
    const store = memoryStore();
    // A tool the framework calls with its own tool call id, as AI SDK, Mastra and OpenAI Agents do.
    const refund = durableTool("refund", async (amount: number, _options: { toolCallId: string }) => {
      keys.push(useRun().idempotencyKey());
      return provider.charge(-amount, useRun().idempotencyKey());
    }, { toolCallId: (_amount, options) => options.toolCallId });
    let outside: unknown;
    const engine = createEngine(
      {
        support: defineAgent(async () => {
          try {
            useRun().idempotencyKey();
          } catch (error) {
            outside = error;
          }
          return refund(42, { toolCallId: "call_1" });
        }),
      },
      { store },
    );
    const { run, done } = await engine.start("support");
    expect(await done).toMatchObject({ status: "completed" });
    expect(String(outside)).toMatch(/only available inside run\.step\(\) or a tool call/);

    await store.deleteJournalEntry(run.id, "tool:refund:call_1");
    const record = (await store.getRun(run.id))!;
    await store.putRun({ ...record, status: "running", output: undefined });
    expect(await engine.continue(run.id)).toMatchObject({ status: "completed" });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(provider.charges.size).toBe(1);
  });
});

describe("steps inside tool calls", () => {
  const refundTool = (charges: string[]) =>
    durableTool("refund", async (order: string, _options: { toolCallId: string }) =>
      useRun().step("charge", () => {
        charges.push(order);
        return `refunded ${order}`;
      }),
    { toolCallId: (_order, options) => options.toolCallId });

  it("numbers steps within their tool call, so a replayed tool cannot hand its step to the next one", async () => {
    const charges: string[] = [];
    const refund = refundTool(charges);
    const store = memoryStore();
    const engine = createEngine(
      {
        support: defineAgent(async () => [await refund("o_1", { toolCallId: "call_1" }), await refund("o_2", { toolCallId: "call_2" })]),
      },
      { store },
    );
    const { run, done } = await engine.start("support");
    expect(await done).toMatchObject({ status: "completed" });

    // The process died during the second tool call: its outcome was never journaled.
    const journal = await store.getJournal(run.id);
    for (const key of Object.keys(journal).filter((key) => key.startsWith("tool:refund:call_2"))) await store.deleteJournalEntry(run.id, key);
    const record = (await store.getRun(run.id))!;
    await store.putRun({ ...record, status: "running", output: undefined });
    // On recovery the first tool replays without running its body; the second one must still charge o_2.
    expect(await engine.continue(run.id)).toMatchObject({ status: "completed", output: ["refunded o_1", "refunded o_2"] });
    expect(charges).toEqual(["o_1", "o_2", "o_2"]);
  });

  it("keeps run-wide numbering for runs started before scoped keys, so their journals still match", async () => {
    const support = defineAgent(async () => {
      const ask = durableTool("ask", async (_options: { toolCallId: string }) => useRun().interrupt<string>("approve"), {
        toolCallId: (options) => options.toolCallId,
      });
      return ask({ toolCallId: "call_1" });
    });
    const engine = createEngine({ support });
    const { done } = await engine.start("support");
    expect(await done).toMatchObject({ status: "interrupted", interrupt: { key: "tool:ask:call_1/interrupt:approve#0" } });

    // A run paused by 0.1.6: no stepKeys on the record, and the interrupt under its run-wide key.
    const store = memoryStore();
    const now = new Date().toISOString();
    const id = "run_legacy00000000000";
    await store.putRun({ id, agent: "support", threadId: id, status: "interrupted", input: {}, attempt: 1, eventCount: 2, createdAt: now, updatedAt: now, interrupt: { key: "interrupt:approve#0", name: "approve", payload: null } });
    const resumed = await createEngine({ support }, { store }).resume(id, "yes");
    expect(await resumed.done).toMatchObject({ status: "completed", output: "yes" });
  });
});

describe("leases left behind", () => {
  it("resumes at once when the process that paused the run stopped before releasing its lease", async () => {
    const store = memoryStore();
    const agents = {
      refund: defineAgent(async (_input, run) => {
        const answer = await run.interrupt<string>("approve");
        return run.step("charge", () => `charged ${answer}`);
      }),
    };
    // The first process is killed after saving the pause but before releasing its lease.
    const dying = new RunStore(store.storage);
    dying.releaseLease = async () => {};
    const { run, done } = await createEngine(agents, { store: dying }).start("refund");
    expect(await done).toMatchObject({ status: "interrupted" });
    expect(await store.leaseExpired(run.id)).toBe(false);

    const next = createEngine(agents, { store });
    const resumed = await next.resume(run.id, "yes");
    expect(await resumed.done).toMatchObject({ status: "completed", output: "charged yes" });
  });

  it("still waits for the lease of an execution that never recorded its end", async () => {
    const store = memoryStore();
    const agents = { long: defineAgent(async (_input, run) => run.step("work", () => "done")) };
    const now = new Date().toISOString();
    const id = "run_crashed0000000000";
    // Crashed mid-run: still marked executing, its lease still live.
    await store.putRun({ id, agent: "long", threadId: id, status: "running", input: {}, attempt: 1, eventCount: 1, executing: true, lastLease: "old:1", createdAt: now, updatedAt: now });
    await store.acquireLease(id, "old:2", 60_000);
    const engine = createEngine(agents, { store });
    expect(await engine.continue(id)).toMatchObject({ status: "running" });
    expect(await store.leaseExpired(id)).toBe(false);
  });
});
