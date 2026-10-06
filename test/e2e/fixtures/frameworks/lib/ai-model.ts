import { MockLanguageModelV4 } from "ai/test";
import { countEffect } from "./effects";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const streamOf = (parts: unknown[]) => ({
  stream: new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  }),
});

/**
 * A stateless scripted model: it asks for the refund tool until the conversation holds a tool
 * result, then answers. Every call it makes counts as a side effect named `model:<label>`.
 */
export function scriptedModel(label: string) {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      await countEffect(`model:${label}`);
      const answered = prompt.some((message) => message.role === "tool");
      if (!answered) {
        return streamOf([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: `call_${label}`, toolName: "refund", input: JSON.stringify({ orderId: "o_42" }) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
        ]);
      }
      return streamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Refunded " },
        { type: "text-delta", id: "t1", delta: "o_42." },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ]);
    },
  }) as never;
}
