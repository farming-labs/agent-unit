import { join } from "node:path";
import type { NitroModule } from "nitro/types";
import { loadProject } from "./build/load";
import { generateEntry, resolveBudget, resolveStorage } from "./build/nitro";

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
      const project = await loadProject(options.root ?? nitro.options.rootDir);
      const basePath = (options.basePath ?? project.config.basePath ?? "/agents").replace(/\/+$/, "");
      const preset = nitro.options.preset;
      const dir = join(nitro.options.buildDir, "agent-unit");
      generateEntry(project, dir, { budgetMs: resolveBudget(project, preset), basePath });

      // The app's own `agent-unit` mount wins, so runs can live in storage the app already configures.
      nitro.options.storage["agent-unit"] ??= resolveStorage(project, preset, (message) => nitro.logger.warn(message)) as never;
      const handler = join(dir, "entry.mjs");
      nitro.options.handlers.push({ route: basePath || "/", handler }, { route: `${basePath}/**`, handler });

      if (project.config.sweep !== false && !nitro.options.dev) {
        nitro.options.experimental.tasks = true;
        nitro.options.tasks["agent-unit:sweep"] = { handler: join(dir, "sweep.mjs"), description: "Wake due runs and recover stalled ones." };
        const cron = project.config.sweep ?? "* * * * *";
        const existing = nitro.options.scheduledTasks[cron];
        nitro.options.scheduledTasks[cron] = [...(existing ? [existing].flat() : []), "agent-unit:sweep"];
      }
    },
  };
}

export default agentUnit;
