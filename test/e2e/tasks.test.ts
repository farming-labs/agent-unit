import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
