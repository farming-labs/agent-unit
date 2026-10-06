import type { Metadata } from "@farm.js/core";
import { AgentsConsole } from "../../components/agents-console";

export const metadata: Metadata = {
  title: "Agents | farm-app",
  description: "Durable agents mounted inside a Farm app with agent-unit.",
};

export default function AgentsPage() {
  return <AgentsConsole />;
}
