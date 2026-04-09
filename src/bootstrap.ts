import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { TaskService } from "./core/tasks.js";
import { ProjectService } from "./core/projects.js";
import { TagService } from "./core/tags.js";
import { TemplateService } from "./core/templates.js";
import { SectionService } from "./core/sections.js";
import { StatsService } from "./core/stats.js";
import { EventBus } from "./core/event-bus.js";
import { PluginLoader } from "./plugins/loader.js";
import { PluginSettingsManager } from "./plugins/settings.js";
import { CommandRegistry } from "./plugins/command-registry.js";
import { UIRegistry } from "./plugins/ui-registry.js";
import { ChatManager } from "./ai/chat.js";
import { createDefaultRegistry } from "./ai/provider-node.js";
import { createDefaultToolRegistry } from "./ai/tool-registry.js";
import type { LLMProviderRegistry } from "./ai/provider/registry.js";
import type { ToolRegistry } from "./ai/tools/registry.js";
import { loadEnv } from "./config/env.js";
import { SQLiteBackend } from "./storage/sqlite-backend.js";
import { MarkdownBackend } from "./storage/markdown-backend.js";
import type { IStorage } from "./storage/interface.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger("bootstrap");

export interface AppServices {
  taskService: TaskService;
  projectService: ProjectService;
  tagService: TagService;
  templateService: TemplateService;
  sectionService: SectionService;
  statsService: StatsService;
  eventBus: EventBus;
  pluginLoader: PluginLoader;
  settingsManager: PluginSettingsManager;
  commandRegistry: CommandRegistry;
  uiRegistry: UIRegistry;
  chatManager: ChatManager;
  storage: IStorage;
  aiProviderRegistry: LLMProviderRegistry;
  toolRegistry: ToolRegistry;
}

export function bootstrap(): AppServices {
  const env = loadEnv();
  let storage: IStorage;

  logger.info("Initializing storage", { mode: env.STORAGE_MODE });

  if (env.STORAGE_MODE === "markdown") {
    const mdPath = path.resolve(env.MARKDOWN_PATH);
    fs.mkdirSync(mdPath, { recursive: true });
    const backend = new MarkdownBackend(mdPath);
    backend.initialize();
    storage = backend;
    logger.info("Markdown backend initialized", { path: mdPath });
  } else {
    const resolvedPath = env.DB_PATH;

    // Ensure data directory exists
    const dir = path.dirname(resolvedPath);
    if (dir !== "." && dir !== ":memory:") {
      fs.mkdirSync(dir, { recursive: true });
    }

    const db = getDb(resolvedPath);
    runMigrations(db);
    storage = new SQLiteBackend(db);
    logger.info("SQLite backend initialized", { path: resolvedPath });
  }

  const tagService = new TagService(storage);
  const projectService = new ProjectService(storage);

  const eventBus = new EventBus();
  const taskService = new TaskService(storage, tagService, eventBus);
  const templateService = new TemplateService(storage, taskService);
  const sectionService = new SectionService(storage, eventBus);
  const statsService = new StatsService(storage);

  const settingsManager = new PluginSettingsManager(storage);
  const commandRegistry = new CommandRegistry();
  const uiRegistry = new UIRegistry();
  const chatManager = new ChatManager();
  const aiProviderRegistry = createDefaultRegistry();
  const toolRegistry = createDefaultToolRegistry();

  logger.debug("Services created");

  const pluginDir = path.resolve(env.PLUGIN_DIR);
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const builtinDir = path.join(__dirname, "plugins", "builtin");
  const pluginLoader = new PluginLoader(
    pluginDir,
    {
      taskService,
      projectService,
      tagService,
      eventBus,
      settingsManager,
      commandRegistry,
      uiRegistry,
      queries: storage,
      aiProviderRegistry,
      toolRegistry,
    },
    builtinDir,
  );

  return {
    taskService,
    projectService,
    tagService,
    templateService,
    sectionService,
    statsService,
    eventBus,
    pluginLoader,
    settingsManager,
    commandRegistry,
    uiRegistry,
    chatManager,
    storage,
    aiProviderRegistry,
    toolRegistry,
  };
}
