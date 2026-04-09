import type { Permission, SettingDefinition } from "./types.js";
import { createLogger } from "../utils/logger.js";
import type { CreateTaskInput, UpdateTaskInput } from "../core/types.js";
import type { TaskService } from "../core/tasks.js";
import type { ProjectService } from "../core/projects.js";
import type { TagService } from "../core/tags.js";
import type { TaskFilter } from "../core/filters.js";
import type { EventBus, EventName, EventCallback } from "../core/event-bus.js";
import type { PluginSettingsManager } from "./settings.js";
import type { CommandRegistry } from "./command-registry.js";
import type { UIRegistry, ViewSlot, ViewContentType, PluginComponent } from "./ui-registry.js";
import type { LLMProviderRegistry } from "../ai/provider/registry.js";
import type { ToolRegistry } from "../ai/tools/registry.js";
import type { LLMProviderPlugin } from "../ai/provider/interface.js";
import type { ToolDefinition, ToolExecutor } from "../ai/tools/types.js";
import { validateOutboundNetworkUrl } from "./network-policy.js";

/** Current Plugin API version (semver). */
export const PLUGIN_API_VERSION = "2.0.0";

/** API stability: "stable" means breaking changes require major version bump. */
export const PLUGIN_API_STABILITY = "stable" as const;

export interface PluginAPIOptions {
  pluginId: string;
  permissions: Permission[];
  taskService: TaskService;
  projectService: ProjectService;
  tagService: TagService;
  eventBus: EventBus;
  settingsManager: PluginSettingsManager;
  commandRegistry: CommandRegistry;
  uiRegistry: UIRegistry;
  settingDefinitions: SettingDefinition[];
  aiProviderRegistry?: LLMProviderRegistry;
  toolRegistry?: ToolRegistry;
  onEventListenerRegistered?: <E extends EventName>(
    event: E,
    callback: EventCallback<E>,
  ) => void;
}

/** Accessor bound to a specific plugin for reading/writing settings. */
export interface PluginSettingsAccessor {
  get<T>(key: string): T;
  set(key: string, value: unknown): Promise<void>;
}

export type PluginAPI = ReturnType<typeof createPluginAPI>;

/**
 * Creates a permission-denied function that throws a clear error telling the
 * developer exactly which permission to add to their manifest.json.
 */
function denied(pluginId: string, permission: Permission, method: string): (...args: never[]) => never {
  return () => {
    throw new Error(
      `Plugin "${pluginId}" requires the "${permission}" permission to call ${method}. ` +
      `Add "${permission}" to the "permissions" array in your manifest.json.`,
    );
  };
}

/**
 * Plugin API surface — the controlled interface that plugins interact with.
 *
 * Every method is always present (no undefined). If the plugin lacks the
 * required permission, the method throws a clear error explaining which
 * permission to add to manifest.json.
 */
export function createPluginAPI(options: PluginAPIOptions) {
  const {
    pluginId,
    permissions,
    taskService,
    projectService,
    tagService,
    eventBus,
    settingsManager,
    commandRegistry,
    uiRegistry,
    settingDefinitions,
    aiProviderRegistry,
    toolRegistry,
    onEventListenerRegistered,
  } = options;

  const has = (p: Permission) => permissions.includes(p);

  const checkPermission = (p: Permission, action: string) => {
    if (!has(p)) {
      throw new Error(
        `Plugin "${pluginId}" requires the "${p}" permission to call ${action}. ` +
        `Add "${p}" to the "permissions" array in your manifest.json.`,
      );
    }
  };

  return {
    meta: {
      version: PLUGIN_API_VERSION,
      stability: PLUGIN_API_STABILITY,
    },

    // ── Task API ──────────────────────────────────────────────────────
    // task:read  → list, get
    // task:write → create, update, complete, uncomplete, delete
    tasks: {
      list: has("task:read")
        ? async (filter?: TaskFilter) => taskService.list(filter)
        : (denied(pluginId, "task:read", "tasks.list()") as unknown as (filter?: TaskFilter) => Promise<never>),

      get: has("task:read")
        ? async (id: string) => taskService.get(id)
        : (denied(pluginId, "task:read", "tasks.get()") as unknown as (id: string) => Promise<never>),

      create: has("task:write")
        ? async (input: CreateTaskInput) => taskService.create(input)
        : (denied(pluginId, "task:write", "tasks.create()") as unknown as (input: CreateTaskInput) => Promise<never>),

      update: has("task:write")
        ? async (id: string, changes: UpdateTaskInput) => taskService.update(id, changes)
        : (denied(pluginId, "task:write", "tasks.update()") as unknown as (id: string, changes: UpdateTaskInput) => Promise<never>),

      complete: has("task:write")
        ? async (id: string) => taskService.complete(id)
        : (denied(pluginId, "task:write", "tasks.complete()") as unknown as (id: string) => Promise<never>),

      uncomplete: has("task:write")
        ? async (id: string) => taskService.uncomplete(id)
        : (denied(pluginId, "task:write", "tasks.uncomplete()") as unknown as (id: string) => Promise<never>),

      delete: has("task:write")
        ? async (id: string) => taskService.delete(id)
        : (denied(pluginId, "task:write", "tasks.delete()") as unknown as (id: string) => Promise<never>),
    },

    // ── Project API ───────────────────────────────────────────────────
    // project:read  → list, get
    // project:write → create, update, delete
    projects: {
      list: has("project:read")
        ? async () => projectService.list()
        : (denied(pluginId, "project:read", "projects.list()") as unknown as () => Promise<never>),

      get: has("project:read")
        ? async (id: string) => projectService.get(id)
        : (denied(pluginId, "project:read", "projects.get()") as unknown as (id: string) => Promise<never>),

      create: has("project:write")
        ? async (name: string, opts?: { color?: string; parentId?: string | null; isFavorite?: boolean; viewStyle?: "list" | "board" | "calendar" }) =>
            projectService.create(name, opts)
        : (denied(pluginId, "project:write", "projects.create()") as unknown as (name: string, opts?: Record<string, unknown>) => Promise<never>),

      update: has("project:write")
        ? async (id: string, changes: Partial<{ name: string; color: string; icon: string | null; archived: boolean; parentId: string | null; isFavorite: boolean; viewStyle: "list" | "board" | "calendar" }>) =>
            projectService.update(id, changes)
        : (denied(pluginId, "project:write", "projects.update()") as unknown as (id: string, changes: Record<string, unknown>) => Promise<never>),

      delete: has("project:write")
        ? async (id: string) => projectService.delete(id)
        : (denied(pluginId, "project:write", "projects.delete()") as unknown as (id: string) => Promise<never>),
    },

    // ── Tag API ───────────────────────────────────────────────────────
    // tag:read  → list
    // tag:write → create, delete
    tags: {
      list: has("tag:read")
        ? async () => tagService.list()
        : (denied(pluginId, "tag:read", "tags.list()") as unknown as () => Promise<never>),

      create: has("tag:write")
        ? async (name: string, color?: string) => tagService.create(name, color)
        : (denied(pluginId, "tag:write", "tags.create()") as unknown as (name: string, color?: string) => Promise<never>),

      delete: has("tag:write")
        ? async (id: string) => tagService.delete(id)
        : (denied(pluginId, "tag:write", "tags.delete()") as unknown as (id: string) => Promise<never>),
    },

    // ── Command API ──────────────────────────────────────────────────
    commands: {
      register: has("commands")
        ? (command: { id: string; name: string; callback: () => void; hotkey?: string }) => {
            commandRegistry.register({
              ...command,
              id: `${pluginId}:${command.id}`,
              pluginId,
            });
          }
        : (denied(pluginId, "commands", "commands.register()") as unknown as (command: { id: string; name: string; callback: () => void; hotkey?: string }) => void),
    },

    // ── UI API ────────────────────────────────────────────────────────
    ui: {
      addSidebarPanel: has("ui:panel")
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
        : (denied(pluginId, "ui:panel", "ui.addSidebarPanel()") as unknown as (panel: Record<string, unknown>) => void),

      addView: has("ui:view")
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
        : (denied(pluginId, "ui:view", "ui.addView()") as unknown as (view: Record<string, unknown>) => void),

      addStatusBarItem: has("ui:status")
        ? (item: { id: string; text: string; icon: string; onClick?: () => void }) => {
            return uiRegistry.addStatusBarItem({ ...item, pluginId });
          }
        : (denied(pluginId, "ui:status", "ui.addStatusBarItem()") as unknown as (item: Record<string, unknown>) => { update: (data: { text?: string; icon?: string }) => void }),
    },

    // ── Storage API ──────────────────────────────────────────────────
    storage: {
      get: has("storage")
        ? async <T>(key: string): Promise<T | null> => {
            const all = settingsManager.getAll(pluginId);
            return key in all ? (all[key] as T) : null;
          }
        : (denied(pluginId, "storage", "storage.get()") as unknown as <T>(key: string) => Promise<T | null>),

      set: has("storage")
        ? async (key: string, value: unknown): Promise<void> => {
            await settingsManager.setStorageValue(pluginId, key, value);
          }
        : (denied(pluginId, "storage", "storage.set()") as unknown as (key: string, value: unknown) => Promise<void>),

      delete: has("storage")
        ? async (key: string): Promise<void> => {
            await settingsManager.delete(pluginId, key);
          }
        : (denied(pluginId, "storage", "storage.delete()") as unknown as (key: string) => Promise<void>),

      keys: has("storage")
        ? async (): Promise<string[]> => {
            return settingsManager.keys(pluginId);
          }
        : (denied(pluginId, "storage", "storage.keys()") as unknown as () => Promise<string[]>),
    },

    // ── Network API ──────────────────────────────────────────────────
    network: {
      fetch: has("network")
        ? async (url: string, init?: RequestInit): Promise<Response> => {
            validateOutboundNetworkUrl(url, { context: `network.fetch() for plugin "${pluginId}"` });
            const networkLogger = createLogger("plugin-network");
            networkLogger.info("Plugin fetch request", {
              pluginId,
              url,
              method: init?.method ?? "GET",
            });

            const response = await fetch(url, { ...init, redirect: "manual" });
            if (response.status >= 300 && response.status < 400) {
              throw new Error(
                `Blocked network.fetch() for plugin "${pluginId}": redirects are not allowed`,
              );
            }

            return response;
          }
        : (denied(pluginId, "network", "network.fetch()") as unknown as (url: string, init?: RequestInit) => Promise<Response>),
    },

    // ── Events API ───────────────────────────────────────────────────
    events: {
      on: <E extends EventName>(event: E, callback: EventCallback<E>) => {
        checkPermission("task:read", `events.on("${event}")`);
        eventBus.on(event, callback);
        onEventListenerRegistered?.(event, callback);
      },
      off: <E extends EventName>(event: E, callback: EventCallback<E>) => {
        eventBus.off(event, callback);
      },
    },

    // ── AI API ───────────────────────────────────────────────────────
    ai: {
      registerProvider: has("ai:provider") && aiProviderRegistry
        ? (plugin: LLMProviderPlugin) => {
            const prefixed = {
              ...plugin,
              name: `${pluginId}:${plugin.name}`,
            };
            aiProviderRegistry.register(prefixed, pluginId);
          }
        : (denied(pluginId, "ai:provider", "ai.registerProvider()") as unknown as (plugin: LLMProviderPlugin) => void),

      registerTool: has("ai:tools") && toolRegistry
        ? (definition: ToolDefinition, executor: ToolExecutor) => {
            toolRegistry.register(definition, executor, pluginId);
          }
        : (denied(pluginId, "ai:tools", "ai.registerTool()") as unknown as (definition: ToolDefinition, executor: ToolExecutor) => void),
    },

    // ── Settings API ─────────────────────────────────────────────────
    settings: {
      get: has("settings")
        ? (<T>(key: string): T => {
            return settingsManager.get<T>(pluginId, key, settingDefinitions);
          })
        : (denied(pluginId, "settings", "settings.get()") as unknown as <T>(key: string) => T),
      set: has("settings")
        ? async (key: string, value: unknown): Promise<void> => {
            await settingsManager.setSetting(pluginId, key, value, settingDefinitions);
          }
        : (denied(pluginId, "settings", "settings.set()") as unknown as (key: string, value: unknown) => Promise<void>),
    } satisfies PluginSettingsAccessor,
  };
}
