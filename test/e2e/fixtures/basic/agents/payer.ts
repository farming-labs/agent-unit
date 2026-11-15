import { defineAgent } from "agent-unit";

// Waits for the payment of its order, sent to the server with POST /events.
export default defineAgent({
  description: "Waits for an order's payment.",
  async run(input, run) {
    const order = await run.step("create-checkout", () => ({ id: String(input.orderId) }));
    const paid = await run.waitFor<{ amount: number }>("payment.succeeded", { match: { orderId: order.id } });
    return { status: "paid", order: order.id, amount: paid.amount };
  },
});
