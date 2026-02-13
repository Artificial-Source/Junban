import type { SettingDefinition } from "./types.js";
import type { IStorage } from "../storage/interface.js";

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

    throw new Error(`Unknown setting: ${pluginId}/${settingId}`);
  }

  /** Get all settings for a plugin. */
  getAll(pluginId: string): Record<string, unknown> {
    return this.cache.get(pluginId) ?? {};
  }

  /** Update a setting value for a plugin. */
  async set(pluginId: string, settingId: string, value: unknown): Promise<void> {
    const stored = this.cache.get(pluginId) ?? {};
    stored[settingId] = value;
    this.cache.set(pluginId, stored);
    this.persist(pluginId);
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
    const row = this.queries.loadPluginSettings(pluginId);
    const settings: Record<string, unknown> = row ? JSON.parse(row.settings) : {};
    this.cache.set(pluginId, settings);
    return settings;
  }

  private persist(pluginId: string): void {
    const stored = this.cache.get(pluginId) ?? {};
    this.queries.savePluginSettings(pluginId, JSON.stringify(stored));
  }
}
