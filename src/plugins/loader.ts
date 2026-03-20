import fs from "node:fs";
import path from "node:path";
import { PluginManifest, type Permission } from "./types.js";
import { createPluginAPI, PLUGIN_API_VERSION } from "./api.js";
import { Plugin } from "./lifecycle.js";
import type { TaskService } from "../core/tasks.js";
import type { ProjectService } from "../core/projects.js";
import type { TagService } from "../core/tags.js";
import type { EventBus } from "../core/event-bus.js";
import type { EventCallback, EventName } from "../core/event-bus.js";
import type { PluginSettingsManager } from "./settings.js";
import type { CommandRegistry } from "./command-registry.js";
import type { UIRegistry } from "./ui-registry.js";
import type { IStorage } from "../storage/interface.js";
import type { LLMProviderRegistry } from "../ai/provider/registry.js";
import type { ToolRegistry } from "../ai/tools/registry.js";
import { createLogger } from "../utils/logger.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import {
  PLUGIN_LOAD_TIMEOUT_MS,
  PLUGIN_UNLOAD_TIMEOUT_MS,
} from "../config/defaults.js";

const logger = createLogger("plugin-loader");

export interface LoadedPlugin {
  manifest: PluginManifest;
  path: string;
  enabled: boolean;
  instance?: Plugin;
  pendingApproval?: boolean;
  builtin?: boolean;
}

export interface PluginServices {
  taskService: TaskService;
  projectService: ProjectService;
  tagService: TagService;
  eventBus: EventBus;
  settingsManager: PluginSettingsManager;
  commandRegistry: CommandRegistry;
  uiRegistry: UIRegistry;
  queries: IStorage;
  aiProviderRegistry?: LLMProviderRegistry;
  toolRegistry?: ToolRegistry;
}

/**
 * Plugin loader — discovers, validates, and loads plugins from the plugins directory.
 */
export class PluginLoader {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private moduleLoader: ((path: string) => Promise<any>) | null = null;
  /** EventBus listeners registered per plugin, cleaned up on unload. */
  private pluginListeners: Map<
    string,
    Array<{ event: EventName; callback: EventCallback<any> }>
  > = new Map();

  constructor(
    private pluginDir: string,
    private services: PluginServices,
    private builtinDir?: string,
  ) {}

  /** Create a promise that rejects after the given timeout. */
  private static lifecycleTimeout(pluginId: string, ms: number): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Plugin "${pluginId}" timed out after ${ms}ms`)),
        ms,
      ),
    );
  }

  /** Set a custom module loader (e.g. Vite's ssrLoadModule for dev). */
  setModuleLoader(loader: (path: string) => Promise<any>): void {
    this.moduleLoader = loader;
  }

  /** Scan the plugins directory and validate all manifests. */
  async discover(): Promise<LoadedPlugin[]> {
    logger.info(`Scanning for plugins in ${this.pluginDir}`);

    if (!fs.existsSync(this.pluginDir)) {
      logger.info("Plugin directory does not exist, skipping discovery");
      return [];
    }

    const entries = fs.readdirSync(this.pluginDir, { withFileTypes: true });
    const discovered: LoadedPlugin[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginPath = path.join(this.pluginDir, entry.name);
      const manifestPath = path.join(pluginPath, "manifest.json");

      if (!fs.existsSync(manifestPath)) {
        logger.warn(`No manifest.json in ${entry.name}, skipping`);
        continue;
      }

      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        const result = PluginManifest.safeParse(raw);

        if (!result.success) {
          logger.warn(`Invalid manifest in ${entry.name}: ${result.error.message}`);
          continue;
        }

        const manifest = result.data;
        const loaded: LoadedPlugin = {
          manifest,
          path: pluginPath,
          enabled: false,
        };

        this.plugins.set(manifest.id, loaded);
        discovered.push(loaded);
        logger.info(`Discovered plugin: ${manifest.name} v${manifest.version}`);
      } catch (err) {
        logger.warn(
          `Failed to read manifest in ${entry.name}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    logger.info(`Discovered ${discovered.length} plugin(s)`);
    return discovered;
  }

  /** Scan the built-in extensions directory and validate all manifests. */
  async discoverBuiltin(): Promise<LoadedPlugin[]> {
    if (!this.builtinDir || !fs.existsSync(this.builtinDir)) {
      return [];
    }

    logger.info(`Scanning for built-in extensions in ${this.builtinDir}`);

    const entries = fs.readdirSync(this.builtinDir, { withFileTypes: true });
    const discovered: LoadedPlugin[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginPath = path.join(this.builtinDir, entry.name);
      const manifestPath = path.join(pluginPath, "manifest.json");

      if (!fs.existsSync(manifestPath)) {
        logger.warn(`No manifest.json in built-in ${entry.name}, skipping`);
        continue;
      }

      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        const result = PluginManifest.safeParse(raw);

        if (!result.success) {
          logger.warn(
            `Invalid manifest in built-in ${entry.name}: ${result.error.message}`,
          );
          continue;
        }

        const manifest = result.data;
        const loaded: LoadedPlugin = {
          manifest,
          path: pluginPath,
          enabled: false,
          builtin: true,
        };

        this.plugins.set(manifest.id, loaded);
        discovered.push(loaded);
        logger.info(
          `Discovered built-in extension: ${manifest.name} v${manifest.version}`,
        );
      } catch (err) {
        logger.warn(
          `Failed to read manifest in built-in ${entry.name}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    logger.info(`Discovered ${discovered.length} built-in extension(s)`);
    return discovered;
  }

  /** Load and activate a plugin by ID. */
  async load(pluginId: string): Promise<void> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) {
      throw new NotFoundError("Plugin", pluginId);
    }

    if (loaded.enabled) {
      logger.warn(`Plugin "${pluginId}" is already loaded`);
      return;
    }

    logger.info(`Loading plugin: ${pluginId}`);

    // Block community plugins when restricted mode is on
    if (!loaded.builtin) {
      const setting =
        this.services.queries.getAppSetting("community_plugins_enabled");
      if (setting?.value !== "true") {
        logger.info(`Community plugins disabled, skipping "${pluginId}"`);
        return;
      }
    }

    // Check permissions
    const approvedPermissions =
      this.services.queries.getPluginPermissions(pluginId);
    const requestedPermissions = (loaded.manifest.permissions ?? []) as Permission[];

    if (approvedPermissions === null) {
      if (loaded.builtin) {
        // Built-in extensions stay inactive until explicitly activated by the user
        logger.info(
          `Built-in extension "${pluginId}" not activated, skipping load`,
        );
        return;
      }
      if (requestedPermissions.length > 0) {
        // Community plugin never approved — mark as pending and skip loading
        loaded.pendingApproval = true;
        logger.info(
          `Plugin "${pluginId}" requires permission approval, skipping load`,
        );
        return;
      }
    }

    // Compute effective permissions:
    // Built-in extensions always get their full requested permissions (manifest is trusted).
    // Community plugins get the intersection of requested and user-approved permissions.
    const effectivePermissions =
      loaded.builtin || !approvedPermissions
        ? requestedPermissions
        : requestedPermissions.filter((p) => approvedPermissions.includes(p));

    // Warn if plugin targets a newer API major version
    if (loaded.manifest.targetApiVersion) {
      const [pluginMajor] = loaded.manifest.targetApiVersion
        .split(".")
        .map(Number);
      const [currentMajor] = PLUGIN_API_VERSION.split(".").map(Number);
      if (pluginMajor > currentMajor) {
        logger.warn(
          `Plugin "${pluginId}" targets API v${loaded.manifest.targetApiVersion} but current is v${PLUGIN_API_VERSION}. Some features may not work.`,
        );
      }
    }

    // Load settings from DB
    await this.services.settingsManager.load(pluginId);

    // Create permission-gated API
    const api = createPluginAPI({
      pluginId,
      permissions: effectivePermissions,
      taskService: this.services.taskService,
      projectService: this.services.projectService,
      tagService: this.services.tagService,
      eventBus: this.services.eventBus,
      settingsManager: this.services.settingsManager,
      commandRegistry: this.services.commandRegistry,
      uiRegistry: this.services.uiRegistry,
      settingDefinitions: loaded.manifest.settings ?? [],
      aiProviderRegistry: this.services.aiProviderRegistry,
      toolRegistry: this.services.toolRegistry,
    });

    try {
      // Dynamic import of the plugin entry file
      const entryFile = path.join(loaded.path, loaded.manifest.main);
      const module = this.moduleLoader
        ? await this.moduleLoader(entryFile)
        : await import(entryFile);
      const PluginClass = module.default;

      if (!PluginClass || typeof PluginClass !== "function") {
        throw new ValidationError(
          `Plugin "${pluginId}" does not have a default export class`,
        );
      }

      // Validate that the constructor produces a Plugin-like instance
      const testInstance = new PluginClass();
      if (typeof testInstance.onLoad !== "function") {
        throw new ValidationError(
          `Plugin "${pluginId}" default export must have an onLoad() method`,
        );
      }
      if (typeof testInstance.onUnload !== "function") {
        throw new ValidationError(
          `Plugin "${pluginId}" default export must have an onUnload() method`,
        );
      }

      // Instantiate and wire up
      const instance: Plugin = new PluginClass();
      instance.app = api;
      instance.settings = api.settings;

      // Call onLoad with timeout
      await Promise.race([
        instance.onLoad(),
        PluginLoader.lifecycleTimeout(pluginId, PLUGIN_LOAD_TIMEOUT_MS),
      ]);

      // Wire EventBus listeners to plugin task lifecycle hooks
      this.registerTaskHooks(pluginId, instance);

      loaded.instance = instance;
      loaded.enabled = true;
      loaded.pendingApproval = false;
      logger.info(`Loaded plugin: ${loaded.manifest.name}`);
    } catch (err) {
      // Clean up any EventBus listeners registered during failed load
      this.removeTaskHooks(pluginId);
      // Clean up any commands/UI registered during failed load
      this.services.commandRegistry.unregisterByPlugin(pluginId);
      this.services.uiRegistry.removeByPlugin(pluginId);
      this.services.aiProviderRegistry?.unregisterByPlugin(pluginId);
      this.services.toolRegistry?.unregisterBySource(pluginId);
      loaded.enabled = false;
      logger.error(
        `Failed to load plugin "${pluginId}": ${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }
  }

  /** Approve permissions and load a plugin. */
  async approveAndLoad(pluginId: string, permissions: string[]): Promise<void> {
    this.services.queries.setPluginPermissions(pluginId, permissions);
    const loaded = this.plugins.get(pluginId);
    if (loaded) {
      loaded.pendingApproval = false;
    }
    await this.load(pluginId);
  }

  /** Revoke all permissions and unload a plugin. */
  async revokePermissions(pluginId: string): Promise<void> {
    await this.unload(pluginId);
    this.services.queries.deletePluginPermissions(pluginId);
    const loaded = this.plugins.get(pluginId);
    if (loaded) {
      loaded.pendingApproval = true;
    }
  }

  /** Deactivate and unload a plugin by ID. */
  async unload(pluginId: string): Promise<void> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded || !loaded.enabled || !loaded.instance) {
      logger.warn(`Plugin "${pluginId}" is not loaded`);
      return;
    }

    logger.info(`Unloading plugin: ${pluginId}`);

    try {
      await Promise.race([
        loaded.instance.onUnload(),
        PluginLoader.lifecycleTimeout(pluginId, PLUGIN_UNLOAD_TIMEOUT_MS),
      ]);
    } catch (err) {
      logger.error(
        `Error in onUnload for "${pluginId}": ${err instanceof Error ? err.message : err}`,
      );
    }

    // Remove EventBus listeners registered for this plugin
    this.removeTaskHooks(pluginId);

    // Clean up registered commands and UI
    this.services.commandRegistry.unregisterByPlugin(pluginId);
    this.services.uiRegistry.removeByPlugin(pluginId);

    // Clean up AI providers registered by this plugin
    this.services.aiProviderRegistry?.unregisterByPlugin(pluginId);

    loaded.instance = undefined;
    loaded.enabled = false;
    logger.info(`Unloaded plugin: ${pluginId}`);
  }

  /** Discover and load all valid plugins. */
  async loadAll(): Promise<void> {
    await this.discoverBuiltin();
    await this.discover();

    for (const [pluginId, loaded] of this.plugins) {
      try {
        await this.load(pluginId);
      } catch (err) {
        logger.error(
          `Failed to load plugin "${loaded.manifest.name}": ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /** Unload all enabled plugins. */
  async unloadAll(): Promise<void> {
    for (const [pluginId, loaded] of this.plugins) {
      if (loaded.enabled) {
        await this.unload(pluginId);
      }
    }
  }

  /** Get all discovered plugins. */
  getAll(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /** Get a specific plugin by ID. */
  get(pluginId: string): LoadedPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /** Discover a single plugin by ID (after install). */
  async discoverOne(pluginId: string): Promise<LoadedPlugin | null> {
    // Validate pluginId to prevent path traversal
    if (
      !pluginId ||
      !/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(pluginId)
    ) {
      logger.warn(`Invalid plugin ID: ${pluginId}`);
      return null;
    }

    const pluginPath = path.join(this.pluginDir, pluginId);
    const manifestPath = path.join(pluginPath, "manifest.json");

    if (!fs.existsSync(manifestPath)) {
      logger.warn(`No manifest.json for ${pluginId}`);
      return null;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      const result = PluginManifest.safeParse(raw);

      if (!result.success) {
        logger.warn(
          `Invalid manifest for ${pluginId}: ${result.error.message}`,
        );
        return null;
      }

      const loaded: LoadedPlugin = {
        manifest: result.data,
        path: pluginPath,
        enabled: false,
      };

      this.plugins.set(result.data.id, loaded);
      logger.info(
        `Discovered plugin: ${result.data.name} v${result.data.version}`,
      );
      return loaded;
    } catch (err) {
      logger.warn(
        `Failed to read manifest for ${pluginId}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /** Register EventBus listeners that delegate to a plugin's task lifecycle hooks. */
  private registerTaskHooks(pluginId: string, instance: Plugin): void {
    const listeners: Array<{
      event: EventName;
      callback: EventCallback<any>;
    }> = [];
    const eb = this.services.eventBus;

    if (instance.onTaskCreate) {
      const cb: EventCallback<"task:create"> = (task) => {
        try {
          instance.onTaskCreate!(task);
        } catch (err) {
          logger.error(
            `Plugin "${pluginId}" onTaskCreate error: ${err instanceof Error ? err.message : err}`,
          );
        }
      };
      eb.on("task:create", cb);
      listeners.push({ event: "task:create", callback: cb });
    }

    if (instance.onTaskComplete) {
      const cb: EventCallback<"task:complete"> = (task) => {
        try {
          instance.onTaskComplete!(task);
        } catch (err) {
          logger.error(
            `Plugin "${pluginId}" onTaskComplete error: ${err instanceof Error ? err.message : err}`,
          );
        }
      };
      eb.on("task:complete", cb);
      listeners.push({ event: "task:complete", callback: cb });
    }

    if (instance.onTaskUpdate) {
      const cb: EventCallback<"task:update"> = ({ task, changes }) => {
        try {
          instance.onTaskUpdate!(task, changes);
        } catch (err) {
          logger.error(
            `Plugin "${pluginId}" onTaskUpdate error: ${err instanceof Error ? err.message : err}`,
          );
        }
      };
      eb.on("task:update", cb);
      listeners.push({ event: "task:update", callback: cb });
    }

    if (instance.onTaskDelete) {
      const cb: EventCallback<"task:delete"> = (task) => {
        try {
          instance.onTaskDelete!(task);
        } catch (err) {
          logger.error(
            `Plugin "${pluginId}" onTaskDelete error: ${err instanceof Error ? err.message : err}`,
          );
        }
      };
      eb.on("task:delete", cb);
      listeners.push({ event: "task:delete", callback: cb });
    }

    if (listeners.length > 0) {
      this.pluginListeners.set(pluginId, listeners);
    }
  }

  /** Remove all EventBus listeners for a plugin. */
  private removeTaskHooks(pluginId: string): void {
    const listeners = this.pluginListeners.get(pluginId);
    if (!listeners) return;

    const eb = this.services.eventBus;
    for (const { event, callback } of listeners) {
      eb.off(event, callback);
    }
    this.pluginListeners.delete(pluginId);
  }

  /** Remove a plugin from the internal map (after uninstall). */
  remove(pluginId: string): void {
    const loaded = this.plugins.get(pluginId);
    if (loaded?.builtin) {
      throw new ValidationError(
        `Cannot remove built-in extension "${pluginId}"`,
      );
    }
    this.plugins.delete(pluginId);
    logger.info(`Removed plugin "${pluginId}" from loader`);
  }
}
