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
  MutationResult,
} from "./interface.js";

/**
 * SQLite backend — thin wrapper that delegates to the existing createQueries() function.
 * Satisfies IStorage so services can use either backend interchangeably.
 */
export class SQLiteBackend implements IStorage {
  private q: ReturnType<typeof createQueries>;

  constructor(db: BaseSQLiteDatabase<"sync", any, typeof schema>) {
    this.q = createQueries(db);
  }

  // ── Tasks ──

  listTasks(): TaskRow[] {
    return this.q.listTasks() as unknown as TaskRow[];
  }

  getTask(id: string): TaskRow[] {
    return this.q.getTask(id) as unknown as TaskRow[];
  }

  insertTask(task: TaskRow): MutationResult {
    return this.q.insertTask(task as any);
  }

  insertTaskWithId(task: TaskRow): MutationResult {
    return this.q.insertTaskWithId(task as any);
  }

  updateTask(id: string, data: Partial<TaskRow>): MutationResult {
    return this.q.updateTask(id, data as any);
  }

  deleteTask(id: string): MutationResult {
    return this.q.deleteTask(id);
  }

  deleteManyTasks(ids: string[]): MutationResult {
    return this.q.deleteManyTasks(ids);
  }

  updateManyTasks(ids: string[], data: Partial<TaskRow>): MutationResult {
    return this.q.updateManyTasks(ids, data as any);
  }

  // ── Task-Tag Relations ──

  getTaskTags(taskId: string): TaskTagJoin[] {
    return this.q.getTaskTags(taskId) as unknown as TaskTagJoin[];
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
    return this.q.listProjects() as unknown as ProjectRow[];
  }

  getProject(id: string): ProjectRow[] {
    return this.q.getProject(id) as unknown as ProjectRow[];
  }

  getProjectByName(name: string): ProjectRow[] {
    return this.q.getProjectByName(name) as unknown as ProjectRow[];
  }

  insertProject(project: ProjectRow): MutationResult {
    return this.q.insertProject(project as any);
  }

  updateProject(id: string, data: Partial<ProjectRow>): MutationResult {
    return this.q.updateProject(id, data as any);
  }

  deleteProject(id: string): MutationResult {
    return this.q.deleteProject(id);
  }

  // ── Tags ──

  listTags(): TagRow[] {
    return this.q.listTags() as unknown as TagRow[];
  }

  getTagByName(name: string): TagRow[] {
    return this.q.getTagByName(name) as unknown as TagRow[];
  }

  insertTag(tag: TagRow): MutationResult {
    return this.q.insertTag(tag as any);
  }

  deleteTag(id: string): MutationResult {
    return this.q.deleteTag(id);
  }

  // ── Plugin Settings ──

  loadPluginSettings(pluginId: string): PluginSettingsRow | undefined {
    return this.q.loadPluginSettings(pluginId) as PluginSettingsRow | undefined;
  }

  savePluginSettings(pluginId: string, settings: string): void {
    this.q.savePluginSettings(pluginId, settings);
  }

  // ── App Settings ──

  getAppSetting(key: string): AppSettingRow | undefined {
    return this.q.getAppSetting(key) as AppSettingRow | undefined;
  }

  setAppSetting(key: string, value: string): void {
    this.q.setAppSetting(key, value);
  }

  deleteAppSetting(key: string): MutationResult {
    return this.q.deleteAppSetting(key);
  }

  // ── Chat Messages ──

  listChatMessages(sessionId: string): ChatMessageRow[] {
    return this.q.listChatMessages(sessionId) as unknown as ChatMessageRow[];
  }

  insertChatMessage(msg: ChatMessageRow): MutationResult {
    return this.q.insertChatMessage(msg as any);
  }

  deleteChatSession(sessionId: string): MutationResult {
    return this.q.deleteChatSession(sessionId);
  }

  getLatestSessionId(): { sessionId: string } | undefined {
    return this.q.getLatestSessionId();
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
}
