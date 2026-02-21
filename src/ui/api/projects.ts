import type { Project } from "../../core/types.js";
import { isTauri, BASE, handleResponse, handleVoidResponse, getServices } from "./helpers.js";

export async function listTags(): Promise<{ id: string; name: string; color: string }[]> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.tagService.list();
  }
  const res = await fetch(`${BASE}/tags`);
  return handleResponse<{ id: string; name: string; color: string }[]>(res);
}

export async function listProjects(): Promise<Project[]> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.projectService.list();
  }
  const res = await fetch(`${BASE}/projects`);
  return handleResponse<Project[]>(res);
}

export async function createProject(
  name: string,
  color?: string,
  icon?: string,
  parentId?: string | null,
  isFavorite?: boolean,
  viewStyle?: "list" | "board" | "calendar",
): Promise<Project> {
  if (isTauri()) {
    const svc = await getServices();
    const project = await svc.projectService.create(name, {
      color,
      parentId,
      isFavorite,
      viewStyle,
    });
    if (icon) {
      const updated = await svc.projectService.update(project.id, { icon });
      svc.save();
      return updated ?? project;
    }
    svc.save();
    return project;
  }
  const res = await fetch(`${BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, color, icon, parentId, isFavorite, viewStyle }),
  });
  return handleResponse<Project>(res);
}

export async function updateProject(
  id: string,
  data: Partial<
    Pick<Project, "name" | "color" | "icon" | "archived" | "parentId" | "isFavorite" | "viewStyle">
  >,
): Promise<Project | null> {
  if (isTauri()) {
    const svc = await getServices();
    const project = await svc.projectService.update(id, data);
    svc.save();
    return project;
  }
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return handleResponse<Project | null>(res);
}

export async function deleteProject(id: string): Promise<void> {
  if (isTauri()) {
    const svc = await getServices();
    await svc.projectService.delete(id);
    svc.save();
    return;
  }
  await handleVoidResponse(
    await fetch(`${BASE}/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  );
}
