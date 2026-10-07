import { defineConfig } from "agent-unit";
import tinyAdapter from "agent-unit-adapter-tiny";

export default defineConfig({
  adapters: [tinyAdapter()],
  storage: { driver: "memory" },
});
