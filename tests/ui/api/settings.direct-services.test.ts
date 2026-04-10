import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetServices = vi.fn();

vi.mock("../../../src/ui/api/helpers.js", () => ({
  useDirectServices: () => true,
  BASE: "/api",
  handleResponse: async (res: Response) => res.json(),
  handleVoidResponse: async () => {},
}));

vi.mock("../../../src/ui/api/direct-services.js", () => ({
  getServices: () => mockGetServices(),
}));

import { getAllSettings, getAppSetting, setAppSetting } from "../../../src/ui/api/settings.js";

describe("ui/api/settings direct-services parity", () => {
  const mockStorage = {
    listAllAppSettings: vi.fn(),
    getAppSetting: vi.fn(),
    setAppSetting: vi.fn(),
  };
  const mockSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServices.mockResolvedValue({
      storage: mockStorage,
      save: mockSave,
    });
  });

  it("getAllSettings excludes sensitive keys in direct-services mode", async () => {
    mockStorage.listAllAppSettings.mockReturnValue([
      { key: "font_size", value: "16" },
      { key: "ai_api_key", value: "sk-secret" },
      { key: "oauth_token", value: "token-value" },
    ]);

    const settings = await getAllSettings();

    expect(settings).toEqual({ font_size: "16" });
  });

  it("getAppSetting redacts sensitive values in direct-services mode", async () => {
    mockStorage.getAppSetting.mockReturnValue({ key: "ai_api_key", value: "sk-secret" });

    const value = await getAppSetting("ai_api_key");

    expect(value).toBe("[REDACTED]");
  });

  it("setAppSetting enforces writable allowlist in direct-services mode", async () => {
    await setAppSetting("font_size", "14");

    expect(mockStorage.setAppSetting).toHaveBeenCalledWith("font_size", "14");
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("setAppSetting rejects non-allowlisted keys in direct-services mode", async () => {
    await expect(setAppSetting("ai_api_key", "sk-secret")).rejects.toThrow(
      'Setting key "ai_api_key" is not allowed',
    );

    expect(mockStorage.setAppSetting).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });
});
