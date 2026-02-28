import { describe, it, expect } from "vitest";
import { evaluateNudges, type NudgeContext, type NudgeType } from "../../src/core/nudges.js";
import type { Task } from "../../src/core/types.js";

const ALL_TYPES = new Set<NudgeType>([
  "overdue_alert",
  "deadline_approaching",
  "stale_tasks",
  "empty_today",
  "overloaded_day",
]);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "t1",
    title: overrides.title ?? "Test task",
    description: null,
    status: "pending",
    priority: null,
    dueDate: null,
    dueTime: false,
    completedAt: null,
    projectId: null,
    recurrence: null,
    parentId: null,
    remindAt: null,
    estimatedMinutes: null,
    actualMinutes: null,
    deadline: null,
    isSomeday: false,
    sectionId: null,
    tags: [],
    sortOrder: 0,
    createdAt: "2026-02-28T00:00:00.000Z",
    updatedAt: "2026-02-28T00:00:00.000Z",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<NudgeContext> = {}): NudgeContext {
  return {
    tasks: [],
    todayKey: "2026-02-28",
    capacityMinutes: 480,
    enabledTypes: ALL_TYPES,
    ...overrides,
  };
}

describe("evaluateNudges", () => {
  // ── overdue_alert ──
  describe("overdue_alert", () => {
    it("fires when tasks are overdue", () => {
      const ctx = makeCtx({
        tasks: [
          makeTask({ id: "t1", dueDate: "2026-02-26T00:00:00.000Z" }),
          makeTask({ id: "t2", dueDate: "2026-02-27T00:00:00.000Z" }),
        ],
      });
      const nudges = evaluateNudges(ctx);
      const overdue = nudges.find((n) => n.type === "overdue_alert");
      expect(overdue).toBeDefined();
      expect(overdue!.message).toBe("You have 2 overdue tasks");
      expect(overdue!.severity).toBe("warning");
      expect(overdue!.taskIds).toEqual(["t1", "t2"]);
    });

    it("singular message for 1 overdue task", () => {
      const ctx = makeCtx({
        tasks: [makeTask({ dueDate: "2026-02-27T00:00:00.000Z" })],
      });
      const nudges = evaluateNudges(ctx);
      const overdue = nudges.find((n) => n.type === "overdue_alert");
      expect(overdue!.message).toBe("You have 1 overdue task");
    });

    it("does not fire when no tasks are overdue", () => {
      const ctx = makeCtx({
        tasks: [makeTask({ dueDate: "2026-02-28T00:00:00.000Z" })],
      });
      const nudges = evaluateNudges(ctx);
      expect(nudges.find((n) => n.type === "overdue_alert")).toBeUndefined();
    });

    it("ignores completed tasks", () => {
      const ctx = makeCtx({
        tasks: [
          makeTask({
            dueDate: "2026-02-26T00:00:00.000Z",
            status: "completed",
            completedAt: "2026-02-27T00:00:00.000Z",
          }),
        ],
      });
      const nudges = evaluateNudges(ctx);
      expect(nudges.find((n) => n.type === "overdue_alert")).toBeUndefined();
    });
  });

  // ── deadline_approaching ──
  describe("deadline_approaching", () => {
    it("fires for deadline today", () => {
      const ctx = makeCtx({
        tasks: [makeTask({ id: "t1", title: "Report", deadline: "2026-02-28T00:00:00.000Z" })],
      });
      const nudges = evaluateNudges(ctx);
      const n = nudges.find((n) => n.type === "deadline_approaching");
      expect(n).toBeDefined();
      expect(n!.message).toContain("deadline is today");
      expect(n!.id).toBe("deadline_approaching:t1");
    });

    it("fires for deadline tomorrow", () => {
      const ctx = makeCtx({
        tasks: [makeTask({ id: "t1", title: "Report", deadline: "2026-03-01T00:00:00.000Z" })],
      });
      const nudges = evaluateNudges(ctx);
      const n = nudges.find((n) => n.type === "deadline_approaching");
      expect(n).toBeDefined();
      expect(n!.message).toContain("deadline is tomorrow");
    });

    it("does not fire for deadline in 2+ days", () => {
      const ctx = makeCtx({
        tasks: [makeTask({ deadline: "2026-03-02T00:00:00.000Z" })],
      });
      const nudges = evaluateNudges(ctx);
      expect(nudges.find((n) => n.type === "deadline_approaching")).toBeUndefined();
    });
  });

  // ── stale_tasks ──
  describe("stale_tasks", () => {
    it("fires for tasks pending 14+ days without due date", () => {
      const ctx = makeCtx({
        tasks: [
          makeTask({
            id: "t1",
            title: "Old task",
            createdAt: "2026-02-14T00:00:00.000Z",
          }),
        ],
      });
      const nudges = evaluateNudges(ctx);
      const stale = nudges.find((n) => n.type === "stale_tasks");
      expect(stale).toBeDefined();
      expect(stale!.message).toContain("14 days");
    });

    it("does not fire for tasks with due date", () => {
      const ctx = makeCtx({
        tasks: [
          makeTask({
            createdAt: "2026-02-01T00:00:00.000Z",
            dueDate: "2026-03-01T00:00:00.000Z",
          }),
        ],
      });
      const nudges = evaluateNudges(ctx);
      expect(nudges.find((n) => n.type === "stale_tasks")).toBeUndefined();
    });

    it("limits to 3 stale nudges", () => {
      const tasks = Array.from({ length: 5 }, (_, i) =>
        makeTask({
          id: `t${i}`,
          title: `Stale ${i}`,
          createdAt: "2026-02-01T00:00:00.000Z",
        }),
      );
      const ctx = makeCtx({ tasks });
      const nudges = evaluateNudges(ctx);
      const stale = nudges.filter((n) => n.type === "stale_tasks");
      expect(stale).toHaveLength(3);
    });

    it("does not fire for recent tasks", () => {
      const ctx = makeCtx({
        tasks: [makeTask({ createdAt: "2026-02-20T00:00:00.000Z" })],
      });
      const nudges = evaluateNudges(ctx);
      expect(nudges.find((n) => n.type === "stale_tasks")).toBeUndefined();
    });
  });

  // ── empty_today ──
  describe("empty_today", () => {
    it("fires when no tasks are planned for today", () => {
      const ctx = makeCtx({ tasks: [] });
      const nudges = evaluateNudges(ctx);
      const empty = nudges.find((n) => n.type === "empty_today");
      expect(empty).toBeDefined();
      expect(empty!.message).toBe("No tasks planned for today");
      expect(empty!.severity).toBe("info");
      expect(empty!.id).toBe("empty_today:2026-02-28");
    });

    it("does not fire when today has tasks", () => {
      const ctx = makeCtx({
        tasks: [makeTask({ dueDate: "2026-02-28T00:00:00.000Z" })],
      });
      const nudges = evaluateNudges(ctx);
      expect(nudges.find((n) => n.type === "empty_today")).toBeUndefined();
    });
  });

  // ── overloaded_day ──
  describe("overloaded_day", () => {
    it("fires when estimated time exceeds capacity", () => {
      const ctx = makeCtx({
        tasks: [
          makeTask({ id: "t1", dueDate: "2026-02-28T00:00:00.000Z", estimatedMinutes: 300 }),
          makeTask({ id: "t2", dueDate: "2026-02-28T00:00:00.000Z", estimatedMinutes: 300 }),
        ],
        capacityMinutes: 480,
      });
      const nudges = evaluateNudges(ctx);
      const overloaded = nudges.find((n) => n.type === "overloaded_day");
      expect(overloaded).toBeDefined();
      expect(overloaded!.message).toContain("10h of work");
      expect(overloaded!.message).toContain("2h over capacity");
      expect(overloaded!.severity).toBe("warning");
    });

    it("includes overdue tasks in workload", () => {
      const ctx = makeCtx({
        tasks: [
          makeTask({ id: "t1", dueDate: "2026-02-27T00:00:00.000Z", estimatedMinutes: 300 }),
          makeTask({ id: "t2", dueDate: "2026-02-28T00:00:00.000Z", estimatedMinutes: 300 }),
        ],
        capacityMinutes: 480,
      });
      const nudges = evaluateNudges(ctx);
      expect(nudges.find((n) => n.type === "overloaded_day")).toBeDefined();
    });

    it("does not fire when under capacity", () => {
      const ctx = makeCtx({
        tasks: [makeTask({ dueDate: "2026-02-28T00:00:00.000Z", estimatedMinutes: 60 })],
        capacityMinutes: 480,
      });
      const nudges = evaluateNudges(ctx);
      expect(nudges.find((n) => n.type === "overloaded_day")).toBeUndefined();
    });
  });

  // ── General behavior ──
  describe("general", () => {
    it("respects enabledTypes filter", () => {
      const ctx = makeCtx({
        tasks: [],
        enabledTypes: new Set<NudgeType>(["overdue_alert"]),
      });
      const nudges = evaluateNudges(ctx);
      // empty_today would fire with empty task list, but it's not enabled
      expect(nudges.find((n) => n.type === "empty_today")).toBeUndefined();
    });

    it("generates deterministic IDs", () => {
      const ctx = makeCtx({
        tasks: [makeTask({ id: "t1", dueDate: "2026-02-26T00:00:00.000Z" })],
      });
      const nudges1 = evaluateNudges(ctx);
      const nudges2 = evaluateNudges(ctx);

      const overdue1 = nudges1.find((n) => n.type === "overdue_alert");
      const overdue2 = nudges2.find((n) => n.type === "overdue_alert");
      expect(overdue1!.id).toBe(overdue2!.id);
    });
  });
});
