import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MarkdownBackend } from "../../src/storage/markdown-backend.js";
import { StorageError } from "../../src/core/errors.js";
import type { TaskRow, ProjectRow, TagRow } from "../../src/storage/interface.js";

const now = "2025-01-01T00:00:00.000Z";

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-abc123",
    title: "Buy groceries",
    description: "Milk and eggs",
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

describe("MarkdownBackend", () => {
  let tmpDir: string;
  let backend: MarkdownBackend;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "junban-md-test-"));
    backend = new MarkdownBackend(tmpDir);
    backend.initialize();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("initialize", () => {
    it("creates directory structure on empty dir", () => {
      expect(fs.existsSync(path.join(tmpDir, "inbox"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "projects"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "_plugins"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "_chat"))).toBe(true);
    });

    it("does not error on re-initialization", () => {
      expect(() => backend.initialize()).not.toThrow();
    });
  });

  describe("Tasks", () => {
    it("inserts a task (no project) → file in inbox/", () => {
      backend.insertTask(makeTask());
      const tasks = backend.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Buy groceries");

      // Verify file on disk
      const inboxFiles = fs.readdirSync(path.join(tmpDir, "inbox"));
      expect(inboxFiles.some((f) => f.endsWith(".md"))).toBe(true);
    });

    it("inserts a task with project → file in projects/<name>/", () => {
      backend.insertProject(makeProject());
      backend.insertTask(makeTask({ projectId: "proj-1" }));

      const tasks = backend.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].projectId).toBe("proj-1");

      // Verify file in project dir
      const projectDir = path.join(tmpDir, "projects", "work");
      const files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".md"));
      expect(files).toHaveLength(1);
    });

    it("gets a task by ID", () => {
      backend.insertTask(makeTask());
      const rows = backend.getTask("task-abc123");
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("task-abc123");
    });

    it("returns empty array for unknown task", () => {
      expect(backend.getTask("nonexistent")).toHaveLength(0);
    });

    it("updates a task title → file renamed", () => {
      backend.insertTask(makeTask());

      // Get original file path
      const inboxBefore = fs.readdirSync(path.join(tmpDir, "inbox"));
      expect(inboxBefore.some((f) => f.includes("buy-groceries"))).toBe(true);

      backend.updateTask("task-abc123", { title: "Buy vegetables" });

      const [task] = backend.getTask("task-abc123");
      expect(task.title).toBe("Buy vegetables");

      // Old file gone, new file created
      const inboxAfter = fs.readdirSync(path.join(tmpDir, "inbox"));
      expect(inboxAfter.some((f) => f.includes("buy-vegetables"))).toBe(true);
      expect(inboxAfter.some((f) => f.includes("buy-groceries"))).toBe(false);
    });

    it("does not delete old file when rename write fails", () => {
      backend.insertTask(makeTask());

      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      expect(() => backend.updateTask("task-abc123", { title: "Buy vegetables" })).toThrow(
        StorageError,
      );
      writeSpy.mockRestore();

      const [task] = backend.getTask("task-abc123");
      expect(task.title).toBe("Buy groceries");

      const inboxFiles = fs.readdirSync(path.join(tmpDir, "inbox"));
      expect(inboxFiles.some((f) => f.includes("buy-groceries"))).toBe(true);
      expect(inboxFiles.some((f) => f.includes("buy-vegetables"))).toBe(false);
    });

    it("updates task project → file moves to new directory", () => {
      backend.insertProject(makeProject());
      backend.insertTask(makeTask());

      // Initially in inbox
      expect(fs.readdirSync(path.join(tmpDir, "inbox")).some((f) => f.endsWith(".md"))).toBe(true);

      backend.updateTask("task-abc123", { projectId: "proj-1" });

      // Now in project dir
      const projectFiles = fs
        .readdirSync(path.join(tmpDir, "projects", "work"))
        .filter((f) => f.endsWith(".md"));
      expect(projectFiles).toHaveLength(1);

      // Gone from inbox
      const inboxMdFiles = fs
        .readdirSync(path.join(tmpDir, "inbox"))
        .filter((f) => f.endsWith(".md"));
      expect(inboxMdFiles).toHaveLength(0);
    });

    it("deletes a task → file removed", () => {
      backend.insertTask(makeTask());
      backend.deleteTask("task-abc123");

      expect(backend.listTasks()).toHaveLength(0);
      const inboxFiles = fs
        .readdirSync(path.join(tmpDir, "inbox"))
        .filter((f) => f.endsWith(".md"));
      expect(inboxFiles).toHaveLength(0);
    });

    it("deleteManyTasks", () => {
      backend.insertTask(makeTask({ id: "t1", title: "Task 1" }));
      backend.insertTask(makeTask({ id: "t2", title: "Task 2" }));
      backend.insertTask(makeTask({ id: "t3", title: "Task 3" }));
      backend.deleteManyTasks(["t1", "t3"]);
      expect(backend.listTasks()).toHaveLength(1);
      expect(backend.listTasks()[0].id).toBe("t2");
    });

    it("updateManyTasks", () => {
      backend.insertTask(makeTask({ id: "t1", title: "Task 1" }));
      backend.insertTask(makeTask({ id: "t2", title: "Task 2" }));
      backend.updateManyTasks(["t1", "t2"], { priority: 1 });
      expect(backend.getTask("t1")[0].priority).toBe(1);
      expect(backend.getTask("t2")[0].priority).toBe(1);
    });

    it("stores description in file body", () => {
      backend.insertTask(makeTask({ description: "Detailed notes here" }));

      const inboxFiles = fs.readdirSync(path.join(tmpDir, "inbox"));
      const mdFile = inboxFiles.find((f) => f.endsWith(".md"))!;
      const content = fs.readFileSync(path.join(tmpDir, "inbox", mdFile), "utf-8");

      expect(content).toContain("# Buy groceries");
      expect(content).toContain("Detailed notes here");
    });
  });

  describe("Task-Tag Relations", () => {
    it("inserts and retrieves task tags", () => {
      backend.insertTag(makeTag());
      backend.insertTask(makeTask());
      backend.insertTaskTag("task-abc123", "tag-1");

      const tags = backend.getTaskTags("task-abc123");
      expect(tags).toHaveLength(1);
      expect(tags[0].tags.name).toBe("urgent");
    });

    it("tags appear in frontmatter of task file", () => {
      backend.insertTag(makeTag());
      backend.insertTask(makeTask());
      backend.insertTaskTag("task-abc123", "tag-1");

      const inboxFiles = fs.readdirSync(path.join(tmpDir, "inbox"));
      const mdFile = inboxFiles.find((f) => f.endsWith(".md"))!;
      const content = fs.readFileSync(path.join(tmpDir, "inbox", mdFile), "utf-8");

      expect(content).toContain("tags:");
      expect(content).toContain("- urgent");
    });

    it("listAllTaskTags returns all task-tag joins", () => {
      backend.insertTag(makeTag({ id: "tag-1", name: "urgent" }));
      backend.insertTag(makeTag({ id: "tag-2", name: "home" }));
      backend.insertTask(makeTask({ id: "t1", title: "Task 1" }));
      backend.insertTask(makeTask({ id: "t2", title: "Task 2" }));
      backend.insertTaskTag("t1", "tag-1");
      backend.insertTaskTag("t1", "tag-2");
      backend.insertTaskTag("t2", "tag-1");

      const all = backend.listAllTaskTags();
      expect(all).toHaveLength(3);

      const t1Tags = all.filter((j) => j.task_tags.taskId === "t1");
      expect(t1Tags).toHaveLength(2);
      expect(t1Tags.map((j) => j.tags.name).sort()).toEqual(["home", "urgent"]);
    });

    it("listAllTaskTags returns empty array when no tags assigned", () => {
      backend.insertTask(makeTask());
      expect(backend.listAllTaskTags()).toHaveLength(0);
    });

    it("deleteTaskTags removes all tags and updates file", () => {
      backend.insertTag(makeTag());
      backend.insertTag(makeTag({ id: "tag-2", name: "home" }));
      backend.insertTask(makeTask());
      backend.insertTaskTag("task-abc123", "tag-1");
      backend.insertTaskTag("task-abc123", "tag-2");

      backend.deleteTaskTags("task-abc123");
      expect(backend.getTaskTags("task-abc123")).toHaveLength(0);

      // File should no longer have tags in frontmatter
      const inboxFiles = fs.readdirSync(path.join(tmpDir, "inbox"));
      const mdFile = inboxFiles.find((f) => f.endsWith(".md"))!;
      const content = fs.readFileSync(path.join(tmpDir, "inbox", mdFile), "utf-8");
      expect(content).not.toContain("tags:");
    });
  });

  describe("Projects", () => {
    it("creates project directory + _project.yaml", () => {
      backend.insertProject(makeProject());
      expect(backend.listProjects()).toHaveLength(1);

      const projectDir = path.join(tmpDir, "projects", "work");
      expect(fs.existsSync(projectDir)).toBe(true);
      expect(fs.existsSync(path.join(projectDir, "_project.yaml"))).toBe(true);
    });

    it("gets project by ID", () => {
      backend.insertProject(makeProject());
      expect(backend.getProject("proj-1")).toHaveLength(1);
    });

    it("gets project by name", () => {
      backend.insertProject(makeProject());
      expect(backend.getProjectByName("Work")).toHaveLength(1);
      expect(backend.getProjectByName("Nonexistent")).toHaveLength(0);
    });

    it("updates a project", () => {
      backend.insertProject(makeProject());
      backend.updateProject("proj-1", { archived: true });
      expect(backend.getProject("proj-1")[0].archived).toBe(true);
    });

    it("persists renamed project name after reload", () => {
      backend.insertProject(makeProject());
      backend.updateProject("proj-1", { name: "Personal" });

      // Verify in-memory
      const updated = backend.getProject("proj-1")[0];
      expect(updated.name).toBe("Personal");

      // Verify on disk: reload from the same directory
      const reloaded = new MarkdownBackend(tmpDir);
      reloaded.initialize();
      const project = reloaded.getProject("proj-1")[0];
      expect(project.name).toBe("Personal");
    });

    it("deletes a project → moves tasks to inbox", () => {
      backend.insertProject(makeProject());
      backend.insertTask(makeTask({ projectId: "proj-1" }));

      backend.deleteProject("proj-1");

      expect(backend.listProjects()).toHaveLength(0);
      // Task should now be in inbox
      const task = backend.getTask("task-abc123")[0];
      expect(task.projectId).toBeNull();
    });
  });

  describe("Tags", () => {
    it("inserts and lists tags", () => {
      backend.insertTag(makeTag());
      expect(backend.listTags()).toHaveLength(1);
    });

    it("persists to _tags.yaml", () => {
      backend.insertTag(makeTag());
      const content = fs.readFileSync(path.join(tmpDir, "_tags.yaml"), "utf-8");
      expect(content).toContain("urgent");
    });

    it("gets tag by name", () => {
      backend.insertTag(makeTag());
      expect(backend.getTagByName("urgent")).toHaveLength(1);
      expect(backend.getTagByName("nonexistent")).toHaveLength(0);
    });

    it("deletes a tag", () => {
      backend.insertTag(makeTag());
      backend.deleteTag("tag-1");
      expect(backend.listTags()).toHaveLength(0);
    });
  });

  describe("App Settings", () => {
    it("set, get, delete → _settings.yaml roundtrip", () => {
      backend.setAppSetting("theme", "dark");
      expect(backend.getAppSetting("theme")?.value).toBe("dark");

      // Verify on disk
      const content = fs.readFileSync(path.join(tmpDir, "_settings.yaml"), "utf-8");
      expect(content).toContain("theme");

      backend.deleteAppSetting("theme");
      expect(backend.getAppSetting("theme")).toBeUndefined();
    });

    it("updates on re-set", () => {
      backend.setAppSetting("theme", "light");
      backend.setAppSetting("theme", "dark");
      expect(backend.getAppSetting("theme")?.value).toBe("dark");
    });
  });

  describe("Plugin Settings", () => {
    it("save and load → _plugins/<id>.yaml roundtrip", () => {
      backend.savePluginSettings("pomodoro", '{"work":25}');
      const row = backend.loadPluginSettings("pomodoro");
      expect(row?.settings).toBe('{"work":25}');

      // Verify on disk
      expect(fs.existsSync(path.join(tmpDir, "_plugins", "pomodoro.yaml"))).toBe(true);
    });

    it("returns undefined for unknown plugin", () => {
      expect(backend.loadPluginSettings("nonexistent")).toBeUndefined();
    });
  });

  describe("Plugin Permissions", () => {
    it("set, get, delete → _plugins/permissions.yaml roundtrip", () => {
      backend.setPluginPermissions("p1", ["task:read", "storage"]);
      expect(backend.getPluginPermissions("p1")).toEqual(["task:read", "storage"]);

      // Verify on disk
      expect(fs.existsSync(path.join(tmpDir, "_plugins", "permissions.yaml"))).toBe(true);

      backend.deletePluginPermissions("p1");
      expect(backend.getPluginPermissions("p1")).toBeNull();
    });

    it("returns null for unknown plugin", () => {
      expect(backend.getPluginPermissions("unknown")).toBeNull();
    });
  });

  describe("Chat Messages", () => {
    it("inserts and lists → _chat/<sessionId>.yaml roundtrip", () => {
      backend.insertChatMessage({
        sessionId: "s1",
        role: "user",
        content: "Hello",
        toolCallId: null,
        toolCalls: null,
        createdAt: now,
      });

      const messages = backend.listChatMessages("s1");
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Hello");

      // Verify on disk
      expect(fs.existsSync(path.join(tmpDir, "_chat", "s1.yaml"))).toBe(true);
    });

    it("deletes a chat session", () => {
      backend.insertChatMessage({
        sessionId: "s1",
        role: "user",
        content: "Hello",
        toolCallId: null,
        toolCalls: null,
        createdAt: now,
      });

      backend.deleteChatSession("s1");
      expect(backend.listChatMessages("s1")).toHaveLength(0);
      expect(fs.existsSync(path.join(tmpDir, "_chat", "s1.yaml"))).toBe(false);
    });

    it("getLatestSessionId returns most recent", () => {
      backend.insertChatMessage({
        sessionId: "s1",
        role: "user",
        content: "Old",
        toolCallId: null,
        toolCalls: null,
        createdAt: "2025-01-01T00:00:00.000Z",
      });
      backend.insertChatMessage({
        sessionId: "s2",
        role: "user",
        content: "New",
        toolCallId: null,
        toolCalls: null,
        createdAt: "2025-06-01T00:00:00.000Z",
      });
      expect(backend.getLatestSessionId()?.sessionId).toBe("s2");
    });

    it("returns undefined when no sessions", () => {
      expect(backend.getLatestSessionId()).toBeUndefined();
    });
  });

  describe("Persistence across initialize", () => {
    it("reloads tasks after re-initialization", () => {
      backend.insertTag(makeTag());
      backend.insertTask(makeTask());
      backend.insertTaskTag("task-abc123", "tag-1");

      // Create a new backend on the same directory
      const backend2 = new MarkdownBackend(tmpDir);
      backend2.initialize();

      expect(backend2.listTasks()).toHaveLength(1);
      expect(backend2.listTasks()[0].title).toBe("Buy groceries");
      expect(backend2.listTags()).toHaveLength(1);
      expect(backend2.getTaskTags("task-abc123")).toHaveLength(1);
    });

    it("reloads projects after re-initialization", () => {
      backend.insertProject(makeProject());

      const backend2 = new MarkdownBackend(tmpDir);
      backend2.initialize();

      expect(backend2.listProjects()).toHaveLength(1);
    });

    it("reloads settings after re-initialization", () => {
      backend.setAppSetting("theme", "dark");

      const backend2 = new MarkdownBackend(tmpDir);
      backend2.initialize();

      expect(backend2.getAppSetting("theme")?.value).toBe("dark");
    });

    it("reloads plugin settings after re-initialization", () => {
      backend.savePluginSettings("pomodoro", '{"work":25}');

      const backend2 = new MarkdownBackend(tmpDir);
      backend2.initialize();

      expect(backend2.loadPluginSettings("pomodoro")?.settings).toBe('{"work":25}');
    });

    it("reloads plugin permissions after re-initialization", () => {
      backend.setPluginPermissions("p1", ["task:read"]);

      const backend2 = new MarkdownBackend(tmpDir);
      backend2.initialize();

      expect(backend2.getPluginPermissions("p1")).toEqual(["task:read"]);
    });

    it("reloads chat messages after re-initialization", () => {
      backend.insertChatMessage({
        sessionId: "s1",
        role: "user",
        content: "Hello",
        toolCallId: null,
        toolCalls: null,
        createdAt: now,
      });

      const backend2 = new MarkdownBackend(tmpDir);
      backend2.initialize();

      expect(backend2.listChatMessages("s1")).toHaveLength(1);
      expect(backend2.listChatMessages("s1")[0].content).toBe("Hello");
    });
  });

  describe("StorageError on fs failures", () => {
    it("throws StorageError when writing to an inaccessible location", () => {
      const badBackend = new MarkdownBackend("/nonexistent/path/junban");
      expect(() => badBackend.initialize()).toThrow(StorageError);
    });

    it("StorageError contains operation description", () => {
      const badBackend = new MarkdownBackend("/nonexistent/path/junban");
      try {
        badBackend.initialize();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(StorageError);
        expect((err as StorageError).message).toContain("create directory");
      }
    });
  });

  describe("File format", () => {
    it("task files have YAML frontmatter + heading + body", () => {
      backend.insertTask(makeTask({ description: "Get milk and bread" }));

      const inboxFiles = fs.readdirSync(path.join(tmpDir, "inbox"));
      const mdFile = inboxFiles.find((f) => f.endsWith(".md"))!;
      const content = fs.readFileSync(path.join(tmpDir, "inbox", mdFile), "utf-8");

      expect(content).toMatch(/^---\n/);
      expect(content).toContain("id:");
      expect(content).toContain("status: pending");
      expect(content).toContain("# Buy groceries");
      expect(content).toContain("Get milk and bread");
      expect(content.endsWith("\n")).toBe(true);
    });

    it("task files have sorted frontmatter keys", () => {
      backend.insertTask(makeTask());

      const inboxFiles = fs.readdirSync(path.join(tmpDir, "inbox"));
      const mdFile = inboxFiles.find((f) => f.endsWith(".md"))!;
      const content = fs.readFileSync(path.join(tmpDir, "inbox", mdFile), "utf-8");

      // Extract frontmatter keys
      const lines = content.split("\n");
      const start = lines.indexOf("---") + 1;
      const end = lines.indexOf("---", start);
      const yamlKeys = lines
        .slice(start, end)
        .filter((l) => /^\w/.test(l))
        .map((l) => l.split(":")[0]);

      const sorted = [...yamlKeys].sort();
      expect(yamlKeys).toEqual(sorted);
    });
  });
});
