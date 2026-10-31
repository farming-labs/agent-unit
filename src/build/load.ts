import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createJiti } from "jiti";
import { PRESET_SETTINGS, type AgentUnitConfig } from "../config";

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

/**
 * Loads the app's `.env` into `process.env` for runs from source (`agent-unit dev`, `agent-unit task`),
 * as `mastra dev` and `nitro dev` do. Variables already set win. Builds never read it: hosts have
 * their own settings. Returns the names it set.
 */
export function loadEnvFile(root: string): string[] {
  const file = join(root, ".env");
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    loaded.push(key);
  }
  return loaded;
}

/** Engine settings the config sets, at the top level or for a preset (`presets.vercel.storage`). */
function engineSettings(config: AgentUnitConfig): string[] {
  const used: string[] = ENGINE_OPTIONS.filter((key) => config[key] !== undefined);
  for (const [preset, settings] of Object.entries(config.presets ?? {})) {
    for (const key of ENGINE_OPTIONS) if ((settings as Record<string, unknown>)[key] !== undefined) used.push(`presets[${JSON.stringify(preset)}].${key}`);
  }
  return used;
}

const presetKey = (preset: string) => preset.replaceAll("_", "-");

/** Checks `presets`: an object per preset, holding only settings that can differ per preset. */
function checkPresets(config: AgentUnitConfig, configFile: string | undefined) {
  if (config.presets === undefined) return;
  if (!config.presets || typeof config.presets !== "object" || Array.isArray(config.presets)) {
    throw new Error(`${configFile}: \`presets\` maps preset names to settings, e.g. { "cloudflare-module": { runtime: "durable-objects" } }.`);
  }
  const seen = new Map<string, string>();
  for (const [preset, settings] of Object.entries(config.presets)) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${configFile}: \`presets[${JSON.stringify(preset)}]\` must be an object of settings.`);
    const other = seen.get(presetKey(preset));
    if (other !== undefined) throw new Error(`${configFile}: \`presets\` names ${JSON.stringify(other)} and ${JSON.stringify(preset)}, which are the same preset.`);
    seen.set(presetKey(preset), preset);
    const fixed = Object.keys(settings).filter((key) => !(PRESET_SETTINGS as readonly string[]).includes(key));
    if (fixed.length) {
      throw new Error(
        `${configFile}: ${fixed.map((key) => `\`${key}\``).join(", ")} in \`presets[${JSON.stringify(preset)}]\` cannot differ per preset. Settings that can: ${PRESET_SETTINGS.join(", ")}.`,
      );
    }
  }
}

/**
 * The config as built for `preset`: the top-level settings with that preset's entry in `presets`
 * over them, each replacing the top-level value whole. `cloudflare_module` and `cloudflare-module`
 * are the same preset.
 */
export function configForPreset(config: AgentUnitConfig, preset: string): AgentUnitConfig {
  const key = presetEntryKey(config, preset);
  return key === undefined ? config : { ...config, ...config.presets![key] };
}

/** The key in `presets` that holds `preset`'s settings, as the config spells it. */
export function presetEntryKey(config: AgentUnitConfig, preset: string): string | undefined {
  return Object.keys(config.presets ?? {}).find((name) => presetKey(name) === presetKey(preset));
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

/** How a generated file imports Nitro's runtime: `nitro`, `nitro/storage` or `nitro/task`. */
export type NitroImport = (specifier: "nitro" | "nitro/storage" | "nitro/task") => string;

/** The app's Nitro, by name: for files an app's own Nitro builds (the agent-unit/nitro module). */
export const appNitro: NitroImport = (specifier) => JSON.stringify(specifier);

/**
 * agent-unit's own Nitro, by path: for files `agent-unit build` builds with it. Under pnpm the app
 * cannot import Nitro by name, because only agent-unit depends on it. The real path keeps it one
 * module with the copy Nitro's own runtime imports.
 */
export const ownNitro: NitroImport = (specifier) => JSON.stringify(realpathSync(createRequire(import.meta.url).resolve(specifier)));

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
export interface LoadProjectOptions {
  /**
   * A module whose default export is the config, used instead of `agent-unit.config.*`. The built
   * server imports the same module, so its settings still evaluate where the server runs. For tools
   * that hold agent-unit's settings in their own config, such as a framework integration.
   */
  configFile?: string;
}

export async function loadProject(rootDir = process.cwd(), options: LoadProjectOptions = {}): Promise<LoadedProject> {
  const root = resolve(rootDir);
  const configFile = options.configFile ? resolve(root, options.configFile) : findConfigFile(root);
  if (options.configFile && !existsSync(configFile!)) throw new Error(`agent-unit: the config module ${configFile} does not exist.`);
  let config: AgentUnitConfig = {};
  if (configFile) {
    const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
    // A config without a default export (a named one, or an empty file) once read as an empty config,
    // which then failed somewhere unrelated: name the file instead.
    const source = readFileSync(configFile, "utf8");
    if (!/export\s+default\b|export\s*\{[^}]*\bas\s+default\b|module\.exports\b/.test(source)) {
      throw new Error(`${relative(root, configFile) || configFile} has no default export: export default defineConfig({ ... }).`);
    }
    const loaded = await jiti.import<AgentUnitConfig | { default: AgentUnitConfig }>(configFile);
    config = ((loaded as { default?: AgentUnitConfig }).default ?? loaded) as AgentUnitConfig;
    if (!config || typeof config !== "object") throw new Error(`${configFile} must export a config object (export default defineConfig({ ... })).`);
  }
  checkPresets(config, configFile);
  let name = config.name;
  if (!name && existsSync(join(root, "package.json"))) {
    name = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string }).name;
  }
  // A Mastra app (src/mastra/index.ts) with neither agents nor engine settings needs no config at all:
  // it is built as Mastra's own server, as `server: mastra()` would.
  if (config.server === undefined && !config.agents && MASTRA_ENTRIES.some((file) => existsSync(join(root, file)))) {
    const engineOnly = engineSettings(config);
    if (!engineOnly.length && Object.keys(scanAgents(resolve(root, config.agentsDir ?? "agents"))).length === 0) {
      const { mastra } = await import("../presets/mastra");
      config = { ...config, server: mastra() };
    }
  }
  if (config.server !== undefined) {
    const server = config.server as unknown;
    const preset = typeof server === "object" && server !== null && typeof (server as { name?: unknown }).name === "string" && typeof (server as { entry?: unknown }).entry === "function";
    if ((typeof server !== "string" || !server) && !preset) {
      throw new Error(`${configFile}: \`server\` must be the path of your server file, e.g. "./src/server.ts", or a framework preset such as mastra().`);
    }
    // With its own server the app's framework owns runs, storage and routes; engine settings would be ignored silently.
    const engineOnly = engineSettings(config);
    if (engineOnly.length) {
      throw new Error(
        `${configFile}: ${engineOnly.map((key) => `\`${key}\``).join(", ")} configure agent-unit's engine, which does not run when \`server\` is set. Remove them, or remove \`server\` to serve your agents with the engine.`,
      );
    }
    return { root, name: name ?? basename(root), configFile, config, agentFiles: {} };
  }
  const agentFiles = config.agents ? {} : scanAgents(resolve(root, config.agentsDir ?? "agents"));
  if (!config.agents && Object.keys(agentFiles).length === 0) {
    // A Mastra app that also sets engine settings: say which ones keep it from being built as Mastra's server.
    if (MASTRA_ENTRIES.some((file) => existsSync(join(root, file)))) {
      const engineOnly = engineSettings(config);
      throw new Error(
        `No agents found, but this looks like a Mastra app. agent-unit builds Mastra's own server on its own unless the config sets agent-unit's engine settings (${engineOnly.map((key) => `\`${key}\``).join(", ")}); remove them, or set \`server: mastra()\` to choose explicitly.`,
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
export async function resolveServer(project: LoadedProject, genDir: string, preset: string): Promise<{ file: string; label: string; alias?: Record<string, string> }> {
  const server = project.config.server;
  if (!server) throw new Error("agent-unit: this app has no `server`.");
  if (typeof server === "string") {
    const file = resolve(project.root, server);
    if (!existsSync(file)) throw new Error(`agent-unit: the server file "${server}" does not exist.`);
    return { file, label: server };
  }
  mkdirSync(genDir, { recursive: true });
  const result = await server.entry({ root: project.root, genDir, preset });
  const { file, alias } = typeof result === "string" ? { file: result, alias: undefined } : (result ?? { file: undefined, alias: undefined });
  if (typeof file !== "string" || !existsSync(file)) throw new Error(`agent-unit: the ${server.name} preset returned "${String(file)}", which does not exist.`);
  return { file, label: server.name, ...(alias ? { alias } : {}) };
}
