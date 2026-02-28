import type { UndoableAction } from "./undo.js";
import type { Task, CreateTaskInput, UpdateTaskInput } from "./types.js";

interface ActionAPI {
  completeTask: (id: string) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  updateTask: (id: string, input: UpdateTaskInput) => Promise<Task>;
  createTask: (input: CreateTaskInput) => Promise<Task>;
  completeManyTasks: (ids: string[]) => Promise<void>;
  deleteManyTasks: (ids: string[]) => Promise<void>;
  updateManyTasks: (ids: string[], changes: UpdateTaskInput) => Promise<Task[]>;
  refreshTasks: () => Promise<void>;
}

export function createCompleteAction(api: ActionAPI, task: Task): UndoableAction {
  return {
    description: `Complete "${task.title}"`,
    async execute() {
      await api.completeTask(task.id);
    },
    async undo() {
      await api.updateTask(task.id, { status: "pending", completedAt: null });
      await api.refreshTasks();
    },
  };
}

export function createDeleteAction(api: ActionAPI, task: Task): UndoableAction {
  return {
    description: `Delete "${task.title}"`,
    async execute() {
      await api.deleteTask(task.id);
    },
    async undo() {
      await api.createTask({
        title: task.title,
        description: task.description,
        priority: task.priority,
        dueDate: task.dueDate,
        dueTime: task.dueTime,
        projectId: task.projectId,
        recurrence: task.recurrence,
        parentId: task.parentId,
        remindAt: task.remindAt,
        estimatedMinutes: task.estimatedMinutes,
        actualMinutes: task.actualMinutes,
        deadline: task.deadline,
        isSomeday: task.isSomeday,
        sectionId: task.sectionId,
        tags: task.tags.map((t) => t.name),
      });
      await api.refreshTasks();
    },
  };
}

export function createUpdateAction(
  api: ActionAPI,
  id: string,
  oldFields: UpdateTaskInput,
  newFields: UpdateTaskInput,
): UndoableAction {
  return {
    description: "Update task",
    async execute() {
      await api.updateTask(id, newFields);
    },
    async undo() {
      await api.updateTask(id, oldFields);
    },
  };
}

export function createBulkCompleteAction(api: ActionAPI, tasks: Task[]): UndoableAction {
  const ids = tasks.map((t) => t.id);
  return {
    description: `Complete ${tasks.length} tasks`,
    async execute() {
      await api.completeManyTasks(ids);
    },
    async undo() {
      for (const id of ids) {
        await api.updateTask(id, { status: "pending", completedAt: null });
      }
      await api.refreshTasks();
    },
  };
}

export function createBulkDeleteAction(api: ActionAPI, tasks: Task[]): UndoableAction {
  return {
    description: `Delete ${tasks.length} tasks`,
    async execute() {
      await api.deleteManyTasks(tasks.map((t) => t.id));
    },
    async undo() {
      for (const task of tasks) {
        await api.createTask({
          title: task.title,
          description: task.description,
          priority: task.priority,
          dueDate: task.dueDate,
          dueTime: task.dueTime,
          projectId: task.projectId,
          recurrence: task.recurrence,
          parentId: task.parentId,
          remindAt: task.remindAt,
          estimatedMinutes: task.estimatedMinutes,
          actualMinutes: task.actualMinutes,
          deadline: task.deadline,
          isSomeday: task.isSomeday,
          sectionId: task.sectionId,
          tags: task.tags.map((t) => t.name),
        });
      }
      await api.refreshTasks();
    },
  };
}

export function createBulkUpdateAction(
  api: ActionAPI,
  tasks: Task[],
  newFields: UpdateTaskInput,
): UndoableAction {
  const ids = tasks.map((t) => t.id);
  // Snapshot old fields for each task so we can restore
  const oldSnapshots = tasks.map((t) => ({
    id: t.id,
    fields: {
      title: t.title,
      description: t.description,
      priority: t.priority,
      dueDate: t.dueDate,
      dueTime: t.dueTime,
      projectId: t.projectId,
      tags: t.tags.map((tag) => tag.name),
    } as UpdateTaskInput,
  }));

  return {
    description: `Update ${tasks.length} tasks`,
    async execute() {
      await api.updateManyTasks(ids, newFields);
    },
    async undo() {
      for (const snapshot of oldSnapshots) {
        await api.updateTask(snapshot.id, snapshot.fields);
      }
      await api.refreshTasks();
    },
  };
}
