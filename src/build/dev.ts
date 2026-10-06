import { watch } from "node:fs";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import { serve } from "srvx";
import { createStorage, type Driver } from "unstorage";
import type { AgentAdapter } from "../adapter/types";
import type { StorageConfig } from "../config";
import { createAgentUnit, type AgentUnit } from "../server/app";
import { detectAdapters, type BuiltinAdapter } from "./adapters";
import { loadProject } from "./load";
import { DEFAULT_STORAGE } from "./nitro";

// Literal imports, so the package build keeps each adapter as its own chunk.
const ADAPTER_MODULES: Record<BuiltinAdapter["entry"], () => Promise<Record<string, unknown>>> = {
  "adapters/ai-sdk": () => import("../adapters/ai-sdk"),
};

async function loadDriver(root: string, config: StorageConfig): Promise<Driver> {
  const { driver, ...options } = config;
  if (!/^[a-z0-9-]+$/.test(driver)) throw new Error(`Invalid storage driver name "${driver}".`);
  const module = (await import(`unstorage/drivers/${driver}`)) as { default: (options: unknown) => Driver };
  // Relative fs paths resolve against the app root, matching the built server's working directory.
  if (typeof options.base === "string" && /^(fs|fs-lite)$/.test(driver)) options.base = resolve(root, options.base);
  return module.default(options);
}

export interface DevOptions {
  root?: string;
  port?: number;
  hostname?: string;
  /** Reload agents when files change. Default true. */
  watch?: boolean;
  logger?: { info(message: string): void; warn(message: string): void; error(message: string, error?: unknown): void };
}

export interface DevServer {
  url: string;
  unit(): AgentUnit;
  reload(): Promise<void>;
  close(): Promise<void>;
}

/** Serves the app's agents from source with reload on change. Runs survive reloads in storage. */
export async function startDev(options: DevOptions = {}): Promise<DevServer> {
  const logger = options.logger ?? { info: console.log, warn: console.warn, error: console.error };
  const root = resolve(options.root ?? process.cwd());

  async function create(): Promise<AgentUnit> {
    const project = await loadProject(root);
    const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
    const agents = project.config.agents ?? {};
    for (const [name, file] of Object.entries(project.agentFiles)) agents[name] = await jiti.import(file);
    const adapters: AgentAdapter<any>[] = [...(project.config.adapters ?? [])];
    for (const builtin of detectAdapters(project.root)) {
      adapters.push((await ADAPTER_MODULES[builtin.entry]())[builtin.exportName] as AgentAdapter<any>);
    }
    const storage = createStorage({ driver: await loadDriver(project.root, project.config.storage ?? DEFAULT_STORAGE) });
    return createAgentUnit({
      name: project.name,
      agents,
      adapters,
      storage,
      budget: project.config.budget,
      basePath: project.config.basePath,
      authorize: project.config.authorize,
    });
  }

  let current = await create();
  const server = serve({
    port: options.port ?? Number(process.env.PORT ?? 3000),
    hostname: options.hostname,
    silent: true,
    fetch: (request) => current.handler(request, { waitUntil: (promise) => server.waitUntil?.(promise) }),
  });
  await server.ready();
  const url = server.url ?? `http://localhost:${options.port ?? 3000}/`;

  // Wake sleepers and recover stalled runs, as the scheduled sweep does in production.
  const sweep = setInterval(() => void current.engine.sweep().catch((error) => logger.error("agent-unit: sweep failed", error)), 60_000);
  sweep.unref();

  let reloading: Promise<void> | undefined;
  async function reload() {
    reloading ??= (async () => {
      try {
        const next = await create();
        const previous = current;
        current = next;
        // In-flight executions keep running on the previous engine; its timers move to storage-driven wakes.
        previous.close();
        logger.info(`agent-unit: reloaded ${next.engine.manifest().agents.map((agent) => agent.name).join(", ")}`);
      } catch (error) {
        logger.error("agent-unit: reload failed, still serving the previous agents", error);
      } finally {
        reloading = undefined;
      }
    })();
    return reloading;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher =
    options.watch === false
      ? undefined
      : watch(root, { recursive: true }, (_event, file) => {
          if (!file || /(^|[\\/])(node_modules|\.git|\.data|\.output|\.agent-unit)([\\/]|$)/.test(String(file))) return;
          clearTimeout(timer);
          timer = setTimeout(() => void reload(), 100);
        });

  return {
    url,
    unit: () => current,
    reload,
    async close() {
      clearInterval(sweep);
      clearTimeout(timer);
      watcher?.close();
      current.close();
      await server.close(true);
    },
  };
}
