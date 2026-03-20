import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "../db/schema.js";
import { createQueries } from "../db/queries.js";
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

/**
 * Re-types createQueries() using IStorage row types so all per-method casts
 * collapse into a single cast in the SQLiteBackend constructor.
 *
 * The underlying Drizzle $inferInsert/$inferSelect types are structurally
 * compatible but nominally distinct — this interface bridges the two worlds.
 */
interface StorageQueries {
  // ── Tasks ──
  listTasks(): TaskRow[];
  getTask(id: string): TaskRow[];
  insertTask(task: TaskRow): MutationResult;
  insertTaskWithId(task: TaskRow): MutationResult;
  updateTask(id: string, data: Partial<TaskRow>): MutationResult;
  deleteTask(id: string): MutationResult;
  deleteManyTasks(ids: string[]): MutationResult;
  updateManyTasks(ids: string[], data: Partial<TaskRow>): MutationResult;
  listTasksDueForReminder(beforeTime: string): TaskRow[];

  // ── Task-Tag Relations ──
  getTaskTags(taskId: string): TaskTagJoin[];
  listAllTaskTags(): TaskTagJoin[];
  insertTaskTag(taskId: string, tagId: string): MutationResult;
  deleteTaskTags(taskId: string): MutationResult;
  deleteManyTaskTags(taskIds: string[]): MutationResult;

  // ── Projects ──
  listProjects(): ProjectRow[];
  getProject(id: string): ProjectRow[];
  getProjectByName(name: string): ProjectRow[];
  insertProject(project: ProjectRow): MutationResult;
  updateProject(id: string, data: Partial<ProjectRow>): MutationResult;
  deleteProject(id: string): MutationResult;

  // ── Tags ──
  listTags(): TagRow[];
  getTagByName(name: string): TagRow[];
  insertTag(tag: TagRow): MutationResult;
  deleteTag(id: string): MutationResult;

  // ── Plugin Settings ──
  loadPluginSettings(pluginId: string): PluginSettingsRow | undefined;
  savePluginSettings(pluginId: string, settings: string): void;

  // ── App Settings ──
  getAppSetting(key: string): AppSettingRow | undefined;
  listAllAppSettings(): AppSettingRow[];
  setAppSetting(key: string, value: string): void;
  deleteAppSetting(key: string): MutationResult;

  // ── Chat Messages ──
  listChatMessages(sessionId: string): ChatMessageRow[];
  insertChatMessage(msg: ChatMessageRow): MutationResult;
  deleteChatSession(sessionId: string): MutationResult;
  getLatestSessionId(): { sessionId: string } | undefined;
  /** Raw aggregate — returns session metadata without titles. */
  listChatSessions(): { sessionId: string; createdAt: string | null; messageCount: number }[];
  /** Returns first user message content for title derivation. */
  getFirstUserMessage(sessionId: string): { content: string } | undefined;

  // ── Plugin Permissions ──
  getPluginPermissions(pluginId: string): string[] | null;
  setPluginPermissions(pluginId: string, permissions: string[]): void;
  deletePluginPermissions(pluginId: string): MutationResult;

  // ── Task Templates ──
  listTemplates(): TemplateRow[];
  getTemplate(id: string): TemplateRow | undefined;
  insertTemplate(template: TemplateRow): MutationResult;
  updateTemplate(id: string, data: Partial<TemplateRow>): MutationResult;
  deleteTemplate(id: string): MutationResult;

  // ── Sections ──
  listSections(projectId: string): SectionRow[];
  getSection(id: string): SectionRow | undefined;
  insertSection(section: SectionRow): MutationResult;
  updateSection(id: string, data: Partial<SectionRow>): MutationResult;
  deleteSection(id: string): MutationResult;

  // ── Task Comments ──
  listTaskComments(taskId: string): TaskCommentRow[];
  insertTaskComment(comment: TaskCommentRow): MutationResult;
  updateTaskComment(id: string, data: Partial<TaskCommentRow>): MutationResult;
  deleteTaskComment(id: string): MutationResult;

  // ── Task Activity ──
  listTaskActivity(taskId: string): TaskActivityRow[];
  insertTaskActivity(activity: TaskActivityRow): MutationResult;

  // ── Daily Stats ──
  getDailyStat(date: string): DailyStatRow | undefined;
  upsertDailyStat(stat: DailyStatRow): MutationResult;
  listDailyStats(startDate: string, endDate: string): DailyStatRow[];

  // ── Task Relations ──
  listTaskRelations(): TaskRelationRow[];
  getTaskRelations(taskId: string): TaskRelationRow[];
  insertTaskRelation(relation: TaskRelationRow): MutationResult;
  deleteTaskRelation(taskId: string, relatedTaskId: string): MutationResult;
  deleteAllTaskRelations(taskId: string): MutationResult;

  // ── AI Memories ──
  listAiMemories(): AiMemoryRow[];
  insertAiMemory(row: AiMemoryRow): void;
  updateAiMemory(id: string, content: string, category: AiMemoryRow["category"]): void;
  deleteAiMemory(id: string): MutationResult;
}

/**
 * SQLite backend — thin wrapper that delegates to the existing createQueries() function.
 * Satisfies IStorage so services can use either backend interchangeably.
 */
export class SQLiteBackend implements IStorage {
  private q: StorageQueries;

  constructor(db: BaseSQLiteDatabase<"sync", any, typeof schema>) {
    this.q = createQueries(db) as unknown as StorageQueries;
  }

  // ── Tasks ──

  listTasks(): TaskRow[] {
    return this.q.listTasks();
  }

  getTask(id: string): TaskRow[] {
    return this.q.getTask(id);
  }

  insertTask(task: TaskRow): MutationResult {
    return this.q.insertTask(task);
  }

  insertTaskWithId(task: TaskRow): MutationResult {
    return this.q.insertTaskWithId(task);
  }

  updateTask(id: string, data: Partial<TaskRow>): MutationResult {
    return this.q.updateTask(id, data);
  }

  deleteTask(id: string): MutationResult {
    return this.q.deleteTask(id);
  }

  deleteManyTasks(ids: string[]): MutationResult {
    return this.q.deleteManyTasks(ids);
  }

  updateManyTasks(ids: string[], data: Partial<TaskRow>): MutationResult {
    return this.q.updateManyTasks(ids, data);
  }

  listTasksDueForReminder(beforeTime: string): TaskRow[] {
    return this.q.listTasksDueForReminder(beforeTime);
  }

  // ── Task-Tag Relations ──

  getTaskTags(taskId: string): TaskTagJoin[] {
    return this.q.getTaskTags(taskId);
  }

  listAllTaskTags(): TaskTagJoin[] {
    return this.q.listAllTaskTags();
  }

  insertTaskTag(taskId: string, tagId: string): MutationResult {
    return this.q.insertTaskTag(taskId, tagId);
  }

  deleteTaskTags(taskId: string): MutationResult {
    return this.q.deleteTaskTags(taskId);
  }

  deleteManyTaskTags(taskIds: string[]): MutationResult {
    return this.q.deleteManyTaskTags(taskIds);
  }

  // ── Projects ──

  listProjects(): ProjectRow[] {
    return this.q.listProjects();
  }

  getProject(id: string): ProjectRow[] {
    return this.q.getProject(id);
  }

  getProjectByName(name: string): ProjectRow[] {
    return this.q.getProjectByName(name);
  }

  insertProject(project: ProjectRow): MutationResult {
    return this.q.insertProject(project);
  }

  updateProject(id: string, data: Partial<ProjectRow>): MutationResult {
    return this.q.updateProject(id, data);
  }

  deleteProject(id: string): MutationResult {
    return this.q.deleteProject(id);
  }

  // ── Tags ──

  listTags(): TagRow[] {
    return this.q.listTags();
  }

  getTagByName(name: string): TagRow[] {
    return this.q.getTagByName(name);
  }

  insertTag(tag: TagRow): MutationResult {
    return this.q.insertTag(tag);
  }

  deleteTag(id: string): MutationResult {
    return this.q.deleteTag(id);
  }

  // ── Plugin Settings ──

  loadPluginSettings(pluginId: string): PluginSettingsRow | undefined {
    return this.q.loadPluginSettings(pluginId);
  }

  savePluginSettings(pluginId: string, settings: string): void {
    this.q.savePluginSettings(pluginId, settings);
  }

  // ── App Settings ──

  getAppSetting(key: string): AppSettingRow | undefined {
    return this.q.getAppSetting(key);
  }

  listAllAppSettings(): AppSettingRow[] {
    return this.q.listAllAppSettings();
  }

  setAppSetting(key: string, value: string): void {
    this.q.setAppSetting(key, value);
  }

  deleteAppSetting(key: string): MutationResult {
    return this.q.deleteAppSetting(key);
  }

  // ── Chat Messages ──

  listChatMessages(sessionId: string): ChatMessageRow[] {
    return this.q.listChatMessages(sessionId);
  }

  insertChatMessage(msg: ChatMessageRow): MutationResult {
    return this.q.insertChatMessage(msg);
  }

  deleteChatSession(sessionId: string): MutationResult {
    return this.q.deleteChatSession(sessionId);
  }

  getLatestSessionId(): { sessionId: string } | undefined {
    return this.q.getLatestSessionId();
  }

  listChatSessions(): ChatSessionInfo[] {
    const rows = this.q.listChatSessions();
    return rows.map((row) => {
      // Derive title from first user message or stored override
      const override = this.q.getAppSetting(`chat_session_title:${row.sessionId}`);
      let title = override?.value ?? "";
      if (!title) {
        const firstMsg = this.q.getFirstUserMessage(row.sessionId);
        title = firstMsg?.content?.slice(0, 40) ?? "New chat";
      }
      return {
        sessionId: row.sessionId,
        title,
        createdAt: row.createdAt ?? new Date().toISOString(),
        messageCount: row.messageCount,
      };
    });
  }

  renameChatSession(sessionId: string, title: string): void {
    this.q.setAppSetting(`chat_session_title:${sessionId}`, title);
  }

  // ── Plugin Permissions ──

  getPluginPermissions(pluginId: string): string[] | null {
    return this.q.getPluginPermissions(pluginId);
  }

  setPluginPermissions(pluginId: string, permissions: string[]): void {
    this.q.setPluginPermissions(pluginId, permissions);
  }

  deletePluginPermissions(pluginId: string): MutationResult {
    return this.q.deletePluginPermissions(pluginId);
  }

  // ── Task Templates ──

  listTemplates(): TemplateRow[] {
    return this.q.listTemplates();
  }

  getTemplate(id: string): TemplateRow | undefined {
    return this.q.getTemplate(id);
  }

  insertTemplate(template: TemplateRow): MutationResult {
    return this.q.insertTemplate(template);
  }

  updateTemplate(id: string, data: Partial<TemplateRow>): MutationResult {
    return this.q.updateTemplate(id, data);
  }

  deleteTemplate(id: string): MutationResult {
    return this.q.deleteTemplate(id);
  }

  // ── Sections ──

  listSections(projectId: string): SectionRow[] {
    return this.q.listSections(projectId);
  }

  getSection(id: string): SectionRow | undefined {
    return this.q.getSection(id);
  }

  insertSection(section: SectionRow): MutationResult {
    return this.q.insertSection(section);
  }

  updateSection(id: string, data: Partial<SectionRow>): MutationResult {
    return this.q.updateSection(id, data);
  }

  deleteSection(id: string): MutationResult {
    return this.q.deleteSection(id);
  }

  // ── Task Comments ──

  listTaskComments(taskId: string): TaskCommentRow[] {
    return this.q.listTaskComments(taskId);
  }

  insertTaskComment(comment: TaskCommentRow): MutationResult {
    return this.q.insertTaskComment(comment);
  }

  updateTaskComment(id: string, data: Partial<TaskCommentRow>): MutationResult {
    return this.q.updateTaskComment(id, data);
  }

  deleteTaskComment(id: string): MutationResult {
    return this.q.deleteTaskComment(id);
  }

  // ── Task Activity ──

  listTaskActivity(taskId: string): TaskActivityRow[] {
    return this.q.listTaskActivity(taskId);
  }

  insertTaskActivity(activity: TaskActivityRow): MutationResult {
    return this.q.insertTaskActivity(activity);
  }

  // ── Daily Stats ──

  getDailyStat(date: string): DailyStatRow | undefined {
    return this.q.getDailyStat(date);
  }

  upsertDailyStat(stat: DailyStatRow): MutationResult {
    return this.q.upsertDailyStat(stat);
  }

  listDailyStats(startDate: string, endDate: string): DailyStatRow[] {
    return this.q.listDailyStats(startDate, endDate);
  }

  // ── Task Relations ──

  listTaskRelations(): TaskRelationRow[] {
    return this.q.listTaskRelations();
  }

  getTaskRelations(taskId: string): TaskRelationRow[] {
    return this.q.getTaskRelations(taskId);
  }

  insertTaskRelation(relation: TaskRelationRow): MutationResult {
    return this.q.insertTaskRelation(relation);
  }

  deleteTaskRelation(taskId: string, relatedTaskId: string): MutationResult {
    return this.q.deleteTaskRelation(taskId, relatedTaskId);
  }

  deleteAllTaskRelations(taskId: string): MutationResult {
    return this.q.deleteAllTaskRelations(taskId);
  }

  // ── AI Memories ──

  listAiMemories(): AiMemoryRow[] {
    return this.q.listAiMemories();
  }

  insertAiMemory(row: AiMemoryRow): void {
    this.q.insertAiMemory(row);
  }

  updateAiMemory(id: string, content: string, category: AiMemoryRow["category"]): void {
    this.q.updateAiMemory(id, content, category);
  }

  deleteAiMemory(id: string): MutationResult {
    return this.q.deleteAiMemory(id);
  }
}
