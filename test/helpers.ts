import { createStorage } from "unstorage";
import memory from "unstorage/drivers/memory";
import { functionAdapter, resolveAgent } from "../src/agents";
import type { AgentAdapter } from "../src/adapter/types";
import { aiSdkAdapter } from "../src/adapters/ai-sdk";
import { RunEngine, type EngineOptions } from "../src/runtime/engine";
import { RunStore } from "../src/runtime/store";
import type { AgentEvent } from "../src/types";

export const defaultAdapters: AgentAdapter<any>[] = [functionAdapter, aiSdkAdapter];

export function memoryStore() {
  return new RunStore(createStorage({ driver: memory() }));
}

export function createEngine(
  agents: Record<string, unknown>,
  options: Partial<EngineOptions> = {},
  adapters = defaultAdapters,
) {
  return new RunEngine({
    store: options.store ?? memoryStore(),
    agents: Object.entries(agents).map(([name, agent]) => resolveAgent(name, agent, adapters)),
    ...options,
  });
}

export async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

export const types = (events: AgentEvent[]) => events.map((event) => event.type);
