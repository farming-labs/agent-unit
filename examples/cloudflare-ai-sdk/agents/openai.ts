import { openai } from "@ai-sdk/openai";
import { supportAgent } from "../lib/support";

// Reads OPENAI_API_KEY from the Worker's secrets (`wrangler secret put OPENAI_API_KEY`).
export default supportAgent(openai(process.env.OPENAI_MODEL ?? "gpt-4.1-mini"));
