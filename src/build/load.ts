import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { AgentUnitConfig } from "../config";

const CONFIG_NAMES = ["agent-unit.config.ts", "agent-unit.config.mts", "agent-unit.config.js", "agent-unit.config.mjs"];
const AGENT_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs", ".tsx", ".jsx"]);

export interface LoadedProject {
  root: string;
  name: string;
  configFile?: string;
  config: AgentUnitConfig;
  /** Agent modules found in `agentsDir`, by name. Empty when the config lists `agents`. */
  agentFiles: Record<string, string>;
}

/** The installed agent-unit package root, whether running from `dist/` or from source. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "agent-unit") return dir;
    dir = dirname(dir);
  }
  throw new Error("Could not locate the agent-unit package.");
}

/** Absolute path to a built agent-unit entry, e.g. `server` or `adapters/ai-sdk`. */
export function distEntry(entry: string): string {
  const file = join(packageRoot(), "dist", `${entry}.mjs`);
  if (!existsSync(file)) throw new Error(`agent-unit is not built: ${file} is missing. Run the package build first.`);
  return file;
}

export function findConfigFile(root: string): string | undefined {
  for (const name of CONFIG_NAMES) {
    const file = join(root, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

function scanAgents(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const agents: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    let file: string | undefined;
    let name: string | undefined;
    if (entry.isFile()) {
      const ext = extname(entry.name);
      if (!AGENT_EXTENSIONS.has(ext) || entry.name.endsWith(`.d${ext}`) || /\.(test|spec)\./.test(entry.name)) continue;
      file = join(dir, entry.name);
      name = basename(entry.name, ext);
    } else if (entry.isDirectory()) {
      // agents/support/index.ts serves as "support".
      for (const ext of AGENT_EXTENSIONS) {
        const index = join(dir, entry.name, `index${ext}`);
        if (existsSync(index)) {
          file = index;
          name = entry.name;
          break;
        }
      }
    }
    if (!file || !name || name.startsWith("_") || name.startsWith(".")) continue;
    if (!/^[a-zA-Z0-9][\w-]*$/.test(name)) throw new Error(`Agent file "${file}" needs a name of letters, digits, "-" and "_".`);
    if (agents[name]) throw new Error(`Two agent modules are named "${name}": ${agents[name]} and ${file}.`);
    agents[name] = file;
  }
  return agents;
}

/** Loads `agent-unit.config.*` and discovers agents. `fresh` bypasses the module cache (dev reloads). */
export async function loadProject(rootDir = process.cwd(), options: { fresh?: boolean } = {}): Promise<LoadedProject> {
  const root = resolve(rootDir);
  const configFile = findConfigFile(root);
  let config: AgentUnitConfig = {};
  if (configFile) {
    const jiti = createJiti(import.meta.url, { moduleCache: !options.fresh, fsCache: false });
    const loaded = await jiti.import<AgentUnitConfig | { default: AgentUnitConfig }>(configFile);
    config = ((loaded as { default?: AgentUnitConfig }).default ?? loaded) as AgentUnitConfig;
    if (!config || typeof config !== "object") throw new Error(`${configFile} must export a config object (export default defineConfig({ ... })).`);
  }
  let name = config.name;
  if (!name && existsSync(join(root, "package.json"))) {
    name = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string }).name;
  }
  const agentFiles = config.agents ? {} : scanAgents(resolve(root, config.agentsDir ?? "agents"));
  if (!config.agents && Object.keys(agentFiles).length === 0) {
    throw new Error(`No agents found. Add modules to ${resolve(root, config.agentsDir ?? "agents")} or list them in agent-unit.config.ts.`);
  }
  return { root, name: name ?? basename(root), configFile, config, agentFiles };
}
