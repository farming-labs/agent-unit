// The files `agent-unit init` writes, as a pure function of the answers, so every combination can be
// checked without touching the disk. Each template mirrors an app the e2e suite already runs.

export const FRAMEWORKS = {
  mastra: { label: "Mastra", hint: "a Mastra agent" },
  "ai-sdk": { label: "AI SDK", hint: "an AI SDK agent" },
  langgraph: { label: "LangGraph", hint: "a LangGraph agent, its checkpoints in agent-unit's storage" },
  "openai-agents": { label: "OpenAI Agents SDK", hint: "an OpenAI Agents SDK agent, on OpenAI" },
  "agent-unit": { label: "None: defineAgent", hint: "agent-unit's own agents: plain functions with durable steps and approvals" },
  hono: { label: "None: a Hono server", hint: "a plain server to bring your own agent code to" },
} as const;

/** Who runs the agent, for frameworks that can go either way. */
export const RUNNERS = {
  engine: { label: "agent-unit's engine", hint: "durable runs: journaled model and tool calls, approvals, resume after restarts" },
  server: { label: "Its own server", hint: "the framework's server, routes and storage" },
} as const;

export const HOSTS = {
  node: { label: "Node", preset: "node-server", start: "node .output/server/index.mjs" },
  bun: { label: "Bun", preset: "bun", start: "bun run .output/server/index.mjs" },
  deno: { label: "Deno", preset: "deno-server", start: "deno run -A .output/server/index.mjs" },
  // wrangler's major version is pinned, so a deploy does not change with its next breaking release.
  cloudflare: { label: "Cloudflare Workers", preset: "cloudflare-module", deploy: "npx wrangler@4 deploy" },
  // --prod: Vercel runs cron jobs (agent-unit's sweep, the app's tasks) only on production deployments.
  vercel: { label: "Vercel", preset: "vercel", deploy: "npx vercel deploy --prebuilt --prod" },
  // The Netlify CLI runs the build itself, from netlify.toml, then deploys what it built.
  netlify: { label: "Netlify", preset: "netlify", deploy: "npx netlify-cli deploy --prod", buildsItself: true },
  // The AWS SAM CLI deploys template.yaml, which points at the build.
  lambda: { label: "AWS Lambda", preset: "aws-lambda", deploy: "sam deploy" },
} as const satisfies Record<string, { label: string; preset: string; start?: string; deploy?: string; buildsItself?: boolean }>;

/** Hosts without a disk that lasts between invocations, where the engine keeps runs in Upstash. */
const SERVERLESS: InitHost[] = ["vercel", "netlify", "lambda"];

/** Mastra's store on every host but Workers, where it is always D1. */
export const STORES = {
  libsql: { label: "LibSQL", hint: "a local file, or Turso, on a server you run" },
  postgres: { label: "Postgres", hint: "any Postgres, such as Neon or Supabase; works on serverless hosts" },
} as const;

/** Whether any of these hosts is serverless (Vercel, Netlify, AWS Lambda). */
export const hasServerless = (hosts: InitHost[]): boolean => hosts.some((host) => SERVERLESS.includes(host));

/**
 * Mastra's store when none is chosen. LibSQL loads a native binary when it is imported, and a build
 * carries the binary of the machine that made it (a Mac's, say), which a Linux function cannot load;
 * its default local file cannot be written there either. Postgres is plain JavaScript over the network.
 */
export const defaultStore = (hosts: InitHost[]): InitStore => (hasServerless(hosts) ? "postgres" : "libsql");
/** Hosts whose scheduler Nitro drives, so a task runs on its own there; Netlify and Lambda have none. */
const SCHEDULING_HOSTS: InitHost[] = ["node", "bun", "deno", "cloudflare", "vercel"];
export const runsTasks = (hosts: InitHost[]): boolean => hosts.some((host) => SCHEDULING_HOSTS.includes(host));

export const PROVIDERS = {
  openai: { label: "OpenAI", package: "@ai-sdk/openai", create: "createOpenAI", langchain: "@langchain/openai", chat: "ChatOpenAI", key: "OPENAI_API_KEY", model: "gpt-5-mini" },
  anthropic: { label: "Anthropic", package: "@ai-sdk/anthropic", create: "createAnthropic", langchain: "@langchain/anthropic", chat: "ChatAnthropic", key: "ANTHROPIC_API_KEY", model: "claude-sonnet-4-5" },
  google: {
    label: "Google",
    package: "@ai-sdk/google",
    create: "createGoogleGenerativeAI",
    langchain: "@langchain/google-genai",
    chat: "ChatGoogleGenerativeAI",
    key: "GOOGLE_GENERATIVE_AI_API_KEY",
    model: "gemini-2.5-flash",
  },
} as const;

export const EXTRAS = {
  task: { label: "A scheduled task", hint: "runs every day with the host's own scheduler" },
  auth: { label: "Bearer-token auth", hint: "API_TOKEN protects the agent route" },
  background: { label: "Background work", hint: "a route that answers first and finishes its work after, with waitUntil" },
  test: { label: "A test", hint: "a vitest test that runs offline, on a scripted model where the agent calls one: npm test" },
} as const;

export type InitFramework = keyof typeof FRAMEWORKS;
export type InitRunner = keyof typeof RUNNERS;
export type InitHost = keyof typeof HOSTS;
export type InitStore = keyof typeof STORES;
export type InitProvider = keyof typeof PROVIDERS;
export type InitExtra = keyof typeof EXTRAS;

export interface InitAnswers {
  /** package.json name. */
  name: string;
  framework: InitFramework;
  /** Who runs the agent, when the framework can go either way. */
  runner?: InitRunner;
  /** At least one; the first is what `build` builds. */
  hosts: InitHost[];
  /** Mastra's store off Workers. Default libsql. */
  store?: InitStore;
  /** Model provider, for frameworks that call a model. Default openai. */
  provider?: InitProvider;
  extras?: InitExtra[];
}

/** The questions that apply to the answers before them, so prompts and flags agree. */
export const asksRunner = (framework: InitFramework) => framework === "mastra" || framework === "ai-sdk";
/** Mastra keeps its own server by default; an AI SDK agent runs on the engine. */
export const defaultRunner = (framework: InitFramework): InitRunner => (framework === "mastra" ? "server" : "engine");
export function runnerFor(framework: InitFramework, runner?: InitRunner): InitRunner {
  // LangGraph and the OpenAI Agents SDK have no server of their own; a plain Hono app has no agent.
  if (!asksRunner(framework)) return framework === "hono" ? "server" : "engine";
  return runner ?? defaultRunner(framework);
}
/** The OpenAI Agents SDK calls OpenAI, so it is not asked. */
export const asksProvider = (framework: InitFramework) => framework === "mastra" || framework === "ai-sdk" || framework === "langgraph";
const callsModel = (framework: InitFramework) => asksProvider(framework) || framework === "openai-agents";
export const asksStore = (framework: InitFramework, runner: InitRunner) => framework === "mastra" && runner === "server";
export function extrasFor(framework: InitFramework, runner: InitRunner, hosts?: InitHost[]): InitExtra[] {
  // A scheduled task only where some host runs it on its own.
  const task: InitExtra[] = hosts && !runsTasks(hosts) ? [] : ["task"];
  if (framework === "mastra" && runner === "server") return task;
  // A server agent-unit writes (Hono, or an AI SDK agent on Hono) has routes to add work to and test.
  if (runner === "server") return [...task, "auth", "background", "test"];
  // Every engine agent has an offline test: defineAgent's runs as it is, and the others take a scripted
  // model in place of the provider's.
  return [...task, "auth", "test"];
}

// Ranges start at the versions agent-unit's own tests run against.
const VERSIONS: Record<string, string> = {
  "@ai-sdk/anthropic": "^4.0.21",
  "@ai-sdk/google": "^4.0.24",
  "@ai-sdk/openai": "^4.0.20",
  "@langchain/anthropic": "^1.5.12",
  "@langchain/core": "^1.2.14",
  "@langchain/google-genai": "^2.3.2",
  "@langchain/langgraph": "^1.4.19",
  "@langchain/openai": "^1.6.2",
  "@mastra/cloudflare-d1": "^1.4.1",
  "@mastra/core": "^1.74.0",
  "@mastra/hono": "^1.7.16",
  "@mastra/libsql": "^1.25.1",
  "@mastra/pg": "^1.29.0",
  "@openai/agents": "^0.19.0",
  "@types/node": "^20.19.0",
  "@upstash/redis": "^1.39.0",
  vitest: "^3.2.7",
  ai: "^7.0.30",
  hono: "^4.13.13",
  typescript: "^5.9.3",
  zod: "^4.3.6",
};

const sorted = (names: string[]) => Object.fromEntries([...new Set(names)].sort().map((name) => [name, VERSIONS[name]!]));

/** A valid npm package name from a directory name. */
export function packageName(input: string): string {
  const name = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[._-]+|-+$/g, "");
  return name || "my-agent";
}

/** A Worker name from the app's name: lowercase letters, digits and dashes, at most 63 characters. */
export function workerName(name: string): string {
  return name.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "") || "my-agent";
}

/** Fills in defaults and drops answers that do not apply, so `files()` sees one shape. */
export function normalizeAnswers(answers: InitAnswers): Required<InitAnswers> {
  if (!answers.hosts.length) throw new Error("Choose at least one host.");
  const runner = runnerFor(answers.framework, answers.runner);
  const allowed = extrasFor(answers.framework, runner, answers.hosts);
  return {
    name: packageName(answers.name),
    framework: answers.framework,
    runner,
    hosts: [...new Set(answers.hosts)],
    store: answers.store ?? defaultStore(answers.hosts),
    provider: answers.framework === "openai-agents" ? "openai" : (answers.provider ?? "openai"),
    extras: [...new Set(answers.extras ?? [])].filter((extra) => allowed.includes(extra)),
  };
}

/**
 * An AWS SAM template for the Lambda build: one function on Node.js 22 behind a public function URL,
 * with each environment variable as a deploy parameter (secrets hidden in the console and the logs).
 */
function samTemplate(name: string, env: string[], script: string): string {
  const parameter = (key: string) => key.toLowerCase().replace(/(^|_)([a-z0-9])/g, (_match, _sep, char: string) => char.toUpperCase());
  const secret = (key: string) => /KEY|TOKEN|SECRET|PASSWORD|AUTH/.test(key);
  const lines = [
    `# AWS SAM template for this app's Lambda build. \`npm run ${script}\` deploys it; the first time, add -- --guided.`,
    `AWSTemplateFormatVersion: "2010-09-09"`,
    `Transform: AWS::Serverless-2016-10-31`,
    `Description: ${name}, built by agent-unit for AWS Lambda`,
    ``,
  ];
  if (env.length) {
    lines.push(`Parameters:`);
    for (const key of env) lines.push(`  ${parameter(key)}:`, `    Type: String`, ...(secret(key) ? [`    NoEcho: true`] : []), ...(/^(FEEDBACK_WEBHOOK_URL)$/.test(key) ? [`    Default: ""`] : []));
    lines.push(``);
  }
  lines.push(
    `Resources:`,
    `  App:`,
    `    Type: AWS::Serverless::Function`,
    `    Properties:`,
    `      CodeUri: .output/server/`,
    `      Handler: index.handler`,
    `      Runtime: nodejs22.x`,
    `      Architectures: [x86_64]`,
    `      MemorySize: 1024`,
    `      # Lambda's default is 3 seconds; a run with model calls needs longer.`,
    `      Timeout: 300`,
  );
  if (env.length) {
    lines.push(`      Environment:`, `        Variables:`);
    for (const key of env) lines.push(`          ${key}: !Ref ${parameter(key)}`);
  }
  lines.push(
    `      FunctionUrlConfig:`,
    `        AuthType: NONE`,
    `        InvokeMode: BUFFERED`,
    ``,
    `Outputs:`,
    `  Url:`,
    `    Description: The app's URL`,
    `    Value: !GetAtt AppUrl.FunctionUrl`,
    ``,
  );
  return lines.join("\n");
}

const and = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join(""));
const objectKey = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key));

/** What an existing app already has, when `agent-unit init` adds agent-unit to it. */
export interface ExistingApp {
  /** Its own Mastra instance in src/mastra: Mastra's storage and agents stay the app's. */
  mastra?: boolean;
  /** Its own server module, as a path from the app's root (`./src/index.ts`): built instead of a new one. */
  server?: string;
}

type Manifest = Record<string, unknown> & { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

/** The framework an app already uses, from its package.json, as the default answer. */
export function detectFramework(manifest: Manifest): InitFramework | undefined {
  const deps = { ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.dependencies };
  if (deps["@mastra/core"]) return "mastra";
  if (deps["@langchain/langgraph"]) return "langgraph";
  if (deps["@openai/agents"]) return "openai-agents";
  if (deps.ai) return "ai-sdk";
  if (deps.hono) return "hono";
  return undefined;
}

export interface AppMerge {
  /** What to write, by path: new files, and the app's own files with lines added. */
  files: Record<string, string>;
  created: string[];
  updated: string[];
  /** The app's files left as they are, where agent-unit would have written its own. */
  kept: string[];
  /** agent-unit's scripts whose names the app already uses, under their new names. */
  renamed: Record<string, string>;
}

/**
 * Adds a plan to an existing app without replacing anything in it: package.json gains only missing
 * dependencies, scripts and imports (a script whose name is taken is added as `agent-unit:<name>`),
 * .gitignore and .env.example only missing lines, and every other file only where none exists.
 */
export function mergeIntoApp(plan: Record<string, string>, read: (path: string) => string | undefined): AppMerge {
  const merge: AppMerge = { files: {}, created: [], updated: [], kept: [], renamed: {} };
  // package.json first: the files that name agent-unit's scripts (netlify.toml, template.yaml) need
  // the names they end up with.
  const paths = Object.keys(plan).sort((a, b) => Number(b === "package.json") - Number(a === "package.json"));
  for (const path of paths) {
    const content = renameScripts(plan[path]!, merge.renamed);
    const current = read(path);
    // The app's README describes the app, and its TypeScript setup is its own: agent-unit builds
    // without one.
    if (path === "README.md" || path === "tsconfig.json") continue;
    if (current === undefined) {
      merge.files[path] = content;
      merge.created.push(path);
      continue;
    }
    const next = path === "package.json" ? mergeManifest(current, content, merge.renamed) : path === ".gitignore" ? mergeLines(current, content) : path === ".env.example" ? mergeEnv(current, content) : current;
    if (next !== current) {
      merge.files[path] = next;
      merge.updated.push(path);
    } else if (path !== "package.json" && path !== ".gitignore" && path !== ".env.example" && current !== content) {
      merge.kept.push(path);
    }
  }
  return merge;
}

/** `npm run <script>` in a planned file, for each of agent-unit's scripts the app's own names took. */
function renameScripts(content: string, renamed: Record<string, string>): string {
  let next = content;
  for (const [from, to] of Object.entries(renamed)) next = next.replace(new RegExp(`npm run ${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w:-])`, "g"), `npm run ${to}`);
  return next;
}

function mergeManifest(current: string, planned: string, renamed: Record<string, string>): string {
  const app = JSON.parse(current) as Manifest & { scripts?: Record<string, string>; imports?: Record<string, unknown> };
  const plan = JSON.parse(planned) as Manifest & { scripts: Record<string, string>; imports?: Record<string, unknown> };
  const has = (name: string) => [app.dependencies, app.devDependencies, app.peerDependencies].some((deps) => deps?.[name] !== undefined);
  for (const [name, range] of Object.entries(plan.dependencies ?? {})) if (!has(name)) app.dependencies = { ...app.dependencies, [name]: range };
  // Dev tools the extras need (vitest for the test), but not a TypeScript setup: that one is the app's.
  for (const [name, range] of Object.entries(plan.devDependencies ?? {})) {
    if (!has(name) && name !== "typescript" && name !== "@types/node") app.devDependencies = { ...app.devDependencies, [name]: range };
  }
  for (const [name, command] of Object.entries(plan.scripts)) {
    if (name === "typecheck") continue;
    const scripts = (app.scripts ??= {});
    if (scripts[name] === undefined || scripts[name] === command) {
      scripts[name] = command;
      continue;
    }
    const alias = `agent-unit:${name}`;
    if (scripts[alias] === undefined || scripts[alias] === command) {
      scripts[alias] = command;
      renamed[name] = alias;
    }
  }
  for (const [key, target] of Object.entries(plan.imports ?? {})) if (app.imports?.[key] === undefined) app.imports = { ...app.imports, [key]: target };
  const indent = /^([ \t]+)"/m.exec(current)?.[1] ?? "  ";
  return `${JSON.stringify(app, null, indent)}\n`;
}

function mergeLines(current: string, planned: string): string {
  const have = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = planned.split("\n").filter((line) => line.trim() && !have.has(line.trim()));
  return missing.length ? `${current.replace(/\n*$/, "\n")}\n# agent-unit\n${missing.join("\n")}\n` : current;
}

function mergeEnv(current: string, planned: string): string {
  const keys = new Set([...current.matchAll(/^\s*([A-Za-z_][\w]*)\s*=/gm)].map((match) => match[1]));
  const missing = planned.split("\n\n").filter((block) => {
    const key = /^([A-Za-z_][\w]*)=/m.exec(block)?.[1];
    return key !== undefined && !keys.has(key);
  });
  return missing.length ? `${current.replace(/\n*$/, "\n")}\n${missing.map((block) => block.replace(/\n*$/, "\n")).join("\n")}` : current;
}

export interface InitPlan {
  files: Record<string, string>;
  /** Environment variables the app reads, for the summary. */
  env: string[];
}

/** Everything `agent-unit init` writes for these answers, by path relative to the new app. */
export function initFiles(input: InitAnswers, agentUnitVersion: string, app: ExistingApp = {}): InitPlan {
  const answers = normalizeAnswers(input);
  const { framework, hosts, extras } = answers;
  const engine = answers.runner === "engine";
  // The app's own Mastra instance: its agents, model keys and storage stay as they are.
  const ownMastra = !!app.mastra && framework === "mastra" && !engine;
  // The app's own server: agent-unit builds it as it is, so it needs no model, route or package of ours.
  const ownServer = !!app.server && framework !== "mastra" && !engine;
  const provider = PROVIDERS[answers.provider];
  const workers = hosts.includes("cloudflare");
  const serverless = hosts.filter((host) => SERVERLESS.includes(host));
  const task = extras.includes("task");
  const auth = extras.includes("auth") && !ownServer;
  const background = extras.includes("background") && !ownServer;
  const test = extras.includes("test") && !ownServer;
  const files: Record<string, string> = {};

  // Dependencies
  const dependencies = ownMastra || ownServer ? [] : ["zod"];
  const devDependencies = ["typescript", "@types/node", ...(test ? ["vitest"] : [])];
  if (ownMastra) {
    dependencies.push("@mastra/hono", "hono");
  } else if (engine) {
    if (framework === "mastra") dependencies.push("@mastra/core");
    if (framework === "mastra" || framework === "ai-sdk") dependencies.push("ai", provider.package);
    if (framework === "langgraph") dependencies.push("@langchain/core", "@langchain/langgraph", provider.langchain);
    if (framework === "openai-agents") dependencies.push("@openai/agents");
    if (serverless.length) dependencies.push("@upstash/redis");
  } else if (framework === "mastra") {
    dependencies.push("@mastra/core", "@mastra/hono", "hono", answers.store === "postgres" ? "@mastra/pg" : "@mastra/libsql");
    if (workers) dependencies.push("@mastra/cloudflare-d1");
  } else if (!ownServer) {
    dependencies.push("hono");
    if (framework === "ai-sdk") dependencies.push("ai", provider.package);
  }

  // Scripts: `build` is the first host; with several, each also has its own. Deploy CLIs run through
  // npx rather than being installed: wrangler's peer range for @cloudflare/workers-types conflicts
  // with @mastra/cloudflare-d1's, and npm refuses to install both.
  const scripts: Record<string, string> = { dev: "agent-unit dev", build: `agent-unit build --preset ${HOSTS[hosts[0]!].preset}` };
  for (const host of hosts) {
    const { preset } = HOSTS[host];
    const { start, deploy, buildsItself } = HOSTS[host] as { start?: string; deploy?: string; buildsItself?: boolean };
    const suffix = hosts.length > 1 ? `:${host}` : "";
    if (suffix) scripts[`build${suffix}`] = `agent-unit build --preset ${preset}`;
    if (start) scripts[`start${suffix}`] = start;
    if (deploy) scripts[`deploy${suffix}`] = buildsItself ? deploy : `agent-unit build --preset ${preset} && ${deploy}`;
    // The Worker on Cloudflare's own runtime, locally: Durable Objects and bindings as deployed.
    if (host === "cloudflare") scripts[`preview${suffix}`] = `agent-unit build --preset ${preset} && npx wrangler@4 dev`;
  }
  if (task) scripts.task = "agent-unit task daily-summary";
  if (test) scripts.test = "vitest run";
  scripts.typecheck = "tsc --noEmit";

  const manifest: Record<string, unknown> = { name: answers.name, private: true, type: "module", scripts };
  if (framework === "mastra" && !engine && !ownMastra) {
    // Each host gets its own store: the build for Workers resolves `workerd`, every other host `default`.
    const store = `./src/storage.${answers.store}.ts`;
    manifest.imports = { "#storage": workers ? { workerd: "./src/storage.d1.ts", default: store } : store };
  }
  manifest.dependencies = { "agent-unit": `^${agentUnitVersion}`, ...sorted(dependencies) };
  manifest.devDependencies = sorted(devDependencies);
  files["package.json"] = `${JSON.stringify(manifest, null, 2)}\n`;

  // agent-unit.config.ts
  const config: string[] = [];
  if (!engine && framework !== "mastra") config.push(`  server: ${JSON.stringify(app.server ?? "./src/server.ts")},`);
  if (engine && auth) {
    config.push(
      `  // Clients send \`Authorization: Bearer <API_TOKEN>\`.`,
      `  authorize: (request) => !!env.API_TOKEN && request.headers.get("authorization") === \`Bearer \${env.API_TOKEN}\`,`,
    );
  }
  if (workers) {
    // Named here: without a name, the Worker is named after the git remote once there is one, and the
    // next deploy makes a new Worker, without the secrets and runs of the first.
    const name = `name: ${JSON.stringify(workerName(answers.name))}`;
    if (framework === "mastra" && !engine && !ownMastra) {
      config.push(
        `  // Mastra's D1 store on Workers. Create the database with \`npx wrangler d1 create ${answers.name}\``,
        `  // and put the id it prints here.`,
        `  cloudflare: {`,
        `    wrangler: {`,
        `      ${name},`,
        `      d1_databases: [{ binding: "DB", database_name: "${answers.name}", database_id: "00000000-0000-0000-0000-000000000000" }],`,
        `    },`,
        `  },`,
      );
    } else {
      config.push(`  cloudflare: { wrangler: { ${name} } },`);
    }
  }
  if (task) config.push(`  tasks: { "daily-summary": { schedule: "0 8 * * *", handler: "./src/tasks/daily-summary.ts" } },`);
  if (engine && (workers || serverless.length)) {
    // Runs stay on disk on Node, Bun and Deno (the default); other hosts get theirs per preset.
    config.push(`  presets: {`);
    if (workers) config.push(`    // One Durable Object per run, with its own alarm: nothing to set up.`, `    "cloudflare-module": { runtime: "durable-objects" },`);
    if (serverless.length) {
      config.push(
        `    // No disk lasts between invocations here, so runs go to Upstash. Its driver reads`,
        `    // UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN when it runs.`,
        ...serverless.flatMap((host) =>
          host === "vercel"
            ? [
                `    // The sweep wakes sleeping runs and recovers stalled ones. Vercel's Hobby plan runs cron jobs`,
                `    // at most once a day; on Pro, remove \`sweep\` here for a sweep every minute.`,
                `    vercel: { storage: { driver: "upstash" }, sweep: "0 0 * * *" },`,
              ]
            : [`    ${objectKey(HOSTS[host].preset)}: { storage: { driver: "upstash" } },`],
        ),
      );
    }
    config.push(`  },`);
  }
  const configComment = engine
    ? "// agent-unit's engine: every file in agents/ is an agent, served at /agents/<name>/runs.\n"
    : framework === "mastra"
      ? "// No `server`: agent-unit finds src/mastra/index.ts and builds Mastra's own server.\n"
      : "// Your server, built for every host with `agent-unit build --preset <host>`.\n";
  const configImports = [`import { defineConfig } from "agent-unit";`, ...(engine && auth ? [`import { env } from "agent-unit/env";`] : [])];
  files["agent-unit.config.ts"] = `${configImports.join("\n")}\n\n${configComment}export default defineConfig({${config.length ? `\n${config.join("\n")}\n` : ""}});\n`;

  // The app
  if (engine) Object.assign(files, engineAgent(answers));
  else if (framework === "mastra") Object.assign(files, ownMastra ? {} : mastraFiles(answers, workers));
  else if (!app.server) files["src/server.ts"] = serverFile(framework as "ai-sdk" | "hono", provider, auth, background);
  // Engine agents on a model write their own test, beside the agent.
  if (test && !engine) files["test/server.test.ts"] = serverTest(framework as "ai-sdk" | "hono", auth, background);
  if (test && framework === "agent-unit") files["test/refund.test.ts"] = AGENT_TEST;
  if (task) {
    files["src/tasks/daily-summary.ts"] = `// Runs every day at 08:00 UTC: in-process on Node, Bun and Deno, a Cron Trigger on Workers, a Cron
// Job on Vercel. \`npm run task\` runs it once now.
export default async ({ scheduledTime }: { name: string; scheduledTime: number }) => {
  console.log(\`daily summary for \${new Date(scheduledTime).toISOString().slice(0, 10)}\`);
};
`;
  }

  // Environment
  const env: [string, string][] = [];
  if (callsModel(framework) && !ownMastra && !ownServer) env.push([provider.key, `Your ${provider.label} API key`]);
  if (engine && serverless.length) {
    env.push(["UPSTASH_REDIS_REST_URL", `Upstash Redis REST URL, where runs are kept on ${and(serverless.map((host) => HOSTS[host].label))}`]);
    env.push(["UPSTASH_REDIS_REST_TOKEN", "Upstash Redis REST token"]);
  }
  if (engine && serverless.length) {
    env.push(["AGENT_UNIT_SECRET", "Any long random string in production: protects the internal continue and sweep endpoints"]);
  }
  // Vercel sends it with each cron request; without it, anyone can call the cron route.
  if (hosts.includes("vercel") && (engine || task)) env.push(["CRON_SECRET", "Any long random string on Vercel: its cron jobs send it, and other callers are refused"]);
  // Workers keep Mastra in D1: its LibSQL settings matter only where another host runs it.
  if (framework === "mastra" && !engine && !ownMastra && answers.store === "libsql" && hosts.some((host) => host !== "cloudflare")) {
    env.push(["MASTRA_DB_URL", "LibSQL database. Default file:./mastra.db; serverless hosts need a hosted one, such as libsql://<db>.turso.io"]);
    env.push(["MASTRA_DB_AUTH_TOKEN", "Token for a hosted LibSQL database (Turso)"]);
  }
  if (framework === "mastra" && !engine && !ownMastra && answers.store === "postgres") env.push(["DATABASE_URL", "Postgres connection string"]);
  if (auth) env.push(["API_TOKEN", "Clients send it as `Authorization: Bearer <token>`"]);
  if (background) env.push(["FEEDBACK_WEBHOOK_URL", "Optional: where POST /feedback forwards feedback after answering; unset, it is logged"]);
  if (env.length) files[".env.example"] = env.map(([key, comment]) => `# ${comment}\n${key}=\n`).join("\n");

  if (hosts.includes("netlify")) {
    files["netlify.toml"] = `# Netlify builds and deploys from this, with \`npm run deploy${hosts.length > 1 ? ":netlify" : ""}\` or from a connected repository.
[build]
  command = "npm run build${hosts.length > 1 ? ":netlify" : ""}"
  publish = "dist"
`;
  }
  if (hosts.includes("lambda")) files["template.yaml"] = samTemplate(answers.name, env.map(([key]) => key).filter((key) => key !== "CRON_SECRET"), hosts.length > 1 ? "deploy:lambda" : "deploy");

  // Netlify's build puts static files in dist/; LibSQL keeps -shm and -wal files beside its database.
  const ignored = ["node_modules", ".output", ".agent-unit", ".data", ".nitro", ".vercel", ".netlify", ".wrangler", ...(hosts.includes("netlify") ? ["dist"] : []), ...(hosts.includes("lambda") ? [".aws-sam"] : []), "*.db", "*.db-shm", "*.db-wal"];
  files[".gitignore"] = [...ignored, ".env", ".env.*", "!.env.example", ".dev.vars", ""].join("\n");
  files["tsconfig.json"] = `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: ["node"],
      },
      include: ["src", ...(test ? ["test"] : []), ...(engine ? ["agents"] : []), "agent-unit.config.ts"],
    },
    null,
    2,
  )}\n`;
  files["README.md"] = readme(answers, env.map(([key]) => key));
  return { files, env: env.map(([key]) => key) };
}

function serverFile(framework: "ai-sdk" | "hono", provider: (typeof PROVIDERS)[InitProvider], auth: boolean, background: boolean): string {
  const route = framework === "ai-sdk" ? "/chat" : "/hello";
  const imports = [`import { Hono } from "hono";`];
  if (auth) imports.push(`import { bearerAuth } from "hono/bearer-auth";`);
  const lines: string[] = [];
  if (framework === "ai-sdk") {
    imports.push(`import { ${provider.create} } from "${provider.package}";`, `import { ToolLoopAgent, tool } from "ai";`, `import { z } from "zod";`);
    lines.push(
      `// One AI SDK agent with one tool. Read keys with agent-unit/env: it works the same on every host.`,
      `const provider = ${provider.create}({ apiKey: env.${provider.key} });`,
      ``,
      `const assistant = new ToolLoopAgent({`,
      `  model: provider("${provider.model}"),`,
      `  instructions: "You are a helpful assistant. Keep answers short.",`,
      `  tools: {`,
      `    clock: tool({`,
      `      description: "The current date and time in UTC",`,
      `      inputSchema: z.object({}),`,
      `      execute: async () => ({ now: new Date().toISOString() }),`,
      `    }),`,
      `  },`,
      `});`,
      ``,
    );
  }
  imports.push(background ? `import { env, waitUntil } from "agent-unit/env";` : `import { env } from "agent-unit/env";`);
  lines.push(`const app = new Hono();`, ``, `app.get("/", (c) => c.json({ ok: true }));`, ``);
  if (background) {
    lines.push(
      `// POST /feedback {"rating":5} answers at once; forwarding the feedback finishes after the response.`,
      `// waitUntil keeps it running on every host: the host's own on Node, Bun, Deno, Workers and Vercel,`,
      `// and on Netlify and AWS Lambda, which may freeze after a response, the response waits for it.`,
      `app.post("/feedback", async (c) => {`,
      `  waitUntil(forward(await c.req.json()));`,
      `  return c.json({ received: true }, 202);`,
      `});`,
      ``,
      `async function forward(feedback: unknown) {`,
      `  if (!env.FEEDBACK_WEBHOOK_URL) return console.log("feedback", feedback);`,
      `  const response = await fetch(env.FEEDBACK_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(feedback) });`,
      `  if (!response.ok) throw new Error(\`feedback webhook answered \${response.status}\`);`,
      `}`,
      ``,
    );
  }
  if (auth) {
    lines.push(
      `// Clients send \`Authorization: Bearer <API_TOKEN>\`.`,
      `app.use("${route}", bearerAuth({ verifyToken: (token) => !!env.API_TOKEN && token === env.API_TOKEN }));`,
      ``,
    );
  }
  if (framework === "ai-sdk") {
    lines.push(
      `// POST /chat {"prompt":"What time is it?"} streams the answer as text.`,
      `app.post("/chat", async (c) => {`,
      `  const { prompt } = await c.req.json<{ prompt: string }>();`,
      `  const result = await assistant.stream({ prompt });`,
      `  return result.toTextStreamResponse();`,
      `});`,
    );
  } else {
    lines.push(`app.get("/hello", (c) => c.json({ hello: env.GREETING ?? "world" }));`);
  }
  lines.push(``, `export default app;`, ``);
  return `${imports.join("\n")}\n\n${lines.join("\n")}`;
}

const AGENT_TEST = `import { createTestUnit } from "agent-unit/testing";
import { describe, expect, it } from "vitest";
import refund from "../agents/refund";

// The agent runs in memory, with no server: \`npm test\`. A second createTestUnit on the same
// \`storage\` tests a restart between the pause and the answer.
describe("refund", () => {
  it("pauses for approval, then refunds", async () => {
    const unit = createTestUnit({ refund });
    const parked = await unit.run("refund", { orderId: "o_42" });
    expect(parked).toMatchObject({ status: "interrupted", interrupt: { name: "approve-refund", payload: { id: "o_42" } } });
    const done = await unit.resume(parked.id, { approved: true });
    expect(done.output).toBe("refunded o_42");
  });

  it("refunds nothing when the answer is no", async () => {
    const unit = createTestUnit({ refund });
    const parked = await unit.run("refund", { orderId: "o_43" });
    expect((await unit.resume(parked.id, { approved: false })).output).toBe("declined");
  });
});
`;

function serverTest(framework: "ai-sdk" | "hono", auth: boolean, background: boolean): string {
  const route = framework === "ai-sdk" ? "/chat" : "/hello";
  const cases = [
    `  it("answers on /", async () => {
    expect(await (await app.request("/")).json()).toEqual({ ok: true });
  });`,
  ];
  if (framework === "hono" && !auth) {
    cases.push(`  it("says hello", async () => {
    expect(await (await app.request("/hello")).json()).toEqual({ hello: process.env.GREETING ?? "world" });
  });`);
  }
  if (auth) {
    cases.push(`  it("asks for the token on ${route}", async () => {
    expect((await app.request("${route}", { method: "${framework === "ai-sdk" ? "POST" : "GET"}" })).status).toBe(401);
  });`);
  }
  if (background) {
    cases.push(`  it("answers feedback first and forwards it after", async () => {
    vi.stubEnv("FEEDBACK_WEBHOOK_URL", "https://hooks.example.test/feedback");
    const forwarded = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", forwarded);
    const response = await app.request("/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rating: 5 }) });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(forwarded).toHaveBeenCalledWith("https://hooks.example.test/feedback", expect.objectContaining({ body: '{"rating":5}' })));
  });`);
  }
  return `import { ${background ? "afterEach, " : ""}describe, expect, it${background ? ", vi" : ""} } from "vitest";
import app from "../src/server";

// The server answers in-process, with no network: \`npm test\`.
describe("server", () => {
${background ? `  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

` : ""}${cases.join("\n\n")}
});
`;
}

const modelAgentTest = (framework: "ai-sdk" | "mastra") => {
  const adapter = framework === "mastra" ? "mastraAdapter" : "aiSdkAdapter";
  return `import { ${adapter} } from "agent-unit/adapters/${framework}";
import { createTestUnit } from "agent-unit/testing";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAssistant } from "../agents/assistant";

// The agent runs in memory on a scripted model, with no server and no API key: \`npm test\`.

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const stream = (parts: unknown[]) => ({
  stream: new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  }),
});

/** Asks for the refund tool until the conversation holds its result, then answers. */
const model = new MockLanguageModelV4({
  doStream: async ({ prompt }) =>
    prompt.some((message) => message.role === "tool")
      ? stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Refunded o_42." },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ])
      : stream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call_1", toolName: "refund", input: JSON.stringify({ orderId: "o_42" }) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
        ]),
});

describe("assistant", () => {
  it("asks a person before it refunds, then finishes", async () => {
    // Builds find the framework's adapter on their own; a test unit is given it.
    const unit = createTestUnit({ assistant: createAssistant(model) }, { adapters: [${adapter}] });
    const parked = await unit.run("assistant", { prompt: "Please refund order o_42" });
    expect(parked).toMatchObject({ status: "interrupted", interrupt: { name: "approve-refund", payload: { orderId: "o_42" } } });
    const done = await unit.resume(parked.id, { approved: true });
    expect(done).toMatchObject({ status: "completed", output: "Refunded o_42." });
  });
});
`;
};

const LANGGRAPH_TEST = `import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { langGraphAdapter } from "agent-unit/adapters/langgraph";
import { createTestUnit } from "agent-unit/testing";
import { describe, expect, it } from "vitest";
import { createAssistant } from "../agents/assistant";

// The graph runs in memory on a scripted model, with no server and no API key: \`npm test\`.

/** Asks for the refund tool until the conversation holds its result, then answers. */
const model = RunnableLambda.from(async (messages: BaseMessage[]) =>
  messages.some((message) => message.getType() === "tool")
    ? new AIMessage("Refunded o_42.")
    : new AIMessage({ content: "", tool_calls: [{ id: "call_1", name: "refund", args: { orderId: "o_42" } }] }),
);

describe("assistant", () => {
  it("asks a person before it refunds, then finishes", async () => {
    // Builds find the framework's adapter on their own; a test unit is given it.
    const unit = createTestUnit({ assistant: createAssistant(() => model) }, { adapters: [langGraphAdapter] });
    const parked = await unit.run("assistant", { prompt: "Please refund order o_42" });
    // The graph pauses in its tools node, where the refund tool called interrupt().
    expect(parked).toMatchObject({ status: "interrupted", interrupt: { name: "tools", payload: { orderId: "o_42" } } });
    const done = await unit.resume(parked.id, { approved: true });
    expect(done.status).toBe("completed");
    const messages = (done.output as { messages: { type: string; content: unknown }[] }).messages;
    expect(messages.find((message) => message.type === "tool")?.content).toBe("refunded o_42");
    expect(messages.at(-1)).toMatchObject({ type: "ai", content: "Refunded o_42." });
  });
});
`;

const OPENAI_AGENTS_TEST = `import { Usage, type Model, type ModelRequest } from "@openai/agents";
import { openAIAgentsAdapter } from "agent-unit/adapters/openai-agents";
import { createTestUnit } from "agent-unit/testing";
import { describe, expect, it } from "vitest";
import { createAssistant } from "../agents/assistant";

// The agent runs in memory on a scripted model, with no server and no API key: \`npm test\`.

const usage = { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/** Asks for the refund tool until the conversation holds its result, then answers. */
function output(request: ModelRequest) {
  const answered = Array.isArray(request.input) && request.input.some((item) => (item as { type?: string }).type === "function_call_result");
  return answered
    ? [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Refunded o_42." }] }]
    : [{ type: "function_call", callId: "call_1", name: "refund", arguments: JSON.stringify({ orderId: "o_42" }), status: "completed" }];
}

const model = {
  async getResponse(request: ModelRequest) {
    return { usage: new Usage(usage), output: output(request), responseId: "resp_1" };
  },
  async *getStreamedResponse(request: ModelRequest) {
    const items = output(request);
    yield { type: "response_started" };
    if (items[0]!.type === "message") yield { type: "output_text_delta", delta: "Refunded o_42.", itemId: "msg_1" };
    yield { type: "response_done", response: { id: "resp_1", usage, output: items } };
  },
} as unknown as Model;

describe("assistant", () => {
  it("asks a person before it refunds, then finishes", async () => {
    // Builds find the framework's adapter on their own; a test unit is given it.
    const unit = createTestUnit({ assistant: createAssistant(model) }, { adapters: [openAIAgentsAdapter] });
    const parked = await unit.run("assistant", { prompt: "Please refund order o_42" });
    // The refund tool needs approval, so the run waits for a person.
    expect(parked).toMatchObject({ status: "interrupted", interrupt: { name: "tool-approval", payload: { tool: "refund", arguments: { orderId: "o_42" } } } });
    const done = await unit.resume(parked.id, { approved: true });
    expect(done).toMatchObject({ status: "completed", output: "Refunded o_42." });
  });
});
`;

const INSTRUCTIONS = "You help customers with their orders. Keep answers short. Refund only with the refund tool.";

function langgraphAgent(provider: (typeof PROVIDERS)[InitProvider], factory: boolean): string {
  const graph = `new StateGraph(MessagesAnnotation)
  .addNode("agent", async ({ messages }) => ({
    messages: [await model().invoke([new SystemMessage("${INSTRUCTIONS}"), ...messages])],
  }))
  .addNode("tools", new ToolNode([refund]))
  .addEdge(START, "agent")
  .addConditionalEdges("agent", toolsCondition, ["tools", END])
  .addEdge("tools", "agent")
  .compile()`;
  const chat = `new ${provider.chat}({ model: "${provider.model}", apiKey: env.${provider.key} }).bindTools([refund])`;
  return `import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { END, interrupt, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { ${provider.chat} } from "${provider.langchain}";
import { env } from "agent-unit/env";
import { z } from "zod";

// A LangGraph agent on agent-unit's engine: its checkpoints are kept in agent-unit's storage, so a run
// that pauses for approval, restarts or moves to another instance resumes from its last step.
// POST /agents/assistant/runs {"input":{"prompt":"Please refund order o_42"}}

const refund = tool(
  async ({ orderId }) => {
    // Pauses the run until a person answers; the run resumes here with their answer.
    const { approved } = interrupt<{ orderId: string }, { approved: boolean }>({ orderId });
    return approved ? \`refunded \${orderId}\` : \`declined \${orderId}\`;
  },
  { name: "refund", description: "Refunds an order once a person approves it", schema: z.object({ orderId: z.string() }) },
);

// Created on first use, so the app starts, builds and runs its tests before the key is set (some
// LangChain chat models check it when they are created).
let chat: Runnable<BaseMessage[], BaseMessage> | undefined;
const ${factory ? "providerModel" : "model"} = () => (chat ??= ${chat});

${
  factory
    ? `/** The graph on any chat model with the refund tool bound: the test gives it a scripted one. */
export function createAssistant(model: () => Runnable<BaseMessage[], BaseMessage>) {
  return ${graph.replaceAll("\n", "\n  ")};
}

export default createAssistant(providerModel);`
    : `export default ${graph};`
}
`;
}

function openaiAgent(factory: boolean): string {
  const agent = `new Agent({
  name: "Assistant",
  instructions: "${INSTRUCTIONS}",
  ${factory ? "model" : `model: "gpt-5-mini"`},
  tools: [
    tool({
      name: "refund",
      description: "Refunds an order once a person approves it",
      parameters: z.object({ orderId: z.string() }),
      needsApproval: true,
      execute: async ({ orderId }) => \`refunded \${orderId}\`,
    }),
  ],
})`;
  return `import { Agent, ${factory ? "type Model, " : ""}setDefaultOpenAIKey, tool } from "@openai/agents";
import { env } from "agent-unit/env";
import { z } from "zod";

// An OpenAI Agents SDK agent on agent-unit's engine: model and tool calls are journaled, and a tool
// that needs approval pauses the run until a person answers, even across restarts and instances.
// POST /agents/assistant/runs {"input":{"prompt":"Please refund order o_42"}}
setDefaultOpenAIKey(env.OPENAI_API_KEY ?? "");

${
  factory
    ? `/** The agent on any model: the test gives it a scripted one. */
export function createAssistant(model: Model | string) {
  return ${agent.replaceAll("\n", "\n  ")};
}

export default createAssistant("gpt-5-mini");`
    : `export default ${agent};`
}
`;
}

/** The agent an engine app starts with: one that asks a person before it refunds an order. */
function engineAgent(answers: Required<InitAnswers>): Record<string, string> {
  const provider = PROVIDERS[answers.provider];
  if (answers.framework === "agent-unit") {
    return {
      "agents/refund.ts": `import { defineAgent } from "agent-unit";

// An agent-unit agent: each \`run.step\` is journaled, so a run that resumes after an approval, a
// restart or a redeploy never repeats a finished step.
// POST /agents/refund/runs {"input":{"orderId":"o_42"}}
export default defineAgent({
  description: "Refunds an order after a person approves it.",
  async run(input: { orderId: string }, run) {
    const order = await run.step("load-order", async () => ({ id: input.orderId, amount: 42 }));
    const { approved } = await run.interrupt<{ approved: boolean }>("approve-refund", order);
    if (!approved) return "declined";
    await run.step("refund", async () => {
      console.log(\`refunding \${order.id}\`);
    });
    return \`refunded \${order.id}\`;
  },
});
`,
    };
  }
  const test = answers.extras.includes("test");
  if (answers.framework === "langgraph") {
    return { "agents/assistant.ts": langgraphAgent(provider, test), ...(test ? { "test/assistant.test.ts": LANGGRAPH_TEST } : {}) };
  }
  if (answers.framework === "openai-agents") {
    return { "agents/assistant.ts": openaiAgent(test), ...(test ? { "test/assistant.test.ts": OPENAI_AGENTS_TEST } : {}) };
  }
  const mastra = answers.framework === "mastra";
  // With a test, the agent takes its model as an argument, so the test can give it a scripted one.
  const factory = answers.extras.includes("test");
  const imports = mastra
    ? [`import { Agent } from "@mastra/core/agent";`, `import { createTool } from "@mastra/core/tools";`]
    : [factory ? `import { type LanguageModel, tool, ToolLoopAgent } from "ai";` : `import { tool, ToolLoopAgent } from "ai";`];
  imports.push(
    `import { ${provider.create} } from "${provider.package}";`,
    `import { useRun } from "agent-unit";`,
    `import { env } from "agent-unit/env";`,
    `import { z } from "zod";`,
  );
  const execute = `async ({ orderId }) => {
        // Pauses the run until a person answers; the run resumes here, even on another instance.
        const { approved } = await useRun().interrupt<{ approved: boolean }>("approve-refund", { orderId });
        return approved ? { status: "refunded", orderId } : { status: "declined", orderId };
      }`;
  const model = factory ? "model" : `provider("${provider.model}")`;
  const agent = mastra
    ? `new Agent({
  id: "assistant",
  name: "Assistant",
  instructions: "${INSTRUCTIONS}",
  ${factory ? "model" : `model: ${model}`},
  tools: {
    refund: createTool({
      id: "refund",
      description: "Refunds an order once a person approves it",
      inputSchema: z.object({ orderId: z.string() }),
      execute: ${execute},
    }),
  },
})`
    : `new ToolLoopAgent({
  ${factory ? "model" : `model: ${model}`},
  instructions: "${INSTRUCTIONS}",
  tools: {
    refund: tool({
      description: "Refunds an order once a person approves it",
      inputSchema: z.object({ orderId: z.string() }),
      execute: ${execute},
    }),
  },
})`;
  const modelType = mastra ? `ConstructorParameters<typeof Agent>[0]["model"]` : "LanguageModel";
  const body = factory
    ? `/** The agent on any model: the test gives it a scripted one. */
export function createAssistant(model: ${modelType}) {
  return ${agent.replaceAll("\n", "\n  ")};
}

export default createAssistant(provider("${provider.model}"));`
    : `export default ${agent};`;
  return {
    "agents/assistant.ts": `${imports.join("\n")}

// ${mastra ? "A Mastra" : "An AI SDK"} agent on agent-unit's engine: model and tool calls are journaled, so a run that
// resumes after an approval, a restart or a redeploy picks up where it stopped.
// POST /agents/assistant/runs {"input":{"prompt":"Please refund order o_42"}}
const provider = ${provider.create}({ apiKey: env.${provider.key} });

${body}
`,
    ...(factory ? { "test/assistant.test.ts": modelAgentTest(mastra ? "mastra" : "ai-sdk") } : {}),
  };
}

function mastraFiles(answers: Required<InitAnswers>, workers: boolean): Record<string, string> {
  const provider = PROVIDERS[answers.provider];
  const files: Record<string, string> = {};
  files["src/mastra/index.ts"] = `import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { env } from "agent-unit/env";
import { z } from "zod";
import { storage } from "#storage";

// Mastra's own app. agent-unit serves it with Mastra's Hono adapter, so every Mastra route works as
// under \`mastra dev\`: POST /api/agents/assistant/generate {"messages":"What time is it?"}

const clock = createTool({
  id: "clock",
  description: "The current date and time in UTC",
  inputSchema: z.object({}),
  outputSchema: z.object({ now: z.string() }),
  execute: async () => ({ now: new Date().toISOString() }),
});

const assistant = new Agent({
  id: "assistant",
  name: "Assistant",
  instructions: "You are a helpful assistant. Keep answers short.",
  model: { id: "${answers.provider}/${provider.model}", apiKey: env.${provider.key} },
  tools: { clock },
});

export const mastra = new Mastra({ agents: { assistant }, storage });
`;
  files[`src/storage.${answers.store}.ts`] =
    answers.store === "postgres"
      ? `import { PostgresStore } from "@mastra/pg";
import { env } from "agent-unit/env";

// Mastra's Postgres store${workers ? " on every host but Workers" : ""}.
export const storage = new PostgresStore({ id: "${answers.name}", connectionString: env.DATABASE_URL });
`
      : `import { LibSQLStore } from "@mastra/libsql";
import { env } from "agent-unit/env";

// Mastra's LibSQL store${workers ? " on every host but Workers" : ""}: a local file by default. Serverless hosts lose
// local files between invocations, so point MASTRA_DB_URL at a hosted database (Turso) there.
export const storage = new LibSQLStore({ id: "${answers.name}", url: env.MASTRA_DB_URL || "file:./mastra.db", authToken: env.MASTRA_DB_AUTH_TOKEN });
`;
  if (workers) {
    files["src/storage.d1.ts"] = `import { D1Store } from "@mastra/cloudflare-d1";
import { env } from "agent-unit/env";

// Mastra's D1 store on Workers, on the DB binding declared in agent-unit.config.ts.
export const storage = new D1Store({ id: "${answers.name}", binding: env.DB });
`;
  }
  return files;
}

const ENGINE_AGENTS: Record<Exclude<InitFramework, "hono">, string> = {
  mastra: "A Mastra agent",
  "ai-sdk": "An AI SDK agent",
  langgraph: "A LangGraph agent",
  "openai-agents": "An OpenAI Agents SDK agent",
  "agent-unit": "An agent",
};

function readme(answers: Required<InitAnswers>, env: string[]): string {
  const { framework, hosts } = answers;
  const engine = answers.runner === "engine";
  const several = hosts.length > 1;
  const lines = [`# ${answers.name}`, ""];
  const agentName = framework === "agent-unit" ? "refund" : "assistant";
  lines.push(
    engine
      ? `${ENGINE_AGENTS[framework as Exclude<InitFramework, "hono">]} on [agent-unit](https://github.com/farming-labs/agent-unit)'s engine: runs are durable, pause for approval and resume where they stopped, on any host.`
      : framework === "mastra"
      ? "A Mastra app, built for any host by [agent-unit](https://github.com/farming-labs/agent-unit). Mastra owns its routes and storage; agent-unit builds it."
      : framework === "ai-sdk"
        ? "An AI SDK agent on a Hono server, built for any host by [agent-unit](https://github.com/farming-labs/agent-unit)."
        : "A Hono server, built for any host by [agent-unit](https://github.com/farming-labs/agent-unit).",
    "",
    "## Develop",
    "",
    "```sh",
    ...(env.length ? ["cp .env.example .env   # then fill it in"] : []),
    "npm run dev            # http://localhost:3000, reloads on change",
    "```",
    "",
  );
  if (engine) {
    const input = framework === "agent-unit" ? `{"input":{"orderId":"o_42"}}` : `{"input":{"prompt":"Please refund order o_42"}}`;
    const auth = answers.extras.includes("auth") ? ` -H "authorization: Bearer $API_TOKEN"` : "";
    if (auth) lines.push("Set `API_TOKEN` in `.env` to any long random string, and the same value in this shell: `export API_TOKEN=<the same value>`.", "");
    lines.push(
      "Try it: start a run, which pauses for approval, then approve it with the `runId` the first call printed. Both stream the run's events.",
      "",
      "```sh",
      `curl -N -X POST localhost:3000/agents/${agentName}/runs${auth} -H 'content-type: application/json' -H 'accept: text/event-stream' -d '${input}'`,
      `curl -N -X POST localhost:3000/runs/<runId>/resume${auth} -H 'content-type: application/json' -H 'accept: text/event-stream' -d '{"answer":{"approved":true}}'`,
      "```",
      "",
      "Each file in `agents/` is an agent named after the file. `GET /agents` lists them.",
      "",
      ...(auth
        ? []
        : ["Anyone who can reach the server can start and read runs. Before you deploy, set `authorize` in `agent-unit.config.ts` (see agent-unit's README).", ""]),
    );
  }
  if (framework === "mastra" && !engine) lines.push("Try it: `curl -X POST localhost:3000/api/agents/assistant/generate -H 'content-type: application/json' -d '{\"messages\":\"What time is it?\"}'`", "");
  if (answers.extras.includes("background") && !engine) {
    lines.push("`POST /feedback` answers at once and forwards the feedback after, with `waitUntil`: `curl -X POST localhost:3000/feedback -H 'content-type: application/json' -d '{\"rating\":5}'`", "");
  }
  if (!engine && framework !== "mastra" && answers.extras.includes("auth")) {
    lines.push("Set `API_TOKEN` in `.env` to any long random string, and the same value in this shell: `export API_TOKEN=<the same value>`.", "");
  }
  const serverAuth = !engine && answers.extras.includes("auth") ? ` -H "authorization: Bearer $API_TOKEN"` : "";
  if (framework === "ai-sdk" && !engine) lines.push(`Try it: \`curl -X POST localhost:3000/chat${serverAuth} -H 'content-type: application/json' -d '{"prompt":"What time is it?"}'\``, "");
  lines.push("## Build and deploy", "");
  for (const host of hosts) {
    const { label, preset } = HOSTS[host];
    const { start, deploy } = HOSTS[host] as { start?: string; deploy?: string };
    const suffix = several ? `:${host}` : "";
    const build = several ? `npm run build${suffix}` : "npm run build";
    // What to do once before the first deploy, then the commands, then what to know after.
    const before: string[] = [];
    const after: string[] = [];
    const vars = env.length ? " each variable in `.env.example`" : "";
    if (host === "cloudflare") {
      before.push("Sign in once with `npx wrangler@4 login` (in CI, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead).");
      if (framework === "mastra" && !engine) {
        before.push(`Create the D1 database before the first deploy, with \`npx wrangler@4 d1 create ${answers.name}\`, and put the id it prints in \`agent-unit.config.ts\`.`);
      }
      if (vars) before.push(`Set${vars} as a secret: \`npx wrangler@4 secret put <NAME> --name ${workerName(answers.name)}\`.`);
      after.push(`\`npm run preview${suffix}\` runs the build on Cloudflare's runtime on your machine first.`);
      if (engine) after.push("Each run gets its own Durable Object; the build writes their bindings into `wrangler.json`.");
    }
    if (host === "vercel") {
      before.push(`Link the project once with \`npx vercel link\`${vars ? `, and add${vars}: \`npx vercel env add <NAME> production\`` : ""}.`);
      if (engine) after.push("The sweep that wakes sleeping runs runs once a day, which Vercel's Hobby plan allows; on Pro, remove `sweep` from `vercel` in `agent-unit.config.ts` for a sweep every minute.");
    }
    if (host === "netlify") {
      before.push(
        `Sign in once with \`npx netlify-cli login\` (in CI, set \`NETLIFY_AUTH_TOKEN\`); the first deploy asks to create or link a site.${vars ? ` Set${vars}: \`npx netlify-cli env:set <NAME> <value>\`.` : ""}`,
      );
      after.push("Or connect the repository in Netlify: `netlify.toml` sets the build command and the publish directory.");
    }
    if (host === "lambda") {
      before.push(
        "Install the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) and sign in to AWS (`aws configure` or `aws sso login`).",
        `The first deploy asks for a stack name, a region${vars ? " and each variable" : ""}, and saves your answers in \`samconfig.toml\`: \`npm run deploy${suffix} -- --guided\`.`,
      );
      after.push("`template.yaml` describes the function: Node.js 22, the handler `index.handler`, a 5-minute timeout and a public function URL, printed as `Url` when the deploy finishes.");
      // Lambda has no scheduler of its own for the sweep, unlike Workers, Vercel and Netlify here.
      if (engine) {
        after.push(
          "Nothing wakes sleeping runs or recovers stalled ones on Lambda by itself: schedule `POST <Url>/__agent-unit/sweep` with `Authorization: Bearer <AGENT_UNIT_SECRET>` every minute (an EventBridge Scheduler target, or any cron service).",
        );
      }
    }
    if (answers.extras.includes("task") && (host === "netlify" || host === "lambda")) {
      after.push(`The daily task does not run on its own here: ${label} has no scheduler agent-unit drives. Run \`npm run task\` from a scheduler of yours, or let a host that runs it take the task.`);
    }
    if (engine && host === "vercel") {
      // Vercel's Marketplace sets KV_REST_API_URL and KV_REST_API_TOKEN, which the runtime reads too.
      after.push(
        "Runs are kept in [Upstash](https://upstash.com) Redis here. The quickest way to get one is Upstash's Redis in the project's Storage tab on Vercel: it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which agent-unit reads, so the two `UPSTASH_REDIS_REST_` variables need not be added.",
      );
    } else if (engine && (SERVERLESS as string[]).includes(host)) after.push("Runs are kept in [Upstash](https://upstash.com) Redis here, from `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.");
    lines.push(`**${label}** (\`${preset}\`)`, "");
    for (const line of before) lines.push(line, "");
    lines.push("```sh");
    const { buildsItself } = HOSTS[host] as { buildsItself?: boolean };
    if (deploy) lines.push(`npm run deploy${suffix}   # ${buildsItself ? `${deploy}, which builds with netlify.toml` : `builds, then ${deploy}`}`);
    else lines.push(build);
    if (start) lines.push(`npm run start${suffix}`);
    lines.push("```", "");
    for (const line of after) lines.push(line, "");
  }
  if (env.length && hosts.some((host) => "start" in HOSTS[host])) {
    lines.push("A built server reads its environment, not `.env`. To try a Node build with your `.env`: `node --env-file=.env .output/server/index.mjs` (Bun reads `.env` on its own).", "");
  }
  if (answers.extras.includes("test")) {
    const offline = engine && framework !== "agent-unit" ? "runs offline on a scripted model: no server, no API key" : "runs offline, with no server";
    lines.push("## Test", "", "```sh", `npm test               # ${offline}`, "```", "");
  }
  if (env.length) lines.push("## Environment", "", ...env.map((key) => `- \`${key}\``), "");
  return `${lines.join("\n")}`;
}
