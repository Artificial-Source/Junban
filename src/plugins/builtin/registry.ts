import { PluginManifest, type SettingDefinition, type Permission } from "../types.js";
import type { Plugin } from "../lifecycle.js";
import pomodoroManifestJson from "./pomodoro/manifest.json" with { type: "json" };
import timeblockingManifestJson from "./timeblocking/manifest.json" with { type: "json" };
import statsManifestJson from "./stats/manifest.json" with { type: "json" };
import somedayManifestJson from "./someday/manifest.json" with { type: "json" };
import completedManifestJson from "./completed/manifest.json" with { type: "json" };
import cancelledManifestJson from "./cancelled/manifest.json" with { type: "json" };
import matrixManifestJson from "./matrix/manifest.json" with { type: "json" };
import calendarManifestJson from "./calendar/manifest.json" with { type: "json" };
import dopamineMenuManifestJson from "./dopamine-menu/manifest.json" with { type: "json" };

export const BUILTIN_MANIFESTS = [
  PluginManifest.parse(pomodoroManifestJson),
  PluginManifest.parse(timeblockingManifestJson),
  PluginManifest.parse(statsManifestJson),
  PluginManifest.parse(somedayManifestJson),
  PluginManifest.parse(completedManifestJson),
  PluginManifest.parse(cancelledManifestJson),
  PluginManifest.parse(matrixManifestJson),
  PluginManifest.parse(calendarManifestJson),
  PluginManifest.parse(dopamineMenuManifestJson),
] as const;

export const BUILTIN_PLUGIN_LOADERS: Record<string, () => Promise<{ default: new () => Plugin }>> = {
  pomodoro: () => import("./pomodoro/index.js"),
  timeblocking: () => import("./timeblocking/index.js"),
  stats: () => import("./stats/index.js"),
  someday: () => import("./someday/index.js"),
  completed: () => import("./completed/index.js"),
  cancelled: () => import("./cancelled/index.js"),
  matrix: () => import("./matrix/index.js"),
  calendar: () => import("./calendar/index.js"),
  "dopamine-menu": () => import("./dopamine-menu/index.js"),
};

export const DIRECT_PLUGIN_POLICIES: Record<
  string,
  { permissions: Permission[]; settings: SettingDefinition[] }
> = Object.fromEntries(
  BUILTIN_MANIFESTS.map((manifest) => [
    manifest.id,
    {
      permissions: [...(manifest.permissions as Permission[])],
      settings: [...manifest.settings],
    },
  ]),
);

export const LEGACY_BUILTIN_VIEW_IDS: Record<string, string> = {
  calendar: "calendar:calendar",
  completed: "completed:completed",
  cancelled: "cancelled:cancelled",
  someday: "someday:someday",
  stats: "stats:stats",
  matrix: "matrix:matrix",
  "dopamine-menu": "dopamine-menu:dopamine-menu",
};
