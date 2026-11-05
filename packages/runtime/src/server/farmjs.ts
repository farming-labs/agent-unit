import type { ApprovalRegistry, WakeClock } from "../runtime/engine";
import { safeEqual } from "../runtime/util";

// Farm.js Infra as the clock that wakes runs on every host: the app registers each wake-up, and Infra
// calls `POST {endpoint}/__agent-unit/wake/{run}` at that time, signed with the app's FARMJS_API_KEY.
// It also shows the interrupts runs wait on as approvals, and answers one with
// `POST {endpoint}/__agent-unit/answer/{run}`, signed the same way.
// Web Crypto only, so it runs on Workers, Deno, Bun and Node alike.

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A signature this far from now, either way, is refused, so a captured call cannot be replayed later. */
const SIGNATURE_WINDOW_S = 300;
const DEFAULT_API_URL = "https://app.farmjs.dev";
const REGISTER_TIMEOUT_MS = 2_000;
/** Infra takes at most 100 entries per request, and no wake-up more than 366 days ahead. */
const MAX_BATCH = 100;
const MAX_AHEAD_MS = 365 * 86_400_000;
/** Infra takes interrupt names and pause keys of 1 to 120 characters, and payloads up to 16 KB of JSON. */
const MAX_NAME = 120;
const MAX_PAYLOAD_BYTES = 16 * 1024;

let cached: { apiKey: string; key: Promise<CryptoKey> } | undefined;

/** The HMAC key is the hex SHA-256 of FARMJS_API_KEY, as text: Infra keeps only the key's hash. */
function signingKey(apiKey: string): Promise<CryptoKey> {
  if (cached?.apiKey !== apiKey) {
    const key = crypto.subtle
      .digest("SHA-256", encoder.encode(apiKey))
      .then((digest) => crypto.subtle.importKey("raw", encoder.encode(hex(digest)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
    cached = { apiKey, key };
  }
  return cached.key;
}

async function sign(apiKey: string, t: string, method: string, pathname: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await signingKey(apiKey), encoder.encode(`farmjs-agent-v1\n${t}\n${method} ${pathname}`)));
}

/** The `farmjs-signature` header for a call to `pathname`, signed the way Farm.js Infra signs its own. */
export async function farmjsSignature(apiKey: string, method: string, pathname: string, now = Date.now()): Promise<string> {
  const t = String(Math.floor(now / 1000));
  return `t=${t},v1=${await sign(apiKey, t, method, pathname)}`;
}

/** Whether `header` (`t=<unix seconds>,v1=<hex>`) signs this very call with FARMJS_API_KEY, within five minutes of now. */
export async function verifyFarmjsSignature(apiKey: string, header: string, method: string, pathname: string, now = Date.now()): Promise<boolean> {
  const fields = new Map<string, string>();
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    const name = part.slice(0, at).trim();
    if (at > 0 && !fields.has(name)) fields.set(name, part.slice(at + 1).trim());
  }
  const t = fields.get("t");
  const v1 = fields.get("v1");
  if (!t || !/^\d{1,12}$/.test(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(t)) > SIGNATURE_WINDOW_S) return false;
  return safeEqual(await sign(apiKey, t, method, pathname), v1);
}

/** Hosts that freeze between requests, where an in-process timer would not fire. */
function serverless(env: Record<string, string | undefined>): boolean {
  if (env.VERCEL || env.NETLIFY || env.AWS_LAMBDA_FUNCTION_NAME) return true;
  return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function loopback(url: string | undefined, protocols: string[]): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return protocols.includes(parsed.protocol) && LOOPBACK.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** Infra calls https URLs, and a local http one only when Infra itself runs locally (FARMJS_API_URL). */
function reachable(env: Record<string, string | undefined>, endpoint: string): boolean {
  if (endpoint.startsWith("https://")) return true;
  return loopback(endpoint, ["http:"]) && loopback(env.FARMJS_API_URL, ["http:", "https:"]);
}

const HTTPS_ONLY = "Farm.js Infra calls https URLs only (a localhost one too when FARMJS_API_URL is local)";

export interface FarmClockOptions {
  env: () => Record<string, string | undefined>;
  /** The base URL Infra calls back (origin and base path), from the deployment's own URL, never a request's Host. */
  endpoint: () => string | undefined;
}

type Warn = (topic: string, message: string) => void;

function warnOnce(): Warn {
  const warned = new Set<string>();
  return (topic, message) => {
    if (warned.has(topic)) return;
    warned.add(topic);
    console.warn(`[agent-unit] ${message}`);
  };
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Sends entries to `POST {FARMJS_API_URL}/api/agents/{list}` as `{ endpoint, [list]: entries }`.
 * Entries queued together are sent as one request (100 entries at most to a request), awaited for at
 * most two seconds; a failure is logged once and never rejects. An entry queued under an id already
 * waiting replaces it, unless `merge` keeps another.
 */
function infraSender<T>(
  options: FarmClockOptions & { list: "wakes" | "approvals"; failed: (reason: string) => string; merge?: (previous: T, next: T) => T },
  warn: Warn,
) {
  let pending: Map<string, T> | undefined;
  let batch: Promise<void> | undefined;

  async function post(url: string, headers: Record<string, string>, body: string) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`no answer in ${REGISTER_TIMEOUT_MS / 1000}s`));
      }, REGISTER_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([fetch(url, { method: "POST", headers, body, signal: controller.signal }), timeout]);
      void response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      warn("register", options.failed(reason(error)));
    } finally {
      clearTimeout(timer);
    }
  }

  async function flush() {
    const entries = [...(pending?.values() ?? [])];
    pending = undefined;
    batch = undefined;
    const env = options.env();
    const apiKey = env.FARMJS_API_KEY;
    const endpoint = options.endpoint();
    if (!apiKey || !endpoint || !entries.length) return;
    const url = `${(env.FARMJS_API_URL || DEFAULT_API_URL).replace(/\/+$/, "")}/api/agents/${options.list}`;
    const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    if (env.FARMJS_ENVIRONMENT) headers["x-farm-environment"] = env.FARMJS_ENVIRONMENT;
    if (env.FARMJS_PROJECT_ID) headers["x-farm-project"] = env.FARMJS_PROJECT_ID;
    const requests: Promise<void>[] = [];
    for (let i = 0; i < entries.length; i += MAX_BATCH) {
      requests.push(post(url, headers, JSON.stringify({ endpoint, [options.list]: entries.slice(i, i + MAX_BATCH) })));
    }
    await Promise.all(requests);
  }

  return {
    send(id: string, entry: T): Promise<void> {
      pending ??= new Map();
      const previous = pending.get(id);
      pending.set(id, previous !== undefined && options.merge ? options.merge(previous, entry) : entry);
      return (batch ??= new Promise<void>((resolve) => setTimeout(resolve, 0))
        .then(flush)
        .catch((error) => warn("register", options.failed(reason(error)))));
    },
  };
}

/**
 * Registers wake-ups with Farm.js Infra (`POST {FARMJS_API_URL}/api/agents/wakes`). On when
 * FARMJS_API_KEY is set, unless AGENT_UNIT_CLOCK is `local`. Calls made together are sent as one
 * request, awaited for at most two seconds; a failure is logged once and never fails a run.
 */
export function farmClock(options: FarmClockOptions): WakeClock {
  const warn = warnOnce();
  // Infra keeps one time per run, so the latest call for a run in a batch is the one that counts.
  const sender = infraSender<{ run: string; at: string }>(
    {
      ...options,
      list: "wakes",
      failed: (why) =>
        `Farm.js Infra did not take the runs' wake-ups (${why}), so they depend on the sweep and in-process timers where those run. Check FARMJS_API_KEY and its agents:runtime permission.`,
    },
    warn,
  );

  return {
    mode() {
      const env = options.env();
      if (env.AGENT_UNIT_CLOCK === "local") return "off";
      if (!env.FARMJS_API_KEY) {
        if (env.AGENT_UNIT_CLOCK === "farmjs") warn("key", "AGENT_UNIT_CLOCK is farmjs, but FARMJS_API_KEY is not set, so Farm.js Infra cannot wake runs.");
        return "off";
      }
      const endpoint = options.endpoint();
      if (!endpoint || !reachable(env, endpoint)) {
        warn(
          "endpoint",
          endpoint
            ? `${HTTPS_ONLY}, and this deployment's URL is ${endpoint}: runs wake in-process and from the sweep.`
            : "FARMJS_API_KEY is set, but this deployment's URL is unknown, so Farm.js Infra cannot wake runs. Set AGENT_UNIT_URL (or the `origin` option).",
        );
        return "off";
      }
      return serverless(env) ? "only" : "backstop";
    },
    schedule(runId, at) {
      // A sleep longer than Infra takes is registered at its limit; the wake then answers the real time.
      return sender.send(runId, { run: runId, at: new Date(Math.min(at, Date.now() + MAX_AHEAD_MS)).toISOString() });
    },
  };
}

type ApprovalEntry =
  | { run: string; key: string; agent: string; interrupt: string; payload?: unknown; status: "open" }
  | { run: string; key: string; interrupt: string; status: "closed" };

const utf8Length = (text: string) => encoder.encode(text).byteLength;

/**
 * Shows the interrupts runs wait on in Farm.js Infra, as approvals (`POST {FARMJS_API_URL}/api/agents/approvals`),
 * and tells it when one closes some other way. On whenever FARMJS_API_KEY is set and Infra can reach
 * this deployment, on any host and whatever AGENT_UNIT_CLOCK says. Sent as the clock's wake-ups are:
 * together, awaited for at most two seconds, a failure logged once and never failing a run.
 */
export function farmApprovals(options: FarmClockOptions): ApprovalRegistry {
  const warn = warnOnce();
  const sender = infraSender<ApprovalEntry>(
    {
      ...options,
      list: "approvals",
      failed: (why) =>
        `Farm.js Infra did not take the runs' approvals (${why}), so its dashboard may not show what they wait on; they can still be answered through this API. Check FARMJS_API_KEY and its agents:runtime permission.`,
      // A pause closes once: a close queued before its open (a cancel racing the interrupt) still wins.
      merge: (previous, next) => (previous.status === "closed" ? previous : next),
    },
    warn,
  );

  /** Whether Infra should hear about this pause, saying once why not. */
  const enabled = (key: string, name: string): boolean => {
    const env = options.env();
    if (!env.FARMJS_API_KEY) return false;
    const endpoint = options.endpoint();
    if (!endpoint || !reachable(env, endpoint)) {
      warn(
        "endpoint",
        endpoint
          ? `${HTTPS_ONLY}, and this deployment's URL is ${endpoint}: interrupts are not sent to Farm.js Infra for approval.`
          : "FARMJS_API_KEY is set, but this deployment's URL is unknown, so Farm.js Infra cannot answer interrupts. Set AGENT_UNIT_URL (or the `origin` option).",
      );
      return false;
    }
    if (!name || name.length > MAX_NAME || !key || key.length > MAX_NAME) {
      warn(
        "name",
        `Farm.js Infra takes interrupt names and keys of 1 to ${MAX_NAME} characters, so the interrupt "${name.slice(0, MAX_NAME)}" (key "${key.slice(0, MAX_NAME)}") is not sent for approval. Use a shorter name.`,
      );
      return false;
    }
    return true;
  };

  return {
    open(run, interrupt) {
      if (!enabled(interrupt.key, interrupt.name)) return Promise.resolve();
      const json = interrupt.payload === undefined ? undefined : JSON.stringify(interrupt.payload);
      const payload = json !== undefined && utf8Length(json) > MAX_PAYLOAD_BYTES ? { omitted: "payload larger than 16 KB" } : interrupt.payload;
      return sender.send(`${run.id}\n${interrupt.key}`, { run: run.id, key: interrupt.key, agent: run.agent, interrupt: interrupt.name, payload, status: "open" });
    },
    close(run, interrupt) {
      if (!enabled(interrupt.key, interrupt.name)) return Promise.resolve();
      return sender.send(`${run.id}\n${interrupt.key}`, { run: run.id, key: interrupt.key, interrupt: interrupt.name, status: "closed" });
    },
  };
}
