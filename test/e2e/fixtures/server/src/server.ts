import { Hono } from "hono";
import { stream } from "hono/streaming";
import { env } from "agent-unit/env";

const app = new Hono();

app.get("/", (c) => c.text("hello from hono"));

app.post("/echo/:id", async (c) => c.json({ id: c.req.param("id"), body: await c.req.json(), query: c.req.query("q") ?? null }));

app.get("/env", (c) => c.json({ greeting: env.GREETING ?? null }));

app.get("/stream", (c) =>
  stream(c, async (out) => {
    for (const part of ["one ", "two ", "three"]) await out.write(part);
  }),
);

export default app;
