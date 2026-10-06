import { defineAgent } from "agent-unit";
import { readEffect } from "../lib/effects";

/** Reports side-effect counters, so the e2e suite can check what ran and how often. */
export default defineAgent(async (input) => {
  const names = (input.names ?? []) as string[];
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readEffect(name)])));
});
