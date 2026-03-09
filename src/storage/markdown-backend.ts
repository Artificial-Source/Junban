import fs from "node:fs";
import path from "node:path";
import { StorageError } from "../core/errors.js";
import { createLogger } from "../utils/logger.js";
import type { MarkdownIndexes } from "./markdown/types.js";
import type {
  IStorage,
  TaskRow,
  ProjectRow,
  TagRow,
  TaskTagJoin,
  PluginSettingsRow,
  AppSettingRow,
  ChatMessageRow,
  ChatSessionInfo,
  TemplateRow,
  SectionRow,
  TaskCommentRow,
  TaskActivityRow,
  DailyStatRow,
  TaskRelationRow,
  AiMemoryRow,
  MutationResult,
} from "./interface.js";
import * as taskOps from "./markdown/task-ops.js";
import * as projectOps from "./markdown/project-ops.js";
import * as metadataOps from "./markdown/metadata-ops.js";
import {
  loadTags,
  loadProjects,
  loadTasks,
  loadAppSettings,
  loadPluginData,
  loadChatData,
  loadTemplates,
  loadSections,
  loadDailyStatsFile,
  loadTaskMeta,
  loadTaskRelations,
  loadAiMemories,
} from "./markdown/persistence.js";

const logger = createLogger("storage-md");

/**
 * Markdown storage backend — stores tasks as .md files with YAML frontmatter.
 * Reads are served from in-memory indexes; writes update both index and disk.
 */
export class MarkdownBackend implements IStorage {
  private idx: MarkdownIndexes;

  constructor(basePath: string) {
    this.idx = {
      basePath,
      taskIndex: new Map(),
      projectIndex: new Map(),
      tagIndex: new Map(),
      taskTagIndex: new Map(),
      appSettings: new Map(),
      pluginSettingsMap: new Map(),
      pluginPermissions: new Map(),
      chatMessages: new Map(),
      templateIndex: new Map(),
      sectionIndex: new Map(),
      taskCommentIndex: new Map(),
      taskActivityIndex: new Map(),
      dailyStatIndex: new Map(),
      taskRelationList: [],
      aiMemoryIndex: new Map(),
    };
  }

  /** Scan directory tree, parse all files, build in-memory indexes. */
  initialize(): void {
    logger.info("Initializing markdown backend", { basePath: this.idx.basePath });
    // Ensure base directories exist
    const dirs = [
      path.join(this.idx.basePath, "inbox"),
      path.join(this.idx.basePath, "projects"),
      path.join(this.idx.basePath, "_plugins"),
      path.join(this.idx.basePath, "_chat"),
    ];
    for (const dir of dirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        throw new StorageError(`create directory ${dir}`, err instanceof Error ? err : undefined);
      }
    }

    loadTags(this.idx);
    loadProjects(this.idx);
    loadTasks(this.idx);
    loadAppSettings(this.idx);
    loadPluginData(this.idx);
    loadChatData(this.idx);
    loadTemplates(this.idx);
    loadSections(this.idx);
    loadDailyStatsFile(this.idx);
    loadTaskMeta(this.idx);
    loadTaskRelations(this.idx);
    loadAiMemories(this.idx);

    logger.info("Markdown backend ready", {
      tasks: this.idx.taskIndex.size,
      projects: this.idx.projectIndex.size,
      tags: this.idx.tagIndex.size,
    });
  }

  // ── Tasks ──

  listTasks(): TaskRow[] {
    return taskOps.listTasks(this.idx);
  }

  getTask(id: string): TaskRow[] {
    return taskOps.getTask(this.idx, id);
  }

  insertTask(task: TaskRow): MutationResult {
    return taskOps.insertTask(this.idx, task);
  }

  insertTaskWithId(task: TaskRow): MutationResult {
    return taskOps.insertTaskWithId(this.idx, task);
  }

  updateTask(id: string, data: Partial<TaskRow>): MutationResult {
    return taskOps.updateTask(this.idx, id, data);
  }

  deleteTask(id: string): MutationResult {
    return taskOps.deleteTask(this.idx, id);
  }

  deleteManyTasks(ids: string[]): MutationResult {
    return taskOps.deleteManyTasks(this.idx, ids);
  }

  updateManyTasks(ids: string[], data: Partial<TaskRow>): MutationResult {
    return taskOps.updateManyTasks(this.idx, ids, data);
  }

  listTasksDueForReminder(beforeTime: string): TaskRow[] {
    return taskOps.listTasksDueForReminder(this.idx, beforeTime);
  }

  // ── Task-Tag Relations ──

  getTaskTags(taskId: string): TaskTagJoin[] {
    return taskOps.getTaskTags(this.idx, taskId);
  }

  insertTaskTag(taskId: string, tagId: string): MutationResult {
    return taskOps.insertTaskTag(this.idx, taskId, tagId);
  }

  deleteTaskTags(taskId: string): MutationResult {
    return taskOps.deleteTaskTags(this.idx, taskId);
  }

  listAllTaskTags(): TaskTagJoin[] {
    return taskOps.listAllTaskTags(this.idx);
  }

  deleteManyTaskTags(taskIds: string[]): MutationResult {
    return taskOps.deleteManyTaskTags(this.idx, taskIds);
  }

  // ── Projects ──

  listProjects(): ProjectRow[] {
    return projectOps.listProjects(this.idx);
  }

  getProject(id: string): ProjectRow[] {
    return projectOps.getProject(this.idx, id);
  }

  getProjectByName(name: string): ProjectRow[] {
    return projectOps.getProjectByName(this.idx, name);
  }

  insertProject(project: ProjectRow): MutationResult {
    return projectOps.insertProject(this.idx, project);
  }

  updateProject(id: string, data: Partial<ProjectRow>): MutationResult {
    return projectOps.updateProject(this.idx, id, data);
  }

  deleteProject(id: string): MutationResult {
    return projectOps.deleteProject(this.idx, id);
  }

  // ── Tags ──

  listTags(): TagRow[] {
    return metadataOps.listTags(this.idx);
  }

  getTagByName(name: string): TagRow[] {
    return metadataOps.getTagByName(this.idx, name);
  }

  insertTag(tag: TagRow): MutationResult {
    return metadataOps.insertTag(this.idx, tag);
  }

  deleteTag(id: string): MutationResult {
    return metadataOps.deleteTag(this.idx, id);
  }

  // ── Plugin Settings ──

  loadPluginSettings(pluginId: string): PluginSettingsRow | undefined {
    return metadataOps.loadPluginSettings(this.idx, pluginId);
  }

  savePluginSettings(pluginId: string, settings: string): void {
    metadataOps.savePluginSettings(this.idx, pluginId, settings);
  }

  // ── App Settings ──

  getAppSetting(key: string): AppSettingRow | undefined {
    return metadataOps.getAppSetting(this.idx, key);
  }

  setAppSetting(key: string, value: string): void {
    metadataOps.setAppSetting(this.idx, key, value);
  }

  deleteAppSetting(key: string): MutationResult {
    return metadataOps.deleteAppSetting(this.idx, key);
  }

  // ── Chat Messages ──

  listChatMessages(sessionId: string): ChatMessageRow[] {
    return metadataOps.listChatMessages(this.idx, sessionId);
  }

  insertChatMessage(msg: ChatMessageRow): MutationResult {
    return metadataOps.insertChatMessage(this.idx, msg);
  }

  deleteChatSession(sessionId: string): MutationResult {
    return metadataOps.deleteChatSession(this.idx, sessionId);
  }

  getLatestSessionId(): { sessionId: string } | undefined {
    return metadataOps.getLatestSessionId(this.idx);
  }

  listChatSessions(): ChatSessionInfo[] {
    return metadataOps.listChatSessions(this.idx);
  }

  renameChatSession(sessionId: string, title: string): void {
    metadataOps.renameChatSession(this.idx, sessionId, title);
  }

  // ── Plugin Permissions ──

  getPluginPermissions(pluginId: string): string[] | null {
    return metadataOps.getPluginPermissions(this.idx, pluginId);
  }

  setPluginPermissions(pluginId: string, permissions: string[]): void {
    metadataOps.setPluginPermissions(this.idx, pluginId, permissions);
  }

  deletePluginPermissions(pluginId: string): MutationResult {
    return metadataOps.deletePluginPermissions(this.idx, pluginId);
  }

  // ── Task Templates ──

  listTemplates(): TemplateRow[] {
    return metadataOps.listTemplates(this.idx);
  }

  getTemplate(id: string): TemplateRow | undefined {
    return metadataOps.getTemplate(this.idx, id);
  }

  insertTemplate(template: TemplateRow): MutationResult {
    return metadataOps.insertTemplate(this.idx, template);
  }

  updateTemplate(id: string, data: Partial<TemplateRow>): MutationResult {
    return metadataOps.updateTemplate(this.idx, id, data);
  }

  deleteTemplate(id: string): MutationResult {
    return metadataOps.deleteTemplate(this.idx, id);
  }

  // ── Sections ──

  listSections(projectId: string): SectionRow[] {
    return metadataOps.listSections(this.idx, projectId);
  }

  getSection(id: string): SectionRow | undefined {
    return metadataOps.getSection(this.idx, id);
  }

  insertSection(section: SectionRow): MutationResult {
    return metadataOps.insertSection(this.idx, section);
  }

  updateSection(id: string, data: Partial<SectionRow>): MutationResult {
    return metadataOps.updateSection(this.idx, id, data);
  }

  deleteSection(id: string): MutationResult {
    return metadataOps.deleteSection(this.idx, id);
  }

  // ── Task Comments ──

  listTaskComments(taskId: string): TaskCommentRow[] {
    return metadataOps.listTaskComments(this.idx, taskId);
  }

  insertTaskComment(comment: TaskCommentRow): MutationResult {
    return metadataOps.insertTaskComment(this.idx, comment);
  }

  updateTaskComment(id: string, data: Partial<TaskCommentRow>): MutationResult {
    return metadataOps.updateTaskComment(this.idx, id, data);
  }

  deleteTaskComment(id: string): MutationResult {
    return metadataOps.deleteTaskComment(this.idx, id);
  }

  // ── Task Activity ──

  listTaskActivity(taskId: string): TaskActivityRow[] {
    return metadataOps.listTaskActivity(this.idx, taskId);
  }

  insertTaskActivity(activity: TaskActivityRow): MutationResult {
    return metadataOps.insertTaskActivity(this.idx, activity);
  }

  // ── Daily Stats ──

  getDailyStat(date: string): DailyStatRow | undefined {
    return metadataOps.getDailyStat(this.idx, date);
  }

  upsertDailyStat(stat: DailyStatRow): MutationResult {
    return metadataOps.upsertDailyStat(this.idx, stat);
  }

  listDailyStats(startDate: string, endDate: string): DailyStatRow[] {
    return metadataOps.listDailyStats(this.idx, startDate, endDate);
  }

  // ── Task Relations ──

  listTaskRelations(): TaskRelationRow[] {
    return metadataOps.listTaskRelations(this.idx);
  }

  getTaskRelations(taskId: string): TaskRelationRow[] {
    return metadataOps.getTaskRelations(this.idx, taskId);
  }

  insertTaskRelation(relation: TaskRelationRow): MutationResult {
    return metadataOps.insertTaskRelation(this.idx, relation);
  }

  deleteTaskRelation(taskId: string, relatedTaskId: string): MutationResult {
    return metadataOps.deleteTaskRelation(this.idx, taskId, relatedTaskId);
  }

  deleteAllTaskRelations(taskId: string): MutationResult {
    return metadataOps.deleteAllTaskRelations(this.idx, taskId);
  }

  // ── AI Memories ──

  listAiMemories(): AiMemoryRow[] {
    return metadataOps.listAiMemories(this.idx);
  }

  insertAiMemory(row: AiMemoryRow): void {
    metadataOps.insertAiMemory(this.idx, row);
  }

  updateAiMemory(id: string, content: string, category: AiMemoryRow["category"]): void {
    metadataOps.updateAiMemory(this.idx, id, content, category);
  }

  deleteAiMemory(id: string): MutationResult {
    return metadataOps.deleteAiMemory(this.idx, id);
  }
}
