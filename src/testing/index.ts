import { createStorage } from "unstorage";
import memory from "unstorage/drivers/memory";
import type { AgentAdapter } from "../adapter/types";
import { createAgentUnit, type AgentUnitOptions } from "../server/app";
import type { AgentEvent, RunInput, RunRecord } from "../types";

export interface TestUnitOptions extends Partial<Omit<AgentUnitOptions, "agents">> {
  adapters?: AgentAdapter<any>[];
}

/**
 * An in-memory agent-unit for tests: start runs, answer interrupts and inspect events without a server.
 * Pass the same `storage` to a second test unit to simulate a restart.
 */
export function createTestUnit(agents: Record<string, unknown>, options: TestUnitOptions = {}) {
  const storage = options.storage ?? createStorage({ driver: memory() });
  const unit = createAgentUnit({ ...options, agents, storage });
  const { engine } = unit;

  async function events(runId: string, after = 0): Promise<AgentEvent[]> {
    const list: AgentEvent[] = [];
    for await (const event of engine.events(runId, after)) list.push(event);
    return list;
  }

  return {
    ...unit,
    storage,
    /** Starts a run and waits until it finishes or parks. */
    async run(agent: string, input: RunInput = {}, init: { threadId?: string } = {}): Promise<RunRecord> {
      const { run, done } = await engine.start(agent, input, init);
      return (await done) ?? engine.getRun(run.id);
    },
    /** Answers the pending interrupt and waits until the run finishes or parks again. */
    async resume(runId: string, answer: unknown): Promise<RunRecord> {
      const { done } = await engine.resume(runId, answer);
      return (await done) ?? engine.getRun(runId);
    },
    events,
  };
}
