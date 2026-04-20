import { describe, expect, it, vi } from "vitest";
import { aiRoutes } from "../../src/api/ai.js";

describe("aiRoutes initialization retry", () => {
  it("keeps /providers available and retries plugin initialization after an initial failure", async () => {
    const loadAll = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("init failed"))
      .mockResolvedValueOnce(undefined);

    const services = {
      pluginLoader: {
        loadAll,
      },
      aiProviderRegistry: {
        getAll: vi.fn().mockReturnValue([
          {
            plugin: {
              name: "openai",
              displayName: "OpenAI",
              needsApiKey: true,
            },
            pluginId: "builtin:openai",
          },
        ]),
      },
    } as any;

    const app = aiRoutes(services);

    const first = await app.request(new Request("http://localhost/providers"));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual([
      {
        name: "openai",
        displayName: "OpenAI",
        needsApiKey: true,
        optionalApiKey: false,
        supportsOAuth: false,
        defaultModel: undefined,
        defaultBaseUrl: undefined,
        showBaseUrl: false,
        pluginId: "builtin:openai",
      },
    ]);

    const second = await app.request(new Request("http://localhost/providers"));
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual([
      {
        name: "openai",
        displayName: "OpenAI",
        needsApiKey: true,
        optionalApiKey: false,
        supportsOAuth: false,
        defaultModel: undefined,
        defaultBaseUrl: undefined,
        showBaseUrl: false,
        pluginId: "builtin:openai",
      },
    ]);

    expect(loadAll).toHaveBeenCalledTimes(2);
  });

  it("uses injected ensurePluginsLoaded when provided", async () => {
    const loadAll = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const ensurePluginsLoaded = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const services = {
      pluginLoader: {
        loadAll,
      },
      aiProviderRegistry: {
        getAll: vi.fn().mockReturnValue([
          {
            plugin: {
              name: "openai",
              displayName: "OpenAI",
              needsApiKey: true,
            },
            pluginId: "builtin:openai",
          },
        ]),
      },
    } as any;

    const app = aiRoutes(services, { ensurePluginsLoaded });
    const res = await app.request(new Request("http://localhost/providers"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      {
        name: "openai",
        displayName: "OpenAI",
        needsApiKey: true,
        optionalApiKey: false,
        supportsOAuth: false,
        defaultModel: undefined,
        defaultBaseUrl: undefined,
        showBaseUrl: false,
        pluginId: "builtin:openai",
      },
    ]);
    expect(ensurePluginsLoaded).toHaveBeenCalledTimes(1);
    expect(loadAll).not.toHaveBeenCalled();
  });

  it("does not fail /providers when injected ensurePluginsLoaded rejects", async () => {
    const loadAll = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const ensurePluginsLoaded = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValueOnce(undefined);

    const services = {
      pluginLoader: {
        loadAll,
      },
      aiProviderRegistry: {
        getAll: vi.fn().mockReturnValue([
          {
            plugin: {
              name: "openai",
              displayName: "OpenAI",
              needsApiKey: true,
            },
            pluginId: "builtin:openai",
          },
        ]),
      },
    } as any;

    const app = aiRoutes(services, { ensurePluginsLoaded });

    const first = await app.request(new Request("http://localhost/providers"));
    expect(first.status).toBe(200);

    const second = await app.request(new Request("http://localhost/providers"));
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual([
      {
        name: "openai",
        displayName: "OpenAI",
        needsApiKey: true,
        optionalApiKey: false,
        supportsOAuth: false,
        defaultModel: undefined,
        defaultBaseUrl: undefined,
        showBaseUrl: false,
        pluginId: "builtin:openai",
      },
    ]);

    expect(ensurePluginsLoaded).toHaveBeenCalledTimes(2);
    expect(loadAll).not.toHaveBeenCalled();
  });

  it("keeps /config available without depending on plugin initialization", async () => {
    const ensurePluginsLoaded = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("startup failed"));
    const getAppSetting = vi.fn((key: string) => {
      if (key === "ai_provider") return { value: "openai" };
      if (key === "ai_model") return { value: "gpt-4o-mini" };
      if (key === "ai_base_url") return { value: "https://api.openai.com" };
      if (key === "ai_api_key") return { value: "sk-test" };
      if (key === "ai_auth_type") return { value: "api-key" };
      if (key === "ai_oauth_token") return null;
      return null;
    });

    const services = {
      pluginLoader: {
        loadAll: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      },
      aiProviderRegistry: {
        getAll: vi.fn().mockReturnValue([]),
      },
      storage: {
        getAppSetting,
      },
    } as any;

    const app = aiRoutes(services, { ensurePluginsLoaded });
    const res = await app.request(new Request("http://localhost/config"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com",
      hasApiKey: true,
      authType: "api-key",
      hasOAuthToken: false,
    });
    expect(ensurePluginsLoaded).not.toHaveBeenCalled();
  });
});
