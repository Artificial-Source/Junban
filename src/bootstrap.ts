import path from "node:path";
import fs from "node:fs";
import { getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { TaskService } from "./core/tasks.js";
import { ProjectService } from "./core/projects.js";
import { TagService } from "./core/tags.js";
import { EventBus } from "./core/event-bus.js";
import { PluginLoader } from "./plugins/loader.js";
import { PluginSettingsManager } from "./plugins/settings.js";
import { CommandRegistry } from "./plugins/command-registry.js";
import { UIRegistry } from "./plugins/ui-registry.js";
import { ChatManager } from "./ai/chat.js";
import { createDefaultRegistry } from "./ai/provider.js";
import type { AIProviderRegistry } from "./ai/provider-registry.js";
import { loadEnv } from "./config/env.js";
import { SQLiteBackend } from "./storage/sqlite-backend.js";
import { MarkdownBackend } from "./storage/markdown-backend.js";
import type { IStorage } from "./storage/interface.js";

export interface AppServices {
  taskService: TaskService;
  projectService: ProjectService;
  tagService: TagService;
  eventBus: EventBus;
  pluginLoader: PluginLoader;
  settingsManager: PluginSettingsManager;
  commandRegistry: CommandRegistry;
  uiRegistry: UIRegistry;
  chatManager: ChatManager;
  storage: IStorage;
  aiProviderRegistry: AIProviderRegistry;
}

export function bootstrap(dbPath?: string): AppServices {
  const env = loadEnv();
  let storage: IStorage;

  if (env.STORAGE_MODE === "markdown") {
    const mdPath = path.resolve(env.MARKDOWN_PATH);
    fs.mkdirSync(mdPath, { recursive: true });
    const backend = new MarkdownBackend(mdPath);
    backend.initialize();
    storage = backend;
  } else {
    const resolvedPath = dbPath ?? env.DB_PATH;

    // Ensure data directory exists
    const dir = path.dirname(resolvedPath);
    if (dir !== "." && dir !== ":memory:") {
      fs.mkdirSync(dir, { recursive: true });
    }

    const db = getDb(resolvedPath);
    runMigrations(db);
    storage = new SQLiteBackend(db);
  }

  const tagService = new TagService(storage);
  const projectService = new ProjectService(storage);

  const eventBus = new EventBus();
  const taskService = new TaskService(storage, tagService, eventBus);

  const settingsManager = new PluginSettingsManager(storage);
  const commandRegistry = new CommandRegistry();
  const uiRegistry = new UIRegistry();
  const chatManager = new ChatManager();
  const aiProviderRegistry = createDefaultRegistry();

  const pluginDir = path.resolve(env.PLUGIN_DIR);
  const pluginLoader = new PluginLoader(pluginDir, {
    taskService,
    eventBus,
    settingsManager,
    commandRegistry,
    uiRegistry,
    queries: storage,
    aiProviderRegistry,
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
    chatManager,
    storage,
    aiProviderRegistry,
  };
}
