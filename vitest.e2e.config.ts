import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    // Built bundles load with Node's own import, as the platforms load them, not through Vite.
    server: { deps: { external: [/agent-unit-[^/\\]*-out-/] } },
  },
});
