import { createWebDb } from "./db/client-web.js";
import { runWebMigrations } from "./db/migrate-web.js";
import { TaskService } from "./core/tasks.js";
import { ProjectService } from "./core/projects.js";
import { TagService } from "./core/tags.js";
import { EventBus } from "./core/event-bus.js";
import { ChatManager } from "./ai/chat.js";
import { createDefaultRegistry } from "./ai/provider.js";
import type { AIProviderRegistry } from "./ai/provider-registry.js";
import { PluginSettingsManager } from "./plugins/settings.js";
import { CommandRegistry } from "./plugins/command-registry.js";
import { UIRegistry } from "./plugins/ui-registry.js";
import { loadDbFile, saveDbFile } from "./db/persistence.js";
import { SQLiteBackend } from "./storage/sqlite-backend.js";
import type { IStorage } from "./storage/interface.js";

// Web/Tauri mode always uses SQLite (sql.js in browser has no filesystem access).
// Markdown storage requires Node.js for file I/O.

export interface WebAppServices {
  taskService: TaskService;
  projectService: ProjectService;
  tagService: TagService;
  eventBus: EventBus;
  settingsManager: PluginSettingsManager;
  commandRegistry: CommandRegistry;
  uiRegistry: UIRegistry;
  chatManager: ChatManager;
  storage: IStorage;
  aiProviderRegistry: AIProviderRegistry;
  save: () => void;
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as unknown as T;
}

export async function bootstrapWeb(): Promise<WebAppServices> {
  const existingData = await loadDbFile();
  const { db, sqlite } = await createWebDb(existingData ?? undefined);
  runWebMigrations(sqlite);

  const storage: IStorage = new SQLiteBackend(db);
  const tagService = new TagService(storage);
  const projectService = new ProjectService(storage);
  const eventBus = new EventBus();
  const taskService = new TaskService(storage, tagService, eventBus);
  const settingsManager = new PluginSettingsManager(storage);
  const commandRegistry = new CommandRegistry();
  const uiRegistry = new UIRegistry();
  const chatManager = new ChatManager();
  const aiProviderRegistry = createDefaultRegistry();

  // Auto-save DB to Tauri FS after mutations (debounced)
  const save = debounce(() => {
    saveDbFile(sqlite.export()).catch((err) =>
      console.error("[bootstrap-web] Failed to save DB:", err),
    );
  }, 500);

  eventBus.on("task:create", save);
  eventBus.on("task:complete", save);
  eventBus.on("task:update", save);
  eventBus.on("task:delete", save);

  // Flush DB to disk on window close
  window.addEventListener("beforeunload", () => {
    saveDbFile(sqlite.export()).catch(() => {});
  });

  return {
    taskService,
    projectService,
    tagService,
    eventBus,
    settingsManager,
    commandRegistry,
    uiRegistry,
    chatManager,
    storage,
    aiProviderRegistry,
    save,
  };
}
