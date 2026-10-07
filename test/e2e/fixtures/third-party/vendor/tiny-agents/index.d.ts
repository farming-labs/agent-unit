export declare class TinyAgent {
  constructor(steps: Record<string, (value: string) => string | Promise<string>>);
  run(input: Record<string, unknown>, step: (name: string, fn: () => unknown) => Promise<unknown>): Promise<string>;
}
