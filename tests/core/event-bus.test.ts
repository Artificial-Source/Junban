import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../../src/core/event-bus.js";
import type { Task } from "../../src/core/types.js";

/** Minimal task fixture for event payloads. */
function makeTask(overrides: Partial<Task> = {}): Task {
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
    parentId: null,
    remindAt: null,
    estimatedMinutes: null,
    actualMinutes: null,
    deadline: null,
    isSomeday: false,
    sectionId: null,
    dreadLevel: null,
    tags: [],
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("EventBus", () => {
  // ── on / emit ──

  describe("on() and emit()", () => {
    it("calls listener when event is emitted", () => {
      const bus = new EventBus();
      const listener = vi.fn();

      bus.on("task:create", listener);
      const task = makeTask();
      bus.emit("task:create", task);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(task);
    });

    it("passes the correct data payload", () => {
      const bus = new EventBus();
      const listener = vi.fn();

      bus.on("task:update", listener);
      const task = makeTask({ title: "Updated" });
      const payload = { task, changes: { title: "Updated" } };
      bus.emit("task:update", payload);

      expect(listener).toHaveBeenCalledWith(payload);
    });

    it("supports multiple listeners on the same event", () => {
      const bus = new EventBus();
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      bus.on("task:create", listener1);
      bus.on("task:create", listener2);

      bus.emit("task:create", makeTask());

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it("does not call listeners for other events", () => {
      const bus = new EventBus();
      const createListener = vi.fn();
      const deleteListener = vi.fn();

      bus.on("task:create", createListener);
      bus.on("task:delete", deleteListener);

      bus.emit("task:create", makeTask());

      expect(createListener).toHaveBeenCalledOnce();
      expect(deleteListener).not.toHaveBeenCalled();
    });

    it("handles emit with no listeners without error", () => {
      const bus = new EventBus();

      expect(() => bus.emit("task:create", makeTask())).not.toThrow();
    });

    it("calls listener multiple times for multiple emits", () => {
      const bus = new EventBus();
      const listener = vi.fn();

      bus.on("task:create", listener);
      bus.emit("task:create", makeTask());
      bus.emit("task:create", makeTask({ id: "task-2" }));

      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  // ── off ──

  describe("off()", () => {
    it("removes a specific listener", () => {
      const bus = new EventBus();
      const listener = vi.fn();

      bus.on("task:create", listener);
      bus.off("task:create", listener);
      bus.emit("task:create", makeTask());

      expect(listener).not.toHaveBeenCalled();
    });

    it("only removes the specified listener, not others", () => {
      const bus = new EventBus();
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      bus.on("task:create", listener1);
      bus.on("task:create", listener2);
      bus.off("task:create", listener1);

      bus.emit("task:create", makeTask());

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it("is safe to call off for a listener that was never added", () => {
      const bus = new EventBus();
      const listener = vi.fn();

      expect(() => bus.off("task:create", listener)).not.toThrow();
    });

    it("is safe to call off for an event that has no listeners", () => {
      const bus = new EventBus();

      expect(() => bus.off("task:delete", vi.fn())).not.toThrow();
    });
  });

  // ── clear ──

  describe("clear()", () => {
    it("removes all listeners for all events", () => {
      const bus = new EventBus();
      const createListener = vi.fn();
      const deleteListener = vi.fn();

      bus.on("task:create", createListener);
      bus.on("task:delete", deleteListener);

      bus.clear();

      bus.emit("task:create", makeTask());
      bus.emit("task:delete", makeTask());

      expect(createListener).not.toHaveBeenCalled();
      expect(deleteListener).not.toHaveBeenCalled();
    });

    it("resets listener count to zero", () => {
      const bus = new EventBus();
      bus.on("task:create", vi.fn());
      bus.on("task:create", vi.fn());

      bus.clear();

      expect(bus.listenerCount("task:create")).toBe(0);
    });
  });

  // ── listenerCount ──

  describe("listenerCount()", () => {
    it("returns 0 for events with no listeners", () => {
      const bus = new EventBus();
      expect(bus.listenerCount("task:create")).toBe(0);
    });

    it("returns the correct count after adding listeners", () => {
      const bus = new EventBus();
      bus.on("task:create", vi.fn());
      bus.on("task:create", vi.fn());

      expect(bus.listenerCount("task:create")).toBe(2);
    });

    it("decrements count after removing a listener", () => {
      const bus = new EventBus();
      const listener = vi.fn();

      bus.on("task:create", listener);
      bus.on("task:create", vi.fn());

      expect(bus.listenerCount("task:create")).toBe(2);

      bus.off("task:create", listener);

      expect(bus.listenerCount("task:create")).toBe(1);
    });
  });

  // ── error isolation ──

  describe("error isolation", () => {
    it("catches listener errors and continues calling other listeners", () => {
      const bus = new EventBus();
      const badListener = vi.fn(() => {
        throw new Error("Listener blew up");
      });
      const goodListener = vi.fn();

      bus.on("task:create", badListener);
      bus.on("task:create", goodListener);

      expect(() => bus.emit("task:create", makeTask())).not.toThrow();
      expect(badListener).toHaveBeenCalledOnce();
      expect(goodListener).toHaveBeenCalledOnce();
    });

    it("keeps current emit stable when listeners are removed during dispatch", () => {
      const bus = new EventBus();
      const secondListener = vi.fn();
      const firstListener = vi.fn(() => {
        bus.off("task:create", secondListener);
      });

      bus.on("task:create", firstListener);
      bus.on("task:create", secondListener);

      bus.emit("task:create", makeTask());
      bus.emit("task:create", makeTask({ id: "task-2" }));

      expect(firstListener).toHaveBeenCalledTimes(2);
      expect(secondListener).toHaveBeenCalledTimes(1);
    });
  });

  // ── typed events ──

  describe("typed event payloads", () => {
    it("handles task:reorder with string array payload", () => {
      const bus = new EventBus();
      const listener = vi.fn();

      bus.on("task:reorder", listener);
      bus.emit("task:reorder", ["id-1", "id-2", "id-3"]);

      expect(listener).toHaveBeenCalledWith(["id-1", "id-2", "id-3"]);
    });

    it("handles task:moved with from/to project IDs", () => {
      const bus = new EventBus();
      const listener = vi.fn();

      bus.on("task:moved", listener);
      const payload = {
        task: makeTask(),
        fromProjectId: "proj-1",
        toProjectId: "proj-2",
      };
      bus.emit("task:moved", payload);

      expect(listener).toHaveBeenCalledWith(payload);
    });

    it("handles task:estimated with previous/new minutes", () => {
      const bus = new EventBus();
      const listener = vi.fn();

      bus.on("task:estimated", listener);
      const payload = {
        task: makeTask(),
        previousMinutes: null,
        newMinutes: 30,
      };
      bus.emit("task:estimated", payload);

      expect(listener).toHaveBeenCalledWith(payload);
    });
  });
});
