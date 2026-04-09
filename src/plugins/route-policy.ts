import { VALID_PERMISSIONS } from "./types.js";

const validPermissions = new Set<string>(VALID_PERMISSIONS);

export const COMMUNITY_PLUGINS_DISABLED_ERROR =
  "Community plugins are disabled. Enable them in Settings > Plugins.";

type AppSettingReader = {
  getAppSetting(key: string): { value: string } | undefined;
};

export function areCommunityPluginsEnabled(storage: AppSettingReader): boolean {
  return storage.getAppSetting("community_plugins_enabled")?.value === "true";
}

export function hasSettingsPermission(permissions: string[] | undefined): boolean {
  return (permissions ?? []).includes("settings");
}

export function settingsPermissionError(pluginId: string): string {
  return `Plugin "${pluginId}" does not have the "settings" permission.`;
}

export type ValidateApprovalPermissionsResult =
  | { ok: true; permissions: string[] }
  | { ok: false; error: string };

export function validateApprovalPermissions(permissions: unknown): ValidateApprovalPermissionsResult {
  if (!Array.isArray(permissions)) {
    return { ok: false, error: "permissions must be an array" };
  }

  const invalid = permissions.filter((p) => typeof p !== "string" || !validPermissions.has(p));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Invalid permissions: ${invalid.map((p) => String(p)).join(", ")}`,
    };
  }

  return { ok: true, permissions: permissions as string[] };
}
