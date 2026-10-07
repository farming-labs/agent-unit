import type { Storage } from "unstorage";
import type { AgentEvent, RunRecord, RunStatus } from "../types";

/** One journaled fact about a run: a completed step, an interrupt answer or a wake time. */
export type JournalEntry =
  | { kind: "step"; value?: unknown; error?: unknown }
  | { kind: "interrupt"; answered: boolean; answer?: unknown }
  | { kind: "sleep"; wakeAt: number; woke?: boolean };

export type Journal = Record<string, JournalEntry>;

export type StateScope = "thread" | "agent" | "app";

export interface ListRunsFilter {
  agent?: string;
  status?: RunStatus;
  threadId?: string;
  limit?: number;
}

export interface KeyValueStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys under a `:`-separated prefix, sorted, relative to the namespace. */
  keys(prefix?: string): Promise<string[]>;
}

const pad = (seq: number) => String(seq).padStart(10, "0");

/**
 * Persists runs, journals, events, state and leases on any unstorage driver: memory, the
 * filesystem, Redis, Cloudflare KV, Vercel KV, Netlify Blobs, Deno KV, a database, …
 */
/**
 * Who may execute a run. The default keeps leases in the run storage with a read, a write and a
 * read back, which is best effort: two processes racing within a few milliseconds on an eventually
 * consistent store can both win. Pass leases backed by an atomic operation (Redis `SET NX PX` and a
 * compare-and-renew script, a database row lock…) where two executors must never overlap. The
 * Durable Objects runtime needs none: each run's object is its only executor.
 */
export interface LeaseBackend {
  /** Takes the lease if it is free, expired or already `owner`'s. */
  acquire(runId: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Extends the lease only while `owner` still holds it; false when it was lost. */
  renew(runId: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Releases the lease if `owner` holds it. */
  release(runId: string, owner: string): Promise<void>;
  /** True when no one holds a live lease. */
  expired(runId: string): Promise<boolean>;
}

export interface RunStoreOptions {
  leases?: LeaseBackend;
}

export class RunStore {
  private readonly leases: LeaseBackend;

  constructor(
    readonly storage: Storage,
    options: RunStoreOptions = {},
  ) {
    this.leases = options.leases ?? storageLeases(storage);
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    return ((await this.storage.getItem(`runs:${id}`)) as RunRecord | null) ?? undefined;
  }

  async putRun(run: RunRecord): Promise<void> {
    await this.storage.setItem(`runs:${run.id}`, run as never);
  }

  async listRuns(filter: ListRunsFilter = {}): Promise<RunRecord[]> {
    const keys = await this.storage.getKeys("runs");
    const runs: RunRecord[] = [];
    for (const key of keys) {
      const run = (await this.storage.getItem(key)) as RunRecord | null;
      if (!run) continue;
      if (filter.agent && run.agent !== filter.agent) continue;
      if (filter.status && run.status !== filter.status) continue;
      if (filter.threadId && run.threadId !== filter.threadId) continue;
      runs.push(run);
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return runs.slice(0, filter.limit ?? 50);
  }

  async getJournal(id: string): Promise<Journal> {
    return ((await this.storage.getItem(`journal:${id}`)) as Journal | null) ?? {};
  }

  async putJournal(id: string, journal: Journal): Promise<void> {
    await this.storage.setItem(`journal:${id}`, journal as never);
  }

  async appendEvents(id: string, events: AgentEvent[]): Promise<void> {
    for (const event of events) await this.storage.setItem(`events:${id}:${pad(event.seq)}`, event as never);
  }

  async readEvents(id: string, after = 0): Promise<AgentEvent[]> {
    const keys = (await this.storage.getKeys(`events:${id}`)).sort();
    const events: AgentEvent[] = [];
    for (const key of keys) {
      const seq = Number(key.slice(key.lastIndexOf(":") + 1));
      if (seq <= after) continue;
      const event = (await this.storage.getItem(key)) as AgentEvent | null;
      if (event) events.push(event);
    }
    return events;
  }

  private stateKey(scope: StateScope, owner: string, key: string) {
    return `state:${scope}:${owner}:${key}`;
  }

  async getState<T>(scope: StateScope, owner: string, key: string): Promise<T | undefined> {
    return ((await this.storage.getItem(this.stateKey(scope, owner, key))) as T | null) ?? undefined;
  }

  async setState(scope: StateScope, owner: string, key: string, value: unknown): Promise<void> {
    await this.storage.setItem(this.stateKey(scope, owner, key), value as never);
  }

  async deleteState(scope: StateScope, owner: string, key: string): Promise<void> {
    await this.storage.removeItem(this.stateKey(scope, owner, key));
  }

  /**
   * A persistent key-value namespace for adapters (a framework's own checkpoints, for example).
   * Keys are `:`-separated segments; `keys(prefix)` lists the keys under a segment prefix.
   */
  kv(namespace: string): KeyValueStore {
    const base = `kv:${namespace}`;
    const full = (key: string) => `${base}:${key}`;
    return {
      get: async <T>(key: string) => ((await this.storage.getItem(full(key))) as T | null) ?? undefined,
      set: async (key, value) => {
        await this.storage.setItem(full(key), value as never);
      },
      delete: async (key) => {
        await this.storage.removeItem(full(key));
      },
      keys: async (prefix = "") => {
        const keys = await this.storage.getKeys(prefix ? full(prefix) : base);
        return keys.map((key) => key.slice(base.length + 1)).sort();
      },
    };
  }

  /** Takes the run's execution lease. Only one execution runs a run at a time; see LeaseBackend. */
  acquireLease(id: string, owner: string, ttlMs: number): Promise<boolean> {
    return this.leases.acquire(id, owner, ttlMs);
  }

  renewLease(id: string, owner: string, ttlMs: number): Promise<boolean> {
    return this.leases.renew(id, owner, ttlMs);
  }

  releaseLease(id: string, owner: string): Promise<void> {
    return this.leases.release(id, owner);
  }

  leaseExpired(id: string): Promise<boolean> {
    return this.leases.expired(id);
  }

  /** The highest event seq stored for a run: the truth after a crash, whatever the record says. */
  async lastEventSeq(id: string): Promise<number> {
    let last = 0;
    for (const key of await this.storage.getKeys(`events:${id}`)) {
      const seq = Number(key.slice(key.lastIndexOf(":") + 1));
      if (Number.isFinite(seq) && seq > last) last = seq;
    }
    return last;
  }
}

type Lease = { owner: string; until: number };

/** Leases in the run storage itself. Best effort; see LeaseBackend. */
export function storageLeases(storage: Storage): LeaseBackend {
  const key = (id: string) => `lease:${id}`;
  const read = async (id: string) => (await storage.getItem(key(id))) as Lease | null;
  return {
    async acquire(id, owner, ttlMs) {
      const current = await read(id);
      if (current && current.owner !== owner && current.until > Date.now()) return false;
      await storage.setItem(key(id), { owner, until: Date.now() + ttlMs } as never);
      return (await read(id))?.owner === owner;
    },
    async renew(id, owner, ttlMs) {
      const current = await read(id);
      // A lease another execution took over is not taken back.
      if (current && current.owner !== owner) return false;
      await storage.setItem(key(id), { owner, until: Date.now() + ttlMs } as never);
      return (await read(id))?.owner === owner;
    },
    async release(id, owner) {
      if ((await read(id))?.owner === owner) await storage.removeItem(key(id));
    },
    async expired(id) {
      const current = await read(id);
      return !current || current.until <= Date.now();
    },
  };
}
