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
  parentId: string | null;
  remindAt: string | null;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  deadline: string | null;
  isSomeday: boolean;
  sectionId: string | null;
  dreadLevel: number | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SectionRow {
  id: string;
  projectId: string;
  name: string;
  sortOrder: number;
  isCollapsed: boolean;
  createdAt: string;
}

export interface TaskCommentRow {
  id: string;
  taskId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskActivityRow {
  id: string;
  taskId: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

export interface DailyStatRow {
  id: string;
  date: string;
  tasksCompleted: number;
  tasksCreated: number;
  minutesTracked: number;
  streak: number;
  createdAt: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  parentId: string | null;
  isFavorite: boolean;
  viewStyle: "list" | "board" | "calendar";
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

export interface ChatSessionInfo {
  sessionId: string;
  title: string;
  createdAt: string;
  messageCount: number;
}

export interface TemplateRow {
  id: string;
  name: string;
  title: string;
  description: string | null;
  priority: number | null;
  tags: string | null;
  projectId: string | null;
  recurrence: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRelationRow {
  taskId: string;
  relatedTaskId: string;
  type: "blocks";
}

export interface AiMemoryRow {
  id: string;
  content: string;
  category: "preference" | "habit" | "context" | "instruction" | "pattern";
  createdAt: string;
  updatedAt: string;
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
  listChatSessions(): ChatSessionInfo[];
  renameChatSession(sessionId: string, title: string): void;

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

  // ── Task Relations ──
  listTaskRelations(): TaskRelationRow[];
  getTaskRelations(taskId: string): TaskRelationRow[];
  insertTaskRelation(relation: TaskRelationRow): MutationResult;
  deleteTaskRelation(taskId: string, relatedTaskId: string): MutationResult;
  deleteAllTaskRelations(taskId: string): MutationResult;

  // ── Daily Stats ──
  getDailyStat(date: string): DailyStatRow | undefined;
  upsertDailyStat(stat: DailyStatRow): MutationResult;
  listDailyStats(startDate: string, endDate: string): DailyStatRow[];

  // ── AI Memories ──
  listAiMemories(): AiMemoryRow[];
  insertAiMemory(row: AiMemoryRow): void;
  updateAiMemory(id: string, content: string, category: AiMemoryRow["category"]): void;
  deleteAiMemory(id: string): MutationResult;
}
