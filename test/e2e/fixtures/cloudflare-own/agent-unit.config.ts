import { defineConfig } from "agent-unit";

export default defineConfig({
  preset: "cloudflare-module",
  runtime: "durable-objects",
  nitro: {
    cloudflare: {
      ...(process.env.NOTES_EXPORTS ? { exports: process.env.NOTES_EXPORTS } : {}),
      wrangler: {
        durable_objects: {
          bindings: [{ name: process.env.NOTES_BINDING ?? "NOTES", class_name: process.env.NOTES_CLASS ?? "NoteStore" }],
        },
      },
    },
  },
});
