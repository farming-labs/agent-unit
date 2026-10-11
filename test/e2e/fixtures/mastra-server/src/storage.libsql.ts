import { LibSQLStore } from "@mastra/libsql";
import { env } from "agent-unit/env";

// Servers and functions: Mastra's LibSQL store (a local file here; Turso in production).
export const storage = new LibSQLStore({ id: "refunds", url: env.MASTRA_DB_URL ?? "file:./mastra.db" });
