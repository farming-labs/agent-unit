import type { Driver } from "unstorage";
import type { DurableObjectStorageLike } from "./types";

const keysOf = (map: Map<string, unknown>) => [...map.keys()];

/** unstorage over a Durable Object's own storage: strongly consistent, private to that object. */
export function durableStorageDriver(storage: DurableObjectStorageLike): Driver {
  return {
    name: "durable-object",
    hasItem: async (key) => (await storage.get(key)) !== undefined,
    getItem: async (key) => (await storage.get(key)) ?? null,
    setItem: async (key, value) => {
      await storage.put(key, value);
    },
    removeItem: async (key) => {
      await storage.delete(key);
    },
    getKeys: async (base) => keysOf(await storage.list(base ? { prefix: base } : {})),
    clear: async (base) => {
      for (const key of keysOf(await storage.list(base ? { prefix: base } : {}))) await storage.delete(key);
    },
  };
}

/** The RPC surface of the shared index object, used as a remote key-value store. */
export interface IndexStub {
  kvGet(key: string): Promise<unknown>;
  kvSet(key: string, value: unknown): Promise<void>;
  kvDelete(key: string): Promise<void>;
  kvKeys(base?: string): Promise<string[]>;
}

/**
 * unstorage over the shared index object, reached by RPC from any Worker or run object. `base` keeps
 * each mount (`runs`, `state`, `kv`) in its own key space inside the one object.
 */
export function indexStorageDriver(stub: () => IndexStub, base: string): Driver {
  const prefix = `${base}:`;
  const full = (key: string) => prefix + key;
  return {
    name: "agent-unit-index",
    hasItem: async (key) => (await stub().kvGet(full(key))) !== null,
    getItem: (key) => stub().kvGet(full(key)),
    setItem: (key, value) => stub().kvSet(full(key), value),
    removeItem: (key) => stub().kvDelete(full(key)),
    getKeys: async (sub) => (await stub().kvKeys(full(sub ?? ""))).map((key) => key.slice(prefix.length)),
    clear: async (sub) => {
      for (const key of await stub().kvKeys(full(sub ?? ""))) await stub().kvDelete(key);
    },
  };
}
