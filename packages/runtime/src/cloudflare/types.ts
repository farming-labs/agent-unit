// The slice of the Workers runtime agent-unit uses, so the package needs no Workers type package.

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
}

export interface DurableObjectStateLike {
  readonly storage: DurableObjectStorageLike;
  waitUntil(promise: Promise<unknown>): void;
}

export interface DurableObjectNamespaceLike<Stub> {
  idFromName(name: string): unknown;
  get(id: unknown): Stub;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
