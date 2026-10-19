import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, collect, createAgentClient, freePort, prepareFixture, startServer, tempDir, type RunningServer } from "./helpers";
import { vercel, workerd, writeDurableConfig } from "./hosts";

// `presets` in the config: one app, one config, no environment variables, and each host gets its own
// runtime and storage. Each build runs an agent to the end on its host.

type Built = Awaited<ReturnType<typeof buildFixture>>;

const finished = async (client: ReturnType<typeof createAgentClient>) => {
  const events = await collect(client.run("greeter", { name: "presets" }));
  return events.at(-1);
};

describe("per-preset settings", () => {
  const dirs: string[] = [];
  let root: string;
  beforeAll(() => {
    root = prepareFixture("presets");
  });
  afterAll(() => cleanup(...dirs));
  const out = () => {
    const dir = tempDir("presets-out");
    dirs.push(dir);
    return dir;
  };

  it("builds two presets at once, each with its own settings", async () => {
    // `build:all` scripts start one build per host together; they once shared one generated runtime.
    const [node, vercelOut] = [out(), out()];
    await Promise.all([buildFixture(root, "node-server", node), buildFixture(root, "vercel", vercelOut)]);
    const code = (dir: string) =>
      (readdirSync(dir, { recursive: true }) as string[])
        .filter((file) => file.endsWith(".mjs"))
        .map((file) => readFileSync(join(dir, file), "utf8"))
        .join("\n");
    expect(code(node)).toMatch(/\bbudget: false\b/);
    expect(code(node)).not.toMatch(/\bbudget: (30000|3e4)\b/);
    expect(code(vercelOut)).toMatch(/\bbudget: (30000|3e4)\b/);
  });

  it("keeps runs on disk on Node, from the top-level settings", async () => {
    const dir = out();
    const result: Built = await buildFixture(root, "node-server", dir);
    expect(result).toMatchObject({ runtime: "default", storage: { driver: "fs-lite" } });
    const server: RunningServer = await startServer(process.execPath, [join(dir, "server/index.mjs")], { cwd: root, env: { AGENT_UNIT_DATA: join(dir, "data") } });
    try {
      expect(await finished(createAgentClient({ baseUrl: server.url }))).toMatchObject({ type: "RUN_FINISHED", result: "hello presets" });
    } finally {
      await server.stop();
    }
  });

  it.skipIf(!workerd)("gives every run its own Durable Object on Workers", async () => {
    const dir = out();
    const result = await buildFixture(root, "cloudflare_module", dir);
    expect(result).toMatchObject({ preset: "cloudflare-module", runtime: "durable-objects", storage: { driver: "durable-objects" } });
    const disk = join(dir, "disk");
    mkdirSync(disk, { recursive: true });
    const port = await freePort();
    const { config, wrangler } = writeDurableConfig(dir, disk, port);
    expect(wrangler.durable_objects.bindings).toHaveLength(2);
    const server = await startServer(workerd!, ["serve", config], { cwd: dir, port });
    try {
      expect(await finished(createAgentClient({ baseUrl: server.url }))).toMatchObject({ type: "RUN_FINISHED", result: "hello presets" });
    } finally {
      await server.stop();
    }
  });

  it("uses the storage, budget and authorize set for Vercel", async () => {
    const dir = out();
    const result = await buildFixture(root, "vercel", dir);
    expect(result).toMatchObject({ runtime: "default", storage: { driver: "memory" }, budgetMs: 30_000 });
    const module = (await import(pathToFileURL(join(dir, vercel.entry)).href)) as Record<string, any>;
    const fetch = (input: RequestInfo | URL, init?: RequestInit) => vercel.invoke(module, new Request(input, init), () => {});
    expect((await fetch("https://app.example.com/agents")).status).toBe(401);
    const client = createAgentClient({ baseUrl: "https://app.example.com", headers: { "x-team": "presets" }, fetch });
    expect(await finished(client)).toMatchObject({ type: "RUN_FINISHED", result: "hello presets" });
  });
});
