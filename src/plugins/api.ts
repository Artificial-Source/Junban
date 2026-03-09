import type { Permission, SettingDefinition } from "./types.js";
import { createLogger } from "../utils/logger.js";
import type { CreateTaskInput } from "../core/types.js";
import type { TaskService } from "../core/tasks.js";
import type { EventBus, EventName, EventCallback } from "../core/event-bus.js";
import type { PluginSettingsManager } from "./settings.js";
import type { CommandRegistry } from "./command-registry.js";
import type { UIRegistry, ViewSlot, ViewContentType, PluginComponent } from "./ui-registry.js";
import type { LLMProviderRegistry } from "../ai/provider/registry.js";
import type { ToolRegistry } from "../ai/tools/registry.js";
import type { LLMProviderPlugin } from "../ai/provider/interface.js";
import type { ToolDefinition, ToolExecutor } from "../ai/tools/types.js";

/** Current Plugin API version (semver). */
export const PLUGIN_API_VERSION = "1.1.0";

/** API stability: "stable" means breaking changes require major version bump. */
export const PLUGIN_API_STABILITY = "stable" as const;

export interface PluginAPIOptions {
  pluginId: string;
  permissions: Permission[];
  taskService: TaskService;
  eventBus: EventBus;
  settingsManager: PluginSettingsManager;
  commandRegistry: CommandRegistry;
  uiRegistry: UIRegistry;
  settingDefinitions: SettingDefinition[];
  aiProviderRegistry?: LLMProviderRegistry;
  toolRegistry?: ToolRegistry;
}

/** Accessor bound to a specific plugin for reading/writing settings. */
export interface PluginSettingsAccessor {
  get<T>(key: string): T;
  set(key: string, value: unknown): Promise<void>;
}

export type PluginAPI = ReturnType<typeof createPluginAPI>;

/**
 * Plugin API surface — the controlled interface that plugins interact with.
 * Access is filtered by the plugin's declared permissions.
 */
export function createPluginAPI(options: PluginAPIOptions) {
  const {
    pluginId,
    permissions,
    taskService,
    eventBus,
    settingsManager,
    commandRegistry,
    uiRegistry,
    settingDefinitions,
    aiProviderRegistry,
    toolRegistry,
  } = options;

  const hasPermission = (p: Permission) => permissions.includes(p);

  const checkPermission = (p: Permission, action: string) => {
    if (!hasPermission(p)) {
      throw new Error(`Plugin "${pluginId}" lacks "${p}" permission for: ${action}`);
    }
  };

  return {
    meta: {
      version: PLUGIN_API_VERSION,
      stability: PLUGIN_API_STABILITY,
    },

    tasks: {
      list: hasPermission("task:read")
        ? async () => taskService.list()
        : undefined,
      create: hasPermission("task:write")
        ? async (input: CreateTaskInput) => taskService.create(input)
        : undefined,
    },

    commands: hasPermission("commands")
      ? {
          register: (command: { id: string; name: string; callback: () => void; hotkey?: string }) => {
            commandRegistry.register({
              ...command,
              id: `${pluginId}:${command.id}`,
              pluginId,
            });
          },
        }
      : undefined,

    ui: {
      addSidebarPanel: hasPermission("ui:panel")
        ? (panel: {
            id: string;
            title: string;
            icon: string;
            contentType?: "text" | "react";
            component?: PluginComponent;
            render?: () => string;
          }) => {
            uiRegistry.addPanel({
              ...panel,
              pluginId,
              contentType: panel.contentType ?? "text",
              getContent: panel.render,
            });
          }
        : undefined,
      addView: hasPermission("ui:view")
        ? (view: {
            id: string;
            name: string;
            icon: string;
            slot?: ViewSlot;
            contentType?: ViewContentType;
            component?: PluginComponent;
            render?: () => string;
          }) => {
            uiRegistry.addView({
              ...view,
              pluginId,
              slot: view.slot ?? "tools",
              contentType: view.contentType ?? "text",
              getContent: view.render,
            });
          }
        : undefined,
      addStatusBarItem: hasPermission("ui:status")
        ? (item: { id: string; text: string; icon: string; onClick?: () => void }) => {
            return uiRegistry.addStatusBarItem({ ...item, pluginId });
          }
        : undefined,
    },

    storage: hasPermission("storage")
      ? {
          get: async <T>(key: string): Promise<T | null> => {
            const all = settingsManager.getAll(pluginId);
            return key in all ? (all[key] as T) : null;
          },
          set: async (key: string, value: unknown): Promise<void> => {
            await settingsManager.set(pluginId, key, value);
          },
          delete: async (key: string): Promise<void> => {
            await settingsManager.delete(pluginId, key);
          },
          keys: async (): Promise<string[]> => {
            return settingsManager.keys(pluginId);
          },
        }
      : undefined,

    network: hasPermission("network")
      ? {
          fetch: async (url: string, init?: RequestInit): Promise<Response> => {
            const networkLogger = createLogger("plugin-network");
            networkLogger.info("Plugin fetch request", {
              pluginId,
              url,
              method: init?.method ?? "GET",
            });
            return fetch(url, init);
          },
        }
      : undefined,

    events: {
      on: <E extends EventName>(event: E, callback: EventCallback<E>) => {
        checkPermission("task:read", `events.on("${event}")`);
        eventBus.on(event, callback);
      },
      off: <E extends EventName>(event: E, callback: EventCallback<E>) => {
        eventBus.off(event, callback);
      },
    },

    ai: {
      registerProvider: hasPermission("ai:provider") && aiProviderRegistry
        ? (plugin: LLMProviderPlugin) => {
            // Prefix the provider name with pluginId to avoid collisions
            const prefixed = {
              ...plugin,
              name: `${pluginId}:${plugin.name}`,
            };
            aiProviderRegistry.register(prefixed, pluginId);
          }
        : undefined,
      registerTool: hasPermission("ai:tools") && toolRegistry
        ? (definition: ToolDefinition, executor: ToolExecutor) => {
            toolRegistry.register(definition, executor, pluginId);
          }
        : undefined,
    },

    settings: {
      get: <T>(key: string): T => {
        return settingsManager.get<T>(pluginId, key, settingDefinitions);
      },
      set: async (key: string, value: unknown): Promise<void> => {
        await settingsManager.set(pluginId, key, value);
      },
    } satisfies PluginSettingsAccessor,
  };
}
