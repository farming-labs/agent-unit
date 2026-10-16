import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject } from "../src/build/load";
import { prepareTasks, runTask } from "../src/build/tasks";

// `tasks`: checked before a build, and runnable once from source with `agent-unit task <name>`.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function project(tasks: string, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-unit-tasks-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "tasks", type: "module" }));
  writeFileSync(join(root, "agent-unit.config.mjs"), `export default { server: "./server.mjs", tasks: ${tasks} };`);
  writeFileSync(join(root, "server.mjs"), "export default () => new Response('ok');");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return loadProject(root);
}

describe("tasks", () => {
  it("runs a task once from source, finishing its follow-up work first", async () => {
    const app = await project(`{ digest: { schedule: "0 8 * * *", handler: "./tasks/digest.ts" } }`, {
      // An absolute import of this repo's source, quoted so Windows backslashes survive.
      "tasks/digest.ts": `import { waitUntil } from ${JSON.stringify(join(process.cwd(), "src/env/scope.ts"))};
const sent: string[] = [];
export default ({ name }: { name: string }) => {
  waitUntil(new Promise((resolve) => setTimeout(resolve, 10)).then(() => sent.push(name)));
  return { sent };
};`,
    });
    expect(await runTask(app, "digest")).toEqual({ sent: ["digest"] });
    await expect(runTask(app, "nightly")).rejects.toThrow(/there is no task "nightly"\. Tasks: digest\./);
  });

  it("rejects tasks that could not run", async () => {
    const genDir = (app: { root: string }) => join(app.root, ".agent-unit");
    const check = async (tasks: string) => {
      const app = await project(tasks);
      return () => prepareTasks(app, genDir(app), "node-server", () => {});
    };
    expect(await check(`{ "agent-unit:sweep": { schedule: "* * * * *", handler: "./server.mjs" } }`)).toThrow(/names starting "agent-unit:" are reserved/);
    expect(await check(`{ "nightly job": { schedule: "* * * * *", handler: "./server.mjs" } }`)).toThrow(/the task name "nightly job" must start with a letter or digit/);
    expect(await check(`{ nightly: { handler: "./server.mjs" } }`)).toThrow(/the task "nightly" needs a `schedule`/);
    expect(await check(`{ nightly: { schedule: "0 3 * * *", handler: "./missing.ts" } }`)).toThrow(/the handler of task "nightly", "\.\/missing\.ts", does not exist/);
  });

  it("rejects a schedule the host could not run, before one bad cron stops every task", async () => {
    const prepare = async (schedule: string, preset: string) => {
      const app = await project(`{ tick: { schedule: "* * * * *", handler: "./server.mjs" }, digest: { schedule: ${JSON.stringify(schedule)}, handler: "./server.mjs" } }`);
      return () => prepareTasks(app, join(app.root, ".agent-unit"), preset, () => {});
    };
    expect(await prepare("0 8 * * * * * *", "node-server")).toThrow(/the schedule of task "digest", "0 8 \* \* \* \* \* \*", is not a cron expression/);
    expect(await prepare("61 * * * *", "node-server")).toThrow(/Invalid value for minute: 61/);
    // Seconds and nicknames run on a server's scheduler, but Workers and Vercel take five fields only.
    expect(await prepare("*/30 * * * * *", "node-server")).not.toThrow();
    expect(await prepare("*/30 * * * * *", "cloudflare-module")).toThrow(/needs five fields \(minute hour day month weekday\) on the "cloudflare-module" preset/);
    expect(await prepare("@daily", "vercel")).toThrow(/needs five fields/);
    expect(await prepare("0 8 * * MON-FRI", "vercel")).not.toThrow();
  });

  it("rejects a sweep schedule the host could not run", async () => {
    const { prepareEngine } = await import("../src/build/engine");
    const root = mkdtempSync(join(tmpdir(), "agent-unit-sweep-"));
    dirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sweep", type: "module" }));
    const engine = (sweep: string, preset: string) => () => prepareEngine({ root, name: "sweep", config: { sweep }, agentFiles: {} }, preset, join(root, ".agent-unit"), () => {});
    expect(engine("every minute", "node-server")).toThrow(/the schedule of the sweep, "every minute", is not a cron expression/);
    expect(engine("*/30 * * * * *", "vercel")).toThrow(/needs five fields/);
    expect(engine("*/5 * * * *", "vercel")).not.toThrow();
  });

  it("groups tasks by schedule", async () => {
    const app = await project(`{ a: { schedule: "0 * * * *", handler: "./server.mjs" }, b: { schedule: "0 * * * *", handler: "./server.mjs" }, c: { schedule: "0 3 * * *", handler: "./server.mjs" } }`);
    const { tasks, scheduledTasks } = prepareTasks(app, join(app.root, ".agent-unit"), "node-server", () => {});
    expect(Object.keys(tasks)).toEqual(["a", "b", "c"]);
    expect(scheduledTasks).toEqual({ "0 * * * *": ["a", "b"], "0 3 * * *": ["c"] });
  });
});

describe("task names that read the same once made file-safe", () => {
  it("get a generated file each, so each runs its own handler", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-unit-task-names-"));
    try {
      writeFileSync(join(dir, "a.mjs"), "export default () => 'a';");
      writeFileSync(join(dir, "b.mjs"), "export default () => 'b';");
      const project = { root: dir, config: { tasks: { "report:daily": { schedule: "0 8 * * *", handler: "./a.mjs" }, report_daily: { schedule: "0 9 * * *", handler: "./b.mjs" } } } };
      const { tasks } = prepareTasks(project as never, join(dir, ".agent-unit"), "node-server", () => {});
      const files = Object.values(tasks).map((task) => (task as { handler: string }).handler);
      expect(new Set(files).size).toBe(2);
      expect(readFileSync(files[0]!, "utf8")).toContain(`a.mjs"`);
      expect(readFileSync(files[1]!, "utf8")).toContain(`b.mjs"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the app's own nitro options beside agent-unit's", () => {
  it("keeps the run sweep and the app's tasks when the app sets nitro.experimental, tasks or scheduledTasks", async () => {
    const { withUserNitro } = await import("../src/build/nitro");
    const ours = {
      experimental: { tasks: true },
      tasks: { "agent-unit:sweep": { handler: "sweep.mjs" }, digest: { handler: "digest.mjs" } },
      scheduledTasks: { "* * * * *": ["agent-unit:sweep"], "0 8 * * *": ["digest"] },
      alias: { ws: "ws.mjs" },
    };
    const merged = withUserNitro(ours, {
      experimental: { asyncContext: true },
      tasks: { cleanup: { handler: "cleanup.mjs" } },
      scheduledTasks: { "0 8 * * *": "cleanup", "0 3 * * *": ["cleanup"] },
      alias: { typescript: "typescript" },
      minify: true,
    });
    expect(merged).toEqual({
      minify: true,
      experimental: { asyncContext: true, tasks: true },
      tasks: { "agent-unit:sweep": { handler: "sweep.mjs" }, digest: { handler: "digest.mjs" }, cleanup: { handler: "cleanup.mjs" } },
      scheduledTasks: { "* * * * *": ["agent-unit:sweep"], "0 8 * * *": ["digest", "cleanup"], "0 3 * * *": ["cleanup"] },
      alias: { ws: "ws.mjs", typescript: "typescript" },
    });
    // An app that turns tasks on itself keeps them on with nothing of agent-unit's scheduled.
    expect(withUserNitro({ ...ours, experimental: { tasks: false } }, { experimental: { tasks: true } }).experimental).toEqual({ tasks: true });
  });
});

