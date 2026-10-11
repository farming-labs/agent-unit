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

/**
 * Conditional writes of run records. `compareAndSet` must check and write in one atomic operation
 * (a Redis script, a database `UPDATE … WHERE version = ?`, a Durable Object's single thread).
 * Without one, the store checks then writes, which leaves a gap of one storage round trip.
 */
export interface AtomicWrites {
  /**
   * Writes `record` at `key` only if the stored record's version is `expectedVersion` (a record
   * without one counts as 0), or, when `expectedVersion` is undefined, only if there is none.
   */
  compareAndSet(key: string, expectedVersion: number | undefined, record: RunRecord): Promise<boolean>;
}

export interface RunStoreOptions {
  leases?: LeaseBackend;
  atomic?: AtomicWrites;
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);
const INDEX_VERSION = 1;
const MAX_TIME = 9_999_999_999_999;
const time = (ms: number) => String(Math.max(0, Math.min(MAX_TIME, Math.floor(ms)))).padStart(13, "0");

/** Journal keys contain `:`, `#` and anything an adapter chose; storage keys get a safe encoding. */
function encodeSegment(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeSegment(value: string): string {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/**
 * Persists runs, journals, events, state and leases on any unstorage driver: memory, the
 * filesystem, Redis, Cloudflare KV, Vercel KV, Netlify Blobs, Deno KV, a database, …
 *
 * Runs are indexed (newest first overall and per status, sleepers by wake time, finished runs by
 * when they finished), so listing, the sweep and retention read what they need instead of every
 * run. Each journal entry is its own key, so a step writes one entry rather than the whole journal.
 */
export class RunStore {
  private readonly leases: LeaseBackend;
  private readonly atomic: AtomicWrites;
  private indexReady: Promise<void> | undefined;

  constructor(
    readonly storage: Storage,
    options: RunStoreOptions = {},
  ) {
    this.leases = options.leases ?? storageLeases(storage);
    this.atomic = options.atomic ?? checkThenWrite(storage);
  }

  /** True when conditional writes are atomic, not check-then-write. */
  get atomicWrites(): boolean {
    return !(this.atomic as { bestEffort?: boolean }).bestEffort;
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    return ((await this.storage.getItem(`runs:${id}`)) as RunRecord | null) ?? undefined;
  }

  /**
   * Writes a run and moves its index entries.
   *
   * With `previous` (the record as read, or `null` for a new run) the write is conditional: it
   * happens only if the stored record is still that version, and returns false when another write
   * got there first, so the caller can re-read instead of overwriting it. Without `previous` it
   * writes unconditionally.
   */
  async putRun(run: RunRecord, previous?: RunRecord | null): Promise<boolean> {
    const key = `runs:${run.id}`;
    let before: RunRecord | null | undefined = previous;
    if (previous === undefined) {
      before = (await this.getRun(run.id)) ?? null;
      run.version = (before?.version ?? 0) + 1;
      await this.storage.setItem(key, run as never);
    } else {
      const expected = previous === null ? undefined : (previous.version ?? 0);
      const next = { ...run, version: (expected ?? 0) + 1 };
      if (!(await this.atomic.compareAndSet(key, expected, next))) return false;
      run.version = next.version;
    }
    const keys = this.indexKeys(run);
    for (const old of before ? this.indexKeys(before) : []) if (!keys.includes(old)) await this.storage.removeItem(old);
    for (const indexKey of keys) await this.storage.setItem(indexKey, run as never);
    return true;
  }

  /** Index entries carry a copy of the record, so a listing never reads the runs themselves. */
  private indexKeys(run: RunRecord): string[] {
    const created = time(MAX_TIME - Date.parse(run.createdAt));
    const keys = [`index:all:${created}:${run.id}`, `index:status:${run.status}:${created}:${run.id}`];
    if (run.status === "sleeping" && run.wakeAt) keys.push(`index:wake:${time(Date.parse(run.wakeAt))}:${run.id}`);
    if (TERMINAL.has(run.status)) keys.push(`index:done:${time(Date.parse(run.updatedAt))}:${run.id}`);
    return keys;
  }

  /** Builds the index once for runs stored before it existed. */
  private ensureIndex(): Promise<void> {
    return (this.indexReady ??= (async () => {
      if ((await this.storage.getItem("index:version")) === INDEX_VERSION) return;
      for (const key of await this.storage.getKeys("runs")) {
        const run = (await this.storage.getItem(key)) as RunRecord | null;
        if (run) for (const indexKey of this.indexKeys(run)) await this.storage.setItem(indexKey, run as never);
      }
      await this.storage.setItem("index:version", INDEX_VERSION as never);
    })().catch((error) => {
      this.indexReady = undefined;
      throw error;
    }));
  }

  private async indexed(prefix: string): Promise<string[]> {
    await this.ensureIndex();
    return (await this.storage.getKeys(prefix)).sort();
  }

  async listRuns(filter: ListRunsFilter = {}): Promise<RunRecord[]> {
    const limit = filter.limit ?? 50;
    const runs: RunRecord[] = [];
    // Newest first; stop as soon as enough match.
    for (const key of await this.indexed(filter.status ? `index:status:${filter.status}` : "index:all")) {
      const run = (await this.storage.getItem(key)) as RunRecord | null;
      if (!run) continue;
      if (filter.agent && run.agent !== filter.agent) continue;
      if (filter.threadId && run.threadId !== filter.threadId) continue;
      if (filter.status && run.status !== filter.status) continue;
      runs.push(run);
      if (runs.length >= limit) break;
    }
    return runs;
  }

  /** Sleeping runs whose wake time has come, earliest first. */
  async dueSleepers(now = Date.now()): Promise<string[]> {
    const due: string[] = [];
    for (const key of await this.indexed("index:wake")) {
      const [, , at, id] = key.split(":");
      if (Number(at) > now) break;
      if (id) due.push(id);
    }
    return due;
  }

  /** Runs that are running according to the index (live, yielded or orphaned). */
  async runningRuns(): Promise<string[]> {
    return (await this.indexed("index:status:running")).map((key) => key.slice(key.lastIndexOf(":") + 1));
  }

  /** Finished (completed, failed, cancelled) runs last updated at or before `cutoff`, oldest first. */
  async finishedBefore(cutoff: number): Promise<string[]> {
    const ids: string[] = [];
    for (const key of await this.indexed("index:done")) {
      const [, , at, id] = key.split(":");
      if (Number(at) > cutoff) break;
      if (id) ids.push(id);
    }
    return ids;
  }

  /** Deletes a run with its journal, events, lease and index entries. */
  async deleteRun(id: string): Promise<void> {
    const run = await this.getRun(id);
    for (const key of run ? this.indexKeys(run) : []) await this.storage.removeItem(key);
    for (const base of [`steps:${id}`, `events:${id}`]) {
      for (const key of await this.storage.getKeys(base)) await this.storage.removeItem(key);
    }
    await this.storage.removeItem(`journal:${id}`);
    await this.storage.removeItem(`lease:${id}`);
    await this.storage.removeItem(`runs:${id}`);
  }

  async getJournal(id: string): Promise<Journal> {
    // Runs from before per-entry journals kept the whole journal under one key.
    const journal: Journal = { ...(((await this.storage.getItem(`journal:${id}`)) as Journal | null) ?? {}) };
    const base = `steps:${id}`;
    for (const key of await this.storage.getKeys(base)) {
      const entry = (await this.storage.getItem(key)) as JournalEntry | null;
      if (entry) journal[decodeSegment(key.slice(key.lastIndexOf(":") + 1))] = entry;
    }
    return journal;
  }

  /** Writes one journal entry. */
  async putJournalEntry(id: string, key: string, entry: JournalEntry): Promise<void> {
    await this.storage.setItem(`steps:${id}:${encodeSegment(key)}`, entry as never);
  }

  async deleteJournalEntry(id: string, key: string): Promise<void> {
    await this.storage.removeItem(`steps:${id}:${encodeSegment(key)}`);
  }

  /** Writes every entry of a journal (tests and tools); executions write one entry at a time. */
  async putJournal(id: string, journal: Journal): Promise<void> {
    for (const [key, entry] of Object.entries(journal)) await this.putJournalEntry(id, key, entry);
  }

  async appendEvents(id: string, events: AgentEvent[]): Promise<void> {
    for (const event of events) await this.storage.setItem(`events:${id}:${pad(event.seq)}`, event as never);
  }

  /**
   * Events after `after`, in order and without gaps: reads seq after+1, after+2, … until one is not
   * there, so a reader never skips an event that is still being written (or not yet visible on an
   * eventually consistent store). `upTo` reads past gaps once the caller knows the run settled.
   */
  async readEvents(id: string, after = 0, upTo?: number): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for (let seq = after + 1; upTo === undefined || seq <= upTo; seq++) {
      const event = (await this.storage.getItem(`events:${id}:${pad(seq)}`)) as AgentEvent | null;
      if (!event) {
        if (upTo === undefined) break;
        continue;
      }
      events.push(event);
    }
    return events;
  }

  /**
   * Owners (thread ids, agent names) and keys come from callers and may hold `:`, `?` or `/`, which
   * storage keys treat specially (`?` even cuts a key short), so both are encoded.
   */
  private stateKey(scope: StateScope, owner: string, key: string) {
    return `state:${scope}:${encodeSegment(owner)}:${encodeSegment(key)}`;
  }

  /** Where state was stored before keys were encoded; still read, so existing state survives. */
  private legacyStateKey(scope: StateScope, owner: string, key: string) {
    return `state:${scope}:${owner}:${key}`;
  }

  async getState<T>(scope: StateScope, owner: string, key: string): Promise<T | undefined> {
    const value = (await this.storage.getItem(this.stateKey(scope, owner, key))) as T | null;
    if (value !== null) return value;
    return ((await this.storage.getItem(this.legacyStateKey(scope, owner, key))) as T | null) ?? undefined;
  }

  async setState(scope: StateScope, owner: string, key: string, value: unknown): Promise<void> {
    await this.storage.setItem(this.stateKey(scope, owner, key), value as never);
  }

  async deleteState(scope: StateScope, owner: string, key: string): Promise<void> {
    await this.storage.removeItem(this.stateKey(scope, owner, key));
    await this.storage.removeItem(this.legacyStateKey(scope, owner, key));
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

  /**
   * The highest event seq stored for a run: the truth after a crash, whatever the record says.
   * Probes upward from what the record knows, so it costs one read per event the record missed.
   */
  async lastEventSeq(id: string, known = 0): Promise<number> {
    let last = known;
    while ((await this.storage.getItem(`events:${id}:${pad(last + 1)}`)) !== null) last++;
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
      // A lease another execution took over is not taken back, and a released one is not recreated
      // (a renewal still in flight when its execution ends would otherwise block the run for a whole lease).
      if (!current || current.owner !== owner) return false;
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

/**
 * Saves to one key queued per storage, process-wide: every RunStore over the same storage in this
 * process (two engines, a test, a dev server) takes turns, so their check-then-write never interleaves.
 */
const queues = new WeakMap<object, Map<string, Promise<unknown>>>();
function queued<T>(storage: object, key: string, work: () => Promise<T>): Promise<T> {
  let keys = queues.get(storage);
  if (!keys) queues.set(storage, (keys = new Map()));
  const previous = keys.get(key) ?? Promise.resolve();
  const current = previous.then(work, work);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  keys.set(key, settled);
  void settled.then(() => {
    if (keys.get(key) === settled) keys.delete(key);
  });
  return current;
}

/**
 * Check, then write. Atomic within one process (writes to a key take turns); across processes the
 * check and the write are one storage round trip apart. Pass `atomic` for stores that can do better.
 */
function checkThenWrite(storage: Storage): AtomicWrites & { bestEffort: true } {
  return {
    bestEffort: true,
    compareAndSet(key, expectedVersion, record) {
      return queued(storage, key, async () => {
        const current = (await storage.getItem(key)) as RunRecord | null;
        const currentVersion = current ? (current.version ?? 0) : undefined;
        if (currentVersion !== expectedVersion) return false;
        await storage.setItem(key, record as never);
        return true;
      });
    },
  };
}
