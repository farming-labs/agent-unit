import type { AgentCard, AgentEvent, Manifest, RunInput, RunRecord, RunStatus } from "../types";

export type { AgentCard, AgentEvent, Manifest, RunInput, RunRecord, RunStatus } from "../types";

export interface AgentClientOptions {
  /** Where the agent-unit API is mounted, e.g. `https://agents.example.com`. */
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** How many times `events` reconnects after a dropped stream. Default 5. */
  reconnects?: number;
}

export class AgentClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentClientError";
  }
}

/** Parses an SSE body into events. Comments and unnamed keep-alives are skipped. */
export async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<{ id?: string; event?: string; data: string }> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        const message: { id?: string; event?: string; data: string } = { data: "" };
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (!line || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(value);
          else if (field === "id") message.id = value;
          else if (field === "event") message.event = value;
        }
        if (data.length === 0) continue;
        message.data = data.join("\n");
        yield message;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const SETTLING = new Set(["RUN_FINISHED", "RUN_ERROR", "RUN_INTERRUPTED", "RUN_SLEEPING", "RUN_CANCELLED"]);

/** A typed client for the agent-unit HTTP API (spec/runs.md). Works in browsers, Node, Bun, Deno and Workers. */
export function createAgentClient(options: AgentClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const extra = typeof options.headers === "function" ? await options.headers() : options.headers;
    const headers = new Headers(extra);
    for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await doFetch(`${base}${path}`, { ...init, headers });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { error?: { code?: string; message?: string } } | undefined;
      throw new AgentClientError(response.status, body?.error?.code ?? "http_error", body?.error?.message ?? `Request failed with ${response.status}.`);
    }
    return response;
  }

  const getJson = async <T>(path: string, init?: RequestInit) => (await request(path, init)).json() as Promise<T>;

  async function* stream(response: Response): AsyncGenerator<AgentEvent> {
    if (!response.body) return;
    for await (const message of parseEventStream(response.body)) {
      if (message.event === "error") throw new AgentClientError(500, "stream_error", JSON.parse(message.data).message);
      yield JSON.parse(message.data) as AgentEvent;
    }
  }

  /** Follows a run's events from `after`, reconnecting with the last seen seq until it settles. */
  async function* events(runId: string, init: { after?: number; signal?: AbortSignal } = {}): AsyncGenerator<AgentEvent> {
    let cursor = init.after ?? 0;
    let attempts = 0;
    while (!init.signal?.aborted) {
      let settled = false;
      try {
        const response = await request(`/runs/${encodeURIComponent(runId)}/events?after=${cursor}`, {
          headers: { accept: "text/event-stream" },
          signal: init.signal,
        });
        for await (const event of stream(response)) {
          attempts = 0;
          cursor = event.seq;
          yield event;
          if (SETTLING.has(event.type)) settled = true;
        }
        // The server closes the stream when the run settles, so a clean end without a settling event is a drop.
        const run = await getJson<RunRecord>(`/runs/${encodeURIComponent(runId)}`, { signal: init.signal });
        if (settled || (run.status !== "running" && run.eventCount <= cursor)) return;
      } catch (error) {
        if (error instanceof AgentClientError && error.status < 500) throw error;
        if (init.signal?.aborted) return;
        if (++attempts > (options.reconnects ?? 5)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempts, 5_000)));
      }
    }
  }

  return {
    manifest: () => getJson<Manifest>("/manifest.json"),
    agents: async () => (await getJson<{ agents: AgentCard[] }>("/agents")).agents,
    agent: (name: string) => getJson<AgentCard>(`/agents/${encodeURIComponent(name)}`),

    /** Starts a run and returns its record without waiting. */
    start: (agent: string, input: RunInput = {}, init: { threadId?: string } = {}) =>
      getJson<RunRecord>(`/agents/${encodeURIComponent(agent)}/runs`, {
        method: "POST",
        body: JSON.stringify({ input, threadId: init.threadId }),
      }),

    /** Starts a run and streams its events until it finishes or parks. */
    async *run(agent: string, input: RunInput = {}, init: { threadId?: string; signal?: AbortSignal } = {}): AsyncGenerator<AgentEvent> {
      const response = await request(`/agents/${encodeURIComponent(agent)}/runs`, {
        method: "POST",
        headers: { accept: "text/event-stream" },
        body: JSON.stringify({ input, threadId: init.threadId }),
        signal: init.signal,
      });
      let cursor = 0;
      let runId: string | undefined;
      let settled = false;
      try {
        for await (const event of stream(response)) {
          cursor = event.seq;
          runId = event.runId;
          yield event;
          if (SETTLING.has(event.type)) settled = true;
        }
      } catch (error) {
        if (!runId || init.signal?.aborted) throw error;
      }
      if (!settled && runId && !init.signal?.aborted) yield* events(runId, { after: cursor, signal: init.signal });
    },

    /** Answers a pending interrupt and streams the events that follow. */
    async *resume(runId: string, answer: unknown, init: { signal?: AbortSignal } = {}): AsyncGenerator<AgentEvent> {
      const before = await getJson<RunRecord>(`/runs/${encodeURIComponent(runId)}`, { signal: init.signal });
      await request(`/runs/${encodeURIComponent(runId)}/resume`, {
        method: "POST",
        body: JSON.stringify({ answer }),
        signal: init.signal,
      });
      yield* events(runId, { after: before.eventCount, signal: init.signal });
    },

    events,
    get: (runId: string) => getJson<RunRecord>(`/runs/${encodeURIComponent(runId)}`),
    list: (filter: { agent?: string; status?: RunStatus; threadId?: string; limit?: number } = {}) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filter)) if (value !== undefined) params.set(key, String(value));
      const query = params.size ? `?${params}` : "";
      return getJson<{ runs: RunRecord[] }>(`/runs${query}`).then((body) => body.runs);
    },
    cancel: (runId: string) => getJson<RunRecord>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),

    /** Streams events until the run settles and returns its final record. */
    async wait(runId: string, init: { signal?: AbortSignal } = {}): Promise<RunRecord> {
      for await (const _ of events(runId, init));
      return getJson<RunRecord>(`/runs/${encodeURIComponent(runId)}`);
    },
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
