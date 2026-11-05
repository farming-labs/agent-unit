# Approve agent runs in Farm.js Infra

One agent that pauses for a person. With `FARMJS_API_KEY` set, every pause shows up under
**Agents > Approvals** in [Farm.js Infra](https://app.farmjs.dev). Approve or reject it there and
the run continues with the answer. No other config: the key is the switch.

```sh
npm install
cp .env.example .env     # paste a key from Infra > API keys
npm run dev -- --port 3030
```

Start a run:

```sh
curl -X POST http://localhost:3030/agents/refund/runs \
  -H 'content-type: application/json' \
  -d '{"input":{"orderId":"ord_2291","amount":18400}}'
# {"id":"run_…","status":"running", …}

curl http://localhost:3030/runs/run_…
# {"status":"interrupted", …}   waiting on approve-refund
```

Open Agents in Infra, pick the request, add a note, and press Approve. The run resumes:

```sh
curl http://localhost:3030/runs/run_…
# {"status":"completed","output":{"status":"refunded","order":"ord_2291","by":"you@example.com","note":"…"}}
```

## How it works

| Step | What happens |
| --- | --- |
| `run.interrupt("approve-refund", order)` | The run parks, and agent-unit sends the pause to `POST {FARMJS_API_URL}/api/agents/approvals` |
| Approve or Reject in Infra | Infra signs `{ key, interrupt, answer }` with your key and calls `POST {AGENT_UNIT_URL}/__agent-unit/answer/<run>` |
| The answer route | Checks the signature, resumes the run with `{ approved, by, note? }`, and returns 200 |
| Answered some other way | Your own `POST /runs/:id/resume`, or a cancel, marks it closed in Infra |

Owners and admins of the project's organization can answer; other members see the list read-only.
Infra must reach `AGENT_UNIT_URL`, so a deployed app uses its public URL. Against a local Infra,
set `FARMJS_API_URL=http://localhost:3021` and start Infra with `FARMJS_DISCOVERY_ALLOW_LOOPBACK=1`.

This example installs agent-unit from the repository (`file:../..`); in your own app it is
`npm install agent-unit`.
