import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, prepareFixture, ROOT, startServer, tempDir, type RunningServer } from "./helpers";
import { startMiniflare, vercel } from "./hosts";

// Mastra's own server, built with `server: mastra()`: its routes and its storage (LibSQL on servers
// and functions, D1 on Workers), with nothing of agent-unit's engine. A workflow pauses for approval,
// the host restarts, and it resumes from Mastra's store without running finished steps again.

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));

interface Deployment {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

interface Host {
  preset: string;
  launch(out: string, root: string, data: string): Promise<Deployment>;
}

const node: Host = {
  preset: "node-server",
  async launch(out, root, data) {
    const start = () =>
      startServer(process.execPath, [join(out, "server/index.mjs")], { cwd: root, env: { MASTRA_DB_URL: `file:${join(data, "mastra.db")}` }, readyPath: "/api/workflows" });
    let server: RunningServer = await start();
    return {
      fetch: (path, init) => fetch(`${server.url}${path}`, init),
      async restart() {
        await server.stop();
        server = await start();
      },
      stop: () => server.stop(),
    };
  },
};

/** Vercel's function, called in-process; a restart is a cold start of a fresh module instance. */
const vercelFunction: Host = {
  preset: "vercel",
  async launch(out, _root, data) {
    let cold = 0;
    const load = async () => (await import(`${pathToFileURL(join(out, vercel.entry)).href}?cold=${cold++}`)) as Record<string, any>;
    const url = `file:${join(data, "mastra.db")}`;
    const previous = process.env.MASTRA_DB_URL;
    process.env.MASTRA_DB_URL = url;
    let module = await load();
    return {
      async fetch(path, init) {
        const response = await vercel.invoke(module, new Request(`https://app.example.com${path}`, init), () => {});
        return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
      },
      async restart() {
        module = await load();
      },
      async stop() {
        if (previous === undefined) delete process.env.MASTRA_DB_URL;
        else process.env.MASTRA_DB_URL = previous;
      },
    };
  },
};

/** The Worker in Miniflare with a D1 database kept on disk; a restart is a fresh runtime on the same database. */
const workers: Host = {
  preset: "cloudflare-module",
  launch: (out, _root, data) => startMiniflare(out, data),
};

for (const host of [node, vercelFunction, workers]) {
  describe(`Mastra's own server on ${host.preset}`, () => {
    let out: string;
    let data: string;
    let deployment: Deployment;

    const call = async (path: string, body?: unknown) => {
      const response = await deployment.fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status, `${path}: ${response.status}`).toBe(200);
      return (await response.json()) as Record<string, any>;
    };

    beforeAll(async () => {
      const root = prepareFixture("mastra-server");
      out = tempDir(`mastra-${host.preset}-out`);
      data = tempDir(`mastra-${host.preset}-data`);
      const result = await buildFixture(root, host.preset, out);
      expect(result).toMatchObject({ runtime: "none", server: "mastra", agents: [] });
      deployment = await host.launch(out, root, data);
    });

    afterAll(async () => {
      await deployment?.stop();
      cleanup(out, data);
    });

    it("serves Mastra's routes", async () => {
      expect(Object.keys(await call("/api/workflows"))).toEqual(["refund"]);
    });

    it("pauses a workflow, survives a restart, and resumes it from Mastra's store without repeating steps", async () => {
      const { runId } = await call("/api/workflows/refund/create-run", {});
      const started = await call(`/api/workflows/refund/start-async?runId=${runId}`, { inputData: { orderId: "o_42" } });
      expect(started.status).toBe("suspended");
      const token = started.steps.lookup.output.token;
      expect(token).toMatch(/^[0-9a-f-]{36}$/);

      await deployment.restart();

      const resumed = await call(`/api/workflows/refund/resume-async?runId=${runId}`, { step: "approve", resumeData: { approved: true } });
      expect(resumed.status).toBe("success");
      // The lookup step made a new token whenever it ran: the same token means it did not run again.
      expect(resumed.result).toEqual({ orderId: "o_42", token, approved: true });
      expect(await call(`/api/workflows/refund/runs/${runId}`)).toMatchObject({ runId, status: "success" });
    });

    it("contains none of agent-unit's engine", () => {
      const found = files(out)
        .filter((file) => /\.m?js$/.test(file))
        .filter((file) => ["agent-unit.context", "@agent-unit/runtime"].some((marker) => readFileSync(file, "utf8").includes(marker)));
      expect(found).toEqual([]);
    });
  });
}

describe("Mastra's own server in agent-unit dev", () => {
  it("serves Mastra from source with the preset", async () => {
    const root = prepareFixture("mastra-server");
    const data = tempDir("mastra-dev-data");
    const previous = process.env.MASTRA_DB_URL;
    process.env.MASTRA_DB_URL = `file:${join(data, "mastra.db")}`;
    const { startDev } = (await import(join(ROOT, "dist/build.mjs"))) as typeof import("../../src/build");
    const dev = await startDev({ root, port: 0, watch: false, logger: { info() {}, warn() {}, error() {} } });
    try {
      expect(dev.server).toBe("mastra");
      const workflows = (await (await fetch(new URL("/api/workflows", dev.url))).json()) as Record<string, unknown>;
      expect(Object.keys(workflows)).toEqual(["refund"]);
    } finally {
      await dev.close();
      if (previous === undefined) delete process.env.MASTRA_DB_URL;
      else process.env.MASTRA_DB_URL = previous;
      cleanup(data);
    }
  });
});
