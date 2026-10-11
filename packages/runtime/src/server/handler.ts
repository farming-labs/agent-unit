import { AgentUnitError, RunEngine } from "../runtime/engine";
import type { AgentEvent, RunInput, RunRecord, RunStatus } from "../types";
import { agentCardDocument } from "./a2a";
import { readBody } from "./body";
import { handleMcp } from "./mcp";
import type { RunService } from "./service";

export interface HandlerOptions {
  /** Path prefix the API is mounted under, e.g. `/api/agents`. Default: none. */
  basePath?: string;
  /**
   * Returns false (or a Response) to reject a request. Runs before every route except the agent
   * card, with what the request does: for a run, the agent and thread come from the stored run, so an
   * app can check that this caller owns the thread rather than trusting an id it was sent.
   */
  authorize?: (request: Request, context: AuthorizeContext) => boolean | Response | Promise<boolean | Response>;
  /**
   * Secret for the internal continuation and sweep endpoints. Default: the AGENT_UNIT_SECRET
   * environment variable. Without one those endpoints are disabled.
   */
  secret?: string;
  /**
   * This deployment's own URL, used to continue a long run in a fresh invocation. Default: the
   * AGENT_UNIT_URL environment variable, or the platform's (VERCEL_URL, Netlify's URL). It is never
   * taken from a request, whose Host header anyone can set. Without one, runs continue in-process.
   */
  origin?: string;
  /** Largest accepted request body, in bytes. Default 1 MB. */
  maxBodyBytes?: number;
  /** Most messages accepted in one MCP JSON-RPC batch. Default 20. */
  maxBatch?: number;
  /** Interval for SSE keep-alive comments. Default 15s. */
  heartbeatMs?: number;
  version?: string;
}

/** Compares secrets in constant time, so response timing reveals nothing about the expected value. */
function safeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/** What a request does, for `authorize`. */
export interface AuthorizeContext {
  action: "manifest" | "list" | "start" | "read" | "events" | "resume" | "cancel" | "delete" | "mcp";
  agent?: string;
  runId?: string;
  threadId?: string;
}

/** Thread ids name shared state, so they are plain text of a sensible length. */
const THREAD_ID = /^[^\u0000-\u001f\u007f]{1,256}$/;

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

async function readJson(request: Request, maxBytes?: number): Promise<Record<string, unknown>> {
  const text = await readBody(request, maxBytes);
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
export function createHandler(engine: RunService, options: HandlerOptions = {}) {
  const base = (options.basePath ?? "").replace(/\/+$/, "");
  const secret = () => options.secret ?? engine.env().AGENT_UNIT_SECRET;
  const selfOrigin = (): string | undefined => {
    const env = engine.env();
    const candidate = options.origin ?? env.AGENT_UNIT_URL ?? (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined) ?? env.URL;
    if (!candidate) return undefined;
    try {
      return new URL(candidate).origin;
    } catch {
      return undefined;
    }
  };

  // Serverless hosts continue a yielded run in a fresh invocation through the internal endpoint.
  if (engine instanceof RunEngine && !engine.options.continueRun && !engine.options.scheduleWake) {
    engine.options.continueRun = async (id) => {
      const token = secret();
      const origin = selfOrigin();
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
    return Boolean(token) && safeEqual(request.headers.get("authorization") ?? "", `Bearer ${token}`);
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
    if (base && !url.pathname.startsWith(base)) return problem(404, "not_found", "Not found.");
    const path = url.pathname.slice(base.length).replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    /** undefined when allowed; otherwise the response to send. */
    const guard = async (authorization: AuthorizeContext): Promise<Response | undefined> => {
      if (!options.authorize) return undefined;
      const verdict = await options.authorize(request, authorization);
      if (verdict instanceof Response) return verdict;
      return verdict ? undefined : problem(401, "unauthorized", "Unauthorized.");
    };
    /** Authorizes an action on a stored run, with its agent and thread; unauthorized callers learn nothing about whether it exists. */
    const guardRun = async (action: AuthorizeContext["action"], id: string) => {
      let record: RunRecord | undefined;
      try {
        record = await engine.getRun(id);
      } catch (error) {
        if (!(error instanceof AgentUnitError) || error.status !== 404) throw error;
      }
      const denied = await guard({ action, runId: id, agent: record?.agent, threadId: record?.threadId });
      if (denied) return { denied };
      if (!record) throw new AgentUnitError(404, "run_not_found", `No run with id "${id}".`);
      return { record };
    };

    try {
      let segments: string[];
      try {
        segments = path.split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        throw new AgentUnitError(400, "invalid_path", "The request path is not valid percent-encoding.");
      }
      // Discovery documents are public so registries can find the agents.
      if (method === "GET" && path === "/.well-known/agent.json") {
        return json(agentCardDocument(engine.manifest(), `${url.origin}${base}`, options.version));
      }

      if (segments[0] === "__agent-unit") {
        if (!internalAllowed(request)) return problem(401, "unauthorized", "Missing or invalid agent-unit secret.");
        if (method === "POST" && segments[1] === "continue" && segments[2] && engine.continue) {
          await background(engine.continue(segments[2]));
          return json({ ok: true }, context.waitUntil ? 202 : 200);
        }
        if (segments[1] === "sweep" && engine.sweep) {
          const { woken, recovered, deleted, settled } = await engine.sweep();
          await background(settled);
          return json({ woken, recovered, deleted });
        }
        return problem(404, "not_found", "Not found.");
      }

      if (method === "GET" && (path === "/" || path === "/manifest.json")) {
        return (await guard({ action: "manifest" })) ?? json(engine.manifest());
      }
      if (method === "POST" && path === "/mcp") {
        const denied = await guard({ action: "mcp" });
        if (denied) return denied;
        return await handleMcp(engine, request, context, options.version, {
          maxBodyBytes: options.maxBodyBytes,
          maxBatch: options.maxBatch,
          // Each tool call starts a run: authorized like a start, per agent and thread.
          authorizeStart: async (agent, threadId) => !(await guard({ action: "start", agent, threadId })),
        });
      }
      if (method === "GET" && path === "/mcp") return problem(405, "method_not_allowed", "Use POST for MCP requests.");

      if (segments[0] === "agents") {
        if (method === "GET" && segments.length === 1) return (await guard({ action: "manifest" })) ?? json({ agents: engine.manifest().agents });
        const agent = segments[1];
        if (agent && method === "GET" && segments.length === 2) return (await guard({ action: "manifest", agent })) ?? json(engine.agentCard(agent));
        if (agent && method === "POST" && segments[2] === "runs" && segments.length === 3) {
          const body = await readJson(request, options.maxBodyBytes);
          const input = (body.input ?? {}) as RunInput;
          if (typeof input !== "object" || input === null || Array.isArray(input)) {
            throw new AgentUnitError(400, "invalid_input", "`input` must be an object.");
          }
          if (body.threadId !== undefined && (typeof body.threadId !== "string" || !THREAD_ID.test(body.threadId))) {
            throw new AgentUnitError(400, "invalid_thread_id", "`threadId` must be a string of 1 to 256 printable characters.");
          }
          const threadId = body.threadId as string | undefined;
          const denied = await guard({ action: "start", agent, threadId });
          if (denied) return denied;
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
          const denied = await guard({
            action: "list",
            agent: url.searchParams.get("agent") ?? undefined,
            threadId: url.searchParams.get("threadId") ?? undefined,
          });
          if (denied) return denied;
          const limit = Number(url.searchParams.get("limit") ?? 50);
          const runs = await engine.listRuns({
            agent: url.searchParams.get("agent") ?? undefined,
            status: (status as RunStatus | null) ?? undefined,
            threadId: url.searchParams.get("threadId") ?? undefined,
            limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50,
          });
          return json({ runs });
        }
        if (id && method === "GET" && segments.length === 2) {
          const checked = await guardRun("read", id);
          return checked.denied ?? json(checked.record);
        }
        if (id && method === "GET" && segments[2] === "events") {
          const checked = await guardRun("events", id);
          if (checked.denied) return checked.denied;
          const after = Number(url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? 0);
          return eventStream(engine.events(id, Number.isFinite(after) ? after : 0, request.signal), request.signal, options.heartbeatMs);
        }
        if (id && method === "POST" && segments[2] === "resume") {
          const checked = await guardRun("resume", id);
          if (checked.denied) return checked.denied;
          const body = await readJson(request, options.maxBodyBytes);
          const before = checked.record.eventCount;
          const { run, done } = await engine.resume(id, body.answer);
          if (wantsStream(request)) {
            context.waitUntil?.(done);
            return eventStream(engine.events(id, before, request.signal), request.signal, options.heartbeatMs);
          }
          const settled = await background(done);
          return settled ? json(settled) : json(run, 202);
        }
        if (id && method === "POST" && segments[2] === "cancel") {
          const checked = await guardRun("cancel", id);
          return checked.denied ?? json(await engine.cancel(id));
        }
        if (id && method === "DELETE" && segments.length === 2) {
          if (!engine.deleteRun) return problem(405, "method_not_allowed", "This runtime does not delete runs.");
          const checked = await guardRun("delete", id);
          if (checked.denied) return checked.denied;
          await engine.deleteRun(id);
          return new Response(null, { status: 204 });
        }
      }

      return problem(404, "not_found", `No route for ${method} ${path}.`);
    } catch (error) {
      if (error instanceof AgentUnitError) return problem(error.status, error.code, error.message);
      console.error("[agent-unit]", error);
      return problem(500, "internal_error", "Internal error.");
    }
  };
}
