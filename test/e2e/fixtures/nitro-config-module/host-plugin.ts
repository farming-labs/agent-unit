import { definePlugin } from "nitro";
import app from "./app.config";

// The host framework's startup, evaluating its own config and handing agent-unit its part.
export default definePlugin(() => {
  (globalThis as Record<symbol, unknown>)[Symbol.for("host.agents")] = app.agents;
});
