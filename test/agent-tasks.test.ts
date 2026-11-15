import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentUnit, scheduledRunId, startScheduledRun, type RunService } from "@agent-unit/runtime/server";
import { defineAgent } from "@agent-unit/runtime";
import { loadProject } from "../src/build/load";
import { prepareTasks, runTask } from "../src/build/tasks";
import { scheduledTime } from "../src/exports/tasks";

// A task with `agent` starts a run of that agent on each fire: one run per scheduled time, however
// often the host's scheduler fires for it.

const at = (iso: string) => Date.parse(iso);

describe("the scheduled time of a fire", () => {
  it("is the schedule's latest time at or before the fire", () => {
    expect(scheduledTime("*/5 * * * *", at("2026-11-15T10:07:12Z"))).toBe(at("2026-11-15T10:05:00Z"));
    expect(scheduledTime("*/5 * * * *", at("2026-11-15T10:05:00Z"))).toBe(at("2026-11-15T10:05:00Z"));
    // A scheduler that fires late, more than 30 seconds before the next time, still fires for this one.
    expect(scheduledTime("*/5 * * * *", at("2026-11-15T10:09:20Z"))).toBe(at("2026-11-15T10:05:00Z"));
  });

  it("counts a fire slightly early for the time it is about to reach, up to half the interval", () => {
    expect(scheduledTime("*/5 * * * *", at("2026-11-15T10:04:45Z"))).toBe(at("2026-11-15T10:05:00Z"));
    expect(scheduledTime("*/5 * * * *", at("2026-11-15T10:04:00Z"))).toBe(at("2026-11-15T10:00:00Z"));
    // Every ten seconds: half the interval is five seconds.
    expect(scheduledTime("*/10 * * * * *", at("2026-11-15T10:00:16Z"))).toBe(at("2026-11-15T10:00:20Z"));
    expect(scheduledTime("*/10 * * * * *", at("2026-11-15T10:00:14.9Z"))).toBe(at("2026-11-15T10:00:10Z"));
  });

  it("counts times in the same second as the limit, which croner's previousRuns leaves out", () => {
    // Every second, fired 2 ms after the second starts (a scheduler's usual delay).
    expect(scheduledTime("* * * * * *", at("2026-11-15T18:03:40.002Z"))).toBe(at("2026-11-15T18:03:40Z"));
    // 29.5 seconds early: the limit lands at 10:05:00.5, in the scheduled second.
    expect(scheduledTime("*/5 * * * *", at("2026-11-15T10:04:30.5Z"))).toBe(at("2026-11-15T10:05:00Z"));
  });
});

function unit() {
  const runs: unknown[] = [];
  const digest = defineAgent({
    async run(input) {
      runs.push(input);
      return { team: (input as { team?: string }).team };
    },
  });
  return { unit: createAgentUnit({ name: "tasks", agents: { digest }, storage: "memory" }), runs };
}

describe("startScheduledRun", () => {
  it("starts one run per scheduled time, and finds it when the same time fires again", async () => {
    const { unit: app, runs } = unit();
    const task = { name: "morning-digest", agent: "digest", input: { team: "support" } };
    const nine = at("2026-11-15T09:00:00Z");

    const first = await startScheduledRun(app.engine, task, nine);
    expect(first.started).toBe(true);
    expect(first.run.id).toBe(await scheduledRunId("morning-digest", nine));
    expect((await first.done)?.status).toBe("completed");

    const again = await startScheduledRun(app.engine, task, nine);
    expect(again).toMatchObject({ started: false, run: { id: first.run.id, status: "completed" } });
    expect(runs).toEqual([{ team: "support" }]);

    const tomorrow = await startScheduledRun(app.engine, task, nine + 86_400_000);
    expect(tomorrow.started).toBe(true);
    expect(tomorrow.run.id).not.toBe(first.run.id);
    await tomorrow.done;
    expect(runs).toHaveLength(2);
    expect((await app.engine.listRuns({ agent: "digest" })).map((run) => run.id).sort()).toEqual([first.run.id, tomorrow.run.id].sort());
    app.close();
  });

  it("keeps tasks with the same time apart", async () => {
    const nine = at("2026-11-15T09:00:00Z");
    expect(await scheduledRunId("a", nine)).toMatch(/^run_[0-9a-f]{32}$/);
    expect(await scheduledRunId("a", nine)).not.toBe(await scheduledRunId("b", nine));
  });

  it("refuses a runtime that picks its own run id, which would let a repeated fire start the agent twice", async () => {
    const { unit: app } = unit();
    const engine = app.engine;
    const ignoresId: RunService = new Proxy(engine, {
      get: (target, key) => (key === "start" ? (agent: string, input: Record<string, unknown>) => target.start(agent, input) : Reflect.get(target, key, target)),
    });
    await expect(startScheduledRun(ignoresId, { name: "digest", agent: "digest" }, at("2026-11-15T09:00:00Z"))).rejects.toThrow(/started task "digest" as run run_\w+ instead of run_[0-9a-f]{32}/);
    app.close();
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An app on agent-unit's engine with one agent, `digest`, that returns its input. */
async function engineProject(config: string) {
  const root = mkdtempSync(join(tmpdir(), "agent-unit-agent-tasks-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-tasks", type: "module" }));
  mkdirSync(join(root, "agents"));
  writeFileSync(join(root, "agents/digest.mjs"), `export default { [Symbol.for("agent-unit.agent")]: true, run: async (input) => ({ digest: input }) };`);
  writeFileSync(join(root, "digest-task.mjs"), "export default () => null;");
  writeFileSync(join(root, "server.mjs"), "export default () => new Response('ok');");
  writeFileSync(join(root, "agent-unit.config.mjs"), `export default ${config};`);
  return loadProject(root);
}

describe("agent tasks in the build", () => {
  const check = async (config: string) => {
    const app = await engineProject(config);
    return () => prepareTasks(app, join(app.root, ".agent-unit"), "node-server", () => {});
  };

  it("rejects agent tasks that could not run, saying what to change", async () => {
    expect(await check(`{ tasks: { digest: { schedule: "0 8 * * *", agent: "digest", handler: "./digest-task.mjs" } } }`)).toThrow(
      /the task "digest" needs a `schedule` \(a cron expression\) and either an `agent` to run or a `handler` \(the path of its module\), not both/,
    );
    expect(await check(`{ tasks: { digest: { schedule: "0 8 * * *" } } }`)).toThrow(/either an `agent` to run or a `handler`/);
    expect(await check(`{ tasks: { digest: { schedule: "0 8 * * *", agent: "digests" } } }`)).toThrow(/runs the agent "digests", and there is no such agent\. Agents: digest\./);
    expect(await check(`{ server: "./server.mjs", tasks: { digest: { schedule: "0 8 * * *", agent: "digest" } } }`)).toThrow(/needs agent-unit's engine, and `server` replaces it.*Give the task a `handler`/);
    expect(await check(`{ runtime: "durable-objects", tasks: { digest: { schedule: "0 8 * * *", agent: "digest" } } }`)).toThrow(/runtime "durable-objects" does not run agent tasks yet/);
    expect(await check(`{ tasks: { digest: { schedule: "0 8 * * *", agent: "digest", input: ["support"] } } }`)).toThrow(/the `input` of task "digest" must be a JSON object, as `POST \/agents\/digest\/runs` takes it/);
    expect(await check(`{ tasks: { digest: { schedule: "0 8 * * *", agent: "digest", input: { at: 1n } } } }`)).toThrow(/must be a JSON object/);
  });

  it("schedules a task that starts the agent on the engine, reading its input where the server runs", async () => {
    const app = await engineProject(`{ tasks: { "morning-digest": { schedule: "0 8 * * *", agent: "digest", input: { team: "support" }, description: "Daily digest." } } }`);
    const genDir = join(app.root, ".agent-unit");
    const options = prepareTasks(app, genDir, "node-server", () => {});
    expect(options.scheduledTasks).toEqual({ "0 8 * * *": ["morning-digest"] });
    expect(options.tasks["morning-digest"]).toMatchObject({ description: "Daily digest." });
    const [file] = readdirSync(join(genDir, "tasks"));
    const code = readFileSync(join(genDir, "tasks", file!), "utf8");
    expect(code).toContain(`import { getSettings, getUnit } from "../runtime.mjs";`);
    expect(code).toContain(`agent: "digest",`);
    expect(code).toContain(`schedule: "0 8 * * *",`);
    // The input is not in the build: the config gives it where the server runs.
    expect(code).toContain("input: getSettings().tasks?.[name]?.input,");
    expect(code).not.toContain("support");
  });

  it("runs an agent task once from source, until the run finishes", async () => {
    const app = await engineProject(`{ storage: "memory", tasks: { "morning-digest": { schedule: "0 8 * * *", agent: "digest", input: { team: "support" } } } }`);
    const result = (await runTask(app, "morning-digest")) as { run: string; status: string; output: unknown };
    expect(result).toEqual({ run: expect.stringMatching(/^run_/), status: "completed", output: { digest: { team: "support" } } });
  });
});
