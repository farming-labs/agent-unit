/**
 * The host's environment, the same way on every host: your secrets and variables, and on Cloudflare
 * Workers also your bindings (D1, KV, R2, Durable Objects). Use it to connect your own storage:
 *
 * ```ts
 * import { env } from "agent-unit/env";
 * const storage = env.DB ? new D1Store({ binding: env.DB }) : new LibSQLStore({ url: env.DATABASE_URL });
 * ```
 *
 * Builds for Cloudflare Workers resolve this module to `cloudflare:workers` (the `workerd` export
 * condition); everywhere else it is `process.env`.
 */
export const env: Record<string, any> = typeof process !== "undefined" && process.env ? process.env : {};
export { runInScope, waitUntil } from "./scope";
