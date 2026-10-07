import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createJiti } from "jiti";
import { validateAdapter } from "../adapter/types";
import { BUILTIN_ADAPTERS } from "./adapters";
import { findConfigFile } from "./load";

// `agent-unit add <package>`: install an adapter package and register it in agent-unit.config.ts,
// the way `astro add` and `nuxt module add` do. The result is plain, explicit config: an import and
// an entry in `adapters`, which the user can read and edit like any other line.

export interface AddOptions {
  root?: string;
  packages: string[];
  /** Skip the confirmation. Required when there is no terminal to ask in. */
  yes?: boolean;
  /** Install missing packages with the project's package manager. Default true. */
  install?: boolean;
  logger?: { info(message: string): void; warn(message: string): void };
}

export interface AddedAdapter {
  package: string;
  /** False when the config already had it. */
  changed: boolean;
  /** The adapter's framework name. */
  name: string;
  /** The import line and the `adapters` entry. */
  importLine: string;
  entry: string;
}

export interface AddResult {
  added: AddedAdapter[];
  /** Frameworks agent-unit supports out of the box: nothing to add. */
  builtin: string[];
  configFile?: string;
  /** Set when the config could not be edited safely: the lines to add by hand. */
  manual?: string;
}

const BUILTIN_ALIASES: Record<string, string> = {
  mastra: "@mastra/core",
  langgraph: "@langchain/langgraph",
  "openai-agents": "@openai/agents",
  "ai-sdk": "ai",
};

/** A readable local name for an adapter package: `agent-unit-adapter-tiny` → `tinyAdapter`, `@acme/agent-unit` → `acmeAdapter`. */
export function adapterIdentifier(pkg: string): string {
  const [scope, name = ""] = pkg.startsWith("@") ? pkg.slice(1).split("/") : ["", pkg];
  const base = name.replace(/^agent-unit-adapter-|^agent-unit-|-agent-unit$|^agent-unit$/g, "") || scope || "custom";
  const camel = base.replace(/[^a-zA-Z0-9]+(.)?/g, (_, next: string | undefined) => (next ? next.toUpperCase() : "")).replace(/^[0-9]/, "_$&");
  return `${camel.charAt(0).toLowerCase()}${camel.slice(1)}Adapter`;
}

function packageManager(root: string): { name: string; add: string[]; remove: string[] } {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return { name: "pnpm", add: ["pnpm", "add"], remove: ["pnpm", "remove"] };
    if (existsSync(join(dir, "yarn.lock"))) return { name: "yarn", add: ["yarn", "add"], remove: ["yarn", "remove"] };
    if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return { name: "bun", add: ["bun", "add"], remove: ["bun", "remove"] };
    if (existsSync(join(dir, "package-lock.json")) || dirname(dir) === dir) return { name: "npm", add: ["npm", "install"], remove: ["npm", "uninstall"] };
  }
}

const run = (root: string, [command, ...args]: string[]) =>
  spawnSync(command!, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" }).status === 0;

/**
 * Loads an adapter package and finds its adapter: by convention the default export, a function
 * returning the adapter (or the adapter itself). A named export ending in `Adapter` also works.
 */
async function loadAdapter(root: string, pkg: string): Promise<{ name: string; exportName: string; call: boolean }> {
  const jiti = createJiti(join(root, "package.json"), { moduleCache: false, fsCache: false });
  const mod = (await jiti.import(pkg)) as Record<string, unknown>;
  const candidates: [string, unknown][] = [
    ["default", mod.default],
    ...Object.entries(mod).filter(([key]) => key !== "default" && /adapter$/i.test(key)),
  ];
  const problems: string[] = [];
  for (const [exportName, value] of candidates) {
    if (value === undefined) continue;
    try {
      const call = typeof value === "function";
      const label = call ? `What ${pkg}'s ${exportName} export returned` : `${pkg}'s ${exportName} export`;
      const adapter = validateAdapter(call ? (value as () => unknown)() : value, label);
      return { name: adapter.name, exportName, call };
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    `${pkg} does not export an agent-unit adapter. Adapter packages export a function returning the adapter as their default export.${problems.length ? `\n  ${problems.join("\n  ")}` : ""}`,
  );
}

const IMPORT = /^import\s[^;]*?["'][^"'\n]+["'];?[^\S\n]*$/gm;

/**
 * Adds an import and an `adapters` entry to a config file's source. Returns undefined when the
 * config has a shape it cannot edit safely (the caller then prints the lines to add by hand).
 */
export function addToConfigSource(source: string, importLine: string, entry: string, pkg: string): string | undefined {
  let next = source;
  const alreadyImported = new RegExp(`from\\s+["']${pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']`).test(next);
  if (!alreadyImported) {
    const imports = [...next.matchAll(IMPORT)];
    const last = imports.at(-1);
    next = last ? `${next.slice(0, last.index! + last[0].length)}\n${importLine}${next.slice(last.index! + last[0].length)}` : `${importLine}\n${next}`;
  }
  if (next.includes(entry)) return next;
  const list = /adapters\s*:\s*\[/.exec(next);
  if (list) {
    const at = list.index + list[0].length;
    const empty = /^\s*\]/.test(next.slice(at));
    return `${next.slice(0, at)}${entry}${empty ? "" : ", "}${next.slice(at)}`;
  }
  const object = /(?:defineConfig\(\s*\{|export\s+default\s+\{)/.exec(next);
  if (!object) return undefined;
  const at = object.index + object[0].length;
  const rest = next.slice(at);
  // An empty object closes on its own line after the new entry.
  return `${next.slice(0, at)}\n  adapters: [${entry}],${/^\s*\}/.test(rest) ? `\n${rest.trimStart()}` : rest}`;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} (Y/n) `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** Installs adapter packages and registers them in agent-unit.config.ts. */
export async function addAdapters(options: AddOptions): Promise<AddResult> {
  const logger = options.logger ?? { info: console.log, warn: console.warn };
  const root = resolve(options.root ?? ".");
  const manifestFile = join(root, "package.json");
  if (!existsSync(manifestFile)) throw new Error(`No package.json in ${root}. Run agent-unit add in your app's directory.`);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, Record<string, string> | undefined>;
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);

  const builtin: string[] = [];
  const wanted: string[] = [];
  for (const name of options.packages) {
    const framework = BUILTIN_ALIASES[name] ?? name;
    if (BUILTIN_ADAPTERS.some((adapter) => adapter.package === framework)) {
      builtin.push(framework);
      logger.info(`${framework} is supported out of the box: install it in your app and agent-unit detects it. Nothing to add.`);
    } else wanted.push(name);
  }
  if (!wanted.length) return { added: [], builtin };

  const configFile = findConfigFile(root);
  const target = configFile ?? join(root, "agent-unit.config.ts");
  const toInstall = wanted.filter((pkg) => !declared.has(pkg));
  const manager = packageManager(root);
  const plan = [
    ...(toInstall.length && options.install !== false ? [`install ${toInstall.join(", ")} with ${manager.name}`] : []),
    `${configFile ? "update" : "create"} ${relative(root, target) || target} to use ${wanted.join(", ")}`,
  ];
  if (!options.yes) {
    if (!process.stdin.isTTY) throw new Error(`agent-unit add would ${plan.join(", then ")}. Run it again with --yes to go ahead.`);
    if (!(await confirm(`agent-unit add will ${plan.join(", then ")}. Continue?`))) return { added: [], builtin, configFile };
  }

  const installed = toInstall.length && options.install !== false ? toInstall : [];
  if (installed.length && !run(root, [...manager.add, ...installed])) throw new Error(`${manager.add.join(" ")} ${installed.join(" ")} failed.`);

  const added: AddedAdapter[] = [];
  let source = configFile ? readFileSync(configFile, "utf8") : `import { defineConfig } from "agent-unit";\n\nexport default defineConfig({});\n`;
  const manual: string[] = [];
  for (const pkg of wanted) {
    let found: Awaited<ReturnType<typeof loadAdapter>>;
    try {
      found = await loadAdapter(root, pkg);
    } catch (error) {
      // Not an adapter: take back what this command installed, so a typo leaves nothing behind.
      if (installed.length && run(root, [...manager.remove, ...installed])) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n  Uninstalled ${installed.join(", ")} again.`);
      }
      throw error;
    }
    let local = adapterIdentifier(pkg);
    for (let n = 2; new RegExp(`\\b${local}\\b`).test(source) && !source.includes(`from "${pkg}"`); n++) local = `${adapterIdentifier(pkg)}${n}`;
    const importLine =
      found.exportName === "default"
        ? `import ${local} from "${pkg}";`
        : `import { ${found.exportName === local ? local : `${found.exportName} as ${local}`} } from "${pkg}";`;
    const entry = found.call ? `${local}()` : local;
    const next = addToConfigSource(source, importLine, entry, pkg);
    if (next === undefined) manual.push(`${importLine}\n// in defineConfig({ ... }):\nadapters: [${entry}],`);
    added.push({ package: pkg, changed: next !== undefined && next !== source, name: found.name, importLine, entry });
    if (next !== undefined) source = next;
  }
  if (manual.length) {
    const text = manual.join("\n\n");
    logger.warn(`Could not edit ${relative(root, target)} safely. Add these lines yourself:\n\n${text}\n`);
    return { added, builtin, configFile: target, manual: text };
  }
  if (added.some((adapter) => adapter.changed)) writeFileSync(target, source);
  for (const adapter of added) {
    logger.info(
      adapter.changed
        ? `Added the ${adapter.name} adapter (${adapter.package}) to ${relative(root, target)}.`
        : `The ${adapter.name} adapter (${adapter.package}) is already in ${relative(root, target)}.`,
    );
  }
  return { added, builtin, configFile: target };
}
