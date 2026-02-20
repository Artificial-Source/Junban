import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../src/ai/provider.js";

describe("createDefaultRegistry", () => {
  it("registers all built-in providers", () => {
    const registry = createDefaultRegistry();
    const all = registry.getAll();
    const names = all.map((r) => r.plugin.name);
    expect(names).toContain("openai");
    expect(names).toContain("anthropic");
    expect(names).toContain("openrouter");
    expect(names).toContain("ollama");
    expect(names).toContain("lmstudio");
    expect(all).toHaveLength(5);
  });

  it("creates an executor for OpenAI with API key", () => {
    const registry = createDefaultRegistry();
    const executor = registry.createExecutor({ provider: "openai", apiKey: "sk-test" });
    expect(executor).toBeDefined();
    expect(executor.execute).toBeTypeOf("function");
    expect(executor.getCapabilities).toBeTypeOf("function");
  });

  it("creates an executor for Anthropic with API key", () => {
    const registry = createDefaultRegistry();
    const executor = registry.createExecutor({ provider: "anthropic", apiKey: "sk-ant-test" });
    expect(executor).toBeDefined();
    expect(executor.execute).toBeTypeOf("function");
  });

  it("creates an executor for OpenRouter with API key", () => {
    const registry = createDefaultRegistry();
    const executor = registry.createExecutor({ provider: "openrouter", apiKey: "sk-or-test" });
    expect(executor).toBeDefined();
    expect(executor.execute).toBeTypeOf("function");
  });

  it("creates an executor for Ollama without API key", () => {
    const registry = createDefaultRegistry();
    const executor = registry.createExecutor({ provider: "ollama" });
    expect(executor).toBeDefined();
    expect(executor.execute).toBeTypeOf("function");
  });

  it("creates an executor for LM Studio without API key", () => {
    const registry = createDefaultRegistry();
    const executor = registry.createExecutor({ provider: "lmstudio" });
    expect(executor).toBeDefined();
    expect(executor.execute).toBeTypeOf("function");
  });

  it("throws for missing API key on OpenAI", () => {
    const registry = createDefaultRegistry();
    expect(() => registry.createExecutor({ provider: "openai" })).toThrow("requires an API key");
  });

  it("throws for missing API key on Anthropic", () => {
    const registry = createDefaultRegistry();
    expect(() => registry.createExecutor({ provider: "anthropic" })).toThrow("requires an API key");
  });

  it("throws for missing API key on OpenRouter", () => {
    const registry = createDefaultRegistry();
    expect(() => registry.createExecutor({ provider: "openrouter" })).toThrow(
      "requires an API key",
    );
  });

  it("throws for unknown provider", () => {
    const registry = createDefaultRegistry();
    expect(() => registry.createExecutor({ provider: "unknown" as any })).toThrow(
      "Unknown AI provider",
    );
  });
});
