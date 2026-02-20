import type {
  Task,
  TaskTemplate,
  CreateTemplateInput,
  UpdateTemplateInput,
} from "../../core/types.js";
import { isTauri, BASE, handleResponse, handleVoidResponse, getServices } from "./helpers.js";

export async function listTemplates(): Promise<TaskTemplate[]> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.templateService.list();
  }
  const res = await fetch(`${BASE}/templates`);
  return handleResponse<TaskTemplate[]>(res);
}

export async function createTemplate(input: CreateTemplateInput): Promise<TaskTemplate> {
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
}

export async function updateTemplate(
  id: string,
  input: UpdateTemplateInput,
): Promise<TaskTemplate> {
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
}

export async function deleteTemplate(id: string): Promise<void> {
  if (isTauri()) {
    const svc = await getServices();
    await svc.templateService.delete(id);
    svc.save();
    return;
  }
  await handleVoidResponse(await fetch(`${BASE}/templates/${id}`, { method: "DELETE" }));
}

export async function instantiateTemplate(
  id: string,
  variables?: Record<string, string>,
): Promise<Task> {
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
}
