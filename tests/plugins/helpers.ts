/**
 * Shared test helpers for plugin tests.
 *
 * - `createPluginTestEnv()` — wires up real services (in-memory SQLite) + plugin
 *   registries, returning a ready-to-use PluginAPI. Good for integration tests.
 * - `createMockPluginAPI()` — returns a fully vi.fn()-mocked PluginAPI.
 *   Good for unit-testing plugin code in isolation.
 */

import { vi } from "vitest";
import { createTestServices } from "../integration/helpers.js";
import { PluginSettingsManager } from "../../src/plugins/settings.js";
import { CommandRegistry } from "../../src/plugins/command-registry.js";
import { UIRegistry } from "../../src/plugins/ui-registry.js";
import { createPluginAPI } from "../../src/plugins/api.js";
import type { PluginAPI, PluginSettingsAccessor } from "../../src/plugins/api.js";
import type { Permission, SettingDefinition } from "../../src/plugins/types.js";

export interface PluginTestEnvOptions {
  /** Plugin ID (defaults to "test-plugin"). */
  pluginId?: string;
  /** Permissions granted to the plugin (defaults to all 15). */
  permissions?: Permission[];
  /** Setting definitions from the plugin manifest. */
  settings?: SettingDefinition[];
}

const ALL_PERMISSIONS: Permission[] = [
  "task:read",
  "task:write",
  "project:read",
  "project:write",
  "tag:read",
  "tag:write",
  "ui:panel",
  "ui:view",
  "ui:status",
  "commands",
  "settings",
  "storage",
  "network",
  "ai:provider",
  "ai:tools",
];

/**
 * Create a full plugin test environment backed by an in-memory SQLite database.
 *
 * Returns all services, registries, and a real PluginAPI that can create tasks,
 * register commands, etc. Use this for integration-style plugin tests.
 */
export function createPluginTestEnv(options?: PluginTestEnvOptions) {
  const pluginId = options?.pluginId ?? "test-plugin";
  const permissions = options?.permissions ?? ALL_PERMISSIONS;
  const settingDefinitions = options?.settings ?? [];

  const services = createTestServices();
  const settingsManager = new PluginSettingsManager(services.storage);
  const commandRegistry = new CommandRegistry();
  const uiRegistry = new UIRegistry();

  const api = createPluginAPI({
    pluginId,
    permissions,
    taskService: services.taskService,
    projectService: services.projectService,
    tagService: services.tagService,
    eventBus: services.eventBus,
    settingsManager,
    commandRegistry,
    uiRegistry,
    settingDefinitions,
  });

  return {
    pluginId,
    api,
    settings: api.settings,
    ...services,
    settingsManager,
    commandRegistry,
    uiRegistry,
  };
}

/**
 * Create a fully-mocked PluginAPI where every method is a `vi.fn()`.
 *
 * Use this for unit tests that need to verify a plugin calls specific API
 * methods without wiring up real services.
 */
export function createMockPluginAPI(): {
  api: PluginAPI;
  settings: PluginSettingsAccessor;
} {
  const settings: PluginSettingsAccessor = {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
  };

  const api = {
    meta: { version: "2.0.0", stability: "stable" as const },

    tasks: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "mock-task-id" }),
      update: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
      uncomplete: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },

    projects: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "mock-project-id" }),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },

    tags: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: "mock-tag-id" }),
      delete: vi.fn().mockResolvedValue(undefined),
    },

    commands: {
      register: vi.fn(),
    },

    ui: {
      addSidebarPanel: vi.fn(),
      addView: vi.fn(),
      addStatusBarItem: vi.fn().mockReturnValue({
        update: vi.fn(),
      }),
    },

    storage: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockResolvedValue([]),
    },

    network: {
      fetch: vi.fn().mockResolvedValue(new Response()),
    },

    events: {
      on: vi.fn(),
      off: vi.fn(),
    },

    ai: {
      registerProvider: vi.fn(),
      registerTool: vi.fn(),
    },

    settings,
  } as unknown as PluginAPI;

  return { api, settings };
}
