import type { Task } from "./types.js";

export interface TaskFilter {
  status?: "pending" | "completed" | "cancelled";
  projectId?: string;
  /** Project name for query-parser resolution (caller resolves to projectId). */
  projectName?: string;
  tag?: string;
  priority?: number;
  dueBefore?: string;
  dueAfter?: string;
  search?: string;
}

/** Filter tasks by the given criteria. */
export function filterTasks(tasks: Task[], filter: TaskFilter): Task[] {
  return tasks.filter((task) => {
    if (filter.status && task.status !== filter.status) return false;
    if (filter.projectId && task.projectId !== filter.projectId) return false;
    if (filter.tag && !task.tags.some((t) => t.name === filter.tag)) return false;
    if (filter.priority && task.priority !== filter.priority) return false;
    if (filter.dueBefore && (!task.dueDate || task.dueDate > filter.dueBefore)) return false;
    if (filter.dueAfter && (!task.dueDate || task.dueDate < filter.dueAfter)) return false;
    if (filter.search) {
      const q = filter.search.toLowerCase();
      if (!task.title.toLowerCase().includes(q) && !task.description?.toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  });
}
