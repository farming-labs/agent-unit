import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Built-in adapters, included when their framework is installed in the app. */
export const BUILTIN_ADAPTERS = [
  { entry: "adapters/ai-sdk", exportName: "aiSdkAdapter", package: "ai" },
] as const;

export type BuiltinAdapter = (typeof BUILTIN_ADAPTERS)[number];

function isInstalled(root: string, name: string): boolean {
  let dir = root;
  while (true) {
    if (existsSync(join(dir, "node_modules", name, "package.json"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** The built-in adapters whose frameworks the app has installed, in match order. */
export function detectAdapters(root: string): BuiltinAdapter[] {
  return BUILTIN_ADAPTERS.filter((adapter) => isInstalled(root, adapter.package));
}
