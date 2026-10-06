// Provided by the Workers runtime; agent-unit/cloudflare only runs there.
declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    constructor(ctx: import("./types").DurableObjectStateLike, env: Env);
    protected ctx: import("./types").DurableObjectStateLike;
    protected env: Env;
  }
}
