import type { ViteDevServer } from "vite";
import type { GetServices } from "./types.js";
import { registerMiscRoutes } from "./misc.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerTemplateRoutes } from "./templates.js";
import { registerTagRoutes } from "./tags.js";
import { registerProjectRoutes } from "./projects.js";
import { registerSectionRoutes } from "./sections.js";
import { registerCommentRoutes } from "./comments.js";
import { registerPluginRoutes } from "./plugins.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerStatsRoutes } from "./stats.js";
import { registerAIRoutes } from "./ai.js";
import { registerVoiceRoutes } from "./voice.js";

/**
 * Register all API routes on the Vite dev server.
 * Order matters — more specific routes must be registered before generic ones.
 */
export function registerRoutes(server: ViteDevServer, getServices: GetServices): void {
  registerMiscRoutes(server, getServices);
  registerTaskRoutes(server, getServices);
  registerTemplateRoutes(server, getServices);
  registerTagRoutes(server, getServices);
  registerProjectRoutes(server, getServices);
  registerSectionRoutes(server, getServices);
  registerCommentRoutes(server, getServices);
  registerPluginRoutes(server, getServices);
  registerSettingsRoutes(server, getServices);
  registerStatsRoutes(server, getServices);
  registerAIRoutes(server, getServices);
  registerVoiceRoutes(server, getServices);
}
