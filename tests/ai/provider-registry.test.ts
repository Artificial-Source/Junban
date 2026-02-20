import { describe, it, expect } from "vitest";
import { LLMProviderRegistry } from "../../src/ai/provider/registry.js";
import type { LLMProviderPlugin, LLMExecutor } from "../../src/ai/provider/interface.js";
import type { LLMExecutionContext, PipelineResult } from "../../src/ai/core/context.js";
import { DEFAULT_CAPABILITIES } from "../../src/ai/core/capabilities.js";

function createTestPlugin(name: string, opts?: Partial<LLMProviderPlugin>): LLMProviderPlugin {
  return {
    name,
    displayName: opts?.displayName ?? name,
    needsApiKey: opts?.needsApiKey ?? false,
    defaultModel: opts?.defaultModel ?? "test-model",
    createExecutor: (): LLMExecutor => ({
      execute: async (_ctx: LLMExecutionContext): Promise<PipelineResult> => ({
        mode: "stream",
        events: (async function* () {
          yield { type: "done" as const, data: "" };
        })(),
      }),
      getCapabilities: () => ({ ...DEFAULT_CAPABILITIES }),
    }),
    discoverModels: async () => [],
    ...opts,
  };
}

describe("LLMProviderRegistry", () => {
  it("registers and retrieves a provider", () => {
    const registry = new LLMProviderRegistry();
    registry.register(createTestPlugin("test", { displayName: "Test Provider" }));

    const reg = registry.get("test");
    expect(reg).toBeDefined();
    expect(reg!.plugin.displayName).toBe("Test Provider");
  });

  it("returns all registered providers", () => {
    const registry = new LLMProviderRegistry();
    registry.register(createTestPlugin("a", { displayName: "A" }));
    registry.register(createTestPlugin("b", { displayName: "B" }));

    expect(registry.getAll()).toHaveLength(2);
  });

  it("throws on duplicate registration", () => {
    const registry = new LLMProviderRegistry();
    const plugin = createTestPlugin("dup");
    registry.register(plugin);
    expect(() => registry.register(plugin)).toThrow("already registered");
  });

  it("unregisters a provider by name", () => {
    const registry = new LLMProviderRegistry();
    registry.register(createTestPlugin("remove-me"));
    expect(registry.get("remove-me")).toBeDefined();

    registry.unregister("remove-me");
    expect(registry.get("remove-me")).toBeUndefined();
  });

  it("unregisters all providers by plugin ID", () => {
    const registry = new LLMProviderRegistry();
    registry.register(createTestPlugin("plugin-a:prov1"), "plugin-a");
    registry.register(createTestPlugin("plugin-a:prov2"), "plugin-a");
    registry.register(createTestPlugin("built-in"));

    registry.unregisterByPlugin("plugin-a");

    expect(registry.getAll()).toHaveLength(1);
    expect(registry.get("built-in")).toBeDefined();
  });

  it("creates an executor via createExecutor", () => {
    const registry = new LLMProviderRegistry();
    registry.register(createTestPlugin("test"));

    const executor = registry.createExecutor({ provider: "test" });
    expect(executor).toBeDefined();
    expect(executor.execute).toBeTypeOf("function");
  });

  it("throws when creating with unknown provider", () => {
    const registry = new LLMProviderRegistry();
    expect(() => registry.createExecutor({ provider: "nope" })).toThrow("Unknown AI provider");
  });

  it("throws when API key is needed but missing", () => {
    const registry = new LLMProviderRegistry();
    registry.register(createTestPlugin("paid", { needsApiKey: true, displayName: "Paid" }));

    expect(() => registry.createExecutor({ provider: "paid" })).toThrow("requires an API key");
    expect(() => registry.createExecutor({ provider: "paid", apiKey: "sk-test" })).not.toThrow();
  });

  it("getPlugin returns just the plugin", () => {
    const registry = new LLMProviderRegistry();
    registry.register(createTestPlugin("test", { displayName: "Test" }));

    const plugin = registry.getPlugin("test");
    expect(plugin).toBeDefined();
    expect(plugin!.displayName).toBe("Test");
  });

  it("getPlugin returns undefined for missing provider", () => {
    const registry = new LLMProviderRegistry();
    expect(registry.getPlugin("nope")).toBeUndefined();
  });

  it("discoverModels delegates to plugin", async () => {
    const registry = new LLMProviderRegistry();
    registry.register(
      createTestPlugin("test", {
        discoverModels: async () => [
          { id: "m1", label: "Model 1", capabilities: { ...DEFAULT_CAPABILITIES }, loaded: true },
        ],
      }),
    );

    const models = await registry.discoverModels("test", { provider: "test" });
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("m1");
  });

  it("discoverModels returns empty for unknown provider", async () => {
    const registry = new LLMProviderRegistry();
    const models = await registry.discoverModels("nope", { provider: "nope" });
    expect(models).toHaveLength(0);
  });
});
