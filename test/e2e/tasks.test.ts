import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scheduledRunId } from "../../packages/runtime/src/server/scheduled";
import { buildFixture, cleanup, prepareFixture, ROOT, startServer, tempDir, type RunningServer } from "./helpers";
import { startMiniflare } from "./hosts";

// `tasks`: the app's scheduled work, run by each host's own scheduler. A task records each run and
// hands follow-up work to waitUntil; the server reports what ran.

interface Report {
  runs: { name: string; scheduledTime: number }[];
  followUps: number;
}

/** Polls until `done` holds, for at most `ms`. A bounded readiness check, not a fixed sleep. */
async function until(read: () => Promise<Report>, done: (report: Report) => boolean, ms: number): Promise<Report> {
  const deadline = Date.now() + ms;
  for (;;) {
    const report = await read();
    if (done(report) || Date.now() > deadline) return report;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("scheduled tasks on node-server", () => {
  let out: string;
  let server: RunningServer;

  beforeAll(async () => {
    const root = prepareFixture("server-tasks");
    out = tempDir("tasks-node-out");
    // Croner takes a seconds field: every second, so the test sees several ticks quickly.
    await buildFixture(root, "node-server", out, { TICK_SCHEDULE: "* * * * * *" });
    // Nitro skips its scheduler when TEST is set, as it is inside this test runner.
    server = await startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: root, env: { TEST: "" }, readyPath: "/" });
  });

  afterAll(async () => {
    await server?.stop();
    cleanup(out);
  });

  it("runs the task once per tick, with its follow-up work", async () => {
    const read = async () => (await (await fetch(server.url)).json()) as Report;
    const report = await until(read, (r) => r.runs.length >= 3 && r.followUps >= 3, 10_000);
    expect(report.runs.length).toBeGreaterThanOrEqual(3);
    expect(new Set(report.runs.map((run) => run.name))).toEqual(new Set(["tick"]));
    const seconds = report.runs.map((run) => Math.floor(run.scheduledTime / 1000));
    expect(new Set(seconds).size, "two runs in the same second").toBe(seconds.length);
    expect(report.followUps).toBeGreaterThanOrEqual(3);
  });
});

describe("scheduled tasks on cloudflare-module", () => {
  let out: string;
  let data: string;
  let worker: Awaited<ReturnType<typeof startMiniflare>>;

  beforeAll(async () => {
    out = tempDir("tasks-cf-out");
    data = tempDir("tasks-cf-data");
    await buildFixture(prepareFixture("server-tasks"), "cloudflare-module", out);
    worker = await startMiniflare(out, data);
  });

  afterAll(async () => {
    await worker?.stop();
    cleanup(out, data);
  });

  it("becomes a Cron Trigger that runs the task once per trigger", async () => {
    expect(worker.wrangler.triggers.crons).toEqual(["* * * * *"]);
    const read = async () => (await (await worker.fetch("/")).json()) as Report;
    expect((await read()).runs).toEqual([]);
    for (let tick = 1; tick <= 2; tick++) {
      expect((await worker.scheduled("* * * * *")).status).toBe(200);
      const report = await until(read, (r) => r.followUps >= tick, 5_000);
      expect(report.runs.map((run) => run.name)).toEqual(Array(tick).fill("tick"));
      expect(report.followUps).toBe(tick);
    }
  });
});

describe("scheduled tasks on other hosts", () => {
  const outs: string[] = [];
  afterAll(() => cleanup(...outs));

  it("becomes a Vercel Cron Job", async () => {
    const out = tempDir("tasks-vercel-out");
    outs.push(out);
    await buildFixture(prepareFixture("server-tasks"), "vercel", out);
    const config = JSON.parse(readFileSync(join(out, "config.json"), "utf8")) as { crons?: { schedule: string; path: string }[] };
    expect(config.crons).toEqual([expect.objectContaining({ schedule: "* * * * *" })]);
  });

  it("warns where the host has no scheduler Nitro can drive", async () => {
    const out = tempDir("tasks-netlify-out");
    outs.push(out);
    const warnings: string[] = [];
    const { build } = (await import(join(ROOT, "dist/build.mjs"))) as typeof import("../../src/build");
    await build({ root: prepareFixture("server-tasks"), preset: "netlify", outDir: out, logger: { info() {}, warn: (message) => void warnings.push(message) } });
    expect(warnings).toEqual([expect.stringMatching(/the "netlify" preset has no scheduler .* the tasks "tick" will not run on their own/)]);
  });
});

// A task with `agent` starts a run of that agent on each fire, with the input the config gives where
// the server runs, and one run per scheduled time.

interface RunList {
  runs: { id: string; status: string; input: { team?: string }; output?: { team?: string }; createdAt: string }[];
}

async function untilRuns(read: () => Promise<RunList>, done: (list: RunList) => boolean, ms: number): Promise<RunList> {
  const deadline = Date.now() + ms;
  for (;;) {
    const list = await read();
    if (done(list) || Date.now() > deadline) return list;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const completed = (list: RunList) => list.runs.filter((run) => run.status === "completed");

describe("agent tasks on node-server", () => {
  let out: string;
  let data: string;
  let server: RunningServer;

  beforeAll(async () => {
    const root = prepareFixture("engine-tasks");
    out = tempDir("agent-tasks-node-out");
    data = tempDir("agent-tasks-node-data");
    // The build sees another team than the server: the run must get the server's.
    await buildFixture(root, "node-server", out, { TICK_SCHEDULE: "* * * * * *", DIGEST_TEAM: "build" });
    server = await startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: root, env: { TEST: "", DIGEST_TEAM: "support", AGENT_UNIT_DATA: data }, readyPath: "/runs" });
  });

  afterAll(async () => {
    await server?.stop();
    cleanup(out, data);
  });

  it("starts the agent once per tick, with the input the server reads", async () => {
    const read = async () => (await (await fetch(`${server.url}/runs?agent=digest`)).json()) as RunList;
    const list = await untilRuns(read, (l) => completed(l).length >= 3, 10_000);
    const runs = completed(list);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    for (const run of runs) expect(run).toMatchObject({ input: { team: "support" }, output: { team: "support" } });
    // Each tick's run has the id of its task and second.
    for (const run of runs) {
      const second = Math.floor(Date.parse(run.createdAt) / 1000) * 1000;
      expect(run.id).toBe(await scheduledRunId("digest", second));
    }
  });
});

describe("agent tasks on cloudflare-module", () => {
  let out: string;
  let data: string;
  let worker: Awaited<ReturnType<typeof startMiniflare>>;

  beforeAll(async () => {
    out = tempDir("agent-tasks-cf-out");
    data = tempDir("agent-tasks-cf-data");
    // One time a year: both triggers below fall on the same scheduled time, whenever the test runs.
    await buildFixture(prepareFixture("engine-tasks"), "cloudflare-module", out, { TICK_SCHEDULE: "0 0 1 1 *" });
    worker = await startMiniflare(out, data);
  });

  afterAll(async () => {
    await worker?.stop();
    cleanup(out, data);
  });

  it("becomes a Cron Trigger, and two triggers for the same time start the agent once", async () => {
    expect(worker.wrangler.triggers.crons).toEqual(["0 0 1 1 *"]);
    expect((await worker.scheduled("0 0 1 1 *")).status).toBe(200);
    expect((await worker.scheduled("0 0 1 1 *")).status).toBe(200);
    const read = async () => (await (await worker.fetch("/runs?agent=digest")).json()) as RunList;
    const list = await untilRuns(read, (l) => completed(l).length >= 1, 5_000);
    expect(list.runs).toHaveLength(1);
    // Workers run in UTC: this year's 1 January is the scheduled time.
    const newYear = Date.UTC(new Date().getUTCFullYear(), 0, 1);
    expect(list.runs[0]).toMatchObject({ id: await scheduledRunId("digest", newYear), status: "completed" });
  });
});

describe("agent tasks on Vercel", () => {
  it("become a Vercel Cron Job", async () => {
    const out = tempDir("agent-tasks-vercel-out");
    try {
      await buildFixture(prepareFixture("engine-tasks"), "vercel", out);
      const config = JSON.parse(readFileSync(join(out, "config.json"), "utf8")) as { crons?: { schedule: string; path: string }[] };
      expect(config.crons).toEqual([expect.objectContaining({ schedule: "* * * * *" })]);
    } finally {
      cleanup(out);
    }
  });
});

describe("agent-unit task", () => {
  it("exits once the task is done, though the task leaves a client or timer open", () => {
    const root = tempDir("task-open-handle");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "task-open-handle", type: "module" }));
    writeFileSync(join(root, "server.mjs"), "export default () => new Response('ok');");
    writeFileSync(join(root, "agent-unit.config.mjs"), `export default { server: "./server.mjs", tasks: { digest: { schedule: "0 8 * * *", handler: "./digest.mjs" } } };`);
    // A database or Redis client a task module opens and never closes keeps a process alive.
    writeFileSync(join(root, "digest.mjs"), "setInterval(() => {}, 1000);\nexport default () => ({ sent: 3 });");
    const result = spawnSync(process.execPath, [join(ROOT, "dist/cli.mjs"), "task", "digest", "--root", root], { encoding: "utf8", timeout: 15_000 });
    cleanup(root);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`agent-unit task digest: done\n{\n  "sent": 3\n}`);
  });
});

