#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { readFileSync } from "node:fs";
import { packageRoot } from "./build/load";

const version = (JSON.parse(readFileSync(`${packageRoot()}/package.json`, "utf8")) as { version: string }).version;

const root = { type: "string", description: "App directory", default: "." } as const;

const init = defineCommand({
  meta: { name: "init", description: "Create a new app: framework, hosts, storage and model provider chosen up front" },
  args: {
    dir: { type: "positional", description: "Directory for the new app", required: false },
    framework: { type: "string", description: "mastra, ai-sdk, langgraph, openai-agents, agent-unit (defineAgent) or hono" },
    runner: { type: "string", description: "Who runs a Mastra or AI SDK agent: engine (agent-unit's) or server (the framework's own)" },
    hosts: { type: "string", description: "Comma-separated: node, bun, deno, cloudflare, vercel, netlify, lambda" },
    store: { type: "string", description: "Mastra's store off Workers: libsql or postgres (Workers use D1)" },
    provider: { type: "string", description: "Model provider: openai, anthropic or google" },
    extras: { type: "string", description: "Comma-separated: task, auth, background, test, or none" },
    install: { type: "boolean", description: "Install dependencies (--no-install to skip)" },
    yes: { type: "boolean", description: "Take the default for every question not answered by a flag", default: false },
  },
  async run({ args }) {
    const { init: createApp } = await import("./build/init");
    try {
      await createApp({ ...args, dir: args.dir || undefined, version });
    } catch (error) {
      console.error(`agent-unit init: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  },
});

const dev = defineCommand({
  meta: { name: "dev", description: "Serve your server or your agents from source, reloading on change (reads .env)" },
  args: {
    root,
    port: { type: "string", description: "Port", default: process.env.PORT ?? "3000" },
    host: { type: "string", description: "Hostname to bind" },
  },
  async run({ args }) {
    const { startDev } = await import("./build/dev");
    const server = await startDev({ root: args.root, port: Number(args.port), hostname: args.host });
    console.log(`agent-unit dev: ${server.url}\n  ${server.server ? "server" : "agents"}: ${server.describe()}`);
    const stop = async () => {
      await server.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  },
});

const build = defineCommand({
  meta: { name: "build", description: "Build your server, or your agents on agent-unit's engine, for a Nitro preset" },
  args: {
    root,
    preset: { type: "string", description: "Nitro preset: node-server, bun, deno-server, cloudflare-module, vercel, netlify, aws-lambda, ..." },
    out: { type: "string", description: "Output directory (default: the preset's own)" },
    minify: { type: "boolean", description: "Minify the server bundle", default: false },
  },
  async run({ args }) {
    const { build: buildApp } = await import("./build/nitro");
    await buildApp({ root: args.root, preset: args.preset, outDir: args.out, minify: args.minify });
  },
});

const add = defineCommand({
  meta: { name: "add", description: "Install an adapter package and add it to agent-unit.config.ts" },
  args: {
    packages: { type: "positional", description: "Adapter packages, e.g. agent-unit-adapter-tiny", required: true },
    root,
    yes: { type: "boolean", description: "Do not ask for confirmation", default: false },
  },
  async run({ args }) {
    const { addAdapters } = await import("./build/add");
    const packages = [args.packages, ...((args._ as string[] | undefined) ?? [])].filter((name, index, all) => name && all.indexOf(name) === index);
    try {
      await addAdapters({ root: args.root, packages, yes: args.yes });
    } catch (error) {
      // Problems here are the user's to fix (a typo, not an adapter, no --yes): say what, without a stack.
      console.error(`agent-unit add: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  },
});

const task = defineCommand({
  meta: { name: "task", description: "Run one of your scheduled tasks now, from source" },
  args: {
    name: { type: "positional", description: "The task's name in agent-unit.config.ts", required: true },
    root,
  },
  async run({ args }) {
    const [{ loadEnvFile, loadProject }, { runTask }] = await Promise.all([import("./build/load"), import("./build/tasks")]);
    try {
      loadEnvFile(args.root);
      const result = await runTask(await loadProject(args.root), args.name);
      console.log(`agent-unit task ${args.name}: done${result === undefined ? "" : `\n${JSON.stringify(result, null, 2)}`}`);
    } catch (error) {
      console.error(`agent-unit task ${args.name}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  },
});

const manifest = defineCommand({
  meta: { name: "manifest", description: "Print the agents, frameworks and tools agent-unit finds" },
  args: { root },
  async run({ args }) {
    const { startDev } = await import("./build/dev");
    const server = await startDev({ root: args.root, port: 0, watch: false });
    try {
      if (server.server) {
        console.error(`agent-unit manifest: this app serves its own server (${server.server}), so there are no agent-unit agents to list.`);
        process.exitCode = 1;
      } else console.log(JSON.stringify(server.unit().engine.manifest(), null, 2));
    } finally {
      await server.close();
    }
  },
});

void runMain(
  defineCommand({
    meta: { name: "agent-unit", version, description: "Build any agent server for any host, with durable runs when you want them" },
    subCommands: { init, dev, build, add, task, manifest },
  }),
);
