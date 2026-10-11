import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      "tasks/digest.ts": `import { waitUntil } from "../../src/env/scope";
const sent: string[] = [];
export default ({ name }: { name: string }) => {
  waitUntil(new Promise((resolve) => setTimeout(resolve, 10)).then(() => sent.push(name)));
  return { sent };
};`.replace("../../src/env/scope", join(process.cwd(), "src/env/scope.ts")),
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

  it("groups tasks by schedule", async () => {
    const app = await project(`{ a: { schedule: "0 * * * *", handler: "./server.mjs" }, b: { schedule: "0 * * * *", handler: "./server.mjs" }, c: { schedule: "0 3 * * *", handler: "./server.mjs" } }`);
    const { tasks, scheduledTasks } = prepareTasks(app, join(app.root, ".agent-unit"), "node-server", () => {});
    expect(Object.keys(tasks)).toEqual(["a", "b", "c"]);
    expect(scheduledTasks).toEqual({ "0 * * * *": ["a", "b"], "0 3 * * *": ["c"] });
  });
});
