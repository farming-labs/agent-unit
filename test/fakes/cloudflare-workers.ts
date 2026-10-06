// Stand-in for the Workers runtime's `cloudflare:workers` module in Node tests.
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}
