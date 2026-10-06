import { AgentUnitError, type RunEngine } from "../runtime/engine";
import type { AgentEvent, RunInput, RunStatus } from "../types";
import { agentCardDocument } from "./a2a";
import { handleMcp } from "./mcp";

export interface HandlerOptions {
  /** Path prefix the API is mounted under, e.g. `/api/agents`. Default: none. */
  basePath?: string;
  /** Returns false (or a Response) to reject a request. Runs before every route except the agent card. */
  authorize?: (request: Request) => boolean | Response | Promise<boolean | Response>;
  /**
   * Secret for the internal continuation and sweep endpoints. Default: the AGENT_UNIT_SECRET
   * environment variable. Without one those endpoints are disabled.
   */
  secret?: string;
  /** Interval for SSE keep-alive comments. Default 15s. */
  heartbeatMs?: number;
  version?: string;
}

export interface RequestContext {
  /** Keeps work alive after the response (serverless `waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void;
}

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const problem = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

const wantsStream = (request: Request) => (request.headers.get("accept") ?? "").includes("text/event-stream");

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AgentUnitError(400, "invalid_json", "The request body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AgentUnitError(400, "invalid_body", "The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

/** Streams events as SSE: `id:` is the event's seq so a reconnecting client resumes exactly. */
export function eventStream(events: AsyncIterable<AgentEvent>, signal: AbortSignal, heartbeatMs = 15_000): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, heartbeatMs);
      try {
        for await (const event of events) {
          if (signal.aborted) break;
          controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`));
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
    cancel() {
      clearInterval(heartbeat);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

const RUN_STATUSES = new Set<RunStatus>(["running", "interrupted", "sleeping", "completed", "failed", "cancelled"]);

/**
 * The agent-unit HTTP API (spec/runs.md) as a Web `Request → Response` handler. Mount it in Nitro,
 * Bun.serve, Deno.serve, a Worker, Hono, or any Fetch-based server.
 */
export function createHandler(engine: RunEngine, options: HandlerOptions = {}) {
  const base = (options.basePath ?? "").replace(/\/+$/, "");
  const secret = () => options.secret ?? engine.env().AGENT_UNIT_SECRET;
  let origin: string | undefined;

  // Serverless hosts continue a yielded run in a fresh invocation through the internal endpoint.
  if (!engine.options.continueRun) {
    engine.options.continueRun = async (id) => {
      const token = secret();
      if (origin && token) {
        try {
          const response = await fetch(`${origin}${base}/__agent-unit/continue/${encodeURIComponent(id)}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            // A host without waitUntil answers only when the continuation stops; it is running by then.
            signal: AbortSignal.timeout(5_000),
          });
          if (response.ok) return;
        } catch (error) {
          if ((error as Error).name === "TimeoutError") return;
        }
      }
      // No secret, or the host cannot reach itself: continuing here beats stalling until a sweep.
      await engine.continue(id);
    };
  }

  const internalAllowed = (request: Request) => {
    const token = secret();
    return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`;
  };

  return async function handle(request: Request, context: RequestContext = {}): Promise<Response> {
    // Hosts without waitUntil (AWS Lambda, Netlify Functions) freeze once the response is sent,
    // so there the work finishes inside the request instead of in the background.
    const background = async <T>(work: Promise<T>): Promise<T | undefined> => {
      if (context.waitUntil) {
        context.waitUntil(work);
        return undefined;
      }
      return work;
    };
    const url = new URL(request.url);
    origin ??= url.origin;
    if (base && !url.pathname.startsWith(base)) return problem(404, "not_found", "Not found.");
    const path = url.pathname.slice(base.length).replace(/\/+$/, "") || "/";
    const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
    const method = request.method.toUpperCase();

    try {
      // Discovery documents are public so registries can find the agents.
      if (method === "GET" && path === "/.well-known/agent.json") {
        return json(agentCardDocument(engine.manifest(), `${url.origin}${base}`, options.version));
      }

      if (segments[0] === "__agent-unit") {
        if (!internalAllowed(request)) return problem(401, "unauthorized", "Missing or invalid agent-unit secret.");
        if (method === "POST" && segments[1] === "continue" && segments[2]) {
          await background(engine.continue(segments[2]));
          return json({ ok: true }, context.waitUntil ? 202 : 200);
        }
        if (segments[1] === "sweep") {
          const { woken, recovered, settled } = await engine.sweep();
          await background(settled);
          return json({ woken, recovered });
        }
        return problem(404, "not_found", "Not found.");
      }

      if (options.authorize) {
        const verdict = await options.authorize(request);
        if (verdict instanceof Response) return verdict;
        if (!verdict) return problem(401, "unauthorized", "Unauthorized.");
      }

      if (method === "GET" && (path === "/" || path === "/manifest.json")) return json(engine.manifest());
      if (method === "POST" && path === "/mcp") return await handleMcp(engine, request, context, options.version);
      if (method === "GET" && path === "/mcp") return problem(405, "method_not_allowed", "Use POST for MCP requests.");

      if (segments[0] === "agents") {
        if (method === "GET" && segments.length === 1) return json({ agents: engine.manifest().agents });
        const agent = segments[1];
        if (agent && method === "GET" && segments.length === 2) return json(engine.agentCard(agent));
        if (agent && method === "POST" && segments[2] === "runs" && segments.length === 3) {
          const body = await readJson(request);
          const input = (body.input ?? {}) as RunInput;
          if (typeof input !== "object" || input === null || Array.isArray(input)) {
            throw new AgentUnitError(400, "invalid_input", "`input` must be an object.");
          }
          const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
          const { run, done } = await engine.start(agent, input, { threadId });
          if (wantsStream(request)) {
            context.waitUntil?.(done);
            return eventStream(engine.events(run.id, 0, request.signal), request.signal, options.heartbeatMs);
          }
          const settled = await background(done);
          return settled ? json(settled) : json(run, 202);
        }
      }

      if (segments[0] === "runs") {
        const id = segments[1];
        if (!id && method === "GET") {
          const status = url.searchParams.get("status");
          if (status && !RUN_STATUSES.has(status as RunStatus)) throw new AgentUnitError(400, "invalid_status", `Unknown status "${status}".`);
          const limit = Number(url.searchParams.get("limit") ?? 50);
          const runs = await engine.listRuns({
            agent: url.searchParams.get("agent") ?? undefined,
            status: (status as RunStatus | null) ?? undefined,
            threadId: url.searchParams.get("threadId") ?? undefined,
            limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50,
          });
          return json({ runs });
        }
        if (id && method === "GET" && segments.length === 2) return json(await engine.getRun(id));
        if (id && method === "GET" && segments[2] === "events") {
          const after = Number(url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? 0);
          return eventStream(engine.events(id, Number.isFinite(after) ? after : 0, request.signal), request.signal, options.heartbeatMs);
        }
        if (id && method === "POST" && segments[2] === "resume") {
          const body = await readJson(request);
          const before = (await engine.getRun(id)).eventCount;
          const { run, done } = await engine.resume(id, body.answer);
          if (wantsStream(request)) {
            context.waitUntil?.(done);
            return eventStream(engine.events(id, before, request.signal), request.signal, options.heartbeatMs);
          }
          const settled = await background(done);
          return settled ? json(settled) : json(run, 202);
        }
        if (id && method === "POST" && segments[2] === "cancel") return json(await engine.cancel(id));
      }

      return problem(404, "not_found", `No route for ${method} ${path}.`);
    } catch (error) {
      if (error instanceof AgentUnitError) return problem(error.status, error.code, error.message);
      console.error("[agent-unit]", error);
      return problem(500, "internal_error", "Internal error.");
    }
  };
}
