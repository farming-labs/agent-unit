import { defineAgent } from "agent-unit";

export default defineAgent({
  description: "Refunds an order after a human approves it.",
  async run(input, run) {
    const order = await run.step("load-order", () => ({ id: String(input.orderId ?? "o_1"), amount: 42 }));
    const decision = await run.interrupt<{ approved: boolean }>("approve-refund", order);
    if (!decision.approved) return { status: "declined", order: order.id };
    await run.step("charge", () => ({ charged: order.amount }));
    return { status: "refunded", order: order.id };
  },
});
