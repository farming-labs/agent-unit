import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentFramework } from "../config";

/** Built-in adapters, included when the app depends on their framework. Tried in this order. */
export const BUILTIN_ADAPTERS = [
  { framework: "mastra", entry: "adapters/mastra", exportName: "mastraAdapter", package: "@mastra/core" },
  { framework: "openai-agents", entry: "adapters/openai-agents", exportName: "openAIAgentsAdapter", package: "@openai/agents" },
  { framework: "langgraph", entry: "adapters/langgraph", exportName: "langGraphAdapter", package: "@langchain/langgraph" },
  { framework: "ai-sdk", entry: "adapters/ai-sdk", exportName: "aiSdkAdapter", package: "ai" },
] as const;

export type BuiltinAdapter = (typeof BUILTIN_ADAPTERS)[number];

/**
 * The built-in adapters for frameworks the app's package.json declares. Declared dependencies, not
 * whatever a hoisted node_modules happens to contain, so a server never bundles an SDK it does not use.
 */
export function detectAdapters(root: string, framework?: AgentFramework): BuiltinAdapter[] {
  if (framework !== undefined) {
    const chosen = BUILTIN_ADAPTERS.find((adapter) => adapter.framework === framework);
    if (!chosen) {
      throw new Error(`agent-unit: unknown framework ${JSON.stringify(framework)}. Use one of ${BUILTIN_ADAPTERS.map((adapter) => JSON.stringify(adapter.framework)).join(", ")}.`);
    }
    if (!declares(root, chosen.package)) {
      throw new Error(`agent-unit: framework "${framework}" needs ${chosen.package} in the app's package.json: npm install ${chosen.package}`);
    }
    return [chosen];
  }
  const manifest = join(root, "package.json");
  if (!existsSync(manifest)) return [];
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, Record<string, string> | undefined>;
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  return BUILTIN_ADAPTERS.filter((adapter) => declared.has(adapter.package));
}

function declares(root: string, name: string): boolean {
  const manifest = join(root, "package.json");
  if (!existsSync(manifest)) return false;
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, Record<string, string> | undefined>;
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some((field) => pkg[field]?.[name] !== undefined);
}
