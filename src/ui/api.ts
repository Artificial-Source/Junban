import type { Task, CreateTaskInput, UpdateTaskInput, Project } from "../core/types.js";

const BASE = "/api";

export const api = {
  async listTasks(params?: { search?: string; projectId?: string; status?: string }): Promise<Task[]> {
    const url = new URL(`${BASE}/tasks`, window.location.origin);
    if (params?.search) url.searchParams.set("search", params.search);
    if (params?.projectId) url.searchParams.set("projectId", params.projectId);
    if (params?.status) url.searchParams.set("status", params.status);
    const res = await fetch(url.toString());
    return res.json();
  },

  async createTask(input: CreateTaskInput): Promise<Task> {
    const res = await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return res.json();
  },

  async completeTask(id: string): Promise<Task> {
    const res = await fetch(`${BASE}/tasks/${id}/complete`, {
      method: "POST",
    });
    return res.json();
  },

  async updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    const res = await fetch(`${BASE}/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return res.json();
  },

  async deleteTask(id: string): Promise<void> {
    await fetch(`${BASE}/tasks/${id}`, { method: "DELETE" });
  },

  async listProjects(): Promise<Project[]> {
    const res = await fetch(`${BASE}/projects`);
    return res.json();
  },

  // Plugin APIs

  async listPlugins(): Promise<PluginInfo[]> {
    const res = await fetch(`${BASE}/plugins`);
    return res.json();
  },

  async getPluginSettings(pluginId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE}/plugins/${pluginId}/settings`);
    return res.json();
  },

  async updatePluginSetting(pluginId: string, key: string, value: unknown): Promise<void> {
    await fetch(`${BASE}/plugins/${pluginId}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
  },

  async listPluginCommands(): Promise<PluginCommandInfo[]> {
    const res = await fetch(`${BASE}/plugins/commands`);
    return res.json();
  },

  async executePluginCommand(id: string): Promise<void> {
    await fetch(`${BASE}/plugins/commands/${encodeURIComponent(id)}`, {
      method: "POST",
    });
  },

  async getStatusBarItems(): Promise<StatusBarItemInfo[]> {
    const res = await fetch(`${BASE}/plugins/ui/status-bar`);
    return res.json();
  },

  async getPluginPanels(): Promise<PanelInfo[]> {
    const res = await fetch(`${BASE}/plugins/ui/panels`);
    return res.json();
  },

  async getPluginViews(): Promise<ViewInfo[]> {
    const res = await fetch(`${BASE}/plugins/ui/views`);
    return res.json();
  },

  async getPluginViewContent(viewId: string): Promise<string> {
    const res = await fetch(`${BASE}/plugins/ui/views/${encodeURIComponent(viewId)}/content`);
    const data = await res.json();
    return data.content;
  },

  async getPluginStore(): Promise<{ plugins: StorePluginInfo[] }> {
    const res = await fetch(`${BASE}/plugins/store`);
    return res.json();
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
  tags: string[];
  minDocketVersion: string;
}
