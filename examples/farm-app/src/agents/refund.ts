import { defineAgent } from "agent-unit";

// A refund that waits for a human. The two steps are journaled: approving the refund
// later (even after a restart or a redeploy) never loads the order or charges twice.
export default defineAgent({
  description: "Refunds an order after a human approves it.",
  async run(input, run) {
    const orderId = String(input.orderId ?? "o_1");
    const order = await run.step("load-order", () => ({ id: orderId, amount: 42, currency: "USD" }));
    const decision = await run.interrupt<{ approved: boolean }>("approve-refund", order);
    if (!decision.approved) return { status: "declined", order: order.id };
    const refund = await run.step("charge", () => ({ refundId: `re_${run.id.slice(4, 12)}`, amount: order.amount }));
    return { status: "refunded", order: order.id, ...refund };
  },
});
