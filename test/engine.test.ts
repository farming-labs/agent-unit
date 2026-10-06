import { describe, expect, it } from "vitest";
import { defineAgent } from "../src/agents";
import { decode, encode } from "../src/runtime/serialize";
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
