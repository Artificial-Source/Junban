import { createWebDb } from "./db/client-web.js";
import { runWebMigrations } from "./db/migrate-web.js";
import { TaskService } from "./core/tasks.js";
import { ProjectService } from "./core/projects.js";
import { TagService } from "./core/tags.js";
import { TemplateService } from "./core/templates.js";
import { SectionService } from "./core/sections.js";
import { StatsService } from "./core/stats.js";
import { EventBus } from "./core/event-bus.js";
import type { WebAIRuntime } from "./bootstrap-web-ai-runtime.js";
import { PluginSettingsManager } from "./plugins/settings.js";
import { CommandRegistry } from "./plugins/command-registry.js";
import { UIRegistry } from "./plugins/ui-registry.js";
import { createPluginAPI } from "./plugins/api.js";
import { Plugin } from "./plugins/lifecycle.js";
import { PluginManifest } from "./plugins/types.js";
import type { Permission } from "./plugins/types.js";
import { ToolRegistry } from "./ai/tools/registry.js";
import { loadDbFile, saveDbFile } from "./db/persistence.js";
import { SQLiteBackend } from "./storage/sqlite-backend.js";
import type { IStorage } from "./storage/interface.js";
import { createLogger } from "./utils/logger.js";
import pomodoroManifestJson from "./plugins/builtin/pomodoro/manifest.json";
import timeblockingManifestJson from "./plugins/builtin/timeblocking/manifest.json";

const logger = createLogger("bootstrap-web");

function runPluginHook(
  pluginId: string,
  hookName: string,
  callback: () => void | Promise<void>,
): void {
  Promise.resolve()
    .then(callback)
    .catch((err: unknown) => {
      logger.error("Built-in plugin hook failed in web bootstrap", {
        pluginId,
        hookName,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

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
  builtinPlugins: Array<{
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    enabled: boolean;
    permissions: Permission[];
    settings: import("./plugins/types.js").SettingDefinition[];
    builtin: true;
    icon?: string;
  }>;
  getAIRuntime: () => Promise<WebAIRuntime>;
  save: () => void;
}

const BUILTIN_MANIFESTS = [
  PluginManifest.parse(pomodoroManifestJson),
  PluginManifest.parse(timeblockingManifestJson),
] as const;

const BUILTIN_PLUGIN_LOADERS: Record<string, () => Promise<{ default: new () => Plugin }>> = {
  pomodoro: () => import("./plugins/builtin/pomodoro/index.js"),
  timeblocking: () => import("./plugins/builtin/timeblocking/index.js"),
};

let webServices: WebAppServices | null = null;
let webServicesPending: Promise<WebAppServices> | null = null;

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as unknown as T;
}

async function createWebServices(): Promise<WebAppServices> {
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
  const pluginToolRegistry = new ToolRegistry();
  let aiRuntime: WebAIRuntime | null = null;
  let aiRuntimePending: Promise<WebAIRuntime> | null = null;

  const builtinPlugins: WebAppServices["builtinPlugins"] = BUILTIN_MANIFESTS.map((manifest) => ({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description,
    enabled: false,
    permissions: manifest.permissions as Permission[],
    settings: manifest.settings,
    builtin: true,
    icon: manifest.icon,
  }));

  const getAIRuntime = async (): Promise<WebAIRuntime> => {
    if (aiRuntime) return aiRuntime;
    if (aiRuntimePending) return aiRuntimePending;

    aiRuntimePending = (async () => {
      try {
        const { createWebAIRuntime } = await import("./bootstrap-web-ai-runtime.js");
        aiRuntime = await createWebAIRuntime();

        for (const definition of pluginToolRegistry.getDefinitions()) {
          const registered = pluginToolRegistry.get(definition.name);
          if (!registered) continue;
          if (aiRuntime.toolRegistry.has(definition.name)) continue;
          aiRuntime.toolRegistry.register(
            registered.definition,
            registered.executor,
            registered.source,
          );
        }

        return aiRuntime;
      } finally {
        aiRuntimePending = null;
      }
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

  for (const builtinPlugin of builtinPlugins) {
    const loader = BUILTIN_PLUGIN_LOADERS[builtinPlugin.id];
    if (!loader) {
      logger.warn("No built-in plugin loader registered", {
        pluginId: builtinPlugin.id,
      });
      continue;
    }

    try {
      await settingsManager.load(builtinPlugin.id);

      const module = await loader();
      const PluginClass = module.default;
      const plugin = new PluginClass();

      const api = createPluginAPI({
        pluginId: builtinPlugin.id,
        permissions: builtinPlugin.permissions,
        taskService,
        projectService,
        tagService,
        eventBus,
        settingsManager,
        commandRegistry,
        uiRegistry,
        settingDefinitions: builtinPlugin.settings,
        toolRegistry: pluginToolRegistry,
      });

      plugin.app = api;
      plugin.settings = api.settings;
      await plugin.onLoad();

      if (typeof plugin.onTaskCreate === "function") {
        eventBus.on("task:create", (task) =>
          runPluginHook(builtinPlugin.id, "onTaskCreate", () => plugin.onTaskCreate?.(task)),
        );
      }
      if (typeof plugin.onTaskComplete === "function") {
        eventBus.on("task:complete", (task) =>
          runPluginHook(builtinPlugin.id, "onTaskComplete", () => plugin.onTaskComplete?.(task)),
        );
      }
      if (typeof plugin.onTaskUpdate === "function") {
        eventBus.on("task:update", (payload) =>
          runPluginHook(builtinPlugin.id, "onTaskUpdate", () =>
            plugin.onTaskUpdate?.(payload.task, payload.changes),
          ),
        );
      }
      if (typeof plugin.onTaskDelete === "function") {
        eventBus.on("task:delete", (task) =>
          runPluginHook(builtinPlugin.id, "onTaskDelete", () => plugin.onTaskDelete?.(task)),
        );
      }

      builtinPlugin.enabled = true;
    } catch (err) {
      logger.error("Failed to initialize built-in plugin in web bootstrap", {
        pluginId: builtinPlugin.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const flushDbToDisk = () => {
    const bytes = sqlite.export();
    return saveDbFile(bytes).catch((err: unknown) => {
      console.error("[bootstrap-web] Failed to persist DB to OPFS:", err);
    });
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      void flushDbToDisk();
    }
  };

  // Flush DB to disk on window close
  window.addEventListener("beforeunload", () => {
    void flushDbToDisk();
  });
  document.addEventListener("visibilitychange", handleVisibilityChange);

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
    builtinPlugins,
    getAIRuntime,
    save,
  };
}

export async function bootstrapWeb(): Promise<WebAppServices> {
  if (webServices) return webServices;
  if (webServicesPending) return webServicesPending;

  webServicesPending = (async () => {
    try {
      const created = await createWebServices();
      webServices = created;
      return created;
    } finally {
      webServicesPending = null;
    }
  })();

  return webServicesPending;
}
