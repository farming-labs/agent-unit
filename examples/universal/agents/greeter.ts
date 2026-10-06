import { defineAgent } from "agent-unit";

export default defineAgent(async (input) => `hello ${String(input.name ?? "world")}`);
