import { waitUntil } from "agent-unit/env";

// A Worker's own handlers for its other events, beside fetch. The server reports what reached them.
const seen: string[] = [];

interface Message {
  body: unknown;
  ack(): void;
}

export default {
  fetch: () => Response.json(seen),
  scheduled(controller: { cron: string }) {
    seen.push(`scheduled ${controller.cron}`);
    // agent-unit's waitUntil works in these handlers too, kept alive by the Worker's own.
    waitUntil(Promise.resolve().then(() => void seen.push("follow-up")));
  },
  queue(batch: { queue: string; messages: Message[] }) {
    for (const message of batch.messages) {
      seen.push(`queue ${batch.queue} ${JSON.stringify(message.body)}`);
      message.ack();
    }
  },
};
