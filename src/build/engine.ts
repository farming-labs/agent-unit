import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseDuration } from "@agent-unit/runtime/runtime";
import { builtinDriverDependencies, builtinDrivers } from "unstorage";
import type { StorageConfig } from "../config";
import { buildManifest } from "./agents";
import { detectAdapters } from "./adapters";
import { appNitro, distEntry, ownNitro, presetEntryKey, toImport, type LoadedProject, type NitroImport } from "./load";
import { checkSchedule, sweepScheduled } from "./schedule";

// agent-unit's own engine as the server: the agents/ folder, the /runs API, run storage, the sweep and
// the Durable Objects runtime. Loaded only when the app does not bring its own `server`.

/** Presets that run as one long-lived process, where a local filesystem and timers are durable enough. */
const SERVER_PRESETS = /^(node|node-server|node-cluster|node-middleware|bun|deno-server)$/;

/** Default time budget per invocation, under each platform's limit for work after the response. */
const PRESET_BUDGETS: [RegExp, string][] = [
  [/^cloudflare/, "25s"],
  [/^vercel/, "240s"],
  [/^netlify/, "20s"],
  [/^aws-(lambda|amplify)/, "25s"],
  [/^azure/, "200s"],
  [/^deno-deploy/, "50s"],
];

export const DEFAULT_STORAGE: StorageConfig = { driver: "fs-lite", base: ".data/agent-unit", atomic: true };

/** Filesystem drivers write atomically (temp file and rename), so a crash never leaves a torn record. */
export function withSafeDefaults(storage: StorageConfig): StorageConfig {
  return /^(fs|fs-lite)$/.test(storage.driver) && storage.atomic === undefined ? { ...storage, atomic: true } : storage;
}

export function resolvePreset(project: LoadedProject, preset?: string): string {
  return preset ?? project.config.preset ?? process.env.NITRO_PRESET ?? "node-server";
}

export function resolveBudget(project: LoadedProject, preset: string): number | undefined {
  const budget = project.config.budget;
  if (budget === false) return undefined;
  if (budget !== undefined) return parseDuration(budget);
  const match = PRESET_BUDGETS.find(([pattern]) => pattern.test(preset));
  return match ? parseDuration(match[1]) : undefined;
}

export function resolveStorage(project: LoadedProject, preset: string, warn: (message: string) => void): StorageConfig {
  if (project.config.storage) return withSafeDefaults(project.config.storage);
  if (SERVER_PRESETS.test(preset)) return DEFAULT_STORAGE;
  warn(
    `The "${preset}" preset has no durable local disk, so runs would be lost between invocations. ` +
      `Set \`storage\` in agent-unit.config.ts to a shared driver (upstash, redis, cloudflare-kv-binding, netlify-blobs, ...). Using memory for now.`,
  );
  return { driver: "memory" };
}

/** Whether `name` is installed where the app resolves packages. */
function installed(root: string, name: string): boolean {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", name, "package.json"))) return true;
    if (dir === dirname(dir)) return false;
  }
}

/**
 * The code that mounts run storage when the server starts. Only the driver is chosen at build; its
 * options come from agent-unit.config.ts as it evaluates where the server runs, so a URL or token the
 * config reads from the environment is read there and never written into the build (Nitro's own
 * storage mounts serialize their options into the output).
 */
function storageMount(project: LoadedProject, dir: string, storage: StorageConfig): { imports: string[]; code: string } {
  const name = storage.driver;
  const builtin = (builtinDrivers as Record<string, string>)[name];
  // agent-unit's own unstorage, which an app on a strict package manager may not resolve itself.
  const module = builtin ? toImport(dir, createRequire(import.meta.url).resolve(builtin)) : /^[./]/.test(name) ? toImport(dir, resolve(project.root, name)) : JSON.stringify(name);
  const libs = Object.entries((builtinDriverDependencies as Record<string, Record<string, { name: string; import?: string; optional?: boolean }>>)[name] ?? {})
    .filter(([option, dep]) => (option === "lib" || option.endsWith("Lib")) && (storage as Record<string, unknown>)[option] === undefined && !dep.optional)
    .map(([option, dep]) => {
      if (!installed(project.root, dep.name)) throw new Error(`agent-unit: the "${name}" storage driver needs ${dep.name}. Install it in your app: npm install ${dep.name}`);
      return `${option}: () => import(${JSON.stringify(dep.import ?? dep.name)}), `;
    });
  // With no storage in the config, the build's default for this host (disk or memory) applies.
  const fallback = project.config.storage ? "undefined" : JSON.stringify(storage);
  const defaults = /^(fs|fs-lite)$/.test(name) ? "atomic: true, " : "";
  return {
    imports: [`import storageDriver from ${module};`],
    code: `// Run storage, from the config as it evaluates here: a URL or token it reads from the environment
// is read where the server runs, never written into the build.
const storageConfig = settings.storage ?? ${fallback};
if (storageConfig?.driver !== ${JSON.stringify(name)}) {
  throw new Error(\`agent-unit: this build keeps runs in ${JSON.stringify(name)} storage, but agent-unit.config.ts chooses "\${storageConfig?.driver}" where it runs. Give the build and the server the same environment, or set storage per host with presets.\`);
}
const { driver: _driver, ...storageOptions } = storageConfig;
${
      name === "upstash"
        ? `// Upstash's own names, or the ones Vercel gives an Upstash database from its Marketplace (as
// Upstash's SDK reads them). Without either, the first run fails deep in a request; say what is missing.
const upstashEnv = globalThis.process?.env ?? {};
storageOptions.url ||= upstashEnv.UPSTASH_REDIS_REST_URL || upstashEnv.KV_REST_API_URL;
storageOptions.token ||= upstashEnv.UPSTASH_REDIS_REST_TOKEN || upstashEnv.KV_REST_API_TOKEN;
if (!storageOptions.url || !storageOptions.token) {
  throw new Error("agent-unit: runs are kept in Upstash here, but UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not set (nor Vercel's KV_REST_API_URL and KV_REST_API_TOKEN). Set them in the host's environment (or url and token in agent-unit.config.ts).");
}
`
        : ""
    }// Mounted once: a dev server that loads this module again keeps the mount it has.
if (useStorage().getMount("agent-unit:").base !== "agent-unit:") {
  useStorage().mount("agent-unit", storageDriver({ ${defaults}${libs.join("")}...storageOptions }));
}
`,
  };
}

/** Writes the Nitro server entry, the shared runtime module and the sweep task into `dir`. */
export function generateEntry(
  project: LoadedProject,
  dir: string,
  options: {
    budgetMs?: number;
    basePath?: string;
    runtime?: "default" | "durable-objects";
    /** The preset being built, whose entry in `presets` applies over the top-level settings. */
    preset?: string;
    /** Run storage to mount at startup; left out when the app mounts `agent-unit` storage itself. */
    storage?: StorageConfig;
    /** How the files import Nitro: the app's by name (the default), or agent-unit's own. */
    nitro?: NitroImport;
  },
) {
  const nitro = options.nitro ?? appNitro;
  mkdirSync(dir, { recursive: true });
  const adapters = detectAdapters(project.root, project.config.framework);
  const durable = options.runtime === "durable-objects";
  const imports = [
    durable
      ? `import { createDurableAgentUnit } from ${JSON.stringify(distEntry("cloudflare"))};`
      : `import { createAgentUnit } from ${JSON.stringify(distEntry("server"))};`,
    ...(durable
      ? []
      : [
          `import { useStorage } from ${nitro("nitro/storage")};`,
          `import { RunStore } from ${JSON.stringify(distEntry("runtime"))};`,
          `import { redisCoordination } from ${JSON.stringify(distEntry("redis"))};`,
        ]),
    ...adapters.map((adapter) => `import { ${adapter.exportName} } from ${JSON.stringify(distEntry(adapter.entry))};`),
  ];
  imports.push(project.configFile ? `import configExport from ${toImport(dir, project.configFile)};` : `const configExport = {};`);
  const mount = !durable && options.storage ? storageMount(project, dir, options.storage) : undefined;
  if (mount) imports.push(...mount.imports);
  // The config evaluates where the server runs; the built preset's entry applies over it, as at build.
  const presetEntry = options.preset === undefined ? undefined : presetEntryKey(project.config, options.preset);
  const settingsLine = `const settings = ${presetEntry === undefined ? "config" : `{ ...config, ...config.presets?.[${JSON.stringify(presetEntry)}] }`};`;
  const agentEntries = Object.entries(project.agentFiles).map(([name, file], index) => {
    imports.push(`import * as agent$${index} from ${toImport(dir, file)};`);
    return `  ${JSON.stringify(name)}: agent$${index},`;
  });

  const agentsBlock = `config.agents ?? {
${agentEntries.join("\n")}
  }`;
  const adapterList = `[...(config.adapters ?? []), ${adapters.map((adapter) => adapter.exportName).join(", ")}]`;
  const basePath = options.basePath === undefined ? "settings.basePath" : JSON.stringify(options.basePath);

  if (durable) {
    writeFileSync(
      join(dir, "runtime.mjs"),
      `// Generated by agent-unit. Do not edit.
${imports.join("\n")}

const config = typeof configExport === "function" ? configExport() : configExport;
${settingsLine}

// Every run gets its own Durable Object; see agent-unit/cloudflare.
export const unit = createDurableAgentUnit({
  name: config.name ?? ${JSON.stringify(project.name)},
  agents: ${agentsBlock},
  adapters: ${adapterList},
  budget: ${options.budgetMs ?? "false"},
  basePath: ${basePath},
  authorize: settings.authorize,
  retention: settings.retention,
  maxBodyBytes: settings.maxBodyBytes,
});
`,
    );
    // Durable Object classes must be exported from the Worker's main module.
    writeFileSync(
      join(dir, "durable.mjs"),
      `// Generated by agent-unit. Do not edit.
import { unit } from "./runtime.mjs";

export const AgentUnitRun = unit.AgentUnitRun;
export const AgentUnitIndex = unit.AgentUnitIndex;
`,
    );
    writeFileSync(
      join(dir, "entry.mjs"),
      `// Generated by agent-unit. Do not edit.
import { defineHandler } from ${nitro("nitro")};
import { unit } from "./runtime.mjs";

export default defineHandler((event) =>
  unit.fetch(event.req, event.req.runtime?.cloudflare?.env ?? globalThis.__env__, {
    waitUntil: (promise) => event.req.waitUntil?.(promise),
  }),
);
`,
    );
    return { adapters: adapters.map((adapter) => adapter.package) };
  }

  writeFileSync(
    join(dir, "runtime.mjs"),
    `// Generated by agent-unit. Do not edit.
${imports.join("\n")}

// The engine starts with the server, so a bad setting fails at startup. A config module may export a
// function instead, called when the engine is first used: a framework that evaluates its own config
// as its server starts hands the settings over by then.
let current = typeof configExport === "function" ? undefined : createUnit(configExport);
/** agent-unit's engine. */
export function getUnit() {
  return (current ??= createUnit(configExport()));
}

function createUnit(config) {
${settingsLine}
${mount?.code ?? ""}
// On Redis, runs and leases change atomically, so two instances never overwrite each other.
const storageView = useStorage("agent-unit");
const mounted = useStorage().getMount("agent-unit:")?.driver;
const storage = mounted?.name === "redis" && typeof mounted.getInstance === "function"
  ? new RunStore(storageView, redisCoordination({ client: () => mounted.getInstance(), base: mounted.options?.base }))
  : storageView;

// Secrets come from Workers bindings when present, otherwise from the process environment.
const env = new Proxy({}, {
  get: (_, key) => typeof key === "string" ? (globalThis.__env__?.[key] ?? globalThis.process?.env?.[key]) : undefined,
});

return createAgentUnit({
  name: config.name ?? ${JSON.stringify(project.name)},
  agents: ${agentsBlock},
  adapters: ${adapterList},
  storage,
  budget: ${options.budgetMs ?? "false"},
  basePath: ${basePath},
  authorize: settings.authorize,
  origin: settings.origin,
  retention: settings.retention,
  maxBodyBytes: settings.maxBodyBytes,
  env,
});
}
`,
  );

  writeFileSync(
    join(dir, "entry.mjs"),
    `// Generated by agent-unit. Do not edit.
import { defineHandler } from ${nitro("nitro")};
import { getUnit } from "./runtime.mjs";

// Only hosts that keep work alive after the response get waitUntil; the others finish work in the request.
export default defineHandler((event) =>
  getUnit().handler(event.req, typeof event.req.waitUntil === "function" ? { waitUntil: (promise) => event.req.waitUntil(promise) } : {}),
);
`,
  );

  writeFileSync(
    join(dir, "sweep.mjs"),
    `// Generated by agent-unit. Do not edit.
import { defineTask } from ${nitro("nitro/task")};
import { getUnit } from "./runtime.mjs";

export default defineTask({
  meta: { description: "Wake due agent-unit runs and recover stalled ones." },
  async run() {
    const { woken, recovered, settled } = await getUnit().engine.sweep();
    await settled;
    return { result: { woken, recovered } };
  },
});
`,
  );
  return { adapters: adapters.map((adapter) => adapter.package) };
}

/**
 * Netlify runs crons as scheduled functions, which Nitro does not emit, so the sweep gets its own
 * function that calls the secret-guarded sweep endpoint on the deployed site.
 */
function writeNetlifySweep(functionsDir: string, schedule: string, basePath: string) {
  const dir = join(functionsDir, "agent-unit-sweep");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent-unit-sweep.mjs"),
    `// Generated by agent-unit. Do not edit.
export default async () => {
  const site = process.env.URL;
  const secret = process.env.AGENT_UNIT_SECRET;
  if (!site || !secret) {
    console.warn("agent-unit: set AGENT_UNIT_SECRET so the scheduled sweep can wake sleeping runs.");
    return new Response(null, { status: 204 });
  }
  const response = await fetch(new URL(${JSON.stringify(`${basePath.replace(/\/+$/, "")}/__agent-unit/sweep`)}, site), {
    method: "POST",
    headers: { authorization: \`Bearer \${secret}\` },
  });
  if (!response.ok) console.error(\`agent-unit: sweep failed with \${response.status}\`);
  return new Response(null, { status: response.ok ? 204 : 500 });
};

export const config = { schedule: ${JSON.stringify(schedule)} };
`,
  );
}

export interface EngineBuild {
  runtime: "default" | "durable-objects";
  /** The Nitro server entry. */
  entry: string;
  budgetMs?: number;
  storage: StorageConfig;
  adapters: string[];
  agents: string[];
  /** Nitro options the engine needs: run storage and the sweep task. */
  nitro: Record<string, unknown>;
  /** Work after Nitro's build: Netlify's scheduled sweep and the agent-unit.json manifest. */
  finish(output: { outDir: string; serverDir: string }, warn: (message: string) => void): Promise<void>;
}

/** Generates the engine's server for `preset` into `genDir`. */
export function prepareEngine(project: LoadedProject, preset: string, genDir: string, warn: (message: string) => void): EngineBuild {
  const runtime = project.config.runtime ?? "default";
  const durable = runtime === "durable-objects";
  if (durable && preset !== "cloudflare-module") {
    throw new Error(`agent-unit: runtime "durable-objects" runs on Cloudflare Workers; build it with preset "cloudflare-module", not "${preset}".`);
  }
  // A Durable Object alarm may run for 15 minutes, so durable runs yield far less often than Workers requests.
  const budgetMs = durable && project.config.budget === undefined ? parseDuration("10m") : resolveBudget(project, preset);
  const storage: StorageConfig = durable ? { driver: "durable-objects" } : resolveStorage(project, preset, warn);
  const { adapters } = generateEntry(project, genDir, { budgetMs, runtime, preset, storage: durable ? undefined : storage, nitro: ownNitro });

  const tasks: Record<string, unknown> = {};
  const scheduledTasks: Record<string, string> = {};
  // Durable runs wake from their own alarms; there is nothing to sweep.
  const cron = project.config.sweep === false || durable ? undefined : (project.config.sweep ?? "* * * * *");
  const sweep = cron !== undefined;
  if (sweep) {
    if (sweepScheduled(preset)) checkSchedule(cron, "the sweep", preset);
    tasks["agent-unit:sweep"] = { handler: join(genDir, "sweep.mjs"), description: "Wake due runs and recover stalled ones." };
    scheduledTasks[cron] = "agent-unit:sweep";
  }

  return {
    runtime,
    entry: join(genDir, "entry.mjs"),
    budgetMs,
    storage,
    adapters,
    agents: project.config.agents ? Object.keys(project.config.agents) : Object.keys(project.agentFiles),
    nitro: {
      // Run storage is mounted by the generated runtime, not through Nitro's storage options.
      experimental: { tasks: sweep },
      tasks,
      scheduledTasks,
    },
    async finish({ outDir, serverDir }, warn) {
      if (sweep && /^netlify/.test(preset) && preset !== "netlify-edge") {
        writeNetlifySweep(dirname(serverDir), cron, project.config.basePath ?? "");
      }
      // The manifest beside the output, for registries and deploy tooling that read it without running the server.
      try {
        writeFileSync(join(outDir, "agent-unit.json"), `${JSON.stringify(await buildManifest(project), null, 2)}\n`);
      } catch (error) {
        warn(`agent-unit: could not load the agents to write agent-unit.json (${error instanceof Error ? error.message : String(error)}); the server still serves /manifest.json.`);
      }
    },
  };
}
