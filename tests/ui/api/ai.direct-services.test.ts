import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetServices = vi.fn();
const mockGetSecureSetting = vi.fn();
const mockSetSecureSetting = vi.fn();

vi.mock("../../../src/ui/api/helpers.js", () => ({
  useDirectServices: () => true,
  BASE: "/api",
  handleResponse: async (res: Response) => res.json(),
  handleVoidResponse: async () => {},
}));

vi.mock("../../../src/ui/api/direct-services.js", () => ({
  getServices: () => mockGetServices(),
}));

vi.mock("../../../src/storage/encrypted-settings.js", () => ({
  getSecureSetting: (...args: unknown[]) => mockGetSecureSetting(...args),
  setSecureSetting: (...args: unknown[]) => mockSetSecureSetting(...args),
}));

import { getAIConfig, updateAIConfig } from "../../../src/ui/api/ai.js";

describe("ui/api/ai direct-services updateAIConfig", () => {
  const mockStorage = {
    getAppSetting: vi.fn(),
    setAppSetting: vi.fn(),
    deleteAppSetting: vi.fn(),
  };
  const mockSave = vi.fn();
  const mockClearSession = vi.fn();
  const mockGetAIRuntime = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSecureSetting.mockResolvedValue(null);
    mockSetSecureSetting.mockResolvedValue(undefined);
    mockGetServices.mockResolvedValue({
      storage: mockStorage,
      save: mockSave,
      getAIRuntime: mockGetAIRuntime,
    });
    mockStorage.getAppSetting.mockImplementation((key: string) => {
      if (key === "ai_provider") return { value: "openai" };
      if (key === "ai_model") return { value: "gpt-4o-mini" };
      if (key === "ai_base_url") return { value: "https://api.openai.com/v1" };
      if (key === "ai_auth_type") return { value: "oauth" };
      return undefined;
    });
  });

  it("reads API key and OAuth token via secure setting helper", async () => {
    mockGetSecureSetting
      .mockResolvedValueOnce("sk-secure")
      .mockResolvedValueOnce("oauth-secure-token");

    const config = await getAIConfig();

    expect(mockGetSecureSetting).toHaveBeenNthCalledWith(1, mockStorage, "ai_api_key");
    expect(mockGetSecureSetting).toHaveBeenNthCalledWith(2, mockStorage, "ai_oauth_token");
    expect(config).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      hasApiKey: true,
      authType: "oauth",
      hasOAuthToken: true,
    });
  });

  it("saves config before requesting AI runtime", async () => {
    mockGetAIRuntime.mockRejectedValue(new Error("runtime unavailable"));

    await expect(updateAIConfig({ provider: "openai" })).rejects.toThrow("runtime unavailable");

    expect(mockStorage.setAppSetting).toHaveBeenCalledWith("ai_provider", "openai");
    expect(mockSetSecureSetting).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetAIRuntime.mock.invocationCallOrder[0],
    );
  });

  it("persists again after clearing chat session", async () => {
    mockGetAIRuntime.mockResolvedValue({
      chatManager: {
        clearSession: mockClearSession,
      },
    });

    await updateAIConfig({ provider: "anthropic" });

    expect(mockClearSession).toHaveBeenCalledWith(mockStorage);
    expect(mockSave).toHaveBeenCalledTimes(2);
  });

  it("writes API key and OAuth token via secure setting helper", async () => {
    mockGetAIRuntime.mockResolvedValue({
      chatManager: {
        clearSession: mockClearSession,
      },
    });

    await updateAIConfig({
      provider: "anthropic",
      apiKey: "sk-ant-secure",
      oauthToken: "oauth-secure-token",
    });

    expect(mockSetSecureSetting).toHaveBeenNthCalledWith(
      1,
      mockStorage,
      "ai_api_key",
      "sk-ant-secure",
    );
    expect(mockSetSecureSetting).toHaveBeenNthCalledWith(
      2,
      mockStorage,
      "ai_oauth_token",
      "oauth-secure-token",
    );
    expect(mockSave).toHaveBeenCalledTimes(2);
  });
});
