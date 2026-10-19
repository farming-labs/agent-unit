import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Nitro merges the app's own wrangler.json(c)/toml with the settings agent-unit and the app's config
// generate, and joins lists end to end: a binding declared in both places appears twice, which wrangler
// rejects. Identical entries are kept once; one name with two different settings is an error.

/** Binding lists in a wrangler config, and the field that names each entry. */
const LISTS: [path: string[], key: string][] = [
  [["d1_databases"], "binding"],
  [["kv_namespaces"], "binding"],
  [["r2_buckets"], "binding"],
  [["services"], "binding"],
  [["hyperdrive"], "binding"],
  [["vectorize"], "binding"],
  [["analytics_engine_datasets"], "binding"],
  [["queues", "producers"], "binding"],
  [["queues", "consumers"], "queue"],
  [["durable_objects", "bindings"], "name"],
  [["migrations"], "tag"],
];

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
  );

/**
 * A bare `{ tag }` in the migrations places the migration of that tag there, as `cloudflare.wrangler`
 * can (see orderMigrations): the app's wrangler file lists `{ tag: "agent-unit-v1" }` after migrations
 * its Worker already applied, and agent-unit's migration, which Nitro put first, moves to that spot.
 */
function placeMigrations(config: Record<string, any>): boolean {
  const list = config.migrations;
  if (!Array.isArray(list)) return false;
  const isBare = (entry: Record<string, unknown>) => typeof entry?.tag === "string" && Object.keys(entry).length === 1;
  const full = new Map<string, unknown>(list.filter((entry) => typeof entry?.tag === "string" && !isBare(entry)).map((entry) => [entry.tag, entry]));
  const placed = new Set(list.filter((entry) => isBare(entry) && full.has(entry.tag)).map((entry) => entry.tag as string));
  if (!placed.size) return false;
  config.migrations = list.flatMap((entry) => (!placed.has(entry?.tag) ? [entry] : isBare(entry) ? [full.get(entry.tag)] : []));
  return true;
}

/** Removes repeated bindings and flags from a merged wrangler config, in place. Returns whether it changed. */
export function dedupeWrangler(config: Record<string, any>): boolean {
  let changed = placeMigrations(config);
  for (const [path, key] of LISTS) {
    const parent = path.slice(0, -1).reduce<Record<string, any> | undefined>((node, part) => node?.[part], config);
    const field = path.at(-1)!;
    const list = parent?.[field];
    if (!Array.isArray(list)) continue;
    const seen = new Map<string, unknown>();
    const kept = list.filter((entry: Record<string, unknown>) => {
      const name = entry?.[key];
      if (typeof name !== "string") return true;
      if (!seen.has(name)) {
        seen.set(name, entry);
        return true;
      }
      if (stable(seen.get(name)) !== stable(entry)) {
        throw new Error(
          `agent-unit: ${path.join(".")} "${name}" is declared twice with different settings, in your wrangler file and in agent-unit's Cloudflare settings (\`cloudflare.wrangler\`). Keep it in one place.`,
        );
      }
      return false;
    });
    if (kept.length !== list.length) {
      parent![field] = kept;
      changed = true;
    }
  }
  if (Array.isArray(config.compatibility_flags)) {
    const flags = [...new Set(config.compatibility_flags)];
    if (flags.length !== config.compatibility_flags.length) {
      config.compatibility_flags = flags;
      changed = true;
    }
  }
  return changed;
}

/** Cleans the wrangler.json a Cloudflare build wrote, if any. */
export function dedupeWranglerFile(file: string): void {
  if (!existsSync(file)) return;
  const config = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  if (dedupeWrangler(config)) writeFileSync(file, JSON.stringify(config, null, 2));
}

/** The app's own wrangler file, as Nitro finds it: the nearest wrangler.json, .jsonc or .toml from `root` up. */
export function findWranglerFile(root: string): string | undefined {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    for (const name of ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]) {
      if (existsSync(join(dir, name))) return join(dir, name);
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Whether the app's wrangler file sets `key`. */
export function wranglerFileSets(root: string, key: string): boolean {
  const file = findWranglerFile(root);
  if (!file) return false;
  const text = readFileSync(file, "utf8");
  return file.endsWith(".toml") ? new RegExp(`^\\s*${key}\\s*=`, "m").test(text) : new RegExp(`"${key}"\\s*:`).test(text);
}

