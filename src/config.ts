import type { AgentAdapter } from "./adapter/types";
import type { HandlerOptions } from "./server/handler";

/** An unstorage driver by name plus its options, e.g. `{ driver: "redis", url: process.env.REDIS_URL }`. */
export interface StorageConfig {
  driver: string;
  [option: string]: unknown;
}

export interface AgentUnitConfig extends Pick<HandlerOptions, "basePath" | "authorize"> {
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
   * Yield to a fresh invocation after this long, so long runs fit serverless limits. Default: chosen
   * per preset (25s on Workers, 240s on Vercel), unlimited on servers. `false` disables it.
   */
  budget?: string | number | false;
  /** Cron for the sweep that wakes sleepers and recovers stalled runs. Default every minute. `false` disables it. */
  sweep?: string | false;
  /** Passed through to Nitro, merged over what agent-unit generates. */
  nitro?: Record<string, unknown>;
}

/** Types an `agent-unit.config.ts`. */
export function defineConfig(config: AgentUnitConfig): AgentUnitConfig {
  return config;
}
