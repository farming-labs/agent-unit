import { useRun } from "agent-unit";
import { stepCountIs, tool, ToolLoopAgent, type LanguageModel } from "ai";
import { z } from "zod";

// A tiny order "database". In a real app these would be calls to your systems.
const ORDERS: Record<string, { item: string; amount: number; status: string }> = {
  o_1001: { item: "Noise-cancelling headphones", amount: 249, status: "delivered" },
  o_1002: { item: "Mechanical keyboard", amount: 129, status: "shipped" },
};

/** Counts a side effect in app state, so you can see that a resumed run never repeats one. */
async function count(name: string) {
  const run = useRun();
  const value = ((await run.state.get<number>(name, { scope: "app" })) ?? 0) + 1;
  await run.state.set(name, value, { scope: "app" });
  return value;
}

/** The same support agent on any model: it looks orders up and asks a human before refunding. */
export function supportAgent(model: LanguageModel) {
  return new ToolLoopAgent({
    model,
    instructions:
      "You are a support agent for an online shop. Always look an order up before acting on it. " +
      "Use refund_order to refund; a human approves every refund. Answer in one or two short sentences.",
    tools: {
      lookup_order: tool({
        description: "Look up an order by id.",
        inputSchema: z.object({ orderId: z.string() }),
        execute: async ({ orderId }) => {
          await count("lookups");
          return ORDERS[orderId] ?? { error: `No order ${orderId}` };
        },
      }),
      refund_order: tool({
        description: "Refund an order. Pauses until a human approves or declines.",
        inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
        execute: async ({ orderId, amount }) => {
          // The run parks here, with no compute, until POST /runs/:id/resume answers.
          const decision = await useRun().interrupt<{ approved: boolean }>("approve-refund", { orderId, amount });
          if (!decision.approved) return { refunded: false, reason: "declined by a human" };
          return { refunded: true, refundId: `re_${orderId}_${await count("refunds")}` };
        },
      }),
    },
    stopWhen: stepCountIs(8),
  });
}
