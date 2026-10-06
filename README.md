# agent-unit

Durable runs for any agent framework, on any host.

Write your agent with the AI SDK, Mastra, the OpenAI Agents SDK, LangGraph or plain TypeScript.
agent-unit makes it durable without a rewrite, so it can pause for a human, sleep for a day, survive
a crash and resume where it stopped, and deploys it to Node, Bun, Deno, Cloudflare, Vercel, Netlify or
AWS Lambda. Every agent gets the same HTTP API, a resumable event stream, an MCP endpoint and an A2A
agent card.

```
agents/refund.ts ──► agent-unit build --preset vercel ──► .vercel/output
       │                                                    ├─ POST /agents/refund/runs
  AI SDK · Mastra · OpenAI Agents · LangGraph · plain TS    ├─ GET  /runs/:id/events   (SSE, resumable)
                                                            ├─ POST /runs/:id/resume   (answer a pause)
                                                            ├─ POST /mcp               (every agent is a tool)
                                                            └─ GET  /.well-known/agent.json
```

It is to agents what [Nitro](https://nitro.build) is to servers, and it is built on Nitro: one build
and one runtime contract, with presets for every host.

- **Durable without a rewrite.** Model calls and tool calls are journaled automatically. When a run
  continues after a pause, a restart or a crash, completed work replays from the journal instead of
  running again, so the provider is not billed twice and a refund is not charged twice.
- **Pauses that cost nothing.** `run.interrupt()` parks a run until someone answers, and
  `run.sleep("2d")` until a time passes. A parked run uses no compute, on any host.
- **One contract for every framework.** The same run API, AG-UI events, manifest, MCP and A2A
  surface, whichever framework an agent uses, so a UI or an approvals inbox works with all of them.
- **No deployers to maintain.** Framework authors write one small adapter; agent-unit and Nitro
  handle hosts, storage and scheduling.

## Quick start

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

## Bring your framework

agent-unit recognises agents from these frameworks when your `package.json` depends on them:

| Framework | Export | What becomes durable | How it pauses |
| --- | --- | --- | --- |
| [AI SDK](https://ai-sdk.dev) | `new ToolLoopAgent(…)` or `streamText` settings | Every model call and tool call | `useRun().interrupt()` in a tool |
| [Mastra](https://mastra.ai) | `new Agent(…)` | Every model call and tool call (on a fork; your agent is untouched) | `useRun().interrupt()` in a tool |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) | `new Agent(…)` | Model responses and function tools, per turn; handoffs included | Tool approvals (`needsApproval: true`) |
| [LangGraph](https://langchain-ai.github.io/langgraphjs/) | `graph.compile()` | LangGraph checkpoints, stored in agent-unit storage | `interrupt()` in a node, resumed with `Command({ resume })` |
| Plain TypeScript | `defineAgent(…)` | `run.step(…)` | `run.interrupt()`, `run.sleep()` |

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

### Run primitives

Inside any run, `useRun()` (or the `run` argument of `defineAgent`) gives you:

| Primitive | |
| --- | --- |
| `run.step(name, fn)` | Run `fn` once; replays return the journaled result |
| `run.interrupt(name, payload)` | Park until `POST /runs/:id/resume` answers, then return the answer |
| `run.sleep("10m")` | Park until the time passes |
| `run.state.get/set/delete(key, { scope })` | State scoped to the `thread` (default), the `agent` or the `app` |
| `run.secrets.get(name)` | Read a secret from the host environment (Workers bindings included) |
| `run.emit(name, value)` | Emit a `CUSTOM` event |
| `run.signal` | Aborts when the run is cancelled or parked |

The one rule: between steps, code must make the same decisions given the same journaled results.
Put anything with side effects or randomness in a step. Model and tool calls already are.

A step is recorded when it finishes. If the process dies while a step is still running, that step
runs again when the run recovers, so give side effects that must never repeat an idempotency key,
such as `` `${run.id}:charge` ``.

## Deploy anywhere

```sh
npx agent-unit build --preset <preset>
```

| Host | Preset | Storage | Long runs | Sleep and recovery |
| --- | --- | --- | --- | --- |
| Node | `node-server` (default) | Filesystem by default | Unlimited | In-process timers + sweep every minute |
| Bun | `bun` | Filesystem by default | Unlimited | In-process timers + sweep |
| Deno | `deno-server` | Filesystem by default | Unlimited | In-process timers + sweep |
| Cloudflare Workers | `cloudflare-module` | Set `storage` (for example `cloudflare-kv-binding`) | Yields every 25s and continues | Cron Trigger runs the sweep |
| Vercel | `vercel` | Set `storage` (Redis, Upstash, Vercel KV, …) | Yields every 240s and continues | Vercel Cron runs the sweep |
| Netlify | `netlify` | Set `storage` (`netlify-blobs`, Redis, …) | Yields every 20s; finishes in the request | Generated scheduled function |
| AWS Lambda | `aws-lambda` | Set `storage` (Redis, Upstash, a database via db0, …) | Yields every 25s; finishes in the request | Point EventBridge at `POST /__agent-unit/sweep` |

Any other [Nitro preset](https://nitro.build/deploy) works too. Serverless hosts need shared
storage, because their filesystem does not survive between invocations; the build warns when one is
missing. Set `AGENT_UNIT_SECRET` in production: it protects the internal continue and sweep
endpoints, which serverless hosts use to continue long runs.

### Inside an existing app

Already on Nitro (or something built on it)? Mount your agents with the module:

```ts
// nitro.config.ts
import { defineConfig } from "nitro";
import { agentUnit } from "agent-unit/nitro";

export default defineConfig({
  modules: [agentUnit({ basePath: "/api/agents" })],
});
```

Anywhere else that speaks Fetch (Hono, Next.js route handlers, Bun.serve, Deno.serve, a Worker):

```ts
import { createAgentUnit } from "agent-unit/server";
import { createStorage } from "unstorage";
import redis from "unstorage/drivers/redis";
import support from "./agents/support";

const unit = createAgentUnit({
  agents: { support },
  storage: createStorage({ driver: redis({ url: process.env.REDIS_URL }) }),
  basePath: "/api/agents",
});

export const fetch = (request: Request, ctx?: { waitUntil(p: Promise<unknown>): void }) =>
  unit.handler(request, { waitUntil: ctx?.waitUntil.bind(ctx) });
```

Pass the host's `waitUntil` where it has one. Without it, start and resume requests finish the work
before they answer, which is the safe behaviour on hosts that freeze after a response.

## Configuration

`agent-unit.config.ts` is optional:

```ts
import { defineConfig } from "agent-unit";

export default defineConfig({
  name: "support",                                   // manifest, MCP and A2A name
  storage: { driver: "redis", url: process.env.REDIS_URL },  // any unstorage driver
  preset: "vercel",                                  // or --preset
  budget: "60s",                                     // yield and continue after this long
  sweep: "*/5 * * * *",                              // sweep schedule, or false
  basePath: "/api/agents",
  authorize: (request) => request.headers.get("authorization") === `Bearer ${process.env.API_TOKEN}`,
  // agents: { support },                            // instead of the agents/ directory
  // adapters: [myAdapter],                          // extra framework adapters
  // nitro: { … },                                   // passed through to Nitro
});
```

## Talk to your agents

### HTTP and events

The full contract is in [`spec/`](./spec). Events follow [AG-UI](https://docs.ag-ui.com) (`RUN_STARTED`,
`TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, …) plus `RUN_INTERRUPTED`, `RUN_SLEEPING` and
`RUN_CANCELLED`. Every event has a `seq`; it is the SSE event id, so `EventSource` reconnects with
`Last-Event-ID` and picks up exactly where it left off.

### Typed client

```ts
import { createAgentClient } from "agent-unit/client";

const agents = createAgentClient({ baseUrl: "https://agents.example.com" });

for await (const event of agents.run("refund", { orderId: "o_1" })) {
  if (event.type === "RUN_INTERRUPTED") console.log("needs approval:", event.interrupt.payload);
}
for await (const event of agents.resume(runId, { approved: true })) console.log(event.type);

await agents.list({ status: "interrupted" }); // an approvals inbox in one call
```

The client reconnects dropped streams from the last event it saw.

### MCP and A2A

`POST /mcp` speaks MCP over streamable HTTP: every agent is a tool, so Claude, Cursor or any MCP
client can call your agents. A run that pauses returns its run id and the pending interrupt.
`GET /.well-known/agent.json` is an A2A agent card with one skill per agent.

## Testing

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

## Write an adapter

An adapter teaches agent-unit one framework. Most are a few dozen lines:

```ts
import { defineAdapter } from "agent-unit/adapter";

export const myAdapter = defineAdapter<MyAgent>({
  name: "my-framework",
  match: (value): value is MyAgent => value instanceof MyAgent,
  describe: (agent) => ({ description: agent.description, tools: agent.tools.map(({ name }) => ({ name })) }),
  async run(agent, ctx) {
    const model = ctx.durable.model(agent.model); // journaled, streams text events
    const tools = ctx.durable.tools(agent.tools); // journaled, emits tool events
    return agent.run(ctx.input, { model, tools, signal: ctx.signal });
  },
});
```

See [spec/adapters.md](./spec/adapters.md) for native adapters that bring their own persistence.

## Limits

- Leases make one process execute a run at a time. On eventually consistent stores (Cloudflare KV)
  this is best effort; use Redis or Upstash where strict exclusivity matters.
- Mastra's own suspend and tool-approval flows need Mastra storage and are left to Mastra; pause
  Mastra agents with `useRun().interrupt()` in tools.
- OpenAI Agents handoffs declared with `handoff(agent, …)` keep their agent as is; plain agent
  handoffs are made durable.
- Cloudflare Durable Objects and Workflows are not used yet; Workers run with KV-style storage.

## License

MIT, Farming Labs.
