import { afterEach, describe, expect, it, vi } from "vitest";
import { defineAgent } from "../packages/runtime/src/agents";
import { InterruptTimeoutError } from "../packages/runtime/src/runtime/context";
import type { ApprovalRegistry } from "../packages/runtime/src/runtime/engine";
import { farmApprovals } from "../packages/runtime/src/server/farmjs";
import type { PendingInterrupt, RunRecord } from "../packages/runtime/src/types";
import { collect, createEngine, memoryStore, types } from "./helpers";

// `run.interrupt(name, payload, { timeout })`: the wait ends through the same wake-ups as a sleep
// (sweep, in-process timer, host scheduler), and the replayed call throws InterruptTimeoutError.

const engines: { close(): void }[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.close();
  globalThis.fetch = realFetch;
});

const HOUR = 3_600_000;
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Approves within the timeout, or falls back to declining. */
const refund = (timeout: number | string = "1h") =>
  defineAgent(async (_input, run) => {
    await run.step("load-order", () => ({ id: "o_1" }));
    try {
      const { approved } = await run.interrupt<{ approved: boolean }>("approve-refund", { amount: 40 }, { timeout });
      return approved ? "refunded" : "declined";
    } catch (error) {
      if (!(error instanceof InterruptTimeoutError)) throw error;
      await run.step("notify-timeout", () => error.expiresAt);
      return `timed out at ${error.expiresAt}`;
    }
  });

function engineWith(agents: Record<string, unknown>, options: Parameters<typeof createEngine>[1] = {}) {
  const engine = createEngine(agents, options);
  engines.push(engine);
  return engine;
}

describe("interrupt timeouts", () => {
  it("parks with a deadline and ends the wait from the sweep once it passes", async () => {
    const engine = engineWith({ refund: refund() });
    const before = Date.now();
    const { run, done } = await engine.start("refund");
    const parked = await done;
    expect(parked).toMatchObject({ status: "interrupted", interrupt: { name: "approve-refund" } });
    const expiresAt = Date.parse(parked!.interrupt!.expiresAt!);
    expect(expiresAt).toBeGreaterThanOrEqual(before + HOUR);
    expect(parked!.wakeAt).toBe(parked!.interrupt!.expiresAt);

    // Not yet due: the sweep leaves it waiting.
    expect((await engine.sweep()).woken).toEqual([]);
    const { woken, settled } = await engine.sweep(expiresAt + 1);
    expect(woken).toEqual([run.id]);
    await settled;
    const finished = await engine.getRun(run.id);
    expect(finished).toMatchObject({ status: "completed", output: `timed out at ${parked!.interrupt!.expiresAt}` });
    expect(finished.wakeAt).toBeUndefined();
    expect(finished.interrupt).toBeUndefined();

    const events = await collect(engine.events(run.id));
    // load-order replays silently; the timeout branch's step runs once.
    expect(types(events)).toEqual(["RUN_STARTED", "STEP_STARTED", "STEP_FINISHED", "RUN_INTERRUPTED", "STEP_STARTED", "STEP_FINISHED", "RUN_FINISHED"]);
    expect(events.find((event) => event.type === "RUN_INTERRUPTED")).toMatchObject({ interrupt: { expiresAt: parked!.interrupt!.expiresAt } });
  });

  it("fails the run with InterruptTimeoutError when the agent does not catch it", async () => {
    const engine = engineWith({
      strict: defineAgent(async (_input, run) => run.interrupt("approve", undefined, { timeout: 30 })),
    });
    const { run, done } = await engine.start("strict");
    expect((await done)?.status).toBe("interrupted");
    // A short timeout ends in-process, with the sleep timer.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await engine.idle(run.id);
    expect(await engine.getRun(run.id)).toMatchObject({
      status: "failed",
      error: { name: "InterruptTimeoutError", message: expect.stringContaining('The interrupt "approve" got no answer by') },
    });
  });

  it("lets an answer before the deadline win; the later wake changes nothing", async () => {
    const engine = engineWith({ refund: refund(40) });
    const { run, done } = await engine.start("refund");
    await done;
    const resumed = await engine.resume(run.id, { approved: true });
    expect(await resumed.done).toMatchObject({ status: "completed", output: "refunded" });
    expect((await engine.getRun(run.id)).wakeAt).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await engine.handleWake(run.id)).toBeUndefined();
    expect((await engine.sweep(Date.now() + HOUR)).woken).toEqual([]);
    expect(await engine.getRun(run.id)).toMatchObject({ status: "completed", output: "refunded" });
  });

  it("refuses an answer that arrives after the deadline ended the wait", async () => {
    const engine = engineWith({ refund: refund() });
    const { run, done } = await engine.start("refund");
    const parked = await done;
    await (await engine.sweep(Date.parse(parked!.interrupt!.expiresAt!) + 1)).settled;
    await expect(engine.resume(run.id, { approved: true })).rejects.toMatchObject({ status: 409, code: "run_not_interrupted" });
    expect((await engine.getRun(run.id)).output).toMatch(/^timed out at /);
  });

  it("never lets a timer left in another process cut the run's next sleep short", async () => {
    const store = memoryStore();
    const agent = defineAgent(async (_input, run) => {
      const answer = await run.interrupt<string>("approve", undefined, { timeout: 60 });
      await run.sleep("1h");
      return answer;
    });
    const a = engineWith({ agent }, { store });
    const b = engineWith({ agent }, { store });
    const { run, done } = await a.start("agent");
    expect(await done).toMatchObject({ status: "interrupted" });
    // Answered on another instance, the run goes on to sleep for an hour.
    expect(await (await b.resume(run.id, "yes")).done).toMatchObject({ status: "sleeping" });
    // The deadline timer this instance set fires, and leaves the sleep alone.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await a.getRun(run.id)).toMatchObject({ status: "sleeping" });
  });

  it("ends the wait when the deadline passes while the parked run is still being saved", async () => {
    const store = memoryStore();
    const putRun = store.putRun.bind(store);
    store.putRun = async (record, previous) => {
      // The interrupted record lands after its 10 ms deadline, as on a slow store.
      if (record.status === "interrupted") await new Promise((resolve) => setTimeout(resolve, 50));
      return putRun(record, previous);
    };
    const engine = engineWith({ refund: refund(10) }, { store });
    const { run, done } = await engine.start("refund");
    expect(await done).toMatchObject({ status: "interrupted" });
    await vi.waitFor(async () =>
      expect(await engine.getRun(run.id)).toMatchObject({ status: "completed", output: expect.stringMatching(/^timed out at /) }),
    );
  });

  it("sets the timer again when it fires before the deadline by the clock", async () => {
    const engine = engineWith({ refund: refund(30) });
    const { run, done } = await engine.start("refund");
    expect(await done).toMatchObject({ status: "interrupted" });
    // From here the clock reads 20 ms behind the timers, as when Node fires a timer a little early.
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() - 20);
    await vi.waitFor(async () => expect((await engine.getRun(run.id)).status).toBe("completed"));
  });

  it("drives the deadline through a host scheduler's handleWake, early calls included", async () => {
    const scheduled: { id: string; at: number }[] = [];
    const engine = engineWith({ refund: refund(30) }, { scheduleWake: (id, at) => void scheduled.push({ id, at }) });
    const { run, done } = await engine.start("refund");
    const parked = await done;
    const deadline = Date.parse(parked!.interrupt!.expiresAt!);
    expect(scheduled.at(-1)).toEqual({ id: run.id, at: deadline });
    // Too early: it waits, and asks to be called at the deadline.
    expect(await engine.handleWake(run.id)).toBe(deadline);
    expect((await engine.getRun(run.id)).status).toBe("interrupted");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await engine.handleWake(run.id);
    await engine.idle(run.id);
    expect(await engine.getRun(run.id)).toMatchObject({ status: "completed", output: expect.stringMatching(/^timed out at /) });
  });

  it("keeps the timeout on replay: a later interrupt's answer re-runs the code, which throws the same error", async () => {
    let fallbacks = 0;
    const engine = engineWith({
      twoStep: defineAgent(async (_input, run) => {
        let first: string;
        try {
          first = await run.interrupt<string>("first", undefined, { timeout: "1h" });
        } catch (error) {
          if (!(error instanceof InterruptTimeoutError)) throw error;
          first = await run.step("fallback", () => `fallback ${++fallbacks}`);
        }
        const second = await run.interrupt<string>("second");
        return `${first} / ${second}`;
      }),
    });
    const { run, done } = await engine.start("twoStep");
    const parked = await done;
    await (await engine.sweep(Date.parse(parked!.interrupt!.expiresAt!) + 1)).settled;
    expect(await engine.getRun(run.id)).toMatchObject({ status: "interrupted", interrupt: { name: "second" } });
    expect((await engine.getRun(run.id)).interrupt!.expiresAt).toBeUndefined();
    const resumed = await engine.resume(run.id, "ok");
    expect(await resumed.done).toMatchObject({ status: "completed", output: "fallback 1 / ok" });
    expect(fallbacks).toBe(1);
  });

  it("clears the deadline when the run is cancelled", async () => {
    const engine = engineWith({ refund: refund() });
    const { run, done } = await engine.start("refund");
    const parked = await done;
    await engine.cancel(run.id);
    const { woken } = await engine.sweep(Date.parse(parked!.interrupt!.expiresAt!) + 1);
    expect(woken).toEqual([]);
    expect(await engine.getRun(run.id)).toMatchObject({ status: "cancelled" });
    expect((await engine.getRun(run.id)).wakeAt).toBeUndefined();
  });

  it("fails the run with the fix when the timeout is not a duration", async () => {
    const engine = engineWith({ refund: refund("tomorrow") });
    const { done } = await engine.start("refund");
    expect(await done).toMatchObject({ status: "failed", error: { message: expect.stringContaining('Invalid duration "tomorrow"') } });
  });

  it("tells the approvals registry the deadline, and that the wait expired", async () => {
    const calls: { kind: "open" | "close"; interrupt: PendingInterrupt; reason?: string }[] = [];
    const approvals: ApprovalRegistry = {
      open: async (_run: RunRecord, interrupt) => void calls.push({ kind: "open", interrupt }),
      close: async (_run: RunRecord, interrupt, reason) => void calls.push({ kind: "close", interrupt, ...(reason ? { reason } : {}) }),
    };
    const engine = engineWith({ refund: refund() }, { approvals });
    const { done } = await engine.start("refund");
    const parked = await done;
    await (await engine.sweep(Date.parse(parked!.interrupt!.expiresAt!) + 1)).settled;
    await tick();
    expect(calls.map((call) => [call.kind, call.interrupt.expiresAt, call.reason])).toEqual([
      ["open", parked!.interrupt!.expiresAt, undefined],
      ["close", parked!.interrupt!.expiresAt, "expired"],
    ]);
  });
});

describe("Farm.js Infra approvals with a timeout", () => {
  it("sends expiresAt with the open entry and reason expired with the close", async () => {
    const sent: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === "https://infra.example.com/api/agents/approvals") sent.push(...((await request.json()) as { approvals: unknown[] }).approvals);
      return Response.json({ accepted: 1 }, { status: 202 });
    }) as typeof fetch;
    const registry = farmApprovals({
      env: () => ({ FARMJS_API_KEY: "farmjs_test_vector_key", FARMJS_API_URL: "https://infra.example.com" }),
      endpoint: () => "https://app.example.com/api/agent",
    });
    const run = { id: "run_1", agent: "refund" } as RunRecord;
    const interrupt = { key: "interrupt:approve-refund#0", name: "approve-refund", payload: { amount: 40 }, expiresAt: "2026-11-16T09:00:00.000Z" };
    await registry.open(run, interrupt);
    await registry.close(run, interrupt, "expired");
    await registry.close(run, { ...interrupt, key: "interrupt:approve-refund#1" });
    expect(sent).toEqual([
      { run: "run_1", key: "interrupt:approve-refund#0", agent: "refund", interrupt: "approve-refund", payload: { amount: 40 }, expiresAt: "2026-11-16T09:00:00.000Z", status: "open" },
      { run: "run_1", key: "interrupt:approve-refund#0", interrupt: "approve-refund", status: "closed", reason: "expired" },
      { run: "run_1", key: "interrupt:approve-refund#1", interrupt: "approve-refund", status: "closed" },
    ]);
  });
});

describe("onInterrupt", () => {
  it("tells the hook once per pause, with the run and the interrupt", async () => {
    const seen: { run: string; status: string; interrupt: string; expiresAt?: string }[] = [];
    const kept: Promise<unknown>[] = [];
    const engine = engineWith(
      { refund: refund() },
      {
        waitUntil: (promise) => void kept.push(promise),
        onInterrupt: ({ run, interrupt }) => void seen.push({ run: run.id, status: run.status, interrupt: interrupt.name, expiresAt: interrupt.expiresAt }),
      },
    );
    const { run, done } = await engine.start("refund");
    const parked = await done;
    expect(seen).toEqual([{ run: run.id, status: "interrupted", interrupt: "approve-refund", expiresAt: parked!.interrupt!.expiresAt }]);
    expect(kept.length).toBeGreaterThan(0);
    // Answering resumes the run; nothing new waits, so the hook is not called again.
    await (await engine.resume(run.id, { approved: true })).done;
    expect(seen).toHaveLength(1);
  });

  it("never fails the run when the hook throws or rejects", async () => {
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      for (const onInterrupt of [
        () => {
          throw new Error("slack is down");
        },
        async () => Promise.reject(new Error("slack is down")),
      ]) {
        const engine = engineWith({ refund: refund() }, { onInterrupt });
        const { done } = await engine.start("refund");
        expect(await done).toMatchObject({ status: "interrupted" });
      }
      await tick();
    } finally {
      console.error = log;
    }
    expect(errors).toHaveLength(2);
    expect(String((errors[0] as unknown[])[0])).toContain('onInterrupt failed for the interrupt "approve-refund"');
  });

  it("stops waiting for a hook that hangs after two seconds", async () => {
    const engine = engineWith({ refund: refund() }, { onInterrupt: () => new Promise(() => {}) });
    const started = Date.now();
    const { done } = await engine.start("refund");
    expect(await done).toMatchObject({ status: "interrupted" });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
