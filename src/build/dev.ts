import { watch } from "node:fs";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import { serve } from "srvx";
import type { AgentUnit } from "@agent-unit/runtime/server";
import { runInScope, waitUntil as scopedWaitUntil } from "../env/scope";
import { loadEnvFile, loadProject, resolveServer, type LoadedProject } from "./load";

export interface DevOptions {
  root?: string;
  port?: number;
  hostname?: string;
  /** Reload when files change. Default true. */
  watch?: boolean;
  logger?: { info(message: string): void; warn(message: string): void; error(message: string, error?: unknown): void };
}

export interface DevServer {
  url: string;
  /** The app's own server file, when it has one (`server` in agent-unit.config.ts). */
  server?: string;
  /** agent-unit's engine. Throws when the app brings its own `server`. */
  unit(): AgentUnit;
  /** What is being served: the agents and their frameworks, or the server file. */
  describe(): string;
  reload(): Promise<void>;
  close(): Promise<void>;
}

/** What the dev server serves; rebuilt from source on every reload. */
export interface DevApp {
  fetch(request: Request, waitUntil: (promise: Promise<unknown>) => void): Response | Promise<Response>;
  describe(): string;
  close(): void;
  sweep?(): Promise<unknown>;
  unit?: AgentUnit;
}

/** The app's own server from source: its default export, called the way the built entry calls it. */
async function createServerApp(project: LoadedProject): Promise<DevApp> {
  const { file, label: server, alias } = await resolveServer(project, resolve(project.root, ".agent-unit"), "dev");
  const jiti = createJiti(resolve(project.root, "package.json"), { moduleCache: false, fsCache: false, ...(alias ? { alias } : {}) });
  const module = (await jiti.import(file)) as { default?: unknown };
  const app = (module.default ?? module) as { fetch?: (...args: unknown[]) => Response | Promise<Response> } | ((...args: unknown[]) => Response | Promise<Response>);
  const handle = typeof app === "function" ? app : typeof app?.fetch === "function" ? app.fetch.bind(app) : undefined;
  if (!handle) {
    throw new Error(`agent-unit: ${server} must export default a fetch handler: a function (request) => Response, or an object with a fetch method (a Hono app, { fetch }).`);
  }
  return {
    fetch: (request, waitUntil) => runInScope(waitUntil, () => handle(request, undefined, { waitUntil: scopedWaitUntil, passThroughOnException() {} })),
    describe: () => server,
    close() {},
  };
}

async function createApp(root: string): Promise<DevApp> {
  const project = await loadProject(root);
  if (project.config.server) return createServerApp(project);
  // The engine is imported only when it is the server.
  return (await import("./engine-dev")).createEngineApp(project);
}

/** Serves the app from source with reload on change: its own server, or its agents on agent-unit's engine. */
export async function startDev(options: DevOptions = {}): Promise<DevServer> {
  const logger = options.logger ?? { info: console.log, warn: console.warn, error: console.error };
  const root = resolve(options.root ?? process.cwd());
  loadEnvFile(root);

  let current = await createApp(root);
  const server = serve({
    port: options.port ?? Number(process.env.PORT ?? 3000),
    hostname: options.hostname,
    silent: true,
    fetch: (request) => current.fetch(request, (promise) => server.waitUntil?.(promise)),
  });
  await server.ready();
  const url = (server.url ?? `http://localhost:${options.port ?? 3000}/`).replace(/\/\/(\[::\]|0\.0\.0\.0)/, "//localhost");

  const sweep = setInterval(() => void current.sweep?.().catch((error) => logger.error("agent-unit: sweep failed", error)), 60_000);
  sweep.unref();

  let reloading: Promise<void> | undefined;
  async function reload() {
    reloading ??= (async () => {
      try {
        const next = await createApp(root);
        const previous = current;
        current = next;
        // In-flight executions keep running on the previous engine; its timers move to storage-driven wakes.
        previous.close();
        logger.info(`agent-unit: reloaded ${next.describe()}`);
      } catch (error) {
        logger.error("agent-unit: reload failed, still serving the previous version", error);
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
    server: current.unit ? undefined : current.describe(),
    unit() {
      if (!current.unit) throw new Error("agent-unit: this app brings its own `server`, so agent-unit's engine is not running.");
      return current.unit;
    },
    describe: () => current.describe(),
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
