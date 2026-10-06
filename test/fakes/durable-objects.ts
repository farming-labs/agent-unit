import type { DurableObjectStorageLike } from "../../src/cloudflare/types";

/** In-memory Durable Object storage with an alarm, like the Workers runtime's. */
export class FakeStorage implements DurableObjectStorageLike {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string) {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async list<T>(options: { prefix?: string } = {}) {
    const keys = [...this.data.keys()].filter((key) => key.startsWith(options.prefix ?? "")).sort();
    return new Map(keys.map((key) => [key, structuredClone(this.data.get(key)) as T]));
  }
  async setAlarm(at: number | Date) {
    this.alarm = typeof at === "number" ? at : at.getTime();
  }
  async getAlarm() {
    return this.alarm;
  }
}

type ObjectClass = new (ctx: unknown, env: unknown) => object;

/**
 * A Durable Object namespace: one instance and one storage per name. Stubs copy arguments and
 * results the way RPC does. `restart()` drops every instance but keeps storage, like a redeploy.
 */
export class FakeNamespace {
  readonly storages = new Map<string, FakeStorage>();
  readonly instances = new Map<string, Record<string, (...args: unknown[]) => unknown>>();
  readonly pending: Promise<unknown>[] = [];
  env: Record<string, unknown> = {};

  constructor(private readonly Class: ObjectClass) {}

  idFromName(name: string) {
    return { name };
  }

  instance(name: string) {
    let instance = this.instances.get(name);
    if (!instance) {
      let storage = this.storages.get(name);
      if (!storage) this.storages.set(name, (storage = new FakeStorage()));
      const ctx = { storage, waitUntil: (promise: Promise<unknown>) => void this.pending.push(promise.catch(() => undefined)) };
      instance = new this.Class(ctx, this.env) as Record<string, (...args: unknown[]) => unknown>;
      this.instances.set(name, instance);
    }
    return instance;
  }

  get(id: { name: string }) {
    return new Proxy(
      {},
      {
        get: (_target, method: string) => async (...args: unknown[]) => {
          const result = await this.instance(id.name)[method]!(...structuredClone(args));
          return containsStream(result) ? result : structuredClone(result);
        },
      },
    );
  }

  restart() {
    this.instances.clear();
  }

  /** Fires the object's alarm if one is set, as the runtime would at that time. */
  async fireAlarm(name: string) {
    const storage = this.storages.get(name)!;
    storage.alarm = null;
    await (this.instance(name) as { alarm(): Promise<void> }).alarm();
  }

  async settle() {
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }
}

const containsStream = (value: unknown): boolean =>
  value instanceof ReadableStream || (typeof value === "object" && value !== null && Object.values(value).some((entry) => entry instanceof ReadableStream));
