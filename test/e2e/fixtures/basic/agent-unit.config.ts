import { defineConfig } from "agent-unit";

export default defineConfig({
  name: "basic",
  storage: { driver: "fs-lite", base: process.env.AGENT_UNIT_DATA ?? ".data/agent-unit" },
  authorize: (request) => {
    const token = process.env.API_TOKEN;
    return !token || request.headers.get("authorization") === `Bearer ${token}`;
  },
});
