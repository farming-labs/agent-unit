import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  asksProvider,
  asksRunner,
  asksStore,
  defaultRunner,
  detectFramework,
  EXTRAS,
  extrasFor,
  FRAMEWORKS,
  HOSTS,
  initFiles,
  mergeIntoApp,
  PROVIDERS,
  RUNNERS,
  runnerFor,
  STORES,
  type InitAnswers,
  type InitExtra,
  type InitFramework,
  type InitHost,
  type InitProvider,
  type InitRunner,
  type InitStore,
} from "./init-templates";

// `agent-unit init [dir]`: a new app with every choice made up front. Each answer can also come from
// a flag, so scripts and CI run it without a terminal.

export interface InitOptions {
  /** Where to create the app. Asked for when missing. */
  dir?: string;
  framework?: string;
  /** Who runs a Mastra or AI SDK agent: `engine` (agent-unit's) or `server` (the framework's own). */
  runner?: string;
  /** Comma-separated or a list: node, bun, deno, cloudflare, vercel, netlify, lambda. */
  hosts?: string | string[];
  store?: string;
  provider?: string;
  /** Comma-separated or a list: task, auth. `none` for none. */
  extras?: string | string[];
  /** Install dependencies afterwards. Asked for when missing. */
  install?: boolean;
  /** Take the default for every question not answered by a flag. */
  yes?: boolean;
  /** The agent-unit version the app depends on. */
  version: string;
  logger?: { info(message: string): void; warn(message: string): void };
}

export interface InitResult {
  root: string;
  /** Whether agent-unit was added to an app that was already there. */
  existing: boolean;
  answers: InitAnswers;
  files: string[];
  installed: boolean;
  packageManager: string;
}

type Choices<K extends string> = Record<K, { label: string; hint?: string }>;

const list = (value: string | string[] | undefined) =>
  value === undefined ? undefined : (Array.isArray(value) ? value : [value]).flatMap((part) => part.split(",")).map((part) => part.trim()).filter(Boolean);

function pick<K extends string>(choices: Choices<K>, value: string, flag: string): K {
  if (value in choices) return value as K;
  throw new Error(`--${flag} ${value} is not one of: ${Object.keys(choices).join(", ")}.`);
}

/** The package manager that ran us (`npx`, `pnpm dlx`, `bunx`, ...), so install and the next steps use it. */
export function packageManager(userAgent = process.env.npm_config_user_agent ?? ""): string {
  const name = userAgent.split("/")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

/** Writes a new app. Throws with a message for the user when the answers or the directory do not work. */
export async function init(options: InitOptions): Promise<InitResult> {
  const logger = options.logger ?? { info: console.log, warn: console.warn };
  const interactive = !options.yes && process.stdin.isTTY && process.stdout.isTTY;
  const consola = interactive ? (await import("consola")).consola : undefined;
  const prompt = consola?.prompt.bind(consola);
  // Without a terminal every answer needs its flag, or --yes for the defaults.
  const ask = async <T>(question: Parameters<NonNullable<typeof prompt>>[1] & { message: string }, fallback: T, flag: string): Promise<T> => {
    if (options.yes) return fallback;
    if (!prompt) throw new Error(`No terminal to ask "${question.message}" in: pass ${flag}, or --yes for the defaults.`);
    const answer = await prompt(question.message, { ...question, cancel: "symbol" } as never);
    if (typeof answer === "symbol") throw new Error("Cancelled.");
    return answer as T;
  };
  const choicesOf = <K extends string>(choices: Choices<K>) =>
    (Object.entries(choices) as [K, { label: string; hint?: string }][]).map(([value, { label, hint }]) => ({ value, label, hint }));

  // Where: a new directory, or an app that is already there (one with a package.json).
  const inApp = existsSync("package.json");
  const where = inApp ? "." : "my-agent";
  const dir =
    options.dir ??
    (await ask(
      { message: inApp ? "Where should the app go? (. adds agent-unit to this app)" : "Where should the app go?", type: "text", placeholder: where, initial: where },
      where,
      "the directory, as in agent-unit init my-agent",
    ));
  const root = resolve(dir);
  const shown = relative(process.cwd(), root) || ".";
  const manifest = existsSync(join(root, "package.json")) ? (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, any>) : undefined;
  if (manifest) {
    const config = readdirSync(root).find((entry) => /^agent-unit\.config\.[cm]?[jt]s$/.test(entry));
    if (config) throw new Error(`${shown} already has ${config}.`);
  } else if (existsSync(root) && readdirSync(root).some((entry) => entry !== ".git")) {
    throw new Error(`${shown} is not empty. Choose a new directory, or run init in an app with a package.json to add agent-unit to it.`);
  }

  // What: each question only offers what fits the answers before it. In an existing app the
  // framework it already uses is the default.
  const detected = (manifest && detectFramework(manifest)) || "mastra";
  const framework: InitFramework = options.framework
    ? pick(FRAMEWORKS, options.framework, "framework")
    : await ask({ message: "Agent framework", type: "select", options: choicesOf(FRAMEWORKS), initial: detected }, detected, "--framework");
  // An existing app's own server module, where agent-unit's templates or Hono's starter put one.
  const ownServer = manifest
    ? ["src/server", "src/index"].flatMap((base) => ["ts", "mts", "js", "mjs"].map((ext) => `${base}.${ext}`)).find((path) => existsSync(join(root, path)))
    : undefined;
  let runner: InitRunner = runnerFor(framework);
  if (asksRunner(framework)) {
    const fallback = ownServer && framework === "ai-sdk" ? "server" : defaultRunner(framework);
    const own = framework === "mastra" ? "Mastra's own server, routes and storage" : "a Hono server you write, streaming the agent's answer";
    const runners: Choices<InitRunner> = { engine: RUNNERS.engine, server: { label: "Its own server", hint: own } };
    runner = options.runner
      ? pick(RUNNERS, options.runner, "runner")
      : await ask({ message: "Run it on", type: "select", options: choicesOf(runners), initial: fallback }, fallback, "--runner");
  } else if (options.runner && pick(RUNNERS, options.runner, "runner") !== runner) {
    throw new Error(`--runner only applies to Mastra and AI SDK apps.`);
  }
  const hostFlag = list(options.hosts);
  const hosts: InitHost[] = hostFlag
    ? hostFlag.map((host) => pick(HOSTS, host, "hosts"))
    : await ask({ message: "Hosts to deploy to (space to select)", type: "multiselect", options: choicesOf(HOSTS), initial: ["node"], required: true }, ["node"], "--hosts");
  const normalizedHosts = hosts.map((host) => (typeof host === "object" ? (host as { value: InitHost }).value : host));
  if (!normalizedHosts.length) throw new Error("Choose at least one host.");
  // An existing Mastra instance keeps its own storage and model keys: nothing to ask about them.
  const ownMastra =
    !!manifest && framework === "mastra" && runner === "server" && ["ts", "mts", "js", "mjs"].some((ext) => existsSync(join(root, `src/mastra/index.${ext}`)));
  const offStoreHosts = normalizedHosts.filter((host) => host !== "cloudflare");
  let store: InitStore | undefined;
  if (asksStore(framework, runner) && !ownMastra) {
    if (options.store) store = pick(STORES, options.store, "store");
    else if (offStoreHosts.length) {
      const where = normalizedHosts.includes("cloudflare") ? " (Workers use D1)" : "";
      store = await ask({ message: `Mastra storage${where}`, type: "select", options: choicesOf(STORES), initial: "libsql" }, "libsql", "--store");
    }
  }
  let provider: InitProvider | undefined;
  // The app's own server is built as it is: its model and its routes are already its own.
  const keepsServer = !!ownServer && runner === "server" && framework !== "mastra";
  if (asksProvider(framework) && !ownMastra && !keepsServer) {
    provider = options.provider
      ? pick(PROVIDERS, options.provider, "provider")
      : await ask({ message: "Model provider", type: "select", options: choicesOf(PROVIDERS), initial: "openai" }, "openai", "--provider");
  }
  const allowed = extrasFor(framework, runner).filter((extra) => !(keepsServer && extra === "auth"));
  const extraFlag = list(options.extras);
  const extras: InitExtra[] = extraFlag
    ? extraFlag.filter((extra) => extra !== "none").map((extra) => {
        const value = pick(EXTRAS, extra, "extras");
        if (keepsServer && value === "auth") throw new Error(`--extras auth does not apply to your own server (${ownServer}): protect its routes there.`);
        if (!allowed.includes(value)) throw new Error(`--extras ${value} does not apply to ${FRAMEWORKS[framework].label} apps${asksRunner(framework) ? ` on ${runner === "engine" ? "agent-unit's engine" : "their own server"}` : ""}.`);
        return value;
      })
    : (
        await ask<(InitExtra | { value: InitExtra })[]>(
          {
            message: "Extras (space to select, enter to skip)",
            type: "multiselect",
            options: choicesOf(Object.fromEntries(allowed.map((key) => [key, EXTRAS[key]])) as Choices<InitExtra>),
            required: false,
          },
          [],
          "--extras",
        )
      ).map((extra) => (typeof extra === "object" ? extra.value : extra));

  const name = typeof manifest?.name === "string" ? manifest.name.replace(/^@[^/]+\//, "") : basename(root);
  const answers: InitAnswers = { name, framework, runner, hosts: normalizedHosts, store, provider, extras };
  const plan = initFiles(answers, options.version, { mastra: ownMastra, server: ownServer && `./${ownServer}` });
  const read = (path: string) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined);
  const merge = manifest ? mergeIntoApp(plan.files, read) : undefined;
  const written = merge?.files ?? plan.files;

  for (const [path, content] of Object.entries(written)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const what = runner === "engine" && framework !== "agent-unit" ? `${FRAMEWORKS[framework].label} on agent-unit's engine` : FRAMEWORKS[framework].label;
  const forHosts = normalizedHosts.map((host) => HOSTS[host].label).join(", ");
  if (merge) {
    logger.info(`Added agent-unit to ${shown === "." ? "this app" : shown} (${what} for ${forHosts}${ownServer && runner === "server" ? `, building ${ownServer}` : ""}).`);
    if (merge.created.length) logger.info(`  created: ${merge.created.join(", ")}`);
    if (merge.updated.length) logger.info(`  updated: ${merge.updated.join(", ")}`);
    if (merge.kept.length) logger.info(`  kept yours: ${merge.kept.join(", ")}`);
    const renamed = Object.entries(merge.renamed);
    if (renamed.length) logger.info(`  your ${renamed.map(([from]) => from).join(", ")} script(s) stay; agent-unit's are ${renamed.map(([, to]) => to).join(", ")}`);
  } else {
    logger.info(`Created ${shown} (${what} for ${forHosts}).`);
  }

  const manager = packageManager();
  const install = options.install ?? (await ask({ message: `Install dependencies with ${manager}?`, type: "confirm", initial: true }, true, "--install or --no-install"));
  let installed = false;
  if (install) {
    installed = spawnSync(manager, ["install"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" }).status === 0;
    if (!installed) logger.warn(`${manager} install failed. Run it yourself in ${relative(process.cwd(), root) || "."}.`);
  }

  const run = manager === "npm" ? "npm run" : manager;
  const steps = [
    ...(shown === "." ? [] : [`cd ${shown}`]),
    ...(installed ? [] : [`${manager} install`]),
    ...(plan.env.length ? [`${merge ? "add the new variables in .env.example to .env" : "cp .env.example .env   # then fill it in"}`] : []),
    `${run} ${merge?.renamed.dev ?? "dev"}`,
  ];
  const after = merge ? "Build for a host with `agent-unit build --preset <preset>`; the scripts in package.json do it for each one you chose." : "The README in the app lists how to build and deploy for each host.";
  logger.info(`\nNext:\n${steps.map((step) => `  ${step}`).join("\n")}\n\n${after}`);
  return { root, existing: !!merge, answers, files: Object.keys(written), installed, packageManager: manager };
}
