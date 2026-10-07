import { Agent, tool, Usage, type Model, type ModelRequest } from "@openai/agents";
import { z } from "zod";
import { countEffect, recordKey } from "../lib/effects";

const usage = { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/** Asks for the refund tool until the input holds its result, then answers. */
function outputFor(request: ModelRequest) {
  const items = Array.isArray(request.input) ? request.input : [];
  const answered = items.some((item) => (item as { type?: string }).type === "function_call_result");
  return answered
    ? [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Refunded o_42." }] }]
    : [{ type: "function_call", callId: "call_openai", name: "refund", arguments: JSON.stringify({ orderId: "o_42" }), status: "completed" }];
}

const model = {
  async getResponse(request: ModelRequest) {
    await countEffect("model:openai-agents");
    return { usage: new Usage(usage), output: outputFor(request) as never, responseId: "resp" };
  },
  async *getStreamedResponse(request: ModelRequest) {
    await countEffect("model:openai-agents");
    const output = outputFor(request);
    yield { type: "response_started" };
    for (const item of output) {
      if (item.type === "message") yield { type: "output_text_delta", delta: "Refunded o_42.", itemId: "msg_1" };
    }
    yield { type: "response_done", response: { id: "resp", usage, output } };
  },
} as unknown as Model;

export default new Agent({
  name: "Support",
  instructions: "You refund orders.",
  model,
  tools: [
    tool({
      name: "refund",
      description: "Refunds an order.",
      parameters: z.object({ orderId: z.string() }),
      needsApproval: true,
      execute: async ({ orderId }) => {
        await countEffect("refund:openai-agents");
        await recordKey("key:openai-agents");
        return `refunded ${orderId}`;
      },
    }),
  ],
});
