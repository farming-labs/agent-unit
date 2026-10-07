// Its adapter, as the framework's own authors would publish it.
import { defineAdapter } from "agent-unit/adapter";
import { TinyAgent } from "tiny-agents";

export default function tinyAdapter() {
  return defineAdapter({
    name: "tiny-agents",
    apiVersion: 1,
    match: (value) => value instanceof TinyAgent,
    describe: () => ({ description: "A tiny agent" }),
    run: (agent, ctx) => agent.run(ctx.input, (name, fn) => ctx.durable.step(name, fn)),
  });
}
