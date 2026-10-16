import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, cleanup, prepareFixture, tempDir } from "./helpers";
import { startMiniflare } from "./hosts";

// A server's own `scheduled` and `queue` handlers on Workers. Nitro's Worker passes these events to
// its hooks only, so agent-unit hands them on; before, queue batches were acknowledged unread.

describe("a Worker's own scheduled and queue handlers", () => {
  let out: string;
  let data: string;
  let worker: Awaited<ReturnType<typeof startMiniflare>>;

  beforeAll(async () => {
    out = tempDir("events-cf-out");
    data = tempDir("events-cf-data");
    await buildFixture(prepareFixture("server-events"), "cloudflare-module", out);
    worker = await startMiniflare(out, data);
  });

  afterAll(async () => {
    await worker?.stop();
    cleanup(out, data);
  });

  const seen = async () => (await (await worker.fetch("/")).json()) as string[];

  it("runs scheduled with the cron, and agent-unit's waitUntil inside it", async () => {
    expect((await worker.scheduled("*/5 * * * *")).status).toBe(200);
    expect(await seen()).toEqual(["scheduled */5 * * * *", "follow-up"]);
  });

  it("runs queue with the batch, whose messages it acknowledges", async () => {
    const result = await worker.queue("jobs", [{ id: 1 }, { id: 2 }]);
    expect(result.outcome).toBe("ok");
    expect(result.explicitAcks).toEqual(["m0", "m1"]);
    expect((await seen()).slice(-2)).toEqual(['queue jobs {"id":1}', 'queue jobs {"id":2}']);
  });
});
