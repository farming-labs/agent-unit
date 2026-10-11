import { Hono } from "hono";
import { stream } from "hono/streaming";
import { env, waitUntil } from "agent-unit/env";

const app = new Hono();

app.get("/", (c) => c.text("hello from hono"));

app.post("/echo/:id", async (c) => c.json({ id: c.req.param("id"), body: await c.req.json(), query: c.req.query("q") ?? null }));

app.get("/env", (c) => c.json({ greeting: env.GREETING ?? null }));

app.get("/stream", (c) =>
  stream(c, async (out) => {
    for (const part of ["one ", "two ", "three"]) await out.write(part);
  }),
);

// Work after the response: through agent-unit's waitUntil, and through Hono's own executionCtx.
const finished: string[] = [];
const later = (name: string) => new Promise((resolve) => setTimeout(resolve, 50)).then(() => void finished.push(name));
app.post("/later", (c) => {
  waitUntil(later("waitUntil"));
  c.executionCtx.waitUntil(later("executionCtx"));
  return c.text("accepted");
});
app.get("/later", (c) => c.json({ finished: [...finished].sort() }));

export default app;
