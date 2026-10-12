import { describe, expect, it } from "vitest";
import { dedupeWrangler } from "../src/build/wrangler";

// Nitro joins the app's wrangler file and agent-unit's settings end to end; the build keeps each binding once.

describe("dedupeWrangler", () => {
  it("keeps identical bindings and flags once", () => {
    const db = { binding: "DB", database_name: "app", database_id: "1" };
    const config = {
      d1_databases: [db, { database_id: "1", binding: "DB", database_name: "app" }],
      durable_objects: { bindings: [{ name: "RUNS", class_name: "Run" }, { name: "RUNS", class_name: "Run" }] },
      compatibility_flags: ["nodejs_compat", "nodejs_compat"],
    };
    expect(dedupeWrangler(config)).toBe(true);
    expect(config).toEqual({ d1_databases: [db], durable_objects: { bindings: [{ name: "RUNS", class_name: "Run" }] }, compatibility_flags: ["nodejs_compat"] });
    expect(dedupeWrangler(config)).toBe(false);
  });

  it("refuses one binding name with two different settings", () => {
    const config = { kv_namespaces: [{ binding: "CACHE", id: "a" }, { binding: "CACHE", id: "b" }] };
    expect(() => dedupeWrangler(config)).toThrow(/kv_namespaces "CACHE" is declared twice with different settings/);
  });
});
