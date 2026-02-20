import { describe, it, expect } from "vitest";
import { LLMPipeline } from "../../src/ai/core/pipeline.js";
import { capabilityGuard, createTimeout, logging } from "../../src/ai/core/middleware.js";
import type { LLMExecutionContext, PipelineResult } from "../../src/ai/core/context.js";
import type { StreamEvent } from "../../src/ai/types.js";
import { DEFAULT_CAPABILITIES } from "../../src/ai/core/capabilities.js";

function createTestCtx(overrides?: Partial<LLMExecutionContext>): LLMExecutionContext {
  return {
    request: { messages: [], model: "test-model" },
    providerName: "test",
    capabilities: { ...DEFAULT_CAPABILITIES },
    metadata: new Map(),
    ...overrides,
  };
}

function createStreamResult(events: StreamEvent[]): PipelineResult {
  return {
    mode: "stream",
    events: (async function* () {
      for (const e of events) yield e;
    })(),
  };
}

describe("LLMPipeline", () => {
  it("executes handler directly with no middleware", async () => {
    const pipeline = new LLMPipeline();
    const ctx = createTestCtx();
    const result = await pipeline.execute(ctx, async () =>
      createStreamResult([{ type: "done", data: "" }]),
    );
    expect(result.mode).toBe("stream");
  });

  it("middleware can modify context before handler", async () => {
    const pipeline = new LLMPipeline();
    pipeline.use(async (ctx, next) => {
      ctx.metadata.set("modified", true);
      return next();
    });

    const ctx = createTestCtx();
    await pipeline.execute(ctx, async () => createStreamResult([{ type: "done", data: "" }]));
    expect(ctx.metadata.get("modified")).toBe(true);
  });

  it("middleware can modify result after handler", async () => {
    const pipeline = new LLMPipeline();
    pipeline.use(async (_ctx, next) => {
      const result = await next();
      // Wrap stream with extra event
      if (result.mode === "stream") {
        const original = result.events;
        return {
          mode: "stream" as const,
          events: (async function* () {
            yield* original;
            yield { type: "token" as const, data: "[injected]" };
          })(),
        };
      }
      return result;
    });

    const ctx = createTestCtx();
    const result = await pipeline.execute(ctx, async () =>
      createStreamResult([{ type: "token", data: "hello" }]),
    );

    const events: StreamEvent[] = [];
    if (result.mode === "stream") {
      for await (const e of result.events) events.push(e);
    }
    expect(events).toHaveLength(2);
    expect(events[1].data).toBe("[injected]");
  });

  it("chains multiple middleware in order", async () => {
    const pipeline = new LLMPipeline();
    const order: string[] = [];

    pipeline.use(async (_ctx, next) => {
      order.push("mw1-before");
      const result = await next();
      order.push("mw1-after");
      return result;
    });

    pipeline.use(async (_ctx, next) => {
      order.push("mw2-before");
      const result = await next();
      order.push("mw2-after");
      return result;
    });

    const ctx = createTestCtx();
    await pipeline.execute(ctx, async () => {
      order.push("handler");
      return createStreamResult([{ type: "done", data: "" }]);
    });

    expect(order).toEqual(["mw1-before", "mw2-before", "handler", "mw2-after", "mw1-after"]);
  });

  it("use() is chainable", () => {
    const pipeline = new LLMPipeline();
    const result = pipeline.use(async (_ctx, next) => next()).use(async (_ctx, next) => next());
    expect(result).toBe(pipeline);
  });
});

describe("capabilityGuard middleware", () => {
  it("strips tools when toolCalling is false", async () => {
    const ctx = createTestCtx({
      request: {
        messages: [],
        model: "test",
        tools: [{ name: "test", description: "Test", parameters: { type: "object" } }],
      },
      capabilities: { ...DEFAULT_CAPABILITIES, toolCalling: false },
    });

    let capturedTools: unknown;
    await capabilityGuard(ctx, async () => {
      capturedTools = ctx.request.tools;
      return createStreamResult([{ type: "done", data: "" }]);
    });

    expect(capturedTools).toBeUndefined();
  });

  it("preserves tools when toolCalling is true", async () => {
    const tools = [{ name: "test", description: "Test", parameters: { type: "object" } }];
    const ctx = createTestCtx({
      request: { messages: [], model: "test", tools },
      capabilities: { ...DEFAULT_CAPABILITIES, toolCalling: true },
    });

    let capturedTools: unknown;
    await capabilityGuard(ctx, async () => {
      capturedTools = ctx.request.tools;
      return createStreamResult([{ type: "done", data: "" }]);
    });

    expect(capturedTools).toEqual(tools);
  });
});

describe("logging middleware", () => {
  it("records startTime and durationMs in metadata", async () => {
    const ctx = createTestCtx();
    await logging(ctx, async () => createStreamResult([{ type: "done", data: "" }]));

    expect(ctx.metadata.has("startTime")).toBe(true);
    expect(ctx.metadata.has("durationMs")).toBe(true);
    expect(typeof ctx.metadata.get("durationMs")).toBe("number");
  });
});

describe("createTimeout middleware", () => {
  it("passes through events within timeout", async () => {
    const timeout = createTimeout(5000);
    const ctx = createTestCtx();
    const result = await timeout(ctx, async () =>
      createStreamResult([
        { type: "token", data: "hello" },
        { type: "done", data: "" },
      ]),
    );

    const events: StreamEvent[] = [];
    if (result.mode === "stream") {
      for await (const e of result.events) events.push(e);
    }
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("hello");
  });
});
