import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // agent-unit/cloudflare runs inside the Workers runtime; Node tests use a stand-in.
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/fakes/cloudflare-workers.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**"],
    testTimeout: 20_000,
  },
});
