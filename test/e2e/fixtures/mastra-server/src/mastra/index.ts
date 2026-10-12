import { Mastra } from "@mastra/core";
import { registerApiRoute } from "@mastra/core/server";
import { VercelDeployer } from "@mastra/deployer-vercel";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { storage } from "#storage";
import { z } from "zod";

// Mastra's own app: a workflow that pauses for approval, kept in Mastra's own store.

const order = z.object({ orderId: z.string(), token: z.string() });

const lookup = createStep({
  id: "lookup",
  inputSchema: z.object({ orderId: z.string() }),
  outputSchema: order,
  // A fresh value each time the step runs: if resuming ever ran it again, the token would change.
  execute: async ({ inputData }) => ({ orderId: inputData.orderId, token: crypto.randomUUID() }),
});

const approve = createStep({
  id: "approve",
  inputSchema: order,
  outputSchema: order.extend({ approved: z.boolean() }),
  suspendSchema: z.object({ orderId: z.string() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) return suspend({ orderId: inputData.orderId });
    return { ...inputData, approved: resumeData.approved };
  },
});

const refund = createWorkflow({ id: "refund", inputSchema: z.object({ orderId: z.string() }), outputSchema: approve.outputSchema })
  .then(lookup)
  .then(approve)
  .commit();

export const mastra = new Mastra({
  workflows: { refund },
  storage,
  // Left over from `mastra build`, as in an app moving to agent-unit; agent-unit builds never load it.
  deployer: new VercelDeployer(),
  // Mastra's own server settings, which agent-unit's build follows as `mastra build` does.
  server: {
    apiPrefix: "/mastra",
    cors: { origin: "https://app.example.com" },
    apiRoutes: [registerApiRoute("/hello", { method: "GET", handler: async (c) => c.json({ hello: "custom route" }) })],
  },
});
