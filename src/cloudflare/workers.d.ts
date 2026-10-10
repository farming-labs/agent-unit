// Provided by the Workers runtime; agent-unit/cloudflare only runs there.
declare module "cloudflare:workers" {
  /** The Worker's bindings and variables, importable anywhere in a Worker. */
  export const env: Record<string, any>;
  export class DurableObject<Env = unknown> {
    constructor(ctx: import("./types").DurableObjectStateLike, env: Env);
    protected ctx: import("./types").DurableObjectStateLike;
    protected env: Env;
  }
}
