import { defineAgent } from "agent-unit";

type Decision = { approved: boolean; by: string; note?: string };

export default defineAgent({
  description: "Refunds an order once a person approves it in Farm.js Infra.",
  async run(input, run) {
    const order = await run.step("load-order", () => ({
      order: String(input.orderId ?? "ord_2291"),
      amount: Number(input.amount ?? 18400),
      currency: "usd",
      reason: String(input.reason ?? "Damaged on arrival"),
    }));
    // The run parks here. With FARMJS_API_KEY set, the pause shows up under Agents > Approvals.
    const decision = await run.interrupt<Decision>("approve-refund", order);
    if (!decision.approved) return { status: "declined", order: order.order, by: decision.by };
    await run.step("charge", () => ({ refunded: order.amount }));
    return { status: "refunded", order: order.order, by: decision.by, note: decision.note };
  },
});
