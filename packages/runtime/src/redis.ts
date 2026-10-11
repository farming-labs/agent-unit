import type { AtomicWrites, LeaseBackend } from "./runtime/store";
import type { RunRecord } from "./types";

/** The one method agent-unit needs from a Redis client (ioredis, node-redis via a small wrapper, Upstash). */
export interface RedisLike {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisCoordinationOptions {
  /** The Redis client, or a function returning it (unstorage's redis driver: `() => driver.getInstance()`). */
  client: RedisLike | (() => RedisLike | Promise<RedisLike>);
  /** The `base` prefix of unstorage's redis driver, so keys match the records it stores. */
  base?: string;
}

// A record is replaced only if it still has the version the caller read ('' = must not exist).
const COMPARE_AND_SET = `
local current = redis.call('GET', KEYS[1])
if current == false then
  if ARGV[1] ~= '' then return 0 end
else
  if ARGV[1] == '' then return 0 end
  local ok, record = pcall(cjson.decode, current)
  local version = 0
  if ok and type(record) == 'table' and type(record.version) == 'number' then version = record.version end
  if tostring(version) ~= ARGV[1] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;

// Leases are owner strings with a Redis expiry. A JSON lease left by the storage-backed default is
// honoured until its own expiry, so switching to Redis leases never steals a live run.
const ACQUIRE = `
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[1] then
  if string.sub(current, 1, 1) ~= '{' then return 0 end
  local ok, lease = pcall(cjson.decode, current)
  if ok and type(lease) == 'table' and type(lease['until']) == 'number' and lease['until'] > tonumber(ARGV[3]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1`;

const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`;

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 1`;

const EXPIRED = `
local current = redis.call('GET', KEYS[1])
if current == false then return 1 end
if string.sub(current, 1, 1) == '{' then
  local ok, lease = pcall(cjson.decode, current)
  if ok and type(lease) == 'table' and type(lease['until']) == 'number' and lease['until'] <= tonumber(ARGV[1]) then return 1 end
end
return 0`;

/**
 * Strict coordination on Redis: run records change only through an atomic compare-and-set, and
 * leases are taken, renewed and released atomically, so two processes can never overwrite each
 * other's change or execute one run at the same time.
 *
 * ```ts
 * new RunStore(storage, redisCoordination({ client: redis, base: "agents" }))
 * ```
 */
export function redisCoordination(options: RedisCoordinationOptions): { atomic: AtomicWrites; leases: LeaseBackend } {
  const base = (options.base ?? "").replace(/:+$/, "");
  const key = (name: string) => (base ? `${base}:${name}` : name);
  const client = async () => (typeof options.client === "function" ? await options.client() : options.client);
  const run = async (script: string, name: string, ...args: (string | number)[]) =>
    Number(await (await client()).eval(script, 1, key(name), ...args));
  return {
    atomic: {
      async compareAndSet(name: string, expectedVersion: number | undefined, record: RunRecord) {
        return (await run(COMPARE_AND_SET, name, expectedVersion === undefined ? "" : String(expectedVersion), JSON.stringify(record))) === 1;
      },
    },
    leases: {
      acquire: async (id, owner, ttlMs) => (await run(ACQUIRE, `lease:${id}`, owner, Math.max(1, Math.ceil(ttlMs)), Date.now())) === 1,
      renew: async (id, owner, ttlMs) => (await run(RENEW, `lease:${id}`, owner, Math.max(1, Math.ceil(ttlMs)))) === 1,
      release: async (id, owner) => {
        await run(RELEASE, `lease:${id}`, owner);
      },
      expired: async (id) => (await run(EXPIRED, `lease:${id}`, Date.now())) === 1,
    },
  };
}
