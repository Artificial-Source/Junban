import type { Task, Project } from "../../core/types.js";
import {
  useDirectServices,
  BASE,
  handleResponse,
  handleVoidResponse,
  getServices,
} from "./helpers.js";
import { listTasks } from "./tasks.js";
import { listProjects } from "./projects.js";

export async function exportAllData(): Promise<{
  tasks: Task[];
  projects: Project[];
  tags: { id: string; name: string; color: string }[];
}> {
  if (useDirectServices()) {
    const svc = await getServices();
    const tasks = await svc.taskService.list();
    const projects = await svc.projectService.list();
    const tags = svc.storage.listTags();
    return { tasks, projects, tags };
  }
  const [tasks, projects] = await Promise.all([listTasks(), listProjects()]);
  // Tags are embedded in tasks, extract unique ones
  const tagMap = new Map<string, { id: string; name: string; color: string }>();
  for (const task of tasks) {
    for (const tag of task.tags) {
      tagMap.set(tag.id, tag);
    }
  }
  return { tasks, projects, tags: Array.from(tagMap.values()) };
}

export async function getAllSettings(): Promise<Record<string, string>> {
  if (useDirectServices()) {
    const svc = await getServices();
    const rows = svc.storage.listAllAppSettings();
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }
  const res = await fetch(`${BASE}/settings`);
  return handleResponse<Record<string, string>>(res);
}

export async function getAppSetting(key: string): Promise<string | null> {
  if (useDirectServices()) {
    const svc = await getServices();
    const row = svc.storage.getAppSetting(key);
    return row?.value ?? null;
  }
  const res = await fetch(`${BASE}/settings/${key}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.value ?? null;
}

export async function getStorageInfo(): Promise<{ mode: string; path: string }> {
  if (useDirectServices()) {
    // Tauri always uses SQLite
    return { mode: "sqlite", path: "(embedded database)" };
  }
  const res = await fetch(`${BASE}/settings/storage`);
  return handleResponse<{ mode: string; path: string }>(res);
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  if (useDirectServices()) {
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
}
