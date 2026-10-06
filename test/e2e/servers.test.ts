import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFixture,
  cleanup,
  collect,
  createAgentClient,
  hasBinary,
  prepareFixture,
  startServer,
  tempDir,
  waitForStatus,
  type RunningServer,
} from "./helpers";

// Long-lived servers: build the fixture for each preset, run the real output, and drive it over HTTP,
// including restarts in the middle of a run.

const RUNTIMES = [
  { preset: "node-server", command: process.execPath, args: (out: string) => [join(out, "server/index.mjs")], available: true },
  { preset: "bun", command: "bun", args: (out: string) => ["run", join(out, "server/index.mjs")], available: hasBinary("bun") },
  {
    preset: "deno-server",
    command: "deno",
    args: (out: string) => ["run", "-A", join(out, "server/index.mjs")],
    available: hasBinary("deno"),
  },
];

const SECRET = "e2e-secret";
const TOKEN = "e2e-token";

for (const runtime of RUNTIMES) {
  describe.skipIf(!runtime.available)(`${runtime.preset} server`, () => {
    let root: string;
    let out: string;
    let data: string;
    let server: RunningServer;

    const start = () =>
      startServer(runtime.command, runtime.args(out), {
        cwd: root,
        env: { AGENT_UNIT_SECRET: SECRET, API_TOKEN: TOKEN, GREETING: "hey" },
      });
    const client = () => createAgentClient({ baseUrl: server.url, headers: { authorization: `Bearer ${TOKEN}` } });
    const restart = async () => {
      await server.stop();
      server = await start();
    };

    beforeAll(async () => {
      root = prepareFixture("basic");
      out = tempDir(`${runtime.preset}-out`);
      data = tempDir(`${runtime.preset}-data`);
      const result = await buildFixture(root, runtime.preset, out, { AGENT_UNIT_DATA: data });
      expect(result.preset).toBe(runtime.preset);
      expect(result.storage).toEqual({ driver: "fs-lite", base: data, atomic: true });
      server = await start();
    });

    afterAll(async () => {
      await server?.stop();
      cleanup(out, data);
    });

    it("serves the manifest and the public agent card, and enforces authorize", async () => {
      const unauthorized = await fetch(`${server.url}/manifest.json`);
      expect(unauthorized.status).toBe(401);

      const manifest = await client().manifest();
      expect(manifest.name).toBe("basic");
      expect(manifest.agents.map((agent) => agent.name).sort()).toEqual(["greeter", "napper", "refund"]);
      expect(manifest.agents.find((agent) => agent.name === "refund")).toMatchObject({
        framework: "agent-unit",
        tools: [{ name: "charge", description: "Refunds the card." }],
      });

      const card = await (await fetch(`${server.url}/.well-known/agent.json`)).json();
      expect(card).toMatchObject({ name: "basic", url: server.url, skills: expect.arrayContaining([expect.objectContaining({ id: "refund" })]) });
    });

    it("parks on an interrupt, survives a restart, and resumes without repeating side effects", async () => {
      const first = await collect(client().run("refund", { orderId: "o_restart" }));
      expect(first.map((event) => event.type)).toEqual(["RUN_STARTED", "STEP_STARTED", "STEP_FINISHED", "RUN_INTERRUPTED"]);
      const interrupted = first.at(-1)!;
      expect(interrupted).toMatchObject({ interrupt: { name: "approve-refund", payload: { id: "o_restart", amount: 42 } } });

      await restart();

      const second = await collect(client().resume(interrupted.runId, { approved: true }));
      expect(second.map((event) => event.type)).toEqual(["STEP_STARTED", "STEP_FINISHED", "RUN_FINISHED"]);
      expect(second[0]!.seq).toBe(5);
      expect(second.at(-1)).toMatchObject({ result: { status: "refunded", order: "o_restart", loads: 1, charges: 1 } });

      // The whole history is still one ordered stream.
      const history = await collect(client().events(interrupted.runId));
      expect(history.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it("reads secrets from the environment and answers MCP tool calls", async () => {
      const events = await collect(client().run("greeter", { name: "farm" }));
      expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: "hey farm" });

      const rpc = (body: unknown) =>
        fetch(`${server.url}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(body),
        }).then((response) => response.json());
      const tools = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(tools.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["greeter", "napper", "refund"]);
      const call = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "greeter", arguments: { message: "mcp" } } });
      expect(call.result.content).toEqual([{ type: "text", text: "hey mcp" }]);
    });

    it("wakes a short sleep in-process", async () => {
      const events = await collect(client().run("napper", { ms: 200 }));
      // The stream ends at RUN_SLEEPING, or follows the run on when the timer fires first.
      expect(events.map((event) => event.type)).toContain("RUN_SLEEPING");
      const run = await waitForStatus(client(), events[0]!.runId, "completed");
      expect(run.output).toEqual({ slept: true });
    });

    it("recovers a sleeping run after a crash through the secret-guarded sweep", async () => {
      const events = await collect(client().run("napper", { ms: 800 }));
      const sleeping = events.at(-1)!;
      expect(sleeping.type).toBe("RUN_SLEEPING");
      await server.stop();

      // Wait out the sleep while the server is down, then bring it back.
      const wakeAt = Date.parse((sleeping as { wakeAt: string }).wakeAt);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, wakeAt - Date.now() + 50)));
      server = await start();
      expect((await client().get(sleeping.runId)).status).toBe("sleeping");

      const denied = await fetch(`${server.url}/__agent-unit/sweep`, { method: "POST" });
      expect(denied.status).toBe(401);
      const swept = await fetch(`${server.url}/__agent-unit/sweep`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
      expect(await swept.json()).toMatchObject({ woken: [sleeping.runId] });
      expect(await waitForStatus(client(), sleeping.runId, "completed")).toMatchObject({ output: { slept: true }, attempt: 2 });
    });

    it("cancels a parked run", async () => {
      const run = await client().start("refund", { orderId: "o_cancel" });
      await waitForStatus(client(), run.id, "interrupted");
      expect(await client().cancel(run.id)).toMatchObject({ status: "cancelled" });
      await expect(collect(client().resume(run.id, { approved: true }))).rejects.toMatchObject({ status: 409 });
    });
  });
}
