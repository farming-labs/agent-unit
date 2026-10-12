import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { init, packageManager } from "../src/build/init";
import { initFiles, packageName } from "../src/build/init-templates";

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
      "deploy:cloudflare": "agent-unit build --preset cloudflare-module && npx wrangler deploy",
    });
    expect(files["agent-unit.config.ts"]).not.toContain("server:");
    expect(files["agent-unit.config.ts"]).toContain(`d1_databases: [{ binding: "DB", database_name: "refund-desk"`);
    expect(files["src/mastra/index.ts"]).toContain(`model: { id: "anthropic/claude-sonnet-4-5", apiKey: env.ANTHROPIC_API_KEY }`);
    expect(files["src/storage.d1.ts"]).toContain("binding: env.DB");
    expect(files["src/storage.libsql.ts"]).toContain("env.MASTRA_DB_URL");
    expect(env).toEqual(["ANTHROPIC_API_KEY", "MASTRA_DB_URL", "MASTRA_DB_AUTH_TOKEN"]);
    expect(files["README.md"]).toContain("npx wrangler d1 create refund-desk");
  });

  it("uses one store and no D1 when Workers is not a host", () => {
    const { files } = initFiles({ name: "app", framework: "mastra", hosts: ["vercel"], store: "postgres" }, "0.1.16");
    const pkg = manifest(files);
    expect(pkg.imports).toEqual({ "#storage": "./src/storage.postgres.ts" });
    expect(pkg.dependencies).toHaveProperty("@mastra/pg");
    expect(pkg.dependencies).not.toHaveProperty("@mastra/cloudflare-d1");
    expect(pkg.scripts).toMatchObject({ build: "agent-unit build --preset vercel", deploy: "agent-unit build --preset vercel && npx vercel deploy --prebuilt" });
    expect(Object.keys(files).filter((path) => path.startsWith("src/storage"))).toEqual(["src/storage.postgres.ts"]);
    expect(files["agent-unit.config.ts"]).not.toContain("cloudflare");
  });

  it("puts an AI SDK agent on a Hono server, with auth and a task when asked", () => {
    const { files, env } = initFiles({ name: "chat", framework: "ai-sdk", hosts: ["cloudflare", "netlify"], provider: "google", extras: ["auth", "task"] }, "0.1.16");
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
    const result = await init({ dir: root, framework: "ai-sdk", hosts: "node,vercel", provider: "openai", extras: "none", install: false, version: "0.1.16", logger: quiet });
    expect(result.answers).toMatchObject({ name: "desk", framework: "ai-sdk", hosts: ["node", "vercel"], extras: [] });
    expect(result.installed).toBe(false);
    expect(readFileSync(join(root, "src/server.ts"), "utf8")).toContain("createOpenAI");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts["deploy:vercel"]).toContain("vercel deploy --prebuilt");
  });

  it("takes the defaults with --yes", async () => {
    const root = join(temp(), "defaults");
    const result = await init({ dir: root, yes: true, install: false, version: "0.1.16", logger: quiet });
    expect(result.answers).toMatchObject({ framework: "mastra", hosts: ["node"], store: "libsql", provider: "openai", extras: [] });
  });

  it("names the flag for each question it cannot ask without a terminal", async () => {
    const root = join(temp(), "app");
    await expect(init({ dir: root, install: false, version: "0.1.16", logger: quiet })).rejects.toThrow(`No terminal to ask "Agent framework" in: pass --framework, or --yes for the defaults.`);
    await expect(init({ dir: root, framework: "hono", install: false, version: "0.1.16", logger: quiet })).rejects.toThrow("pass --hosts");
  });

  it("refuses unknown values, extras that do not apply, and a directory with files in it", async () => {
    const root = temp();
    const options = { install: false, version: "0.1.16", logger: quiet };
    await expect(init({ ...options, dir: join(root, "a"), framework: "crewai", yes: true })).rejects.toThrow("--framework crewai is not one of: mastra, ai-sdk, hono.");
    await expect(init({ ...options, dir: join(root, "b"), hosts: "node,heroku", yes: true })).rejects.toThrow("--hosts heroku is not one of");
    await expect(init({ ...options, dir: join(root, "c"), framework: "mastra", extras: "auth", yes: true })).rejects.toThrow("--extras auth does not apply to Mastra apps.");
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
