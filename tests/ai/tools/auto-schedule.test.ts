import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildAutoScheduleTools } from "../../../src/ai/tools/builtin/auto-schedule.js";
import { TimeBlockStore } from "../../../src/plugins/builtin/timeblocking/store.js";
import type { PluginStorageAPI } from "../../../src/plugins/builtin/timeblocking/types.js";
import type { ToolContext } from "../../../src/ai/tools/types.js";
import type { Task } from "../../../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStorage(): PluginStorageAPI {
  const data = new Map<string, unknown>();
  return {
    get: vi.fn(async <T>(key: string) => (data.get(key) as T) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
    keys: vi.fn(async () => Array.from(data.keys())),
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Test Task",
    description: null,
    status: "pending",
    priority: 2,
    dueDate: null,
    dueTime: false,
    completedAt: null,
    projectId: null,
    recurrence: null,
    parentId: null,
    remindAt: null,
    estimatedMinutes: 30,
    actualMinutes: null,
    deadline: null,
    isSomeday: false,
    sectionId: null,
    tags: [],
    sortOrder: 0,
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z",
    ...overrides,
  };
}

const DEFAULT_SETTINGS = () => ({
  workDayStart: "09:00",
  workDayEnd: "17:00",
  defaultDurationMinutes: 30,
  gridIntervalMinutes: 15,
});

function createMockContext(tasks: Task[]): ToolContext {
  return {
    taskService: {
      list: vi.fn(async () => tasks),
    } as unknown as ToolContext["taskService"],
    projectService: {} as ToolContext["projectService"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auto_schedule_day tool", () => {
  let store: TimeBlockStore;
  let tools: ReturnType<typeof buildAutoScheduleTools>;

  beforeEach(async () => {
    const storage = createMockStorage();
    store = new TimeBlockStore(storage);
    await store.initialize();
    tools = buildAutoScheduleTools(store, DEFAULT_SETTINGS);
  });

  function getAutoScheduleTool() {
    return tools.find((t) => t.definition.name === "auto_schedule_day")!;
  }

  function _getRescheduleTool() {
    return tools.find((t) => t.definition.name === "reschedule_day")!;
  }

  it("should return both tools", () => {
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.definition.name)).toContain("auto_schedule_day");
    expect(tools.map((t) => t.definition.name)).toContain("reschedule_day");
  });

  it("should return error for invalid date format", async () => {
    const tool = getAutoScheduleTool();
    const ctx = createMockContext([]);
    const result = JSON.parse(await tool.executor({ date: "bad-date" }, ctx));
    expect(result.error).toBeDefined();
  });

  it("should report no tasks when task list is empty", async () => {
    const tool = getAutoScheduleTool();
    const ctx = createMockContext([]);
    const result = JSON.parse(await tool.executor({ date: "2026-03-10" }, ctx));
    expect(result.message).toContain("No pending");
  });

  it("suggest mode should return proposal without creating blocks", async () => {
    const tasks = [makeTask({ id: "t1", title: "Important", estimatedMinutes: 60 })];
    const tool = getAutoScheduleTool();
    const ctx = createMockContext(tasks);

    const result = JSON.parse(await tool.executor({ date: "2026-03-10", mode: "suggest" }, ctx));

    expect(result.applied).toBe(false);
    expect(result.proposed).toHaveLength(1);
    expect(result.proposed[0].title).toBe("Important");

    // Should NOT have created blocks
    expect(store.listBlocks("2026-03-10")).toHaveLength(0);
  });

  it("auto mode should create blocks", async () => {
    const tasks = [makeTask({ id: "t1", title: "Important", estimatedMinutes: 60 })];
    const tool = getAutoScheduleTool();
    const ctx = createMockContext(tasks);

    const result = JSON.parse(await tool.executor({ date: "2026-03-10", mode: "auto" }, ctx));

    expect(result.applied).toBe(true);
    expect(result.blocksCreated).toBe(1);

    const blocks = store.listBlocks("2026-03-10");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].taskId).toBe("t1");
  });

  it("should filter out completed tasks", async () => {
    const tasks = [
      makeTask({ id: "t1", status: "completed" }),
      makeTask({ id: "t2", status: "pending", title: "Active" }),
    ];
    const tool = getAutoScheduleTool();
    const ctx = createMockContext(tasks);

    const result = JSON.parse(await tool.executor({ date: "2026-03-10", mode: "suggest" }, ctx));

    expect(result.proposed).toHaveLength(1);
    expect(result.proposed[0].title).toBe("Active");
  });

  it("should respect locked blocks", async () => {
    // Create a locked block covering 09:00-12:00
    await store.createBlock({
      title: "Meeting",
      date: "2026-03-10",
      startTime: "09:00",
      endTime: "12:00",
      locked: true,
    });

    const tasks = [makeTask({ id: "t1", title: "After meeting", estimatedMinutes: 60 })];
    const tool = getAutoScheduleTool();
    const ctx = createMockContext(tasks);

    const result = JSON.parse(await tool.executor({ date: "2026-03-10", mode: "suggest" }, ctx));

    if (result.proposed?.length > 0) {
      expect(result.proposed[0].startTime >= "12:00").toBe(true);
    }
  });
});

describe("reschedule_day tool", () => {
  let store: TimeBlockStore;
  let tools: ReturnType<typeof buildAutoScheduleTools>;

  beforeEach(async () => {
    const storage = createMockStorage();
    store = new TimeBlockStore(storage);
    await store.initialize();
    tools = buildAutoScheduleTools(store, DEFAULT_SETTINGS);
  });

  function getRescheduleTool() {
    return tools.find((t) => t.definition.name === "reschedule_day")!;
  }

  it("should return error for invalid date", async () => {
    const tool = getRescheduleTool();
    const ctx = createMockContext([]);
    const result = JSON.parse(await tool.executor({ date: "not-a-date" }, ctx));
    expect(result.error).toBeDefined();
  });

  it("should remove unlocked blocks and reschedule", async () => {
    // Create some existing blocks
    await store.createBlock({
      title: "Unlocked",
      date: "2026-03-10",
      startTime: "09:00",
      endTime: "10:00",
      locked: false,
    });
    await store.createBlock({
      title: "Locked Meeting",
      date: "2026-03-10",
      startTime: "10:00",
      endTime: "11:00",
      locked: true,
    });

    const tasks = [makeTask({ id: "t1", title: "Rescheduled Task", estimatedMinutes: 30 })];
    const tool = getRescheduleTool();
    const ctx = createMockContext(tasks);

    const result = JSON.parse(await tool.executor({ date: "2026-03-10" }, ctx));

    expect(result.removedBlocks).toBe(1); // only unlocked
    expect(result.createdBlocks).toBeGreaterThanOrEqual(1);

    // Locked block should still exist
    const blocks = store.listBlocks("2026-03-10");
    const lockedBlocks = blocks.filter((b) => b.locked);
    expect(lockedBlocks).toHaveLength(1);
    expect(lockedBlocks[0].title).toBe("Locked Meeting");
  });

  it("should remove all blocks when keepManual is false", async () => {
    await store.createBlock({
      title: "Locked",
      date: "2026-03-10",
      startTime: "09:00",
      endTime: "10:00",
      locked: true,
    });

    const tool = getRescheduleTool();
    const ctx = createMockContext([]);

    const result = JSON.parse(await tool.executor({ date: "2026-03-10", keepManual: false }, ctx));

    expect(result.removedBlocks).toBe(1);
  });
});
