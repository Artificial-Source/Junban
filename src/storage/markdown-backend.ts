import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parseTaskFile, serializeTaskFile, taskFilename, slugify } from "./markdown-utils.js";
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

const OK: MutationResult = { changes: 1 };
const NOOP: MutationResult = { changes: 0 };

/**
 * Markdown storage backend — stores tasks as .md files with YAML frontmatter.
 * Reads are served from in-memory indexes; writes update both index and disk.
 */
export class MarkdownBackend implements IStorage {
  private basePath: string;

  // In-memory indexes
  private taskIndex = new Map<
    string,
    { row: TaskRow; filePath: string; description: string | null }
  >();
  private projectIndex = new Map<string, { row: ProjectRow; dirPath: string }>();
  private tagIndex = new Map<string, TagRow>();
  private taskTagIndex = new Map<string, Set<string>>(); // taskId → Set<tagId>
  private appSettings = new Map<string, AppSettingRow>();
  private pluginSettingsMap = new Map<string, PluginSettingsRow>();
  private pluginPermissions = new Map<string, string[]>();
  private chatMessages = new Map<string, ChatMessageRow[]>(); // sessionId → messages

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /** Scan directory tree, parse all files, build in-memory indexes. */
  initialize(): void {
    // Ensure base directories exist
    const dirs = [
      path.join(this.basePath, "inbox"),
      path.join(this.basePath, "projects"),
      path.join(this.basePath, "_plugins"),
      path.join(this.basePath, "_chat"),
    ];
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 1. Read _tags.yaml
    this.loadTags();

    // 2. Read projects/*/_project.yaml
    this.loadProjects();

    // 3. Read all .md files in inbox/ and projects/*/
    this.loadTasks();

    // 4. Read _settings.yaml
    this.loadAppSettings();

    // 5. Read _plugins/*.yaml
    this.loadPluginData();

    // 6. Read _chat/*.yaml
    this.loadChatData();
  }

  // ── Tasks ──

  listTasks(): TaskRow[] {
    return Array.from(this.taskIndex.values()).map((e) => e.row);
  }

  getTask(id: string): TaskRow[] {
    const entry = this.taskIndex.get(id);
    return entry ? [entry.row] : [];
  }

  insertTask(task: TaskRow): MutationResult {
    const description = task.description;
    const dir = this.getTaskDir(task.projectId);
    const filename = taskFilename(task.title, task.id);
    const filePath = path.join(dir, filename);

    // Get tag names for frontmatter
    const tagNames = this.getTagNamesForTask(task.id);
    const content = serializeTaskFile(task, task.title, description, tagNames);
    fs.writeFileSync(filePath, content, "utf-8");

    this.taskIndex.set(task.id, { row: { ...task, description: null }, filePath, description });
    return OK;
  }

  insertTaskWithId(task: TaskRow): MutationResult {
    return this.insertTask(task);
  }

  updateTask(id: string, data: Partial<TaskRow>): MutationResult {
    const entry = this.taskIndex.get(id);
    if (!entry) return NOOP;

    const oldRow = entry.row;
    const newRow = { ...oldRow, ...data };
    let newDescription = entry.description;
    if ("description" in data) {
      newDescription = data.description ?? null;
    }
    let newFilePath = entry.filePath;

    // If title changed → rename file
    const titleChanged = data.title && data.title !== oldRow.title;
    // If projectId changed → move file
    const projectChanged = "projectId" in data && data.projectId !== oldRow.projectId;

    if (titleChanged || projectChanged) {
      // Remove old file
      if (fs.existsSync(entry.filePath)) {
        fs.unlinkSync(entry.filePath);
      }
      const dir = this.getTaskDir(newRow.projectId);
      const filename = taskFilename(newRow.title, id);
      newFilePath = path.join(dir, filename);
    }

    // Get tag names and rewrite file
    const tagNames = this.getTagNamesForTask(id);
    const content = serializeTaskFile(newRow, newRow.title, newDescription, tagNames);
    fs.mkdirSync(path.dirname(newFilePath), { recursive: true });
    fs.writeFileSync(newFilePath, content, "utf-8");

    this.taskIndex.set(id, { row: newRow, filePath: newFilePath, description: newDescription });
    return OK;
  }

  deleteTask(id: string): MutationResult {
    const entry = this.taskIndex.get(id);
    if (!entry) return NOOP;

    if (fs.existsSync(entry.filePath)) {
      fs.unlinkSync(entry.filePath);
    }
    this.taskIndex.delete(id);
    this.taskTagIndex.delete(id);
    return OK;
  }

  deleteManyTasks(ids: string[]): MutationResult {
    let changes = 0;
    for (const id of ids) {
      if (this.deleteTask(id).changes > 0) changes++;
    }
    return { changes };
  }

  updateManyTasks(ids: string[], data: Partial<TaskRow>): MutationResult {
    let changes = 0;
    for (const id of ids) {
      if (this.updateTask(id, data).changes > 0) changes++;
    }
    return { changes };
  }

  // ── Task-Tag Relations ──

  getTaskTags(taskId: string): TaskTagJoin[] {
    const tagIds = this.taskTagIndex.get(taskId);
    if (!tagIds) return [];

    const results: TaskTagJoin[] = [];
    for (const tagId of tagIds) {
      const tag = this.tagIndex.get(tagId);
      if (tag) {
        results.push({
          task_tags: { taskId, tagId },
          tags: tag,
        });
      }
    }
    return results;
  }

  insertTaskTag(taskId: string, tagId: string): MutationResult {
    let set = this.taskTagIndex.get(taskId);
    if (!set) {
      set = new Set();
      this.taskTagIndex.set(taskId, set);
    }
    set.add(tagId);

    // Rewrite the task file to include updated tags
    this.rewriteTaskFile(taskId);
    return OK;
  }

  deleteTaskTags(taskId: string): MutationResult {
    const had = this.taskTagIndex.has(taskId);
    this.taskTagIndex.delete(taskId);

    // Rewrite the task file to remove tags from frontmatter
    this.rewriteTaskFile(taskId);
    return had ? OK : NOOP;
  }

  deleteManyTaskTags(taskIds: string[]): MutationResult {
    let changes = 0;
    for (const taskId of taskIds) {
      if (this.deleteTaskTags(taskId).changes > 0) changes++;
    }
    return { changes };
  }

  // ── Projects ──

  listProjects(): ProjectRow[] {
    return Array.from(this.projectIndex.values()).map((e) => e.row);
  }

  getProject(id: string): ProjectRow[] {
    const entry = this.projectIndex.get(id);
    return entry ? [entry.row] : [];
  }

  getProjectByName(name: string): ProjectRow[] {
    for (const entry of this.projectIndex.values()) {
      if (entry.row.name === name) return [entry.row];
    }
    return [];
  }

  insertProject(project: ProjectRow): MutationResult {
    const dirName = slugify(project.name) || project.id;
    const dirPath = path.join(this.basePath, "projects", dirName);
    fs.mkdirSync(dirPath, { recursive: true });

    const meta: Record<string, unknown> = {
      id: project.id,
      color: project.color,
      icon: project.icon,
      sortOrder: project.sortOrder,
      archived: project.archived,
      createdAt: project.createdAt,
    };
    fs.writeFileSync(path.join(dirPath, "_project.yaml"), YAML.stringify(meta), "utf-8");

    this.projectIndex.set(project.id, { row: project, dirPath });
    return OK;
  }

  updateProject(id: string, data: Partial<ProjectRow>): MutationResult {
    const entry = this.projectIndex.get(id);
    if (!entry) return NOOP;

    const newRow = { ...entry.row, ...data };
    const meta: Record<string, unknown> = {
      id: newRow.id,
      color: newRow.color,
      icon: newRow.icon,
      sortOrder: newRow.sortOrder,
      archived: newRow.archived,
      createdAt: newRow.createdAt,
    };
    fs.writeFileSync(path.join(entry.dirPath, "_project.yaml"), YAML.stringify(meta), "utf-8");

    this.projectIndex.set(id, { row: newRow, dirPath: entry.dirPath });
    return OK;
  }

  deleteProject(id: string): MutationResult {
    const entry = this.projectIndex.get(id);
    if (!entry) return NOOP;

    // Move project tasks to inbox
    for (const [taskId, taskEntry] of this.taskIndex) {
      if (taskEntry.row.projectId === id) {
        this.updateTask(taskId, { projectId: null });
      }
    }

    // Remove project directory
    if (fs.existsSync(entry.dirPath)) {
      fs.rmSync(entry.dirPath, { recursive: true, force: true });
    }
    this.projectIndex.delete(id);
    return OK;
  }

  // ── Tags ──

  listTags(): TagRow[] {
    return Array.from(this.tagIndex.values());
  }

  getTagByName(name: string): TagRow[] {
    for (const tag of this.tagIndex.values()) {
      if (tag.name === name) return [tag];
    }
    return [];
  }

  insertTag(tag: TagRow): MutationResult {
    this.tagIndex.set(tag.id, tag);
    this.persistTags();
    return OK;
  }

  deleteTag(id: string): MutationResult {
    const had = this.tagIndex.has(id);
    this.tagIndex.delete(id);
    this.persistTags();
    return had ? OK : NOOP;
  }

  // ── Plugin Settings ──

  loadPluginSettings(pluginId: string): PluginSettingsRow | undefined {
    return this.pluginSettingsMap.get(pluginId);
  }

  savePluginSettings(pluginId: string, settings: string): void {
    const now = new Date().toISOString();
    const row: PluginSettingsRow = { pluginId, settings, updatedAt: now };
    this.pluginSettingsMap.set(pluginId, row);

    const filePath = path.join(this.basePath, "_plugins", `${pluginId}.yaml`);
    fs.writeFileSync(filePath, YAML.stringify({ settings, updatedAt: now }), "utf-8");
  }

  // ── App Settings ──

  getAppSetting(key: string): AppSettingRow | undefined {
    return this.appSettings.get(key);
  }

  setAppSetting(key: string, value: string): void {
    const now = new Date().toISOString();
    this.appSettings.set(key, { key, value, updatedAt: now });
    this.persistAppSettings();
  }

  deleteAppSetting(key: string): MutationResult {
    const had = this.appSettings.has(key);
    this.appSettings.delete(key);
    this.persistAppSettings();
    return had ? OK : NOOP;
  }

  // ── Chat Messages ──

  listChatMessages(sessionId: string): ChatMessageRow[] {
    return this.chatMessages.get(sessionId) ?? [];
  }

  insertChatMessage(msg: ChatMessageRow): MutationResult {
    let messages = this.chatMessages.get(msg.sessionId);
    if (!messages) {
      messages = [];
      this.chatMessages.set(msg.sessionId, messages);
    }
    messages.push(msg);
    this.persistChatSession(msg.sessionId);
    return OK;
  }

  deleteChatSession(sessionId: string): MutationResult {
    const had = this.chatMessages.has(sessionId);
    this.chatMessages.delete(sessionId);

    const filePath = path.join(this.basePath, "_chat", `${sessionId}.yaml`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return had ? OK : NOOP;
  }

  getLatestSessionId(): { sessionId: string } | undefined {
    // Find the session with the most recent message
    let latest: { sessionId: string; time: string } | undefined;
    for (const [sessionId, messages] of this.chatMessages) {
      if (messages.length === 0) continue;
      const lastMsg = messages[messages.length - 1];
      if (!latest || lastMsg.createdAt > latest.time) {
        latest = { sessionId, time: lastMsg.createdAt };
      }
    }
    return latest ? { sessionId: latest.sessionId } : undefined;
  }

  // ── Plugin Permissions ──

  getPluginPermissions(pluginId: string): string[] | null {
    return this.pluginPermissions.get(pluginId) ?? null;
  }

  setPluginPermissions(pluginId: string, permissions: string[]): void {
    this.pluginPermissions.set(pluginId, permissions);
    this.persistPluginPermissions();
  }

  deletePluginPermissions(pluginId: string): MutationResult {
    const had = this.pluginPermissions.has(pluginId);
    this.pluginPermissions.delete(pluginId);
    this.persistPluginPermissions();
    return had ? OK : NOOP;
  }

  // ── Private helpers ──

  private getTaskDir(projectId: string | null): string {
    if (!projectId) return path.join(this.basePath, "inbox");

    const projEntry = this.projectIndex.get(projectId);
    if (projEntry) return projEntry.dirPath;

    // Fallback to inbox if project not found
    return path.join(this.basePath, "inbox");
  }

  private getTagNamesForTask(taskId: string): string[] {
    const tagIds = this.taskTagIndex.get(taskId);
    if (!tagIds) return [];
    const names: string[] = [];
    for (const tagId of tagIds) {
      const tag = this.tagIndex.get(tagId);
      if (tag) names.push(tag.name);
    }
    return names;
  }

  private rewriteTaskFile(taskId: string): void {
    const entry = this.taskIndex.get(taskId);
    if (!entry) return;

    const tagNames = this.getTagNamesForTask(taskId);
    const content = serializeTaskFile(entry.row, entry.row.title, entry.description, tagNames);
    fs.writeFileSync(entry.filePath, content, "utf-8");
  }

  private persistTags(): void {
    const tags = Array.from(this.tagIndex.values()).sort((a, b) => a.name.localeCompare(b.name));
    const filePath = path.join(this.basePath, "_tags.yaml");
    fs.writeFileSync(filePath, YAML.stringify(tags), "utf-8");
  }

  private persistAppSettings(): void {
    const obj: Record<string, { value: string; updatedAt: string }> = {};
    for (const [key, row] of [...this.appSettings.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      obj[key] = { value: row.value, updatedAt: row.updatedAt };
    }
    const filePath = path.join(this.basePath, "_settings.yaml");
    fs.writeFileSync(filePath, YAML.stringify(obj), "utf-8");
  }

  private persistPluginPermissions(): void {
    const obj: Record<string, string[]> = {};
    for (const [id, perms] of this.pluginPermissions) {
      obj[id] = perms;
    }
    const filePath = path.join(this.basePath, "_plugins", "permissions.yaml");
    fs.writeFileSync(filePath, YAML.stringify(obj), "utf-8");
  }

  private persistChatSession(sessionId: string): void {
    const messages = this.chatMessages.get(sessionId);
    if (!messages) return;
    const filePath = path.join(this.basePath, "_chat", `${sessionId}.yaml`);
    fs.writeFileSync(filePath, YAML.stringify(messages), "utf-8");
  }

  // ── Loading ──

  private loadTags(): void {
    const filePath = path.join(this.basePath, "_tags.yaml");
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, "utf-8");
    const tags = YAML.parse(content);
    if (Array.isArray(tags)) {
      for (const tag of tags) {
        this.tagIndex.set(tag.id, tag as TagRow);
      }
    }
  }

  private loadProjects(): void {
    const projectsDir = path.join(this.basePath, "projects");
    if (!fs.existsSync(projectsDir)) return;

    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(projectsDir, entry.name);
      const metaPath = path.join(dirPath, "_project.yaml");
      if (!fs.existsSync(metaPath)) continue;

      const content = fs.readFileSync(metaPath, "utf-8");
      const meta = YAML.parse(content);
      const row: ProjectRow = {
        id: meta.id,
        name: entry.name, // directory name
        color: meta.color ?? "#3b82f6",
        icon: meta.icon ?? null,
        sortOrder: meta.sortOrder ?? 0,
        archived: meta.archived ?? false,
        createdAt: meta.createdAt ?? new Date().toISOString(),
      };

      // Store the original name from the directory
      if (meta.name) {
        row.name = meta.name;
      }

      this.projectIndex.set(row.id, { row, dirPath });
    }
  }

  private loadTasks(): void {
    // Load tasks from inbox/
    this.loadTasksFromDir(path.join(this.basePath, "inbox"), null);

    // Load tasks from each project directory
    for (const [projectId, entry] of this.projectIndex) {
      this.loadTasksFromDir(entry.dirPath, projectId);
    }
  }

  private loadTasksFromDir(dirPath: string, projectId: string | null): void {
    if (!fs.existsSync(dirPath)) return;

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const { task, tagNames } = parseTaskFile(content, projectId);

      if (!task.id) continue; // Skip files without an ID

      this.taskIndex.set(task.id, {
        row: { ...task, description: null },
        filePath,
        description: task.description,
      });

      // Resolve tag names to IDs
      const tagIds = new Set<string>();
      for (const tagName of tagNames) {
        for (const [tagId, tag] of this.tagIndex) {
          if (tag.name === tagName) {
            tagIds.add(tagId);
            break;
          }
        }
      }
      if (tagIds.size > 0) {
        this.taskTagIndex.set(task.id, tagIds);
      }
    }
  }

  private loadAppSettings(): void {
    const filePath = path.join(this.basePath, "_settings.yaml");
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, "utf-8");
    const obj = YAML.parse(content);
    if (obj && typeof obj === "object") {
      for (const [key, val] of Object.entries(obj)) {
        const entry = val as { value: string; updatedAt: string };
        this.appSettings.set(key, { key, value: entry.value, updatedAt: entry.updatedAt });
      }
    }
  }

  private loadPluginData(): void {
    const pluginsDir = path.join(this.basePath, "_plugins");
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
        this.pluginSettingsMap.set(pluginId, {
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
          this.pluginPermissions.set(id, perms as string[]);
        }
      }
    }
  }

  private loadChatData(): void {
    const chatDir = path.join(this.basePath, "_chat");
    if (!fs.existsSync(chatDir)) return;

    const files = fs.readdirSync(chatDir).filter((f) => f.endsWith(".yaml"));
    for (const file of files) {
      const sessionId = file.replace(".yaml", "");
      const filePath = path.join(chatDir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const messages = YAML.parse(content);
      if (Array.isArray(messages)) {
        this.chatMessages.set(sessionId, messages as ChatMessageRow[]);
      }
    }
  }
}
