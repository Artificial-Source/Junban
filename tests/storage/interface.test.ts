import { describe, it, expect } from "vitest";
import type {
  TaskRow,
  ProjectRow,
  TagRow,
  TaskTagJoin,
  PluginSettingsRow,
  AppSettingRow,
  ChatMessageRow,
  IStorage,
} from "../../src/storage/interface.js";

describe("IStorage row types", () => {
  it("TaskRow has all expected fields", () => {
    const row: TaskRow = {
      id: "abc123",
      title: "Buy milk",
      description: "From the store",
      status: "pending",
      priority: 1,
      dueDate: "2025-12-25T00:00:00.000Z",
      dueTime: false,
      completedAt: null,
      projectId: null,
      recurrence: null,
      sortOrder: 0,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    expect(row.id).toBe("abc123");
    expect(row.title).toBe("Buy milk");
    expect(row.status).toBe("pending");
    expect(row.dueTime).toBe(false);
  });

  it("ProjectRow has all expected fields", () => {
    const row: ProjectRow = {
      id: "proj1",
      name: "Work",
      color: "#3b82f6",
      icon: null,
      sortOrder: 0,
      archived: false,
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    expect(row.name).toBe("Work");
    expect(row.archived).toBe(false);
  });

  it("TagRow has all expected fields", () => {
    const row: TagRow = {
      id: "tag1",
      name: "urgent",
      color: "#ef4444",
    };
    expect(row.name).toBe("urgent");
  });

  it("TaskTagJoin has expected shape", () => {
    const join: TaskTagJoin = {
      task_tags: { taskId: "task1", tagId: "tag1" },
      tags: { id: "tag1", name: "urgent", color: "#ef4444" },
    };
    expect(join.task_tags.taskId).toBe("task1");
    expect(join.tags.name).toBe("urgent");
  });

  it("PluginSettingsRow has all expected fields", () => {
    const row: PluginSettingsRow = {
      pluginId: "pomodoro",
      settings: '{"workMinutes":25}',
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    expect(row.pluginId).toBe("pomodoro");
  });

  it("AppSettingRow has all expected fields", () => {
    const row: AppSettingRow = {
      key: "theme",
      value: "dark",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    expect(row.key).toBe("theme");
  });

  it("ChatMessageRow has all expected fields", () => {
    const row: ChatMessageRow = {
      sessionId: "session1",
      role: "user",
      content: "Hello",
      toolCallId: null,
      toolCalls: null,
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    expect(row.role).toBe("user");
    expect(row.id).toBeUndefined();
  });

  it("IStorage interface has all required method groups", () => {
    // Compile-time check: a function that accepts IStorage
    // and references all method groups
    function checkInterface(s: IStorage) {
      // Tasks
      s.listTasks();
      s.getTask("id");
      // Projects
      s.listProjects();
      // Tags
      s.listTags();
      // Settings
      s.getAppSetting("key");
      // Plugin settings
      s.loadPluginSettings("id");
      // Chat
      s.getLatestSessionId();
      // Permissions
      s.getPluginPermissions("id");
    }
    // Just verify it compiles
    expect(typeof checkInterface).toBe("function");
  });
});
