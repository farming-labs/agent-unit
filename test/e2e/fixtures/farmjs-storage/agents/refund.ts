import { defineAgent, useRun } from "agent-unit";

// Side effects are counted in app state so the tests can prove nothing ran twice across restarts.
async function countSideEffect(name: string) {
  const run = useRun();
  const count = ((await run.state.get<number>(name, { scope: "app" })) ?? 0) + 1;
  await run.state.set(name, count, { scope: "app" });
  return count;
}

export default defineAgent({
  description: "Refunds an order after a human approves it.",
  tools: [{ name: "charge", description: "Refunds the card." }],
  async run(input, run) {
    const order = await run.step("load-order", async () => {
      await countSideEffect(`loads:${input.orderId}`);
      return { id: String(input.orderId), amount: 42 };
    });
    const decision = await run.interrupt<{ approved: boolean }>("approve-refund", order);
    if (!decision.approved) return { status: "declined", order: order.id };
    await run.step("charge", () => countSideEffect(`charges:${input.orderId}`));
    return {
      status: "refunded",
      order: order.id,
      loads: await run.state.get(`loads:${input.orderId}`, { scope: "app" }),
      charges: await run.state.get(`charges:${input.orderId}`, { scope: "app" }),
    };
  },
});
