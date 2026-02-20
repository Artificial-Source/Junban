/**
 * Built-in middleware for the LLM pipeline.
 */

import type { Middleware } from "./pipeline.js";
import { AIError } from "../errors.js";

/**
 * Guards against using tools when the model doesn't support them.
 * Strips tool definitions from the request if toolCalling is false.
 */
export const capabilityGuard: Middleware = async (ctx, next) => {
  if (!ctx.capabilities.toolCalling && ctx.request.tools?.length) {
    ctx.request = { ...ctx.request, tools: undefined };
  }
  return next();
};

/**
 * Wraps execution with a timeout.
 * For streaming responses, wraps the async iterable with per-chunk timeouts.
 */
export function createTimeout(timeoutMs: number): Middleware {
  return async (_ctx, next) => {
    const result = await next();

    if (result.mode === "stream") {
      return {
        mode: "stream",
        events: withStreamTimeout(result.events, timeoutMs),
      };
    }

    return result;
  };
}

async function* withStreamTimeout(
  source: AsyncIterable<import("../types.js").StreamEvent>,
  timeoutMs: number,
): AsyncGenerator<import("../types.js").StreamEvent> {
  const iterator = source[Symbol.asyncIterator]();
  while (true) {
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new AIError("Response timed out.", "timeout", true)), timeoutMs),
      ),
    ]);
    if (result.done) return;
    yield result.value;
  }
}

/**
 * Logs request/response metadata for debugging.
 * Records timing and model info in ctx.metadata.
 */
export const logging: Middleware = async (ctx, next) => {
  const start = Date.now();
  ctx.metadata.set("startTime", start);
  const result = await next();
  ctx.metadata.set("durationMs", Date.now() - start);
  return result;
};
