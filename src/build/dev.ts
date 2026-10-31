import { existsSync, readFileSync, watch } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createJiti } from "jiti";
import { serve } from "srvx";
import { staticMiddleware } from "srvx/static";
import type { AgentUnit } from "@agent-unit/runtime/server";
import type { AgentUnitConfig, StorageConfig } from "../config";
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
  /** The engine's run storage, so writes to it on disk do not reload the app. */
  storage?: StorageConfig;
}

/** The app's own server from source: its default export, called the way the built entry calls it. */
async function createServerApp(project: LoadedProject): Promise<DevApp> {
  const { file, label: server, alias } = await resolveServer(project, resolve(project.root, ".agent-unit"), "dev");
  const jiti = createJiti(resolve(project.root, "package.json"), { moduleCache: false, fsCache: false, ...(alias ? { alias } : {}) });
  // The default export only, as the build takes it: a module with only named exports fails here too.
  // jiti hands back the module's namespace when it has no default export, so its source tells.
  if (!/export\s+default\b|export\s*\{[^}]*\bdefault\b|module\.exports\b/.test(readFileSync(file, "utf8"))) {
    throw new Error(`agent-unit: ${server} must export default a fetch handler: a function (request) => Response, or an object with a fetch method (a Hono app, { fetch }).`);
  }
  const module = (await jiti.import(file)) as { default?: unknown };
  const app = (module.default ?? module) as { fetch?: (...args: unknown[]) => Response | Promise<Response> } | ((...args: unknown[]) => Response | Promise<Response>);
  const handle = typeof app === "function" ? app : typeof app?.fetch === "function" ? app.fetch.bind(app) : undefined;
  if (!handle) {
    throw new Error(`agent-unit: ${server} must export default a fetch handler: a function (request) => Response, or an object with a fetch method (a Hono app, { fetch }).`);
  }
  return {
    // process.env as the env, as a build passes it off Workers (Hono's c.env).
    fetch: (request, waitUntil) => runInScope(waitUntil, () => handle(request, process.env, { waitUntil: scopedWaitUntil, passThroughOnException() {} })),
    describe: () => server,
    close() {},
  };
}

async function createApp(root: string, configFile?: string, config?: AgentUnitConfig): Promise<DevApp> {
  const project = await loadProject(root, { configFile, config });
  if (project.config.server) return createServerApp(project);
  // The engine is imported only when it is the server.
  return (await import("./engine-dev")).createEngineApp(project);
}

/** Folders of build output, tools and data: writes there are never source. */
const NOT_SOURCE = /(^|[\\/])(node_modules|\.git|\.data|\.output|\.agent-unit|\.nitro|\.vercel|\.netlify|\.wrangler|\.aws-sam|dist|coverage)([\\/]|$)/;
/** Modules, JSON they import, and .env files. */
const SOURCE = /\.(?:[cm]?[jt]sx?|json)$|(?:^|[\\/])\.env(?:\.[\w.-]+)?$/;

/**
 * Whether a change to `file` (relative to the root) reloads the app: source and .env files only, so
 * run storage on disk, build output and editors' temporary files do not restart it with every write.
 */
export function reloadsOn(file: string, storage?: string): boolean {
  if (NOT_SOURCE.test(file) || !SOURCE.test(file)) return false;
  return !storage || !(file === storage || file.startsWith(`${storage}/`) || file.startsWith(`${storage}\\`));
}

/** The folder, relative to the root, where the engine keeps runs on disk, if it does. */
function storageDir(root: string, app: DevApp): string | undefined {
  const storage = app.storage;
  if (!storage || !/^fs(-lite)?$/.test(storage.driver) || typeof storage.base !== "string") return undefined;
  return relative(root, resolve(root, storage.base));
}

/** Serves the app from source with reload on change: its own server, or its agents on agent-unit's engine. */
export interface DevHandlerOptions {
  root?: string;
  /** A module whose default export is the config, instead of `agent-unit.config.*`. */
  configFile?: string;
  /** The config itself, already evaluated in this process, instead of a file. */
  config?: AgentUnitConfig;
  /** Reload when files change. Default true. */
  watch?: boolean;
  logger?: DevOptions["logger"];
}

/**
 * The app's agents (or its own server) served from source as a Fetch handler, with reloads, `.env`
 * and the sweep, for mounting in another dev server, such as a framework's. `startDev` wraps it in
 * an HTTP server.
 */
export interface DevHandler {
  fetch(request: Request, waitUntil?: (promise: Promise<unknown>) => void): Promise<Response>;
  /** agent-unit's engine. Throws when the app brings its own `server`. */
  unit(): AgentUnit;
  /** The app's own server file, when it has one. */
  server(): string | undefined;
  describe(): string;
  reload(): Promise<void>;
  close(): void;
}

export async function createDevHandler(options: DevHandlerOptions = {}): Promise<DevHandler> {
  const logger = options.logger ?? { info: console.log, warn: console.warn, error: console.error };
  const root = resolve(options.root ?? process.cwd());
  // Variables .env set (not those already in the environment, which win), so an edit to .env applies on reload.
  let fromEnvFile = loadEnvFile(root);
  const reloadEnvFile = () => {
    for (const key of fromEnvFile) delete process.env[key];
    fromEnvFile = loadEnvFile(root);
  };

  let current = await createApp(root, options.configFile, options.config);

  // Often, unlike a deployed sweep: a reload hands the previous engine's sleep timers to the sweep.
  const sweep = setInterval(() => void current.sweep?.().catch((error) => logger.error("agent-unit: sweep failed", error)), 5_000);
  sweep.unref();

  let reloading: Promise<void> | undefined;
  async function reload() {
    reloading ??= (async () => {
      try {
        reloadEnvFile();
        const next = await createApp(root, options.configFile, options.config);
        storage = storageDir(root, next);
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
  let storage = storageDir(root, current);
  const watcher =
    options.watch === false
      ? undefined
      : watch(root, { recursive: true }, (_event, file) => {
          if (!file || !reloadsOn(String(file), storage)) return;
          clearTimeout(timer);
          timer = setTimeout(() => void reload(), 100);
        });

  // Without a host waitUntil, background work still runs to completion in this long-lived process.
  const keepAlive = (promise: Promise<unknown>) => void promise.catch((error) => logger.error("agent-unit: background work failed", error));

  return {
    fetch: async (request, waitUntil) => current.fetch(request, waitUntil ?? keepAlive),
    unit() {
      if (!current.unit) throw new Error("agent-unit: this app brings its own `server`, so agent-unit's engine is not running.");
      return current.unit;
    },
    server: () => (current.unit ? undefined : current.describe()),
    describe: () => current.describe(),
    reload,
    close() {
      clearInterval(sweep);
      clearTimeout(timer);
      watcher?.close();
      current.close();
    },
  };
}

export async function startDev(options: DevOptions = {}): Promise<DevServer> {
  const root = resolve(options.root ?? process.cwd());
  const handler = await createDevHandler({ root, watch: options.watch, logger: options.logger });
  // public/ is served before the app, as Nitro serves it in a build.
  const publicDir = join(root, "public");
  const server = serve({
    port: options.port ?? Number(process.env.PORT ?? 3000),
    hostname: options.hostname,
    silent: true,
    middleware: existsSync(publicDir) ? [staticMiddleware({ dir: publicDir })] : [],
    fetch: (request) => handler.fetch(request, (promise) => server.waitUntil?.(promise)),
  });
  await server.ready();
  const url = (server.url ?? `http://localhost:${options.port ?? 3000}/`).replace(/\/\/(\[::\]|0\.0\.0\.0)/, "//localhost");

  return {
    url,
    server: handler.server(),
    unit: () => handler.unit(),
    describe: () => handler.describe(),
    reload: () => handler.reload(),
    async close() {
      handler.close();
      await server.close(true);
    },
  };
}
