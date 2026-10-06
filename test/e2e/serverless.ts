import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildFixture, cleanup, prepareFixture, tempDir } from "./helpers";

const SECRET = "e2e-secret";
const TOKEN = "e2e-token";
const ORIGIN = "https://agents.example.com";

export interface ServerlessHost {
  preset: string;
  /** Path of the function module inside the output directory. */
  entry: string;
  /** Whether the platform keeps work alive after the response (waitUntil). */
  waitUntil: boolean;
  /** Calls the built function with a Web request, the way the platform would. */
  invoke(module: Record<string, any>, request: Request, waitUntil: (promise: Promise<unknown>) => void): Promise<Response>;
  /** Fires the platform's scheduled trigger, when the preset wires one up. */
  cron?(module: Record<string, any>, out: string, call: (request: Request) => Promise<Response>): Promise<void>;
}

/**
 * Builds the fixture for a serverless preset and calls its real function bundle in-process: the same
 * entry the platform invokes, with the platform's request shape and waitUntil semantics.
 */
export function serverlessSuite(host: ServerlessHost) {
  let out: string;
  let data: string;
  let module: Record<string, any>;
  const pending: Promise<unknown>[] = [];

  const call = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${TOKEN}`);
    if (init.body) headers.set("content-type", "application/json");
    return host.invoke(module, new Request(`${ORIGIN}${path}`, { ...init, headers }), (promise) => pending.push(promise));
  };
  const settle = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  const json = async (response: Response) => {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON, got ${response.status}: ${text.slice(0, 300)}`);
    }
  };

  beforeAll(async () => {
    const root = prepareFixture("basic");
    out = tempDir(`${host.preset}-out`);
    data = tempDir(`${host.preset}-data`);
    await buildFixture(root, host.preset, out, { AGENT_UNIT_DATA: data });
    Object.assign(process.env, { AGENT_UNIT_SECRET: SECRET, API_TOKEN: TOKEN, GREETING: "hey", CRON_SECRET: SECRET });
    module = await import(pathToFileURL(join(out, host.entry)).href);
  });

  afterAll(async () => {
    await settle();
    cleanup(out, data);
  });

  it("serves the manifest behind authorize", async () => {
    expect((await call("/manifest.json", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const manifest = await json(await call("/manifest.json"));
    expect(manifest.agents.map((agent: { name: string }) => agent.name).sort()).toEqual(["greeter", "napper", "refund"]);
    const card = await json(await call("/.well-known/agent.json"));
    expect(card.url).toBe(ORIGIN);
  });

  it("runs an interrupt and resume across separate invocations", async () => {
    const started = await call("/agents/refund/runs", { method: "POST", body: JSON.stringify({ input: { orderId: "o_fn" } }) });
    // With waitUntil the run continues after a 202; without it the request carries the run until it parks.
    expect(started.status).toBe(host.waitUntil ? 202 : 200);
    const run = await json(started);
    await settle();
    expect(await json(await call(`/runs/${run.id}`))).toMatchObject({ status: "interrupted", interrupt: { name: "approve-refund" } });

    const resumed = await call(`/runs/${run.id}/resume`, { method: "POST", body: JSON.stringify({ answer: { approved: true } }) });
    expect(resumed.status).toBe(host.waitUntil ? 202 : 200);
    await settle();
    expect(await json(await call(`/runs/${run.id}`))).toMatchObject({
      status: "completed",
      attempt: 2,
      output: { status: "refunded", loads: 1, charges: 1 },
    });

    const stream = await call(`/runs/${run.id}/events`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const body = await stream.text();
    expect(body.match(/^id: /gm)).toHaveLength(7);
  });

  it("answers MCP tool calls", async () => {
    const result = await json(
      await call("/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "greeter", arguments: { message: "fn" } } }),
      }),
    );
    expect(result.result.content).toEqual([{ type: "text", text: "hey fn" }]);
  });

  it("wakes a due sleeper from the sweep", async () => {
    // Sleep long enough that no in-process timer is armed, then make it due, as time passing would.
    const started = await call("/agents/napper/runs", { method: "POST", body: JSON.stringify({ input: { ms: 3_600_000 } }) });
    const run = await json(started);
    await settle();
    const file = join(data, "runs", run.id);
    const record = JSON.parse(readFileSync(file, "utf8"));
    expect(record.status).toBe("sleeping");
    writeFileSync(file, JSON.stringify({ ...record, wakeAt: new Date(Date.now() - 1_000).toISOString() }));

    if (host.cron) {
      await host.cron(module, out, (request) => host.invoke(module, request, (promise) => pending.push(promise)));
    } else {
      expect((await call("/__agent-unit/sweep", { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      const swept = await json(await call("/__agent-unit/sweep", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
      expect(swept.woken).toEqual([run.id]);
    }
    await settle();
    expect(await json(await call(`/runs/${run.id}`))).toMatchObject({ status: "completed", attempt: 2 });
  });
}
