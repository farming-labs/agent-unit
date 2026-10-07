import { describe, expect, it } from "vitest";
import { defineAgent } from "../src/agents";
import { createAgentClient, parseEventStream } from "../src/client";
import { createHandler } from "../src/server";
import type { AgentEvent } from "../src/types";
import { createEngine, types } from "./helpers";

const ORIGIN = "http://agents.test";

function setup(options: Parameters<typeof createHandler>[1] = {}, engineOptions: Parameters<typeof createEngine>[1] = {}) {
  let charges = 0;
  const engine = createEngine(
    {
      refund: defineAgent({
        description: "Refunds an order after approval.",
        tools: [{ name: "charge" }],
        async run(input, run) {
          const order = await run.step("load", () => ({ id: input.orderId ?? "o_1", amount: 40 }));
          const decision = await run.interrupt<{ approved: boolean }>("approve", order);
          if (!decision.approved) return "declined";
          await run.step("charge", () => ++charges);
          return `refunded ${order.id}`;
        },
      }),
      echo: defineAgent(async (input) => {
        const messages = input.messages as { content: string }[] | undefined;
        return `echo: ${messages?.at(-1)?.content ?? input.text}`;
      }),
    },
    { name: "shop", ...engineOptions },
  );
  const pending: Promise<unknown>[] = [];
  const handler = createHandler(engine, options);
  const handle = (path: string, init?: RequestInit) =>
    handler(new Request(`${ORIGIN}${path}`, init), { waitUntil: (promise) => pending.push(promise) });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
  return { engine, handle, fetchImpl, pending, charges: () => charges };
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function sse(response: Response): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const message of parseEventStream(response.body!)) events.push(JSON.parse(message.data));
  return events;
}

describe("HTTP handler", () => {
  it("serves the manifest, agent cards and the A2A card", async () => {
    const { handle } = setup();
    const manifest = await (await handle("/manifest.json")).json();
    expect(manifest).toEqual({
      version: 1,
      name: "shop",
      agents: [
        { name: "refund", framework: "agent-unit", description: "Refunds an order after approval.", tools: [{ name: "charge" }] },
        { name: "echo", framework: "agent-unit", tools: [] },
      ],
    });
    expect(await (await handle("/agents/refund")).json()).toMatchObject({ name: "refund" });
    expect((await handle("/agents/nope")).status).toBe(404);

    const card = await (await handle("/.well-known/agent.json")).json();
    expect(card).toMatchObject({ name: "shop", url: ORIGIN, skills: [{ id: "refund" }, { id: "echo" }] });
  });

  it("starts a run with 202, then streams, resumes and finishes it", async () => {
    const { handle, pending, charges } = setup();
    const started = await handle("/agents/refund/runs", post({ input: { orderId: "o_9" } }));
    expect(started.status).toBe(202);
    const run = await started.json();
    expect(run).toMatchObject({ agent: "refund", status: "running" });
    await Promise.all(pending);

    const parked = await sse(await handle(`/runs/${run.id}/events`));
    expect(types(parked)).toEqual(["RUN_STARTED", "STEP_STARTED", "STEP_FINISHED", "RUN_INTERRUPTED"]);
    expect(await (await handle(`/runs/${run.id}`)).json()).toMatchObject({
      status: "interrupted",
      interrupt: { name: "approve", payload: { id: "o_9", amount: 40 } },
    });

    const resumed = await handle(`/runs/${run.id}/resume`, post({ answer: { approved: true } }, { accept: "text/event-stream" }));
    expect(resumed.headers.get("content-type")).toContain("text/event-stream");
    const after = await sse(resumed);
    expect(types(after)).toEqual(["STEP_STARTED", "STEP_FINISHED", "RUN_FINISHED"]);
    expect(after[0]!.seq).toBe(5);
    expect(after.at(-1)).toMatchObject({ result: "refunded o_9" });
    expect(charges()).toBe(1);

    // Resuming a finished run is a conflict, not a second charge.
    const again = await handle(`/runs/${run.id}/resume`, post({ answer: { approved: true } }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "run_not_interrupted" } });
  });

  it("streams a run directly when the client accepts SSE, with seq as the event id", async () => {
    const { handle } = setup();
    const response = await handle("/agents/echo/runs", post({ input: { text: "hi" } }, { accept: "text/event-stream" }));
    const raw = await response.text();
    expect(raw).toMatch(/^id: 1\nevent: RUN_STARTED\ndata: /);
    expect(raw).toContain('"result":"echo: hi"');
  });

  it("finishes the work inside the request when the host has no waitUntil", async () => {
    const { engine } = setup();
    const handler = createHandler(engine);
    const started = await handler(new Request(`${ORIGIN}/agents/refund/runs`, post({ input: { orderId: "o_2" } })));
    expect(started.status).toBe(200);
    const parked = await started.json();
    expect(parked).toMatchObject({ status: "interrupted", interrupt: { name: "approve" } });

    const resumed = await handler(new Request(`${ORIGIN}/runs/${parked.id}/resume`, post({ answer: { approved: false } })));
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ status: "completed", output: "declined" });
  });

  it("replays from Last-Event-ID", async () => {
    const { handle, pending } = setup();
    const run = await (await handle("/agents/refund/runs", post({}))).json();
    await Promise.all(pending);
    const tail = await sse(await handle(`/runs/${run.id}/events`, { headers: { "last-event-id": "2" } }));
    expect(tail.map((event) => event.seq)).toEqual([3, 4]);
  });

  it("lists, filters and cancels runs", async () => {
    const { handle, pending } = setup();
    const a = await (await handle("/agents/refund/runs", post({ threadId: "t1" }))).json();
    await (await handle("/agents/echo/runs", post({ input: { text: "x" } }))).json();
    await Promise.all(pending);

    expect((await (await handle("/runs")).json()).runs).toHaveLength(2);
    const interrupted = (await (await handle("/runs?status=interrupted")).json()).runs;
    expect(interrupted.map((run: { id: string }) => run.id)).toEqual([a.id]);
    expect((await (await handle("/runs?threadId=t1")).json()).runs).toHaveLength(1);
    expect((await handle("/runs?status=bogus")).status).toBe(400);

    const cancelled = await (await handle(`/runs/${a.id}/cancel`, { method: "POST" })).json();
    expect(cancelled.status).toBe("cancelled");
  });

  it("rejects bad input with structured errors", async () => {
    const { handle } = setup();
    expect((await handle("/agents/echo/runs", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" })).status).toBe(400);
    expect((await handle("/agents/echo/runs", post({ input: [1, 2] }))).status).toBe(400);
    expect((await handle("/agents/ghost/runs", post({}))).status).toBe(404);
    expect((await handle("/runs/run_missing")).status).toBe(404);
    expect((await handle("/nowhere")).status).toBe(404);
  });

  it("refuses bodies that are too large or not JSON, so cross-site forms cannot start runs", async () => {
    const { handle } = setup({ maxBodyBytes: 1000 });
    const form = await handle("/agents/echo/runs", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ input: { text: "from another site" } }),
    });
    expect(form.status).toBe(415);
    expect((await handle("/agents/echo/runs", post({ input: { text: "x".repeat(2000) } }))).status).toBe(413);
    const unsized = new Request(`${ORIGIN}/agents/echo/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 5; i++) controller.enqueue(new TextEncoder().encode("x".repeat(400)));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    const { engine } = setup({ maxBodyBytes: 1000 });
    expect((await createHandler(engine, { maxBodyBytes: 1000 })(unsized)).status).toBe(413);
    // Requests without a body (cancel) need no content type.
    expect((await handle("/runs/run_missing0000000000/cancel", { method: "POST" })).status).toBe(404);
  });

  it("deletes finished runs, refuses to delete live ones, and expires them with retention", async () => {
    const { handle, pending, engine } = setup();
    const done = await (await handle("/agents/echo/runs", post({ input: { text: "bye" } }))).json();
    const parked = await (await handle("/agents/refund/runs", post({}))).json();
    await Promise.all(pending);
    expect((await handle(`/runs/${parked.id}`, { method: "DELETE" })).status).toBe(409);
    expect((await handle(`/runs/${done.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await handle(`/runs/${done.id}`)).status).toBe(404);
    expect(await engine.store.readEvents(done.id)).toEqual([]);
    expect((await (await handle("/runs")).json()).runs.map((run: { id: string }) => run.id)).toEqual([parked.id]);

    const retained = createEngine({ quick: defineAgent(() => "ok") }, { retentionMs: 0 });
    const run = await (await retained.start("quick")).done;
    const swept = await retained.sweep(Date.now() + 1);
    expect(swept.deleted).toEqual([run!.id]);
    expect(await retained.listRuns()).toEqual([]);
  });

  it("honours basePath and authorize", async () => {
    const { handle } = setup({
      basePath: "/api/agents/",
      authorize: (request) => request.headers.get("authorization") === "Bearer ok",
    });
    expect((await handle("/manifest.json")).status).toBe(404);
    expect((await handle("/api/agents/manifest.json")).status).toBe(401);
    expect((await handle("/api/agents/manifest.json", { headers: { authorization: "Bearer ok" } })).status).toBe(200);
    // Discovery stays public.
    const card = await (await handle("/api/agents/.well-known/agent.json")).json();
    expect(card.url).toBe(`${ORIGIN}/api/agents`);
  });

  it("guards the internal endpoints with the secret and sweeps sleepers", async () => {
    const engine = createEngine({
      nap: defineAgent(async (_input, run) => {
        await run.sleep("2h");
        return "rested";
      }),
    });
    const handler = createHandler(engine, { secret: "s3cret" });
    const pending: Promise<unknown>[] = [];
    const call = (path: string, init?: RequestInit) => handler(new Request(`${ORIGIN}${path}`, init), { waitUntil: (p) => pending.push(p) });

    const run = await (await call("/agents/nap/runs", post({}))).json();
    await Promise.all(pending);
    expect((await engine.getRun(run.id)).status).toBe("sleeping");

    expect((await call("/__agent-unit/sweep", { method: "POST" })).status).toBe(401);
    expect((await call("/__agent-unit/sweep", { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);

    // Not due yet: nothing wakes.
    const early = await (await call("/__agent-unit/sweep", { method: "POST", headers: { authorization: "Bearer s3cret" } })).json();
    expect(early).toEqual({ woken: [], recovered: [], deleted: [] });

    const record = await engine.store.getRun(run.id);
    record!.wakeAt = new Date(Date.now() - 1000).toISOString();
    await engine.store.putRun(record!);
    const due = await (await call("/__agent-unit/sweep", { method: "POST", headers: { authorization: "Bearer s3cret" } })).json();
    expect(due.woken).toEqual([run.id]);
    await Promise.all(pending);
    expect(await engine.getRun(run.id)).toMatchObject({ status: "completed", output: "rested" });
    engine.close();
  });

  it("disables the internal endpoints without a secret", async () => {
    const { handle } = setup({}, { env: {} });
    expect((await handle("/__agent-unit/sweep", { method: "POST", headers: { authorization: "Bearer " } })).status).toBe(401);
  });

  it("continues a yielded run through the internal endpoint", async () => {
    let steps = 0;
    const engine = createEngine(
      {
        long: defineAgent(async (_input, run) => {
          for (let i = 0; i < 3; i++) {
            await run.step(`part-${i}`, async () => {
              await new Promise((resolve) => setTimeout(resolve, 15));
              return ++steps;
            });
          }
          return steps;
        }),
      },
      { budgetMs: 10, env: { AGENT_UNIT_SECRET: "k" } },
    );
    const continued: string[] = [];
    const handler = createHandler(engine, { origin: ORIGIN });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      continued.push(new URL(request.url).pathname);
      return handler(request);
    }) as typeof fetch;
    try {
      const response = await handler(new Request(`${ORIGIN}/agents/long/runs`, post({}, { accept: "text/event-stream" })));
      const events = await sse(response);
      expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: 3 });
      expect(continued.length).toBeGreaterThan(0);
      expect(continued.every((path) => path.startsWith("/__agent-unit/continue/run_"))).toBe(true);
      expect(steps).toBe(3);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("never sends the secret to a host named by a request", async () => {
    const engine = createEngine(
      {
        long: defineAgent(async (_input, run) => {
          for (let i = 0; i < 3; i++) await run.step(`part-${i}`, () => new Promise((resolve) => setTimeout(resolve, 15)));
          return "done";
        }),
      },
      { budgetMs: 10, env: { AGENT_UNIT_SECRET: "k" } },
    );
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    try {
      const handler = createHandler(engine);
      // The first request names an attacker's host; continuations must not go there.
      const response = await handler(new Request("http://evil.example/agents/long/runs", post({}, { accept: "text/event-stream" })));
      const events = await sse(response);
      expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: "done" });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rejects internal requests with a wrong secret of any length", async () => {
    const { handle } = setup({ secret: "s3cret" });
    for (const value of ["", "Bearer ", "Bearer s3cre", "Bearer s3cret!", "Bearer S3CRET"]) {
      expect((await handle("/__agent-unit/sweep", { method: "POST", headers: { authorization: value } })).status).toBe(401);
    }
  });
});

describe("MCP endpoint", () => {
  const rpc = (body: unknown) => post(body, { accept: "application/json, text/event-stream" });

  it("initializes, lists agents as tools and calls them", async () => {
    const { handle } = setup();
    const init = await (await handle("/mcp", rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }))).json();
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "shop" }, capabilities: { tools: {} } });

    expect((await handle("/mcp", rpc({ jsonrpc: "2.0", method: "notifications/initialized" }))).status).toBe(202);

    const list = await (await handle("/mcp", rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).json();
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["refund", "echo"]);

    const call = await (await handle("/mcp", rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { message: "ping" } } }))).json();
    expect(call.result).toMatchObject({ content: [{ type: "text", text: "echo: ping" }], structuredContent: { status: "completed" } });

    const parked = await (await handle("/mcp", rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "refund", arguments: { message: "refund o_1" } } }))).json();
    expect(parked.result.structuredContent).toMatchObject({ status: "interrupted", interrupt: { name: "approve" } });

    const missing = await (await handle("/mcp", rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ghost", arguments: { message: "x" } } }))).json();
    expect(missing.error.code).toBe(-32602);

    const unknown = await (await handle("/mcp", rpc({ jsonrpc: "2.0", id: 6, method: "resources/list" }))).json();
    expect(unknown.error.code).toBe(-32601);

    expect((await handle("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "nope" })).status).toBe(400);
    const batch = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    expect((await handle("/mcp", rpc(batch))).status).toBe(400);
  });
});

describe("client", () => {
  it("runs, resumes and inspects through the typed client", async () => {
    const { fetchImpl } = setup();
    const client = createAgentClient({ baseUrl: `${ORIGIN}/`, fetch: fetchImpl });

    expect((await client.manifest()).agents).toHaveLength(2);
    expect((await client.agent("refund")).tools).toEqual([{ name: "charge" }]);

    const first: AgentEvent[] = [];
    for await (const event of client.run("refund", { orderId: "o_5" })) first.push(event);
    expect(first.at(-1)?.type).toBe("RUN_INTERRUPTED");
    const runId = first[0]!.runId;

    const second: AgentEvent[] = [];
    for await (const event of client.resume(runId, { approved: true })) second.push(event);
    expect(types(second)).toEqual(["STEP_STARTED", "STEP_FINISHED", "RUN_FINISHED"]);

    expect(await client.get(runId)).toMatchObject({ status: "completed", output: "refunded o_5" });
    expect(await client.list({ agent: "refund", status: "completed" })).toHaveLength(1);

    const started = await client.start("echo", { text: "later" });
    expect(await client.wait(started.id)).toMatchObject({ status: "completed", output: "echo: later" });

    await expect(client.agent("ghost")).rejects.toMatchObject({ status: 404, code: "agent_not_found" });
  });

  it("parses multi-line and CRLF SSE frames and skips comments", async () => {
    const body = new Response(": hi\r\n\r\nid: 1\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\nid: 2\ndata: c\n\n").body!;
    const messages = [];
    for await (const message of parseEventStream(body)) messages.push(message);
    expect(messages).toEqual([
      { id: "1", event: "x", data: "a\nb" },
      { id: "2", data: "c" },
    ]);
  });
});
