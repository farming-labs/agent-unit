// Step results and run output are stored as JSON. These tags keep the values JSON cannot represent.
const TAG = "$au";

type Tagged =
  | { [TAG]: "undefined" }
  | { [TAG]: "Date"; v: string }
  | { [TAG]: "BigInt"; v: string }
  | { [TAG]: "Map"; v: [unknown, unknown][] }
  | { [TAG]: "Set"; v: unknown[] }
  | { [TAG]: "Uint8Array"; v: string }
  | { [TAG]: "Error"; v: { name: string; message: string; stack?: string } };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Converts a value into plain JSON data, tagging the types JSON cannot hold. */
export function encode(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return { [TAG]: "undefined" };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return { [TAG]: "BigInt", v: value.toString() };
  if (typeof value === "function" || typeof value === "symbol") return { [TAG]: "undefined" };
  if (value instanceof Date) return { [TAG]: "Date", v: value.toISOString() };
  if (value instanceof Uint8Array) return { [TAG]: "Uint8Array", v: toBase64(value) };
  if (value instanceof Error) {
    return { [TAG]: "Error", v: { name: value.name, message: value.message, stack: value.stack } };
  }
  const object = value as object;
  if (seen.has(object)) throw new TypeError("agent-unit cannot store circular values");
  seen.add(object);
  try {
    if (value instanceof Map) return { [TAG]: "Map", v: [...value].map(([k, v]) => [encode(k, seen), encode(v, seen)]) };
    if (value instanceof Set) return { [TAG]: "Set", v: [...value].map((v) => encode(v, seen)) };
    if (Array.isArray(value)) return value.map((item) => encode(item, seen));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      out[key] = encode(item, seen);
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

/** Restores a value produced by `encode`. */
export function decode(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  const record = value as Record<string, unknown>;
  const tag = record[TAG];
  if (typeof tag === "string") {
    const tagged = record as unknown as Tagged;
    switch (tagged[TAG]) {
      case "undefined":
        return undefined;
      case "Date":
        return new Date(tagged.v);
      case "BigInt":
        return BigInt(tagged.v);
      case "Map":
        return new Map(tagged.v.map(([k, v]) => [decode(k), decode(v)]));
      case "Set":
        return new Set(tagged.v.map(decode));
      case "Uint8Array":
        return fromBase64(tagged.v);
      case "Error": {
        const error = new Error(tagged.v.message);
        error.name = tagged.v.name;
        if (tagged.v.stack) error.stack = tagged.v.stack;
        return error;
      }
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) out[key] = decode(item);
  return out;
}

/** A JSON-safe copy of a value: what a reader of the stored data will see. */
export function toJsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}
