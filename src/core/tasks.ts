import type { CreateTaskInput, UpdateTaskInput, Task, Tag } from "./types.js";
import type { IStorage } from "../storage/interface.js";
import type { TagService } from "./tags.js";
import type { TaskFilter } from "./filters.js";
import type { EventBus } from "./event-bus.js";
import { filterTasks } from "./filters.js";
import { sortByPriority } from "./priorities.js";
import { generateId } from "../utils/ids.js";
import { NotFoundError } from "./errors.js";
import { getNextOccurrence } from "./recurrence.js";

/**
 * Task service — handles task CRUD operations.
 * This is the core of the application. Both UI and CLI use this module.
 */
export class TaskService {
  constructor(
    private queries: IStorage,
    private tagService: TagService,
    private eventBus?: EventBus,
  ) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const now = new Date().toISOString();
    const id = generateId();

    // Resolve tags: getOrCreate each tag name
    const tags: Tag[] = [];
    for (const tagName of input.tags ?? []) {
      const tag = await this.tagService.getOrCreate(tagName);
      tags.push(tag);
    }

    // Insert the task row
    this.queries.insertTask({
      id,
      title: input.title,
      description: input.description ?? null,
      status: "pending",
      priority: input.priority ?? null,
      dueDate: input.dueDate ?? null,
      dueTime: input.dueTime ?? false,
      completedAt: null,
      projectId: input.projectId ?? null,
      recurrence: input.recurrence ?? null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Insert task-tag associations
    for (const tag of tags) {
      this.queries.insertTaskTag(id, tag.id);
    }

    const task: Task = {
      id,
      title: input.title,
      description: input.description ?? null,
      status: "pending",
      priority: input.priority ?? null,
      dueDate: input.dueDate ?? null,
      dueTime: input.dueTime ?? false,
      completedAt: null,
      projectId: input.projectId ?? null,
      recurrence: input.recurrence ?? null,
      tags,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.eventBus?.emit("task:create", task);

    return task;
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    const rows = this.queries.listTasks();

    // Hydrate each task with its tags
    const tasks: Task[] = rows.map((row) => {
      const tagRows = this.queries.getTaskTags(row.id);
      const tags = tagRows.map((r) => r.tags);
      return { ...row, dueTime: row.dueTime ?? false, tags };
    });

    // Apply in-memory filtering (reuses existing filterTasks)
    let result = filter ? filterTasks(tasks, filter) : tasks;

    // Apply priority sorting
    result = sortByPriority(result);

    return result;
  }

  async get(id: string): Promise<Task | null> {
    const rows = this.queries.getTask(id);
    if (rows.length === 0) return null;

    const row = rows[0];
    const tagRows = this.queries.getTaskTags(id);
    const tags = tagRows.map((r) => r.tags);

    return { ...row, dueTime: row.dueTime ?? false, tags };
  }

  async update(id: string, input: UpdateTaskInput): Promise<Task> {
    const existing = await this.get(id);
    if (!existing) throw new NotFoundError("Task", id);

    const now = new Date().toISOString();
    const { tags: tagNames, ...fields } = input;

    // Update task fields
    this.queries.updateTask(id, { ...fields, updatedAt: now });

    // If tags are being updated, replace all tag associations
    if (tagNames !== undefined) {
      this.queries.deleteTaskTags(id);
      for (const tagName of tagNames) {
        const tag = await this.tagService.getOrCreate(tagName);
        this.queries.insertTaskTag(id, tag.id);
      }
    }

    const updated = (await this.get(id))!;
    this.eventBus?.emit("task:update", { task: updated, changes: fields });

    return updated;
  }

  async complete(id: string): Promise<Task> {
    const existing = await this.get(id);
    if (!existing) throw new NotFoundError("Task", id);

    const now = new Date().toISOString();
    this.queries.updateTask(id, {
      status: "completed",
      completedAt: now,
      updatedAt: now,
    });

    // Create next occurrence for recurring tasks
    if (existing.recurrence) {
      const fromDate = existing.dueDate ? new Date(existing.dueDate) : new Date();
      const nextDate = getNextOccurrence(existing.recurrence, fromDate);
      if (nextDate) {
        await this.create({
          title: existing.title,
          description: existing.description,
          priority: existing.priority,
          dueDate: nextDate.toISOString(),
          dueTime: existing.dueTime,
          projectId: existing.projectId,
          recurrence: existing.recurrence,
          tags: existing.tags.map((t) => t.name),
        });
      }
    }

    const completed = (await this.get(id))!;
    this.eventBus?.emit("task:complete", completed);

    return completed;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    this.queries.deleteTaskTags(id);
    const result = this.queries.deleteTask(id);
    const deleted = result.changes > 0;
    if (deleted && existing) {
      this.eventBus?.emit("task:delete", existing);
    }
    return deleted;
  }

  /** Complete multiple tasks. Handles recurrence per-task. */
  async completeMany(ids: string[]): Promise<Task[]> {
    const results: Task[] = [];
    for (const id of ids) {
      results.push(await this.complete(id));
    }
    return results;
  }

  /** Delete multiple tasks in batch. */
  async deleteMany(ids: string[]): Promise<Task[]> {
    const snapshots: Task[] = [];
    for (const id of ids) {
      const task = await this.get(id);
      if (task) snapshots.push(task);
    }
    if (ids.length > 0) {
      this.queries.deleteManyTaskTags(ids);
      this.queries.deleteManyTasks(ids);
    }
    for (const task of snapshots) {
      this.eventBus?.emit("task:delete", task);
    }
    return snapshots;
  }

  /** Update multiple tasks with the same changes. */
  async updateMany(ids: string[], changes: UpdateTaskInput): Promise<Task[]> {
    const { tags: tagNames, ...fields } = changes;
    const now = new Date().toISOString();

    if (Object.keys(fields).length > 0) {
      this.queries.updateManyTasks(ids, { ...fields, updatedAt: now });
    }

    // Handle tags per-task if provided
    if (tagNames !== undefined) {
      for (const id of ids) {
        this.queries.deleteTaskTags(id);
        for (const tagName of tagNames) {
          const tag = await this.tagService.getOrCreate(tagName);
          this.queries.insertTaskTag(id, tag.id);
        }
      }
    }

    const results: Task[] = [];
    for (const id of ids) {
      const updated = await this.get(id);
      if (updated) {
        results.push(updated);
        this.eventBus?.emit("task:update", { task: updated, changes: fields });
      }
    }
    return results;
  }

  /** Restore a previously deleted task (for undo). */
  async restoreTask(task: Task): Promise<Task> {
    this.queries.insertTaskWithId({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate,
      dueTime: task.dueTime,
      completedAt: task.completedAt,
      projectId: task.projectId,
      recurrence: task.recurrence,
      sortOrder: task.sortOrder,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });

    for (const tag of task.tags) {
      const resolved = await this.tagService.getOrCreate(tag.name);
      this.queries.insertTaskTag(task.id, resolved.id);
    }

    this.eventBus?.emit("task:create", task);
    return task;
  }

  /** Reorder tasks by assigning sequential sort orders. */
  async reorder(orderedIds: string[]): Promise<void> {
    for (let i = 0; i < orderedIds.length; i++) {
      this.queries.updateTask(orderedIds[i], { sortOrder: i });
    }
    this.eventBus?.emit("task:reorder", orderedIds);
  }
}
