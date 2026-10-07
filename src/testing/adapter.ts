import { createStorage } from "unstorage";
import memory from "unstorage/drivers/memory";
import { defineAgent, functionAdapter, resolveAgent } from "../agents";
import { validateAdapter, type AgentAdapter } from "../adapter/types";
import { currentFrame, tryUseRun } from "../runtime/context";
import { RunStore } from "../runtime/store";
import { createAgentUnit } from "../server/app";
import type { AgentEvent, RunInput, RunRecord } from "../types";

/** What the agent under test uses to report its side effects to the checks. */
export interface AdapterCheckKit {
  /**
   * Call this where your agent does real work (inside a tool, a step, a graph node). The checks
   * count it, see whether it ran inside a journaled call, and catch it if it ever runs twice.
   */
  effect<T = undefined>(name: string, fn?: () => T): T;
}

export interface AdapterCheckOptions<TAgent> {
  /** The adapter under test. */
  adapter: AgentAdapter<TAgent>;
  /**
   * Builds an agent of your framework that does at least one side effect through `kit.effect`, as a
   * tool or step would. Called again for every simulated restart, as a fresh process would.
   */
  agent(kit: AdapterCheckKit): unknown;
  /** Input for runs of `agent`. Default `{ prompt: "hello" }`. */
  input?: RunInput;
  /**
   * An agent that pauses through your framework (a tool approval, an interrupt), and the answer
   * that resumes it. Checks that the pause survives a restart and that resuming repeats no work.
   */
  pause?: { agent(kit: AdapterCheckKit): unknown; answer: unknown; input?: RunInput };
}

export interface AdapterCheck {
  name: string;
  ok: boolean;
  /** What went wrong, and what to change. */
  message?: string;
}

export interface AdapterReport {
  ok: boolean;
  checks: AdapterCheck[];
}

/** A shared log of side effects, keyed so that the same piece of work done twice has the same key. */
function effectLog() {
  const keys = new Map<string, number>();
  const outside: string[] = [];
  const done: string[] = [];
  const seen = new WeakMap<object, Map<string, number>>();
  const kit: AdapterCheckKit = {
    effect<T>(name: string, fn?: () => T): T {
      const frame = currentFrame();
      const run = tryUseRun();
      done.push(name);
      if (!frame) outside.push(name);
      else {
        // Within one execution of a journaled call, the nth effect of a name is one piece of work.
        // Executing that call again (instead of replaying it) produces the same key.
        let counts = seen.get(frame);
        if (!counts) seen.set(frame, (counts = new Map()));
        const n = counts.get(name) ?? 0;
        counts.set(name, n + 1);
        const key = `${run?.id ?? "?"}|${frame.scope}|${name}|${n}`;
        keys.set(key, (keys.get(key) ?? 0) + 1);
      }
      return fn ? fn() : (undefined as T);
    },
  };
  return {
    kit,
    outside,
    repeated: () => [...keys].filter(([, count]) => count > 1).map(([key]) => key.split("|")[2]!),
    /** Every effect so far, in order. */
    done,
  };
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs agent-unit's adapter checks against your adapter, in memory, with simulated restarts.
 * Returns a report; `assertAdapter` throws instead. Works with any test runner:
 *
 * ```ts
 * import { assertAdapter } from "agent-unit/testing";
 * test("agent-unit adapter", () =>
 *   assertAdapter({ adapter: myAdapter(), agent: (kit) => new MyAgent({ tools: { charge: () => kit.effect("charge") } }) }));
 * ```
 */
export async function checkAdapter<TAgent>(options: AdapterCheckOptions<TAgent>): Promise<AdapterReport> {
  const checks: AdapterCheck[] = [];
  const check = async (name: string, work: () => Promise<string | undefined> | string | undefined) => {
    try {
      const problem = await work();
      checks.push(problem ? { name, ok: false, message: problem } : { name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, message: describeError(error) });
    }
  };

  let adapter: AgentAdapter<TAgent> | undefined;
  await check("is a valid adapter", () => {
    adapter = validateAdapter(options.adapter, "The adapter") as AgentAdapter<TAgent>;
    return undefined;
  });
  if (!adapter) return { ok: false, checks };
  const valid = adapter;

  await check("recognises its own agents", () => {
    const agent = options.agent(effectLog().kit);
    if (!valid.match(agent)) return "match() returned false for the agent built by `agent()`.";
    const resolved = resolveAgent("agent", agent, [valid, functionAdapter]);
    if (resolved.card.framework !== valid.name) return `The agent resolved to "${resolved.card.framework}", not "${valid.name}".`;
    if (valid.describe) valid.describe(agent);
    return undefined;
  });

  await check("ignores everything else", () => {
    const others: [string, unknown][] = [
      ["null", null],
      ["undefined", undefined],
      ["a string", "agent"],
      ["a plain object", { name: "agent", run() {} }],
      ["a function", () => "agent"],
      ["a defineAgent() agent", defineAgent(() => "agent")],
    ];
    const claimed: string[] = [];
    for (const [label, value] of others) {
      try {
        if (valid.match(value)) claimed.push(label);
      } catch (error) {
        return `match() threw for ${label}: ${describeError(error)}. match() must return false for values that are not its agents.`;
      }
    }
    return claimed.length ? `match() claimed ${claimed.join(", ")}; it must recognise only its own framework's agents.` : undefined;
  });

  // One storage shared by every "process", as a restart would find it.
  const storage = createStorage({ driver: memory() });
  const unit = (kit: AdapterCheckKit, agent: (kit: AdapterCheckKit) => unknown) =>
    createAgentUnit({ agents: { agent: agent(kit) }, adapters: [valid], storage: new RunStore(storage) });
  const settle = async (done: Promise<RunRecord | undefined>, engine: ReturnType<typeof unit>["engine"], id: string) =>
    (await done) ?? engine.getRun(id);

  const log = effectLog();
  let finished: RunRecord | undefined;
  await check("completes a run", async () => {
    const { engine } = unit(log.kit, options.agent);
    const { run, done } = await engine.start("agent", options.input ?? { prompt: "hello" });
    finished = await settle(done, engine, run.id);
    if (finished.status !== "completed") {
      return `The run ended ${finished.status}${finished.error ? `: ${finished.error.message}` : ""}.`;
    }
    const events: AgentEvent[] = await engine.store.readEvents(run.id, 0, finished.eventCount);
    if (events[0]?.type !== "RUN_STARTED" || events.at(-1)?.type !== "RUN_FINISHED") {
      return `Events must start with RUN_STARTED and end with RUN_FINISHED; got ${events[0]?.type} … ${events.at(-1)?.type}.`;
    }
    if (events.some((event, index) => event.seq !== index + 1)) return "Event numbers (seq) are not 1, 2, 3, … without gaps.";
    if (log.done.length === 0) return "The agent did no work through `kit.effect`, so nothing else can be checked. Call kit.effect() in its tools or steps.";
    return undefined;
  });

  await check("does its work inside journaled calls", () =>
    log.outside.length
      ? `kit.effect(${[...new Set(log.outside)].map((name) => JSON.stringify(name)).join(", ")}) ran outside any journaled call, so recovering the run would do it again. Wrap the framework's model and tools with ctx.durable.model / ctx.durable.tools / ctx.durable.tool, or the work with ctx.durable.step.`
      : undefined,
  );

  await check("replays a finished run without repeating work", async () => {
    if (finished?.status !== "completed") return "Skipped: the run did not complete.";
    // The process stopped after all the work but before saving the result: a fresh one continues it.
    const before = log.done.length;
    const { engine } = unit(log.kit, options.agent);
    await engine.store.putRun({ ...finished, status: "running", output: undefined });
    const replayed = await engine.continue(finished.id);
    if (replayed?.status !== "completed") return `Recovery ended ${replayed?.status}${replayed?.error ? `: ${replayed.error.message}` : ""}.`;
    if (JSON.stringify(replayed.output) !== JSON.stringify(finished.output)) {
      return `Recovery returned ${JSON.stringify(replayed.output)}, not the original ${JSON.stringify(finished.output)}.`;
    }
    const again = log.done.slice(before);
    if (again.length) {
      return `Recovery did work again (${[...new Set(again)].join(", ")}). Everything the first execution finished must replay from the journal.`;
    }
    return undefined;
  });

  if (options.pause) {
    const pause = options.pause;
    const paused = effectLog();
    await check("pauses, survives a restart and resumes without repeating work", async () => {
      const first = unit(paused.kit, pause.agent).engine;
      const { run, done } = await first.start("agent", pause.input ?? options.input ?? { prompt: "hello" });
      const parked = await settle(done, first, run.id);
      if (parked.status !== "interrupted") return `The run ended ${parked.status} instead of pausing${parked.error ? `: ${parked.error.message}` : ""}.`;
      // A fresh process answers it.
      const second = unit(paused.kit, pause.agent).engine;
      const resumed = await second.resume(run.id, pause.answer);
      const record = await settle(resumed.done, second, run.id);
      if (record.status !== "completed") return `After the answer the run ended ${record.status}${record.error ? `: ${record.error.message}` : ""}.`;
      const repeated = paused.repeated();
      if (repeated.length) return `Resuming did work again: ${[...new Set(repeated)].join(", ")}.`;
      if (paused.outside.length) return `kit.effect(${[...new Set(paused.outside)].join(", ")}) ran outside any journaled call.`;
      return undefined;
    });
  }

  return { ok: checks.every((item) => item.ok), checks };
}

/** Runs `checkAdapter` and throws one error listing every failed check. */
export async function assertAdapter<TAgent>(options: AdapterCheckOptions<TAgent>): Promise<AdapterReport> {
  const report = await checkAdapter(options);
  if (!report.ok) {
    const failed = report.checks.filter((item) => !item.ok).map((item) => `  ✗ ${item.name}: ${item.message}`);
    throw new Error(`The adapter failed agent-unit's checks:\n${failed.join("\n")}`);
  }
  return report;
}
