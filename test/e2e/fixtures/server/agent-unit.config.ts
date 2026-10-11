import { defineConfig } from "agent-unit";

// The app's own server: agent-unit only builds it for each host.
export default defineConfig({ server: "./src/server.ts" });
