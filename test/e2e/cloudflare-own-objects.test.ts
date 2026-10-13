import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, collect, createAgentClient, freePort, prepareFixture, startServer, tempDir, type RunningServer } from "./helpers";
import { workerd, writeDurableConfig } from "./hosts";

// An app on the Durable Objects runtime that brings its own Durable Object (a storage provider's, a
// Workflow): both its classes and agent-unit's must be exported and bound, neither replacing the other.

describe.skipIf(!workerd)("Durable Objects runtime with the app's own Durable Objects", () => {
  let root: string;
  let out: string;
  let server: RunningServer;
  let wrangler: { durable_objects: { bindings: { name: string; class_name: string }[] }; migrations: { tag: string }[] };

  beforeAll(async () => {
    root = prepareFixture("cloudflare-own");
    out = tempDir("cf-own-out");
    await buildFixture(root, "cloudflare-module", out);
    const disk = join(out, "disk");
    mkdirSync(disk, { recursive: true });
    const port = await freePort();
    ({ wrangler } = writeDurableConfig(out, disk, port));
    server = await startServer(workerd!, ["serve", join(out, "workerd.capnp")], { cwd: out, port, readyPath: "/.well-known/agent.json" });
  });

  afterAll(async () => {
    await server?.stop();
    if (out) cleanup(out);
  });

  it("exports and binds the app's classes beside agent-unit's", () => {
    expect(wrangler.durable_objects.bindings.map((binding) => binding.class_name)).toEqual(["AgentUnitRun", "AgentUnitIndex", "NoteStore"]);
    expect(wrangler.migrations.map((migration) => migration.tag)).toEqual(["agent-unit-v1"]);
    // Storage bindings from the top-level `cloudflare` option land in wrangler.json as written.
    expect((wrangler as unknown as { d1_databases: unknown[] }).d1_databases).toEqual([
      { binding: "DB", database_name: "notes", database_id: "00000000-0000-0000-0000-000000000000" },
    ]);
    const entry = readFileSync(join(out, "server/index.mjs"), "utf8");
    for (const name of ["AgentUnitRun", "AgentUnitIndex", "NoteStore"]) expect(entry).toMatch(new RegExp(`export \\{[^}]*\\b${name}\\b`));
  });

  it("runs agents in agent-unit's objects that use the app's own object", async () => {
    const events = await collect(createAgentClient({ baseUrl: server.url }).run("notes", {}));
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: "note store got /save" });
  });

  it("takes the app's exports from cloudflare.exports too, and names a missing file", async () => {
    const explicit = tempDir("cf-own-explicit");
    await buildFixture(root, "cloudflare-module", explicit, { NOTES_EXPORTS: "./exports.cloudflare.ts" });
    expect(readFileSync(join(explicit, "server/index.mjs"), "utf8")).toMatch(/export \{[^}]*\bNoteStore\b/);
    cleanup(explicit);
    await expect(buildFixture(root, "cloudflare-module", tempDir("cf-own-missing"), { NOTES_EXPORTS: "./missing.ts" })).rejects.toThrow(
      /Cloudflare exports file "\.\/missing\.ts" does not exist/,
    );
  });

  it("refuses an app binding that would take agent-unit's place", async () => {
    const conflict = tempDir("cf-own-conflict");
    await expect(buildFixture(root, "cloudflare-module", conflict, { NOTES_BINDING: "AGENT_UNIT_RUNS" })).rejects.toThrow(
      /binding "AGENT_UNIT_RUNS" \(NoteStore\) is reserved by agent-unit/,
    );
    cleanup(conflict);
  });
});
