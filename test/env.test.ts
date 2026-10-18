import { describe, expect, it, vi } from "vitest";
import { env, runInScope, waitUntil } from "../src/env";

describe("agent-unit/env", () => {
  it("is the process environment off Cloudflare, read live", () => {
    process.env.AGENT_UNIT_ENV_TEST = "first";
    expect(env.AGENT_UNIT_ENV_TEST).toBe("first");
    process.env.AGENT_UNIT_ENV_TEST = "second";
    expect(env.AGENT_UNIT_ENV_TEST).toBe("second");
    delete process.env.AGENT_UNIT_ENV_TEST;
  });
});

describe("waitUntil", () => {
  const later = (log: string[], name: string) => new Promise((resolve) => setTimeout(resolve, 10)).then(() => void log.push(name));

  it("hands work to the host's waitUntil inside a request", async () => {
    const handed: Promise<unknown>[] = [];
    const log: string[] = [];
    const result = await runInScope((work) => void handed.push(work), () => {
      waitUntil(later(log, "email"));
      return "response";
    });
    expect(result).toBe("response");
    expect(log).toEqual([]);
    expect(handed).toHaveLength(1);
    await Promise.all(handed);
    expect(log).toEqual(["email"]);
  });

  it("finishes the work before returning where the host has no waitUntil", async () => {
    const log: string[] = [];
    // Work started by other work is waited for too.
    await runInScope(undefined, () => waitUntil(later(log, "first").then(() => waitUntil(later(log, "second")))));
    expect(log).toEqual(["first", "second"]);
  });

  it("finishes work queued while a streamed response is written before its body ends", async () => {
    const log: string[] = [];
    const encoder = new TextEncoder();
    const response = await runInScope(undefined, () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("a"));
          // Like an AI SDK onFinish: the work starts once the last of the body is written.
          setTimeout(() => {
            controller.enqueue(encoder.encode("b"));
            waitUntil(later(log, "save"));
            controller.close();
          }, 5);
        },
      });
      return new Response(body, { status: 201, headers: { "x-run": "1" } });
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-run")).toBe("1");
    expect(await response.text()).toBe("ab");
    expect(log).toEqual(["save"]);
  });

  it("logs a failure instead of failing the request, and runs outside any request", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await runInScope(undefined, () => waitUntil(Promise.reject(new Error("smtp down"))));
    expect(errors).toHaveBeenCalledWith("agent-unit: work passed to waitUntil failed", expect.objectContaining({ message: "smtp down" }));
    errors.mockRestore();
    const log: string[] = [];
    waitUntil(later(log, "script"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(log).toEqual(["script"]);
  });
});
