# agent-unit

Build any agent server for any host.

Give agent-unit the server you already have, or the agents you want served, and one command,
`agent-unit build --preset <host>`, turns it into a deployable build for Node, Bun, Deno, Cloudflare
Workers, Vercel, Netlify or AWS Lambda. It handles what each host does differently, so your code
does not have to.

```
your Hono or Fetch server ─┐
Mastra's own server ───────┼──► agent-unit build --preset <host> ──► Node · Bun · Deno · Workers
agents/ on agent-unit's    │                                         Vercel · Netlify · AWS Lambda
  durable run engine ──────┘
```

- **Your server, any host.** A Hono app, a `{ fetch }` handler or Mastra's own server builds for
  every host unchanged. Your framework keeps its routes, memory and storage.
- **One config for every host.** `presets` sets each host's settings in one
  `agent-unit.config.ts`: runs on disk on Node, a Durable Object per run on Workers, Redis on
  Vercel. Secrets are read where the server runs, never written into the build.
- **The gaps between hosts, handled.** `agent-unit/env` reads configuration and bindings the same
  way everywhere, `waitUntil` keeps work running after a response, `tasks` run on each host's own
  scheduler, and Workers get the Node modules agent SDKs import.
- **Durable runs when you want them.** agent-unit's optional engine serves agents from the AI SDK,
  Mastra, the OpenAI Agents SDK, LangGraph or plain TypeScript with runs that pause for a person,
  sleep for days and resume after a crash or a redeploy without repeating a model call or a side
  effect. Every agent gets the same HTTP API, a resumable event stream, an MCP endpoint and an A2A
  agent card.

## Start a new app

```sh
npm create agent-unit@latest my-agent    # or: pnpm create agent-unit, bun create agent-unit, npx agent-unit init
```

It asks for the framework (Mastra, the AI SDK, LangGraph, the OpenAI Agents SDK, agent-unit's own
`defineAgent`, or a plain Hono server), whether agent-unit's engine or the framework's own server
runs it (LangGraph and the OpenAI Agents SDK always run on the engine), the hosts to deploy to,
Mastra's storage, the model provider and extras (a scheduled task, bearer-token auth, background
work with `waitUntil`, a test that runs offline), and writes an app with one working agent, a
`build` script per host (with `start` for Node, Bun and Deno, and `deploy` for Cloudflare, Vercel,
Netlify and AWS Lambda; see [Deploy in one command](#deploy-in-one-command)), and a README with each
host's steps.

- **On the engine** (the default for the AI SDK), the agent asks a person before it refunds an
  order, and the run resumes where it stopped. One `agent-unit.config.ts` sets each host's run
  storage with `presets`: on disk on Node, Bun and Deno, a Durable Object per run on Workers, and
  Upstash on Vercel, Netlify and AWS Lambda.
- **On its own server** (the default for Mastra), Mastra keeps its routes and storage: Mastra's D1
  store on Workers and the store you chose everywhere else.

Every answer has a flag, for scripts and CI:

```sh
npx agent-unit init my-agent --framework ai-sdk --runner engine --hosts node,cloudflare,vercel \
  --provider openai --extras auth --no-install
```

`--yes` takes the default for anything not given.

Run it in an app you already have (a directory with a `package.json`) to add agent-unit to it. The
framework the app uses is the default, and nothing of yours is replaced:

- **Your own server.** For a Hono server, or an AI SDK app on its own server, an existing
  `src/server.ts` or `src/index.ts` (any of `.ts`, `.mts`, `.js`, `.mjs`) is what gets built, as it
  is; `init` warns when it has no default export or starts a server of its own.
- **Your Mastra instance.** It keeps its own storage and model keys.
- **`package.json`.** It gains only missing dependencies and scripts. A script name you already use
  gets agent-unit's under `agent-unit:<name>`, so `npm run dev` stays yours.
- **`.gitignore` and `.env.example`.** They gain only missing lines.
- **Other files.** Each is written only where none exists. Your README and TypeScript setup are left
  alone.

## Build your server for any host

Already have a server, from your agent framework or written by hand? Point `server` at it and
agent-unit builds it for every host in [Deploy anywhere](#deploy-anywhere), with none of its own
engine, routes or storage added. Your framework keeps its own runs, memory and storage.

```ts
// agent-unit.config.ts
import { defineConfig } from "agent-unit";

export default defineConfig({
  server: "./src/server.ts",
  cloudflare: { wrangler: { d1_databases: [{ binding: "DB", database_name: "app", database_id: "…" }] } },
});
```

```ts
// src/server.ts
import { Hono } from "hono";
import { env } from "agent-unit/env";

const app = new Hono();
app.get("/", (c) => c.text(`hello from ${env.APP_NAME}`));

export default app;
```

The default export handles web requests: a Hono app, `export default { fetch }`, or a function
`(request, env, ctx) => Response`. On Workers it receives the Worker's `env` and `ctx`; elsewhere `ctx`
has `waitUntil` where the host keeps work alive after the response. `agent-unit/env` reads
configuration the same way on every host. `agent-unit dev` serves it with reload on change and
reads `.env` (variables already set win). The engine settings (`agents`, `agentsDir`, `storage`,
`runtime`, `budget`, `sweep`, `retention`, `basePath`, `authorize`, `origin`, `maxBodyBytes`,
`adapters`) do not apply and are rejected with `server`, at the top level and in `presets`.

### Background work and scheduled tasks

`waitUntil` from `agent-unit/env` keeps work running after the response (an email, a webhook, a
cache write). It uses the host's own `waitUntil` on Node, Bun, Deno, Workers and Vercel; on Netlify
and AWS Lambda, which may freeze after a response, the response waits for the work instead (a
streamed response ends once work handed over while it streams is done). Hono's
`c.executionCtx.waitUntil` does the same.

```ts
import { waitUntil } from "agent-unit/env";

app.post("/orders", async (c) => {
  const order = await createOrder(await c.req.json());
  waitUntil(sendReceipt(order));
  return c.json(order, 201);
});
```

`tasks` runs work on a schedule with the host's own scheduler: in-process cron on Node, Bun and
Deno, Cron Triggers on Workers, Vercel Cron Jobs on Vercel. Other presets build with a warning, and
the task runs only when you trigger it there. The build checks each schedule: servers also take a
seconds field and nicknames such as `@daily`; Workers and Vercel take the five fields only.

```ts
export default defineConfig({
  server: "./src/server.ts",
  tasks: { "send-digest": { schedule: "0 8 * * *", handler: "./src/tasks/digest.ts" } },
});
```

```ts
// src/tasks/digest.ts
export default async ({ name, scheduledTime }: { name: string; scheduledTime: number }) => {
  await sendDigest(new Date(scheduledTime));
};
```

`scheduledTime` is when the task starts running (the hosts' schedulers pass no scheduled time).
`npx agent-unit task send-digest` runs it once from source.

### Mastra

A Mastra app needs no server file and no config. agent-unit finds your Mastra instance
(`src/mastra/index.ts`, `export const mastra`) and serves it with Mastra's own Hono adapter, so
every Mastra route, its auth, memory and workflows work as they do under `mastra dev`, on the
storage your instance configures.

```sh
npm install agent-unit @mastra/hono hono
npx agent-unit build --preset vercel
```

It follows your instance's `server` settings the way `mastra build` does: `apiPrefix`, `cors`,
`timeout`, `bodySizeLimit`, `apiRoutes`, `middleware`, and a `/health` route. A `deployer` left over
from `mastra build` is ignored. To point at another file or export, set the preset yourself:

```ts
// agent-unit.config.ts
import { defineConfig } from "agent-unit";
import { mastra } from "agent-unit/presets/mastra";

export default defineConfig({ server: mastra({ entry: "./src/ai/mastra.ts", export: "app" }) });
```

Storage stays Mastra's. To use a different store per host, let the build pick it with a
`package.json` import condition: Cloudflare builds resolve `workerd`, everything else `default`.

```json
{ "imports": { "#storage": { "workerd": "./src/storage.d1.ts", "default": "./src/storage.libsql.ts" } } }
```

```ts
// src/storage.d1.ts: Mastra's D1 store on the Worker's DB binding (declare it in your
// wrangler file or in `cloudflare.wrangler`; a binding declared in both is kept once)
import { D1Store } from "@mastra/cloudflare-d1";
import { env } from "agent-unit/env";

export const storage = new D1Store({ id: "app", binding: env.DB });
```

On Workers, the Mastra preset leaves out the TypeScript compiler, which Mastra's server imports
only to check project files on disk: it was 1.4 MB gzipped of a 4.7 MB Worker. To bundle it
anyway, set `nitro: { alias: { typescript: "typescript" } }`.

Mastra's D1 store cannot de-duplicate two simultaneous resumes of the same workflow run (Mastra
logs a warning saying so); stores with atomic updates, such as LibSQL and Postgres, can. Other
frameworks can publish a preset the same way: `server` takes any object with a `name` and an
`entry({ root, genDir, preset })` that returns the path of a server module.

### LangGraph, the OpenAI Agents SDK and others

Frameworks without a server of their own run in yours. Give the framework its own durable storage
and point `server` at the file:

```ts
// src/server.ts: LangGraph, paused and resumed from its own checkpointer
import { Hono } from "hono";
import { Command } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { env } from "agent-unit/env";
import { workflow } from "./graph";

const checkpointer = PostgresSaver.fromConnString(env.DATABASE_URL);
await checkpointer.setup(); // creates LangGraph's tables the first time
const graph = workflow.compile({ checkpointer });
const app = new Hono();
app.post("/threads/:id/runs", async (c) =>
  c.json(await graph.invoke(await c.req.json(), { configurable: { thread_id: c.req.param("id") } })));
app.post("/threads/:id/resume", async (c) =>
  c.json(await graph.invoke(new Command({ resume: await c.req.json() }), { configurable: { thread_id: c.req.param("id") } })));

export default app;
```

```ts
// src/server.ts: the OpenAI Agents SDK, approvals kept as a serialized RunState
import { Hono } from "hono";
import { RunState, run } from "@openai/agents";
import { support } from "./agent";
import { pending } from "./store"; // any key-value store you choose

const app = new Hono();
app.post("/runs", async (c) => {
  const result = await run(support, (await c.req.json()).input);
  if (!result.interruptions?.length) return c.json({ output: result.finalOutput });
  const id = crypto.randomUUID();
  await pending.set(id, result.state.toString());
  return c.json({ id, approvals: result.interruptions.map((item) => item.rawItem) }, 202);
});
app.post("/runs/:id/approve", async (c) => {
  const state = await RunState.fromString(support, await pending.get(c.req.param("id")));
  for (const item of state.getInterruptions()) state.approve(item);
  return c.json({ output: (await run(support, state)).finalOutput });
});

export default app;
```

Prefer agent-unit to handle durability for you? Leave `server` out and use
[its engine](#durable-runs-with-agent-units-engine).

## Deploy anywhere

```sh
npx agent-unit build --preset <preset>
```

| Host | Preset | Storage | Long runs | Sleep and recovery |
| --- | --- | --- | --- | --- |
| Node | `node-server` (default) | Filesystem by default | Unlimited | In-process timers + sweep every minute |
| Bun | `bun` | Filesystem by default | Unlimited | In-process timers + sweep |
| Deno | `deno-server` | Filesystem by default | Unlimited | In-process timers + sweep |
| Cloudflare Workers | `cloudflare-module` with `runtime: "durable-objects"` | One Durable Object per run (no storage to configure) | Yields every 10 min and continues from an alarm | Each run's own alarm |
| Cloudflare Workers (KV) | `cloudflare-module` | Set `storage` (for example `cloudflare-kv-binding`) | Yields every 25s and continues | Cron Trigger runs the sweep |
| Vercel | `vercel` | Set `storage` (Upstash, Redis, …) | Yields every 240s and continues | Vercel Cron runs the sweep (see below for the Hobby plan) |
| Netlify | `netlify` | Set `storage` (`netlify-blobs`, Redis, …) | Yields every 20s; finishes in the request | Generated scheduled function (needs `AGENT_UNIT_SECRET`) |
| AWS Lambda | `aws-lambda` | Set `storage` (Redis, Upstash, a database via db0, …) | Yields every 25s; finishes in the request | Point EventBridge at `POST /__agent-unit/sweep` with `Authorization: Bearer <AGENT_UNIT_SECRET>` |

The storage, long-run and sweep columns are for agent-unit's engine; your own server keeps whatever
storage it already uses.

Cloudflare builds turn on Workers' stub modules for `child_process`, `readline`, `worker_threads`
and `tty`, and replace the Node `ws` package with the built-in WebSocket: Mastra and the OpenAI
Agents SDK import these when they load, and one missing module stops the whole Worker from starting.
Your own `compatibility_flags` and `alias` settings are kept.

Any other [Nitro preset](https://nitro.build/deploy) works too. Serverless hosts need shared
storage, because their filesystem does not survive between invocations; without one the build warns
and keeps runs in memory, which an invocation does not keep. Set `AGENT_UNIT_SECRET` in production: it protects the internal continue and sweep
endpoints, which serverless hosts use to continue long runs. A long run continues in a fresh
invocation at the deployment's own URL, read from `AGENT_UNIT_URL` (or `VERCEL_URL`, Netlify's `URL`,
or the `origin` option) and never from an incoming request; without one it continues in-process.

On Vercel's Hobby plan, cron jobs run at most once a day, and a deploy with a more frequent one
fails. The engine's sweep (which wakes sleeping runs and recovers stalled ones) runs every minute by
default, so on Hobby set `presets: { vercel: { sweep: "0 0 * * *" } }`, or `sweep: false`. Apps from
`agent-unit init` start with the daily sweep on Vercel.

### Deploy in one command

An app from `agent-unit init` has a `deploy` script for each platform (`deploy:<host>` when it has
several), and its README has the same steps:

| Platform | `npm run deploy` runs | Once, before the first deploy |
| --- | --- | --- |
| Cloudflare Workers | the build, then `npx wrangler@4 deploy` | `npx wrangler@4 login` (in CI, `CLOUDFLARE_API_TOKEN`); each secret with `npx wrangler@4 secret put <NAME>` |
| Vercel | the build, then `npx vercel deploy --prebuilt --prod` | `npx vercel link`; each variable with `npx vercel env add <NAME> production` |
| Netlify | `npx netlify-cli deploy --prod`, which builds from the app's `netlify.toml` | `npx netlify-cli login` (in CI, `NETLIFY_AUTH_TOKEN`); the first deploy creates or links the site |
| AWS Lambda | the build, then `sam deploy` with the app's `template.yaml` | the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) and AWS credentials; the first time, `npm run deploy -- --guided` |

Node, Bun and Deno get a `start` script for the built server, which any host that runs a long-lived
process can use. `npm run preview:cloudflare` runs a Workers build on Cloudflare's own runtime
locally, with its Durable Objects, before you deploy.

Vercel runs cron jobs only on production deployments, so the deploy is `--prod`; set `CRON_SECRET`
there so only Vercel can call them. The Lambda template gives the function Node.js 22, a five-minute
timeout (Lambda's default is three seconds) and a public function URL, printed as `Url` after the
deploy; each variable in `.env.example` is a deploy parameter.

### One config for every host

Hosts need different settings: runs on disk on Node, a Durable Object per run on Workers, Redis on
Vercel. `presets` sets them per preset, over the top-level settings, so one app builds for all of
them with no environment variables to switch:

```ts
export default defineConfig({
  retention: "30d",
  presets: {
    "cloudflare-module": { runtime: "durable-objects" },
    // Reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN when it runs, or KV_REST_API_URL and
    // KV_REST_API_TOKEN, the names a Redis database from Vercel's Marketplace gets.
    vercel: { storage: { driver: "upstash" } },
  },
});
```

Each setting there replaces the top-level value whole. The settings that can differ per preset are
`storage`, `runtime`, `budget`, `retention`, `sweep`, `basePath`, `authorize`, `origin`,
`maxBodyBytes`, `tasks`, `cloudflare` and `nitro`. `agent-unit dev` uses the top-level settings.
The `agent-unit/nitro` module applies the entry for the app's Nitro preset too, except `runtime`,
`cloudflare` and `nitro` (see [Mount it in an existing app](#mount-it-in-an-existing-app)).

The build keeps the config as code and evaluates it where the server runs, so `url:
process.env.REDIS_URL` reads the server's environment and no secret is written into the build. The
storage driver is the one exception: the build includes the driver the config chooses at build
time, and the server stops at startup with a message if the config chooses another one where it
runs. Give the build and the server the same environment, or choose storage per host with `presets`.
Builds do not read `.env` (`agent-unit dev` and `agent-unit task` do), so set what the config reads
at build in the build's environment.

## Durable runs with agent-unit's engine

Leave `server` out, and agent-unit serves the agents in `agents/` on its own run engine
(`@agent-unit/runtime`, installed with agent-unit). Model calls and tool calls are journaled, so a
run that continues after a pause, a restart or a crash replays finished work instead of running it
again: the provider is not billed twice and a refund is not charged twice. `run.interrupt()` parks a
run until someone answers and `run.sleep("2d")` until a time passes, using no compute meanwhile, on
any host.

### Quick start

```sh
npm install agent-unit
```

```ts
// agents/refund.ts
import { defineAgent } from "agent-unit";

export default defineAgent({
  description: "Refunds an order after a human approves it.",
  async run(input, run) {
    const order = await run.step("load-order", () => loadOrder(input.orderId));
    const decision = await run.interrupt<{ approved: boolean }>("approve-refund", order);
    if (!decision.approved) return "declined";
    await run.step("charge", () => refund(order)); // journaled: resuming never repeats it
    return "refunded";
  },
});
```

```sh
npx agent-unit dev          # http://localhost:3000, reloads on change
npx agent-unit build        # .output/server/index.mjs for Node
node .output/server/index.mjs
```

```sh
curl -X POST localhost:3000/agents/refund/runs \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"input":{"orderId":"o_1"}}'
# … event: RUN_INTERRUPTED  {"interrupt":{"name":"approve-refund","payload":{…}}}

curl -X POST localhost:3000/runs/run_…/resume \
  -H 'content-type: application/json' -d '{"answer":{"approved":true}}'
```

Every file in `agents/` is an agent named after the file (`agents/support/index.ts` serves as
`support`). Export a framework agent or a `defineAgent` agent as the default export.

### Bring your framework

agent-unit recognises agents from these frameworks when your `package.json` depends on them:

| Framework | Export | What becomes durable | How it pauses |
| --- | --- | --- | --- |
| [AI SDK](https://ai-sdk.dev) | `new ToolLoopAgent(…)` or `streamText` settings | Every model call and tool call | `useRun().interrupt()` in a tool |
| [Mastra](https://mastra.ai) | `new Agent(…)` | Every model call and tool call (on a fork; your agent is untouched); memory uses the run's thread | Tool approvals (`requireApproval`, `requireToolApproval`), `suspend()` in a tool |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) | `new Agent(…)` | Model responses and function tools, per turn; handoffs included, `handoff()` options too | Tool approvals (`needsApproval: true`) |
| [LangGraph](https://langchain-ai.github.io/langgraphjs/) | `graph.compile()` | LangGraph checkpoints, stored in agent-unit storage | `interrupt()` in a node, resumed with `Command({ resume })` |
| Plain TypeScript | `defineAgent(…)` | `run.step(…)` | `run.interrupt()`, `run.sleep()` |

Every framework is tested on every host below (Node, Bun, Deno, Cloudflare Workers with Durable
Objects, Vercel, Netlify and AWS Lambda): a run pauses for approval, the host restarts, and the
resume repeats no model call or side effect.

Events follow [AG-UI](https://docs.ag-ui.com): text streams as `TEXT_MESSAGE_*`, a model's
reasoning as `REASONING_*`, and `RUN_FINISHED` carries token usage per provider and model (also on
the run as `usage`). An agent that asks for structured output (AI SDK `output`, Mastra
`structuredOutput`, OpenAI Agents `outputType`) finishes with that object as its `output`.

A framework's own pauses become agent-unit interrupts, answered with `POST /runs/:id/resume`:

- **Tool approvals** (OpenAI Agents `needsApproval`, Mastra `requireApproval` or
  `requireToolApproval`) pause as `tool-approval` with `{ callId, tool, arguments, agent }`. Answer
  `true`, `false` or `{ approved }`; a declined call is not run and the model is told so.
- **Mastra `suspend(payload)`** in a tool pauses under the tool's name with that payload. The answer
  becomes the tool's `resumeData` when it runs again, as with Mastra's own resume.
- **LangGraph `interrupt(value)`** in a node pauses under the node's name; the answer resumes it.

```ts
// agents/support.ts: an AI SDK agent, unchanged except for the approval
import { useRun } from "agent-unit";
import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent, tool } from "ai";
import { z } from "zod";

export default new ToolLoopAgent({
  model: openai("gpt-5"),
  tools: {
    refund: tool({
      description: "Refund an order",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => {
        const { approved } = await useRun().interrupt<{ approved: boolean }>("approve-refund", { orderId });
        return approved ? await refund(orderId) : "declined";
      },
    }),
  },
});
```

When the run resumes, the model's first response comes from the journal, the tool call continues
with the answer, and only new work reaches the provider.

#### Run primitives

Inside any run, `useRun()` (or the `run` argument of `defineAgent`) gives you:

| Primitive | |
| --- | --- |
| `run.step(name, fn)` | Run `fn` once; replays return the journaled result. `fn` receives `{ idempotencyKey }` |
| `run.idempotencyKey()` | The key of the step or tool call running now |
| `run.interrupt(name, payload)` | Park until `POST /runs/:id/resume` answers, then return the answer |
| `run.sleep("10m")` | Park until the time passes |
| `run.state.get/set/delete(key, { scope })` | State scoped to the `thread` (default), the `agent` or the `app` |
| `run.secrets.get(name)` | Read a secret from the host environment (Workers bindings included) |
| `run.emit(name, value)` | Emit a `CUSTOM` event |
| `run.signal` | Aborts when the run is cancelled or parked |

The one rule: between steps, code must make the same decisions given the same journaled results.
Put anything with side effects or randomness in a step. Model and tool calls already are.

A step is recorded when it finishes. If the process dies while a step is still running, that step
runs again when the run recovers. Every step gets an idempotency key that stays the same when it
runs again and differs for every other step and run; hand it to the API the step calls, and the
repeat has no second effect:

```ts
await run.step("charge", ({ idempotencyKey }) =>
  stripe.refunds.create({ payment_intent: order.paymentId }, { idempotencyKey }),
);
```

Inside a tool the framework calls (AI SDK, Mastra, OpenAI Agents), `useRun().idempotencyKey()`
returns the tool call's key. In a LangGraph node, wrap the side effect in `useRun().step(…)`.

### Cloudflare Durable Objects

On Cloudflare, give every run its own Durable Object, the same primitive Cloudflare's own agents
run on:

```ts
// agent-unit.config.ts
export default defineConfig({ preset: "cloudflare-module", runtime: "durable-objects" });
```

```sh
npx agent-unit build && npx wrangler deploy
```

Your agent code does not change. Each run's object holds its journal and events in strongly
consistent storage and is the only thing that ever executes it, so there are no leases to race. Its
alarm wakes it from `run.sleep`, continues it after a long step, and picks it up again if the
isolate running it dies. A shared index object keeps the run list and thread, agent and app state.
The build exports both classes and writes their bindings and migration into `wrangler.json`.

Your app can bring its own Cloudflare resources beside agent-unit's: D1, KV or R2 for a storage
provider, or its own Durable Objects (Mastra's Cloudflare store ships one, as does a Workflow). Write
them in Cloudflare's own `wrangler.json` format under `cloudflare`, and export your classes from a
file:

```ts
export default defineConfig({
  preset: "cloudflare-module",
  runtime: "durable-objects",
  cloudflare: {
    wrangler: {
      d1_databases: [{ binding: "DB", database_name: "memory", database_id: "…" }],
      durable_objects: { bindings: [{ name: "STORE", class_name: "StoreObject" }] },
    },
    exports: "./store.ts", // or exports.cloudflare.ts, picked up on its own
  },
});
```

To connect your storage the same way on every host, read your bindings and secrets from
`agent-unit/env`. Builds for Workers resolve it to the Workers environment (bindings included);
everywhere else it is `process.env`:

```ts
import { env } from "agent-unit/env";

const storage = env.DB ? new D1Store({ binding: env.DB }) : new LibSQLStore({ url: env.DATABASE_URL });
```

They are merged into what agent-unit generates, never in its place: the names `AGENT_UNIT_RUNS`,
`AGENT_UNIT_INDEX`, `AgentUnitRun`, `AgentUnitIndex` and the migration tag `agent-unit-v1` are
reserved, and the build says so if you reuse one. (`nitro.cloudflare` is the same setting and still
works.)

agent-unit's migration comes before yours. Wrangler applies only the migrations listed after the
last one a Worker has applied, so a Worker that applied migrations of its own before taking this
runtime lists a bare `{ tag: "agent-unit-v1" }` after them, and agent-unit's migration goes there:

```ts
cloudflare: { wrangler: { migrations: [{ tag: "v1", new_sqlite_classes: ["Notes"] }, { tag: "agent-unit-v1" }] } },
```

In a Worker you write yourself:

```ts
import { createDurableAgentUnit } from "agent-unit/cloudflare";
import { aiSdkAdapter } from "agent-unit/adapters/ai-sdk";
import support from "./agents/support";

// A framework's agent needs its adapter here; agent-unit build finds them on its own.
const unit = createDurableAgentUnit({ agents: { support }, adapters: [aiSdkAdapter] });

export const { AgentUnitRun, AgentUnitIndex } = unit;
export default { fetch: unit.fetch };
// wrangler.json: copy unit.wrangler (durable_objects bindings + migrations)
```

### Talk to your agents

#### HTTP and events

The full contract is in [`spec/`](./spec). Events follow [AG-UI](https://docs.ag-ui.com) (`RUN_STARTED`,
`TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, …) plus `RUN_INTERRUPTED`, `RUN_SLEEPING` and
`RUN_CANCELLED`. Every event has a `seq`; it is the SSE event id, so `EventSource` reconnects with
`Last-Event-ID` and picks up exactly where it left off.

#### Typed client

```ts
import { createAgentClient } from "agent-unit/client";

const agents = createAgentClient({ baseUrl: "https://agents.example.com" });

for await (const event of agents.run("refund", { orderId: "o_1" })) {
  if (event.type === "RUN_INTERRUPTED") console.log("needs approval:", event.interrupt.payload);
}
for await (const event of agents.resume(runId, { approved: true })) console.log(event.type);

await agents.list({ status: "interrupted" }); // an approvals inbox in one call
await agents.delete(runId);                   // remove a finished run and its history
```

The client reconnects dropped streams from the last event it saw.

#### MCP and A2A

`POST /mcp` speaks MCP over streamable HTTP: every agent is a tool, so Claude, Cursor or any MCP
client can call your agents. A run that pauses returns its run id and the pending interrupt.
`GET /.well-known/agent.json` is an A2A agent card with one skill per agent.

### Testing

```ts
import { createTestUnit } from "agent-unit/testing";
import refund from "../agents/refund";

const unit = createTestUnit({ refund });
const parked = await unit.run("refund", { orderId: "o_1" });
expect(parked.status).toBe("interrupted");
const done = await unit.resume(parked.id, { approved: true });
expect(done.output).toBe("refunded");
```

Pass the same `storage` to a second `createTestUnit` to test a restart.

A framework's agent runs the same way, on a scripted model so the test needs no API key. Builds find
the framework's adapter on their own; a test unit is given it:

```ts
import { aiSdkAdapter } from "agent-unit/adapters/ai-sdk";
import { MockLanguageModelV4 } from "ai/test";

const unit = createTestUnit({ assistant: createAssistant(new MockLanguageModelV4({ doStream })) }, { adapters: [aiSdkAdapter] });
```

`agent-unit init --extras test` writes such a test for every engine agent: `defineAgent`'s as it is,
and AI SDK, Mastra, LangGraph and OpenAI Agents SDK agents on a scripted model.

### Mount it in an existing app

Already on Nitro (or something built on it)? Mount your agents with the module. It serves the
agents in `agents/` with the settings in `agent-unit.config.ts` (and its `presets` entry for the
app's Nitro preset), runs the sweep and the config's `tasks`, and keeps runs in an `agent-unit`
storage mount the app already has. The Durable Objects runtime needs `agent-unit build`, and Workers
or Nitro settings go in your `nitro.config`:

```ts
// nitro.config.ts
import { defineConfig } from "nitro";
import { agentUnit } from "agent-unit/nitro";

export default defineConfig({
  modules: [agentUnit({ basePath: "/api/agents" })],
});
```

In a [Farm](https://farmjs.dev) app, mount it with one catch-all API route, which works in
`farm dev` and every production target (see [`examples/farm-app`](./examples/farm-app)):

```ts
// src/app/api/ai/[...path]/route.ts
import { after } from "@farm.js/core/after";
import { agents } from "../../../../agents/server"; // createAgentUnit({ …, basePath: "/api/ai" })

const handle = (request: Request) =>
  agents.handler(request, { waitUntil: (work) => after(async () => void (await work)) });

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
```

Anywhere else that speaks Fetch (Hono, Next.js route handlers, Bun.serve, Deno.serve, a Worker):

```ts
import { createAgentUnit } from "agent-unit/server";
import { aiSdkAdapter } from "agent-unit/adapters/ai-sdk";
import { createStorage } from "unstorage";
import redis from "unstorage/drivers/redis";
import support from "./agents/support";

const unit = createAgentUnit({
  agents: { support },
  adapters: [aiSdkAdapter], // a framework's agent needs its adapter; agent-unit build adds them itself
  storage: createStorage({ driver: redis({ url: process.env.REDIS_URL }) }),
  basePath: "/api/agents",
});

export const fetch = (request: Request, ctx?: { waitUntil(p: Promise<unknown>): void }) =>
  unit.handler(request, { waitUntil: ctx?.waitUntil.bind(ctx) });
```

Pass the host's `waitUntil` where it has one. Without it, start and resume requests finish the work
before they answer, which is the safe behaviour on hosts that freeze after a response.

### Customize

agent-unit is layered. Pick the layer that matches what you are changing:

| You want to… | Layer | Who |
| --- | --- | --- |
| Pause, sleep, keep state, make a call run once | Run primitives: `useRun()` / `run.step`, `run.interrupt`, `run.sleep`, `run.state` | App developers, in agent code |
| Choose host, storage, runtime, auth, time budget | `agent-unit.config.ts` | App developers |
| Mount the API in your own server, add routes, compose | `createAgentUnit()`, `createDurableAgentUnit()`, `createHandler()` | App developers |
| Support a new framework | `defineAdapter()` with `ctx.durable`, `ctx.kv`, `ctx.emit` | Framework and library authors |
| Run agents on a new kind of runtime | `RunEngine` options, or your own `RunService` | Runtime and platform authors |

**Mount and compose.** `createAgentUnit` returns a Web `handler`, so it sits beside your own
routes, middleware and auth:

```ts
import { createAgentUnit } from "agent-unit/server";

const unit = createAgentUnit({
  agents: { support },
  adapters: [aiSdkAdapter],      // from agent-unit/adapters/ai-sdk: the frameworks your agents use
  storage,                       // any unstorage instance
  basePath: "/api/agents",
  // Second argument: what the request does, with the run's agent and thread taken from storage.
  // Here each user's runs are on threads named "<user id>:…", so a run must be started with one.
  authorize: async (request, { action, threadId }) => {
    const session = await getSession(request);
    if (session === null) return false;
    // Listing without a thread is fine: the list keeps only the runs this check lets the caller read.
    if (action === "manifest" || action === "mcp" || (action === "list" && threadId === undefined)) return true;
    return threadId?.startsWith(`${session.userId}:`) === true;
  },
  budget: "60s",
});

// Any Fetch-style router, here Hono:
app.all("/api/agents/*", (c) => unit.handler(c.req.raw));
```

**Build on the engine.** Everything the HTTP API does goes through `RunEngine`, which you can drive
directly (a queue consumer, a cron job, a test):

```ts
import { RunEngine, RunStore, resolveAgent } from "agent-unit/runtime";

const engine = new RunEngine({
  store: new RunStore(storage),
  agents: [resolveAgent("support", support, [myAdapter])],
  budgetMs: 60_000,
  // Hand wake-ups to your own scheduler (a delayed queue message, a job runner…) instead of timers:
  scheduleWake: (runId, at) => scheduler.at(at, () => engine.handleWake(runId)),
});

const { run, done } = await engine.start("support", { prompt: "refund o_1" });
```

**A new runtime.** `createHandler(service)` serves the whole API (runs, SSE, MCP, A2A) from any
object that implements `RunService` from `agent-unit/server`. The Durable Objects runtime is one
such implementation: it routes each call to the run's object instead of running it in-process.

### Adapters for other frameworks

AI SDK, Mastra, OpenAI Agents and LangGraph are supported out of the box. Any other framework can
publish its own adapter package and maintain it on its own schedule: no change to agent-unit, no
pull request. To use one:

```sh
npx agent-unit add agent-unit-adapter-crew
```

It installs the package, checks that it is an adapter, and adds two lines to
`agent-unit.config.ts` (asking first; `--yes` skips the question). Adding them by hand works the same:

```ts
import crewAdapter from "agent-unit-adapter-crew";
export default defineConfig({ adapters: [crewAdapter()] });
```

Adapters in the config are tried before the built-in ones, so a framework's own adapter replaces
agent-unit's.

#### Write and publish an adapter

An adapter teaches agent-unit one framework. Most are a few dozen lines:

```ts
// agent-unit-adapter-crew/src/index.ts
import { defineAdapter } from "agent-unit/adapter";
import { CrewAgent } from "crew";

export default function crewAdapter() {
  return defineAdapter<CrewAgent>({
    name: "crew",
    apiVersion: 1, // the adapter interface this was written for
    match: (value): value is CrewAgent => value instanceof CrewAgent,
    describe: (agent) => ({ description: agent.description, tools: agent.tools.map(({ name }) => ({ name })) }),
    async run(agent, ctx) {
      const model = ctx.durable.model(agent.model); // journaled, streams text events
      const tools = ctx.durable.tools(agent.tools); // journaled, emits tool events
      return agent.run(ctx.input, { model, tools, signal: ctx.signal });
    },
  });
}
```

To publish it:

- **Export a function returning the adapter as the default export**, so `agent-unit add` can find it.
- **Name it** `agent-unit-adapter-<framework>`, or `@your-scope/agent-unit`, and add the
  `agent-unit-adapter` keyword, so people can find it on npm.
- **Declare `agent-unit` and your framework as peer dependencies**, so the app's copies are used.
- **Check it** with the same checks agent-unit runs on its own adapters, in any test runner. Report
  every real side effect through `kit.effect`; the checks fail when one runs outside a journaled
  call, or runs again after a restart:

```ts
import { assertAdapter } from "agent-unit/testing";

test("agent-unit adapter", () =>
  assertAdapter({
    adapter: crewAdapter(),
    agent: (kit) => new CrewAgent({ model, tools: [refundTool(() => kit.effect("refund"))] }),
    // Optional: an agent that pauses through your framework, and the answer that resumes it.
    pause: { agent: (kit) => approvalAgent(kit), answer: { approved: true } },
  }));
```

See [spec/adapters.md](./spec/adapters.md) for adapters of frameworks that keep their own state.

### Several servers, one store

Run as many instances as you like over one store. With Redis it is exact out of the box:

```ts
storage: { driver: "redis", url: process.env.REDIS_URL },
```

With `createAgentUnit` on your own server, wrap the storage yourself:

```ts
import { RunStore } from "agent-unit/runtime";
import { redisCoordination } from "agent-unit/redis";
import { createStorage } from "unstorage";
import redis from "unstorage/drivers/redis";

const driver = redis({ url: process.env.REDIS_URL });
const storage = new RunStore(createStorage({ driver }), redisCoordination({ client: () => driver.getInstance!() }));
// createAgentUnit({ agents, storage })
```

`redisCoordination` needs one method, `eval`, so any client with Lua scripting works (ioredis,
node-redis behind a small wrapper). For another store, implement `AtomicWrites.compareAndSet` (save
a run record only if its `version` is still the one read) and `LeaseBackend` with that store's own
conditional write, such as a database `UPDATE … WHERE version = ?`.

### Limits

- Leases make one execution run a run at a time, renewed while it works, and every change to a run
  record is a versioned save: it lands only if nobody else saved the run since it was read, so two
  processes racing to resume, cancel or wake a run cannot both win (the loser gets a 409). On Redis
  both are atomic, wired in automatically by `agent-unit build` and `agent-unit dev` when `storage`
  uses the `redis` driver. On other shared stores the save is check-then-write, which is exact
  within a process and best effort across processes racing within milliseconds; pass atomic
  `leases` and `atomic` writes to `RunStore` for those (see [Several servers, one store](#several-servers-one-store)), or use the Durable Objects
  runtime, where each run's object is its only executor and saves go through the index atomically.
- A Mastra agent with memory reads the run's thread (and `input.resourceId`, or the thread, as its
  resource) and stores each finished turn once. With working or observational memory turned on,
  Mastra saves messages itself as the turn runs, so a run that pauses or recovers from a crash may
  store that turn twice.
- In the Durable Objects runtime, the run list and shared state live in one index object, written when
  a run starts, parks or finishes (not on every step). `agent-unit dev` runs the default runtime
  locally.
- The time budget is checked between steps, so a step that is already running (a slow model call,
  with its SDK's retries) finishes before the run yields, and can run past the budget. Give the
  host's function a timeout above your longest step: the Lambda template `agent-unit init` writes
  allows five minutes, against Lambda's three-second default.
- Streamed text and tool-argument deltas that arrive within 50ms of each other are merged into one
  event, so a long answer costs a few writes instead of one per token, and live clients see text up
  to 50ms later. `deltaBatchMs: 0` on `createAgentUnit` keeps every delta its own event.

## Examples

| Example | What it shows |
| --- | --- |
| [`examples/universal`](./examples/universal) | The universal build: one `agents/` folder built for Node, Bun, Deno, Cloudflare, Vercel, Netlify and AWS Lambda, then every build run through the same pause, restart and resume flow (`npm run try`). |
| [`examples/cloudflare-ai-sdk`](./examples/cloudflare-ai-sdk) | An AI SDK `ToolLoopAgent` (OpenAI and Claude) on Cloudflare Workers with the Durable Objects runtime: a refund pauses for approval, and `npm run verify` checks it against real models across a runtime restart. |
| [`examples/farm-app`](./examples/farm-app) | Agents inside a Farm app at `/api/ai`, with an approvals inbox and live event stream at `/agents`, tested on the production server across a restart (`npm run smoke`). |

## Configuration

`agent-unit.config.ts` is optional:

```ts
import { defineConfig } from "agent-unit";

export default defineConfig({
  name: "support",                                   // manifest, MCP and A2A name
  storage: { driver: "redis", url: process.env.REDIS_URL },  // any unstorage driver
  preset: "vercel",                                  // or --preset
  runtime: "default",                                // or "durable-objects" on Cloudflare
  budget: "60s",                                     // yield and continue after this long
  sweep: "*/5 * * * *",                              // sweep schedule, or false
  basePath: "/api/agents",
  authorize: (request) => request.headers.get("authorization") === `Bearer ${process.env.API_TOKEN}`,
  retention: "30d",                                  // delete finished runs 30 days after they finish
  maxBodyBytes: 1_000_000,                           // largest accepted request body (default 1 MB)
  // server: "./src/server.ts",                      // your own server instead (see "Your own server")
  // agents: { support },                            // instead of the agents/ directory
  // adapters: [myAdapter],                          // extra framework adapters
  // nitro: { … },                                   // passed through to Nitro
  // presets: { vercel: { … } },                     // settings per host (see "One config for every host")
});
```

The config is evaluated where the server runs, so values it reads from `process.env` (a storage URL,
a token) come from the server's environment and are never written into the build.

### CLI

| Command | |
| --- | --- |
| `agent-unit init [dir]` | Start a new app, or add agent-unit to the one in `dir` (see [Start a new app](#start-a-new-app)) |
| `agent-unit dev` | Serve your server or your agents from source, reloading on change; reads `.env` (`--port`, `--host`) |
| `agent-unit build` | Build for a host (`--preset`, `--out` for the output directory, `--minify`); writes `agent-unit.json` beside an engine build, listing its agents |
| `agent-unit task <name>` | Run one of your `tasks` now, from source |
| `agent-unit manifest` | Print the agents, frameworks and tools agent-unit finds |
| `agent-unit add <package>` | Install an adapter package and add it to `agent-unit.config.ts` |

Without `--preset`, `build` uses the config's `preset`, then `NITRO_PRESET`, then `node-server`.

## License

MIT, Farming Labs.
