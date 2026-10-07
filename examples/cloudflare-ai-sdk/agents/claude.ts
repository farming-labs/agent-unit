import { anthropic } from "@ai-sdk/anthropic";
import { supportAgent } from "../lib/support";

// Reads ANTHROPIC_API_KEY from the Worker's secrets (`wrangler secret put ANTHROPIC_API_KEY`).
export default supportAgent(anthropic(process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5"));
