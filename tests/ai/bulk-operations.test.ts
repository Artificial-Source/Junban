import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../src/ai/tools/registry.js";
import { registerBulkOperationTools } from "../../src/ai/tools/builtin/bulk-operations.js";
import { createTestServices } from "../integration/helpers.js";
import type { ToolContext } from "../../src/ai/tools/types.js";
import type { TaskService } from "../../src/core/tasks.js";

function exec(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  return registry.execute(name, args, ctx).then((r) => JSON.parse(r));
}

describe("bulk_create_tasks", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    const svc = createTestServices();
    ctx = {
      taskService: svc.taskService,
      projectService: svc.projectService,
      tagService: svc.tagService,
      storage: svc.storage,
    };
    registry = new ToolRegistry();
    registerBulkOperationTools(registry);
  });

  it("creates multiple tasks at once", async () => {
    const result = await exec(
      registry,
      "bulk_create_tasks",
      {
        tasks: [
          { title: "Buy milk" },
          { title: "Buy eggs", priority: 2 },
          { title: "Buy bread", tags: ["groceries"] },
        ],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(3);
    expect(result.created).toHaveLength(3);
    expect(result.created[0].title).toBe("Buy milk");
    expect(result.created[1].priority).toBe(2);
    expect(result.created[2].tags.map((t: { name: string }) => t.name)).toContain("groceries");
  });

  it("creates tasks with all optional fields", async () => {
    const result = await exec(
      registry,
      "bulk_create_tasks",
      {
        tasks: [
          {
            title: "Complex task",
            priority: 1,
            dueDate: "2026-03-01",
            tags: ["work", "urgent"],
            estimatedMinutes: 60,
          },
        ],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.created[0].title).toBe("Complex task");
    expect(result.created[0].priority).toBe(1);
  });

  it("creates a single task", async () => {
    const result = await exec(
      registry,
      "bulk_create_tasks",
      {
        tasks: [{ title: "Solo task" }],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });
});

describe("bulk_complete_tasks", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let taskService: TaskService;

  beforeEach(() => {
    const svc = createTestServices();
    taskService = svc.taskService;
    ctx = {
      taskService: svc.taskService,
      projectService: svc.projectService,
      tagService: svc.tagService,
      storage: svc.storage,
    };
    registry = new ToolRegistry();
    registerBulkOperationTools(registry);
  });

  it("completes multiple tasks by ID", async () => {
    const t1 = await taskService.create({
      title: "Task 1",
      priority: null,
      dueDate: null,
      dueTime: false,
      tags: [],
      projectId: null,
      recurrence: null,
      remindAt: null,
      estimatedMinutes: null,
      deadline: null,
      isSomeday: false,
      sectionId: null,
    });
    const t2 = await taskService.create({
      title: "Task 2",
      priority: null,
      dueDate: null,
      dueTime: false,
      tags: [],
      projectId: null,
      recurrence: null,
      remindAt: null,
      estimatedMinutes: null,
      deadline: null,
      isSomeday: false,
      sectionId: null,
    });

    const result = await exec(
      registry,
      "bulk_complete_tasks",
      {
        taskIds: [t1.id, t2.id],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.completed).toHaveLength(2);
    expect(result.completed[0].title).toBe("Task 1");
    expect(result.completed[1].title).toBe("Task 2");
  });

  it("completes a single task", async () => {
    const t = await taskService.create({
      title: "Only task",
      priority: null,
      dueDate: null,
      dueTime: false,
      tags: [],
      projectId: null,
      recurrence: null,
      remindAt: null,
      estimatedMinutes: null,
      deadline: null,
      isSomeday: false,
      sectionId: null,
    });

    const result = await exec(
      registry,
      "bulk_complete_tasks",
      {
        taskIds: [t.id],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });
});

describe("bulk_update_tasks", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let taskService: TaskService;

  beforeEach(() => {
    const svc = createTestServices();
    taskService = svc.taskService;
    ctx = {
      taskService: svc.taskService,
      projectService: svc.projectService,
      tagService: svc.tagService,
      storage: svc.storage,
    };
    registry = new ToolRegistry();
    registerBulkOperationTools(registry);
  });

  it("updates priority on multiple tasks", async () => {
    const t1 = await taskService.create({
      title: "Task A",
      priority: null,
      dueDate: null,
      dueTime: false,
      tags: [],
      projectId: null,
      recurrence: null,
      remindAt: null,
      estimatedMinutes: null,
      deadline: null,
      isSomeday: false,
      sectionId: null,
    });
    const t2 = await taskService.create({
      title: "Task B",
      priority: null,
      dueDate: null,
      dueTime: false,
      tags: [],
      projectId: null,
      recurrence: null,
      remindAt: null,
      estimatedMinutes: null,
      deadline: null,
      isSomeday: false,
      sectionId: null,
    });

    const result = await exec(
      registry,
      "bulk_update_tasks",
      {
        taskIds: [t1.id, t2.id],
        changes: { priority: 1 },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.updated).toHaveLength(2);

    // Verify the tasks were actually updated
    const updated1 = await taskService.get(t1.id);
    const updated2 = await taskService.get(t2.id);
    expect(updated1?.priority).toBe(1);
    expect(updated2?.priority).toBe(1);
  });

  it("updates tags on multiple tasks", async () => {
    const t1 = await taskService.create({
      title: "Tag me 1",
      priority: null,
      dueDate: null,
      dueTime: false,
      tags: [],
      projectId: null,
      recurrence: null,
      remindAt: null,
      estimatedMinutes: null,
      deadline: null,
      isSomeday: false,
      sectionId: null,
    });
    const t2 = await taskService.create({
      title: "Tag me 2",
      priority: null,
      dueDate: null,
      dueTime: false,
      tags: [],
      projectId: null,
      recurrence: null,
      remindAt: null,
      estimatedMinutes: null,
      deadline: null,
      isSomeday: false,
      sectionId: null,
    });

    const result = await exec(
      registry,
      "bulk_update_tasks",
      {
        taskIds: [t1.id, t2.id],
        changes: { tags: ["important", "work"] },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
  });

  it("updates due date on a single task", async () => {
    const t = await taskService.create({
      title: "Due soon",
      priority: null,
      dueDate: null,
      dueTime: false,
      tags: [],
      projectId: null,
      recurrence: null,
      remindAt: null,
      estimatedMinutes: null,
      deadline: null,
      isSomeday: false,
      sectionId: null,
    });

    const result = await exec(
      registry,
      "bulk_update_tasks",
      {
        taskIds: [t.id],
        changes: { dueDate: "2026-03-15" },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });
});
