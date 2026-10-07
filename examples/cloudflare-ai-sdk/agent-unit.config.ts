import { defineConfig } from "agent-unit";

// Build for Cloudflare Workers, with every run in its own Durable Object.
export default defineConfig({
  name: "support",
  preset: "cloudflare-module",
  runtime: "durable-objects",
});
