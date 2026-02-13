import fs from "node:fs";
import path from "node:path";
import { PluginManifest, type Permission } from "./types.js";
import { createPluginAPI } from "./api.js";
import { Plugin } from "./lifecycle.js";
import type { TaskService } from "../core/tasks.js";
import type { EventBus } from "../core/event-bus.js";
import type { PluginSettingsManager } from "./settings.js";
import type { CommandRegistry } from "./command-registry.js";
import type { UIRegistry } from "./ui-registry.js";
import type { Queries } from "../db/queries.js";
import type { AIProviderRegistry } from "../ai/provider-registry.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("info");

export interface LoadedPlugin {
  manifest: PluginManifest;
  path: string;
  enabled: boolean;
  instance?: Plugin;
  pendingApproval?: boolean;
}

export interface PluginServices {
  taskService: TaskService;
  eventBus: EventBus;
  settingsManager: PluginSettingsManager;
  commandRegistry: CommandRegistry;
  uiRegistry: UIRegistry;
  queries: Queries;
  aiProviderRegistry?: AIProviderRegistry;
}

/**
 * Plugin loader — discovers, validates, and loads plugins from the plugins directory.
 */
export class PluginLoader {
  private plugins: Map<string, LoadedPlugin> = new Map();

  constructor(
    private pluginDir: string,
    private services: PluginServices,
  ) {}

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

  /** Load and activate a plugin by ID. */
  async load(pluginId: string): Promise<void> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) {
      throw new Error(`Plugin "${pluginId}" not found`);
    }

    if (loaded.enabled) {
      logger.warn(`Plugin "${pluginId}" is already loaded`);
      return;
    }

    logger.info(`Loading plugin: ${pluginId}`);

    // Check permissions
    const approvedPermissions = this.services.queries.getPluginPermissions(pluginId);
    const requestedPermissions = (loaded.manifest.permissions ?? []) as Permission[];

    if (requestedPermissions.length > 0 && approvedPermissions === null) {
      // Never approved — mark as pending and skip loading
      loaded.pendingApproval = true;
      logger.info(`Plugin "${pluginId}" requires permission approval, skipping load`);
      return;
    }

    // Compute effective permissions: intersection of requested and approved
    const effectivePermissions = approvedPermissions
      ? requestedPermissions.filter((p) => approvedPermissions.includes(p))
      : requestedPermissions;

    // Load settings from DB
    await this.services.settingsManager.load(pluginId);

    // Create permission-gated API
    const api = createPluginAPI({
      pluginId,
      permissions: effectivePermissions,
      taskService: this.services.taskService,
      eventBus: this.services.eventBus,
      settingsManager: this.services.settingsManager,
      commandRegistry: this.services.commandRegistry,
      uiRegistry: this.services.uiRegistry,
      settingDefinitions: loaded.manifest.settings ?? [],
      aiProviderRegistry: this.services.aiProviderRegistry,
    });

    // Dynamic import of the plugin entry file
    const entryFile = path.join(loaded.path, loaded.manifest.main);
    const module = await import(entryFile);
    const PluginClass = module.default;

    if (!PluginClass || typeof PluginClass !== "function") {
      throw new Error(`Plugin "${pluginId}" does not have a default export class`);
    }

    // Instantiate and wire up
    const instance: Plugin = new PluginClass();
    instance.app = api;
    instance.settings = api.settings;

    // Call onLoad
    await instance.onLoad();

    loaded.instance = instance;
    loaded.enabled = true;
    loaded.pendingApproval = false;
    logger.info(`Loaded plugin: ${loaded.manifest.name}`);
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
      await loaded.instance.onUnload();
    } catch (err) {
      logger.error(
        `Error in onUnload for "${pluginId}": ${err instanceof Error ? err.message : err}`,
      );
    }

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
        logger.warn(`Invalid manifest for ${pluginId}: ${result.error.message}`);
        return null;
      }

      const loaded: LoadedPlugin = {
        manifest: result.data,
        path: pluginPath,
        enabled: false,
      };

      this.plugins.set(result.data.id, loaded);
      logger.info(`Discovered plugin: ${result.data.name} v${result.data.version}`);
      return loaded;
    } catch (err) {
      logger.warn(
        `Failed to read manifest for ${pluginId}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /** Remove a plugin from the internal map (after uninstall). */
  remove(pluginId: string): void {
    this.plugins.delete(pluginId);
    logger.info(`Removed plugin "${pluginId}" from loader`);
  }
}
