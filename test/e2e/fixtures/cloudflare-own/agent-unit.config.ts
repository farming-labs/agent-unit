import { defineConfig } from "agent-unit";

export default defineConfig({
  preset: "cloudflare-module",
  runtime: "durable-objects",
  // The app's own Durable Object, bound beside agent-unit's.
  cloudflare: {
    wrangler: {
      d1_databases: [{ binding: "DB", database_name: "notes", database_id: "00000000-0000-0000-0000-000000000000" }],
      durable_objects: {
        bindings: [{ name: process.env.NOTES_BINDING ?? "NOTES", class_name: process.env.NOTES_CLASS ?? "NoteStore" }],
      },
    },
  },
  // The older spelling of the same settings still applies, merged with the one above.
  nitro: { cloudflare: process.env.NOTES_EXPORTS ? { exports: process.env.NOTES_EXPORTS } : {} },
});
