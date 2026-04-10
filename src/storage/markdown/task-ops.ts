import fs from "node:fs";
import path from "node:path";
import { serializeTaskFile, taskFilename } from "../markdown-utils.js";
import { StorageError } from "../../core/errors.js";
import type { TaskRow, MutationResult, MarkdownIndexes } from "./types.js";
import { OK, NOOP } from "./types.js";
import type { TaskTagJoin } from "../interface.js";

// ── Helpers ──

export function getTaskDir(idx: MarkdownIndexes, projectId: string | null): string {
  if (!projectId) return path.join(idx.basePath, "inbox");

  const projEntry = idx.projectIndex.get(projectId);
  if (projEntry) return projEntry.dirPath;

  // Fallback to inbox if project not found
  return path.join(idx.basePath, "inbox");
}

export function getTagNamesForTask(idx: MarkdownIndexes, taskId: string): string[] {
  const tagIds = idx.taskTagIndex.get(taskId);
  if (!tagIds) return [];
  const names: string[] = [];
  for (const tagId of tagIds) {
    const tag = idx.tagIndex.get(tagId);
    if (tag) names.push(tag.name);
  }
  return names;
}

export function rewriteTaskFile(idx: MarkdownIndexes, taskId: string): void {
  const entry = idx.taskIndex.get(taskId);
  if (!entry) return;

  const tagNames = getTagNamesForTask(idx, taskId);
  const content = serializeTaskFile(entry.row, entry.row.title, entry.description, tagNames);
  try {
    fs.writeFileSync(entry.filePath, content, "utf-8");
  } catch (err) {
    throw new StorageError(`write ${entry.filePath}`, err instanceof Error ? err : undefined);
  }
}

// ── Task CRUD ──

export function listTasks(idx: MarkdownIndexes): TaskRow[] {
  return Array.from(idx.taskIndex.values()).map((e) => e.row);
}

export function getTask(idx: MarkdownIndexes, id: string): TaskRow[] {
  const entry = idx.taskIndex.get(id);
  return entry ? [entry.row] : [];
}

export function insertTask(idx: MarkdownIndexes, task: TaskRow): MutationResult {
  const description = task.description;
  const dir = getTaskDir(idx, task.projectId);
  const filename = taskFilename(task.title, task.id);
  const filePath = path.join(dir, filename);

  // Get tag names for frontmatter
  const tagNames = getTagNamesForTask(idx, task.id);
  const content = serializeTaskFile(task, task.title, description, tagNames);
  try {
    fs.writeFileSync(filePath, content, "utf-8");
  } catch (err) {
    throw new StorageError(`write ${filePath}`, err instanceof Error ? err : undefined);
  }

  idx.taskIndex.set(task.id, { row: { ...task, description: null }, filePath, description });
  return OK;
}

export function insertTaskWithId(idx: MarkdownIndexes, task: TaskRow): MutationResult {
  return insertTask(idx, task);
}

export function updateTask(
  idx: MarkdownIndexes,
  id: string,
  data: Partial<TaskRow>,
): MutationResult {
  const entry = idx.taskIndex.get(id);
  if (!entry) return NOOP;

  const oldRow = entry.row;
  const newRow = { ...oldRow, ...data };
  let newDescription = entry.description;
  if ("description" in data) {
    newDescription = data.description ?? null;
  }
  let newFilePath = entry.filePath;

  // If title changed -> rename file
  const titleChanged = data.title && data.title !== oldRow.title;
  // If projectId changed -> move file
  const projectChanged = "projectId" in data && data.projectId !== oldRow.projectId;
  const requiresPathChange = titleChanged || projectChanged;

  if (requiresPathChange) {
    const dir = getTaskDir(idx, newRow.projectId);
    const filename = taskFilename(newRow.title, id);
    newFilePath = path.join(dir, filename);
  }

  // Get tag names and rewrite file
  const tagNames = getTagNamesForTask(idx, id);
  const content = serializeTaskFile(newRow, newRow.title, newDescription, tagNames);
  try {
    fs.mkdirSync(path.dirname(newFilePath), { recursive: true });
    fs.writeFileSync(newFilePath, content, "utf-8");
  } catch (err) {
    throw new StorageError(`write ${newFilePath}`, err instanceof Error ? err : undefined);
  }

  // Only remove old file after the replacement has been safely written.
  if (requiresPathChange && newFilePath !== entry.filePath && fs.existsSync(entry.filePath)) {
    try {
      fs.unlinkSync(entry.filePath);
    } catch (err) {
      // Best-effort cleanup to avoid leaving a duplicate path when delete fails.
      try {
        if (fs.existsSync(newFilePath)) fs.unlinkSync(newFilePath);
      } catch {
        // Intentionally ignored: we still throw the original deletion failure.
      }
      throw new StorageError(`delete ${entry.filePath}`, err instanceof Error ? err : undefined);
    }
  }

  idx.taskIndex.set(id, { row: newRow, filePath: newFilePath, description: newDescription });
  return OK;
}

export function deleteTask(idx: MarkdownIndexes, id: string): MutationResult {
  const entry = idx.taskIndex.get(id);
  if (!entry) return NOOP;

  try {
    if (fs.existsSync(entry.filePath)) {
      fs.unlinkSync(entry.filePath);
    }
  } catch (err) {
    throw new StorageError(`delete ${entry.filePath}`, err instanceof Error ? err : undefined);
  }
  idx.taskIndex.delete(id);
  idx.taskTagIndex.delete(id);
  return OK;
}

export function deleteManyTasks(idx: MarkdownIndexes, ids: string[]): MutationResult {
  let changes = 0;
  for (const id of ids) {
    if (deleteTask(idx, id).changes > 0) changes++;
  }
  return { changes };
}

export function updateManyTasks(
  idx: MarkdownIndexes,
  ids: string[],
  data: Partial<TaskRow>,
): MutationResult {
  let changes = 0;
  for (const id of ids) {
    if (updateTask(idx, id, data).changes > 0) changes++;
  }
  return { changes };
}

export function listTasksDueForReminder(idx: MarkdownIndexes, beforeTime: string): TaskRow[] {
  const results: TaskRow[] = [];
  for (const entry of idx.taskIndex.values()) {
    if (entry.row.remindAt && entry.row.remindAt <= beforeTime && entry.row.status === "pending") {
      results.push(entry.row);
    }
  }
  return results;
}

// ── Task-Tag Relations ──

export function getTaskTags(idx: MarkdownIndexes, taskId: string): TaskTagJoin[] {
  const tagIds = idx.taskTagIndex.get(taskId);
  if (!tagIds) return [];

  const results: TaskTagJoin[] = [];
  for (const tagId of tagIds) {
    const tag = idx.tagIndex.get(tagId);
    if (tag) {
      results.push({
        task_tags: { taskId, tagId },
        tags: tag,
      });
    }
  }
  return results;
}

export function insertTaskTag(idx: MarkdownIndexes, taskId: string, tagId: string): MutationResult {
  let set = idx.taskTagIndex.get(taskId);
  if (!set) {
    set = new Set();
    idx.taskTagIndex.set(taskId, set);
  }
  set.add(tagId);

  // Rewrite the task file to include updated tags
  rewriteTaskFile(idx, taskId);
  return OK;
}

export function deleteTaskTags(idx: MarkdownIndexes, taskId: string): MutationResult {
  const had = idx.taskTagIndex.has(taskId);
  idx.taskTagIndex.delete(taskId);

  // Rewrite the task file to remove tags from frontmatter
  rewriteTaskFile(idx, taskId);
  return had ? OK : NOOP;
}

export function listAllTaskTags(idx: MarkdownIndexes): TaskTagJoin[] {
  const results: TaskTagJoin[] = [];
  for (const [taskId, tagIds] of idx.taskTagIndex) {
    for (const tagId of tagIds) {
      const tag = idx.tagIndex.get(tagId);
      if (tag) results.push({ task_tags: { taskId, tagId }, tags: tag });
    }
  }
  return results;
}

export function deleteManyTaskTags(idx: MarkdownIndexes, taskIds: string[]): MutationResult {
  let changes = 0;
  for (const taskId of taskIds) {
    if (deleteTaskTags(idx, taskId).changes > 0) changes++;
  }
  return { changes };
}
