const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function randomId(prefix: string, length = 20): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return `${prefix}_${out}`;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses `250`, `"250ms"`, `"30s"`, `"5m"`, `"2h"` or `"1d"` into milliseconds. */
export function parseDuration(duration: number | string): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) throw new RangeError(`Invalid duration: ${duration}`);
    return duration;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/.exec(duration);
  if (!match) throw new RangeError(`Invalid duration "${duration}". Use ms or a value like "30s", "5m", "2h", "1d".`);
  return Number(match[1]) * UNITS[match[2]!]!;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function errorInfo(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

/** Collects a value that may be a promise or an async iterable into a final value (the last item). */
export async function settle(value: unknown): Promise<unknown> {
  const resolved = await value;
  if (resolved && typeof resolved === "object" && Symbol.asyncIterator in resolved) {
    let last: unknown;
    for await (const item of resolved as AsyncIterable<unknown>) last = item;
    return last;
  }
  return resolved;
}
