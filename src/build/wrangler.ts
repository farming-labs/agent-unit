import { existsSync, readFileSync, writeFileSync } from "node:fs";

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

/** Removes repeated bindings and flags from a merged wrangler config, in place. Returns whether it changed. */
export function dedupeWrangler(config: Record<string, any>): boolean {
  let changed = false;
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
