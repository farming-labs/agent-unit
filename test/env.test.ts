import { describe, expect, it } from "vitest";
import { env } from "../src/env";

describe("agent-unit/env", () => {
  it("is the process environment off Cloudflare, read live", () => {
    process.env.AGENT_UNIT_ENV_TEST = "first";
    expect(env.AGENT_UNIT_ENV_TEST).toBe("first");
    process.env.AGENT_UNIT_ENV_TEST = "second";
    expect(env.AGENT_UNIT_ENV_TEST).toBe("second");
    delete process.env.AGENT_UNIT_ENV_TEST;
  });
});
