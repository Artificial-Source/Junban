/**
 * Composable middleware pipeline for LLM execution.
 * Middleware wraps the provider's execute call, enabling
 * cross-cutting concerns like timeouts, logging, and capability guards.
 */

import type { LLMExecutionContext, PipelineResult } from "./context.js";

export type Middleware = (
  ctx: LLMExecutionContext,
  next: () => Promise<PipelineResult>,
) => Promise<PipelineResult>;

export class LLMPipeline {
  private middlewares: Middleware[] = [];

  /** Add a middleware to the end of the chain. */
  use(mw: Middleware): this {
    this.middlewares.push(mw);
    return this;
  }

  /** Execute the pipeline with the given handler as the innermost call. */
  async execute(
    ctx: LLMExecutionContext,
    handler: (ctx: LLMExecutionContext) => Promise<PipelineResult>,
  ): Promise<PipelineResult> {
    const chain = this.middlewares.reduceRight<
      (ctx: LLMExecutionContext) => Promise<PipelineResult>
    >((next, mw) => (c) => mw(c, () => next(c)), handler);
    return chain(ctx);
  }
}
