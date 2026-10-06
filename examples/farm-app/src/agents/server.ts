import { createAgentUnit } from "agent-unit/server";
import { createStorage } from "unstorage";
import fsLite from "unstorage/drivers/fs-lite";
import refund from "./refund";
import reminder from "./reminder";

// One agent-unit for the whole app. Runs live in `.data/agent-unit` here; on a serverless
// target, swap the driver for a shared one (redis, upstash, vercel-kv, ...).
export const agents = createAgentUnit({
  name: "farm-app",
  agents: { refund, reminder },
  storage: createStorage({ driver: fsLite({ base: ".data/agent-unit", atomic: true }) }),
  basePath: "/api/ai",
});
