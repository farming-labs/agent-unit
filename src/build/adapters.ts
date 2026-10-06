import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Built-in adapters, included when the app depends on their framework. Tried in this order. */
export const BUILTIN_ADAPTERS = [
  { entry: "adapters/mastra", exportName: "mastraAdapter", package: "@mastra/core" },
  { entry: "adapters/openai-agents", exportName: "openAIAgentsAdapter", package: "@openai/agents" },
  { entry: "adapters/langgraph", exportName: "langGraphAdapter", package: "@langchain/langgraph" },
  { entry: "adapters/ai-sdk", exportName: "aiSdkAdapter", package: "ai" },
] as const;

export type BuiltinAdapter = (typeof BUILTIN_ADAPTERS)[number];

/**
 * The built-in adapters for frameworks the app's package.json declares. Declared dependencies, not
 * whatever a hoisted node_modules happens to contain, so a server never bundles an SDK it does not use.
 */
export function detectAdapters(root: string): BuiltinAdapter[] {
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
