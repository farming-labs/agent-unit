// A small agent framework agent-unit knows nothing about.
export class TinyAgent {
  constructor(steps) {
    this.steps = steps;
  }
  async run(input, step) {
    let value = String(input.prompt ?? "");
    for (const [name, fn] of Object.entries(this.steps)) value = await step(name, () => fn(value));
    return value;
  }
}
