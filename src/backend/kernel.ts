import { TaskService } from "../core/tasks.js";
import { ProjectService } from "../core/projects.js";
import { TagService } from "../core/tags.js";
import { TemplateService } from "../core/templates.js";
import { SectionService } from "../core/sections.js";
import { StatsService } from "../core/stats.js";
import { EventBus } from "../core/event-bus.js";
import type { LoadedPlugin, PluginServices } from "../plugins/loader.js";
import { PluginSettingsManager } from "../plugins/settings.js";
import { CommandRegistry } from "../plugins/command-registry.js";
import { UIRegistry } from "../plugins/ui-registry.js";
import { ChatManager } from "../ai/chat.js";
import type { LLMProviderRegistry } from "../ai/provider/registry.js";
import type { ToolRegistry } from "../ai/tools/registry.js";
import type { IStorage } from "../storage/interface.js";

export interface BackendPluginLoader {
  setModuleLoader(loader: (path: string) => Promise<{ default: unknown }>): void;
  loadAll(): Promise<void>;
  unloadAll(): Promise<void>;
  getAll(): LoadedPlugin[];
  get(pluginId: string): LoadedPlugin | undefined;
  discoverOne(pluginId: string): Promise<LoadedPlugin | null>;
  load(pluginId: string): Promise<void>;
  unload(pluginId: string): Promise<void>;
  remove(pluginId: string): void;
  approveAndLoad(pluginId: string, permissions: string[]): Promise<void>;
  revokePermissions(pluginId: string): Promise<void>;
}

export interface AppServices {
  taskService: TaskService;
  projectService: ProjectService;
  tagService: TagService;
  templateService: TemplateService;
  sectionService: SectionService;
  statsService: StatsService;
  eventBus: EventBus;
  pluginLoader: BackendPluginLoader;
  settingsManager: PluginSettingsManager;
  commandRegistry: CommandRegistry;
  uiRegistry: UIRegistry;
  chatManager: ChatManager;
  storage: IStorage;
  aiProviderRegistry: LLMProviderRegistry;
  toolRegistry: ToolRegistry;
}

export interface BackendKernelOptions {
  storage: IStorage;
  aiRuntime: BackendKernelAIRuntime;
  createPluginLoader: (services: PluginServices) => BackendPluginLoader;
}

export interface BackendKernelAIRuntime {
  chatManager: ChatManager;
  aiProviderRegistry: LLMProviderRegistry;
  toolRegistry: ToolRegistry;
}

/**
 * Compose the runtime-agnostic backend service graph around supplied infrastructure.
 * Runtime-specific factories are responsible for creating storage and plugin hosts.
 */
export function createBackendKernel(options: BackendKernelOptions): AppServices {
  const { storage, aiRuntime, createPluginLoader } = options;

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
  const { chatManager, aiProviderRegistry, toolRegistry } = aiRuntime;

  const pluginServices: PluginServices = {
    taskService,
    projectService,
    tagService,
    eventBus,
    settingsManager,
    commandRegistry,
    uiRegistry,
    queries: storage,
    aiProviderRegistry,
    toolRegistry,
  };

  const pluginLoader = createPluginLoader(pluginServices);

  return {
    taskService,
    projectService,
    tagService,
    templateService,
    sectionService,
    statsService,
    eventBus,
    pluginLoader,
    settingsManager,
    commandRegistry,
    uiRegistry,
    chatManager,
    storage,
    aiProviderRegistry,
    toolRegistry,
  };
}
