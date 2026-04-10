import type { ImportedTask, ImportResult } from "./import.js";

interface ImportTaskService {
  create(input: {
    title: string;
    description?: string;
    priority: number | null;
    dueDate?: string;
    dueTime: boolean;
    projectId?: string;
    recurrence?: string;
    tags: string[];
  }): Promise<{ id: string }>;
  complete(id: string): Promise<unknown>;
  delete(id: string): Promise<unknown>;
}

interface ImportProjectService {
  getByName(name: string): Promise<{ id: string } | null>;
  create(name: string): Promise<{ id: string }>;
  delete(id: string): Promise<boolean>;
}

export interface ImportExecutionServices {
  taskService: ImportTaskService;
  projectService: ImportProjectService;
}

function messageForError(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

/**
 * Execute imports with rollback safety.
 *
 * Behavior:
 * - all imported tasks are created/updated as one logical unit
 * - on the first failure, previously created tasks/projects in this run are rolled back
 * - result is either full success or failure with `imported: 0`
 */
export async function importTasksWithRollback(
  services: ImportExecutionServices,
  importedTasks: ImportedTask[],
): Promise<ImportResult> {
  const createdTaskIds: string[] = [];
  const createdProjectIds: string[] = [];
  const projectIdByName = new Map<string, string>();

  try {
    for (const t of importedTasks) {
      let projectId: string | undefined;

      if (t.projectName) {
        const cached = projectIdByName.get(t.projectName);
        if (cached) {
          projectId = cached;
        } else {
          const existing = await services.projectService.getByName(t.projectName);
          if (existing) {
            projectId = existing.id;
          } else {
            const created = await services.projectService.create(t.projectName);
            projectId = created.id;
            createdProjectIds.push(created.id);
          }
          projectIdByName.set(t.projectName, projectId);
        }
      }

      const task = await services.taskService.create({
        title: t.title,
        description: t.description ?? undefined,
        priority: t.priority,
        dueDate: t.dueDate ?? undefined,
        dueTime: t.dueTime,
        projectId,
        recurrence: t.recurrence ?? undefined,
        tags: t.tagNames,
      });
      createdTaskIds.push(task.id);

      if (t.status === "completed") {
        await services.taskService.complete(task.id);
      }
    }

    return { imported: importedTasks.length, errors: [] };
  } catch (err) {
    const rollbackErrors: string[] = [];

    for (const taskId of createdTaskIds.reverse()) {
      try {
        await services.taskService.delete(taskId);
      } catch (rollbackErr) {
        rollbackErrors.push(`Failed to rollback task ${taskId}: ${messageForError(rollbackErr)}`);
      }
    }

    for (const projectId of createdProjectIds.reverse()) {
      try {
        await services.projectService.delete(projectId);
      } catch (rollbackErr) {
        rollbackErrors.push(
          `Failed to rollback project ${projectId}: ${messageForError(rollbackErr)}`,
        );
      }
    }

    return {
      imported: 0,
      errors: [`Import aborted and rolled back: ${messageForError(err)}`, ...rollbackErrors],
    };
  }
}
