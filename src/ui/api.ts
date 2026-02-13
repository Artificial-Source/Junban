import type { Task, CreateTaskInput, UpdateTaskInput, Project } from "../core/types.js";
import type { TaskFilter } from "../core/filters.js";
import type { ImportedTask, ImportResult } from "../core/import.js";

const BASE = "/api";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

// Lazy-loaded services for Tauri mode
type WebServices = Awaited<ReturnType<typeof import("../bootstrap-web.js").bootstrapWeb>>;
let _services: WebServices | null = null;

async function getServices(): Promise<WebServices> {
  if (!_services) {
    const { bootstrapWeb } = await import("../bootstrap-web.js");
    _services = await bootstrapWeb();
  }
  return _services;
}

export const api = {
  async listTasks(params?: {
    search?: string;
    projectId?: string;
    status?: string;
  }): Promise<Task[]> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.taskService.list(
        params && Object.keys(params).length > 0 ? (params as TaskFilter) : undefined,
      );
    }
    const url = new URL(`${BASE}/tasks`, window.location.origin);
    if (params?.search) url.searchParams.set("search", params.search);
    if (params?.projectId) url.searchParams.set("projectId", params.projectId);
    if (params?.status) url.searchParams.set("status", params.status);
    const res = await fetch(url.toString());
    return res.json();
  },

  async createTask(input: CreateTaskInput): Promise<Task> {
    if (isTauri()) {
      const svc = await getServices();
      const task = await svc.taskService.create(input);
      svc.save();
      return task;
    }
    const res = await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return res.json();
  },

  async completeTask(id: string): Promise<Task> {
    if (isTauri()) {
      const svc = await getServices();
      const task = await svc.taskService.complete(id);
      svc.save();
      return task;
    }
    const res = await fetch(`${BASE}/tasks/${id}/complete`, {
      method: "POST",
    });
    return res.json();
  },

  async updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    if (isTauri()) {
      const svc = await getServices();
      const task = await svc.taskService.update(id, input);
      svc.save();
      return task;
    }
    const res = await fetch(`${BASE}/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return res.json();
  },

  async deleteTask(id: string): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      await svc.taskService.delete(id);
      svc.save();
      return;
    }
    await fetch(`${BASE}/tasks/${id}`, { method: "DELETE" });
  },

  async completeManyTasks(ids: string[]): Promise<Task[]> {
    if (isTauri()) {
      const svc = await getServices();
      const tasks = await svc.taskService.completeMany(ids);
      svc.save();
      return tasks;
    }
    const res = await fetch(`${BASE}/tasks/bulk/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    return res.json();
  },

  async deleteManyTasks(ids: string[]): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      await svc.taskService.deleteMany(ids);
      svc.save();
      return;
    }
    await fetch(`${BASE}/tasks/bulk/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  },

  async updateManyTasks(ids: string[], changes: UpdateTaskInput): Promise<Task[]> {
    if (isTauri()) {
      const svc = await getServices();
      const tasks = await svc.taskService.updateMany(ids, changes);
      svc.save();
      return tasks;
    }
    const res = await fetch(`${BASE}/tasks/bulk/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, changes }),
    });
    return res.json();
  },

  async reorderTasks(orderedIds: string[]): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      await svc.taskService.reorder(orderedIds);
      svc.save();
      return;
    }
    await fetch(`${BASE}/tasks/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds }),
    });
  },

  async importTasks(tasks: ImportedTask[]): Promise<ImportResult> {
    if (isTauri()) {
      const svc = await getServices();
      const errors: string[] = [];
      let imported = 0;

      for (const t of tasks) {
        try {
          let projectId: string | undefined;
          if (t.projectName) {
            const project = await svc.projectService.getOrCreate(t.projectName);
            projectId = project.id;
          }

          const task = await svc.taskService.create({
            title: t.title,
            description: t.description ?? undefined,
            priority: t.priority,
            dueDate: t.dueDate ?? undefined,
            dueTime: t.dueTime,
            projectId,
            recurrence: t.recurrence ?? undefined,
            tags: t.tagNames,
          });

          if (t.status === "completed") {
            await svc.taskService.complete(task.id);
          }

          imported++;
        } catch (err) {
          errors.push(
            `Failed to import "${t.title}": ${err instanceof Error ? err.message : "unknown error"}`,
          );
        }
      }

      svc.save();
      return { imported, errors };
    }

    const res = await fetch(`${BASE}/tasks/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks }),
    });
    return res.json();
  },

  async listProjects(): Promise<Project[]> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.projectService.list();
    }
    const res = await fetch(`${BASE}/projects`);
    return res.json();
  },

  // Plugin APIs

  async listPlugins(): Promise<PluginInfo[]> {
    if (isTauri()) {
      // No plugin loader in Tauri mode (deferred)
      return [];
    }
    const res = await fetch(`${BASE}/plugins`);
    return res.json();
  },

  async getPluginSettings(pluginId: string): Promise<Record<string, unknown>> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.settingsManager.getAll(pluginId);
    }
    const res = await fetch(`${BASE}/plugins/${pluginId}/settings`);
    return res.json();
  },

  async updatePluginSetting(pluginId: string, key: string, value: unknown): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      await svc.settingsManager.set(pluginId, key, value);
      svc.save();
      return;
    }
    await fetch(`${BASE}/plugins/${pluginId}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
  },

  async listPluginCommands(): Promise<PluginCommandInfo[]> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.commandRegistry.getAll().map((c) => ({
        id: c.id,
        name: c.name,
        hotkey: c.hotkey,
      }));
    }
    const res = await fetch(`${BASE}/plugins/commands`);
    return res.json();
  },

  async executePluginCommand(id: string): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      svc.commandRegistry.execute(id);
      return;
    }
    await fetch(`${BASE}/plugins/commands/${encodeURIComponent(id)}`, {
      method: "POST",
    });
  },

  async getStatusBarItems(): Promise<StatusBarItemInfo[]> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.uiRegistry.getStatusBarItems().map((item) => ({
        id: item.id,
        text: item.text,
        icon: item.icon,
      }));
    }
    const res = await fetch(`${BASE}/plugins/ui/status-bar`);
    return res.json();
  },

  async getPluginPanels(): Promise<PanelInfo[]> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.uiRegistry.getPanels().map((panel) => ({
        id: panel.id,
        title: panel.title,
        icon: panel.icon,
        content: svc.uiRegistry.getPanelContent(panel.id) ?? "",
      }));
    }
    const res = await fetch(`${BASE}/plugins/ui/panels`);
    return res.json();
  },

  async getPluginViews(): Promise<ViewInfo[]> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.uiRegistry.getViews().map((view) => ({
        id: view.id,
        name: view.name,
        icon: view.icon,
      }));
    }
    const res = await fetch(`${BASE}/plugins/ui/views`);
    return res.json();
  },

  async getPluginViewContent(viewId: string): Promise<string> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.uiRegistry.getViewContent(viewId) ?? "";
    }
    const res = await fetch(`${BASE}/plugins/ui/views/${encodeURIComponent(viewId)}/content`);
    const data = await res.json();
    return data.content;
  },

  async getPluginPermissions(pluginId: string): Promise<string[] | null> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.queries.getPluginPermissions(pluginId);
    }
    const res = await fetch(`${BASE}/plugins/${pluginId}/permissions`);
    const data = await res.json();
    return data.permissions;
  },

  async approvePluginPermissions(pluginId: string, permissions: string[]): Promise<void> {
    if (isTauri()) {
      // Not yet supported in Tauri mode
      return;
    }
    await fetch(`${BASE}/plugins/${pluginId}/permissions/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissions }),
    });
  },

  async revokePluginPermissions(pluginId: string): Promise<void> {
    if (isTauri()) {
      // Not yet supported in Tauri mode
      return;
    }
    await fetch(`${BASE}/plugins/${pluginId}/permissions/revoke`, {
      method: "POST",
    });
  },

  async getPluginStore(): Promise<{ plugins: StorePluginInfo[] }> {
    if (isTauri()) {
      // Plugin store not available in Tauri mode (deferred)
      return { plugins: [] };
    }
    const res = await fetch(`${BASE}/plugins/store`);
    return res.json();
  },

  async installPlugin(pluginId: string, downloadUrl: string): Promise<void> {
    if (isTauri()) {
      throw new Error("Plugin install not available in desktop mode");
    }
    const res = await fetch(`${BASE}/plugins/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pluginId, downloadUrl }),
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error ?? "Install failed");
    }
  },

  async uninstallPlugin(pluginId: string): Promise<void> {
    if (isTauri()) {
      throw new Error("Plugin uninstall not available in desktop mode");
    }
    const res = await fetch(`${BASE}/plugins/${pluginId}/uninstall`, {
      method: "POST",
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error ?? "Uninstall failed");
    }
  },

  // AI APIs

  async listAIProviders(): Promise<AIProviderInfo[]> {
    if (isTauri()) {
      // Return built-in providers for Tauri mode
      return [
        {
          name: "openai",
          displayName: "OpenAI",
          needsApiKey: true,
          defaultModel: "gpt-4o",
          showBaseUrl: false,
          pluginId: null,
        },
        {
          name: "anthropic",
          displayName: "Anthropic",
          needsApiKey: true,
          defaultModel: "claude-sonnet-4-5-20250929",
          showBaseUrl: false,
          pluginId: null,
        },
        {
          name: "openrouter",
          displayName: "OpenRouter",
          needsApiKey: true,
          defaultModel: "anthropic/claude-sonnet-4-5-20250929",
          showBaseUrl: false,
          pluginId: null,
        },
        {
          name: "ollama",
          displayName: "Ollama (local)",
          needsApiKey: false,
          defaultModel: "llama3.2",
          defaultBaseUrl: "http://localhost:11434",
          showBaseUrl: true,
          pluginId: null,
        },
        {
          name: "lmstudio",
          displayName: "LM Studio (local)",
          needsApiKey: false,
          defaultModel: "default",
          defaultBaseUrl: "http://localhost:1234",
          showBaseUrl: true,
          pluginId: null,
        },
      ];
    }
    const res = await fetch(`${BASE}/ai/providers`);
    return res.json();
  },

  async getAIConfig(): Promise<AIConfigInfo> {
    if (isTauri()) {
      const svc = await getServices();
      const providerSetting = svc.queries.getAppSetting("ai_provider");
      const modelSetting = svc.queries.getAppSetting("ai_model");
      const baseUrlSetting = svc.queries.getAppSetting("ai_base_url");
      const apiKeySetting = svc.queries.getAppSetting("ai_api_key");
      return {
        provider: providerSetting?.value ?? null,
        model: modelSetting?.value ?? null,
        baseUrl: baseUrlSetting?.value ?? null,
        hasApiKey: !!apiKeySetting?.value,
      };
    }
    const res = await fetch(`${BASE}/ai/config`);
    return res.json();
  },

  async updateAIConfig(config: {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  }): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      if (config.provider) svc.queries.setAppSetting("ai_provider", config.provider);
      if (config.apiKey) svc.queries.setAppSetting("ai_api_key", config.apiKey);
      if (config.model !== undefined) {
        if (config.model) {
          svc.queries.setAppSetting("ai_model", config.model);
        } else {
          svc.queries.deleteAppSetting("ai_model");
        }
      }
      if (config.baseUrl !== undefined) {
        if (config.baseUrl) {
          svc.queries.setAppSetting("ai_base_url", config.baseUrl);
        } else {
          svc.queries.deleteAppSetting("ai_base_url");
        }
      }
      svc.chatManager.clearSession(svc.queries);
      svc.save();
      return;
    }
    await fetch(`${BASE}/ai/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
  },

  async sendChatMessage(message: string): Promise<ReadableStream<Uint8Array> | null> {
    if (isTauri()) {
      const svc = await getServices();
      const providerSetting = svc.queries.getAppSetting("ai_provider");
      if (!providerSetting?.value) {
        // Return a stream with an error event, matching SSE format
        const encoder = new TextEncoder();
        return new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "error", data: "No AI provider configured. Go to Settings to set one up." })}\n\n`,
              ),
            );
            controller.close();
          },
        });
      }

      try {
        const { createProvider } = await import("../ai/provider.js");
        const { gatherContext } = await import("../ai/chat.js");
        const apiKeySetting = svc.queries.getAppSetting("ai_api_key");
        const modelSetting = svc.queries.getAppSetting("ai_model");
        const baseUrlSetting = svc.queries.getAppSetting("ai_base_url");

        const provider = createProvider({
          provider: providerSetting.value as
            | "openai"
            | "anthropic"
            | "openrouter"
            | "ollama"
            | "lmstudio",
          apiKey: apiKeySetting?.value,
          model: modelSetting?.value,
          baseUrl: baseUrlSetting?.value,
        });

        const toolServices = {
          taskService: svc.taskService,
          projectService: svc.projectService,
        };

        const contextBlock = await gatherContext(toolServices);
        const session = svc.chatManager.getOrCreateSession(
          provider,
          toolServices,
          svc.queries,
          contextBlock,
        );

        session.addUserMessage(message);

        const encoder = new TextEncoder();
        return new ReadableStream({
          async start(controller) {
            try {
              for await (const event of session.run()) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              }
            } catch (err: unknown) {
              const errorMsg = err instanceof Error ? err.message : "Unknown error";
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "error", data: errorMsg })}\n\n`),
              );
            }
            svc.save();
            controller.close();
          },
        });
      } catch (err: unknown) {
        const encoder = new TextEncoder();
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        return new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "error", data: errorMsg })}\n\n`),
            );
            controller.close();
          },
        });
      }
    }

    const res = await fetch(`${BASE}/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    return res.body;
  },

  async getChatMessages(): Promise<AIChatMessage[]> {
    if (isTauri()) {
      const svc = await getServices();
      let session = svc.chatManager.getSession();

      if (!session) {
        try {
          const providerSetting = svc.queries.getAppSetting("ai_provider");
          if (providerSetting?.value) {
            const { createProvider } = await import("../ai/provider.js");
            const apiKeySetting = svc.queries.getAppSetting("ai_api_key");
            const modelSetting = svc.queries.getAppSetting("ai_model");
            const baseUrlSetting = svc.queries.getAppSetting("ai_base_url");

            const provider = createProvider({
              provider: providerSetting.value as
                | "openai"
                | "anthropic"
                | "openrouter"
                | "ollama"
                | "lmstudio",
              apiKey: apiKeySetting?.value,
              model: modelSetting?.value,
              baseUrl: baseUrlSetting?.value,
            });

            session = svc.chatManager.restoreSession(
              provider,
              { taskService: svc.taskService, projectService: svc.projectService },
              svc.queries,
            );
          }
        } catch {
          // Non-critical
        }
      }

      return session ? (session.getMessages() as AIChatMessage[]) : [];
    }

    const res = await fetch(`${BASE}/ai/messages`);
    return res.json();
  },

  async clearChat(): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      svc.chatManager.clearSession(svc.queries);
      svc.save();
      return;
    }
    await fetch(`${BASE}/ai/clear`, { method: "POST" });
  },

  async exportAllData(): Promise<{
    tasks: Task[];
    projects: Project[];
    tags: { id: string; name: string; color: string }[];
  }> {
    if (isTauri()) {
      const svc = await getServices();
      const tasks = await svc.taskService.list();
      const projects = await svc.projectService.list();
      const tags = svc.queries.listTags();
      return { tasks, projects, tags };
    }
    const [tasks, projects] = await Promise.all([api.listTasks(), api.listProjects()]);
    // Tags are embedded in tasks, extract unique ones
    const tagMap = new Map<string, { id: string; name: string; color: string }>();
    for (const task of tasks) {
      for (const tag of task.tags) {
        tagMap.set(tag.id, tag);
      }
    }
    return { tasks, projects, tags: Array.from(tagMap.values()) };
  },

  async getAppSetting(key: string): Promise<string | null> {
    if (isTauri()) {
      const svc = await getServices();
      const row = svc.queries.getAppSetting(key);
      return row?.value ?? null;
    }
    const res = await fetch(`${BASE}/settings/${key}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.value ?? null;
  },

  async setAppSetting(key: string, value: string): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      svc.queries.setAppSetting(key, value);
      svc.save();
      return;
    }
    await fetch(`${BASE}/settings/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  },
};

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  enabled: boolean;
  permissions: string[];
  settings: SettingDefinitionInfo[];
}

export interface SettingDefinitionInfo {
  id: string;
  name: string;
  type: "text" | "number" | "boolean" | "select";
  default: unknown;
  description?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  options?: string[];
}

export interface PluginCommandInfo {
  id: string;
  name: string;
  hotkey?: string;
}

export interface StatusBarItemInfo {
  id: string;
  text: string;
  icon: string;
}

export interface PanelInfo {
  id: string;
  title: string;
  icon: string;
  content: string;
}

export interface ViewInfo {
  id: string;
  name: string;
  icon: string;
}

export interface StorePluginInfo {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  repository: string;
  downloadUrl?: string;
  tags: string[];
  minDocketVersion: string;
}

export interface AIConfigInfo {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  hasApiKey: boolean;
}

export interface AIChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
}

export interface AIProviderInfo {
  name: string;
  displayName: string;
  needsApiKey: boolean;
  defaultModel: string;
  defaultBaseUrl?: string;
  showBaseUrl?: boolean;
  pluginId: string | null;
}
