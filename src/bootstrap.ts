import path from "node:path";
import fs from "node:fs";
import { getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createQueries } from "./db/queries.js";
import { TaskService } from "./core/tasks.js";
import { ProjectService } from "./core/projects.js";
import { TagService } from "./core/tags.js";
import { EventBus } from "./core/event-bus.js";
import { PluginLoader } from "./plugins/loader.js";
import { PluginSettingsManager } from "./plugins/settings.js";
import { CommandRegistry } from "./plugins/command-registry.js";
import { UIRegistry } from "./plugins/ui-registry.js";
import { loadEnv } from "./config/env.js";

export interface AppServices {
  taskService: TaskService;
  projectService: ProjectService;
  tagService: TagService;
  eventBus: EventBus;
  pluginLoader: PluginLoader;
  settingsManager: PluginSettingsManager;
  commandRegistry: CommandRegistry;
  uiRegistry: UIRegistry;
}

export function bootstrap(dbPath?: string): AppServices {
  const env = loadEnv();
  const resolvedPath = dbPath ?? env.DB_PATH;

  // Ensure data directory exists
  const dir = path.dirname(resolvedPath);
  if (dir !== "." && dir !== ":memory:") {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = getDb(resolvedPath);
  runMigrations(db);

  const queries = createQueries(db);
  const tagService = new TagService(queries);
  const projectService = new ProjectService(queries);

  const eventBus = new EventBus();
  const taskService = new TaskService(queries, tagService, eventBus);

  const settingsManager = new PluginSettingsManager(queries);
  const commandRegistry = new CommandRegistry();
  const uiRegistry = new UIRegistry();

  const pluginDir = path.resolve(env.PLUGIN_DIR);
  const pluginLoader = new PluginLoader(pluginDir, {
    taskService,
    eventBus,
    settingsManager,
    commandRegistry,
    uiRegistry,
  });

  return {
    taskService,
    projectService,
    tagService,
    eventBus,
    pluginLoader,
    settingsManager,
    commandRegistry,
    uiRegistry,
  };
}
