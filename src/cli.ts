#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { readFileSync } from "node:fs";
import { packageRoot } from "./build/load";

const version = (JSON.parse(readFileSync(`${packageRoot()}/package.json`, "utf8")) as { version: string }).version;

const root = { type: "string", description: "App directory", default: "." } as const;

const dev = defineCommand({
  meta: { name: "dev", description: "Serve your agents from source, reloading on change" },
  args: {
    root,
    port: { type: "string", description: "Port", default: process.env.PORT ?? "3000" },
    host: { type: "string", description: "Hostname to bind" },
  },
  async run({ args }) {
    const { startDev } = await import("./build/dev");
    const server = await startDev({ root: args.root, port: Number(args.port), hostname: args.host });
    const agents = server.unit().engine.manifest().agents.map((agent) => `${agent.name} (${agent.framework})`);
    console.log(`agent-unit dev: ${server.url}\n  agents: ${agents.join(", ")}`);
    const stop = async () => {
      await server.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  },
});

const build = defineCommand({
  meta: { name: "build", description: "Build a deployable server for a Nitro preset" },
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

const manifest = defineCommand({
  meta: { name: "manifest", description: "Print the agents, frameworks and tools agent-unit finds" },
  args: { root },
  async run({ args }) {
    const { startDev } = await import("./build/dev");
    const server = await startDev({ root: args.root, port: 0, watch: false });
    console.log(JSON.stringify(server.unit().engine.manifest(), null, 2));
    await server.close();
  },
});

void runMain(
  defineCommand({
    meta: { name: "agent-unit", version, description: "Durable runs for any agent framework, on any host" },
    subCommands: { dev, build, manifest },
  }),
);
