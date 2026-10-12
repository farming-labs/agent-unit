// The files `agent-unit init` writes, as a pure function of the answers, so every combination can be
// checked without touching the disk. Each template mirrors an app the e2e suite already runs.

export const FRAMEWORKS = {
  mastra: { label: "Mastra", hint: "Mastra's own server, routes and storage" },
  "ai-sdk": { label: "AI SDK", hint: "an AI SDK agent on a Hono server" },
  hono: { label: "None", hint: "a plain Hono server to bring your own agent code to" },
} as const;

export const HOSTS = {
  node: { label: "Node", preset: "node-server", start: "node .output/server/index.mjs" },
  bun: { label: "Bun", preset: "bun", start: "bun run .output/server/index.mjs" },
  deno: { label: "Deno", preset: "deno-server", start: "deno run -A .output/server/index.mjs" },
  cloudflare: { label: "Cloudflare Workers", preset: "cloudflare-module", deploy: "npx wrangler deploy" },
  vercel: { label: "Vercel", preset: "vercel", deploy: "npx vercel deploy --prebuilt" },
  netlify: { label: "Netlify", preset: "netlify" },
  lambda: { label: "AWS Lambda", preset: "aws-lambda" },
} as const satisfies Record<string, { label: string; preset: string; start?: string; deploy?: string }>;

/** Mastra's store on every host but Workers, where it is always D1. */
export const STORES = {
  libsql: { label: "LibSQL", hint: "a local file, or Turso in production" },
  postgres: { label: "Postgres", hint: "any Postgres, such as Neon or Supabase" },
} as const;

export const PROVIDERS = {
  openai: { label: "OpenAI", package: "@ai-sdk/openai", create: "createOpenAI", key: "OPENAI_API_KEY", model: "gpt-5-mini" },
  anthropic: { label: "Anthropic", package: "@ai-sdk/anthropic", create: "createAnthropic", key: "ANTHROPIC_API_KEY", model: "claude-sonnet-4-5" },
  google: { label: "Google", package: "@ai-sdk/google", create: "createGoogleGenerativeAI", key: "GOOGLE_GENERATIVE_AI_API_KEY", model: "gemini-2.5-flash" },
} as const;

export const EXTRAS = {
  task: { label: "A scheduled task", hint: "runs every day with the host's own scheduler" },
  auth: { label: "Bearer-token auth", hint: "API_TOKEN protects the agent route" },
} as const;

export type InitFramework = keyof typeof FRAMEWORKS;
export type InitHost = keyof typeof HOSTS;
export type InitStore = keyof typeof STORES;
export type InitProvider = keyof typeof PROVIDERS;
export type InitExtra = keyof typeof EXTRAS;

export interface InitAnswers {
  /** package.json name. */
  name: string;
  framework: InitFramework;
  /** At least one; the first is what `build` builds. */
  hosts: InitHost[];
  /** Mastra's store off Workers. Default libsql. */
  store?: InitStore;
  /** Model provider, for frameworks that call a model. Default openai. */
  provider?: InitProvider;
  extras?: InitExtra[];
}

/** The questions that apply to a framework, so prompts and flags agree. */
export const asksProvider = (framework: InitFramework) => framework !== "hono";
export const asksStore = (framework: InitFramework) => framework === "mastra";
export const extrasFor = (framework: InitFramework): InitExtra[] => (framework === "mastra" ? ["task"] : ["task", "auth"]);

// Ranges start at the versions agent-unit's own tests run against.
const VERSIONS: Record<string, string> = {
  "@ai-sdk/anthropic": "^4.0.21",
  "@ai-sdk/google": "^4.0.24",
  "@ai-sdk/openai": "^4.0.20",
  "@mastra/cloudflare-d1": "^1.4.1",
  "@mastra/core": "^1.74.0",
  "@mastra/hono": "^1.7.16",
  "@mastra/libsql": "^1.25.1",
  "@mastra/pg": "^1.29.0",
  "@types/node": "^20.19.0",
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

/** Fills in defaults and drops answers that do not apply, so `files()` sees one shape. */
export function normalizeAnswers(answers: InitAnswers): Required<InitAnswers> {
  if (!answers.hosts.length) throw new Error("Choose at least one host.");
  const allowed = extrasFor(answers.framework);
  return {
    name: packageName(answers.name),
    framework: answers.framework,
    hosts: [...new Set(answers.hosts)],
    store: answers.store ?? "libsql",
    provider: answers.provider ?? "openai",
    extras: [...new Set(answers.extras ?? [])].filter((extra) => allowed.includes(extra)),
  };
}

export interface InitPlan {
  files: Record<string, string>;
  /** Environment variables the app reads, for the summary. */
  env: string[];
}

/** Everything `agent-unit init` writes for these answers, by path relative to the new app. */
export function initFiles(input: InitAnswers, agentUnitVersion: string): InitPlan {
  const answers = normalizeAnswers(input);
  const { framework, hosts, extras } = answers;
  const provider = PROVIDERS[answers.provider];
  const workers = hosts.includes("cloudflare");
  const task = extras.includes("task");
  const auth = extras.includes("auth");
  const files: Record<string, string> = {};

  // Dependencies
  const dependencies = ["zod"];
  const devDependencies = ["typescript", "@types/node"];
  if (framework === "mastra") {
    dependencies.push("@mastra/core", "@mastra/hono", "hono", answers.store === "postgres" ? "@mastra/pg" : "@mastra/libsql");
    if (workers) dependencies.push("@mastra/cloudflare-d1");
  } else {
    dependencies.push("hono");
    if (framework === "ai-sdk") dependencies.push("ai", provider.package);
  }

  // Scripts: `build` is the first host; with several, each also has its own. Deploy CLIs run through
  // npx rather than being installed: wrangler's peer range for @cloudflare/workers-types conflicts
  // with @mastra/cloudflare-d1's, and npm refuses to install both.
  const scripts: Record<string, string> = { dev: "agent-unit dev", build: `agent-unit build --preset ${HOSTS[hosts[0]!].preset}` };
  for (const host of hosts) {
    const { preset } = HOSTS[host];
    const { start, deploy } = HOSTS[host] as { start?: string; deploy?: string };
    const suffix = hosts.length > 1 ? `:${host}` : "";
    if (suffix) scripts[`build${suffix}`] = `agent-unit build --preset ${preset}`;
    if (start) scripts[`start${suffix}`] = start;
    if (deploy) scripts[`deploy${suffix}`] = `agent-unit build --preset ${preset} && ${deploy}`;
  }
  if (task) scripts.task = "agent-unit task daily-summary";
  scripts.typecheck = "tsc --noEmit";

  const manifest: Record<string, unknown> = { name: answers.name, private: true, type: "module", scripts };
  if (framework === "mastra") {
    // Each host gets its own store: the build for Workers resolves `workerd`, every other host `default`.
    const store = `./src/storage.${answers.store}.ts`;
    manifest.imports = { "#storage": workers ? { workerd: "./src/storage.d1.ts", default: store } : store };
  }
  manifest.dependencies = { "agent-unit": `^${agentUnitVersion}`, ...sorted(dependencies) };
  manifest.devDependencies = sorted(devDependencies);
  files["package.json"] = `${JSON.stringify(manifest, null, 2)}\n`;

  // agent-unit.config.ts
  const config: string[] = [];
  if (framework !== "mastra") config.push(`  server: "./src/server.ts",`);
  if (workers && framework === "mastra") {
    config.push(
      `  // Mastra's D1 store on Workers. Create the database with \`npx wrangler d1 create ${answers.name}\``,
      `  // and put the id it prints here.`,
      `  cloudflare: {`,
      `    wrangler: { d1_databases: [{ binding: "DB", database_name: "${answers.name}", database_id: "00000000-0000-0000-0000-000000000000" }] },`,
      `  },`,
    );
  }
  if (task) config.push(`  tasks: { "daily-summary": { schedule: "0 8 * * *", handler: "./src/tasks/daily-summary.ts" } },`);
  const configComment =
    framework === "mastra" ? "// No `server`: agent-unit finds src/mastra/index.ts and builds Mastra's own server.\n" : "// Your server, built for every host with `agent-unit build --preset <host>`.\n";
  files["agent-unit.config.ts"] = `import { defineConfig } from "agent-unit";\n\n${configComment}export default defineConfig({${config.length ? `\n${config.join("\n")}\n` : ""}});\n`;

  // The app
  if (framework === "mastra") Object.assign(files, mastraFiles(answers, workers));
  else files["src/server.ts"] = serverFile(framework, provider, auth);
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
  if (framework !== "hono") env.push([provider.key, `Your ${provider.label} API key`]);
  if (framework === "mastra" && answers.store === "libsql") {
    env.push(["MASTRA_DB_URL", "LibSQL database. Default file:./mastra.db; serverless hosts need a hosted one, such as libsql://<db>.turso.io"]);
    env.push(["MASTRA_DB_AUTH_TOKEN", "Token for a hosted LibSQL database (Turso)"]);
  }
  if (framework === "mastra" && answers.store === "postgres") env.push(["DATABASE_URL", "Postgres connection string"]);
  if (auth) env.push(["API_TOKEN", "Clients send it as `Authorization: Bearer <token>`"]);
  if (env.length) files[".env.example"] = env.map(([key, comment]) => `# ${comment}\n${key}=\n`).join("\n");

  files[".gitignore"] = ["node_modules", ".output", ".agent-unit", ".data", ".nitro", ".vercel", ".netlify", ".wrangler", "*.db", ".env", ".env.*", "!.env.example", ".dev.vars", ""].join("\n");
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
      include: ["src", "agent-unit.config.ts"],
    },
    null,
    2,
  )}\n`;
  files["README.md"] = readme(answers, env.map(([key]) => key));
  return { files, env: env.map(([key]) => key) };
}

function serverFile(framework: Exclude<InitFramework, "mastra">, provider: (typeof PROVIDERS)[InitProvider], auth: boolean): string {
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
  imports.push(`import { env } from "agent-unit/env";`);
  lines.push(`const app = new Hono();`, ``, `app.get("/", (c) => c.json({ ok: true }));`, ``);
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
export const storage = new LibSQLStore({ id: "${answers.name}", url: env.MASTRA_DB_URL ?? "file:./mastra.db", authToken: env.MASTRA_DB_AUTH_TOKEN });
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

function readme(answers: Required<InitAnswers>, env: string[]): string {
  const { framework, hosts } = answers;
  const several = hosts.length > 1;
  const lines = [`# ${answers.name}`, ""];
  lines.push(
    framework === "mastra"
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
  if (framework === "mastra") lines.push("Try it: `curl -X POST localhost:3000/api/agents/assistant/generate -H 'content-type: application/json' -d '{\"messages\":\"What time is it?\"}'`", "");
  if (framework === "ai-sdk") lines.push("Try it: `curl -X POST localhost:3000/chat -H 'content-type: application/json' -d '{\"prompt\":\"What time is it?\"}'`", "");
  lines.push("## Build and deploy", "");
  for (const host of hosts) {
    const { label, preset } = HOSTS[host];
    const { start, deploy } = HOSTS[host] as { start?: string; deploy?: string };
    const suffix = several ? `:${host}` : "";
    const build = several ? `npm run build${suffix}` : "npm run build";
    lines.push(`**${label}** (\`${preset}\`)`, "", "```sh");
    if (deploy) lines.push(`npm run deploy${suffix}   # builds, then ${deploy}`);
    else lines.push(build);
    if (start) lines.push(`npm run start${suffix}`);
    lines.push("```", "");
    if (host === "cloudflare" && framework === "mastra") {
      lines.push(`Create the D1 database once with \`npx wrangler d1 create ${answers.name}\` and put its id in \`agent-unit.config.ts\`.`, "");
    }
    if (host === "cloudflare" && env.length) lines.push(`Set secrets with \`npx wrangler secret put <NAME>\`.`, "");
    if (host === "vercel") lines.push("Run `npx vercel link` once first. Set environment variables in the Vercel project.", "");
    if (host === "netlify") lines.push(`Connect the repository in Netlify with \`${build}\` as the build command.`, "");
    if (host === "lambda") lines.push("Deploy `.output/server` with your usual tool (SAM, CDK, Terraform) as a Node.js function behind a function URL or API Gateway.", "");
  }
  if (env.length) lines.push("## Environment", "", ...env.map((key) => `- \`${key}\``), "");
  return `${lines.join("\n")}`;
}
