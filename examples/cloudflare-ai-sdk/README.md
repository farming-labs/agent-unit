# AI SDK agent on Cloudflare, with Durable Objects

A support agent written with the [AI SDK](https://ai-sdk.dev) (`ToolLoopAgent`, OpenAI or Claude),
deployed to Cloudflare Workers. Every run lives in its own Durable Object, so it can pause for a
human, sleep, or lose its isolate, and carry on where it stopped.

```
agents/openai.ts    supportAgent(openai("gpt-4.1-mini"))
agents/claude.ts    supportAgent(anthropic("claude-haiku-4-5"))
lib/support.ts      the ToolLoopAgent: lookup_order, and refund_order which waits for approval
agent-unit.config.ts  preset "cloudflare-module", runtime "durable-objects"
```

The only agent-unit code inside the agent is the approval:

```ts
refund_order: tool({
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  execute: async ({ orderId, amount }) => {
    const { approved } = await useRun().interrupt<{ approved: boolean }>("approve-refund", { orderId, amount });
    return approved ? { refunded: true } : { refunded: false };
  },
}),
```

## Deploy

```sh
npm install                                   # agent-unit, the AI SDK, wrangler
npx wrangler login
npx wrangler secret put OPENAI_API_KEY       # and/or ANTHROPIC_API_KEY
npm run deploy                                # agent-unit build && wrangler deploy
```

```sh
curl -N https://<worker>/agents/openai/runs \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"input":{"prompt":"Order o_1001 arrived broken. Can I get a refund?"}}'
# … TOOL_CALL lookup_order, TOOL_CALL refund_order, RUN_INTERRUPTED {"orderId":"o_1001","amount":249}

curl -N https://<worker>/runs/<run id>/resume \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"answer":{"approved":true}}'
# … TOOL_CALL_RESULT {"refunded":true,…}, TEXT_MESSAGE_CONTENT "Your refund…", RUN_FINISHED
```

## Verify locally against real models

`npm run verify` runs the same Cloudflare build in [workerd](https://github.com/cloudflare/workerd),
the open-source Workers runtime, with Durable Objects on disk. For each provider with a key it asks
for a refund, waits for the approval pause, kills the runtime, starts a new one, approves, and
checks the refund happened exactly once.

```sh
npm run build
OPENAI_API_KEY=… ANTHROPIC_API_KEY=… npm run verify
```

Keys are handed to the Worker as workerd environment bindings; they are not written to disk.
