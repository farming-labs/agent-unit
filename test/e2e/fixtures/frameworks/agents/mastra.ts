import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { useRun } from "agent-unit";
import { z } from "zod";
import { scriptedModel } from "../lib/ai-model";
import { countEffect, recordKey } from "../lib/effects";

export default new Agent({
  id: "mastra-support",
  name: "Mastra support",
  description: "Refunds orders with Mastra.",
  instructions: "You refund orders.",
  model: scriptedModel("mastra"),
  tools: {
    refund: createTool({
      id: "refund",
      description: "Refunds an order after approval.",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => {
        const decision = await useRun().interrupt<{ approved: boolean }>("approve-refund", { orderId });
        if (!decision.approved) return { status: "declined" };
        await countEffect("refund:mastra");
        await recordKey("key:mastra");
        return { status: "refunded", orderId };
      },
    }),
  },
});
