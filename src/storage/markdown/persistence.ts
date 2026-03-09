import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parseTaskFile } from "../markdown-utils.js";
import { StorageError } from "../../core/errors.js";
import type {
  TagRow,
  ChatMessageRow,
  TemplateRow,
  SectionRow,
  TaskCommentRow,
  TaskActivityRow,
  DailyStatRow,
  TaskRelationRow,
  AiMemoryRow,
  MarkdownIndexes,
} from "./types.js";

// ── Persist helpers (write index state to disk) ──

export function persistTags(idx: MarkdownIndexes): void {
  const tags = Array.from(idx.tagIndex.values()).sort((a, b) => a.name.localeCompare(b.name));
  const filePath = path.join(idx.basePath, "_tags.yaml");
  try {
    fs.writeFileSync(filePath, YAML.stringify(tags), "utf-8");
  } catch (err) {
    throw new StorageError(`write ${filePath}`, err instanceof Error ? err : undefined);
  }
}

export function persistAppSettings(idx: MarkdownIndexes): void {
  const obj: Record<string, { value: string; updatedAt: string }> = {};
  for (const [key, row] of [...idx.appSettings.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    obj[key] = { value: row.value, updatedAt: row.updatedAt };
  }
  const filePath = path.join(idx.basePath, "_settings.yaml");
  try {
    fs.writeFileSync(filePath, YAML.stringify(obj), "utf-8");
  } catch (err) {
    throw new StorageError(`write ${filePath}`, err instanceof Error ? err : undefined);
  }
}

export function persistPluginPermissions(idx: MarkdownIndexes): void {
  const obj: Record<string, string[]> = {};
  for (const [id, perms] of idx.pluginPermissions) {
    obj[id] = perms;
  }
  const filePath = path.join(idx.basePath, "_plugins", "permissions.yaml");
  try {
    fs.writeFileSync(filePath, YAML.stringify(obj), "utf-8");
  } catch (err) {
    throw new StorageError(`write ${filePath}`, err instanceof Error ? err : undefined);
  }
}

export function persistChatSession(idx: MarkdownIndexes, sessionId: string): void {
  const messages = idx.chatMessages.get(sessionId);
  if (!messages) return;
  const filePath = path.join(idx.basePath, "_chat", `${sessionId}.yaml`);
  try {
    fs.writeFileSync(filePath, YAML.stringify(messages), "utf-8");
  } catch (err) {
    throw new StorageError(`write ${filePath}`, err instanceof Error ? err : undefined);
  }
}

export function persistTemplates(idx: MarkdownIndexes): void {
  const templates = Array.from(idx.templateIndex.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const filePath = path.join(idx.basePath, "_templates.yaml");
  try {
    fs.writeFileSync(filePath, YAML.stringify(templates), "utf-8");
  } catch (err) {
    throw new StorageError(`write ${filePath}`, err instanceof Error ? err : undefined);
  }
}

export function persistSections(idx: MarkdownIndexes): void {
  const sections = Array.from(idx.sectionIndex.values());
  const filePath = path.join(idx.basePath, "_sections.yaml");
  try {
    fs.writeFileSync(filePath, YAML.stringify(sections), "utf-8");
  } catch (err) {
    throw new StorageError(`write ${filePath}`, err instanceof Error ? err : undefined);
  }
}

export function persistTaskMeta(idx: MarkdownIndexes, taskId: string): void {
  const comments = idx.taskCommentIndex.get(taskId) ?? [];
  const activities = idx.taskActivityIndex.get(taskId) ?? [];
  if (comments.length === 0 && activities.length === 0) return;
  const metaDir = path.join(idx.basePath, "_task_meta");
  try {
    fs.mkdirSync(metaDir, { recursive: true });
  } catch {
    // directory may already exist
  }
  const filePath = path.join(metaDir, `${taskId}.yaml`);
  try {
    fs.writeFileSync(filePath, YAML.stringify({ comments, activities }), "utf-8");
  } catch (err) {
    throw new StorageError(`write ${filePath}`, err instanceof Error ? err : undefined);
  }
}

export function persistDailyStats(idx: MarkdownIndexes): void {
  const stats = Array.from(idx.dailyStatIndex.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const filePath = path.join(idx.basePath, "_daily_stats.yaml");
  try {
    fs.writeFileSync(filePath, YAML.stringify(stats), "utf-8");
  } catch (err) {
    throw new StorageError(`write ${filePath}`, err instanceof Error ? err : undefined);
  }
}

export function persistTaskRelations(idx: MarkdownIndexes): void {
  const filePath = path.join(idx.basePath, "_task_relations.yaml");
  try {
    fs.writeFileSync(filePath, YAML.stringify(idx.taskRelationList), "utf-8");
  } catch (err) {
    throw new StorageError(`write ${filePath}`, err instanceof Error ? err : undefined);
  }
}

export function persistAiMemories(idx: MarkdownIndexes): void {
  const memories = Array.from(idx.aiMemoryIndex.values());
  const filePath = path.join(idx.basePath, "_ai_memories.json");
  try {
    fs.writeFileSync(filePath, JSON.stringify(memories, null, 2), "utf-8");
  } catch (err) {
    throw new StorageError(`write ${filePath}`, err instanceof Error ? err : undefined);
  }
}

// ── Load helpers (read from disk into indexes) ──

export function loadTags(idx: MarkdownIndexes): void {
  const filePath = path.join(idx.basePath, "_tags.yaml");
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf-8");
  const tags = YAML.parse(content);
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      idx.tagIndex.set(tag.id, tag as TagRow);
    }
  }
}

export function loadProjects(idx: MarkdownIndexes): void {
  const projectsDir = path.join(idx.basePath, "projects");
  if (!fs.existsSync(projectsDir)) return;

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(projectsDir, entry.name);
    const metaPath = path.join(dirPath, "_project.yaml");
    if (!fs.existsSync(metaPath)) continue;

    const content = fs.readFileSync(metaPath, "utf-8");
    const meta = YAML.parse(content);
    const row = {
      id: meta.id,
      name: entry.name, // directory name
      color: meta.color ?? "#3b82f6",
      icon: meta.icon ?? null,
      parentId: meta.parentId ?? null,
      isFavorite: meta.isFavorite ?? false,
      viewStyle: meta.viewStyle ?? "list",
      sortOrder: meta.sortOrder ?? 0,
      archived: meta.archived ?? false,
      createdAt: meta.createdAt ?? new Date().toISOString(),
    } as any;

    // Store the original name from the directory
    if (meta.name) {
      row.name = meta.name;
    }

    idx.projectIndex.set(row.id, { row, dirPath });
  }
}

export function loadTasks(idx: MarkdownIndexes): void {
  // Load tasks from inbox/
  loadTasksFromDir(idx, path.join(idx.basePath, "inbox"), null);

  // Load tasks from each project directory
  for (const [projectId, entry] of idx.projectIndex) {
    loadTasksFromDir(idx, entry.dirPath, projectId);
  }
}

export function loadTasksFromDir(
  idx: MarkdownIndexes,
  dirPath: string,
  projectId: string | null,
): void {
  if (!fs.existsSync(dirPath)) return;

  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const { task, tagNames } = parseTaskFile(content, projectId);

    if (!task.id) continue; // Skip files without an ID

    idx.taskIndex.set(task.id, {
      row: { ...task, description: null },
      filePath,
      description: task.description,
    });

    // Resolve tag names to IDs
    const tagIds = new Set<string>();
    for (const tagName of tagNames) {
      for (const [tagId, tag] of idx.tagIndex) {
        if (tag.name === tagName) {
          tagIds.add(tagId);
          break;
        }
      }
    }
    if (tagIds.size > 0) {
      idx.taskTagIndex.set(task.id, tagIds);
    }
  }
}

export function loadAppSettings(idx: MarkdownIndexes): void {
  const filePath = path.join(idx.basePath, "_settings.yaml");
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf-8");
  const obj = YAML.parse(content);
  if (obj && typeof obj === "object") {
    for (const [key, val] of Object.entries(obj)) {
      const entry = val as { value: string; updatedAt: string };
      idx.appSettings.set(key, { key, value: entry.value, updatedAt: entry.updatedAt });
    }
  }
}

export function loadPluginData(idx: MarkdownIndexes): void {
  const pluginsDir = path.join(idx.basePath, "_plugins");
  if (!fs.existsSync(pluginsDir)) return;

  // Load plugin settings
  const files = fs.readdirSync(pluginsDir).filter((f) => f.endsWith(".yaml"));
  for (const file of files) {
    if (file === "permissions.yaml") continue;
    const pluginId = file.replace(".yaml", "");
    const filePath = path.join(pluginsDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const data = YAML.parse(content);
    if (data) {
      idx.pluginSettingsMap.set(pluginId, {
        pluginId,
        settings: data.settings ?? "{}",
        updatedAt: data.updatedAt ?? new Date().toISOString(),
      });
    }
  }

  // Load plugin permissions
  const permPath = path.join(pluginsDir, "permissions.yaml");
  if (fs.existsSync(permPath)) {
    const content = fs.readFileSync(permPath, "utf-8");
    const obj = YAML.parse(content);
    if (obj && typeof obj === "object") {
      for (const [id, perms] of Object.entries(obj)) {
        idx.pluginPermissions.set(id, perms as string[]);
      }
    }
  }
}

export function loadChatData(idx: MarkdownIndexes): void {
  const chatDir = path.join(idx.basePath, "_chat");
  if (!fs.existsSync(chatDir)) return;

  const files = fs.readdirSync(chatDir).filter((f) => f.endsWith(".yaml"));
  for (const file of files) {
    const sessionId = file.replace(".yaml", "");
    const filePath = path.join(chatDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const messages = YAML.parse(content);
    if (Array.isArray(messages)) {
      idx.chatMessages.set(sessionId, messages as ChatMessageRow[]);
    }
  }
}

export function loadTemplates(idx: MarkdownIndexes): void {
  const filePath = path.join(idx.basePath, "_templates.yaml");
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf-8");
  const templates = YAML.parse(content);
  if (Array.isArray(templates)) {
    for (const t of templates) {
      idx.templateIndex.set(t.id, t as TemplateRow);
    }
  }
}

export function loadSections(idx: MarkdownIndexes): void {
  const filePath = path.join(idx.basePath, "_sections.yaml");
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf-8");
  const sections = YAML.parse(content);
  if (Array.isArray(sections)) {
    for (const s of sections) {
      idx.sectionIndex.set(s.id, s as SectionRow);
    }
  }
}

export function loadDailyStatsFile(idx: MarkdownIndexes): void {
  const filePath = path.join(idx.basePath, "_daily_stats.yaml");
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf-8");
  const stats = YAML.parse(content);
  if (Array.isArray(stats)) {
    for (const s of stats) {
      idx.dailyStatIndex.set(s.date, s as DailyStatRow);
    }
  }
}

export function loadTaskMeta(idx: MarkdownIndexes): void {
  const metaDir = path.join(idx.basePath, "_task_meta");
  if (!fs.existsSync(metaDir)) return;

  const files = fs.readdirSync(metaDir).filter((f) => f.endsWith(".yaml"));
  for (const file of files) {
    const taskId = file.replace(".yaml", "");
    const filePath = path.join(metaDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const data = YAML.parse(content);
    if (data) {
      if (Array.isArray(data.comments)) {
        idx.taskCommentIndex.set(taskId, data.comments as TaskCommentRow[]);
      }
      if (Array.isArray(data.activities)) {
        idx.taskActivityIndex.set(taskId, data.activities as TaskActivityRow[]);
      }
    }
  }
}

export function loadTaskRelations(idx: MarkdownIndexes): void {
  const filePath = path.join(idx.basePath, "_task_relations.yaml");
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf-8");
  const relations = YAML.parse(content);
  if (Array.isArray(relations)) {
    idx.taskRelationList = relations as TaskRelationRow[];
  }
}

export function loadAiMemories(idx: MarkdownIndexes): void {
  const filePath = path.join(idx.basePath, "_ai_memories.json");
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf-8");
  const memories = JSON.parse(content);
  if (Array.isArray(memories)) {
    for (const m of memories) {
      idx.aiMemoryIndex.set(m.id, m as AiMemoryRow);
    }
  }
}
