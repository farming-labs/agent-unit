import type { RunService } from "./service";
import { AgentUnitError } from "../runtime/engine";
import { readBody } from "./body";
import type { RequestContext } from "./handler";

// MCP over streamable HTTP with JSON responses (spec/manifest.md): each agent is one tool.

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: JsonRpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: JsonRpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function toolList(engine: RunService) {
  return engine.manifest().agents.map((agent) => ({
    name: agent.name,
    description: agent.description ?? `Run the ${agent.name} agent (${agent.framework}).`,
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to ask the agent." },
        threadId: { type: "string", description: "Continue an earlier conversation." },
      },
      required: ["message"],
    },
  }));
}

async function callTool(engine: RunService, params: Record<string, unknown>, context: RequestContext, limits: McpLimits) {
  const name = String(params.name ?? "");
  const args = (params.arguments ?? {}) as { message?: unknown; threadId?: unknown };
  if (typeof args.message !== "string") return { content: [{ type: "text", text: "`message` must be a string." }], isError: true };
  const threadId = typeof args.threadId === "string" ? args.threadId : undefined;
  if (limits.authorizeStart && !(await limits.authorizeStart(name, threadId))) {
    return { content: [{ type: "text", text: "Not allowed to run this agent on this thread." }], isError: true };
  }
  const { run, done } = await engine.start(name, { messages: [{ role: "user", content: args.message }] }, { threadId });
  context.waitUntil?.(done);
  const final = (await done) ?? (await engine.getRun(run.id));
  if (final.status === "completed") {
    const text = typeof final.output === "string" ? final.output : JSON.stringify(final.output);
    return { content: [{ type: "text", text }], structuredContent: { status: final.status, runId: final.id, output: final.output } };
  }
  if (final.status === "failed") {
    return { content: [{ type: "text", text: final.error?.message ?? "The run failed." }], isError: true };
  }
  const parked = { status: final.status, runId: final.id, interrupt: final.interrupt, wakeAt: final.wakeAt };
  const text =
    final.status === "interrupted"
      ? `The run is waiting for input (${final.interrupt?.name}). Resume it with POST /runs/${final.id}/resume.`
      : `The run is ${final.status}. Follow it at /runs/${final.id}/events.`;
  return { content: [{ type: "text", text }], structuredContent: parked };
}

interface McpLimits {
  maxBodyBytes?: number;
  maxBatch?: number;
  /** Checks a tools/call the way a run start is checked. */
  authorizeStart?: (agent: string, threadId: string | undefined) => Promise<boolean>;
}

async function respond(engine: RunService, message: JsonRpcRequest, context: RequestContext, version: string, limits: McpLimits) {
  switch (message.method) {
    case "initialize": {
      const requested = String(message.params?.protocolVersion ?? "");
      return rpcResult(message.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: engine.manifest().name, version },
      });
    }
    case "ping":
      return rpcResult(message.id, {});
    case "tools/list":
      return rpcResult(message.id, { tools: toolList(engine) });
    case "tools/call": {
      try {
        return rpcResult(message.id, await callTool(engine, message.params ?? {}, context, limits));
      } catch (error) {
        return rpcError(message.id, -32602, error instanceof Error ? error.message : String(error));
      }
    }
    default:
      return rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

export async function handleMcp(
  engine: RunService,
  request: Request,
  context: RequestContext,
  version = "0.0.0",
  limits: McpLimits = {},
): Promise<Response> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(request, limits.maxBodyBytes));
  } catch (error) {
    if (error instanceof AgentUnitError) throw error;
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const messages = (Array.isArray(payload) ? payload : [payload]) as JsonRpcRequest[];
  // Each tools/call can start and wait for a run, so a batch is bounded.
  if (messages.length > (limits.maxBatch ?? 20)) {
    return Response.json(rpcError(null, -32600, `A batch may hold at most ${limits.maxBatch ?? 20} messages.`), { status: 400 });
  }
  const responses = [];
  for (const message of messages) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      responses.push(rpcError(message?.id, -32600, "Invalid request"));
      continue;
    }
    // Notifications (no id) get no response.
    if (message.id === undefined) continue;
    responses.push(await respond(engine, message, context, version, limits));
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(payload) ? responses : responses[0], {
    headers: { "cache-control": "no-store" },
  });
}
