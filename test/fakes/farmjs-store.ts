import { serve } from "srvx";

// Farm.js Infra's store token route and the store Worker's `POST /v1/ops`, in memory, with the
// contract's semantics: ops run in order in one transaction, cas compares the stored record's
// version, leases are owner strings with an expiry, and the limits answer 400, 401 and 413.

const MAX_OPS = 50;
const MAX_KEY_BYTES = 512;
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_KEYS = 10_000;

const bytes = (text: string) => new TextEncoder().encode(text).length;

type Op = { op: string; key?: unknown; prefix?: unknown; value?: unknown; expected?: unknown; run?: unknown; owner?: unknown; ttl?: unknown };

interface Namespace {
  /** Values as JSON text, as the Durable Object's `kv` table keeps them. */
  kv: Map<string, string>;
  lease: Map<string, { owner: string; until: number }>;
}

export interface FakeFarmjsStore {
  /** FARMJS_API_URL for agent-unit. */
  url: string;
  /** Where the token route sends agent-unit: a path of its own, so a client that ignores it fails. */
  storeUrl: string;
  /** FARMJS_API_KEY and FARMJS_API_URL for this fake. */
  env: Record<string, string>;
  /** Every token request, with its headers. */
  tokenRequests: Headers[];
  /** Every ops request's ops, in order. */
  opsRequests: Op[][];
  /** The namespaces by `project:environment`. */
  namespaces: Map<string, Namespace>;
  /** One namespace's values, parsed. */
  values(namespace?: string): Map<string, unknown>;
  /** Live leases of one namespace. */
  leases(namespace?: string): Map<string, { owner: string; until: number }>;
  /** Makes every token issued so far invalid, as an expiry or a rotated secret would. */
  revokeTokens(): void;
  /** The store refuses every token, old and new. */
  refuseAllTokens(refuse?: boolean): void;
  /** The token route answers this status (undefined: answers normally). */
  failTokens(status?: number): void;
  close(): Promise<void>;
}

export async function startFakeFarmjsStore(options: { key?: string; tokenLifeMs?: number } = {}): Promise<FakeFarmjsStore> {
  const key = options.key ?? "farmjs_fake_key";
  const tokenLifeMs = options.tokenLifeMs ?? 15 * 60_000;
  const tokens = new Map<string, { namespace: string; expires: number }>();
  const namespaces = new Map<string, Namespace>();
  const tokenRequests: Headers[] = [];
  const opsRequests: Op[][] = [];
  let tokenFailure: number | undefined;
  let refuseAll = false;
  let issued = 0;
  let origin = "";

  const namespaceOf = (name: string) => {
    let namespace = namespaces.get(name);
    if (!namespace) namespaces.set(name, (namespace = { kv: new Map(), lease: new Map() }));
    return namespace;
  };

  function issueToken(request: Request): Response {
    tokenRequests.push(request.headers);
    if (request.headers.get("authorization") !== `Bearer ${key}`) return Response.json({ error: "unknown key" }, { status: 401 });
    if (tokenFailure) return Response.json({ error: "failing on purpose" }, { status: tokenFailure });
    const project = request.headers.get("x-farm-project") ?? "proj_fake";
    const environment = request.headers.get("x-farm-environment") ?? "production";
    const token = `v1.fake${++issued}.sig`;
    const expires = Date.now() + tokenLifeMs;
    tokens.set(token, { namespace: `${project}:${environment}`, expires });
    return Response.json({ url: `${origin}/store`, token, expiresAt: new Date(expires).toISOString() });
  }

  /** Checks every op before running any, as the Worker does: one bad op fails the whole request. */
  function invalid(ops: unknown): Response | undefined {
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_OPS) return Response.json({ error: `1 to ${MAX_OPS} ops` }, { status: 400 });
    for (const op of ops as Op[]) {
      const keyed = ["get", "set", "del", "cas"].includes(op?.op);
      const leased = op?.op?.startsWith("lease.");
      if (!keyed && !leased && op?.op !== "keys") return Response.json({ error: `unknown op ${op?.op}` }, { status: 400 });
      if (keyed && (typeof op.key !== "string" || !op.key || bytes(op.key) > MAX_KEY_BYTES)) return Response.json({ error: "bad key" }, { status: 400 });
      if (op.op === "keys" && typeof op.prefix !== "string") return Response.json({ error: "bad prefix" }, { status: 400 });
      if (leased && (typeof op.run !== "string" || typeof op.owner !== "string")) return Response.json({ error: "bad lease" }, { status: 400 });
      if ((op.op === "lease.acquire" || op.op === "lease.renew") && !(typeof op.ttl === "number" && op.ttl > 0)) return Response.json({ error: "bad ttl" }, { status: 400 });
      if (op.op === "cas" && !(op.expected === null || typeof op.expected === "number")) return Response.json({ error: "bad expected" }, { status: 400 });
      if (op.op === "cas" && typeof (op.value as { version?: unknown } | null)?.version !== "number") return Response.json({ error: "cas needs a versioned record" }, { status: 400 });
      if ((op.op === "set" || op.op === "cas") && (op.value === undefined || bytes(JSON.stringify(op.value)) > MAX_VALUE_BYTES)) {
        return Response.json({ error: "value too large" }, { status: op.value === undefined ? 400 : 413 });
      }
    }
    return undefined;
  }

  const versionOf = (text: string | undefined) => {
    if (text === undefined) return undefined;
    const record = JSON.parse(text) as { version?: unknown } | null;
    return record && typeof record === "object" && typeof record.version === "number" ? record.version : 0;
  };

  function runOps(namespace: Namespace, ops: Op[]): unknown[] {
    const now = Date.now();
    return ops.map((op) => {
      const key = op.key as string;
      const run = op.run as string;
      switch (op.op) {
        case "get": {
          const text = namespace.kv.get(key);
          return text === undefined ? null : JSON.parse(text);
        }
        case "set":
          namespace.kv.set(key, JSON.stringify(op.value));
          return true;
        case "del":
          namespace.kv.delete(key);
          return true;
        case "keys":
          return [...namespace.kv.keys()].filter((name) => name.startsWith(op.prefix as string)).sort().slice(0, MAX_KEYS);
        case "cas": {
          const current = versionOf(namespace.kv.get(key));
          if (op.expected === null ? current !== undefined : current !== op.expected) return false;
          namespace.kv.set(key, JSON.stringify(op.value));
          return true;
        }
        case "lease.acquire": {
          const lease = namespace.lease.get(run);
          if (lease && lease.owner !== op.owner && lease.until > now) return false;
          namespace.lease.set(run, { owner: op.owner as string, until: now + (op.ttl as number) });
          return true;
        }
        case "lease.renew": {
          const lease = namespace.lease.get(run);
          if (!lease || lease.owner !== op.owner || lease.until <= now) return false;
          lease.until = now + (op.ttl as number);
          return true;
        }
        case "lease.release":
          if (namespace.lease.get(run)?.owner === op.owner) namespace.lease.delete(run);
          return true;
        default:
          throw new Error(`unreachable: ${op.op}`);
      }
    });
  }

  async function handleOps(request: Request): Promise<Response> {
    const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const grant = token === undefined ? undefined : tokens.get(token);
    if (refuseAll || !grant || grant.expires <= Date.now()) return Response.json({ error: "bad or expired token" }, { status: 401 });
    const body = (await request.json().catch(() => undefined)) as { ops?: unknown } | undefined;
    const bad = invalid(body?.ops);
    if (bad) return bad;
    const ops = body!.ops as Op[];
    opsRequests.push(ops);
    return Response.json({ results: runOps(namespaceOf(grant.namespace), ops) });
  }

  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (request.method === "POST" && pathname === "/api/agents/store/token") return issueToken(request);
      if (request.method === "POST" && pathname === "/store/v1/ops") return handleOps(request);
      return new Response("not found", { status: 404 });
    },
  });
  await server.ready();
  origin = new URL(server.url!).origin;

  return {
    url: origin,
    storeUrl: `${origin}/store`,
    env: { FARMJS_API_KEY: key, FARMJS_API_URL: origin },
    tokenRequests,
    opsRequests,
    namespaces,
    values(name = "proj_fake:production") {
      return new Map([...(namespaces.get(name)?.kv ?? [])].map(([entry, text]) => [entry, JSON.parse(text) as unknown]));
    },
    leases(name = "proj_fake:production") {
      const now = Date.now();
      return new Map([...(namespaces.get(name)?.lease ?? [])].filter(([, lease]) => lease.until > now));
    },
    revokeTokens: () => tokens.clear(),
    refuseAllTokens: (refuse = true) => {
      refuseAll = refuse;
    },
    failTokens: (status) => {
      tokenFailure = status;
    },
    close: () => server.close(true),
  };
}
