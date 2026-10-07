import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect } from "vitest";
import { netlify } from "./hosts";
import { serverlessSuite } from "./serverless";

describe("netlify function", () => {
  serverlessSuite({
    ...netlify,
    // The generated scheduled function calls the deployed site's sweep endpoint.
    async cron(_module, out, call) {
      const sweep = await import(pathToFileURL(join(out, "agent-unit-sweep/agent-unit-sweep.mjs")).href);
      expect(sweep.config).toEqual({ schedule: "* * * * *" });
      const realFetch = globalThis.fetch;
      process.env.URL = "https://agents.example.com";
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => call(new Request(input, init))) as typeof fetch;
      try {
        expect((await sweep.default()).status).toBe(204);
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  });
});
