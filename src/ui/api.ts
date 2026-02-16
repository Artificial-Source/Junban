import type {
  Task,
  CreateTaskInput,
  UpdateTaskInput,
  Project,
  TaskTemplate,
  CreateTemplateInput,
  UpdateTemplateInput,
} from "../core/types.js";
import type { TaskFilter } from "../core/filters.js";
import type { ImportedTask, ImportResult } from "../core/import.js";

import { isTauri } from "../utils/tauri.js";

const BASE = "/api";

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      // Use status code message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function handleVoidResponse(res: Response): Promise<void> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      // Use status code message
    }
    throw new Error(message);
  }
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
    return handleResponse<Task[]>(res);
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
    return handleResponse<Task>(res);
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
    return handleResponse<Task>(res);
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
    return handleResponse<Task>(res);
  },

  async deleteTask(id: string): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      await svc.taskService.delete(id);
      svc.save();
      return;
    }
    await handleVoidResponse(await fetch(`${BASE}/tasks/${id}`, { method: "DELETE" }));
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
    return handleResponse<Task[]>(res);
  },

  async deleteManyTasks(ids: string[]): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      await svc.taskService.deleteMany(ids);
      svc.save();
      return;
    }
    await handleVoidResponse(
      await fetch(`${BASE}/tasks/bulk/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      }),
    );
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
    return handleResponse<Task[]>(res);
  },

  async listTaskTree(): Promise<Task[]> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.taskService.listTree();
    }
    const res = await fetch(`${BASE}/tasks/tree`);
    return handleResponse<Task[]>(res);
  },

  async getChildren(parentId: string): Promise<Task[]> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.taskService.getChildren(parentId);
    }
    const res = await fetch(`${BASE}/tasks/${parentId}/children`);
    return handleResponse<Task[]>(res);
  },

  async indentTask(id: string): Promise<Task> {
    if (isTauri()) {
      const svc = await getServices();
      const task = await svc.taskService.indent(id);
      svc.save();
      return task;
    }
    const res = await fetch(`${BASE}/tasks/${id}/indent`, { method: "POST" });
    return handleResponse<Task>(res);
  },

  async outdentTask(id: string): Promise<Task> {
    if (isTauri()) {
      const svc = await getServices();
      const task = await svc.taskService.outdent(id);
      svc.save();
      return task;
    }
    const res = await fetch(`${BASE}/tasks/${id}/outdent`, { method: "POST" });
    return handleResponse<Task>(res);
  },

  async reorderTasks(orderedIds: string[]): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      await svc.taskService.reorder(orderedIds);
      svc.save();
      return;
    }
    await handleVoidResponse(
      await fetch(`${BASE}/tasks/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds }),
      }),
    );
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
    return handleResponse<ImportResult>(res);
  },

  // ── Templates ──

  async listTemplates(): Promise<TaskTemplate[]> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.templateService.list();
    }
    const res = await fetch(`${BASE}/templates`);
    return handleResponse<TaskTemplate[]>(res);
  },

  async createTemplate(input: CreateTemplateInput): Promise<TaskTemplate> {
    if (isTauri()) {
      const svc = await getServices();
      const template = await svc.templateService.create(input);
      svc.save();
      return template;
    }
    const res = await fetch(`${BASE}/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return handleResponse<TaskTemplate>(res);
  },

  async updateTemplate(id: string, input: UpdateTemplateInput): Promise<TaskTemplate> {
    if (isTauri()) {
      const svc = await getServices();
      const template = await svc.templateService.update(id, input);
      svc.save();
      return template;
    }
    const res = await fetch(`${BASE}/templates/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return handleResponse<TaskTemplate>(res);
  },

  async deleteTemplate(id: string): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      await svc.templateService.delete(id);
      svc.save();
      return;
    }
    await handleVoidResponse(await fetch(`${BASE}/templates/${id}`, { method: "DELETE" }));
  },

  async instantiateTemplate(id: string, variables?: Record<string, string>): Promise<Task> {
    if (isTauri()) {
      const svc = await getServices();
      const task = await svc.templateService.instantiate(id, variables);
      svc.save();
      return task;
    }
    const res = await fetch(`${BASE}/templates/${id}/instantiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variables: variables ?? {} }),
    });
    return handleResponse<Task>(res);
  },

  async listTags(): Promise<{ id: string; name: string; color: string }[]> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.tagService.list();
    }
    const res = await fetch(`${BASE}/tags`);
    return handleResponse<{ id: string; name: string; color: string }[]>(res);
  },

  async listProjects(): Promise<Project[]> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.projectService.list();
    }
    const res = await fetch(`${BASE}/projects`);
    return handleResponse<Project[]>(res);
  },

  // Plugin APIs

  async listPlugins(): Promise<PluginInfo[]> {
    if (isTauri()) {
      // No plugin loader in Tauri mode (deferred)
      return [];
    }
    const res = await fetch(`${BASE}/plugins`);
    return handleResponse<PluginInfo[]>(res);
  },

  async getPluginSettings(pluginId: string): Promise<Record<string, unknown>> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.settingsManager.getAll(pluginId);
    }
    const res = await fetch(`${BASE}/plugins/${pluginId}/settings`);
    return handleResponse<Record<string, unknown>>(res);
  },

  async updatePluginSetting(pluginId: string, key: string, value: unknown): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      await svc.settingsManager.set(pluginId, key, value);
      svc.save();
      return;
    }
    await handleVoidResponse(
      await fetch(`${BASE}/plugins/${pluginId}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      }),
    );
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
    return handleResponse<PluginCommandInfo[]>(res);
  },

  async executePluginCommand(id: string): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      svc.commandRegistry.execute(id);
      return;
    }
    await handleVoidResponse(
      await fetch(`${BASE}/plugins/commands/${encodeURIComponent(id)}`, {
        method: "POST",
      }),
    );
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
    return handleResponse<StatusBarItemInfo[]>(res);
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
    return handleResponse<PanelInfo[]>(res);
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
    return handleResponse<ViewInfo[]>(res);
  },

  async getPluginViewContent(viewId: string): Promise<string> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.uiRegistry.getViewContent(viewId) ?? "";
    }
    const res = await fetch(`${BASE}/plugins/ui/views/${encodeURIComponent(viewId)}/content`);
    const data = await handleResponse<{ content: string }>(res);
    return data.content;
  },

  async getPluginPermissions(pluginId: string): Promise<string[] | null> {
    if (isTauri()) {
      const svc = await getServices();
      return svc.storage.getPluginPermissions(pluginId);
    }
    const res = await fetch(`${BASE}/plugins/${pluginId}/permissions`);
    const data = await handleResponse<{ permissions: string[] | null }>(res);
    return data.permissions;
  },

  async approvePluginPermissions(pluginId: string, permissions: string[]): Promise<void> {
    if (isTauri()) {
      // Not yet supported in Tauri mode
      return;
    }
    await handleVoidResponse(
      await fetch(`${BASE}/plugins/${pluginId}/permissions/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions }),
      }),
    );
  },

  async revokePluginPermissions(pluginId: string): Promise<void> {
    if (isTauri()) {
      // Not yet supported in Tauri mode
      return;
    }
    await handleVoidResponse(
      await fetch(`${BASE}/plugins/${pluginId}/permissions/revoke`, {
        method: "POST",
      }),
    );
  },

  async getPluginStore(): Promise<{ plugins: StorePluginInfo[] }> {
    if (isTauri()) {
      // Plugin store not available in Tauri mode (deferred)
      return { plugins: [] };
    }
    const res = await fetch(`${BASE}/plugins/store`);
    return handleResponse<{ plugins: StorePluginInfo[] }>(res);
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
    const data = await handleResponse<{ success: boolean; error?: string }>(res);
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
    const data = await handleResponse<{ success: boolean; error?: string }>(res);
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
          suggestedModels: ["liquid/lfm2.5-1.2b", "liquid/lfm2-1.2b"],
          defaultBaseUrl: "http://localhost:1234/v1",
          showBaseUrl: true,
          pluginId: null,
        },
      ];
    }
    const res = await fetch(`${BASE}/ai/providers`);
    return handleResponse<AIProviderInfo[]>(res);
  },

  async fetchModels(providerName: string, baseUrl?: string): Promise<ModelDiscoveryInfo[]> {
    if (isTauri()) {
      const svc = await getServices();
      const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
      const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
      const { fetchAvailableModels } = await import("../ai/model-discovery.js");
      return fetchAvailableModels(providerName, {
        apiKey: apiKeySetting?.value,
        baseUrl: baseUrl || baseUrlSetting?.value,
      });
    }
    const url = new URL(`${BASE}/ai/providers/${encodeURIComponent(providerName)}/models`, window.location.origin);
    if (baseUrl) url.searchParams.set("baseUrl", baseUrl);
    const res = await fetch(url.toString());
    const data = await handleResponse<{ models: ModelDiscoveryInfo[] }>(res);
    return data.models;
  },

  async loadModel(providerName: string, modelKey: string, baseUrl?: string): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
      if (providerName === "lmstudio") {
        const { loadLMStudioModel } = await import("../ai/model-discovery.js");
        await loadLMStudioModel(modelKey, baseUrl || baseUrlSetting?.value || "http://localhost:1234/v1");
      }
      return;
    }
    await handleVoidResponse(
      await fetch(`${BASE}/ai/providers/${encodeURIComponent(providerName)}/models/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelKey, baseUrl }),
      }),
    );
  },

  async getAIConfig(): Promise<AIConfigInfo> {
    if (isTauri()) {
      const svc = await getServices();
      const providerSetting = svc.storage.getAppSetting("ai_provider");
      const modelSetting = svc.storage.getAppSetting("ai_model");
      const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
      const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
      return {
        provider: providerSetting?.value ?? null,
        model: modelSetting?.value ?? null,
        baseUrl: baseUrlSetting?.value ?? null,
        hasApiKey: !!apiKeySetting?.value,
      };
    }
    const res = await fetch(`${BASE}/ai/config`);
    return handleResponse<AIConfigInfo>(res);
  },

  async updateAIConfig(config: {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  }): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      if (config.provider) svc.storage.setAppSetting("ai_provider", config.provider);
      if (config.apiKey) svc.storage.setAppSetting("ai_api_key", config.apiKey);
      if (config.model !== undefined) {
        if (config.model) {
          svc.storage.setAppSetting("ai_model", config.model);
        } else {
          svc.storage.deleteAppSetting("ai_model");
        }
      }
      if (config.baseUrl !== undefined) {
        if (config.baseUrl) {
          svc.storage.setAppSetting("ai_base_url", config.baseUrl);
        } else {
          svc.storage.deleteAppSetting("ai_base_url");
        }
      }
      svc.chatManager.clearSession(svc.storage);
      svc.save();
      return;
    }
    await handleVoidResponse(
      await fetch(`${BASE}/ai/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      }),
    );
  },

  async sendChatMessage(message: string): Promise<ReadableStream<Uint8Array> | null> {
    if (isTauri()) {
      const svc = await getServices();
      const providerSetting = svc.storage.getAppSetting("ai_provider");
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
        const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
        const modelSetting = svc.storage.getAppSetting("ai_model");
        const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

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
          svc.storage,
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
          const providerSetting = svc.storage.getAppSetting("ai_provider");
          if (providerSetting?.value) {
            const { createProvider } = await import("../ai/provider.js");
            const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
            const modelSetting = svc.storage.getAppSetting("ai_model");
            const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

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
              svc.storage,
            );
          }
        } catch {
          // Non-critical
        }
      }

      return session ? (session.getMessages() as AIChatMessage[]) : [];
    }

    const res = await fetch(`${BASE}/ai/messages`);
    return handleResponse<AIChatMessage[]>(res);
  },

  async clearChat(): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      svc.chatManager.clearSession(svc.storage);
      svc.save();
      return;
    }
    await handleVoidResponse(await fetch(`${BASE}/ai/clear`, { method: "POST" }));
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
      const tags = svc.storage.listTags();
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
      const row = svc.storage.getAppSetting(key);
      return row?.value ?? null;
    }
    const res = await fetch(`${BASE}/settings/${key}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.value ?? null;
  },

  async getStorageInfo(): Promise<{ mode: string; path: string }> {
    if (isTauri()) {
      // Tauri always uses SQLite
      return { mode: "sqlite", path: "(embedded database)" };
    }
    const res = await fetch(`${BASE}/settings/storage`);
    return handleResponse<{ mode: string; path: string }>(res);
  },

  async setAppSetting(key: string, value: string): Promise<void> {
    if (isTauri()) {
      const svc = await getServices();
      svc.storage.setAppSetting(key, value);
      svc.save();
      return;
    }
    await handleVoidResponse(
      await fetch(`${BASE}/settings/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      }),
    );
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
  isError?: boolean;
  errorCategory?: string;
  retryable?: boolean;
}

export interface AIProviderInfo {
  name: string;
  displayName: string;
  needsApiKey: boolean;
  defaultModel: string;
  suggestedModels?: string[];
  defaultBaseUrl?: string;
  showBaseUrl?: boolean;
  pluginId: string | null;
}

export interface ModelDiscoveryInfo {
  id: string;
  label: string;
  loaded: boolean;
}
