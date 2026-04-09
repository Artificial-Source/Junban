import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PluginManifest, type Permission } from "./types.js";
import { createPluginAPI } from "./api.js";
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
import { createSandbox, type PluginSandbox } from "./sandbox.js";
import {
  checkDependencyVersionConstraint,
  validateManifestVersionCompatibility,
} from "./compatibility.js";

const logger = createLogger("plugin-loader");

export interface LoadedPlugin {
  manifest: PluginManifest;
  path: string;
  enabled: boolean;
  instance?: Plugin;
  sandbox?: PluginSandbox;
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
  /** Monotonic reload token used to bypass host loader cache for built-ins. */
  private builtinLoadRevisions: Map<string, number> = new Map();
  /** Temporary copied built-in plugin directories (native import path only). */
  private builtinNativeStageDirs: Map<string, string> = new Map();
  /** EventBus listeners registered by plugin hooks/API, cleaned up on unload. */
  private pluginListeners: Map<
    string,
    Array<{ event: EventName; callback: EventCallback<any> }>
  > = new Map();

  constructor(
    private pluginDir: string,
    private services: PluginServices,
    private builtinDir?: string,
  ) {}

  /** Create a cancellable lifecycle timeout guard. */
  private static lifecycleTimeout(
    pluginId: string,
    ms: number,
  ): { promise: Promise<never>; cancel: () => void } {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const promise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Plugin "${pluginId}" timed out after ${ms}ms`));
      }, ms);
    });

    return {
      promise,
      cancel: () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      },
    };
  }

  /** Set a custom module loader (e.g. Vite's ssrLoadModule for dev). */
  setModuleLoader(loader: (path: string) => Promise<any>): void {
    this.moduleLoader = loader;
  }

  /**
   * Module-loader path (e.g. Vite) cache busting by unique query param.
   */
  private nextBuiltinModuleLoaderSpecifier(
    pluginId: string,
    entryFile: string,
  ): string {
    const revision = (this.builtinLoadRevisions.get(pluginId) ?? 0) + 1;
    this.builtinLoadRevisions.set(pluginId, revision);
    const token = `junban_plugin_reload=${revision}`;

    return `${entryFile}${entryFile.includes("?") ? "&" : "?"}${token}`;
  }

  /**
   * Native ESM import caches module graphs by URL, including static dependencies.
   * Copy the built-in plugin tree to a unique temp directory per load so both
   * entry and dependency modules get fresh URLs.
   */
  private stageBuiltinForNativeImport(
    pluginId: string,
    pluginPath: string,
    entryRelPath: string,
  ): string {
    this.cleanupBuiltinNativeStage(pluginId);

    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), `junban-builtin-${pluginId}-`));
    fs.cpSync(pluginPath, stageDir, { recursive: true, force: true });
    this.builtinNativeStageDirs.set(pluginId, stageDir);

    return path.join(stageDir, entryRelPath);
  }

  private cleanupBuiltinNativeStage(pluginId: string): void {
    const stageDir = this.builtinNativeStageDirs.get(pluginId);
    if (!stageDir) {
      return;
    }

    this.builtinNativeStageDirs.delete(pluginId);
    try {
      fs.rmSync(stageDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        `Failed to clean up staged built-in plugin "${pluginId}" at ${stageDir}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Register a discovered plugin without allowing ID collisions to overwrite
   * existing loader state.
   */
  private async registerDiscovered(
    loaded: LoadedPlugin,
  ): Promise<LoadedPlugin | null> {
    const pluginId = loaded.manifest.id;
    const existing = this.plugins.get(pluginId);

    if (!existing) {
      this.plugins.set(pluginId, loaded);
      return loaded;
    }

    const samePlugin =
      existing.path === loaded.path && Boolean(existing.builtin) === Boolean(loaded.builtin);

    if (samePlugin) {
      // Rediscovery of the same plugin should not reset runtime state.
      existing.manifest = loaded.manifest;
      return existing;
    }

    // Built-ins always win ID collisions over community plugins, regardless
    // of discovery call order.
    if (loaded.builtin && !existing.builtin) {
      if (existing.enabled) {
        await this.unload(pluginId);
      }
      this.plugins.set(pluginId, loaded);
      logger.warn(
        `Built-in plugin ID "${pluginId}" replaced community plugin from ${existing.path}`,
      );
      return loaded;
    }

    if (!loaded.builtin && existing.builtin) {
      logger.warn(
        `Duplicate plugin ID "${pluginId}" rejected (${loaded.path}); built-in plugin already registered from ${existing.path}`,
      );
      return null;
    }

    logger.warn(
      `Duplicate plugin ID "${pluginId}" rejected (${loaded.path}); already registered from ${existing.path}`,
    );
    return null;
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

        const compatibilityIssues = validateManifestVersionCompatibility(result.data);
        if (compatibilityIssues.length > 0) {
          logger.warn(
            `Incompatible manifest in ${entry.name}: ${compatibilityIssues.map((issue) => issue.message).join("; ")}`,
          );
          continue;
        }

        const manifest = result.data;
        if (manifest.id !== entry.name) {
          logger.warn(
            `Manifest ID mismatch in ${entry.name}: manifest declares "${manifest.id}"`,
          );
          continue;
        }
        const loaded: LoadedPlugin = {
          manifest,
          path: pluginPath,
          enabled: false,
        };

        const registered = await this.registerDiscovered(loaded);
        if (!registered) {
          continue;
        }

        discovered.push(registered);
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

        const compatibilityIssues = validateManifestVersionCompatibility(result.data);
        if (compatibilityIssues.length > 0) {
          logger.warn(
            `Incompatible built-in manifest in ${entry.name}: ${compatibilityIssues.map((issue) => issue.message).join("; ")}`,
          );
          continue;
        }

        const manifest = result.data;
        if (manifest.id !== entry.name) {
          logger.warn(
            `Manifest ID mismatch in built-in ${entry.name}: manifest declares "${manifest.id}"`,
          );
          continue;
        }
        const loaded: LoadedPlugin = {
          manifest,
          path: pluginPath,
          enabled: false,
          builtin: true,
        };

        const registered = await this.registerDiscovered(loaded);
        if (!registered) {
          continue;
        }

        discovered.push(registered);
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
    return this.loadWithDependencyResolution(pluginId, new Set());
  }

  private async loadWithDependencyResolution(
    pluginId: string,
    resolving: Set<string>,
  ): Promise<void> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) {
      throw new NotFoundError("Plugin", pluginId);
    }

    if (loaded.enabled) {
      logger.warn(`Plugin "${pluginId}" is already loaded`);
      return;
    }

    if (resolving.has(pluginId)) {
      throw new ValidationError(
        `Circular plugin dependency detected while loading "${pluginId}"`,
      );
    }

    resolving.add(pluginId);

    try {
      await this.ensurePluginDependencies(
        pluginId,
        loaded.manifest.dependencies,
        resolving,
      );

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
        onEventListenerRegistered: (event, callback) => {
          this.trackPluginListener(pluginId, event, callback);
        },
      });

      let sandbox: PluginSandbox | undefined;

      try {
        const entryFile = path.join(loaded.path, loaded.manifest.main);
        const module = loaded.builtin
          ? await (async () => {
              if (this.moduleLoader) {
                const specifier = this.nextBuiltinModuleLoaderSpecifier(pluginId, entryFile);
                return this.moduleLoader(specifier);
              }

              const stagedEntry = this.stageBuiltinForNativeImport(
                pluginId,
                loaded.path,
                loaded.manifest.main,
              );
              return import(pathToFileURL(stagedEntry).href);
            })()
          : await (async () => {
              sandbox = createSandbox({
                pluginId,
                pluginDir: loaded.path,
                permissions: effectivePermissions,
              });
              return sandbox.execute(entryFile);
            })();

        const PluginClass = module.default;

        if (!PluginClass || typeof PluginClass !== "function") {
          throw new ValidationError(
            `Plugin "${pluginId}" does not have a default export class`,
          );
        }

        // Instantiate once and validate required lifecycle methods
        const instance: Plugin = new PluginClass();
        if (typeof instance.onLoad !== "function") {
          throw new ValidationError(
            `Plugin "${pluginId}" default export must have an onLoad() method`,
          );
        }
        if (typeof instance.onUnload !== "function") {
          throw new ValidationError(
            `Plugin "${pluginId}" default export must have an onUnload() method`,
          );
        }

        // Wire up instance API
        instance.app = api;
        instance.settings = api.settings;

        // Call onLoad with timeout and timer cleanup
        const loadTimeout = PluginLoader.lifecycleTimeout(
          pluginId,
          PLUGIN_LOAD_TIMEOUT_MS,
        );
        try {
          await Promise.race([instance.onLoad(), loadTimeout.promise]);
        } finally {
          loadTimeout.cancel();
        }

        // Wire EventBus listeners to plugin task lifecycle hooks
        this.registerTaskHooks(pluginId, instance, effectivePermissions);

        loaded.instance = instance;
        loaded.sandbox = sandbox;
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
        sandbox?.destroy();
        if (loaded.builtin) {
          this.cleanupBuiltinNativeStage(pluginId);
        }
        if (loaded.sandbox && loaded.sandbox !== sandbox) {
          loaded.sandbox.destroy();
        }
        loaded.sandbox = undefined;
        loaded.enabled = false;
        logger.error(
          `Failed to load plugin "${pluginId}": ${err instanceof Error ? err.message : err}`,
        );
        throw err;
      }
    } finally {
      resolving.delete(pluginId);
    }
  }

  private async ensurePluginDependencies(
    pluginId: string,
    dependencies: Record<string, string> | undefined,
    resolving: Set<string>,
  ): Promise<void> {
    if (!dependencies) {
      return;
    }

    const validDependencyId = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

    for (const [dependencyId, constraint] of Object.entries(dependencies)) {
      if (!validDependencyId.test(dependencyId)) {
        throw new ValidationError(
          `Plugin "${pluginId}" has invalid dependency ID "${dependencyId}"`,
        );
      }

      const dependency = this.plugins.get(dependencyId);
      if (!dependency) {
        throw new ValidationError(
          `Plugin "${pluginId}" requires dependency "${dependencyId}" (${constraint}) but it is not installed/discovered`,
        );
      }

      const versionCheck = checkDependencyVersionConstraint(
        dependency.manifest.version,
        constraint,
      );
      if (!versionCheck.ok) {
        const detail = versionCheck.error ? `: ${versionCheck.error}` : "";
        throw new ValidationError(
          `Plugin "${pluginId}" dependency "${dependencyId}" version ${dependency.manifest.version} does not satisfy "${constraint}"${detail}`,
        );
      }

      if (!dependency.enabled) {
        await this.loadWithDependencyResolution(dependencyId, resolving);
      }

      if (!this.plugins.get(dependencyId)?.enabled) {
        throw new ValidationError(
          `Plugin "${pluginId}" requires dependency "${dependencyId}" to be loadable and active before it can load`,
        );
      }
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
      const unloadTimeout = PluginLoader.lifecycleTimeout(
        pluginId,
        PLUGIN_UNLOAD_TIMEOUT_MS,
      );
      try {
        await Promise.race([loaded.instance.onUnload(), unloadTimeout.promise]);
      } finally {
        unloadTimeout.cancel();
      }
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
    this.services.toolRegistry?.unregisterBySource(pluginId);

    // Tear down sandbox context for community plugins
    loaded.sandbox?.destroy();
    loaded.sandbox = undefined;

    if (loaded.builtin) {
      this.cleanupBuiltinNativeStage(pluginId);
    }

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

      const compatibilityIssues = validateManifestVersionCompatibility(result.data);
      if (compatibilityIssues.length > 0) {
        logger.warn(
          `Incompatible manifest for ${pluginId}: ${compatibilityIssues.map((issue) => issue.message).join("; ")}`,
        );
        return null;
      }

      if (result.data.id !== pluginId) {
        logger.warn(
          `Manifest ID mismatch for ${pluginId}: manifest declares "${result.data.id}"`,
        );
        return null;
      }

      const loaded: LoadedPlugin = {
        manifest: result.data,
        path: pluginPath,
        enabled: false,
      };

      const registered = await this.registerDiscovered(loaded);
      if (!registered) {
        return null;
      }

      logger.info(
        `Discovered plugin: ${result.data.name} v${result.data.version}`,
      );
      return registered;
    } catch (err) {
      logger.warn(
        `Failed to read manifest for ${pluginId}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /** Register EventBus listeners that delegate to a plugin's task lifecycle hooks. */
  private registerTaskHooks(
    pluginId: string,
    instance: Plugin,
    permissions: Permission[],
  ): void {
    if (!permissions.includes("task:read")) {
      return;
    }

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
      this.trackPluginListener(pluginId, "task:create", cb);
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
      this.trackPluginListener(pluginId, "task:complete", cb);
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
      this.trackPluginListener(pluginId, "task:update", cb);
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
      this.trackPluginListener(pluginId, "task:delete", cb);
    }
  }

  private trackPluginListener(
    pluginId: string,
    event: EventName,
    callback: EventCallback<any>,
  ): void {
    const listeners = this.pluginListeners.get(pluginId) ?? [];
    listeners.push({ event, callback });
    this.pluginListeners.set(pluginId, listeners);
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
