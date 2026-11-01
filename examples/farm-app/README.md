# agent-unit in a Farm app

A [Farm](https://farmjs.dev) app (from `@farm.js/create-app`, basic template) with durable agents
mounted at `/api/ai`, and a page at `/agents` that starts runs, approves them from an inbox and
streams their events live.

```sh
npm install
npm run dev        # open http://localhost:3000/agents
npm run smoke      # production build, then a kill-and-restart check on the real server
```

## How it is wired

| File | What it does |
| --- | --- |
| `farm.config.ts` | `integrations: { agent: agent({ name, basePath: "/api/ai", storage }) }` from `@farm.js/agent`. |
| `src/agents/refund.ts` | Loads an order, waits for approval with `run.interrupt`, then charges it. Both steps are journaled. |
| `src/agents/reminder.ts` | Sleeps with `run.sleep`, without holding a process, then finishes. |
| `src/components/agents-console.tsx` | The `/agents` page, a `"use client"` component using `agent-unit/client`. |

[`@farm.js/agent`](https://farmjs.dev/docs/integrations/agent) serves the agents in `src/agents`
under `/api/ai`: from source in `farm dev`, and built by agent-unit into the server for every
deploy target, with the sweep that wakes sleeping runs. Runs are stored in `.data/agent-unit` here.
On a serverless target (this app's `deploy.target` is `vercel`), set `storage` to a shared driver
such as Redis or Upstash, or per target with `presets`.

## Endpoints

```
POST /api/ai/agents/refund/runs      start a run (SSE with Accept: text/event-stream)
GET  /api/ai/runs?status=interrupted the approvals inbox
POST /api/ai/runs/:id/resume         answer a pause
GET  /api/ai/runs/:id/events         resumable event stream
POST /api/ai/mcp                     every agent as an MCP tool
GET  /api/ai/.well-known/agent.json  A2A agent card
```
