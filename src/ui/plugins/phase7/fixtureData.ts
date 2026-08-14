/**
 * Offline Phase 7 visual fixture data — synthetic demo copy only.
 */

import type { BrowserPlugin } from "../components/PluginBrowser";
import type { InstalledPlugin, PluginSetting, PluginSurface, SettingDeclaration } from "../types";

export const FIXTURE_COPY = {
  communityPluginName: "Sample Timer Pack",
  communityPluginAuthor: "Demo Publisher",
  communityPluginDescription:
    "Offline demo registry entry for Extensions browser capture. Not a live package.",
  communityLongDescription:
    "Deterministic fixture package used only for Phase 7 legacy visual authorities. Install, search, and detail chrome are rendered offline with no marketplace network dependency.",
  panelTitle: "Automation Panel",
  panelHeading: "Queued actions",
} as const;

export const POMODORO_SETTINGS: SettingDeclaration[] = [
  {
    id: "workMinutes",
    label: "Work Duration",
    description: "",
    schema: { type: "integer", default: 25, min: 1, max: 120, step: 1 },
  },
  {
    id: "breakMinutes",
    label: "Break Duration",
    description: "",
    schema: { type: "integer", default: 5, min: 1, max: 60, step: 1 },
  },
  {
    id: "longBreakMinutes",
    label: "Long Break Duration",
    description: "",
    schema: { type: "integer", default: 15, min: 1, max: 60, step: 1 },
  },
  {
    id: "sessionsBeforeLongBreak",
    label: "Sessions Before Long Break",
    description: "",
    schema: { type: "integer", default: 4, min: 1, max: 10, step: 1 },
  },
];

function basePlugin(
  partial: Partial<InstalledPlugin> &
    Pick<InstalledPlugin, "pluginId" | "name" | "description" | "builtin">,
): InstalledPlugin {
  return {
    version: "1.0.0",
    packageSha256: "0".repeat(64),
    publisherKeyId: "junban-builtin",
    packageGeneration: 1,
    activationEpoch: 1,
    desiredEnabled: false,
    runtimeState: "disabled",
    requestedPermissions: [],
    grantedPermissions: [],
    dependencies: [],
    dependenciesSatisfied: true,
    settingDeclarations: [],
    failureCount: 0,
    lastErrorCode: null,
    nextRetryAt: null,
    installedAt: "2026-08-04T15:00:00.000Z",
    updatedAt: "2026-08-04T15:00:00.000Z",
    author: "ASF",
    ...partial,
  };
}

export function fixtureInstalledPlugins(): InstalledPlugin[] {
  return [
    basePlugin({
      pluginId: "pomodoro",
      name: "Pomodoro Timer",
      description: "Focus timer with configurable work/break intervals.",
      builtin: true,
      desiredEnabled: true,
      runtimeState: "active",
      icon: "timer",
      requestedPermissions: [
        { capability: "tasks:read", scope: {} },
        { capability: "commands", scope: {} },
        { capability: "ui:status", scope: {} },
        { capability: "ui:view", scope: {} },
        { capability: "storage", scope: {} },
        { capability: "settings", scope: {} },
      ],
      grantedPermissions: [
        { capability: "tasks:read", scope: {} },
        { capability: "commands", scope: {} },
        { capability: "ui:status", scope: {} },
        { capability: "ui:view", scope: {} },
        { capability: "storage", scope: {} },
        { capability: "settings", scope: {} },
      ],
    }),
    basePlugin({
      pluginId: "calendar",
      name: "Calendar",
      description: "Calendar view for scheduled tasks.",
      builtin: true,
      desiredEnabled: true,
      runtimeState: "active",
      icon: "calendar",
      requestedPermissions: [
        { capability: "tasks:read", scope: {} },
        { capability: "tasks:write", scope: {} },
        { capability: "projects:read", scope: {} },
        { capability: "ui:view", scope: {} },
      ],
      grantedPermissions: [
        { capability: "tasks:read", scope: {} },
        { capability: "tasks:write", scope: {} },
        { capability: "projects:read", scope: {} },
        { capability: "ui:view", scope: {} },
      ],
    }),
    basePlugin({
      pluginId: "stats",
      name: "Stats",
      description: "Productivity statistics and charts.",
      builtin: true,
      icon: "bar-chart-3",
      requestedPermissions: [
        { capability: "tasks:read", scope: {} },
        { capability: "ui:view", scope: {} },
      ],
    }),
    basePlugin({
      pluginId: "focus-helper",
      name: "Focus Helper",
      description: "Built-in helper used to exercise permission approval chrome.",
      builtin: true,
      icon: "target",
      requestedPermissions: [
        { capability: "tasks:read", scope: {} },
        { capability: "commands", scope: {} },
        { capability: "ui:status", scope: {} },
      ],
    }),
    basePlugin({
      pluginId: "sample-timer",
      name: FIXTURE_COPY.communityPluginName,
      description: FIXTURE_COPY.communityPluginDescription,
      builtin: false,
      version: "0.3.1",
      author: FIXTURE_COPY.communityPluginAuthor,
      publisherKeyId: "demo-publisher-key",
      icon: "puzzle",
      requestedPermissions: [
        { capability: "tasks:read", scope: {} },
        { capability: "ui:status", scope: {} },
        { capability: "storage", scope: {} },
      ],
    }),
  ];
}

export function fixtureStorePlugins(): BrowserPlugin[] {
  return [
    {
      id: "markdown-export-pack",
      name: "Markdown Export Pack",
      description: "Offline demo export helper listed in the registry browser.",
      author: "Demo Publisher",
      version: "1.2.0",
      tags: ["export", "markdown", "demo"],
      capabilities: ["task:read", "storage"],
      packageSha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      installed: false,
      downloads: 640,
      repository: "example.invalid/junban-plugins/markdown-export-pack",
      longDescription:
        "Deterministic registry row used for list/search/filter and not-installed detail/install chrome.",
    },
    {
      id: "sample-timer",
      name: FIXTURE_COPY.communityPluginName,
      description: FIXTURE_COPY.communityPluginDescription,
      author: FIXTURE_COPY.communityPluginAuthor,
      version: "0.3.1",
      tags: ["timer", "productivity", "demo"],
      capabilities: ["task:read", "ui:status", "storage"],
      packageSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      installed: true,
      downloads: 1280,
      longDescription: FIXTURE_COPY.communityLongDescription,
    },
    {
      id: "status-badge-kit",
      name: "Status Badge Kit",
      description: "Not-installed demo package for filter chrome.",
      author: "Demo Publisher",
      version: "0.1.4",
      tags: ["status", "ui", "demo"],
      capabilities: ["ui:status"],
      packageSha256: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      installed: false,
      downloads: 96,
      longDescription: "Third registry row kept uninstalled for Not Installed filter authority.",
    },
  ];
}

export function fixturePomodoroSettingValues(): PluginSetting[] {
  return [
    { key: "workMinutes", value: 25, updatedAt: "2026-08-04T15:00:00.000Z" },
    { key: "breakMinutes", value: 5, updatedAt: "2026-08-04T15:00:00.000Z" },
    { key: "longBreakMinutes", value: 15, updatedAt: "2026-08-04T15:00:00.000Z" },
    { key: "sessionsBeforeLongBreak", value: 4, updatedAt: "2026-08-04T15:00:00.000Z" },
  ];
}

/** WIT-shaped pomodoro surface for contribution scenes. */
export function fixturePomodoroSurface(): PluginSurface {
  return {
    surfaceId: "pomodoro-view",
    rootIndex: 0,
    nodes: [
      {
        id: "root",
        parentIndex: null,
        content: { tag: "stack", val: { gap: 4, align: "center" } },
      },
      {
        id: "phase",
        parentIndex: 0,
        content: {
          tag: "text",
          val: { text: "Work", tone: "neutral", size: "small" },
        },
      },
      {
        id: "timer",
        parentIndex: 0,
        content: {
          tag: "heading",
          val: { text: "25:00", tone: "neutral", size: "large" },
        },
      },
      {
        id: "progress",
        parentIndex: 0,
        content: { tag: "progress", val: { label: "", value: 0, maximum: 1500 } },
      },
      {
        id: "actions",
        parentIndex: 0,
        content: { tag: "row", val: { gap: 4, align: "center" } },
      },
      {
        id: "start",
        parentIndex: 4,
        content: {
          tag: "button",
          val: { label: "Start", actionId: "pomodoro:start", tone: "accent", icon: null },
        },
      },
      {
        id: "reset",
        parentIndex: 4,
        content: {
          tag: "button",
          val: { label: "Reset", actionId: "pomodoro:reset", tone: "neutral", icon: null },
        },
      },
      {
        id: "skip",
        parentIndex: 4,
        content: {
          tag: "button",
          val: { label: "Skip", actionId: "pomodoro:skip", tone: "neutral", icon: null },
        },
      },
      {
        id: "badges",
        parentIndex: 0,
        content: { tag: "row", val: { gap: 2, align: "center" } },
      },
      {
        id: "session",
        parentIndex: 8,
        content: {
          tag: "badge",
          val: { text: "Session 1/4", tone: "neutral", size: "small" },
        },
      },
      {
        id: "idle",
        parentIndex: 8,
        content: {
          tag: "badge",
          val: { text: "Idle", tone: "neutral", size: "small" },
        },
      },
    ],
  };
}

export function fixtureDeclarativePanelSurface(): PluginSurface {
  return {
    surfaceId: "automation-panel",
    rootIndex: 0,
    nodes: [
      {
        id: "root",
        parentIndex: null,
        content: { tag: "stack", val: { gap: 3, align: "start" } },
      },
      {
        id: "heading",
        parentIndex: 0,
        content: {
          tag: "heading",
          val: { text: FIXTURE_COPY.panelHeading, tone: "neutral", size: "small" },
        },
      },
      {
        id: "body",
        parentIndex: 0,
        content: {
          tag: "text",
          val: {
            text: "3 tasks ready for the next focus block.",
            tone: "neutral",
            size: "medium",
          },
        },
      },
      { id: "div", parentIndex: 0, content: { tag: "divider", val: null } },
      {
        id: "row",
        parentIndex: 0,
        content: { tag: "row", val: { gap: 2, align: "start" } },
      },
      {
        id: "run",
        parentIndex: 4,
        content: {
          tag: "button",
          val: { label: "Run plan", actionId: "example:run-plan", tone: "accent", icon: null },
        },
      },
      {
        id: "dismiss",
        parentIndex: 4,
        content: {
          tag: "button",
          val: { label: "Dismiss", actionId: "example:dismiss", tone: "neutral", icon: null },
        },
      },
      {
        id: "badge",
        parentIndex: 0,
        content: {
          tag: "badge",
          val: { text: "Declarative actions", tone: "accent", size: "small" },
        },
      },
    ],
  };
}
