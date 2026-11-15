import { defineConfig } from "agent-unit";

export default defineConfig({
  name: "infra-approvals",
  storage: { driver: "fs-lite", base: ".data/agent-unit" },
});
