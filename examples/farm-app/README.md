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
| `src/agents/refund.ts` | Loads an order, waits for approval with `run.interrupt`, then charges it. Both steps are journaled. |
| `src/agents/reminder.ts` | Sleeps with `run.sleep`, without holding a process, then finishes. |
| `src/agents/server.ts` | One `createAgentUnit({ agents, storage, basePath: "/api/ai" })` for the app. |
| `src/app/api/ai/[...path]/route.ts` | A Farm catch-all API route that hands every request under `/api/ai` to agent-unit, with Farm's `after()` as `waitUntil`. |
| `src/components/agents-console.tsx` | The `/agents` page, a `"use client"` component using `agent-unit/client`. |

A plain Farm API route works in `farm dev` and in every production target, so there is no
build plugin to configure. Runs are stored in `.data/agent-unit` here. On a serverless target
(this app's `deploy.target` is `vercel`), switch the storage driver in `src/agents/server.ts` to a
shared one such as Redis or Upstash.

## Endpoints

```
POST /api/ai/agents/refund/runs      start a run (SSE with Accept: text/event-stream)
GET  /api/ai/runs?status=interrupted the approvals inbox
POST /api/ai/runs/:id/resume         answer a pause
GET  /api/ai/runs/:id/events         resumable event stream
POST /api/ai/mcp                     every agent as an MCP tool
GET  /api/ai/.well-known/agent.json  A2A agent card
```
