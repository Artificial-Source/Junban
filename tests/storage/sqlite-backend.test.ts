import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../../src/db/schema.js";
import { SQLiteBackend } from "../../src/storage/sqlite-backend.js";
import type { IStorage, TaskRow, ProjectRow, TagRow } from "../../src/storage/interface.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../src/db/migrations");

function createBackend(): IStorage {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return new SQLiteBackend(db);
}

const now = new Date().toISOString();

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-1",
    title: "Test task",
    description: null,
    status: "pending",
    priority: null,
    dueDate: null,
    dueTime: false,
    completedAt: null,
    projectId: null,
    recurrence: null,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: "proj-1",
    name: "Work",
    color: "#3b82f6",
    icon: null,
    sortOrder: 0,
    archived: false,
    createdAt: now,
    ...overrides,
  };
}

function makeTag(overrides: Partial<TagRow> = {}): TagRow {
  return {
    id: "tag-1",
    name: "urgent",
    color: "#ef4444",
    ...overrides,
  };
}

describe("SQLiteBackend", () => {
  let storage: IStorage;

  beforeEach(() => {
    storage = createBackend();
  });

  describe("Tasks", () => {
    it("inserts and lists tasks", () => {
      storage.insertTask(makeTask());
      const tasks = storage.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Test task");
    });

    it("gets a task by ID", () => {
      storage.insertTask(makeTask());
      const rows = storage.getTask("task-1");
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("task-1");
    });

    it("returns empty array for unknown task", () => {
      expect(storage.getTask("nonexistent")).toHaveLength(0);
    });

    it("updates a task", () => {
      storage.insertTask(makeTask());
      storage.updateTask("task-1", { title: "Updated", priority: 2 });
      const [task] = storage.getTask("task-1");
      expect(task.title).toBe("Updated");
      expect(task.priority).toBe(2);
    });

    it("deletes a task", () => {
      storage.insertTask(makeTask());
      const result = storage.deleteTask("task-1");
      expect(result.changes).toBe(1);
      expect(storage.listTasks()).toHaveLength(0);
    });

    it("deleteManyTasks", () => {
      storage.insertTask(makeTask({ id: "t1" }));
      storage.insertTask(makeTask({ id: "t2" }));
      storage.insertTask(makeTask({ id: "t3" }));
      storage.deleteManyTasks(["t1", "t3"]);
      expect(storage.listTasks()).toHaveLength(1);
      expect(storage.listTasks()[0].id).toBe("t2");
    });

    it("updateManyTasks", () => {
      storage.insertTask(makeTask({ id: "t1" }));
      storage.insertTask(makeTask({ id: "t2" }));
      storage.updateManyTasks(["t1", "t2"], { priority: 1 });
      expect(storage.getTask("t1")[0].priority).toBe(1);
      expect(storage.getTask("t2")[0].priority).toBe(1);
    });

    it("insertTaskWithId works", () => {
      storage.insertTaskWithId(makeTask({ id: "custom-id" }));
      expect(storage.getTask("custom-id")).toHaveLength(1);
    });
  });

  describe("Task-Tag Relations", () => {
    it("inserts and retrieves task tags", () => {
      storage.insertTask(makeTask());
      storage.insertTag(makeTag());
      storage.insertTaskTag("task-1", "tag-1");

      const tags = storage.getTaskTags("task-1");
      expect(tags).toHaveLength(1);
      expect(tags[0].tags.name).toBe("urgent");
      expect(tags[0].task_tags.taskId).toBe("task-1");
    });

    it("deleteTaskTags removes all tags for a task", () => {
      storage.insertTask(makeTask());
      storage.insertTag(makeTag({ id: "tag-1" }));
      storage.insertTag(makeTag({ id: "tag-2", name: "home" }));
      storage.insertTaskTag("task-1", "tag-1");
      storage.insertTaskTag("task-1", "tag-2");

      storage.deleteTaskTags("task-1");
      expect(storage.getTaskTags("task-1")).toHaveLength(0);
    });

    it("deleteManyTaskTags removes tags for multiple tasks", () => {
      storage.insertTask(makeTask({ id: "t1" }));
      storage.insertTask(makeTask({ id: "t2" }));
      storage.insertTag(makeTag());
      storage.insertTaskTag("t1", "tag-1");
      storage.insertTaskTag("t2", "tag-1");

      storage.deleteManyTaskTags(["t1", "t2"]);
      expect(storage.getTaskTags("t1")).toHaveLength(0);
      expect(storage.getTaskTags("t2")).toHaveLength(0);
    });
  });

  describe("Projects", () => {
    it("inserts and lists projects", () => {
      storage.insertProject(makeProject());
      expect(storage.listProjects()).toHaveLength(1);
    });

    it("gets project by ID", () => {
      storage.insertProject(makeProject());
      expect(storage.getProject("proj-1")).toHaveLength(1);
    });

    it("gets project by name", () => {
      storage.insertProject(makeProject());
      expect(storage.getProjectByName("Work")).toHaveLength(1);
      expect(storage.getProjectByName("Nonexistent")).toHaveLength(0);
    });

    it("updates a project", () => {
      storage.insertProject(makeProject());
      storage.updateProject("proj-1", { archived: true });
      expect(storage.getProject("proj-1")[0].archived).toBe(true);
    });

    it("deletes a project", () => {
      storage.insertProject(makeProject());
      const result = storage.deleteProject("proj-1");
      expect(result.changes).toBe(1);
      expect(storage.listProjects()).toHaveLength(0);
    });
  });

  describe("Tags", () => {
    it("inserts and lists tags", () => {
      storage.insertTag(makeTag());
      expect(storage.listTags()).toHaveLength(1);
    });

    it("gets tag by name", () => {
      storage.insertTag(makeTag());
      expect(storage.getTagByName("urgent")).toHaveLength(1);
      expect(storage.getTagByName("nonexistent")).toHaveLength(0);
    });

    it("deletes a tag", () => {
      storage.insertTag(makeTag());
      const result = storage.deleteTag("tag-1");
      expect(result.changes).toBe(1);
      expect(storage.listTags()).toHaveLength(0);
    });
  });

  describe("App Settings", () => {
    it("set, get, delete", () => {
      storage.setAppSetting("theme", "dark");
      const row = storage.getAppSetting("theme");
      expect(row?.value).toBe("dark");

      storage.deleteAppSetting("theme");
      expect(storage.getAppSetting("theme")).toBeUndefined();
    });

    it("updates on re-set", () => {
      storage.setAppSetting("theme", "light");
      storage.setAppSetting("theme", "dark");
      expect(storage.getAppSetting("theme")?.value).toBe("dark");
    });
  });

  describe("Plugin Settings", () => {
    it("save and load", () => {
      storage.savePluginSettings("pomodoro", '{"work":25}');
      const row = storage.loadPluginSettings("pomodoro");
      expect(row?.settings).toBe('{"work":25}');
    });

    it("returns undefined for unknown plugin", () => {
      expect(storage.loadPluginSettings("nonexistent")).toBeUndefined();
    });
  });

  describe("Chat Messages", () => {
    it("inserts and lists messages", () => {
      storage.insertChatMessage({
        sessionId: "s1",
        role: "user",
        content: "Hello",
        toolCallId: null,
        toolCalls: null,
        createdAt: now,
      });
      const messages = storage.listChatMessages("s1");
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Hello");
    });

    it("deletes a session", () => {
      storage.insertChatMessage({
        sessionId: "s1",
        role: "user",
        content: "Hello",
        toolCallId: null,
        toolCalls: null,
        createdAt: now,
      });
      storage.deleteChatSession("s1");
      expect(storage.listChatMessages("s1")).toHaveLength(0);
    });

    it("getLatestSessionId returns most recent", () => {
      storage.insertChatMessage({
        sessionId: "s1",
        role: "user",
        content: "Old",
        toolCallId: null,
        toolCalls: null,
        createdAt: "2025-01-01T00:00:00.000Z",
      });
      storage.insertChatMessage({
        sessionId: "s2",
        role: "user",
        content: "New",
        toolCallId: null,
        toolCalls: null,
        createdAt: "2025-06-01T00:00:00.000Z",
      });
      expect(storage.getLatestSessionId()?.sessionId).toBe("s2");
    });
  });

  describe("Plugin Permissions", () => {
    it("set and get", () => {
      storage.setPluginPermissions("p1", ["task:read", "storage"]);
      expect(storage.getPluginPermissions("p1")).toEqual(["task:read", "storage"]);
    });

    it("returns null for unknown plugin", () => {
      expect(storage.getPluginPermissions("unknown")).toBeNull();
    });

    it("delete permissions", () => {
      storage.setPluginPermissions("p1", ["task:read"]);
      storage.deletePluginPermissions("p1");
      expect(storage.getPluginPermissions("p1")).toBeNull();
    });
  });
});
