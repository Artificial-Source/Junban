import type { CreateTaskInput, UpdateTaskInput, Task, Tag } from "./types.js";
import type { TagRow } from "../storage/interface.js";
import type { IStorage } from "../storage/interface.js";
import type { TagService } from "./tags.js";
import type { TaskFilter } from "./filters.js";
import type { EventBus } from "./event-bus.js";
import { filterTasks } from "./filters.js";
import { sortByPriority } from "./priorities.js";
import { generateId } from "../utils/ids.js";
import { NotFoundError } from "./errors.js";
import { getNextOccurrence } from "./recurrence.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("tasks");

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
      parentId: input.parentId ?? null,
      remindAt: input.remindAt ?? null,
      estimatedMinutes: input.estimatedMinutes ?? null,
      actualMinutes: input.actualMinutes ?? null,
      deadline: input.deadline ?? null,
      isSomeday: input.isSomeday ?? false,
      sectionId: input.sectionId ?? null,
      dreadLevel: input.dreadLevel ?? null,
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
      parentId: input.parentId ?? null,
      remindAt: input.remindAt ?? null,
      estimatedMinutes: input.estimatedMinutes ?? null,
      actualMinutes: input.actualMinutes ?? null,
      deadline: input.deadline ?? null,
      isSomeday: input.isSomeday ?? false,
      sectionId: input.sectionId ?? null,
      dreadLevel: input.dreadLevel ?? null,
      tags,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    };

    logger.debug("Task created", { id, title: input.title });
    this.eventBus?.emit("task:create", task);

    return task;
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    const rows = this.queries.listTasks();

    // Single batch query — eliminates N+1
    const allTagJoins = this.queries.listAllTaskTags();
    const tagsByTaskId = new Map<string, TagRow[]>();
    for (const join of allTagJoins) {
      const taskId = join.task_tags.taskId;
      if (!tagsByTaskId.has(taskId)) tagsByTaskId.set(taskId, []);
      tagsByTaskId.get(taskId)!.push(join.tags);
    }

    const tasks: Task[] = rows.map((row) => ({
      ...row,
      dueTime: row.dueTime ?? false,
      parentId: row.parentId ?? null,
      remindAt: row.remindAt ?? null,
      estimatedMinutes: row.estimatedMinutes ?? null,
      actualMinutes: row.actualMinutes ?? null,
      deadline: row.deadline ?? null,
      isSomeday: row.isSomeday ?? false,
      sectionId: row.sectionId ?? null,
      dreadLevel: row.dreadLevel ?? null,
      tags: tagsByTaskId.get(row.id) ?? [],
    }));

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

    return {
      ...row,
      dueTime: row.dueTime ?? false,
      parentId: row.parentId ?? null,
      remindAt: row.remindAt ?? null,
      estimatedMinutes: row.estimatedMinutes ?? null,
      actualMinutes: row.actualMinutes ?? null,
      deadline: row.deadline ?? null,
      isSomeday: row.isSomeday ?? false,
      sectionId: row.sectionId ?? null,
      dreadLevel: row.dreadLevel ?? null,
      tags,
    };
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
    logger.debug("Task updated", { id, fields: Object.keys(fields) });
    this.eventBus?.emit("task:update", { task: updated, changes: fields });

    // Emit task:moved when projectId changes
    if ("projectId" in fields && existing.projectId !== updated.projectId) {
      this.eventBus?.emit("task:moved", {
        task: updated,
        fromProjectId: existing.projectId,
        toProjectId: updated.projectId,
      });
    }

    // Emit task:estimated when estimatedMinutes changes
    if ("estimatedMinutes" in fields && existing.estimatedMinutes !== updated.estimatedMinutes) {
      this.eventBus?.emit("task:estimated", {
        task: updated,
        previousMinutes: existing.estimatedMinutes,
        newMinutes: updated.estimatedMinutes,
      });
    }

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

    // Cascade-complete children
    const children = await this.getChildren(id);
    for (const child of children) {
      if (child.status === "pending") {
        await this.complete(child.id);
      }
    }

    logger.debug("Task completed", { id });

    // Create next occurrence for recurring tasks
    if (existing.recurrence) {
      const fromDate = existing.dueDate ? new Date(existing.dueDate) : new Date();
      const nextDate = getNextOccurrence(existing.recurrence, fromDate);
      if (nextDate) {
        logger.debug("Creating next recurrence", {
          originalId: id,
          nextDate: nextDate.toISOString(),
        });
        // Propagate remindAt with preserved offset from dueDate
        let nextRemindAt: string | null = null;
        if (existing.remindAt && existing.dueDate) {
          const offsetMs =
            new Date(existing.dueDate).getTime() - new Date(existing.remindAt).getTime();
          nextRemindAt = new Date(nextDate.getTime() - offsetMs).toISOString();
        } else if (existing.remindAt) {
          // No dueDate but has remindAt — keep the same remind offset from now
          nextRemindAt = existing.remindAt;
        }

        // Propagate deadline with preserved offset from dueDate
        let nextDeadline: string | null = null;
        if (existing.deadline && existing.dueDate) {
          const deadlineOffsetMs =
            new Date(existing.deadline).getTime() - new Date(existing.dueDate).getTime();
          nextDeadline = new Date(nextDate.getTime() + deadlineOffsetMs).toISOString();
        }

        await this.create({
          title: existing.title,
          description: existing.description,
          priority: existing.priority,
          dueDate: nextDate.toISOString(),
          dueTime: existing.dueTime,
          projectId: existing.projectId,
          recurrence: existing.recurrence,
          remindAt: nextRemindAt,
          sectionId: existing.sectionId,
          estimatedMinutes: existing.estimatedMinutes,
          deadline: nextDeadline,
          isSomeday: existing.isSomeday,
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
      logger.debug("Task deleted", { id });
      this.eventBus?.emit("task:delete", existing);
    }
    return deleted;
  }

  /** Complete multiple tasks. Handles recurrence per-task. */
  async completeMany(ids: string[]): Promise<Task[]> {
    logger.debug("Completing batch", { count: ids.length });
    const results: Task[] = [];
    for (const id of ids) {
      results.push(await this.complete(id));
    }
    return results;
  }

  /** Delete multiple tasks in batch. */
  async deleteMany(ids: string[]): Promise<Task[]> {
    logger.debug("Deleting batch", { count: ids.length });
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
    logger.debug("Updating batch", { count: ids.length, fields: Object.keys(changes) });
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
      parentId: task.parentId,
      remindAt: task.remindAt,
      estimatedMinutes: task.estimatedMinutes,
      actualMinutes: task.actualMinutes,
      deadline: task.deadline,
      isSomeday: task.isSomeday,
      sectionId: task.sectionId,
      dreadLevel: task.dreadLevel,
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

  /** Get tasks with reminders that are due (remindAt <= now, status pending). */
  async getDueReminders(): Promise<Task[]> {
    const now = new Date().toISOString();
    const rows = this.queries.listTasksDueForReminder(now);

    const allTagJoins = this.queries.listAllTaskTags();
    const tagsByTaskId = new Map<string, import("../storage/interface.js").TagRow[]>();
    for (const join of allTagJoins) {
      const taskId = join.task_tags.taskId;
      if (!tagsByTaskId.has(taskId)) tagsByTaskId.set(taskId, []);
      tagsByTaskId.get(taskId)!.push(join.tags);
    }

    return rows.map((row) => ({
      ...row,
      dueTime: row.dueTime ?? false,
      parentId: row.parentId ?? null,
      remindAt: row.remindAt ?? null,
      estimatedMinutes: row.estimatedMinutes ?? null,
      actualMinutes: row.actualMinutes ?? null,
      deadline: row.deadline ?? null,
      isSomeday: row.isSomeday ?? false,
      sectionId: row.sectionId ?? null,
      dreadLevel: row.dreadLevel ?? null,
      tags: tagsByTaskId.get(row.id) ?? [],
    }));
  }

  // ── Sub-task methods ──

  /** Get direct children of a task. */
  async getChildren(parentId: string): Promise<Task[]> {
    const allTasks = await this.list();
    return allTasks.filter((t) => t.parentId === parentId);
  }

  /** List tasks as a nested tree (top-level tasks with children populated). */
  async listTree(filter?: TaskFilter): Promise<Task[]> {
    const allTasks = await this.list(filter);

    // Build parent → children map
    const childMap = new Map<string, Task[]>();
    const topLevel: Task[] = [];

    for (const task of allTasks) {
      if (task.parentId) {
        if (!childMap.has(task.parentId)) childMap.set(task.parentId, []);
        childMap.get(task.parentId)!.push(task);
      } else {
        topLevel.push(task);
      }
    }

    // Recursively attach children
    function attachChildren(task: Task): Task {
      const children = childMap.get(task.id);
      if (children && children.length > 0) {
        return { ...task, children: children.map(attachChildren) };
      }
      return { ...task, children: [] };
    }

    return topLevel.map(attachChildren);
  }

  /**
   * Indent a task: make it a child of its previous sibling.
   * Tasks are ordered by sortOrder. The previous sibling is the nearest task
   * with the same parentId and a lower sortOrder.
   */
  async indent(id: string): Promise<Task> {
    const task = await this.get(id);
    if (!task) throw new NotFoundError("Task", id);

    // Find siblings (tasks with same parentId)
    const allTasks = await this.list();
    const siblings = allTasks
      .filter((t) => t.parentId === task.parentId && t.id !== id)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    // Find the previous sibling by sortOrder
    const prevSibling = siblings.filter((s) => s.sortOrder < task.sortOrder).pop();

    if (!prevSibling) {
      // No previous sibling — cannot indent
      return task;
    }

    // Make this task a child of prevSibling
    return this.update(id, { parentId: prevSibling.id } as any);
  }

  // ── Task Relations ──

  async addRelation(
    taskId: string,
    relatedTaskId: string,
    type: "blocks" = "blocks",
  ): Promise<void> {
    const task = await this.get(taskId);
    if (!task) throw new NotFoundError("Task", taskId);
    const related = await this.get(relatedTaskId);
    if (!related) throw new NotFoundError("Task", relatedTaskId);

    // Cycle detection: would relatedTaskId transitively block taskId?
    if (this.wouldCreateCycle(taskId, relatedTaskId)) {
      throw new Error("Cannot create relation: would create a cycle");
    }

    this.queries.insertTaskRelation({ taskId, relatedTaskId, type });
    this.eventBus?.emit("task:update", { task, changes: {} });
  }

  async removeRelation(taskId: string, relatedTaskId: string): Promise<void> {
    this.queries.deleteTaskRelation(taskId, relatedTaskId);
  }

  async getRelations(taskId: string): Promise<{ blocks: string[]; blockedBy: string[] }> {
    const rows = this.queries.getTaskRelations(taskId);
    const blocks: string[] = [];
    const blockedBy: string[] = [];

    for (const row of rows) {
      if (row.taskId === taskId) {
        blocks.push(row.relatedTaskId);
      } else {
        blockedBy.push(row.taskId);
      }
    }

    return { blocks, blockedBy };
  }

  async listAllRelations(): Promise<
    Array<{ taskId: string; relatedTaskId: string; type: string }>
  > {
    return this.queries.listTaskRelations();
  }

  private wouldCreateCycle(blockerId: string, blockedId: string): boolean {
    // BFS from blockedId through "blocks" edges to see if we reach blockerId
    const allRelations = this.queries.listTaskRelations();
    const adjacency = new Map<string, string[]>();
    for (const rel of allRelations) {
      if (!adjacency.has(rel.taskId)) adjacency.set(rel.taskId, []);
      adjacency.get(rel.taskId)!.push(rel.relatedTaskId);
    }

    const visited = new Set<string>();
    const queue = [blockedId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === blockerId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const neighbors = adjacency.get(current) ?? [];
      queue.push(...neighbors);
    }
    return false;
  }

  /**
   * Outdent a task: make it a sibling of its parent.
   * Moves the task up one level in the hierarchy.
   */
  async outdent(id: string): Promise<Task> {
    const task = await this.get(id);
    if (!task) throw new NotFoundError("Task", id);

    if (!task.parentId) {
      // Already at top level — cannot outdent
      return task;
    }

    const parent = await this.get(task.parentId);
    if (!parent) throw new NotFoundError("Task", task.parentId);

    // Move to parent's parent (or top level if parent is top level)
    return this.update(id, { parentId: parent.parentId } as any);
  }
}
