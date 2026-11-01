import { createStorage, type Driver } from "unstorage";
import { RunStore, type AtomicWrites, type LeaseBackend } from "../runtime/store";
import { randomId } from "../runtime/util";
import type { RunRecord } from "../types";
import { farmjsInfra } from "./farmjs";

// Farm.js storage: runs, journals, events, state and leases kept by Farm.js, in one store per project
// and environment. Farm.js Infra trades FARMJS_API_KEY for a short-lived token, and every read and
// write is a `POST {url}/v1/ops` with it. fetch only, so it runs on Node, Bun, Deno, Workers and every
// serverless host.

/** One operation of `POST {url}/v1/ops`. The ops of one request run in order, in one transaction. */
export type StoreOp =
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: unknown }
  | { op: "del"; key: string }
  | { op: "keys"; prefix: string }
  | { op: "cas"; key: string; expected: number | null; value: RunRecord }
  | { op: "lease.acquire"; run: string; owner: string; ttl: number }
  | { op: "lease.renew"; run: string; owner: string; ttl: number }
  | { op: "lease.release"; run: string; owner: string };

export interface FarmjsStoreOptions {
  /**
   * Where FARMJS_API_KEY (and FARMJS_API_URL, FARMJS_ENVIRONMENT, FARMJS_PROJECT_ID) are read, each
   * time a token is needed. Default: `process.env`.
   */
  env?: Record<string, string | undefined>;
}

/** The store lists at most this many keys at a time. */
const MAX_KEYS = 10_000;
const TOKEN_TIMEOUT_MS = 10_000;
const OPS_TIMEOUT_MS = 30_000;
/** A token is replaced once this share of its life has passed, and once on a 401. */
const REFRESH_AT = 0.8;
/** Infra's tokens live 15 minutes; assumed when an answer has no readable expiry. */
const TOKEN_LIFE_MS = 15 * 60_000;
/** However its expiry reads on this clock, a token is kept this long: a clock far ahead must not ask for one per call. */
const MIN_TOKEN_LIFE_MS = 30_000;

/** What to do when runs are kept in Farm.js storage and FARMJS_API_KEY is not set where the server runs. */
export const FARMJS_KEY_MISSING = `agent-unit: runs are kept in Farm.js storage here, but FARMJS_API_KEY is not set. Either:
  - add FARMJS_API_KEY (from app.farmjs.dev) to this server's environment
  - set storage, e.g. { driver: "upstash" } or { driver: "redis", url: process.env.REDIS_URL }
  - set it per target: presets: { <preset>: { storage: { ... } } }
  - or storage: "memory" if runs may be lost between requests`;

interface Token {
  url: string;
  token: string;
  refreshAt: number;
  /** When it expires, as this process's clock reads it. */
  expiresAt: number;
}

/** Tokens per Infra, key, environment and project, shared by every store in this process. */
const tokens = new Map<string, { current?: Token; pending?: Promise<Token> }>();

const warned = new Set<string>();
function warnOnce(topic: string, message: string) {
  if (warned.has(topic)) return;
  warned.add(topic);
  console.warn(message);
}

/** Why a fetch failed, with the system error under undici's "fetch failed". */
function reason(error: unknown): string {
  if ((error as Error | undefined)?.name === "TimeoutError") return "no answer in time";
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof code === "string" ? `${message}, ${code}` : message;
}

/** The error a response carries (`{ error: "..." }` or `{ error: { message } }`), or its first line of text. */
async function answered(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const error = body.error;
    const message = typeof error === "string" ? error : typeof (error as { message?: unknown })?.message === "string" ? (error as { message: string }).message : body.message;
    if (typeof message === "string" && message) return message;
  } catch {
    // Not JSON: the text itself, trimmed.
  }
  return text.trim().split("\n")[0]?.slice(0, 200) || "no details";
}

const TOKEN_HINTS: Record<number, string> = {
  401: "FARMJS_API_KEY is unknown, revoked or expired",
  403: "the key needs the agents:runtime permission, and FARMJS_PROJECT_ID set for an organization-wide key",
  429: "too many token requests; try again shortly",
  503: "Farm.js storage is not available on this Farm.js Infra",
};

const STORE_HINTS: Record<number, string> = {
  401: "it refused the token Farm.js Infra gave, even a fresh one",
  413: "a value is over its 1 MiB limit",
  429: "too many requests; try again shortly",
};

/** The operations of a request, for an error message: the first one and how many others. */
function describe(ops: StoreOp[]): string {
  const [first] = ops;
  if (!first) return "no operations";
  const target = "key" in first ? first.key : "prefix" in first ? `"${first.prefix}"` : first.run;
  return `${first.op} ${target}${ops.length > 1 ? ` and ${ops.length - 1} more` : ""}`;
}

async function fetchToken(infra: { api: string; headers: Record<string, string> }): Promise<Token> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(`${infra.api}/api/agents/store/token`, { method: "POST", headers: infra.headers, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`agent-unit: Farm.js storage was unreachable: no token from ${infra.api} (${reason(error)}).`, { cause: error });
  }
  if (!response.ok) {
    const hint = TOKEN_HINTS[response.status] ?? (await answered(response));
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`agent-unit: Farm.js storage got no token from Farm.js Infra (HTTP ${response.status}): ${hint}.`);
  }
  const body = (await response.json().catch(() => undefined)) as { url?: unknown; token?: unknown; expiresAt?: unknown } | undefined;
  if (typeof body?.url !== "string" || typeof body.token !== "string") {
    throw new Error(`agent-unit: Farm.js storage got no token: Farm.js Infra answered ${infra.api}/api/agents/store/token without a url and token.`);
  }
  const parsed = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) - started : Number.NaN;
  const life = Number.isFinite(parsed) ? Math.max(MIN_TOKEN_LIFE_MS, parsed) : TOKEN_LIFE_MS;
  return { url: body.url.replace(/\/+$/, ""), token: body.token, refreshAt: started + REFRESH_AT * life, expiresAt: started + life };
}

/** Sends operations to Farm.js storage with a token from Farm.js Infra, cached per process. */
export class FarmjsStoreClient {
  constructor(private readonly env: () => Record<string, string | undefined>) {}

  /** Runs `ops` in order, in one transaction, and returns their results in the same order. */
  async run(ops: StoreOp[]): Promise<unknown[]> {
    const infra = farmjsInfra(this.env());
    if (!infra) throw new Error(FARMJS_KEY_MISSING);
    const slotKey = JSON.stringify([infra.api, infra.headers]);
    let slot = tokens.get(slotKey);
    if (!slot) tokens.set(slotKey, (slot = {}));
    let token = await this.token(slot, infra);
    let response = await this.send(token, ops);
    if (response.status === 401) {
      // Expired early, or the store's secret rotated: one fresh token, once.
      void response.body?.cancel().catch(() => undefined);
      if (slot.current === token) slot.current = undefined;
      token = await this.token(slot, infra);
      response = await this.send(token, ops);
      if (response.status === 401 && slot.current === token) slot.current = undefined;
    }
    if (!response.ok) {
      const hint = STORE_HINTS[response.status] ?? (await answered(response));
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`agent-unit: Farm.js storage answered HTTP ${response.status} to ${describe(ops)}: ${hint}.`);
    }
    const body = (await response.json().catch(() => undefined)) as { results?: unknown } | undefined;
    if (!Array.isArray(body?.results) || body.results.length !== ops.length) {
      throw new Error(`agent-unit: Farm.js storage answered ${describe(ops)} without a result for each operation.`);
    }
    return body.results;
  }

  /** The cached token, or a new one once 80% of its life has passed. Calls at the same time share one request. */
  private async token(slot: { current?: Token; pending?: Promise<Token> }, infra: { api: string; headers: Record<string, string> }): Promise<Token> {
    const current = slot.current;
    if (current && Date.now() < current.refreshAt) return current;
    slot.pending ??= fetchToken(infra).then(
      (token) => {
        slot.current = token;
        slot.pending = undefined;
        return token;
      },
      (error) => {
        slot.pending = undefined;
        throw error;
      },
    );
    try {
      return await slot.pending;
    } catch (error) {
      // Infra did not answer the refresh, but the token it gave still has time left: use it until then.
      if (current && slot.current === current && Date.now() < current.expiresAt) return current;
      throw error;
    }
  }

  private async send(token: Token, ops: StoreOp[]): Promise<Response> {
    try {
      return await fetch(`${token.url}/v1/ops`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ops }),
        signal: AbortSignal.timeout(OPS_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`agent-unit: Farm.js storage was unreachable at ${token.url} (${reason(error)}) for ${describe(ops)}.`, { cause: error });
    }
  }
}

/**
 * unstorage hands drivers JSON text for objects and arrays: they go to the store as JSON values, so a
 * run record it compares by `version` is the same record whether a `set` or a `cas` wrote it. Other
 * values stay text, read back exactly as with any other driver.
 */
function stored(value: unknown): unknown {
  if (typeof value !== "string" || !/^[[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** unstorage over Farm.js storage. */
export function farmjsDriver(client: FarmjsStoreClient): Driver {
  const one = async (op: StoreOp) => (await client.run([op]))[0];
  return {
    name: "farmjs",
    getInstance: () => client,
    hasItem: async (key) => (await one({ op: "get", key })) != null,
    getItem: async (key) => (await one({ op: "get", key })) ?? null,
    setItem: async (key, value) => {
      await one({ op: "set", key, value: stored(value) });
    },
    removeItem: async (key) => {
      await one({ op: "del", key });
    },
    getKeys: async (base) => {
      const prefix = base ?? "";
      const keys = (await one({ op: "keys", prefix })) as string[];
      if (keys.length >= MAX_KEYS) {
        warnOnce("keys", `[agent-unit] Farm.js storage lists at most ${MAX_KEYS} keys at a time, and "${prefix}" has that many: a listing under it may be cut short.`);
      }
      return keys;
    },
  };
}

/**
 * Exact coordination on Farm.js storage, as `redisCoordination` is on Redis: a run record changes
 * only through the store's compare-and-set, and leases are taken, renewed and released atomically.
 */
export function farmjsCoordination(client: FarmjsStoreClient): { atomic: AtomicWrites; leases: LeaseBackend } {
  const one = async (op: StoreOp) => (await client.run([op]))[0];
  const ttl = (ms: number) => Math.max(1, Math.ceil(ms));
  return {
    atomic: {
      compareAndSet: async (key, expectedVersion, record) => (await one({ op: "cas", key, expected: expectedVersion ?? null, value: record })) === true,
    },
    leases: {
      acquire: async (run, owner, ttlMs) => (await one({ op: "lease.acquire", run, owner, ttl: ttl(ttlMs) })) === true,
      renew: async (run, owner, ttlMs) => (await one({ op: "lease.renew", run, owner, ttl: ttl(ttlMs) })) === true,
      release: async (run, owner) => {
        await one({ op: "lease.release", run, owner });
      },
      // No operation reads a lease. Taking it as an owner nobody else has and giving it back in the
      // same transaction tells whether it was free, and no one ever sees it taken.
      expired: async (run) => {
        const owner = randomId("probe");
        const [free] = await client.run([
          { op: "lease.acquire", run, owner, ttl: 1 },
          { op: "lease.release", run, owner },
        ]);
        return free === true;
      },
    },
  };
}

const farmjsStores = new WeakSet<RunStore>();

/**
 * Runs kept in Farm.js storage, with exact compare-and-set and leases: as many servers as you like
 * share it, on any host, with nothing to set up but FARMJS_API_KEY.
 *
 * ```ts
 * new RunEngine({ store: farmjsStore(), agents })
 * ```
 */
export function farmjsStore(options: FarmjsStoreOptions = {}): RunStore {
  const client = new FarmjsStoreClient(() => options.env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {});
  const store = new RunStore(createStorage({ driver: farmjsDriver(client) }), farmjsCoordination(client));
  farmjsStores.add(store);
  return store;
}

/** Whether `store` keeps its runs in Farm.js storage. */
export const isFarmjsStore = (store: RunStore): boolean => farmjsStores.has(store);
