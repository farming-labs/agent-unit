import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const runtime = (path: string) => fileURLToPath(new URL(`./packages/runtime/src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // agent-unit/cloudflare runs inside the Workers runtime; Node tests use a stand-in.
      { find: "cloudflare:workers", replacement: fileURLToPath(new URL("./test/fakes/cloudflare-workers.ts", import.meta.url)) },
      // Compiler code imports the runtime package; tests import its source. Both must be one copy.
      { find: /^@agent-unit\/runtime$/, replacement: runtime("index.ts") },
      { find: /^@agent-unit\/runtime\/redis$/, replacement: runtime("redis.ts") },
      { find: /^@agent-unit\/runtime\/adapters\/(.*)$/, replacement: runtime("adapters/$1.ts") },
      { find: /^@agent-unit\/runtime\/(.*)$/, replacement: runtime("$1/index.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**"],
    testTimeout: 20_000,
  },
});
