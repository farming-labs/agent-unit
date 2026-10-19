import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeWrangler, wranglerFileSets } from "../src/build/wrangler";

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

  it("places a migration where a bare { tag } of the app's wrangler file lists it", () => {
    const ours = { tag: "agent-unit-v1", new_sqlite_classes: ["AgentUnitRun"] };
    // Nitro joins agent-unit's settings and the app's file: agent-unit's migration comes first.
    const config = { migrations: [ours, { tag: "v1", new_classes: ["Notes"] }, { tag: "agent-unit-v1" }, { tag: "v2" }] };
    expect(dedupeWrangler(config)).toBe(true);
    expect(config.migrations).toEqual([{ tag: "v1", new_classes: ["Notes"] }, ours, { tag: "v2" }]);
    // Without a placement, agent-unit's stays first.
    const unplaced = { migrations: [ours, { tag: "v1", new_classes: ["Notes"] }] };
    expect(dedupeWrangler(unplaced)).toBe(false);
  });

  it("refuses one binding name with two different settings", () => {
    const config = { kv_namespaces: [{ binding: "CACHE", id: "a" }, { binding: "CACHE", id: "b" }] };
    expect(() => dedupeWrangler(config)).toThrow(/kv_namespaces "CACHE" is declared twice with different settings/);
  });
});

describe("agent-unit's Durable Objects migration among the app's", () => {
  const ours = [{ tag: "agent-unit-v1", new_sqlite_classes: ["AgentUnitRun", "AgentUnitIndex"] }];
  it("goes first unless the app places it, so a Worker that already applied its own migrations can list it after them", async () => {
    const { orderMigrations } = await import("../src/build/nitro");
    const app = [{ tag: "v1", new_sqlite_classes: ["Notes"] }];
    expect(orderMigrations(ours, app).map((migration) => migration.tag)).toEqual(["agent-unit-v1", "v1"]);
    expect(orderMigrations(ours, [...app, { tag: "agent-unit-v1" }, { tag: "v2" }])).toEqual([...app, ...ours, { tag: "v2" }]);
    expect(orderMigrations([], app)).toEqual(app);
  });

  it("refuses the reserved tag with content of the app's, and a placement without the Durable Objects runtime", async () => {
    const { orderMigrations } = await import("../src/build/nitro");
    expect(() => orderMigrations(ours, [{ tag: "agent-unit-v1", new_classes: ["Mine"] } as { tag: string }])).toThrow(
      `Use another tag, or list a bare { tag: "agent-unit-v1" } to place agent-unit's migration there.`,
    );
    expect(() => orderMigrations([], [{ tag: "agent-unit-v1" }])).toThrow(`only the "durable-objects" runtime has`);
  });
});

describe("wranglerFileSets", () => {
  it("finds a setting in the nearest wrangler.json, .jsonc or .toml, as Nitro finds the file", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-unit-wrangler-"));
    try {
      const app = join(root, "apps/agent");
      mkdirSync(app, { recursive: true });
      expect(wranglerFileSets(app, "compatibility_date")).toBe(false);
      writeFileSync(join(root, "wrangler.toml"), 'name = "agent"\ncompatibility_date = "2026-06-01"\n');
      expect(wranglerFileSets(app, "compatibility_date")).toBe(true);
      writeFileSync(join(app, "wrangler.jsonc"), '{\n  // no date here\n  "name": "agent"\n}\n');
      expect(wranglerFileSets(app, "compatibility_date")).toBe(false);
      writeFileSync(join(app, "wrangler.jsonc"), '{ "compatibility_date": "2026-06-01" }');
      expect(wranglerFileSets(app, "compatibility_date")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

