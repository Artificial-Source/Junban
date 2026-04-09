import { describe, expect, it } from "vitest";
import {
  areCommunityPluginsEnabled,
  hasSettingsPermission,
  settingsPermissionError,
  validateApprovalPermissions,
} from "../../src/plugins/route-policy.js";

describe("plugins/route-policy", () => {
  it("reads community plugin mode from app settings", () => {
    const enabledStorage = {
      getAppSetting: (key: string) =>
        key === "community_plugins_enabled" ? { value: "true" } : undefined,
    };
    const disabledStorage = {
      getAppSetting: () => ({ value: "false" }),
    };

    expect(areCommunityPluginsEnabled(enabledStorage)).toBe(true);
    expect(areCommunityPluginsEnabled(disabledStorage)).toBe(false);
  });

  it("checks settings permission and formats permission error", () => {
    expect(hasSettingsPermission(["task:read", "settings"])).toBe(true);
    expect(hasSettingsPermission(["task:read"])).toBe(false);
    expect(hasSettingsPermission(undefined)).toBe(false);
    expect(settingsPermissionError("pomodoro")).toBe(
      'Plugin "pomodoro" does not have the "settings" permission.',
    );
  });

  it("validates approval permissions payloads", () => {
    expect(validateApprovalPermissions("not-an-array")).toEqual({
      ok: false,
      error: "permissions must be an array",
    });

    expect(validateApprovalPermissions(["commands", "unknown", 123])).toEqual({
      ok: false,
      error: "Invalid permissions: unknown, 123",
    });

    expect(validateApprovalPermissions(["commands", "settings"]).ok).toBe(true);
  });
});
