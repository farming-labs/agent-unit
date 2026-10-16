import { join } from "node:path";
import type { NitroModule } from "nitro/types";
import { configForPreset, loadProject } from "./build/load";
import { checkSchedule } from "./build/schedule";
import { prepareTasks } from "./build/tasks";
import { generateEntry, resolveBudget, resolveStorage } from "./build/engine";

export interface AgentUnitNitroOptions {
  /** Directory holding `agent-unit.config.ts` and `agents/`. Default: the Nitro root. */
  root?: string;
  /** Where the agent API is mounted in the app. Default `/agents`. */
  basePath?: string;
}

/**
 * Mounts agent-unit inside an existing Nitro app (or anything built on Nitro): the run API, MCP and
 * the agent card under `basePath`, runs in the app's storage, and the sweep as a scheduled task.
 *
 * ```ts
 * // nitro.config.ts
 * import { agentUnit } from "agent-unit/nitro";
 * export default defineConfig({ modules: [agentUnit({ basePath: "/api/agents" })] });
 * ```
 */
export function agentUnit(options: AgentUnitNitroOptions = {}): NitroModule {
  return {
    name: "agent-unit",
    async setup(nitro) {
      const preset = nitro.options.preset;
      const loaded = await loadProject(options.root ?? nitro.options.rootDir);
      const project = { ...loaded, config: configForPreset(loaded.config, preset) };
      const basePath = (options.basePath ?? project.config.basePath ?? "/agents").replace(/\/+$/, "");
      const warn = (message: string) => nitro.logger.warn(message);
      // The Durable Objects runtime needs agent-unit's own Worker entry and exports, which the app's
      // Nitro build owns here; Workers and Nitro settings belong in the app's nitro.config.
      if (project.config.runtime === "durable-objects") {
        throw new Error(`agent-unit: runtime "durable-objects" is built by \`agent-unit build\`, not by the agent-unit/nitro module. Keep runs in a storage driver here (for example cloudflare-kv-binding), or build the agents with agent-unit build.`);
      }
      const ignored = (["cloudflare", "nitro"] as const).filter((key) => project.config[key] !== undefined);
      if (ignored.length) warn(`agent-unit: ${ignored.map((key) => `\`${key}\``).join(" and ")} in agent-unit.config.ts do not apply with the agent-unit/nitro module: set them in your nitro.config.`);
      // A directory per preset: Nitro's prerenderer runs this setup again as its own `nitro-prerender`
      // instance in the same build directory, before the production bundle is written.
      const dir = join(nitro.options.buildDir, "agent-unit", preset);
      // The app's own `agent-unit` mount wins, so runs can live in storage the app already configures.
      // A dev server runs on this machine, with its disk, whatever the preset it will be built for.
      const storage = nitro.options.storage["agent-unit"] ? undefined : resolveStorage(project, nitro.options.dev ? "node-server" : preset, warn);
      generateEntry(project, dir, { budgetMs: resolveBudget(project, preset), basePath, preset, storage });
      const handler = join(dir, "entry.mjs");
      nitro.options.handlers.push({ route: basePath || "/", handler }, { route: `${basePath}/**`, handler });

      // The app's own tasks, as agent-unit build runs them.
      const appTasks = prepareTasks(project, dir, preset, warn);
      if (Object.keys(appTasks.tasks).length) {
        nitro.options.experimental.tasks = true;
        Object.assign(nitro.options.tasks, appTasks.tasks);
        for (const [cron, names] of Object.entries(appTasks.scheduledTasks)) {
          const existing = nitro.options.scheduledTasks[cron];
          nitro.options.scheduledTasks[cron] = [...(existing ? [existing].flat() : []), ...names];
        }
      }

      if (project.config.sweep !== false && !nitro.options.dev) {
        nitro.options.experimental.tasks = true;
        nitro.options.tasks["agent-unit:sweep"] = { handler: join(dir, "sweep.mjs"), description: "Wake due runs and recover stalled ones." };
        const cron = project.config.sweep ?? "* * * * *";
        checkSchedule(cron, "the sweep", preset);
        const existing = nitro.options.scheduledTasks[cron];
        nitro.options.scheduledTasks[cron] = [...(existing ? [existing].flat() : []), "agent-unit:sweep"];
      }
    },
  };
}

export default agentUnit;
