import { AsyncLocalStorage } from "node:async_hooks";

// The request (or scheduled task) being handled, so code anywhere in the app can hand work to the
// host with `waitUntil`. One store per process, shared by every copy of this module.

interface Scope {
  waitUntil(promise: Promise<unknown>): void;
}

const KEY = Symbol.for("agent-unit.scope");
const scopes: AsyncLocalStorage<Scope> = ((globalThis as Record<symbol, unknown>)[KEY] ??= new AsyncLocalStorage<Scope>()) as AsyncLocalStorage<Scope>;

/**
 * Keeps `promise` running after the response is sent: an email, a webhook, a cache write. Where the
 * host keeps work alive after a response (Node, Bun, Deno, Workers, Vercel) it uses the host's own
 * `waitUntil`; where it may freeze (Netlify, AWS Lambda) the response waits for the work instead.
 * A rejection is logged, never thrown into the request.
 */
export function waitUntil(promise: PromiseLike<unknown>): void {
  const work = Promise.resolve(promise).catch((error: unknown) => console.error("agent-unit: work passed to waitUntil failed", error));
  // Outside a request or task (a script, a test) nothing ends the process early, so the work just runs.
  scopes.getStore()?.waitUntil(work);
}

/**
 * Runs `handle` as one request or task. With the host's `waitUntil`, work handed to `waitUntil` is
 * passed on; without one, it is awaited before the result is returned, and work handed over while a
 * streamed response is written is awaited before that body ends.
 * @internal Called by the server and task entries agent-unit generates.
 */
export async function runInScope<T>(hostWaitUntil: ((promise: Promise<unknown>) => void) | undefined, handle: () => T | Promise<T>): Promise<T> {
  if (hostWaitUntil) return scopes.run({ waitUntil: hostWaitUntil }, handle);
  const pending: Promise<unknown>[] = [];
  const drain = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  const result = await scopes.run({ waitUntil: (work) => void pending.push(work) }, handle);
  await drain();
  // A streamed body can hand over work as it ends (an AI SDK onFinish that saves the chat), after
  // `handle` returned. These hosts keep the function alive while the body streams, so it ends last.
  if (result instanceof Response && result.body) return new Response(result.body.pipeThrough(new TransformStream({ flush: drain })), result) as T;
  return result;
}
