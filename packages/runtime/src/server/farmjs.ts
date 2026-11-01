import type { WakeClock } from "../runtime/engine";
import { safeEqual } from "../runtime/util";

// Farm.js Infra as the clock that wakes runs on every host: the app registers each wake-up, and Infra
// calls `POST {endpoint}/__agent-unit/wake/{run}` at that time, signed with the app's FARMJS_API_KEY.
// Web Crypto only, so it runs on Workers, Deno, Bun and Node alike.

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A signature this far from now, either way, is refused, so a captured call cannot be replayed later. */
const SIGNATURE_WINDOW_S = 300;
const DEFAULT_API_URL = "https://app.farmjs.dev";
const REGISTER_TIMEOUT_MS = 2_000;
/** Infra takes at most 100 wake-ups per request, and none more than 366 days ahead. */
const MAX_BATCH = 100;
const MAX_AHEAD_MS = 365 * 86_400_000;

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

/**
 * Where Farm.js Infra is and the headers that identify the app to it: the key, and the environment
 * and project when they are set. Shared by every call agent-unit makes to Infra.
 */
export function farmjsInfra(env: Record<string, string | undefined>): { api: string; headers: Record<string, string> } | undefined {
  const apiKey = env.FARMJS_API_KEY;
  if (!apiKey) return undefined;
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
  if (env.FARMJS_ENVIRONMENT) headers["x-farm-environment"] = env.FARMJS_ENVIRONMENT;
  if (env.FARMJS_PROJECT_ID) headers["x-farm-project"] = env.FARMJS_PROJECT_ID;
  return { api: (env.FARMJS_API_URL || DEFAULT_API_URL).replace(/\/+$/, ""), headers };
}

/** Hosts that freeze between requests, where an in-process timer would not fire. */
function serverless(env: Record<string, string | undefined>): boolean {
  if (env.VERCEL || env.NETLIFY || env.AWS_LAMBDA_FUNCTION_NAME) return true;
  return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";
}

export interface FarmClockOptions {
  env: () => Record<string, string | undefined>;
  /** The base URL Infra calls back (origin and base path), from the deployment's own URL, never a request's Host. */
  endpoint: () => string | undefined;
}

/**
 * Registers wake-ups with Farm.js Infra (`POST {FARMJS_API_URL}/api/agents/wakes`). On when
 * FARMJS_API_KEY is set, unless AGENT_UNIT_CLOCK is `local`. Calls made together are sent as one
 * request, awaited for at most two seconds; a failure is logged once and never fails a run.
 */
export function farmClock(options: FarmClockOptions): WakeClock {
  const warned = new Set<string>();
  const warn = (topic: string, message: string) => {
    if (warned.has(topic)) return;
    warned.add(topic);
    console.warn(`[agent-unit] ${message}`);
  };
  let pending: Map<string, number> | undefined;
  let batch: Promise<void> | undefined;

  async function register(api: string, headers: Record<string, string>, body: string) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`no answer in ${REGISTER_TIMEOUT_MS / 1000}s`));
      }, REGISTER_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([fetch(`${api}/api/agents/wakes`, { method: "POST", headers, body, signal: controller.signal }), timeout]);
      void response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      warn(
        "register",
        `Farm.js Infra did not take the runs' wake-ups (${error instanceof Error ? error.message : String(error)}), so they depend on the sweep and in-process timers where those run. Check FARMJS_API_KEY and its agents:runtime permission.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function flush() {
    const wakes = [...(pending ?? [])];
    pending = undefined;
    batch = undefined;
    const infra = farmjsInfra(options.env());
    const endpoint = options.endpoint();
    if (!infra || !endpoint || !wakes.length) return;
    const { api } = infra;
    const headers = { ...infra.headers, "content-type": "application/json" };
    // A sleep longer than Infra takes is registered at its limit; the wake then answers the real time.
    const latest = Date.now() + MAX_AHEAD_MS;
    const requests: Promise<void>[] = [];
    for (let i = 0; i < wakes.length; i += MAX_BATCH) {
      const chunk = wakes.slice(i, i + MAX_BATCH).map(([run, at]) => ({ run, at: new Date(Math.min(at, latest)).toISOString() }));
      requests.push(register(api, headers, JSON.stringify({ endpoint, wakes: chunk })));
    }
    await Promise.all(requests);
  }

  return {
    mode() {
      const env = options.env();
      if (env.AGENT_UNIT_CLOCK === "local") return "off";
      if (!env.FARMJS_API_KEY) {
        if (env.AGENT_UNIT_CLOCK === "farmjs") warn("key", "AGENT_UNIT_CLOCK is farmjs, but FARMJS_API_KEY is not set, so Farm.js Infra cannot wake runs.");
        return "off";
      }
      const endpoint = options.endpoint();
      if (!endpoint?.startsWith("https://")) {
        warn(
          "endpoint",
          endpoint
            ? `Farm.js Infra calls https URLs only, and this deployment's URL is ${endpoint}: runs wake in-process and from the sweep.`
            : "FARMJS_API_KEY is set, but this deployment's URL is unknown, so Farm.js Infra cannot wake runs. Set AGENT_UNIT_URL (or the `origin` option).",
        );
        return "off";
      }
      return serverless(env) ? "only" : "backstop";
    },
    schedule(runId, at) {
      // Infra keeps one time per run, so the latest call for a run in a batch is the one that counts.
      (pending ??= new Map()).set(runId, at);
      return (batch ??= new Promise<void>((resolve) => setTimeout(resolve, 0))
        .then(flush)
        .catch((error) => warn("register", `could not register wake-ups with Farm.js Infra: ${error instanceof Error ? error.message : String(error)}`)));
    },
  };
}
