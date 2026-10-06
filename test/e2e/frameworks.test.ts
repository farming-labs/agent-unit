import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, collect, createAgentClient, prepareFixture, startServer, tempDir, type RunningServer } from "./helpers";

// Every built-in adapter through a real production bundle: start a run that pauses for approval,
// kill the server, resume on a fresh process, and check that no model call or side effect repeats.

const CASES = [
  { agent: "ai-sdk", framework: "ai-sdk", interrupt: "approve-refund", answer: { approved: true }, output: "Refunded o_42.", model: 2 },
  { agent: "mastra", framework: "mastra", interrupt: "approve-refund", answer: { approved: true }, output: "Refunded o_42.", model: 2 },
  { agent: "openai-agents", framework: "openai-agents", interrupt: "tool-approval", answer: { approved: true }, output: "Refunded o_42.", model: 2 },
  { agent: "langgraph", framework: "langgraph", interrupt: "review", answer: { approved: true }, output: undefined, model: 0 },
];

describe("framework adapters in a node-server build", () => {
  let root: string;
  let out: string;
  let data: string;
  let server: RunningServer;
  const start = () => startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: root });
  const client = () => createAgentClient({ baseUrl: server.url });

  beforeAll(async () => {
    root = prepareFixture("frameworks");
    out = tempDir("frameworks-out");
    data = tempDir("frameworks-data");
    const result = await buildFixture(root, "node-server", out, { AGENT_UNIT_DATA: data });
    expect(result.adapters.sort()).toEqual(["@langchain/langgraph", "@mastra/core", "@openai/agents", "ai"]);
    server = await start();
  });

  afterAll(async () => {
    await server?.stop();
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

      await server.stop();
      server = await start();

      const second = await collect(client().resume(parked.runId, testCase.answer));
      expect(second.at(-1)?.type).toBe("RUN_FINISHED");
      const run = await client().get(parked.runId);
      expect(run.status).toBe("completed");
      if (testCase.output) expect(run.output).toBe(testCase.output);
      else expect(JSON.stringify(run.output)).toContain("Refunded o_42.");

      const names = [`refund:${testCase.agent}`, `model:${testCase.agent}`, `plan:${testCase.agent}`];
      const effects = await collect(client().run("effects", { names }));
      const counts = effects.at(-1) as { result: Record<string, number> };
      expect(counts.result[`refund:${testCase.agent}`]).toBe(1);
      expect(counts.result[`model:${testCase.agent}`]).toBe(testCase.model);
      if (testCase.agent === "langgraph") expect(counts.result["plan:langgraph"]).toBe(1);
    });
  }
});
