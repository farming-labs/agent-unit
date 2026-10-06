import { after } from "@farm.js/core/after";
import { agents } from "../../../../agents/server";

// Every agent-unit endpoint under /api/ai: runs, resumable event streams, MCP and the
// agent card. Farm's after() keeps a started run going after the response is sent.
async function handle(request: Request): Promise<Response> {
  return agents.handler(request, {
    waitUntil: (work) => after(async () => void (await work)),
  });
}

export const GET = handle;
export const POST = handle;
