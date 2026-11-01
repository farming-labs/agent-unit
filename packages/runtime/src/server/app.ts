import { createStorage, type Storage } from "unstorage";
import { validateAdapter, type AgentAdapter } from "../adapter/types";
import { functionAdapter, resolveAgent } from "../agents";
import { RunEngine } from "../runtime/engine";
import { RunStore } from "../runtime/store";
import { parseDuration } from "../runtime/util";
import { FARMJS_KEY_MISSING, farmjsStore, isFarmjsStore } from "./farmjs-store";
import { createHandler, type HandlerOptions, type RequestContext } from "./handler";

export interface AgentUnitOptions extends HandlerOptions {
  /** App name for the manifest, MCP server info and A2A card. */
  name?: string;
  /** Agents by name: framework agents, `defineAgent` agents, or modules exporting one as default. */
  agents: Record<string, unknown>;
  /** Adapters tried before the built-in function adapter, in order. */
  adapters?: AgentAdapter<any>[];
  /**
   * Where runs, journals, events and state live: any unstorage instance or `RunStore`, `"farmjs"`
   * (Farm.js storage, with FARMJS_API_KEY) or `"memory"` (lost when the process stops). Default:
   * `"farmjs"` when FARMJS_API_KEY is set.
   */
  storage?: Storage | RunStore | "farmjs" | "memory";
  /** Yield to a fresh invocation after this long (`"25s"`, ms, or false). Default: no limit. */
  budget?: string | number | false;
  /** How long an execution owns a run before another process may take over. Default 60s. */
  lease?: string | number;
  /** Delete finished runs, with their journal and events, this long after they finish (`"30d"`). Default: 30 days in Farm.js storage, otherwise never. */
  retention?: string | number;
  /** Fail a run after this many crashed executions in a row. Default 5. */
  maxCrashes?: number;
  /** Merge streamed deltas arriving within this window into one event and one write (ms). 0 turns it off. Default 50. */
  deltaBatchMs?: number;
  env?: Record<string, string | undefined>;
  /** Keeps background work alive on hosts that need it, for work not tied to a request. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface AgentUnit {
  engine: RunEngine;
  /** The HTTP API as a Web handler. Pass the host's `waitUntil` in the context on serverless. */
  handler: (request: Request, context?: RequestContext) => Promise<Response>;
  /** `fetch`-shaped alias, so the unit is itself a server entry for Bun, Deno, Workers and srvx. */
  fetch: (request: Request) => Promise<Response>;
  close(): void;
}

const ms = (value: string | number | false | undefined) =>
  value === undefined || value === false ? undefined : typeof value === "number" ? value : parseDuration(value);

const NO_STORAGE = `agent-unit: runs need storage, and none is set. Either:
  - add FARMJS_API_KEY (from app.farmjs.dev) to use Farm.js storage, or set storage: "farmjs"
  - pass storage: any unstorage instance, e.g. createStorage({ driver: redis({ url: process.env.REDIS_URL }) })
  - or storage: "memory" if runs may be lost between requests`;

let warnedNoKey = false;

/** The run store `storage` names, or Farm.js storage when it is left out and FARMJS_API_KEY is set. */
function runStore(options: AgentUnitOptions): RunStore {
  const env = () => options.env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const storage = options.storage ?? (env().FARMJS_API_KEY ? "farmjs" : undefined);
  if (storage === undefined) throw new Error(NO_STORAGE);
  if (storage === "memory") return new RunStore(createStorage());
  if (storage === "farmjs") {
    // Every use throws until the key is set; say so once as the server starts, before any request.
    if (!env().FARMJS_API_KEY && !warnedNoKey) {
      warnedNoKey = true;
      console.warn(FARMJS_KEY_MISSING);
    }
    return farmjsStore({ env: options.env });
  }
  if (typeof storage === "string") throw new Error(`agent-unit: storage is "farmjs", "memory", an unstorage instance or a RunStore, not "${storage}".`);
  return storage instanceof RunStore ? storage : new RunStore(storage);
}

/** Builds a durable agent server from agents and storage. Mount `handler` anywhere that speaks Fetch. */
export function createAgentUnit(options: AgentUnitOptions): AgentUnit {
  const adapters = [...(options.adapters ?? []).map((adapter, index) => validateAdapter(adapter, `adapters[${index}]`)), functionAdapter];
  const agents = Object.entries(options.agents).map(([name, agent]) => resolveAgent(name, agent, adapters));
  const store = runStore(options);
  const engine = new RunEngine({
    store,
    agents,
    name: options.name,
    budgetMs: ms(options.budget),
    leaseMs: ms(options.lease),
    // Farm.js storage keeps finished runs for 30 days unless told otherwise.
    retentionMs: ms(options.retention ?? (isFarmjsStore(store) ? "30d" : undefined)),
    maxCrashes: options.maxCrashes,
    deltaBatchMs: options.deltaBatchMs,
    env: options.env,
    waitUntil: options.waitUntil,
  });
  const handler = createHandler(engine, options);
  return {
    engine,
    handler,
    fetch: (request) => handler(request),
    close: () => engine.close(),
  };
}
