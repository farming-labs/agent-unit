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

const pad = (seq: number) => String(seq).padStart(10, "0");

/**
 * Persists runs, journals, events, state and leases on any unstorage driver: memory, the
 * filesystem, Redis, Cloudflare KV, Vercel KV, Netlify Blobs, Deno KV, a database, …
 */
export class RunStore {
  constructor(readonly storage: Storage) {}

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
   * Takes the run's execution lease. Only one process executes a run at a time: a duplicate resume,
   * a continuation and the sweep can race, and the loser backs off.
   */
  async acquireLease(id: string, owner: string, ttlMs: number): Promise<boolean> {
    const key = `lease:${id}`;
    const current = (await this.storage.getItem(key)) as { owner: string; until: number } | null;
    if (current && current.owner !== owner && current.until > Date.now()) return false;
    await this.storage.setItem(key, { owner, until: Date.now() + ttlMs } as never);
    const confirmed = (await this.storage.getItem(key)) as { owner: string } | null;
    return confirmed?.owner === owner;
  }

  async renewLease(id: string, owner: string, ttlMs: number): Promise<void> {
    await this.storage.setItem(`lease:${id}`, { owner, until: Date.now() + ttlMs } as never);
  }

  async releaseLease(id: string, owner: string): Promise<void> {
    const key = `lease:${id}`;
    const current = (await this.storage.getItem(key)) as { owner: string } | null;
    if (current?.owner === owner) await this.storage.removeItem(key);
  }

  async leaseExpired(id: string): Promise<boolean> {
    const current = (await this.storage.getItem(`lease:${id}`)) as { until: number } | null;
    return !current || current.until <= Date.now();
  }
}
