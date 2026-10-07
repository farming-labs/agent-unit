import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, collect, createAgentClient, hasBinary, prepareFixture, startServer, tempDir, type RunningServer } from "./helpers";
import { lambda, netlify, vercel, workerd, writeDurableConfig, type FunctionHost } from "./hosts";

// Every built-in adapter on every host, through the real production bundle: start a run that pauses
// for approval, restart the host, resume, and check that no model call or side effect repeats.

const CASES = [
  { agent: "ai-sdk", interrupt: "approve-refund", output: "Refunded o_42.", model: 2 },
  { agent: "mastra", interrupt: "approve-refund", output: "Refunded o_42.", model: 2 },
  { agent: "openai-agents", interrupt: "tool-approval", output: "Refunded o_42.", model: 2 },
  { agent: "langgraph", interrupt: "review", output: undefined, model: 0 },
];

/** A running build: a client for it, and a way to restart it on the same storage. */
interface Deployment {
  client(): ReturnType<typeof createAgentClient>;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

interface Host {
  name: string;
  preset: string;
  available: boolean;
  env?: Record<string, string>;
  launch(out: string, root: string): Promise<Deployment>;
}

/** A long-lived server process, killed and started again for a restart. */
function processHost(preset: string, command: string, args: (out: string) => string[], available = hasBinary(command)): Host {
  return {
    name: preset,
    preset,
    available,
    async launch(out, root) {
      const start = () => startServer(command, args(out), { cwd: root });
      let server: RunningServer = await start();
      return {
        client: () => createAgentClient({ baseUrl: server.url }),
        async restart() {
          await server.stop();
          server = await start();
        },
        stop: () => server.stop(),
      };
    },
  };
}

/** A function bundle invoked in-process the way its platform invokes it; a restart is a cold start. */
function functionHost(host: FunctionHost): Host {
  return {
    name: host.preset,
    preset: host.preset,
    available: true,
    async launch(out) {
      let cold = 0;
      const load = async () => (await import(`${pathToFileURL(join(out, host.entry)).href}?cold=${cold++}`)) as Record<string, any>;
      let module = await load();
      const pending: Promise<unknown>[] = [];
      const call = async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await host.invoke(module, new Request(input, init), (promise) => void pending.push(promise));
        // Work handed to waitUntil finishes before the next invocation, as the platform keeps it alive.
        const body = await response.arrayBuffer();
        while (pending.length) await Promise.allSettled(pending.splice(0));
        return new Response(response.status === 204 ? null : body, { status: response.status, headers: response.headers });
      };
      return {
        client: () => createAgentClient({ baseUrl: "https://agents.example.com", fetch: call as typeof fetch }),
        async restart() {
          module = await load();
        },
        async stop() {},
      };
    },
  };
}

/** workerd with the Durable Objects runtime, objects kept on disk across restarts. */
const durableObjects: Host = {
  name: "cloudflare-module (durable-objects)",
  preset: "cloudflare-module",
  available: Boolean(workerd),
  env: { AGENT_UNIT_RUNTIME: "durable-objects" },
  async launch(out) {
    const disk = join(out, "do-disk");
    mkdirSync(disk, { recursive: true });
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const { config } = writeDurableConfig(out, disk, port);
    const start = () => startServer(workerd!, ["serve", config], { cwd: out, port });
    let server = await start();
    return {
      client: () => createAgentClient({ baseUrl: server.url }),
      async restart() {
        await server.stop();
        server = await start();
      },
      stop: () => server.stop(),
    };
  },
};

const HOSTS: Host[] = [
  processHost("node-server", process.execPath, (out) => [join(out, "server/index.mjs")], true),
  processHost("bun", "bun", (out) => ["run", join(out, "server/index.mjs")]),
  processHost("deno-server", "deno", (out) => ["run", "-A", join(out, "server/index.mjs")]),
  durableObjects,
  functionHost(vercel),
  functionHost(netlify),
  functionHost(lambda),
];

for (const host of HOSTS) {
  describe.skipIf(!host.available)(`framework adapters on ${host.name}`, () => {
    let out: string;
    let data: string;
    let deployment: Deployment;
    const client = () => deployment.client();

    beforeAll(async () => {
      const root = prepareFixture("frameworks");
      out = tempDir(`frameworks-${host.preset}-out`);
      data = tempDir(`frameworks-${host.preset}-data`);
      const result = await buildFixture(root, host.preset, out, { AGENT_UNIT_DATA: data, ...host.env });
      expect(result.adapters.sort()).toEqual(["@langchain/langgraph", "@mastra/core", "@openai/agents", "ai"]);
      deployment = await host.launch(out, root);
    });

    afterAll(async () => {
      await deployment?.stop();
      cleanup(out, data);
    });

    it("discovers each agent with its framework", async () => {
      const manifest = await client().manifest();
      const frameworks = Object.fromEntries(manifest.agents.map((agent) => [agent.name, agent.framework]));
      expect(frameworks).toEqual({
        "ai-sdk": "ai-sdk",
        effects: "agent-unit",
        langgraph: "langgraph",
        mastra: "mastra",
        "openai-agents": "openai-agents",
      });
    });

    for (const testCase of CASES) {
      it(`${testCase.agent}: pauses, survives a restart, and resumes without repeating work`, async () => {
        const first = await collect(client().run(testCase.agent, { prompt: "refund o_42" }));
        const parked = first.at(-1)!;
        expect(parked).toMatchObject({ type: "RUN_INTERRUPTED", interrupt: { name: testCase.interrupt } });

        await deployment.restart();

        const second = await collect(client().resume(parked.runId, { approved: true }));
        expect(second.at(-1)?.type).toBe("RUN_FINISHED");
        const run = await client().get(parked.runId);
        expect(run.status).toBe("completed");
        if (testCase.output) expect(run.output).toBe(testCase.output);
        else expect(JSON.stringify(run.output)).toContain("Refunded o_42.");

        const names = [`refund:${testCase.agent}`, `model:${testCase.agent}`, `plan:${testCase.agent}`, `key:${testCase.agent}`];
        const effects = await collect(client().run("effects", { names }));
        const counts = (effects.at(-1) as { result: Record<string, number | string> }).result;
        expect(counts[`refund:${testCase.agent}`]).toBe(1);
        expect(counts[`model:${testCase.agent}`]).toBe(testCase.model);
        if (testCase.agent === "langgraph") expect(counts["plan:langgraph"]).toBe(1);
        // The side effect saw its idempotency key, on this host too.
        expect(counts[`key:${testCase.agent}`]).toMatch(/^[A-Za-z0-9_-]{32}$/);
      });
    }
  });
}
