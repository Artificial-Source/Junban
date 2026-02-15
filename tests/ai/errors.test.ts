import { describe, it, expect } from "vitest";
import { AIError, classifyProviderError } from "../../src/ai/errors.js";

describe("classifyProviderError", () => {
  it("classifies 401 as auth error (not retryable)", () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    const result = classifyProviderError(err);
    expect(result).toBeInstanceOf(AIError);
    expect(result.category).toBe("auth");
    expect(result.retryable).toBe(false);
  });

  it("classifies 403 as auth error (not retryable)", () => {
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    const result = classifyProviderError(err);
    expect(result.category).toBe("auth");
    expect(result.retryable).toBe(false);
  });

  it("classifies 429 as rate_limit (retryable)", () => {
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    const result = classifyProviderError(err);
    expect(result.category).toBe("rate_limit");
    expect(result.retryable).toBe(true);
  });

  it("parses Retry-After header from 429", () => {
    const err = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      headers: { "retry-after": "30" },
    });
    const result = classifyProviderError(err);
    expect(result.category).toBe("rate_limit");
    expect(result.retryAfterMs).toBe(30000);
  });

  it("classifies 500 as server error (retryable)", () => {
    const err = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const result = classifyProviderError(err);
    expect(result.category).toBe("server");
    expect(result.retryable).toBe(true);
  });

  it("classifies 503 as server error", () => {
    const err = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const result = classifyProviderError(err);
    expect(result.category).toBe("server");
    expect(result.retryable).toBe(true);
  });

  it("classifies ECONNREFUSED as network error", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const result = classifyProviderError(err);
    expect(result.category).toBe("network");
    expect(result.retryable).toBe(true);
  });

  it("classifies ENOTFOUND as network error", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    const result = classifyProviderError(err);
    expect(result.category).toBe("network");
    expect(result.retryable).toBe(true);
  });

  it("classifies 'fetch failed' as network error", () => {
    const result = classifyProviderError(new Error("fetch failed"));
    expect(result.category).toBe("network");
    expect(result.retryable).toBe(true);
  });

  it("classifies 'Failed to fetch' as network error", () => {
    const result = classifyProviderError(new Error("Failed to fetch"));
    expect(result.category).toBe("network");
    expect(result.retryable).toBe(true);
  });

  it("classifies unknown errors as unknown (retryable)", () => {
    const result = classifyProviderError(new Error("Something unexpected"));
    expect(result.category).toBe("unknown");
    expect(result.retryable).toBe(true);
    expect(result.message).toBe("Something unexpected");
  });

  it("handles non-Error values", () => {
    const result = classifyProviderError("string error");
    expect(result).toBeInstanceOf(AIError);
    expect(result.category).toBe("unknown");
    expect(result.message).toBe("string error");
  });

  it("passes through existing AIError unchanged", () => {
    const original = new AIError("test", "timeout", true, 5000);
    const result = classifyProviderError(original);
    expect(result).toBe(original);
  });
});
