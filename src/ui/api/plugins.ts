import { isTauri, BASE, handleResponse, handleVoidResponse, getServices } from "./helpers.js";

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  enabled: boolean;
  permissions: string[];
  settings: SettingDefinitionInfo[];
  builtin: boolean;
  icon?: string;
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
  contentType?: "text" | "react";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component?: (props: any) => any;
}

export interface ViewInfo {
  id: string;
  name: string;
  icon: string;
  slot: "navigation" | "tools" | "workspace";
  contentType: "text" | "structured" | "react";
  pluginId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component?: (props: any) => any;
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
  minSaydoVersion: string;
  icon?: string;
  downloads?: number;
  longDescription?: string;
}

export async function listPlugins(): Promise<PluginInfo[]> {
  if (isTauri()) {
    // No plugin loader in Tauri mode (deferred)
    return [];
  }
  const res = await fetch(`${BASE}/plugins`);
  return handleResponse<PluginInfo[]>(res);
}

export async function getPluginSettings(pluginId: string): Promise<Record<string, unknown>> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.settingsManager.getAll(pluginId);
  }
  const res = await fetch(`${BASE}/plugins/${pluginId}/settings`);
  return handleResponse<Record<string, unknown>>(res);
}

export async function updatePluginSetting(
  pluginId: string,
  key: string,
  value: unknown,
): Promise<void> {
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
}

export async function listPluginCommands(): Promise<PluginCommandInfo[]> {
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
}

export async function executePluginCommand(id: string): Promise<void> {
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
}

export async function getStatusBarItems(): Promise<StatusBarItemInfo[]> {
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
}

export async function getPluginPanels(): Promise<PanelInfo[]> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.uiRegistry.getPanels().map((panel) => ({
      id: panel.id,
      title: panel.title,
      icon: panel.icon,
      content: svc.uiRegistry.getPanelContent(panel.id) ?? "",
      contentType: panel.contentType,
      component: panel.component,
    }));
  }
  const res = await fetch(`${BASE}/plugins/ui/panels`);
  return handleResponse<PanelInfo[]>(res);
}

export async function getPluginViews(): Promise<ViewInfo[]> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.uiRegistry.getViews().map((view) => ({
      id: view.id,
      name: view.name,
      icon: view.icon,
      slot: view.slot,
      contentType: view.contentType,
      pluginId: view.pluginId,
      component: view.component,
    }));
  }
  const res = await fetch(`${BASE}/plugins/ui/views`);
  return handleResponse<ViewInfo[]>(res);
}

export async function getPluginViewContent(viewId: string): Promise<string> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.uiRegistry.getViewContent(viewId) ?? "";
  }
  const res = await fetch(`${BASE}/plugins/ui/views/${encodeURIComponent(viewId)}/content`);
  const data = await handleResponse<{ content: string }>(res);
  return data.content;
}

export async function getPluginPermissions(pluginId: string): Promise<string[] | null> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.storage.getPluginPermissions(pluginId);
  }
  const res = await fetch(`${BASE}/plugins/${pluginId}/permissions`);
  const data = await handleResponse<{ permissions: string[] | null }>(res);
  return data.permissions;
}

export async function approvePluginPermissions(
  pluginId: string,
  permissions: string[],
): Promise<void> {
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
}

export async function revokePluginPermissions(pluginId: string): Promise<void> {
  if (isTauri()) {
    // Not yet supported in Tauri mode
    return;
  }
  await handleVoidResponse(
    await fetch(`${BASE}/plugins/${pluginId}/permissions/revoke`, {
      method: "POST",
    }),
  );
}

export async function getPluginStore(): Promise<{ plugins: StorePluginInfo[] }> {
  if (isTauri()) {
    // Plugin store not available in Tauri mode (deferred)
    return { plugins: [] };
  }
  const res = await fetch(`${BASE}/plugins/store`);
  return handleResponse<{ plugins: StorePluginInfo[] }>(res);
}

export async function installPlugin(pluginId: string, downloadUrl: string): Promise<void> {
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
}

export async function uninstallPlugin(pluginId: string): Promise<void> {
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
}

export async function togglePlugin(pluginId: string): Promise<void> {
  if (isTauri()) {
    // Not yet supported in Tauri mode
    return;
  }
  await handleVoidResponse(
    await fetch(`${BASE}/plugins/${pluginId}/toggle`, {
      method: "POST",
    }),
  );
}
