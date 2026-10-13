import { ToolLoopAgent } from "ai";
import { MockLanguageModelV4 } from "ai/test";

// An AI SDK agent exported as the default, as agent-unit init writes one, on a model that answers once.
export default new ToolLoopAgent({
  model: new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "hello from dev" },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
            },
          ])
            controller.enqueue(part as never);
          controller.close();
        },
      }),
    }),
  }) as never,
  instructions: "Say hello.",
});
