import type { Storage } from "unstorage";
import type { AgentAdapter } from "../adapter/types";
import { functionAdapter, resolveAgent } from "../agents";
import { RunEngine } from "../runtime/engine";
import { RunStore } from "../runtime/store";
import { parseDuration } from "../runtime/util";
import { createHandler, type HandlerOptions, type RequestContext } from "./handler";

export interface AgentUnitOptions extends HandlerOptions {
  /** App name for the manifest, MCP server info and A2A card. */
  name?: string;
  /** Agents by name: framework agents, `defineAgent` agents, or modules exporting one as default. */
  agents: Record<string, unknown>;
  /** Adapters tried before the built-in function adapter, in order. */
  adapters?: AgentAdapter<any>[];
  /** Where runs, journals, events and state live. Any unstorage instance. */
  storage: Storage | RunStore;
  /** Yield to a fresh invocation after this long (`"25s"`, ms, or false). Default: no limit. */
  budget?: string | number | false;
  /** How long an execution owns a run before another process may take over. Default 60s. */
  lease?: string | number;
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

/** Builds a durable agent server from agents and storage. Mount `handler` anywhere that speaks Fetch. */
export function createAgentUnit(options: AgentUnitOptions): AgentUnit {
  const adapters = [...(options.adapters ?? []), functionAdapter];
  const agents = Object.entries(options.agents).map(([name, agent]) => resolveAgent(name, agent, adapters));
  const engine = new RunEngine({
    store: options.storage instanceof RunStore ? options.storage : new RunStore(options.storage),
    agents,
    name: options.name,
    budgetMs: ms(options.budget),
    leaseMs: ms(options.lease),
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
