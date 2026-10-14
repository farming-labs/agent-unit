import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { init, packageManager } from "../src/build/init";
import { detectFramework, initFiles, mergeIntoApp, packageName } from "../src/build/init-templates";

const manifest = (files: Record<string, string>) => JSON.parse(files["package.json"]!) as Record<string, any>;

describe("the files agent-unit init writes", () => {
  it("builds a Mastra app with its own store per host: D1 on Workers, the chosen store elsewhere", () => {
    const { files, env } = initFiles({ name: "Refund Desk", framework: "mastra", hosts: ["node", "cloudflare"], store: "libsql", provider: "anthropic" }, "0.1.16");
    const pkg = manifest(files);
    expect(pkg.name).toBe("refund-desk");
    expect(pkg.imports).toEqual({ "#storage": { workerd: "./src/storage.d1.ts", default: "./src/storage.libsql.ts" } });
    expect(pkg.dependencies).toMatchObject({ "agent-unit": "^0.1.16", "@mastra/core": expect.any(String), "@mastra/hono": expect.any(String), "@mastra/libsql": expect.any(String), "@mastra/cloudflare-d1": expect.any(String) });
    expect(pkg.dependencies).not.toHaveProperty("@mastra/pg");
    // wrangler runs through npx: installed, its workers-types peer range conflicts with Mastra's D1 store's.
    expect(pkg.devDependencies).not.toHaveProperty("wrangler");
    expect(pkg.scripts).toMatchObject({
      dev: "agent-unit dev",
      build: "agent-unit build --preset node-server",
      "build:node": "agent-unit build --preset node-server",
      "start:node": "node .output/server/index.mjs",
      "deploy:cloudflare": "agent-unit build --preset cloudflare-module && npx wrangler@4 deploy",
      "preview:cloudflare": "agent-unit build --preset cloudflare-module && npx wrangler@4 dev",
    });
    expect(files["agent-unit.config.ts"]).not.toContain("server:");
    expect(files["agent-unit.config.ts"]).toContain(`d1_databases: [{ binding: "DB", database_name: "refund-desk"`);
    expect(files["src/mastra/index.ts"]).toContain(`model: { id: "anthropic/claude-sonnet-4-5", apiKey: env.ANTHROPIC_API_KEY }`);
    expect(files["src/storage.d1.ts"]).toContain("binding: env.DB");
    // `cp .env.example .env` leaves MASTRA_DB_URL empty: that has to fall back to the local file too.
    expect(files["src/storage.libsql.ts"]).toContain(`url: env.MASTRA_DB_URL || "file:./mastra.db"`);
    expect(env).toEqual(["ANTHROPIC_API_KEY", "MASTRA_DB_URL", "MASTRA_DB_AUTH_TOKEN"]);
    expect(files["README.md"]).toContain("npx wrangler@4 d1 create refund-desk");
  });

  it("uses one store and no D1 when Workers is not a host", () => {
    const { files } = initFiles({ name: "app", framework: "mastra", hosts: ["vercel"], store: "postgres" }, "0.1.16");
    const pkg = manifest(files);
    expect(pkg.imports).toEqual({ "#storage": "./src/storage.postgres.ts" });
    expect(pkg.dependencies).toHaveProperty("@mastra/pg");
    expect(pkg.dependencies).not.toHaveProperty("@mastra/cloudflare-d1");
    expect(pkg.scripts).toMatchObject({ build: "agent-unit build --preset vercel", deploy: "agent-unit build --preset vercel && npx vercel deploy --prebuilt --prod" });
    expect(Object.keys(files).filter((path) => path.startsWith("src/storage"))).toEqual(["src/storage.postgres.ts"]);
    expect(files["agent-unit.config.ts"]).not.toContain("cloudflare");
  });

  it("puts an AI SDK agent on a Hono server, with auth and a task when asked", () => {
    const { files, env } = initFiles({ name: "chat", framework: "ai-sdk", runner: "server", hosts: ["cloudflare", "netlify"], provider: "google", extras: ["auth", "task"] }, "0.1.16");
    const pkg = manifest(files);
    expect(pkg.dependencies).toMatchObject({ ai: expect.any(String), hono: expect.any(String), "@ai-sdk/google": expect.any(String) });
    expect(pkg.dependencies).not.toHaveProperty("@ai-sdk/openai");
    expect(pkg.scripts).toMatchObject({ build: "agent-unit build --preset cloudflare-module", "build:netlify": "agent-unit build --preset netlify", task: "agent-unit task daily-summary" });
    expect(files["agent-unit.config.ts"]).toContain(`server: "./src/server.ts"`);
    expect(files["agent-unit.config.ts"]).toContain(`tasks: { "daily-summary"`);
    expect(files["src/server.ts"]).toContain(`import { createGoogleGenerativeAI } from "@ai-sdk/google";`);
    expect(files["src/server.ts"]).toContain(`app.use("/chat", bearerAuth(`);
    expect(files["src/tasks/daily-summary.ts"]).toBeDefined();
    expect(env).toEqual(["GOOGLE_GENERATIVE_AI_API_KEY", "API_TOKEN"]);
  });

  it("writes a plain Hono server with no model and no environment file", () => {
    const { files, env } = initFiles({ name: "plain", framework: "hono", hosts: ["node"], provider: "anthropic" }, "0.1.16");
    expect(Object.keys(manifest(files).dependencies).sort()).toEqual(["agent-unit", "hono", "zod"]);
    expect(files["src/server.ts"]).not.toContain("ai-sdk");
    expect(files[".env.example"]).toBeUndefined();
    expect(env).toEqual([]);
    // One host: no per-host script names.
    expect(Object.keys(manifest(files).scripts)).toEqual(["dev", "build", "start", "typecheck"]);
  });

  it("drops extras that do not apply to the framework", () => {
    const { files } = initFiles({ name: "m", framework: "mastra", hosts: ["node"], extras: ["auth", "task"] }, "0.1.16");
    expect(files[".env.example"]).not.toContain("API_TOKEN");
    expect(files["src/tasks/daily-summary.ts"]).toBeDefined();
  });

  it("runs an AI SDK agent on the engine by default, with each host's run storage set per preset", () => {
    const { files, env } = initFiles({ name: "desk", framework: "ai-sdk", hosts: ["node", "cloudflare", "vercel", "lambda"], provider: "anthropic", extras: ["auth"] }, "0.1.16");
    const pkg = manifest(files);
    expect(Object.keys(pkg.dependencies)).toEqual(["agent-unit", "@ai-sdk/anthropic", "@upstash/redis", "ai", "zod"]);
    expect(pkg.imports).toBeUndefined();
    const config = files["agent-unit.config.ts"]!;
    expect(config).not.toContain("server:");
    expect(config).toContain(`"cloudflare-module": { runtime: "durable-objects" },`);
    expect(config).toContain(`    vercel: { storage: { driver: "upstash" }, sweep: "0 0 * * *" },\n    "aws-lambda": { storage: { driver: "upstash" } },`);
    // No secret in the config: storage options are written into the build output.
    expect(config).not.toMatch(/UPSTASH_REDIS_REST_(URL|TOKEN)[^\n]*[,}]/);
    expect(config).toContain(`authorize: (request) => !!env.API_TOKEN`);
    expect(files["agents/assistant.ts"]).toContain(`new ToolLoopAgent({`);
    expect(files["agents/assistant.ts"]).toContain(`model: provider("claude-sonnet-4-5")`);
    expect(files["agents/assistant.ts"]).toContain(`useRun().interrupt<{ approved: boolean }>("approve-refund"`);
    expect(files["src/server.ts"]).toBeUndefined();
    expect(env).toEqual(["ANTHROPIC_API_KEY", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "AGENT_UNIT_SECRET", "CRON_SECRET", "API_TOKEN"]);
    expect(files["README.md"]).toContain(`curl -N -X POST localhost:3000/agents/assistant/runs -H "authorization: Bearer $API_TOKEN"`);
    expect(files["README.md"]).toContain("Each run gets its own Durable Object");
    // Vercel's Marketplace Redis works as is; Lambda needs the Upstash variables.
    expect(files["README.md"]).toContain("it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which agent-unit reads");
    expect(files["README.md"]).toContain("Runs are kept in [Upstash](https://upstash.com) Redis here, from `UPSTASH_REDIS_REST_URL`");
  });

  it("keeps runs on disk with no presets when every host is a server, and runs Mastra agents on the engine when asked", () => {
    const { files, env } = initFiles({ name: "m", framework: "mastra", runner: "engine", hosts: ["node", "bun"], extras: ["auth"] }, "0.1.16");
    const pkg = manifest(files);
    expect(Object.keys(pkg.dependencies)).toEqual(["agent-unit", "@ai-sdk/openai", "@mastra/core", "ai", "zod"]);
    expect(pkg.imports).toBeUndefined();
    expect(files["agent-unit.config.ts"]).not.toContain("presets");
    expect(files["agents/assistant.ts"]).toContain(`import { Agent } from "@mastra/core/agent";`);
    expect(Object.keys(files).filter((path) => path.startsWith("src/"))).toEqual([]);
    expect(env).toEqual(["OPENAI_API_KEY", "API_TOKEN"]);
  });

  it("writes a LangGraph agent on the provider's LangChain chat model, pausing inside its tool", () => {
    const { files, env } = initFiles({ name: "g", framework: "langgraph", runner: "server", hosts: ["node"], provider: "google" }, "0.1.16");
    expect(Object.keys(manifest(files).dependencies)).toEqual(["agent-unit", "@langchain/core", "@langchain/google-genai", "@langchain/langgraph", "zod"]);
    const agent = files["agents/assistant.ts"]!;
    expect(agent).toContain(`import { ChatGoogleGenerativeAI } from "@langchain/google-genai";`);
    expect(agent).toContain(`new ChatGoogleGenerativeAI({ model: "gemini-2.5-flash", apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY })`);
    expect(agent).toContain(`.addNode("tools", new ToolNode([refund]))`);
    expect(agent).toContain(`interrupt<{ orderId: string }, { approved: boolean }>({ orderId })`);
    expect(env).toEqual(["GOOGLE_GENERATIVE_AI_API_KEY"]);
    expect(files["README.md"]).toContain("A LangGraph agent on [agent-unit]");
  });

  it("writes an OpenAI Agents SDK agent on OpenAI whatever the provider, its tool needing approval", () => {
    const { files, env } = initFiles({ name: "o", framework: "openai-agents", hosts: ["vercel"], provider: "anthropic" }, "0.1.16");
    expect(Object.keys(manifest(files).dependencies)).toEqual(["agent-unit", "@openai/agents", "@upstash/redis", "zod"]);
    expect(files["agents/assistant.ts"]).toContain(`setDefaultOpenAIKey(env.OPENAI_API_KEY ?? "");`);
    expect(files["agents/assistant.ts"]).toContain(`needsApproval: true,`);
    expect(env).toEqual(["OPENAI_API_KEY", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "AGENT_UNIT_SECRET", "CRON_SECRET"]);
  });

  it("writes a defineAgent app with no framework and no model", () => {
    const { files, env } = initFiles({ name: "plain", framework: "agent-unit", runner: "server", hosts: ["cloudflare"], provider: "google" }, "0.1.16");
    expect(Object.keys(manifest(files).dependencies)).toEqual(["agent-unit", "zod"]);
    expect(files["agents/refund.ts"]).toContain(`export default defineAgent({`);
    expect(files["agent-unit.config.ts"]).toContain(`"cloudflare-module": { runtime: "durable-objects" }`);
    expect(files[".env.example"]).toBeUndefined();
    expect(env).toEqual([]);
    expect(files["README.md"]).toContain(`localhost:3000/agents/refund/runs`);
  });

  it("offers background work and a test where agent-unit writes the server or the agent runs offline", () => {
    const server = initFiles({ name: "s", framework: "hono", hosts: ["node"], extras: ["background", "test", "auth"] }, "0.1.16");
    expect(server.files["src/server.ts"]).toContain(`import { env, waitUntil } from "agent-unit/env";`);
    expect(server.files["src/server.ts"]).toContain(`waitUntil(forward(await c.req.json()));`);
    expect(server.files["test/server.test.ts"]).toContain(`asks for the token on /hello`);
    expect(manifest(server.files).scripts.test).toBe("vitest run");
    expect(manifest(server.files).devDependencies).toHaveProperty("vitest");
    expect(JSON.parse(server.files["tsconfig.json"]!).include).toEqual(["src", "test", "agent-unit.config.ts"]);
    expect(server.env).toContain("FEEDBACK_WEBHOOK_URL");

    const agent = initFiles({ name: "a", framework: "agent-unit", hosts: ["node"], extras: ["test", "background"] }, "0.1.16");
    expect(agent.files["test/refund.test.ts"]).toContain(`createTestUnit({ refund })`);
    expect(agent.files["src/server.ts"]).toBeUndefined();
    expect(JSON.parse(agent.files["tsconfig.json"]!).include).toEqual(["src", "test", "agents", "agent-unit.config.ts"]);

    // Agents on a model take a scripted one in their test; Mastra's own server has no routes of ours.
    for (const framework of ["ai-sdk", "mastra"] as const) {
      const files = initFiles({ name: "m", framework, runner: "engine", hosts: ["node"], extras: ["test"] }, "0.1.16").files;
      expect(Object.keys(files).filter((path) => path.startsWith("test/"))).toEqual(["test/assistant.test.ts"]);
      expect(files["agents/assistant.ts"]).toContain("export function createAssistant(model: ");
      expect(files["agents/assistant.ts"]).toContain(`export default createAssistant(provider("gpt-5-mini"));`);
    }
    expect(initFiles({ name: "m", framework: "ai-sdk", runner: "engine", hosts: ["node"] }, "0.1.16").files["agents/assistant.ts"]).toContain("export default new ToolLoopAgent({");
    for (const framework of ["langgraph", "openai-agents"] as const) {
      const files = initFiles({ name: "m", framework, hosts: ["node"], extras: ["test"] }, "0.1.16").files;
      expect(Object.keys(files).filter((path) => path.startsWith("test/"))).toEqual(["test/assistant.test.ts"]);
      expect(files["agents/assistant.ts"]).toContain("export function createAssistant(model: ");
      expect(initFiles({ name: "m", framework, hosts: ["node"] }, "0.1.16").files["agents/assistant.ts"]).not.toContain("createAssistant");
    }
    expect(initFiles({ name: "m", framework: "mastra", hosts: ["node"], extras: ["background", "test"] }, "0.1.16").files).not.toHaveProperty("test/server.test.ts");
  });

  it("gives Mastra Postgres when it goes to a serverless host, and LibSQL on servers", async () => {
    const serverless = initFiles({ name: "m", framework: "mastra", runner: "server", hosts: ["node", "vercel"] }, "0.1.16").files;
    expect(serverless).toHaveProperty("src/storage.postgres.ts");
    expect(JSON.parse(serverless["package.json"]!).dependencies).toHaveProperty("@mastra/pg");
    expect(initFiles({ name: "m", framework: "mastra", runner: "server", hosts: ["node", "cloudflare"] }, "0.1.16").files).toHaveProperty("src/storage.libsql.ts");

    const warnings: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "agent-unit-init-"));
    try {
      await init({ dir: join(root, "m"), framework: "mastra", runner: "server", hosts: "lambda", store: "libsql", yes: true, install: false, version: "0.1.16", logger: { info() {}, warn: (message) => warnings.push(message) } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(warnings.join("\n")).toContain("LibSQL on Vercel, Netlify or AWS Lambda needs a hosted database (Turso) and a build made on Linux");
  });

  it("puts each host's steps where a newcomer needs them", () => {
    const mastra = initFiles({ name: "desk", framework: "mastra", runner: "server", hosts: ["node", "cloudflare"], store: "libsql" }, "0.1.16");
    const readme = mastra.files["README.md"]!;
    expect(readme.indexOf("npx wrangler@4 d1 create desk")).toBeLessThan(readme.indexOf("npm run deploy:cloudflare"));
    expect(readme).toContain("Sign in once with `npx wrangler@4 login`");
    // Workers keep Mastra in D1; the LibSQL variables are for the Node host here.
    expect(initFiles({ name: "d", framework: "mastra", runner: "server", hosts: ["cloudflare"] }, "0.1.16").env).not.toContain("MASTRA_DB_URL");
    expect(readme).toContain("node --env-file=.env .output/server/index.mjs");
    expect(mastra.files[".gitignore"]).toContain("*.db-wal");

    const engine = initFiles({ name: "e", framework: "agent-unit", hosts: ["vercel", "netlify", "lambda"] }, "0.1.16");
    // Vercel: a daily sweep, which the Hobby plan allows, and a production deploy, where crons run.
    expect(engine.files["agent-unit.config.ts"]).toContain(`vercel: { storage: { driver: "upstash" }, sweep: "0 0 * * *" },`);
    expect(engine.files["README.md"]).toContain("The sweep that wakes sleeping runs runs once a day, which Vercel's Hobby plan allows");
    expect(engine.files["README.md"]).toContain("`npx vercel env add <NAME> production`");
    expect(engine.env).toContain("CRON_SECRET");
    // Netlify: netlify.toml has the build, and its CLI builds and deploys.
    expect(engine.files["netlify.toml"]).toBe(
      `# Netlify builds and deploys from this, with \`npm run deploy:netlify\` or from a connected repository.\n[build]\n  command = "npm run build:netlify"\n  publish = "dist"\n`,
    );
    expect(manifest(engine.files).scripts["deploy:netlify"]).toBe("npx netlify-cli deploy --prod");
    expect(engine.files["README.md"]).toContain("npm run deploy:netlify   # npx netlify-cli deploy --prod, which builds with netlify.toml");
    // Lambda: a SAM template for the build, deployed with the SAM CLI.
    expect(manifest(engine.files).scripts["deploy:lambda"]).toBe("agent-unit build --preset aws-lambda && sam deploy");
    expect(engine.files["template.yaml"]).toContain("      CodeUri: .output/server/\n      Handler: index.handler\n      Runtime: nodejs22.x");
    expect(engine.files["template.yaml"]).toContain("          UPSTASH_REDIS_REST_TOKEN: !Ref UpstashRedisRestToken");
    expect(engine.files["template.yaml"]).not.toContain("CRON_SECRET");
    expect(engine.files["README.md"]).toContain("`npm run deploy:lambda -- --guided`");
    expect(engine.files[".gitignore"]).toMatch(/^\.aws-sam$/m);
    expect(engine.files["README.md"]).toContain("Anyone who can reach the server can start and read runs.");
    expect(engine.files[".gitignore"]).toMatch(/^dist$/m);

    const auth = initFiles({ name: "a", framework: "agent-unit", hosts: ["node"], extras: ["auth"] }, "0.1.16").files["README.md"]!;
    expect(auth).toContain("export API_TOKEN=<the same value>");
    expect(auth).not.toContain("Anyone who can reach the server");
  });

  it("turns a directory name into a package name", () => {
    expect(packageName("My Agent!")).toBe("my-agent");
    expect(packageName("..")).toBe("my-agent");
    expect(packageName("_x")).toBe("x");
  });
});

describe("agent-unit init", () => {
  const dirs: string[] = [];
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-unit-init-"));
    dirs.push(dir);
    return dir;
  };
  const quiet = { info() {}, warn() {} };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes the app from flags alone", async () => {
    const root = join(temp(), "desk");
    const result = await init({ dir: root, framework: "ai-sdk", runner: "server", hosts: "node,vercel", provider: "openai", extras: "none", install: false, version: "0.1.16", logger: quiet });
    expect(result.answers).toMatchObject({ name: "desk", framework: "ai-sdk", runner: "server", hosts: ["node", "vercel"], extras: [] });
    expect(result.installed).toBe(false);
    expect(readFileSync(join(root, "src/server.ts"), "utf8")).toContain("createOpenAI");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts["deploy:vercel"]).toContain("vercel deploy --prebuilt");
  });

  it("takes the defaults with --yes", async () => {
    const root = join(temp(), "defaults");
    const result = await init({ dir: root, yes: true, install: false, version: "0.1.16", logger: quiet });
    expect(result.answers).toMatchObject({ framework: "mastra", runner: "server", hosts: ["node"], store: "libsql", provider: "openai", extras: [] });
    const engine = await init({ dir: join(temp(), "engine"), framework: "ai-sdk", yes: true, install: false, version: "0.1.16", logger: quiet });
    expect(engine.answers).toMatchObject({ framework: "ai-sdk", runner: "engine" });
    expect(engine.files).toContain("agents/assistant.ts");
  });

  it("names the flag for each question it cannot ask without a terminal", async () => {
    const root = join(temp(), "app");
    await expect(init({ dir: root, install: false, version: "0.1.16", logger: quiet })).rejects.toThrow(`No terminal to ask "Agent framework" in: pass --framework, or --yes for the defaults.`);
    await expect(init({ dir: root, framework: "hono", install: false, version: "0.1.16", logger: quiet })).rejects.toThrow("pass --hosts");
  });

  it("refuses unknown values, extras that do not apply, and a directory with files in it", async () => {
    const root = temp();
    const options = { install: false, version: "0.1.16", logger: quiet };
    await expect(init({ ...options, dir: join(root, "a"), framework: "crewai", yes: true })).rejects.toThrow("--framework crewai is not one of: mastra, ai-sdk, langgraph, openai-agents, agent-unit, hono.");
    await expect(init({ ...options, dir: join(root, "b"), hosts: "node,heroku", yes: true })).rejects.toThrow("--hosts heroku is not one of");
    await expect(init({ ...options, dir: join(root, "c"), framework: "mastra", extras: "auth", yes: true })).rejects.toThrow("--extras auth does not apply to Mastra apps on their own server.");
    await expect(init({ ...options, dir: join(root, "d"), framework: "hono", runner: "engine", yes: true })).rejects.toThrow("--runner only applies to Mastra and AI SDK apps.");
    await expect(init({ ...options, dir: join(root, "f"), framework: "langgraph", runner: "server", yes: true })).rejects.toThrow("--runner only applies to Mastra and AI SDK apps.");
    await expect(init({ ...options, dir: join(root, "e"), framework: "ai-sdk", runner: "lambda", yes: true })).rejects.toThrow("--runner lambda is not one of: engine, server.");
    mkdirSync(join(root, "taken"));
    writeFileSync(join(root, "taken/index.ts"), "");
    await expect(init({ ...options, dir: join(root, "taken"), yes: true })).rejects.toThrow("is not empty");
  });

  it("installs with the package manager that ran it", () => {
    expect(packageManager("pnpm/10.9.0 npm/? node/v24.0.0 darwin arm64")).toBe("pnpm");
    expect(packageManager("bun/1.2.0")).toBe("bun");
    expect(packageManager("npm/10.0.0 node/v24.0.0")).toBe("npm");
    expect(packageManager("")).toBe("npm");
  });
});

describe("agent-unit init in an existing app", () => {
  const dirs: string[] = [];
  const quiet = { info() {}, warn() {} };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function app(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "agent-unit-existing-"));
    dirs.push(dir);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return dir;
  }
  const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

  it("builds the app's own Hono server, adding to package.json and .gitignore without replacing anything", async () => {
    const server = `import { Hono } from "hono";\nexport default new Hono().get("/", (c) => c.text("shop"));\n`;
    const root = app({
      "package.json": JSON.stringify({ name: "@acme/shop", type: "module", scripts: { dev: "tsx watch src/server.ts", build: "tsc", lint: "eslint ." }, dependencies: { hono: "^4.0.0" } }, null, "\t"),
      "src/server.ts": server,
      ".gitignore": "node_modules\n.env\n",
    });
    const result = await init({ dir: root, hosts: "node,vercel", yes: true, install: false, version: "0.1.16", logger: quiet });
    expect(result).toMatchObject({ existing: true, answers: { name: "shop", framework: "hono", runner: "server" } });
    expect(read(root, "src/server.ts")).toBe(server);
    expect(read(root, "agent-unit.config.ts")).toContain(`server: "./src/server.ts"`);
    const pkg = JSON.parse(read(root, "package.json"));
    expect(pkg.dependencies).toEqual({ hono: "^4.0.0", "agent-unit": "^0.1.16" });
    expect(pkg.scripts).toMatchObject({
      dev: "tsx watch src/server.ts",
      build: "tsc",
      lint: "eslint .",
      "agent-unit:dev": "agent-unit dev",
      "agent-unit:build": "agent-unit build --preset node-server",
      "build:vercel": "agent-unit build --preset vercel",
    });
    expect(read(root, "package.json")).toMatch(/^\t"name"/m); // the app's own indentation
    const ignore = read(root, ".gitignore");
    expect(ignore.startsWith("node_modules\n.env\n\n# agent-unit\n")).toBe(true);
    expect(ignore.match(/^node_modules$/gm)).toHaveLength(1);
    expect(ignore).toContain(".output");
    // The app's README and TypeScript setup are its own.
    expect(result.files.sort()).toEqual([".gitignore", "agent-unit.config.ts", "package.json"]);
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.scripts).not.toHaveProperty("typecheck");
  });

  it("runs an AI SDK app's own server by default, wherever Hono's starter put it", async () => {
    const root = app({ "package.json": JSON.stringify({ name: "chat", dependencies: { ai: "^7.0.0", hono: "^4.0.0" } }), "src/index.js": "export default { fetch: () => new Response('hi') };\n" });
    const result = await init({ dir: root, hosts: "node", yes: true, install: false, version: "0.1.16", logger: quiet });
    expect(result.answers).toMatchObject({ framework: "ai-sdk", runner: "server" });
    expect(read(root, "agent-unit.config.ts")).toContain(`server: "./src/index.js"`);
    // Built as it is: no model key, route or package of agent-unit's own.
    expect(result.answers.provider).toBeUndefined();
    expect(result.files.sort()).toEqual([".gitignore", "agent-unit.config.ts", "package.json"]);
    expect(Object.keys(JSON.parse(read(root, "package.json")).dependencies)).toEqual(["ai", "hono", "agent-unit"]);
    await expect(init({ dir: app({ "package.json": "{}", "src/server.ts": "" }), framework: "hono", extras: "auth", hosts: "node", yes: true, install: false, version: "0.1.16", logger: quiet })).rejects.toThrow(
      "--extras auth does not apply to your own server (src/server.ts): agent-unit builds it as it is.",
    );
    // Asked for the engine, it writes an agent beside the app's server.
    const engine = app({ "package.json": JSON.stringify({ name: "chat", dependencies: { ai: "^7.0.0" } }), "src/index.ts": "" });
    expect((await init({ dir: engine, runner: "engine", hosts: "node", yes: true, install: false, version: "0.1.16", logger: quiet })).files).toContain("agents/assistant.ts");
  });

  it("leaves an existing Mastra instance its storage and model keys", async () => {
    const root = app({
      "package.json": JSON.stringify({ name: "desk", dependencies: { "@mastra/core": "^1.70.0", "@mastra/libsql": "^1.20.0" } }),
      "src/mastra/index.ts": "export const mastra = {};\n",
    });
    const result = await init({ dir: root, hosts: "node,cloudflare", yes: true, install: false, version: "0.1.16", logger: quiet });
    expect(result.answers).toMatchObject({ framework: "mastra", runner: "server", store: undefined, provider: undefined });
    expect(result.files.sort()).toEqual([".gitignore", "agent-unit.config.ts", "package.json"]);
    const pkg = JSON.parse(read(root, "package.json"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@mastra/core", "@mastra/hono", "@mastra/libsql", "agent-unit", "hono"]);
    expect(pkg.imports).toBeUndefined();
    expect(read(root, "agent-unit.config.ts")).not.toContain("d1_databases");
    expect(read(root, "src/mastra/index.ts")).toBe("export const mastra = {};\n");
  });

  it("refuses an app that already has an agent-unit config, and points a non-empty directory without a package.json at a new one", async () => {
    const options = { yes: true, install: false, version: "0.1.16", logger: quiet };
    await expect(init({ ...options, dir: app({ "package.json": "{}", "agent-unit.config.mjs": "export default {};" }) })).rejects.toThrow("already has agent-unit.config.mjs.");
    await expect(init({ ...options, dir: app({ "notes.txt": "" }) })).rejects.toThrow("is not empty. Choose a new directory, or run init in an app with a package.json");
  });

  it("adds only missing variables to .env.example, and reports files it kept", () => {
    const plan = initFiles({ name: "x", framework: "ai-sdk", hosts: ["vercel"], extras: ["auth"] }, "0.1.16").files;
    const existing: Record<string, string> = {
      "package.json": JSON.stringify({ name: "x", dependencies: { ai: "^7.0.0" } }),
      ".env.example": "# mine\nOPENAI_API_KEY=\n",
      "agents/assistant.ts": "// mine\n",
    };
    const merge = mergeIntoApp(plan, (path) => existing[path]);
    expect(merge.files[".env.example"]).toBe(`# mine\nOPENAI_API_KEY=\n\n${plan[".env.example"]!.split("\n\n").slice(1).join("\n\n")}`);
    expect(merge.files[".env.example"]!.match(/^OPENAI_API_KEY=/gm)).toHaveLength(1);
    expect(JSON.parse(merge.files["package.json"]!).dependencies.ai).toBe("^7.0.0");
    expect(merge.kept).toEqual(["agents/assistant.ts"]);
    expect(merge.created).toEqual(["agent-unit.config.ts", ".gitignore"]);
  });

  it("adds the dev tools an extra needs, but not a TypeScript setup", async () => {
    const root = app({ "package.json": JSON.stringify({ name: "@acme/my-app", scripts: { test: "jest" } }) });
    await init({ dir: root, framework: "ai-sdk", runner: "engine", hosts: "node", extras: "test", yes: true, install: false, version: "0.1.16", logger: quiet });
    const pkg = JSON.parse(read(root, "package.json"));
    expect(pkg.devDependencies).toEqual({ vitest: expect.any(String) });
    expect(pkg.scripts).toMatchObject({ test: "jest", "agent-unit:test": "vitest run" });
  });

  it("warns when the app's server file has no default export or starts its own server", async () => {
    const warnings: string[] = [];
    const root = app({
      "package.json": JSON.stringify({ name: "shop", dependencies: { hono: "^4.0.0" } }),
      "src/index.ts": `import { serve } from "@hono/node-server";\nconst app = { fetch: () => new Response("hi") };\nserve(app);\n`,
    });
    await init({ dir: root, hosts: "node", yes: true, install: false, version: "0.1.16", logger: { info() {}, warn: (message) => warnings.push(message) } });
    expect(warnings.join("\n")).toContain("src/index.ts has no default export");
    expect(warnings.join("\n")).toContain("src/index.ts calls serve(...)");
  });

  it("takes the framework an app already uses as the default", () => {
    expect(detectFramework({ dependencies: { "@mastra/core": "1", ai: "7" } })).toBe("mastra");
    expect(detectFramework({ devDependencies: { "@langchain/langgraph": "1" } })).toBe("langgraph");
    expect(detectFramework({ dependencies: { ai: "7", hono: "4" } })).toBe("ai-sdk");
    expect(detectFramework({ dependencies: { express: "5" } })).toBeUndefined();
  });
});

