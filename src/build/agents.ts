import { createJiti } from "jiti";
import type { AgentAdapter } from "../adapter/types";
import { functionAdapter, resolveAgent } from "../agents";
import type { Manifest } from "../types";
import { detectAdapters, type BuiltinAdapter } from "./adapters";
import type { LoadedProject } from "./load";

// Literal imports, so the package build keeps each adapter as its own chunk.
const ADAPTER_MODULES: Record<BuiltinAdapter["entry"], () => Promise<Record<string, unknown>>> = {
  "adapters/ai-sdk": () => import("../adapters/ai-sdk"),
  "adapters/mastra": () => import("../adapters/mastra"),
  "adapters/langgraph": () => import("../adapters/langgraph"),
  "adapters/openai-agents": () => import("../adapters/openai-agents"),
};

/** Imports the project's agents from source and the adapters for the frameworks it declares. */
export async function loadAgents(project: LoadedProject): Promise<{ agents: Record<string, unknown>; adapters: AgentAdapter<any>[] }> {
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
  const agents: Record<string, unknown> = { ...(project.config.agents ?? {}) };
  for (const [name, file] of Object.entries(project.agentFiles)) agents[name] = await jiti.import(file);
  const adapters: AgentAdapter<any>[] = [...(project.config.adapters ?? [])];
  for (const builtin of detectAdapters(project.root)) {
    adapters.push((await ADAPTER_MODULES[builtin.entry]())[builtin.exportName] as AgentAdapter<any>);
  }
  return { agents, adapters };
}

/** The manifest the built server will serve at /manifest.json. */
export async function buildManifest(project: LoadedProject): Promise<Manifest> {
  const { agents, adapters } = await loadAgents(project);
  const all = [...adapters, functionAdapter];
  return { version: 1, name: project.name, agents: Object.entries(agents).map(([name, agent]) => resolveAgent(name, agent, all).card) };
}
