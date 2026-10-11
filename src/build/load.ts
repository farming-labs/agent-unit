import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
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

/** Where Mastra's CLI keeps the app's Mastra instance. */
export const MASTRA_ENTRIES = ["src/mastra/index.ts", "src/mastra/index.js", "src/mastra/index.mts", "src/mastra/index.mjs"];

/** Settings that only agent-unit's engine reads. */
const ENGINE_OPTIONS = [
  "agents",
  "agentsDir",
  "adapters",
  "storage",
  "runtime",
  "budget",
  "retention",
  "sweep",
  "basePath",
  "authorize",
  "origin",
  "maxBodyBytes",
] as const satisfies readonly (keyof AgentUnitConfig)[];

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

/** A relative import specifier from `from` (a directory) to `file`, with forward slashes. */
export const toImport = (from: string, file: string) => {
  const path = relative(from, file).replaceAll("\\", "/");
  return JSON.stringify(path.startsWith(".") ? path : `./${path}`);
};

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

/** Loads `agent-unit.config.*` and discovers agents. Always re-evaluates, so dev reloads and repeated builds see edits and env. */
export async function loadProject(rootDir = process.cwd()): Promise<LoadedProject> {
  const root = resolve(rootDir);
  const configFile = findConfigFile(root);
  let config: AgentUnitConfig = {};
  if (configFile) {
    const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
    const loaded = await jiti.import<AgentUnitConfig | { default: AgentUnitConfig }>(configFile);
    config = ((loaded as { default?: AgentUnitConfig }).default ?? loaded) as AgentUnitConfig;
    if (!config || typeof config !== "object") throw new Error(`${configFile} must export a config object (export default defineConfig({ ... })).`);
  }
  let name = config.name;
  if (!name && existsSync(join(root, "package.json"))) {
    name = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string }).name;
  }
  if (config.server !== undefined) {
    const server = config.server as unknown;
    const preset = typeof server === "object" && server !== null && typeof (server as { name?: unknown }).name === "string" && typeof (server as { entry?: unknown }).entry === "function";
    if ((typeof server !== "string" || !server) && !preset) {
      throw new Error(`${configFile}: \`server\` must be the path of your server file, e.g. "./src/server.ts", or a framework preset such as mastra().`);
    }
    // With its own server the app's framework owns runs, storage and routes; engine settings would be ignored silently.
    const engineOnly = ENGINE_OPTIONS.filter((key) => config[key] !== undefined);
    if (engineOnly.length) {
      throw new Error(
        `${configFile}: ${engineOnly.map((key) => `\`${key}\``).join(", ")} configure agent-unit's engine, which does not run when \`server\` is set. Remove them, or remove \`server\` to serve your agents with the engine.`,
      );
    }
    return { root, name: name ?? basename(root), configFile, config, agentFiles: {} };
  }
  const agentFiles = config.agents ? {} : scanAgents(resolve(root, config.agentsDir ?? "agents"));
  if (!config.agents && Object.keys(agentFiles).length === 0) {
    // A Mastra app keeps its instance in src/mastra/index.ts; point at the preset rather than at agents/.
    if (MASTRA_ENTRIES.some((file) => existsSync(join(root, file)))) {
      throw new Error(
        `No agents found, but this looks like a Mastra app. To build Mastra's own server, set \`server: mastra()\` (import { mastra } from "agent-unit/presets/mastra") in agent-unit.config.ts.`,
      );
    }
    throw new Error(
      `No agents found. Add modules to ${resolve(root, config.agentsDir ?? "agents")}, list them in agent-unit.config.ts, or set \`server\` to your own server file.`,
    );
  }
  return { root, name: name ?? basename(root), configFile, config, agentFiles };
}

/**
 * The app's own server module (`server` in the config): its file, or the one its framework preset
 * writes into `genDir`. `label` names it in build and dev output.
 */
export async function resolveServer(project: LoadedProject, genDir: string, preset: string): Promise<{ file: string; label: string }> {
  const server = project.config.server;
  if (!server) throw new Error("agent-unit: this app has no `server`.");
  if (typeof server === "string") {
    const file = resolve(project.root, server);
    if (!existsSync(file)) throw new Error(`agent-unit: the server file "${server}" does not exist.`);
    return { file, label: server };
  }
  mkdirSync(genDir, { recursive: true });
  const file = await server.entry({ root: project.root, genDir, preset });
  if (typeof file !== "string" || !existsSync(file)) throw new Error(`agent-unit: the ${server.name} preset returned "${String(file)}", which does not exist.`);
  return { file, label: server.name };
}
