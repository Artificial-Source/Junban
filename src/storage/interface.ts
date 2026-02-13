/** Row types matching DB schema (without hydrated relations). */

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: "pending" | "completed" | "cancelled";
  priority: number | null;
  dueDate: string | null;
  dueTime: boolean;
  completedAt: string | null;
  projectId: string | null;
  recurrence: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  sortOrder: number;
  archived: boolean;
  createdAt: string;
}

export interface TagRow {
  id: string;
  name: string;
  color: string;
}

export interface TaskTagJoin {
  task_tags: { taskId: string; tagId: string };
  tags: TagRow;
}

export interface PluginSettingsRow {
  pluginId: string;
  settings: string;
  updatedAt: string;
}

export interface AppSettingRow {
  key: string;
  value: string;
  updatedAt: string;
}

export interface ChatMessageRow {
  id?: number;
  sessionId: string;
  role: string;
  content: string;
  toolCallId: string | null;
  toolCalls: string | null;
  createdAt: string;
}

/** Result type for mutations that report affected row count. */
export interface MutationResult {
  changes: number;
}

/**
 * Storage abstraction — both SQLite and Markdown backends implement this.
 * Method signatures mirror the existing Queries type for drop-in compatibility.
 */
export interface IStorage {
  // ── Tasks ──
  listTasks(): TaskRow[];
  getTask(id: string): TaskRow[];
  insertTask(task: TaskRow): MutationResult;
  insertTaskWithId(task: TaskRow): MutationResult;
  updateTask(id: string, data: Partial<TaskRow>): MutationResult;
  deleteTask(id: string): MutationResult;
  deleteManyTasks(ids: string[]): MutationResult;
  updateManyTasks(ids: string[], data: Partial<TaskRow>): MutationResult;

  // ── Task-Tag Relations ──
  getTaskTags(taskId: string): TaskTagJoin[];
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
  setAppSetting(key: string, value: string): void;
  deleteAppSetting(key: string): MutationResult;

  // ── Chat Messages ──
  listChatMessages(sessionId: string): ChatMessageRow[];
  insertChatMessage(msg: ChatMessageRow): MutationResult;
  deleteChatSession(sessionId: string): MutationResult;
  getLatestSessionId(): { sessionId: string } | undefined;

  // ── Plugin Permissions ──
  getPluginPermissions(pluginId: string): string[] | null;
  setPluginPermissions(pluginId: string, permissions: string[]): void;
  deletePluginPermissions(pluginId: string): MutationResult;
}
