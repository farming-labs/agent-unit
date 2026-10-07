import { useRun } from "agent-unit";
import { jsonSchema, tool, ToolLoopAgent } from "ai";
import { scriptedModel } from "../lib/ai-model";
import { countEffect, recordKey } from "../lib/effects";

export default new ToolLoopAgent({
  model: scriptedModel("ai-sdk"),
  tools: {
    refund: tool({
      description: "Refunds an order after approval.",
      inputSchema: jsonSchema<{ orderId: string }>({ type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] }),
      execute: async ({ orderId }) => {
        const decision = await useRun().interrupt<{ approved: boolean }>("approve-refund", { orderId });
        if (!decision.approved) return { status: "declined" };
        await countEffect("refund:ai-sdk");
        await recordKey("key:ai-sdk");
        return { status: "refunded", orderId };
      },
    }),
  },
});
