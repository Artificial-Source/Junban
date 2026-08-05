/**
 * Ephemeral Phase 7 legacy Extensions/plugin visual fixture state.
 * Read by Vite-overlaid mocks; never touches production legacy sources.
 */

export type Phase7SceneId =
  | "settings-extensions-main-desktop-light"
  | "settings-extensions-safety-desktop-light"
  | "settings-extensions-permission-desktop-light"
  | "registry-browser-list-detail-desktop-light"
  | "registry-browser-empty-desktop-light"
  | "registry-browser-loading-desktop-light"
  | "registry-browser-error-desktop-light"
  | "plugin-settings-pomodoro-desktop-light"
  | "pomodoro-view-status-desktop-light"
  | "declarative-panel-action-desktop-light"
  | "settings-extensions-mobile-category-light"
  | "settings-extensions-mobile-detail-light"
  | "pomodoro-view-status-desktop-dark";

export type StoreMode = "ready" | "loading" | "error" | "empty";
export type PluginLoadMode = "ready" | "loading" | "error";

export interface Phase7FixtureState {
  scene: Phase7SceneId;
  theme: "light" | "dark";
  /** community_plugins_enabled setting */
  communityPluginsEnabled: boolean;
  /** Installed plugin list resource state */
  pluginLoadMode: PluginLoadMode;
  /** Registry store fetch mode for PluginBrowser */
  storeMode: StoreMode;
  /** When true, installed plugin list is empty (registry empty authority). */
  emptyInstalledPlugins: boolean;
  /** Expand settings card for this plugin id */
  expandedPluginId: string | null;
  /** Open community safety dialog */
  openSafetyDialog: boolean;
  /** Open permission dialog for this installed plugin id */
  openPermissionPluginId: string | null;
  /** Force PluginBrowser open without clicking Browse */
  openBrowser: boolean;
  /** Prefill Extensions search box */
  searchQuery: string;
  /** Prefill registry browser search */
  browserSearchQuery: string;
  /** Registry filter tab */
  browserFilterTab: "all" | "installed" | "not-installed";
  /** Selected registry plugin id */
  browserSelectedId: string | null;
}

declare global {
  interface Window {
    __PHASE7_FIXTURE__?: Phase7FixtureState;
  }
}

export const DEFAULT_FIXTURE: Phase7FixtureState = {
  scene: "settings-extensions-main-desktop-light",
  theme: "light",
  communityPluginsEnabled: false,
  pluginLoadMode: "ready",
  storeMode: "ready",
  emptyInstalledPlugins: false,
  expandedPluginId: null,
  openSafetyDialog: false,
  openPermissionPluginId: null,
  openBrowser: false,
  searchQuery: "",
  browserSearchQuery: "",
  browserFilterTab: "all",
  browserSelectedId: "markdown-export-pack",
};

export function readFixture(): Phase7FixtureState {
  if (typeof window !== "undefined" && window.__PHASE7_FIXTURE__) {
    return { ...DEFAULT_FIXTURE, ...window.__PHASE7_FIXTURE__ };
  }
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const scene = (params.get("scene") as Phase7SceneId) || DEFAULT_FIXTURE.scene;
    const theme = (params.get("theme") as "light" | "dark") || "light";
    return { ...DEFAULT_FIXTURE, scene, theme };
  }
  return DEFAULT_FIXTURE;
}

/** Synthetic demo copy only — never real secrets, hostnames, or marketplace traffic. */
export const FIXTURE_COPY = {
  communityPluginName: "Sample Timer Pack",
  communityPluginAuthor: "Demo Publisher",
  communityPluginDescription:
    "Offline demo registry entry for Extensions browser capture. Not a live package.",
  communityLongDescription:
    "Deterministic fixture package used only for Phase 7 legacy visual authorities. Install, search, and detail chrome are rendered offline with no marketplace network dependency.",
  registryError: "Plugin registry is temporarily unavailable",
  extensionsLoadError: "Extensions could not be loaded.",
  panelTitle: "Automation Panel",
  panelHeading: "Queued actions",
  statusReady: "Ready",
  statusRunning: "24:12",
};

export const POMODORO_SETTINGS = [
  {
    id: "workMinutes",
    name: "Work Duration",
    type: "number" as const,
    default: 25,
    min: 1,
    max: 120,
  },
  {
    id: "breakMinutes",
    name: "Break Duration",
    type: "number" as const,
    default: 5,
    min: 1,
    max: 60,
  },
  {
    id: "longBreakMinutes",
    name: "Long Break Duration",
    type: "number" as const,
    default: 15,
    min: 1,
    max: 60,
  },
  {
    id: "sessionsBeforeLongBreak",
    name: "Sessions Before Long Break",
    type: "number" as const,
    default: 4,
    min: 1,
    max: 10,
  },
];

export const POMODORO_PERMISSIONS = [
  "task:read",
  "commands",
  "ui:status",
  "ui:view",
  "storage",
  "settings",
];

/** Built-in + one community installed plugin for Settings Extensions list density. */
export function fixtureInstalledPlugins() {
  return [
    {
      id: "pomodoro",
      name: "Pomodoro Timer",
      version: "1.0.0",
      author: "ASF",
      description: "Focus timer with configurable work/break intervals.",
      enabled: true,
      permissions: [...POMODORO_PERMISSIONS],
      settings: [...POMODORO_SETTINGS],
      builtin: true,
      icon: "timer",
    },
    {
      id: "calendar",
      name: "Calendar",
      version: "1.0.0",
      author: "ASF",
      description: "Calendar view for scheduled tasks.",
      enabled: true,
      permissions: ["task:read", "task:write", "project:read", "ui:view"],
      settings: [],
      builtin: true,
      icon: "calendar",
    },
    {
      id: "stats",
      name: "Stats",
      version: "1.0.0",
      author: "ASF",
      description: "Productivity statistics and charts.",
      enabled: false,
      permissions: ["task:read", "ui:view"],
      settings: [],
      builtin: true,
      icon: "bar-chart-3",
    },
    {
      id: "focus-helper",
      name: "Focus Helper",
      version: "1.0.0",
      author: "ASF",
      description: "Built-in helper used to exercise permission approval chrome.",
      enabled: false,
      permissions: ["task:read", "commands", "ui:status"],
      settings: [],
      builtin: true,
      icon: "target",
    },
    {
      id: "sample-timer",
      name: FIXTURE_COPY.communityPluginName,
      version: "0.3.1",
      author: FIXTURE_COPY.communityPluginAuthor,
      description: FIXTURE_COPY.communityPluginDescription,
      enabled: false,
      permissions: ["task:read", "ui:status", "storage"],
      settings: [
        {
          id: "label",
          name: "Status Label",
          type: "text" as const,
          default: "Demo",
          description: "Text shown in the status item",
        },
      ],
      builtin: false,
      icon: "puzzle",
    },
  ];
}

export function fixtureStorePlugins() {
  // First row is intentionally not installed so desktop auto-select shows Install chrome.
  return [
    {
      id: "markdown-export-pack",
      name: "Markdown Export Pack",
      description: "Offline demo export helper listed in the registry browser.",
      author: "Demo Publisher",
      version: "1.2.0",
      repository: "https://example.invalid/junban-plugins/markdown-export-pack",
      downloadUrl: "https://example.invalid/packages/markdown-export-pack.jbp",
      sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      tags: ["export", "markdown", "demo"],
      minJunbanVersion: "0.1.0",
      icon: "list",
      downloads: 640,
      longDescription:
        "Deterministic registry row used for list/search/filter and not-installed detail/install chrome.",
      permissions: ["task:read", "storage"],
    },
    {
      id: "sample-timer",
      name: FIXTURE_COPY.communityPluginName,
      description: FIXTURE_COPY.communityPluginDescription,
      author: FIXTURE_COPY.communityPluginAuthor,
      version: "0.3.1",
      repository: "https://example.invalid/junban-plugins/sample-timer",
      downloadUrl: "https://example.invalid/packages/sample-timer.jbp",
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      tags: ["timer", "productivity", "demo"],
      minJunbanVersion: "0.1.0",
      icon: "puzzle",
      downloads: 1280,
      longDescription: FIXTURE_COPY.communityLongDescription,
      permissions: ["task:read", "ui:status", "storage"],
    },
    {
      id: "status-badge-kit",
      name: "Status Badge Kit",
      description: "Not-installed demo package for filter chrome.",
      author: "Demo Publisher",
      version: "0.1.4",
      repository: "https://example.invalid/junban-plugins/status-badge-kit",
      downloadUrl: "https://example.invalid/packages/status-badge-kit.jbp",
      sha256: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      tags: ["status", "ui", "demo"],
      minJunbanVersion: "0.1.0",
      icon: "zap",
      downloads: 96,
      longDescription: "Third registry row kept uninstalled for Not Installed filter authority.",
      permissions: ["ui:status"],
    },
  ];
}

export function fixturePomodoroStructuredContent() {
  return {
    layout: "center" as const,
    elements: [
      { type: "text" as const, value: "Work", variant: "subtitle" as const },
      { type: "spacer" as const, size: "sm" as const },
      { type: "text" as const, value: "25:00", variant: "mono" as const },
      { type: "spacer" as const, size: "sm" as const },
      {
        type: "progress" as const,
        value: 0,
        max: 1500,
        color: "accent" as const,
      },
      { type: "spacer" as const, size: "sm" as const },
      {
        type: "row" as const,
        gap: "md" as const,
        justify: "center" as const,
        elements: [
          {
            type: "button" as const,
            label: "Start",
            commandId: "pomodoro:start",
            variant: "primary" as const,
          },
          {
            type: "button" as const,
            label: "Reset",
            commandId: "pomodoro:reset",
            variant: "secondary" as const,
          },
          {
            type: "button" as const,
            label: "Skip",
            commandId: "pomodoro:skip",
            variant: "ghost" as const,
          },
        ],
      },
      { type: "spacer" as const, size: "sm" as const },
      {
        type: "row" as const,
        gap: "sm" as const,
        justify: "center" as const,
        elements: [
          {
            type: "badge" as const,
            value: "Session 1/4",
            color: "default" as const,
          },
          {
            type: "badge" as const,
            value: "Idle",
            color: "default" as const,
          },
        ],
      },
    ],
  };
}

export function fixtureDeclarativePanelContent() {
  return {
    layout: "stack" as const,
    elements: [
      {
        type: "text" as const,
        value: FIXTURE_COPY.panelHeading,
        variant: "subtitle" as const,
      },
      {
        type: "text" as const,
        value: "3 tasks ready for the next focus block.",
        variant: "body" as const,
      },
      { type: "divider" as const },
      {
        type: "row" as const,
        gap: "sm" as const,
        justify: "start" as const,
        elements: [
          {
            type: "button" as const,
            label: "Run plan",
            commandId: "example:run-plan",
            variant: "primary" as const,
          },
          {
            type: "button" as const,
            label: "Dismiss",
            commandId: "example:dismiss",
            variant: "ghost" as const,
          },
        ],
      },
      {
        type: "badge" as const,
        value: "Declarative actions",
        color: "accent" as const,
      },
    ],
  };
}
