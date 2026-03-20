import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestServices } from "../integration/helpers.js";
import type { TaskService } from "../../src/core/tasks.js";
import type { TagService } from "../../src/core/tags.js";
import type { ProjectService } from "../../src/core/projects.js";
import type { EventBus } from "../../src/core/event-bus.js";
import { NotFoundError, ValidationError } from "../../src/core/errors.js";

describe("TaskService", () => {
  let taskService: TaskService;
  let _tagService: TagService;
  let _projectService: ProjectService;
  let eventBus: EventBus;

  beforeEach(() => {
    const services = createTestServices();
    taskService = services.taskService;
    _tagService = services.tagService;
    _projectService = services.projectService;
    eventBus = services.eventBus;
  });

  // ── create ──

  describe("create()", () => {
    it("creates a task and returns it with an ID", async () => {
      const task = await taskService.create({ title: "Write tests" });

      expect(task.id).toBeDefined();
      expect(typeof task.id).toBe("string");
      expect(task.title).toBe("Write tests");
      expect(task.status).toBe("pending");
      expect(task.completedAt).toBeNull();
      expect(task.createdAt).toBeDefined();
      expect(task.updatedAt).toBeDefined();
    });

    it("defaults optional fields to null/false/empty", async () => {
      const task = await taskService.create({ title: "Minimal" });

      expect(task.description).toBeNull();
      expect(task.priority).toBeNull();
      expect(task.dueDate).toBeNull();
      expect(task.dueTime).toBe(false);
      expect(task.projectId).toBeNull();
      expect(task.recurrence).toBeNull();
      expect(task.parentId).toBeNull();
      expect(task.remindAt).toBeNull();
      expect(task.estimatedMinutes).toBeNull();
      expect(task.actualMinutes).toBeNull();
      expect(task.deadline).toBeNull();
      expect(task.isSomeday).toBe(false);
      expect(task.sectionId).toBeNull();
      expect(task.dreadLevel).toBeNull();
      expect(task.tags).toEqual([]);
    });

    it("creates a task with priority and description", async () => {
      const task = await taskService.create({
        title: "Urgent task",
        description: "Do this ASAP",
        priority: 1,
      });

      expect(task.priority).toBe(1);
      expect(task.description).toBe("Do this ASAP");
    });

    it("creates a task with tags", async () => {
      const task = await taskService.create({
        title: "Tagged task",
        tags: ["work", "important"],
      });

      expect(task.tags).toHaveLength(2);
      expect(task.tags.map((t) => t.name).sort()).toEqual(["important", "work"]);
    });

    it("creates a task with dueDate and dueTime", async () => {
      const task = await taskService.create({
        title: "Meeting",
        dueDate: "2026-04-01T14:00:00.000Z",
        dueTime: true,
      });

      expect(task.dueDate).toBe("2026-04-01T14:00:00.000Z");
      expect(task.dueTime).toBe(true);
    });

    it("creates a task with estimatedMinutes and dreadLevel", async () => {
      const task = await taskService.create({
        title: "Dreaded task",
        estimatedMinutes: 45,
        dreadLevel: 4,
      });

      expect(task.estimatedMinutes).toBe(45);
      expect(task.dreadLevel).toBe(4);
    });

    it("emits task:create event", async () => {
      const listener = vi.fn();
      eventBus.on("task:create", listener);

      const task = await taskService.create({ title: "Evented" });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
    });
  });

  // ── get ──

  describe("get()", () => {
    it("retrieves an existing task by ID", async () => {
      const created = await taskService.create({ title: "Find me" });
      const found = await taskService.get(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.title).toBe("Find me");
    });

    it("returns null for a non-existent ID", async () => {
      const found = await taskService.get("nonexistent-id");
      expect(found).toBeNull();
    });

    it("includes tags on the returned task", async () => {
      const created = await taskService.create({
        title: "Tagged",
        tags: ["alpha"],
      });
      const found = await taskService.get(created.id);

      expect(found!.tags).toHaveLength(1);
      expect(found!.tags[0].name).toBe("alpha");
    });
  });

  // ── update ──

  describe("update()", () => {
    it("updates the title of a task", async () => {
      const task = await taskService.create({ title: "Old title" });
      const updated = await taskService.update(task.id, { title: "New title" });

      expect(updated.title).toBe("New title");
      expect(updated.id).toBe(task.id);
    });

    it("updates priority", async () => {
      const task = await taskService.create({ title: "Reprioritize" });
      const updated = await taskService.update(task.id, { priority: 2 });

      expect(updated.priority).toBe(2);
    });

    it("updates tags by replacing them", async () => {
      const task = await taskService.create({
        title: "Retag",
        tags: ["old-tag"],
      });
      const updated = await taskService.update(task.id, { tags: ["new-tag", "another"] });

      expect(updated.tags.map((t) => t.name).sort()).toEqual(["another", "new-tag"]);
    });

    it("throws NotFoundError for non-existent task", async () => {
      await expect(
        taskService.update("missing-id", { title: "Nope" }),
      ).rejects.toThrow(NotFoundError);
    });

    it("emits task:update event", async () => {
      const listener = vi.fn();
      eventBus.on("task:update", listener);

      const task = await taskService.create({ title: "Will update" });
      await taskService.update(task.id, { title: "Updated" });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          task: expect.objectContaining({ title: "Updated" }),
        }),
      );
    });

    it("sets updatedAt to a newer timestamp", async () => {
      const task = await taskService.create({ title: "Timestamp check" });
      const updated = await taskService.update(task.id, { description: "Added desc" });

      expect(updated.updatedAt >= task.updatedAt).toBe(true);
    });
  });

  // ── delete ──

  describe("delete()", () => {
    it("deletes an existing task and returns true", async () => {
      const task = await taskService.create({ title: "To delete" });
      const result = await taskService.delete(task.id);

      expect(result).toBe(true);

      const found = await taskService.get(task.id);
      expect(found).toBeNull();
    });

    it("returns false for a non-existent task", async () => {
      const result = await taskService.delete("no-such-id");
      expect(result).toBe(false);
    });

    it("emits task:delete event", async () => {
      const listener = vi.fn();
      eventBus.on("task:delete", listener);

      const task = await taskService.create({ title: "Delete me" });
      await taskService.delete(task.id);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
    });
  });

  // ── complete / uncomplete ──

  describe("complete()", () => {
    it("marks a task as completed", async () => {
      const task = await taskService.create({ title: "Finish this" });
      const completed = await taskService.complete(task.id);

      expect(completed.status).toBe("completed");
      expect(completed.completedAt).toBeDefined();
      expect(completed.completedAt).not.toBeNull();
    });

    it("throws NotFoundError for non-existent task", async () => {
      await expect(taskService.complete("missing")).rejects.toThrow(NotFoundError);
    });

    it("emits task:complete event", async () => {
      const listener = vi.fn();
      eventBus.on("task:complete", listener);

      const task = await taskService.create({ title: "Complete me" });
      await taskService.complete(task.id);

      expect(listener).toHaveBeenCalledOnce();
    });

    it("cascade-completes child tasks", async () => {
      const parent = await taskService.create({ title: "Parent" });
      const child = await taskService.create({
        title: "Child",
        parentId: parent.id,
      });

      await taskService.complete(parent.id);

      const childAfter = await taskService.get(child.id);
      expect(childAfter!.status).toBe("completed");
    });

    it("creates next occurrence for recurring tasks", async () => {
      const task = await taskService.create({
        title: "Daily standup",
        dueDate: "2026-03-20T09:00:00.000Z",
        dueTime: true,
        recurrence: "daily",
      });

      await taskService.complete(task.id);

      const allTasks = await taskService.list();
      const pending = allTasks.filter((t) => t.status === "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0].title).toBe("Daily standup");
      expect(pending[0].recurrence).toBe("daily");
      // Next occurrence should be after the original due date
      expect(new Date(pending[0].dueDate!).getTime()).toBeGreaterThan(
        new Date("2026-03-20T09:00:00.000Z").getTime(),
      );
    });
  });

  describe("uncomplete()", () => {
    it("reverts a completed task to pending", async () => {
      const task = await taskService.create({ title: "Reopen" });
      await taskService.complete(task.id);
      const uncompleted = await taskService.uncomplete(task.id);

      expect(uncompleted.status).toBe("pending");
      expect(uncompleted.completedAt).toBeNull();
    });

    it("throws NotFoundError for non-existent task", async () => {
      await expect(taskService.uncomplete("missing")).rejects.toThrow(NotFoundError);
    });

    it("emits task:uncomplete event", async () => {
      const listener = vi.fn();
      eventBus.on("task:uncomplete", listener);

      const task = await taskService.create({ title: "Toggle" });
      await taskService.complete(task.id);
      await taskService.uncomplete(task.id);

      expect(listener).toHaveBeenCalledOnce();
    });
  });

  // ── list ──

  describe("list()", () => {
    it("returns an empty array when no tasks exist", async () => {
      const tasks = await taskService.list();
      expect(tasks).toEqual([]);
    });

    it("returns all created tasks", async () => {
      await taskService.create({ title: "Task A" });
      await taskService.create({ title: "Task B" });
      await taskService.create({ title: "Task C" });

      const tasks = await taskService.list();
      expect(tasks).toHaveLength(3);
    });

    it("applies status filter", async () => {
      await taskService.create({ title: "Pending one" });
      const toComplete = await taskService.create({ title: "Will complete" });
      await taskService.complete(toComplete.id);

      const pending = await taskService.list({ status: "pending" });
      expect(pending).toHaveLength(1);
      expect(pending[0].title).toBe("Pending one");
    });

    it("sorts tasks by priority (p1 first)", async () => {
      await taskService.create({ title: "Low", priority: 4 });
      await taskService.create({ title: "High", priority: 1 });
      await taskService.create({ title: "Medium", priority: 2 });

      const tasks = await taskService.list();
      expect(tasks[0].title).toBe("High");
      expect(tasks[1].title).toBe("Medium");
      expect(tasks[2].title).toBe("Low");
    });
  });

  // ── subtasks ──

  describe("subtask handling", () => {
    it("creates a task with parentId", async () => {
      const parent = await taskService.create({ title: "Parent task" });
      const child = await taskService.create({
        title: "Child task",
        parentId: parent.id,
      });

      expect(child.parentId).toBe(parent.id);
    });

    it("getChildren returns direct children", async () => {
      const parent = await taskService.create({ title: "Parent" });
      await taskService.create({ title: "Child 1", parentId: parent.id });
      await taskService.create({ title: "Child 2", parentId: parent.id });
      await taskService.create({ title: "Unrelated" });

      const children = await taskService.getChildren(parent.id);
      expect(children).toHaveLength(2);
    });

    it("listTree nests children under parents", async () => {
      const parent = await taskService.create({ title: "Parent" });
      await taskService.create({ title: "Child", parentId: parent.id });

      const tree = await taskService.listTree();
      expect(tree).toHaveLength(1);
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children![0].title).toBe("Child");
    });
  });

  // ── relations and cycle detection ──

  describe("relations", () => {
    it("adds a blocking relation between tasks", async () => {
      const taskA = await taskService.create({ title: "Blocker" });
      const taskB = await taskService.create({ title: "Blocked" });

      await taskService.addRelation(taskA.id, taskB.id);

      const rels = await taskService.getRelations(taskA.id);
      expect(rels.blocks).toContain(taskB.id);
    });

    it("throws NotFoundError when adding relation to non-existent task", async () => {
      const taskA = await taskService.create({ title: "Exists" });

      await expect(
        taskService.addRelation(taskA.id, "nonexistent"),
      ).rejects.toThrow(NotFoundError);
    });

    it("throws ValidationError on cycle detection", async () => {
      const taskA = await taskService.create({ title: "A" });
      const taskB = await taskService.create({ title: "B" });
      const taskC = await taskService.create({ title: "C" });

      await taskService.addRelation(taskA.id, taskB.id); // A blocks B
      await taskService.addRelation(taskB.id, taskC.id); // B blocks C

      // C blocks A would create a cycle: A -> B -> C -> A
      await expect(
        taskService.addRelation(taskC.id, taskA.id),
      ).rejects.toThrow(ValidationError);
    });

    it("removes a relation", async () => {
      const taskA = await taskService.create({ title: "A" });
      const taskB = await taskService.create({ title: "B" });

      await taskService.addRelation(taskA.id, taskB.id);
      await taskService.removeRelation(taskA.id, taskB.id);

      const rels = await taskService.getRelations(taskA.id);
      expect(rels.blocks).not.toContain(taskB.id);
    });
  });

  // ── batch operations ──

  describe("batch operations", () => {
    it("completeMany completes multiple tasks", async () => {
      const t1 = await taskService.create({ title: "Batch 1" });
      const t2 = await taskService.create({ title: "Batch 2" });

      const results = await taskService.completeMany([t1.id, t2.id]);
      expect(results).toHaveLength(2);
      expect(results.every((t) => t.status === "completed")).toBe(true);
    });

    it("deleteMany deletes multiple tasks", async () => {
      const t1 = await taskService.create({ title: "Del 1" });
      const t2 = await taskService.create({ title: "Del 2" });

      const deleted = await taskService.deleteMany([t1.id, t2.id]);
      expect(deleted).toHaveLength(2);

      const remaining = await taskService.list();
      expect(remaining).toHaveLength(0);
    });

    it("updateMany updates multiple tasks with same changes", async () => {
      const t1 = await taskService.create({ title: "Bulk 1" });
      const t2 = await taskService.create({ title: "Bulk 2" });

      const results = await taskService.updateMany([t1.id, t2.id], { priority: 1 });
      expect(results).toHaveLength(2);
      expect(results.every((t) => t.priority === 1)).toBe(true);
    });
  });

  // ── reorder ──

  describe("reorder()", () => {
    it("assigns sequential sort orders", async () => {
      const t1 = await taskService.create({ title: "First" });
      const t2 = await taskService.create({ title: "Second" });
      const t3 = await taskService.create({ title: "Third" });

      await taskService.reorder([t3.id, t1.id, t2.id]);

      const after1 = await taskService.get(t3.id);
      const after2 = await taskService.get(t1.id);
      const after3 = await taskService.get(t2.id);

      expect(after1!.sortOrder).toBe(0);
      expect(after2!.sortOrder).toBe(1);
      expect(after3!.sortOrder).toBe(2);
    });
  });

  // ── restoreTask ──

  describe("restoreTask()", () => {
    it("restores a previously deleted task", async () => {
      const task = await taskService.create({ title: "Restore me" });
      const snapshot = (await taskService.get(task.id))!;
      await taskService.delete(task.id);

      expect(await taskService.get(task.id)).toBeNull();

      await taskService.restoreTask(snapshot);
      const restored = await taskService.get(task.id);

      expect(restored).not.toBeNull();
      expect(restored!.title).toBe("Restore me");
    });
  });
});
