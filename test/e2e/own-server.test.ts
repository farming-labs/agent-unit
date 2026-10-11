import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, hasBinary, prepareFixture, ROOT, startServer, tempDir, type RunningServer } from "./helpers";
import { lambda, netlify, vercel, workerd, writeDurableConfig, type FunctionHost } from "./hosts";

// An app that brings its own server (a Hono app here): agent-unit builds it for every host and adds
// nothing of its engine. The app's routes answer exactly as the app defines them.

const GREETING = "hey";

/** Strings only agent-unit's engine contains: its run context key and its package name. */
const ENGINE_MARKERS = ["agent-unit.context", "@agent-unit/runtime"];

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));

interface Deployment {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

interface Host {
  preset: string;
  available: boolean;
  /** Whether the host keeps work alive after the response; without it, waitUntil work finishes first. */
  waitUntil: boolean;
  launch(out: string, root: string): Promise<Deployment>;
}

function processHost(preset: string, command: string, args: (out: string) => string[], available = hasBinary(command)): Host {
  return {
    preset,
    available,
    waitUntil: true,
    async launch(out, root) {
      const server: RunningServer = await startServer(command, args(out), { cwd: root, env: { GREETING }, readyPath: "/" });
      return { fetch: (path, init) => fetch(`${server.url}${path}`, init), stop: () => server.stop() };
    },
  };
}

function functionHost(host: FunctionHost): Host {
  return {
    preset: host.preset,
    available: true,
    waitUntil: host.waitUntil,
    async launch(out) {
      const module = (await import(pathToFileURL(join(out, host.entry)).href)) as Record<string, any>;
      return {
        async fetch(path, init) {
          const previous = process.env.GREETING;
          process.env.GREETING = GREETING;
          try {
            const response = await host.invoke(module, new Request(`https://app.example.com${path}`, init), () => {});
            // Read the body while the environment is set: a streamed body runs the app's code as it is read.
            const body = await response.arrayBuffer();
            return new Response(body, { status: response.status, headers: response.headers });
          } finally {
            if (previous === undefined) delete process.env.GREETING;
            else process.env.GREETING = previous;
          }
        },
        async stop() {},
      };
    },
  };
}

const cloudflare: Host = {
  preset: "cloudflare-module",
  available: Boolean(workerd),
  waitUntil: true,
  async launch(out) {
    const disk = join(out, "do-disk");
    mkdirSync(disk, { recursive: true });
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const { config } = writeDurableConfig(out, disk, port, { GREETING });
    const server = await startServer(workerd!, ["serve", config], { cwd: out, port, readyPath: "/" });
    return { fetch: (path, init) => fetch(`${server.url}${path}`, init), stop: () => server.stop() };
  },
};

const HOSTS: Host[] = [
  processHost("node-server", process.execPath, (out) => [join(out, "server/index.mjs")], true),
  processHost("bun", "bun", (out) => ["run", join(out, "server/index.mjs")]),
  processHost("deno-server", "deno", (out) => ["run", "-A", join(out, "server/index.mjs")]),
  cloudflare,
  functionHost(vercel),
  functionHost(netlify),
  functionHost(lambda),
];

it("looks for engine code by strings the engine really contains", () => {
  const runtime = files(join(ROOT, "packages/runtime/dist"))
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  expect(runtime).toContain(ENGINE_MARKERS[0]);
});

for (const host of HOSTS) {
  describe.skipIf(!host.available)(`own server on ${host.preset}`, () => {
    let out: string;
    let deployment: Deployment;

    beforeAll(async () => {
      const root = prepareFixture("server");
      out = tempDir(`own-server-${host.preset}-out`);
      const result = await buildFixture(root, host.preset, out);
      expect(result).toMatchObject({ preset: host.preset, runtime: "none", server: "./src/server.ts", agents: [], adapters: [] });
      expect(result.storage).toBeUndefined();
      deployment = await host.launch(out, root);
    });

    afterAll(async () => {
      await deployment?.stop();
      cleanup(out);
    });

    it("answers the app's own routes", async () => {
      const hello = await deployment.fetch("/");
      expect(hello.status).toBe(200);
      expect(await hello.text()).toBe("hello from hono");

      const echo = await deployment.fetch("/echo/42?q=refunds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: "o_1" }),
      });
      expect(await echo.json()).toEqual({ id: "42", body: { orderId: "o_1" }, query: "refunds" });

      expect(await (await deployment.fetch("/stream")).text()).toBe("one two three");
      expect((await deployment.fetch("/missing")).status).toBe(404);
    });

    it("reads the host's configuration through agent-unit/env", async () => {
      expect(await (await deployment.fetch("/env")).json()).toEqual({ greeting: GREETING });
    });

    it("runs work handed to waitUntil after the response, or before it where the host would freeze", async () => {
      expect(await (await deployment.fetch("/later", { method: "POST" })).text()).toBe("accepted");
      const both = ["executionCtx", "waitUntil"];
      if (!host.waitUntil) {
        // Netlify and Lambda may freeze after the response, so the work was done before it.
        expect((await (await deployment.fetch("/later")).json()) as { finished: string[] }).toEqual({ finished: both });
        return;
      }
      const deadline = Date.now() + 5_000;
      let finished: string[] = [];
      while (finished.length < 2 && Date.now() < deadline) {
        finished = ((await (await deployment.fetch("/later")).json()) as { finished: string[] }).finished;
        if (finished.length < 2) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(finished).toEqual(both);
    });

    it("contains none of agent-unit's engine", () => {
      const found = files(out)
        .filter((file) => /\.(m?js|json)$/.test(file))
        .flatMap((file) => ENGINE_MARKERS.filter((marker) => readFileSync(file, "utf8").includes(marker)).map((marker) => `${file}: ${marker}`));
      expect(found).toEqual([]);
    });
  });
}
