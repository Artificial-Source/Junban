import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { slugify } from "../markdown-utils.js";
import { StorageError } from "../../core/errors.js";
import type { ProjectRow, MutationResult, MarkdownIndexes } from "./types.js";
import { OK, NOOP } from "./types.js";
import { updateTask } from "./task-ops.js";

export function listProjects(idx: MarkdownIndexes): ProjectRow[] {
  return Array.from(idx.projectIndex.values()).map((e) => e.row);
}

export function getProject(idx: MarkdownIndexes, id: string): ProjectRow[] {
  const entry = idx.projectIndex.get(id);
  return entry ? [entry.row] : [];
}

export function getProjectByName(idx: MarkdownIndexes, name: string): ProjectRow[] {
  for (const entry of idx.projectIndex.values()) {
    if (entry.row.name === name) return [entry.row];
  }
  return [];
}

export function insertProject(idx: MarkdownIndexes, project: ProjectRow): MutationResult {
  const dirName = slugify(project.name) || project.id;
  const dirPath = path.join(idx.basePath, "projects", dirName);

  const meta: Record<string, unknown> = {
    id: project.id,
    color: project.color,
    icon: project.icon,
    parentId: project.parentId,
    isFavorite: project.isFavorite,
    viewStyle: project.viewStyle,
    sortOrder: project.sortOrder,
    archived: project.archived,
    createdAt: project.createdAt,
  };
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, "_project.yaml"), YAML.stringify(meta), "utf-8");
  } catch (err) {
    throw new StorageError(`write project ${dirPath}`, err instanceof Error ? err : undefined);
  }

  idx.projectIndex.set(project.id, { row: project, dirPath });
  return OK;
}

export function updateProject(
  idx: MarkdownIndexes,
  id: string,
  data: Partial<ProjectRow>,
): MutationResult {
  const entry = idx.projectIndex.get(id);
  if (!entry) return NOOP;

  const newRow = { ...entry.row, ...data };
  const meta: Record<string, unknown> = {
    id: newRow.id,
    name: newRow.name,
    color: newRow.color,
    icon: newRow.icon,
    parentId: newRow.parentId,
    isFavorite: newRow.isFavorite,
    viewStyle: newRow.viewStyle,
    sortOrder: newRow.sortOrder,
    archived: newRow.archived,
    createdAt: newRow.createdAt,
  };
  try {
    fs.writeFileSync(path.join(entry.dirPath, "_project.yaml"), YAML.stringify(meta), "utf-8");
  } catch (err) {
    throw new StorageError(
      `write project ${entry.dirPath}`,
      err instanceof Error ? err : undefined,
    );
  }

  idx.projectIndex.set(id, { row: newRow, dirPath: entry.dirPath });
  return OK;
}

export function deleteProject(idx: MarkdownIndexes, id: string): MutationResult {
  const entry = idx.projectIndex.get(id);
  if (!entry) return NOOP;

  // Move project tasks to inbox
  for (const [taskId, taskEntry] of idx.taskIndex) {
    if (taskEntry.row.projectId === id) {
      updateTask(idx, taskId, { projectId: null });
    }
  }

  // Remove project directory
  try {
    if (fs.existsSync(entry.dirPath)) {
      fs.rmSync(entry.dirPath, { recursive: true, force: true });
    }
  } catch (err) {
    throw new StorageError(
      `delete project ${entry.dirPath}`,
      err instanceof Error ? err : undefined,
    );
  }
  idx.projectIndex.delete(id);
  return OK;
}
