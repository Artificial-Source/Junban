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
import type { Permission } from "./plugins/types.js";
import { ToolRegistry } from "./ai/tools/registry.js";
import { loadDbFile, saveDbFile } from "./db/persistence.js";
import { SQLiteBackend } from "./storage/sqlite-backend.js";
import type { IStorage } from "./storage/interface.js";
import { createLogger } from "./utils/logger.js";
import type { EventName, EventCallback } from "./core/event-bus.js";
import { BUILTIN_MANIFESTS, BUILTIN_PLUGIN_LOADERS } from "./plugins/builtin/registry.js";
import { measureAsync } from "./utils/perf.js";

const logger = createLogger("bootstrap-web");
const LEGACY_AUTO_ENABLED_PLUGIN_IDS = new Set(["pomodoro", "timeblocking"]);

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
  approveBuiltinPlugin: (pluginId: string, permissions: string[]) => Promise<void>;
  revokeBuiltinPlugin: (pluginId: string) => Promise<void>;
  toggleBuiltinPlugin: (pluginId: string) => Promise<void>;
  getAIRuntime: () => Promise<WebAIRuntime>;
  save: () => void;
}

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
  return measureAsync("junban:web-services-bootstrap", async () => {
    logger.info("Web bootstrap starting");
    const existingData = await loadDbFile();
    const { db, sqlite } = await createWebDb(existingData ?? undefined);
    await runWebMigrations(sqlite);
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
    const pluginListeners = new Map<
      string,
      Array<{ event: EventName; callback: (...args: unknown[]) => void }>
    >();
    const pluginInstances = new Map<string, Plugin>();

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

    const trackPluginListener = <E extends EventName>(
      pluginId: string,
      event: E,
      callback: EventCallback<E>,
    ): void => {
      const listeners = pluginListeners.get(pluginId) ?? [];
      listeners.push({ event, callback: callback as (...args: unknown[]) => void });
      pluginListeners.set(pluginId, listeners);
    };

    const removePluginListeners = (pluginId: string): void => {
      const listeners = pluginListeners.get(pluginId);
      if (!listeners) return;

      for (const { event, callback } of listeners) {
        eventBus.off(event, callback);
      }
      pluginListeners.delete(pluginId);
    };

    const registerTaskHooks = (
      pluginId: string,
      plugin: Plugin,
      permissions: Permission[],
    ): void => {
      if (!permissions.includes("task:read")) {
        return;
      }

      if (typeof plugin.onTaskCreate === "function") {
        const callback: EventCallback<"task:create"> = (task) => {
          void Promise.resolve(plugin.onTaskCreate?.(task)).catch((err: unknown) => {
            logger.error("Built-in plugin hook failed in web bootstrap", {
              pluginId,
              hookName: "onTaskCreate",
              error: err instanceof Error ? err.message : String(err),
            });
          });
        };
        eventBus.on("task:create", callback);
        trackPluginListener(pluginId, "task:create", callback);
      }

      if (typeof plugin.onTaskComplete === "function") {
        const callback: EventCallback<"task:complete"> = (task) => {
          void Promise.resolve(plugin.onTaskComplete?.(task)).catch((err: unknown) => {
            logger.error("Built-in plugin hook failed in web bootstrap", {
              pluginId,
              hookName: "onTaskComplete",
              error: err instanceof Error ? err.message : String(err),
            });
          });
        };
        eventBus.on("task:complete", callback);
        trackPluginListener(pluginId, "task:complete", callback);
      }

      if (typeof plugin.onTaskUpdate === "function") {
        const callback: EventCallback<"task:update"> = (payload) => {
          void Promise.resolve(plugin.onTaskUpdate?.(payload.task, payload.changes)).catch(
            (err: unknown) => {
              logger.error("Built-in plugin hook failed in web bootstrap", {
                pluginId,
                hookName: "onTaskUpdate",
                error: err instanceof Error ? err.message : String(err),
              });
            },
          );
        };
        eventBus.on("task:update", callback);
        trackPluginListener(pluginId, "task:update", callback);
      }

      if (typeof plugin.onTaskDelete === "function") {
        const callback: EventCallback<"task:delete"> = (task) => {
          void Promise.resolve(plugin.onTaskDelete?.(task)).catch((err: unknown) => {
            logger.error("Built-in plugin hook failed in web bootstrap", {
              pluginId,
              hookName: "onTaskDelete",
              error: err instanceof Error ? err.message : String(err),
            });
          });
        };
        eventBus.on("task:delete", callback);
        trackPluginListener(pluginId, "task:delete", callback);
      }
    };

    const unloadBuiltinPlugin = async (pluginId: string): Promise<void> => {
      const builtinPlugin = builtinPlugins.find((plugin) => plugin.id === pluginId);
      const instance = pluginInstances.get(pluginId);
      if (!builtinPlugin || !builtinPlugin.enabled || !instance) {
        return;
      }

      try {
        await instance.onUnload();
      } catch (err: unknown) {
        logger.error("Failed to unload built-in plugin in web bootstrap", {
          pluginId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      removePluginListeners(pluginId);
      commandRegistry.unregisterByPlugin(pluginId);
      uiRegistry.removeByPlugin(pluginId);
      aiRuntime?.aiProviderRegistry.unregisterByPlugin(pluginId);
      pluginToolRegistry.unregisterBySource(pluginId);
      aiRuntime?.toolRegistry.unregisterBySource(pluginId);
      pluginInstances.delete(pluginId);
      builtinPlugin.enabled = false;
    };

    const loadBuiltinPlugin = async (pluginId: string): Promise<void> => {
      const builtinPlugin = builtinPlugins.find((plugin) => plugin.id === pluginId);
      if (!builtinPlugin || builtinPlugin.enabled) {
        return;
      }

      const approvedPermissions = storage.getPluginPermissions(pluginId);
      if (approvedPermissions === null) {
        return;
      }

      const loader = BUILTIN_PLUGIN_LOADERS[pluginId];
      if (!loader) {
        logger.warn("No built-in plugin loader registered", { pluginId });
        return;
      }

      try {
        await settingsManager.load(pluginId);

        await measureAsync(
          "junban:builtin-plugin-load",
          async () => {
            const module = await loader();
            const PluginClass = module.default;
            const plugin = new PluginClass();
            const api = createPluginAPI({
              pluginId,
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
              onEventListenerRegistered: (event, callback) => {
                trackPluginListener(pluginId, event, callback as EventCallback<EventName>);
              },
            });

            plugin.app = api;
            plugin.settings = api.settings;
            await plugin.onLoad();
            registerTaskHooks(pluginId, plugin, builtinPlugin.permissions);
            pluginInstances.set(pluginId, plugin);
            builtinPlugin.enabled = true;

            if (aiRuntime) {
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
            }
          },
          { pluginId },
        );
      } catch (err: unknown) {
        removePluginListeners(pluginId);
        commandRegistry.unregisterByPlugin(pluginId);
        uiRegistry.removeByPlugin(pluginId);
        pluginToolRegistry.unregisterBySource(pluginId);
        pluginInstances.delete(pluginId);
        builtinPlugin.enabled = false;
        logger.error("Failed to initialize built-in plugin in web bootstrap", {
          pluginId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const approveBuiltinPlugin = async (pluginId: string, permissions: string[]): Promise<void> => {
      storage.setPluginPermissions(pluginId, permissions);
      await loadBuiltinPlugin(pluginId);
      save();
    };

    const revokeBuiltinPlugin = async (pluginId: string): Promise<void> => {
      await unloadBuiltinPlugin(pluginId);
      storage.deletePluginPermissions(pluginId);
      save();
    };

    const toggleBuiltinPlugin = async (pluginId: string): Promise<void> => {
      const builtinPlugin = builtinPlugins.find((plugin) => plugin.id === pluginId);
      if (!builtinPlugin) {
        throw new Error("Plugin not found");
      }

      if (builtinPlugin.enabled) {
        await revokeBuiltinPlugin(pluginId);
        return;
      }

      await approveBuiltinPlugin(pluginId, builtinPlugin.permissions);
    };

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
      if (
        existingData &&
        storage.getPluginPermissions(builtinPlugin.id) === null &&
        LEGACY_AUTO_ENABLED_PLUGIN_IDS.has(builtinPlugin.id)
      ) {
        storage.setPluginPermissions(builtinPlugin.id, builtinPlugin.permissions);
        save();
      }
    }

    await Promise.all(builtinPlugins.map((builtinPlugin) => loadBuiltinPlugin(builtinPlugin.id)));

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
      approveBuiltinPlugin,
      revokeBuiltinPlugin,
      toggleBuiltinPlugin,
      getAIRuntime,
      save,
    };
  });
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
