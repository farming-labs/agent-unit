import { D1Store } from "@mastra/cloudflare-d1";
import { env } from "agent-unit/env";

// Workers: Mastra's D1 store on the Worker's DB binding.
export const storage = new D1Store({ id: "refunds", binding: env.DB });
