import type { SettingDefinition } from "./types.js";
import type { IStorage } from "../storage/interface.js";
import { createLogger } from "../utils/logger.js";
import { NotFoundError, ValidationError } from "../core/errors.js";

const logger = createLogger("plugin-settings");

/**
 * Per-plugin settings manager.
 * Stores settings in the database, keyed by plugin ID.
 * Defaults come from the plugin manifest.
 */
export class PluginSettingsManager {
  private cache: Map<string, Record<string, unknown>> = new Map();

  constructor(private queries: IStorage) {}

  /** Get a setting value for a plugin, falling back to the manifest default. */
  get<T>(pluginId: string, settingId: string, definitions: SettingDefinition[]): T {
    const stored = this.cache.get(pluginId);
    if (stored && settingId in stored) {
      return stored[settingId] as T;
    }

    const def = definitions.find((d) => d.id === settingId);
    if (def) {
      return def.default as T;
    }

    throw new NotFoundError("Setting", `${pluginId}/${settingId}`);
  }

  /** Get all settings for a plugin. */
  getAll(pluginId: string): Record<string, unknown> {
    return this.cache.get(pluginId) ?? {};
  }

  /**
   * Raw plugin-scoped storage write.
   * Use this only for `app.storage.*`, not manifest-defined settings.
   */
  async setStorageValue(
    pluginId: string,
    settingId: string,
    value: unknown,
  ): Promise<void> {
    await this.writeValue(pluginId, settingId, value);
  }

  private async writeValue(
    pluginId: string,
    settingId: string,
    value: unknown,
  ): Promise<void> {
    logger.debug("Saving plugin setting", { pluginId, settingId });
    const stored = this.cache.get(pluginId) ?? {};
    stored[settingId] = value;
    this.cache.set(pluginId, stored);
    this.persist(pluginId);
  }

  /**
   * Update a manifest-defined setting value for a plugin.
   * Rejects unknown keys and invalid values.
   */
  async setSetting(
    pluginId: string,
    settingId: string,
    value: unknown,
    definitions: SettingDefinition[],
  ): Promise<void> {
    const definition = definitions.find((d) => d.id === settingId);
    if (!definition) {
      throw new ValidationError(
        `Invalid setting key "${settingId}" for plugin "${pluginId}". ` +
          "Only manifest-defined settings can be updated.",
      );
    }

    this.assertSettingValue(pluginId, definition, value);
    await this.writeValue(pluginId, settingId, value);
  }

  /** Delete a setting value for a plugin. */
  async delete(pluginId: string, settingId: string): Promise<void> {
    const stored = this.cache.get(pluginId);
    if (stored) {
      delete stored[settingId];
      this.persist(pluginId);
    }
  }

  /** Get all setting keys for a plugin. */
  keys(pluginId: string): string[] {
    const stored = this.cache.get(pluginId);
    return stored ? Object.keys(stored) : [];
  }

  /** Load all settings for a plugin from the database. */
  async load(pluginId: string): Promise<Record<string, unknown>> {
    logger.debug("Loading plugin settings", { pluginId });
    const row = this.queries.loadPluginSettings(pluginId);
    const settings: Record<string, unknown> = row ? JSON.parse(row.settings) : {};
    this.cache.set(pluginId, settings);
    return settings;
  }

  private persist(pluginId: string): void {
    const stored = this.cache.get(pluginId) ?? {};
    this.queries.savePluginSettings(pluginId, JSON.stringify(stored));
  }

  private assertSettingValue(
    pluginId: string,
    definition: SettingDefinition,
    value: unknown,
  ): void {
    const settingRef = `${pluginId}/${definition.id}`;
    switch (definition.type) {
      case "text": {
        if (typeof value !== "string") {
          throw new ValidationError(
            `Invalid value for setting "${settingRef}": expected string, got ${typeof value}.`,
          );
        }
        return;
      }
      case "number": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new ValidationError(
            `Invalid value for setting "${settingRef}": expected finite number.`,
          );
        }
        if (definition.min !== undefined && value < definition.min) {
          throw new ValidationError(
            `Invalid value for setting "${settingRef}": must be >= ${definition.min}.`,
          );
        }
        if (definition.max !== undefined && value > definition.max) {
          throw new ValidationError(
            `Invalid value for setting "${settingRef}": must be <= ${definition.max}.`,
          );
        }
        return;
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          throw new ValidationError(
            `Invalid value for setting "${settingRef}": expected boolean, got ${typeof value}.`,
          );
        }
        return;
      }
      case "select": {
        if (typeof value !== "string") {
          throw new ValidationError(
            `Invalid value for setting "${settingRef}": expected string option, got ${typeof value}.`,
          );
        }
        if (!definition.options.includes(value)) {
          throw new ValidationError(
            `Invalid value for setting "${settingRef}": must be one of ${definition.options.join(", ")}.`,
          );
        }
        return;
      }
    }
  }
}
