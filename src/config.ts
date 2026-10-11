import type { AgentAdapter } from "@agent-unit/runtime/adapter";
import type { HandlerOptions } from "@agent-unit/runtime/server";

/** An unstorage driver by name plus its options, e.g. `{ driver: "redis", url: process.env.REDIS_URL }`. */
export interface StorageConfig {
  driver: string;
  [option: string]: unknown;
}

export interface AgentUnitConfig extends Pick<HandlerOptions, "basePath" | "authorize" | "origin" | "maxBodyBytes"> {
  /**
   * Your own server, to build for any host instead of agent-unit's engine: the path of a module whose
   * default export handles web requests, a Hono app, `export default { fetch }` or a function
   * `(request, env, ctx) => Response`. Your framework then owns its routes, runs and storage, so the
   * engine settings (`agents`, `storage`, `runtime`, ...) do not apply. On Workers it gets the
   * Worker's `env` and `ctx`; read configuration anywhere with `agent-unit/env`.
   */
  server?: string;
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
   * vercel-kv or netlify-blobs, because their filesystem does not survive between invocations.
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
}

/** Types an `agent-unit.config.ts`. */
export function defineConfig(config: AgentUnitConfig): AgentUnitConfig {
  return config;
}
