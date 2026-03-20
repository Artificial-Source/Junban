import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { StorageError } from "../../core/errors.js";
import type {
  TagRow,
  TemplateRow,
  SectionRow,
  ChatMessageRow,
  ChatSessionInfo,
  TaskCommentRow,
  TaskActivityRow,
  DailyStatRow,
  TaskRelationRow,
  AiMemoryRow,
  PluginSettingsRow,
  AppSettingRow,
  MutationResult,
  MarkdownIndexes,
} from "./types.js";
import { OK, NOOP } from "./types.js";
import {
  persistTags,
  persistAppSettings,
  persistPluginPermissions,
  persistChatSession,
  persistTemplates,
  persistSections,
  persistTaskMeta,
  persistDailyStats,
  persistTaskRelations,
  persistAiMemories,
} from "./persistence.js";
import { updateTask } from "./task-ops.js";

// ── Tags ──

export function listTags(idx: MarkdownIndexes): TagRow[] {
  return Array.from(idx.tagIndex.values());
}

export function getTagByName(idx: MarkdownIndexes, name: string): TagRow[] {
  for (const tag of idx.tagIndex.values()) {
    if (tag.name === name) return [tag];
  }
  return [];
}

export function insertTag(idx: MarkdownIndexes, tag: TagRow): MutationResult {
  idx.tagIndex.set(tag.id, tag);
  persistTags(idx);
  return OK;
}

export function deleteTag(idx: MarkdownIndexes, id: string): MutationResult {
  const had = idx.tagIndex.has(id);
  idx.tagIndex.delete(id);
  persistTags(idx);
  return had ? OK : NOOP;
}

// ── Plugin Settings ──

export function loadPluginSettings(
  idx: MarkdownIndexes,
  pluginId: string,
): PluginSettingsRow | undefined {
  return idx.pluginSettingsMap.get(pluginId);
}

export function savePluginSettings(idx: MarkdownIndexes, pluginId: string, settings: string): void {
  const now = new Date().toISOString();
  const row: PluginSettingsRow = { pluginId, settings, updatedAt: now };
  idx.pluginSettingsMap.set(pluginId, row);

  const filePath = path.join(idx.basePath, "_plugins", `${pluginId}.yaml`);
  try {
    fs.writeFileSync(filePath, YAML.stringify({ settings, updatedAt: now }), "utf-8");
  } catch (err) {
    throw new StorageError(`write ${filePath}`, err instanceof Error ? err : undefined);
  }
}

// ── App Settings ──

export function getAppSetting(idx: MarkdownIndexes, key: string): AppSettingRow | undefined {
  return idx.appSettings.get(key);
}

export function setAppSetting(idx: MarkdownIndexes, key: string, value: string): void {
  const now = new Date().toISOString();
  idx.appSettings.set(key, { key, value, updatedAt: now });
  persistAppSettings(idx);
}

export function deleteAppSetting(idx: MarkdownIndexes, key: string): MutationResult {
  const had = idx.appSettings.has(key);
  idx.appSettings.delete(key);
  persistAppSettings(idx);
  return had ? OK : NOOP;
}

// ── Chat Messages ──

export function listChatMessages(idx: MarkdownIndexes, sessionId: string): ChatMessageRow[] {
  return idx.chatMessages.get(sessionId) ?? [];
}

export function insertChatMessage(idx: MarkdownIndexes, msg: ChatMessageRow): MutationResult {
  let messages = idx.chatMessages.get(msg.sessionId);
  if (!messages) {
    messages = [];
    idx.chatMessages.set(msg.sessionId, messages);
  }
  messages.push(msg);
  persistChatSession(idx, msg.sessionId);
  return OK;
}

export function deleteChatSession(idx: MarkdownIndexes, sessionId: string): MutationResult {
  const had = idx.chatMessages.has(sessionId);
  idx.chatMessages.delete(sessionId);

  const filePath = path.join(idx.basePath, "_chat", `${sessionId}.yaml`);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    throw new StorageError(`delete ${filePath}`, err instanceof Error ? err : undefined);
  }
  return had ? OK : NOOP;
}

export function getLatestSessionId(idx: MarkdownIndexes): { sessionId: string } | undefined {
  let latest: { sessionId: string; time: string } | undefined;
  for (const [sessionId, messages] of idx.chatMessages) {
    if (messages.length === 0) continue;
    const lastMsg = messages[messages.length - 1];
    if (!latest || lastMsg.createdAt > latest.time) {
      latest = { sessionId, time: lastMsg.createdAt };
    }
  }
  return latest ? { sessionId: latest.sessionId } : undefined;
}

export function listChatSessions(idx: MarkdownIndexes): ChatSessionInfo[] {
  const sessions: ChatSessionInfo[] = [];
  for (const [sessionId, messages] of idx.chatMessages) {
    if (messages.length === 0) continue;
    const override = getAppSetting(idx, `chat_session_title:${sessionId}`);
    let title = override?.value ?? "";
    if (!title) {
      const firstUserMsg = messages.find((m) => m.role === "user");
      title = firstUserMsg?.content?.slice(0, 40) ?? "New chat";
    }
    sessions.push({
      sessionId,
      title,
      createdAt: messages[0].createdAt,
      messageCount: messages.length,
    });
  }
  sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return sessions;
}

export function renameChatSession(idx: MarkdownIndexes, sessionId: string, title: string): void {
  setAppSetting(idx, `chat_session_title:${sessionId}`, title);
}

// ── Plugin Permissions ──

export function getPluginPermissions(idx: MarkdownIndexes, pluginId: string): string[] | null {
  return idx.pluginPermissions.get(pluginId) ?? null;
}

export function setPluginPermissions(
  idx: MarkdownIndexes,
  pluginId: string,
  permissions: string[],
): void {
  idx.pluginPermissions.set(pluginId, permissions);
  persistPluginPermissions(idx);
}

export function deletePluginPermissions(idx: MarkdownIndexes, pluginId: string): MutationResult {
  const had = idx.pluginPermissions.has(pluginId);
  idx.pluginPermissions.delete(pluginId);
  persistPluginPermissions(idx);
  return had ? OK : NOOP;
}

// ── Task Templates ──

export function listTemplates(idx: MarkdownIndexes): TemplateRow[] {
  return Array.from(idx.templateIndex.values());
}

export function getTemplate(idx: MarkdownIndexes, id: string): TemplateRow | undefined {
  return idx.templateIndex.get(id);
}

export function insertTemplate(idx: MarkdownIndexes, template: TemplateRow): MutationResult {
  idx.templateIndex.set(template.id, template);
  persistTemplates(idx);
  return OK;
}

export function updateTemplate(
  idx: MarkdownIndexes,
  id: string,
  data: Partial<TemplateRow>,
): MutationResult {
  const existing = idx.templateIndex.get(id);
  if (!existing) return NOOP;
  idx.templateIndex.set(id, { ...existing, ...data });
  persistTemplates(idx);
  return OK;
}

export function deleteTemplate(idx: MarkdownIndexes, id: string): MutationResult {
  const had = idx.templateIndex.has(id);
  idx.templateIndex.delete(id);
  persistTemplates(idx);
  return had ? OK : NOOP;
}

// ── Sections ──

export function listSections(idx: MarkdownIndexes, projectId: string): SectionRow[] {
  return Array.from(idx.sectionIndex.values()).filter((s) => s.projectId === projectId);
}

export function getSection(idx: MarkdownIndexes, id: string): SectionRow | undefined {
  return idx.sectionIndex.get(id);
}

export function insertSection(idx: MarkdownIndexes, section: SectionRow): MutationResult {
  idx.sectionIndex.set(section.id, section);
  persistSections(idx);
  return OK;
}

export function updateSection(
  idx: MarkdownIndexes,
  id: string,
  data: Partial<SectionRow>,
): MutationResult {
  const existing = idx.sectionIndex.get(id);
  if (!existing) return NOOP;
  idx.sectionIndex.set(id, { ...existing, ...data });
  persistSections(idx);
  return OK;
}

export function deleteSection(idx: MarkdownIndexes, id: string): MutationResult {
  const had = idx.sectionIndex.has(id);
  idx.sectionIndex.delete(id);
  // Clear sectionId on tasks that referenced this section
  for (const [taskId, entry] of idx.taskIndex) {
    if (entry.row.sectionId === id) {
      updateTask(idx, taskId, { sectionId: null });
    }
  }
  persistSections(idx);
  return had ? OK : NOOP;
}

// ── Task Comments ──

export function listTaskComments(idx: MarkdownIndexes, taskId: string): TaskCommentRow[] {
  return idx.taskCommentIndex.get(taskId) ?? [];
}

export function insertTaskComment(idx: MarkdownIndexes, comment: TaskCommentRow): MutationResult {
  let comments = idx.taskCommentIndex.get(comment.taskId);
  if (!comments) {
    comments = [];
    idx.taskCommentIndex.set(comment.taskId, comments);
  }
  comments.push(comment);
  persistTaskMeta(idx, comment.taskId);
  return OK;
}

export function updateTaskComment(
  idx: MarkdownIndexes,
  id: string,
  data: Partial<TaskCommentRow>,
): MutationResult {
  for (const [taskId, comments] of idx.taskCommentIndex) {
    const i = comments.findIndex((c) => c.id === id);
    if (i >= 0) {
      comments[i] = { ...comments[i], ...data };
      persistTaskMeta(idx, taskId);
      return OK;
    }
  }
  return NOOP;
}

export function deleteTaskComment(idx: MarkdownIndexes, id: string): MutationResult {
  for (const [taskId, comments] of idx.taskCommentIndex) {
    const i = comments.findIndex((c) => c.id === id);
    if (i >= 0) {
      comments.splice(i, 1);
      persistTaskMeta(idx, taskId);
      return OK;
    }
  }
  return NOOP;
}

// ── Task Activity ──

export function listTaskActivity(idx: MarkdownIndexes, taskId: string): TaskActivityRow[] {
  return idx.taskActivityIndex.get(taskId) ?? [];
}

export function insertTaskActivity(
  idx: MarkdownIndexes,
  activity: TaskActivityRow,
): MutationResult {
  let activities = idx.taskActivityIndex.get(activity.taskId);
  if (!activities) {
    activities = [];
    idx.taskActivityIndex.set(activity.taskId, activities);
  }
  activities.push(activity);
  persistTaskMeta(idx, activity.taskId);
  return OK;
}

// ── Daily Stats ──

export function getDailyStat(idx: MarkdownIndexes, date: string): DailyStatRow | undefined {
  return idx.dailyStatIndex.get(date);
}

export function upsertDailyStat(idx: MarkdownIndexes, stat: DailyStatRow): MutationResult {
  idx.dailyStatIndex.set(stat.date, stat);
  persistDailyStats(idx);
  return OK;
}

export function listDailyStats(
  idx: MarkdownIndexes,
  startDate: string,
  endDate: string,
): DailyStatRow[] {
  const results: DailyStatRow[] = [];
  for (const stat of idx.dailyStatIndex.values()) {
    if (stat.date >= startDate && stat.date <= endDate) {
      results.push(stat);
    }
  }
  return results.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Task Relations ──

export function listTaskRelations(idx: MarkdownIndexes): TaskRelationRow[] {
  return [...idx.taskRelationList];
}

export function getTaskRelations(idx: MarkdownIndexes, taskId: string): TaskRelationRow[] {
  return idx.taskRelationList.filter((r) => r.taskId === taskId || r.relatedTaskId === taskId);
}

export function insertTaskRelation(
  idx: MarkdownIndexes,
  relation: TaskRelationRow,
): MutationResult {
  idx.taskRelationList.push({ ...relation });
  persistTaskRelations(idx);
  return OK;
}

export function deleteTaskRelation(
  idx: MarkdownIndexes,
  taskId: string,
  relatedTaskId: string,
): MutationResult {
  const i = idx.taskRelationList.findIndex(
    (r) => r.taskId === taskId && r.relatedTaskId === relatedTaskId,
  );
  if (i < 0) return NOOP;
  idx.taskRelationList.splice(i, 1);
  persistTaskRelations(idx);
  return OK;
}

export function deleteAllTaskRelations(idx: MarkdownIndexes, taskId: string): MutationResult {
  const before = idx.taskRelationList.length;
  idx.taskRelationList = idx.taskRelationList.filter(
    (r) => r.taskId !== taskId && r.relatedTaskId !== taskId,
  );
  const removed = before - idx.taskRelationList.length;
  if (removed > 0) persistTaskRelations(idx);
  return { changes: removed };
}

// ── AI Memories ──

export function listAiMemories(idx: MarkdownIndexes): AiMemoryRow[] {
  return Array.from(idx.aiMemoryIndex.values());
}

export function insertAiMemory(idx: MarkdownIndexes, row: AiMemoryRow): void {
  idx.aiMemoryIndex.set(row.id, row);
  persistAiMemories(idx);
}

export function updateAiMemory(
  idx: MarkdownIndexes,
  id: string,
  content: string,
  category: AiMemoryRow["category"],
): void {
  const existing = idx.aiMemoryIndex.get(id);
  if (!existing) return;
  idx.aiMemoryIndex.set(id, {
    ...existing,
    content,
    category,
    updatedAt: new Date().toISOString(),
  });
  persistAiMemories(idx);
}

export function deleteAiMemory(idx: MarkdownIndexes, id: string): MutationResult {
  const had = idx.aiMemoryIndex.has(id);
  idx.aiMemoryIndex.delete(id);
  persistAiMemories(idx);
  return had ? OK : NOOP;
}
