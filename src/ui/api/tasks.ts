import type { Task, CreateTaskInput, UpdateTaskInput } from "../../core/types.js";
import type { TaskFilter } from "../../core/filters.js";
import type { ImportedTask, ImportResult } from "../../core/import.js";
import { isTauri, BASE, handleResponse, handleVoidResponse, getServices } from "./helpers.js";

export async function listTasks(params?: {
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
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
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
}

export async function completeTask(id: string): Promise<Task> {
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
}

export async function updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
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
}

export async function deleteTask(id: string): Promise<void> {
  if (isTauri()) {
    const svc = await getServices();
    await svc.taskService.delete(id);
    svc.save();
    return;
  }
  await handleVoidResponse(await fetch(`${BASE}/tasks/${id}`, { method: "DELETE" }));
}

export async function completeManyTasks(ids: string[]): Promise<Task[]> {
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
}

export async function deleteManyTasks(ids: string[]): Promise<void> {
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
}

export async function updateManyTasks(ids: string[], changes: UpdateTaskInput): Promise<Task[]> {
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
}

export async function fetchDueReminders(): Promise<Task[]> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.taskService.getDueReminders();
  }
  const res = await fetch(`${BASE}/tasks/reminders/due`);
  return handleResponse<Task[]>(res);
}

export async function listTaskTree(): Promise<Task[]> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.taskService.listTree();
  }
  const res = await fetch(`${BASE}/tasks/tree`);
  return handleResponse<Task[]>(res);
}

export async function getChildren(parentId: string): Promise<Task[]> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.taskService.getChildren(parentId);
  }
  const res = await fetch(`${BASE}/tasks/${parentId}/children`);
  return handleResponse<Task[]>(res);
}

export async function indentTask(id: string): Promise<Task> {
  if (isTauri()) {
    const svc = await getServices();
    const task = await svc.taskService.indent(id);
    svc.save();
    return task;
  }
  const res = await fetch(`${BASE}/tasks/${id}/indent`, { method: "POST" });
  return handleResponse<Task>(res);
}

export async function outdentTask(id: string): Promise<Task> {
  if (isTauri()) {
    const svc = await getServices();
    const task = await svc.taskService.outdent(id);
    svc.save();
    return task;
  }
  const res = await fetch(`${BASE}/tasks/${id}/outdent`, { method: "POST" });
  return handleResponse<Task>(res);
}

export async function reorderTasks(orderedIds: string[]): Promise<void> {
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
}

export async function importTasks(tasks: ImportedTask[]): Promise<ImportResult> {
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
}

export async function listTaskRelations(): Promise<
  Array<{ taskId: string; relatedTaskId: string; type: "blocks" }>
> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.taskService.listAllRelations() as any;
  }
  const res = await fetch(`${BASE}/tasks/relations`);
  return handleResponse<Array<{ taskId: string; relatedTaskId: string; type: "blocks" }>>(res);
}

export async function getTaskRelations(
  taskId: string,
): Promise<{ blocks: Task[]; blockedBy: Task[] }> {
  if (isTauri()) {
    const svc = await getServices();
    const { blocks, blockedBy } = await svc.taskService.getRelations(taskId);
    const blocksTasks: Task[] = [];
    for (const id of blocks) {
      const t = await svc.taskService.get(id);
      if (t) blocksTasks.push(t);
    }
    const blockedByTasks: Task[] = [];
    for (const id of blockedBy) {
      const t = await svc.taskService.get(id);
      if (t) blockedByTasks.push(t);
    }
    return { blocks: blocksTasks, blockedBy: blockedByTasks };
  }
  const res = await fetch(`${BASE}/tasks/${encodeURIComponent(taskId)}/relations`);
  return handleResponse<{ blocks: Task[]; blockedBy: Task[] }>(res);
}

export async function addTaskRelation(
  taskId: string,
  relatedTaskId: string,
  type: "blocks" = "blocks",
): Promise<void> {
  if (isTauri()) {
    const svc = await getServices();
    await svc.taskService.addRelation(taskId, relatedTaskId, type);
    svc.save();
    return;
  }
  await handleVoidResponse(
    await fetch(`${BASE}/tasks/${encodeURIComponent(taskId)}/relations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relatedTaskId, type }),
    }),
  );
}

export async function removeTaskRelation(taskId: string, relatedTaskId: string): Promise<void> {
  if (isTauri()) {
    const svc = await getServices();
    await svc.taskService.removeRelation(taskId, relatedTaskId);
    svc.save();
    return;
  }
  await handleVoidResponse(
    await fetch(
      `${BASE}/tasks/${encodeURIComponent(taskId)}/relations/${encodeURIComponent(relatedTaskId)}`,
      { method: "DELETE" },
    ),
  );
}
