# One agents folder, every host

The universal build: the same `agents/` folder built for seven hosts, then each build is run and
put through the same durable flow.

```sh
npm install
npm run build:all   # dist/node, dist/bun, dist/deno, dist/cloudflare, dist/vercel, dist/netlify, dist/lambda
npm run try         # build everything, then run every build
```

`npm run try` prints one line per host:

```
node-server         dist/node         ✓ hello universal · refund refunded · paused → killed → restarted → resumed (attempt 2) · 2 MCP tools
bun                 dist/bun          ✓ hello universal · refund refunded · paused → killed → restarted → resumed (attempt 2) · 2 MCP tools
deno-server         dist/deno         ✓ … (when Deno is installed)
cloudflare-module   dist/cloudflare   ✓ hello universal · refund refunded · paused → resumed across invocations · 2 MCP tools
vercel              dist/vercel       ✓ hello universal · refund refunded · paused → resumed across invocations · 2 MCP tools
netlify             dist/netlify      ✓ hello universal · refund refunded · paused → resumed across invocations · 2 MCP tools
aws-lambda          dist/lambda       ✓ hello universal · refund refunded · paused → resumed across invocations · 2 MCP tools
```

- **Servers** (Node, Bun, Deno) run as real processes. The script kills the server while the refund
  waits for approval, starts a new one, and resumes the refund there.
- **Workers** run in [workerd](https://github.com/cloudflare/workerd), the open-source Workers
  runtime, when it is installed.
- **Functions** (Vercel, Netlify, AWS Lambda) are called through the exact module each platform
  invokes, with its request shape, one invocation per request.

Each `dist/<host>` folder is what you deploy there. One build at a time is just
`npx agent-unit build --preset vercel`.

This example installs agent-unit from the repository (`file:../..`); in your own app it is
`npm install agent-unit`.
