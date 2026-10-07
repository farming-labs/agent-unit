import { describe, expect } from "vitest";
import { vercel } from "./hosts";
import { serverlessSuite } from "./serverless";

describe("vercel function", () => {
  serverlessSuite({
    ...vercel,
    // Vercel Cron calls this route with the schedule and CRON_SECRET; Nitro runs the sweep task.
    async cron(_module, _out, call) {
      const response = await call(
        new Request("https://agents.example.com/_vercel/cron", {
          headers: { "x-vercel-cron-schedule": "* * * * *", authorization: `Bearer ${process.env.CRON_SECRET}` },
        }),
      );
      expect(response.status).toBe(200);
    },
  });
});
