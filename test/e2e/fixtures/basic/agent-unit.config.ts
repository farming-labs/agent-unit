import { defineConfig } from "agent-unit";

export default defineConfig({
  name: "basic",
  runtime: process.env.AGENT_UNIT_RUNTIME === "durable-objects" ? "durable-objects" : "default",
  // Workers have no filesystem; the e2e suite runs workerd with in-isolate memory storage.
  storage:
    process.env.AGENT_UNIT_STORAGE === "memory"
      ? { driver: "memory" }
      : process.env.AGENT_UNIT_STORAGE === "redis"
        ? { driver: "redis", url: process.env.REDIS_URL, base: process.env.AGENT_UNIT_DATA }
        : { driver: "fs-lite", base: process.env.AGENT_UNIT_DATA ?? ".data/agent-unit" },
  authorize: (request) => {
    const token = process.env.API_TOKEN;
    return !token || request.headers.get("authorization") === `Bearer ${token}`;
  },
});
