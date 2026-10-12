// Not installed on purpose: the Mastra preset replaces Mastra's deployers in agent-unit builds.
declare module "@mastra/deployer-vercel" {
  import type { MastraDeployer } from "@mastra/core/deployer";
  export class VercelDeployer extends MastraDeployer {
    constructor(options?: Record<string, unknown>);
  }
}
