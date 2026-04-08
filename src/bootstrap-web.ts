import { createWebDb } from "./db/client-web.js";
import { runWebMigrations } from "./db/migrate-web.js";
import { TaskService } from "./core/tasks.js";
import { ProjectService } from "./core/projects.js";
import { TagService } from "./core/tags.js";
import { TemplateService } from "./core/templates.js";
import { SectionService } from "./core/sections.js";
import { StatsService } from "./core/stats.js";
import { EventBus } from "./core/event-bus.js";
import type { ChatManager } from "./ai/chat.js";
import type { LLMProviderRegistry } from "./ai/provider/registry.js";
import type { ToolRegistry } from "./ai/tools/registry.js";
import { PluginSettingsManager } from "./plugins/settings.js";
import { CommandRegistry } from "./plugins/command-registry.js";
import { UIRegistry } from "./plugins/ui-registry.js";
import { loadDbFile, saveDbFile } from "./db/persistence.js";
import { SQLiteBackend } from "./storage/sqlite-backend.js";
import type { IStorage } from "./storage/interface.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger("bootstrap-web");

// Web/Tauri mode always uses SQLite (sql.js in browser has no filesystem access).
// Markdown storage requires Node.js for file I/O.

export interface WebAppServices {
  taskService: TaskService;
  projectService: ProjectService;
  tagService: TagService;
  templateService: TemplateService;
  sectionService: SectionService;
  statsService: StatsService;
  eventBus: EventBus;
  settingsManager: PluginSettingsManager;
  commandRegistry: CommandRegistry;
  uiRegistry: UIRegistry;
  storage: IStorage;
  getAIRuntime: () => Promise<WebAIRuntime>;
  save: () => void;
}

export interface WebAIRuntime {
  chatManager: ChatManager;
  aiProviderRegistry: LLMProviderRegistry;
  toolRegistry: ToolRegistry;
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as unknown as T;
}

export async function bootstrapWeb(): Promise<WebAppServices> {
  logger.info("Web bootstrap starting");
  const existingData = await loadDbFile();
  const { db, sqlite } = await createWebDb(existingData ?? undefined);
  runWebMigrations(sqlite);
  logger.info("Web SQLite initialized", { hasExistingData: !!existingData });

  const storage: IStorage = new SQLiteBackend(db);
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
  let aiRuntime: WebAIRuntime | null = null;
  let aiRuntimePending: Promise<WebAIRuntime> | null = null;

  const getAIRuntime = async (): Promise<WebAIRuntime> => {
    if (aiRuntime) return aiRuntime;
    if (aiRuntimePending) return aiRuntimePending;

    aiRuntimePending = (async () => {
      const { ChatManager } = await import("./ai/chat.js");
      const { createDefaultRegistry } = await import("./ai/provider.js");
      const { createDefaultToolRegistry } = await import("./ai/tool-registry.js");
      aiRuntime = {
        chatManager: new ChatManager(),
        aiProviderRegistry: createDefaultRegistry(),
        toolRegistry: createDefaultToolRegistry(),
      };
      aiRuntimePending = null;
      return aiRuntime;
    })();

    return aiRuntimePending;
  };

  // Auto-save DB to Tauri FS after mutations (debounced)
  const save = debounce(() => {
    saveDbFile(sqlite.export()).catch((err) =>
      logger.error("Failed to save DB", { error: String(err) }),
    );
  }, 500);

  eventBus.on("task:create", save);
  eventBus.on("task:complete", save);
  eventBus.on("task:update", save);
  eventBus.on("task:delete", save);
  eventBus.on("task:reorder", save);
  eventBus.on("section:create", save);
  eventBus.on("section:update", save);
  eventBus.on("section:delete", save);
  eventBus.on("section:reorder", save);

  // Flush DB to disk on window close
  window.addEventListener("beforeunload", () => {
    saveDbFile(sqlite.export()).catch((err: unknown) => {
      console.error("[bootstrap-web] Failed to persist DB to OPFS:", err);
    });
  });

  return {
    taskService,
    projectService,
    tagService,
    templateService,
    sectionService,
    statsService,
    eventBus,
    settingsManager,
    commandRegistry,
    uiRegistry,
    storage,
    getAIRuntime,
    save,
  };
}
