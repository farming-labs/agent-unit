import { defineAgent } from "agent-unit";

// Returns what the scheduled task gave it, so the test can see the input the server read.
export default defineAgent(async (input) => ({ team: input.team }));
