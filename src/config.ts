import type { AgentAdapter } from "@agent-unit/runtime/adapter";
import type { HandlerOptions } from "@agent-unit/runtime/server";

/** An unstorage driver by name plus its options, e.g. `{ driver: "redis", url: process.env.REDIS_URL }`. */
export interface StorageConfig {
  driver: string;
  [option: string]: unknown;
}

/**
 * Builds a framework's own server: writes (or finds) the module whose default export handles web
 * requests, the same contract as a `server` file. Presets are plain objects, so a framework can
 * publish its own without agent-unit knowing about it.
 *
 * ```ts
 * export const myFramework = (): ServerPreset => ({
 *   name: "my-framework",
 *   entry: ({ root, genDir }) => writeServerFile(root, genDir),
 * });
 * ```
 */
export interface ServerPreset {
  /** Shown in build and dev output. */
  name: string;
  /** Returns the absolute path of the server module. Called once per build, and on every dev reload. */
  entry(context: ServerPresetContext): string | ServerPresetEntry | Promise<string | ServerPresetEntry>;
}

export interface ServerPresetEntry {
  /** Absolute path of the server module. */
  file: string;
  /** Module replacements for the production bundle only, such as build-time packages the server must not load. */
  alias?: Record<string, string>;
}

export interface ServerPresetContext {
  /** The app's directory. */
  root: string;
  /** agent-unit's generated-files directory inside the app (`.agent-unit/<preset>`), for files the preset writes. */
  genDir: string;
  /** The Nitro preset being built for (`node-server`, `cloudflare-module`, ...), or `"dev"`. */
  preset: string;
}

export interface TaskConfig {
  /** When it runs: a cron expression (`"0 8 * * *"` is every day at 08:00). Servers also take a seconds field; Workers and Vercel take five fields. */
  schedule: string;
  /** The module whose default export runs the task. */
  handler: string;
  description?: string;
}

export interface AgentUnitConfig extends Pick<HandlerOptions, "basePath" | "authorize" | "origin" | "maxBodyBytes"> {
  /**
   * Your own server, to build for any host instead of agent-unit's engine: the path of a module whose
   * default export handles web requests, a Hono app, `export default { fetch }` or a function
   * `(request, env, ctx) => Response`. Your framework then owns its routes, runs and storage, so the
   * engine settings (`agents`, `storage`, `runtime`, ...) do not apply. On Workers it gets the
   * Worker's `env` and `ctx`; read configuration anywhere with `agent-unit/env`. A framework's
   * preset (`mastra()` from `agent-unit/presets/mastra`) writes that server for you.
   */
  server?: string | ServerPreset;
  /**
   * Work on a schedule, run by the host's own scheduler: in-process cron on Node, Bun and Deno,
   * Cron Triggers on Workers, Vercel Cron Jobs on Vercel. Each task's module default-exports a
   * function called with `{ name, scheduledTime }`; hand follow-up work to `waitUntil` from
   * `agent-unit/env`. Run one now with `agent-unit task <name>`.
   *
   * ```ts
   * tasks: { "send-digest": { schedule: "0 8 * * *", handler: "./src/tasks/digest.ts" } }
   * ```
   */
  tasks?: Record<string, TaskConfig>;
  /** App name for the manifest, MCP server info and A2A card. Default: package.json name. */
  name?: string;
  /**
   * Agents by name. Omit to load every module in `agentsDir`, named after its file
   * (`agents/triage.ts` serves as `triage`).
   */
  agents?: Record<string, unknown>;
  /** Default `agents`. */
  agentsDir?: string;
  /** Extra adapters, tried before the built-in ones. */
  adapters?: AgentAdapter<any>[];
  /**
   * Durable storage for runs (an unstorage driver). Default: the filesystem (`.data/agent-unit`)
   * on servers. Serverless presets need a shared driver such as redis, upstash, cloudflare-kv-binding,
   * upstash or netlify-blobs, because their filesystem does not survive between invocations.
   */
  storage?: StorageConfig;
  /** Nitro preset to build for. Default: `node-server`, or the NITRO_PRESET environment variable. */
  preset?: string;
  /**
   * What keeps runs alive. `"default"` stores runs with `storage` and wakes them with timers and a
   * scheduled sweep. `"durable-objects"` (Cloudflare, `cloudflare-module` preset) gives every run its
   * own Durable Object: strongly consistent storage, exactly one executor, and an alarm for every
   * sleep, yield and recovery. `storage` and `sweep` are then not used.
   */
  runtime?: "default" | "durable-objects";
  /**
   * Yield to a fresh invocation after this long, so long runs fit serverless limits. Default: chosen
   * per preset (25s on Workers, 240s on Vercel), unlimited on servers. `false` disables it.
   */
  budget?: string | number | false;
  /** Delete finished runs, with their journal and events, this long after they finish (`"30d"`). Applied by the sweep. */
  retention?: string | number;
  /** Cron for the sweep that wakes sleepers and recovers stalled runs. Default every minute. `false` disables it. */
  sweep?: string | false;
  /**
   * Cloudflare settings your app needs beside agent-unit's, in Cloudflare's own format: `wrangler`
   * is merged into the generated `wrangler.json` (D1, KV, R2 and Durable Object bindings, vars,
   * routes), and `exports` names a file whose classes the Worker also exports (a storage
   * provider's Durable Object, a Workflow). Same as `nitro.cloudflare`, which still works.
   */
  cloudflare?: {
    wrangler?: Record<string, unknown>;
    exports?: string;
  };
  /** Passed through to Nitro, merged over what agent-unit generates. */
  nitro?: Record<string, unknown>;
  /**
   * Settings for one Nitro preset, used instead of the top-level ones when building for it, so one
   * app can keep runs in Durable Objects on Workers, in Redis on Vercel and on disk on Node. Each
   * setting replaces the top-level value whole (a `storage` here is the whole storage). Keys are
   * preset names as `--preset` takes them; `agent-unit dev` uses the top-level settings.
   *
   * ```ts
   * presets: {
   *   "cloudflare-module": { runtime: "durable-objects" },
   *   vercel: { storage: { driver: "upstash", url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN } },
   * }
   * ```
   */
  presets?: Record<string, PresetConfig>;
}

/** Settings that may differ per Nitro preset. */
export const PRESET_SETTINGS = [
  "storage",
  "runtime",
  "budget",
  "retention",
  "sweep",
  "basePath",
  "authorize",
  "origin",
  "maxBodyBytes",
  "tasks",
  "cloudflare",
  "nitro",
] as const satisfies readonly (keyof AgentUnitConfig)[];

export type PresetConfig = Pick<AgentUnitConfig, (typeof PRESET_SETTINGS)[number]>;

/** Types an `agent-unit.config.ts`. */
export function defineConfig(config: AgentUnitConfig): AgentUnitConfig {
  return config;
}
