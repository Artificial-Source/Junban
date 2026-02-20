import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAvailableModels, loadLMStudioModel } from "../../src/ai/model-discovery.js";
import type { ModelInfo } from "../../src/ai/model-discovery.js";

describe("fetchAvailableModels", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  function ids(models: ModelInfo[]): string[] {
    return models.map((m) => m.id);
  }

  it("returns hardcoded models for anthropic", async () => {
    const models = await fetchAvailableModels("anthropic", {});
    expect(ids(models)).toEqual([
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-6",
      "claude-haiku-4-5-20251001",
    ]);
    expect(models.every((m) => m.loaded)).toBe(true);
  });

  it("returns empty array for unknown provider", async () => {
    const models = await fetchAvailableModels("custom-plugin", {});
    expect(models).toEqual([]);
  });

  it("fetches ollama models from /api/tags", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [{ name: "llama3.2" }, { name: "codellama" }] }),
    });

    const models = await fetchAvailableModels("ollama", {});
    expect(ids(models)).toEqual(["llama3.2", "codellama"]);
    expect(models.every((m) => m.loaded)).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("uses custom baseUrl for ollama", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [{ name: "phi3" }] }),
    });

    const models = await fetchAvailableModels("ollama", {
      baseUrl: "http://myserver:11434",
    });
    expect(ids(models)).toEqual(["phi3"]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://myserver:11434/api/tags",
      expect.any(Object),
    );
  });

  it("fetches lmstudio models from native API with correct shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          models: [
            {
              type: "llm",
              key: "google/gemma-3-4b",
              display_name: "Gemma 3 4B Instruct",
              publisher: "google",
              params_string: "4B",
              loaded_instances: [{ id: "google/gemma-3-4b" }],
            },
            {
              type: "llm",
              key: "qwen/qwen2-0.5b",
              display_name: "Qwen2 0.5B",
              publisher: "qwen",
              params_string: "0.5B",
              loaded_instances: [],
            },
            {
              type: "embedding",
              key: "nomic-embed",
              display_name: "Nomic Embed",
              publisher: "nomic",
              loaded_instances: [],
            },
          ],
        }),
    });

    const models = await fetchAvailableModels("lmstudio", {});
    // Should filter out embedding models
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("google/gemma-3-4b");
    expect(models[0].label).toBe("Gemma 3 4B Instruct (4B)");
    expect(models[0].loaded).toBe(true);
    expect(models[1].id).toBe("qwen/qwen2-0.5b");
    expect(models[1].loaded).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:1234/api/v1/models",
      expect.any(Object),
    );
  });

  it("falls back to OpenAI-compatible endpoint for lmstudio", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (url.includes("/api/v1/models")) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "fallback-model" }] }),
      });
    });

    const models = await fetchAvailableModels("lmstudio", {});
    expect(ids(models)).toEqual(["fallback-model"]);
    expect(models[0].loaded).toBe(true); // Fallback assumes loaded
    expect(callCount).toBe(2);
  });

  it("strips /v1 from lmstudio baseUrl for native API", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          models: [
            {
              type: "llm",
              key: "test-model",
              display_name: "Test",
              publisher: "test",
              loaded_instances: [],
            },
          ],
        }),
    });

    await fetchAvailableModels("lmstudio", { baseUrl: "http://myhost:1234/v1" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://myhost:1234/api/v1/models",
      expect.any(Object),
    );
  });

  it("fetches openai models and filters to chat models", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { id: "gpt-4o" },
            { id: "gpt-3.5-turbo" },
            { id: "dall-e-3" },
            { id: "text-embedding-ada-002" },
            { id: "o1-preview" },
          ],
        }),
    });

    const models = await fetchAvailableModels("openai", { apiKey: "sk-test" });
    const modelIds = ids(models);
    expect(modelIds).toContain("gpt-4o");
    expect(modelIds).toContain("gpt-3.5-turbo");
    expect(modelIds).toContain("o1-preview");
    expect(modelIds).not.toContain("dall-e-3");
    expect(modelIds).not.toContain("text-embedding-ada-002");
  });

  it("sends authorization header for openai", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    await fetchAvailableModels("openai", { apiKey: "sk-my-key" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-my-key" },
      }),
    );
  });

  it("returns empty array for openai without api key", async () => {
    const models = await fetchAvailableModels("openai", {});
    expect(models).toEqual([]);
  });

  it("fetches openrouter models", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: "anthropic/claude-sonnet-4-5-20250929" }, { id: "openai/gpt-4o" }],
        }),
    });

    const models = await fetchAvailableModels("openrouter", { apiKey: "sk-or-test" });
    expect(ids(models)).toEqual(["anthropic/claude-sonnet-4-5-20250929", "openai/gpt-4o"]);
  });

  it("returns empty array for openrouter without api key", async () => {
    const models = await fetchAvailableModels("openrouter", {});
    expect(models).toEqual([]);
  });

  it("returns empty array when fetch fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const models = await fetchAvailableModels("ollama", {});
    expect(models).toEqual([]);
  });

  it("returns empty array when response is not ok", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const models = await fetchAvailableModels("ollama", {});
    expect(models).toEqual([]);
  });

  it("handles missing models array gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const models = await fetchAvailableModels("ollama", {});
    expect(models).toEqual([]);
  });
});

describe("loadLMStudioModel", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST to /api/v1/models/load with model key", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          type: "llm",
          instance_id: "google/gemma-3-4b",
          load_time_seconds: 2.5,
          status: "loaded",
        }),
    });

    const result = await loadLMStudioModel("google/gemma-3-4b", "http://localhost:1234/v1");
    expect(result).toBe("google/gemma-3-4b");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:1234/api/v1/models/load",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "google/gemma-3-4b" }),
      }),
    );
  });

  it("throws on failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      statusText: "Bad Request",
      text: () => Promise.resolve("Model not found"),
    });

    await expect(loadLMStudioModel("nonexistent", "http://localhost:1234/v1")).rejects.toThrow(
      "Failed to load model",
    );
  });
});
