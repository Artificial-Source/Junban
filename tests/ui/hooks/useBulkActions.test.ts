import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mockPlaySound = vi.fn();
const mockListTaskRelations = vi.fn().mockResolvedValue([]);
const mockAddTaskRelation = vi.fn().mockResolvedValue(undefined);

// Undo manager mock — tracks perform calls and executes the action
const mockPerform = vi.fn().mockImplementation(async (action: any) => {
  await action.execute();
});
const mockUndoManager = { perform: mockPerform };

const mockTaskContext = {
  state: {
    tasks: [
      {
        id: "t1",
        title: "Task 1",
        status: "pending",
        priority: null,
        dueDate: null,
        dueTime: false,
        completedAt: null,
        projectId: "p1",
        recurrence: null,
        description: null,
        tags: [{ id: "tag1", name: "work", color: "#f00" }],
      },
      {
        id: "t2",
        title: "Task 2",
        status: "pending",
        priority: null,
        dueDate: null,
        dueTime: false,
        completedAt: null,
        projectId: null,
        recurrence: null,
        description: null,
        tags: [{ id: "tag2", name: "home", color: "#0f0" }],
      },
    ],
  },
  completeTask: vi.fn().mockResolvedValue(undefined),
  deleteTask: vi.fn().mockResolvedValue(undefined),
  createTask: vi.fn().mockResolvedValue(undefined),
  restoreTask: vi.fn().mockResolvedValue(undefined),
  completeManyTasks: vi.fn().mockResolvedValue([]),
  deleteManyTasks: vi.fn().mockResolvedValue(undefined),
  updateManyTasks: vi.fn().mockResolvedValue([]),
  updateTask: vi.fn().mockResolvedValue(undefined),
  refreshTasks: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../../../src/ui/context/TaskContext.js", () => ({
  useTaskContext: () => mockTaskContext,
}));

vi.mock("../../../src/ui/context/UndoContext.js", () => ({
  useUndoContext: () => ({
    undoManager: mockUndoManager,
  }),
}));

vi.mock("../../../src/ui/hooks/useSoundEffect.js", () => ({
  useSoundEffect: () => mockPlaySound,
}));

vi.mock("../../../src/ui/api/tasks.js", () => ({
  listTaskRelations: (...args: any[]) => mockListTaskRelations(...args),
  addTaskRelation: (...args: any[]) => mockAddTaskRelation(...args),
}));

import { useBulkActions } from "../../../src/ui/hooks/useBulkActions.js";

describe("useBulkActions", () => {
  let clearSelection: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearSelection = vi.fn();
  });

  it("handleBulkComplete pushes bulk complete action via undo manager", async () => {
    const selected = new Set(["t1", "t2"]);
    const { result } = renderHook(() => useBulkActions(selected, clearSelection));

    await act(async () => {
      await result.current.handleBulkComplete();
    });

    expect(mockPerform).toHaveBeenCalledTimes(1);
    const action = mockPerform.mock.calls[0][0];
    expect(action.description).toBe("Complete 2 tasks");
    expect(mockTaskContext.completeManyTasks).toHaveBeenCalledWith(["t1", "t2"]);
    expect(mockPlaySound).toHaveBeenCalledWith("complete");
    expect(clearSelection).toHaveBeenCalled();
  });

  it("handleBulkDelete pushes bulk delete action via undo manager", async () => {
    const selected = new Set(["t1"]);
    const { result } = renderHook(() => useBulkActions(selected, clearSelection));

    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(mockPerform).toHaveBeenCalledTimes(1);
    const action = mockPerform.mock.calls[0][0];
    expect(action.description).toBe("Delete 1 tasks");
    expect(mockTaskContext.deleteManyTasks).toHaveBeenCalledWith(["t1"]);
    expect(mockPlaySound).toHaveBeenCalledWith("delete");
    expect(clearSelection).toHaveBeenCalled();
  });

  it("handleBulkMoveToProject pushes bulk update action via undo manager", async () => {
    const selected = new Set(["t1", "t2"]);
    const { result } = renderHook(() => useBulkActions(selected, clearSelection));

    await act(async () => {
      await result.current.handleBulkMoveToProject("p2");
    });

    expect(mockPerform).toHaveBeenCalledTimes(1);
    const action = mockPerform.mock.calls[0][0];
    expect(action.description).toBe("Update 2 tasks");
    expect(mockTaskContext.updateManyTasks).toHaveBeenCalledWith(["t1", "t2"], {
      projectId: "p2",
    });
    expect(clearSelection).toHaveBeenCalled();
  });

  it("handleBulkMoveToProject supports null (move to inbox)", async () => {
    const selected = new Set(["t1"]);
    const { result } = renderHook(() => useBulkActions(selected, clearSelection));

    await act(async () => {
      await result.current.handleBulkMoveToProject(null);
    });

    expect(mockTaskContext.updateManyTasks).toHaveBeenCalledWith(["t1"], {
      projectId: null,
    });
  });

  it("handleBulkMoveToProject undo restores original projectId", async () => {
    const selected = new Set(["t1"]);
    const { result } = renderHook(() => useBulkActions(selected, clearSelection));

    await act(async () => {
      await result.current.handleBulkMoveToProject("p2");
    });

    // Undo should restore t1's original projectId ("p1")
    const action = mockPerform.mock.calls[0][0];
    mockTaskContext.updateTask.mockClear();
    await action.undo();
    expect(mockTaskContext.updateTask).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ projectId: "p1" }),
    );
  });

  it("handleBulkAddTag appends tag without duplicates", async () => {
    const selected = new Set(["t1", "t2"]);
    const { result } = renderHook(() => useBulkActions(selected, clearSelection));

    await act(async () => {
      await result.current.handleBulkAddTag("urgent");
    });

    // t1 has ["work"], so should get ["work", "urgent"]
    expect(mockTaskContext.updateTask).toHaveBeenCalledWith("t1", {
      tags: ["work", "urgent"],
    });
    // t2 has ["home"], so should get ["home", "urgent"]
    expect(mockTaskContext.updateTask).toHaveBeenCalledWith("t2", {
      tags: ["home", "urgent"],
    });
    expect(clearSelection).toHaveBeenCalled();
  });

  it("handleBulkAddTag skips tasks that already have the tag", async () => {
    const selected = new Set(["t1"]);
    const { result } = renderHook(() => useBulkActions(selected, clearSelection));

    await act(async () => {
      await result.current.handleBulkAddTag("work"); // t1 already has "work"
    });

    expect(mockTaskContext.updateTask).not.toHaveBeenCalled();
    expect(clearSelection).toHaveBeenCalled();
  });
});
