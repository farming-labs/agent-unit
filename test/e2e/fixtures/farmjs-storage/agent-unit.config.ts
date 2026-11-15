import { defineConfig } from "agent-unit";

// No storage: with FARMJS_API_KEY in the build's environment, runs are kept in Farm.js storage on
// every host; without it, servers keep them on disk and other hosts refuse to build.
export default defineConfig({ name: "farmjs-storage" });
