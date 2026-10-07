import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentClient, type AgentEvent, type RunRecord } from "../../src/client";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURES = join(ROOT, "test/e2e/fixtures");

export const hasBinary = (name: string) => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;

/** Builds the package once, and links it into a fixture the way an app installs it. */
export function prepareFixture(name: string): string {
  if (!existsSync(join(ROOT, "dist/build.mjs"))) {
    const result = spawnSync("pnpm", ["build"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
    if (result.status !== 0) throw new Error("Building agent-unit failed.");
  }
  const dir = join(FIXTURES, name);
  const link = join(dir, "node_modules/agent-unit");
  if (!existsSync(link)) {
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(ROOT, link, process.platform === "win32" ? "junction" : "dir");
  }
  return dir;
}

export function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), `agent-unit-${prefix}-`));
}

export function cleanup(...paths: string[]) {
  for (const path of paths) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Imports the built package the way an app's build script would. */
export async function buildFixture(root: string, preset: string, outDir: string, env: Record<string, string> = {}) {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    const { build } = (await import(join(ROOT, "dist/build.mjs"))) as typeof import("../../src/build");
    return await build({ root, preset, outDir, logger: { info() {}, warn() {} } });
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

export interface RunningServer {
  url: string;
  stop(): Promise<void>;
}

/** Starts a built server and resolves once it answers, failing fast if the process exits. */
export async function startServer(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; port?: number; readyPath?: string },
): Promise<RunningServer> {
  const port = options.port ?? 20_000 + Math.floor(Math.random() * 20_000);
  const url = `http://127.0.0.1:${port}`;
  // A leftover process on the port would answer the readiness check and stand in for this one.
  if (await fetch(url).then(() => true, () => false)) throw new Error(`Port ${port} is already in use.`);
  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, PORT: String(port), NITRO_PORT: String(port), HOST: "127.0.0.1", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  let exited = false;
  child.once("exit", () => (exited = true));
  const deadline = Date.now() + 20_000;
  while (true) {
    if (exited) throw new Error(`Server exited before it was ready:\n${output}`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`Server did not answer within 20s:\n${output}`);
    }
    const ready = await fetch(`${url}${options.readyPath ?? "/.well-known/agent.json"}`).then((response) => response.ok, () => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    url,
    async stop() {
      if (!exited) {
        const gone = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await gone;
      }
      // Done only when nothing answers on the port any more.
      for (let i = 0; i < 100 && (await fetch(url).then(() => true, () => false)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}

export async function collect(iterable: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/** Polls a run until it reaches a status. A bounded readiness check, not a fixed sleep. */
export async function waitForStatus(client: ReturnType<typeof createAgentClient>, id: string, status: RunRecord["status"], timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const run = await client.get(id);
    if (run.status === status) return run;
    if (Date.now() > deadline) throw new Error(`Run ${id} is ${run.status}, expected ${status}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export { createAgentClient };
