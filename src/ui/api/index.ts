import * as tasks from "./tasks.js";
import * as templates from "./templates.js";
import * as projects from "./projects.js";
import * as sections from "./sections.js";
import * as comments from "./comments.js";
import * as stats from "./stats.js";
import * as plugins from "./plugins.js";
import * as settings from "./settings.js";
import * as desktopServer from "./desktop-server.js";

export const api = {
  ...tasks,
  ...templates,
  ...projects,
  ...sections,
  ...comments,
  ...stats,
  ...plugins,
  ...settings,
  ...desktopServer,
};

// Re-export all interfaces
export type {
  PluginInfo,
  SettingDefinitionInfo,
  PluginCommandInfo,
  StatusBarItemInfo,
  PanelInfo,
  ViewInfo,
  StorePluginInfo,
} from "./plugins.js";
