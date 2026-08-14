/**
 * Frontend plugin operator types for Phase 7 Wave 4.
 * Narrow structural types over generated DTOs; unknown shapes fail closed in parsers.
 */

import type { components } from "../api/generated";

export type PluginCapability = components["schemas"]["PluginCapabilityDto"];
export type PluginPermissionScope = components["schemas"]["PluginPermissionScopeDto"];
export type PluginPermission = components["schemas"]["PluginPermissionDto"];

export type InstalledPlugin = {
  pluginId: string;
  name: string;
  description: string;
  version: string;
  packageSha256: string;
  publisherKeyId: string;
  packageGeneration: number;
  activationEpoch: number;
  desiredEnabled: boolean;
  runtimeState: string;
  requestedPermissions: PluginPermission[];
  grantedPermissions: PluginPermission[];
  dependencies: string[];
  dependenciesSatisfied: boolean;
  settingDeclarations: SettingDeclaration[];
  failureCount: number;
  lastErrorCode: string | null;
  nextRetryAt: string | null;
  installedAt: string;
  updatedAt: string;
  /** Bundled reference / first-party-origin packages listed under Built-in. */
  builtin: boolean;
  /** Optional presentation icon id from fixture or known reference packages. */
  icon?: string;
  /** Optional author label for card chrome. */
  author?: string;
};

export type CommunityPolicy = {
  enabled: boolean;
  updatedAt: string;
};

export type RegistryEntry = {
  pluginId: string;
  version: string;
  packageSha256: string;
  packageSize: number;
  publisherKeyId: string;
  name: string;
  description: string;
  author: string;
  license: string;
  searchTags: string[];
  runtimeProfile: string;
  requestedCapabilities: string[];
};

export type PluginContributionKind = "command" | "view" | "panel" | "status" | string;

export type PluginContribution = {
  contributionId: string;
  pluginId: string;
  localId: string;
  kind: PluginContributionKind;
  title: string;
  description: string | null;
  location: string | null;
  actions: string[];
  packageGeneration: number;
  activationEpoch: number;
  hostSessionId: string;
};

export type ContributionFence = {
  packageGeneration: number;
  activationEpoch: number;
  hostSessionId: string;
};

export type PluginSettingValue = string | number | boolean;

export type PluginSetting = {
  key: string;
  value: PluginSettingValue;
  updatedAt: string;
};

export type SettingSchema =
  | {
      type: "text";
      default: string;
      minBytes: number;
      maxBytes: number;
      secret: false;
    }
  | {
      type: "text";
      /** Secret manifest defaults are never returned by the installed-plugin API. */
      default: null;
      minBytes: number;
      maxBytes: number;
      secret: true;
    }
  | {
      type: "integer";
      default: number;
      min: number;
      max: number;
      step: number;
    }
  | {
      type: "boolean";
      default: boolean;
    }
  | {
      type: "select";
      default: string;
      options: Array<{ id: string; label: string }>;
    };

export type SettingDeclaration = {
  id: string;
  label: string;
  description: string;
  schema: SettingSchema;
};

export type PluginGrant = {
  packageGeneration: number;
  permissionHash: string;
  permission: PluginPermission;
  grantedAt: string;
};

export type PublisherTrust = {
  keyId: string;
  publicKeyBase64: string;
  status: string;
  trustedAt: string;
  revokedAt: string | null;
};

export type PluginMutationResult = {
  eventType: string;
  revision: number;
  operationId: string;
};

export type PluginInvocationResult = {
  status: string;
  terminalKind: string | null;
  revision: number | null;
  rejection: string | null;
};

export type UiTone = "neutral" | "accent" | "positive" | "warning" | "danger";
export type UiSize = "small" | "medium" | "large";
export type UiAlign = "start" | "center" | "end" | "stretch";

export type ScalarValue =
  | { tag: "string-value"; val: string }
  | { tag: "integer-value"; val: number }
  | { tag: "boolean-value"; val: boolean }
  | { tag: "date-value"; val: string }
  | { tag: "timestamp-value"; val: string }
  | { tag: "task-id"; val: string }
  | { tag: "project-id"; val: string }
  | { tag: "tag-id"; val: string }
  | { tag: "plugin-id"; val: string }
  | { tag: "option-id"; val: string };

export type ScalarNamedValue = { name: string; value: ScalarValue };

export type UiContent =
  | { tag: "stack"; val: { gap: number; align: UiAlign } }
  | { tag: "row"; val: { gap: number; align: UiAlign } }
  | { tag: "heading"; val: { text: string; tone: UiTone; size: UiSize } }
  | { tag: "text"; val: { text: string; tone: UiTone; size: UiSize } }
  | { tag: "badge"; val: { text: string; tone: UiTone; size: UiSize } }
  | { tag: "metric"; val: { label: string; value: string; tone: UiTone } }
  | { tag: "progress"; val: { label: string; value: number; maximum: number } }
  | {
      tag: "button";
      val: { label: string; actionId: string; tone: UiTone; icon: string | null };
    }
  | {
      tag: "text-input";
      val: {
        label: string;
        actionId: string;
        value: ScalarValue;
        options: ScalarNamedValue[];
      };
    }
  | {
      tag: "number-input";
      val: {
        label: string;
        actionId: string;
        value: ScalarValue;
        options: ScalarNamedValue[];
      };
    }
  | {
      tag: "select";
      val: {
        label: string;
        actionId: string;
        value: ScalarValue;
        options: ScalarNamedValue[];
      };
    }
  | {
      tag: "toggle";
      val: {
        label: string;
        actionId: string;
        value: ScalarValue;
        options: ScalarNamedValue[];
      };
    }
  | { tag: "task-list"; val: { taskIds: string[] } }
  | { tag: "task-ref"; val: string }
  | { tag: "divider"; val: null }
  | { tag: "empty-state"; val: { text: string; tone: UiTone; size: UiSize } }
  | { tag: "error-state"; val: { text: string; tone: UiTone; size: UiSize } };

export type UiNode = {
  id: string;
  parentIndex: number | null;
  content: UiContent;
};

export type PluginSurface = {
  surfaceId: string;
  rootIndex: number;
  nodes: UiNode[];
};

export type RenderedContribution = {
  pluginId: string;
  surfaceId: string;
  packageGeneration: number;
  activationEpoch: number;
  hostSessionId: string;
  surface: PluginSurface;
};

/** First-party view/command ids that plugin contributions must never shadow. */
export const FIRST_PARTY_ROUTE_NAMES = new Set([
  "today",
  "inbox",
  "upcoming",
  "someday",
  "completed",
  "cancelled",
  "search",
  "filters-labels",
  "saved-filter",
  "project",
  "task",
  "calendar",
  "matrix",
  "stats",
  "dopamine-menu",
  "timeblocking",
  "ai-chat",
  "settings",
  "quick-wins",
]);

export const FIRST_PARTY_COMMAND_IDS = new Set([
  "quick-add",
  "search",
  "command-palette",
  "new-project",
  "undo",
  "redo",
  "today",
  "inbox",
  "upcoming",
  "someday",
  "completed",
  "cancelled",
  "filters",
  "focus-mode",
  "plan-my-day",
  "end-of-day",
  "weekly-review",
  "calendar",
  "matrix",
  "stats",
  "dopamine-menu",
  "timeblocking",
  "settings",
  "settings-data",
  "settings-templates",
  "quick-wins",
]);

/** Client-side declarative surface bounds (mirror WIT host limits). */
export const UI_NODE_MAX = 256;
export const UI_DEPTH_MAX = 8;
export const UI_TEXT_MAX = 2048;
export const UI_SURFACE_BYTES_MAX = 32 * 1024;
