import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mockCreateTask = vi.fn();
const mockUpdateTask = vi.fn();
const mockCompleteTask = vi.fn();
const mockDeleteTask = vi.fn();
const mockRefreshTasks = vi.fn();
const mockPlaySound = vi.fn();
const mockIndentTask = vi.fn();
const mockOutdentTask = vi.fn();
const mockReorderTasks = vi.fn();

// Undo manager mock — tracks perform calls
const mockPerform = vi.fn().mockImplementation(async (action: any) => {
  await action.execute();
});
const mockUndoManager = { perform: mockPerform };

vi.mock("../../../src/ui/context/TaskContext.js", () => ({
  useTaskContext: () => ({
    state: {
      tasks: [
        {
          id: "t1",
          title: "Task 1",
          status: "pending",
          priority: 2,
          dueDate: "2026-03-01T00:00:00.000Z",
          dueTime: false,
          completedAt: null,
          projectId: null,
          recurrence: null,
          description: null,
          tags: [{ id: "tag1", name: "work", color: "#f00" }],
        },
        {
          id: "t2",
          title: "Task 2",
          status: "completed",
          priority: null,
          dueDate: null,
          dueTime: false,
          completedAt: "2026-02-28T10:00:00.000Z",
          projectId: "p1",
          recurrence: null,
          description: null,
          tags: [],
        },
      ],
    },
    createTask: (...args: any[]) => mockCreateTask(...args),
    updateTask: (...args: any[]) => mockUpdateTask(...args),
    completeTask: (...args: any[]) => mockCompleteTask(...args),
    deleteTask: (...args: any[]) => mockDeleteTask(...args),
    refreshTasks: (...args: any[]) => mockRefreshTasks(...args),
  }),
}));

vi.mock("../../../src/ui/context/UndoContext.js", () => ({
  useUndoContext: () => ({
    undoManager: mockUndoManager,
  }),
}));

vi.mock("../../../src/ui/hooks/useSoundEffect.js", () => ({
  useSoundEffect:
    () =>
    (...args: any[]) =>
      mockPlaySound(...args),
}));

vi.mock("../../../src/ui/api/tasks.js", () => ({
  indentTask: (...args: any[]) => mockIndentTask(...args),
  outdentTask: (...args: any[]) => mockOutdentTask(...args),
  reorderTasks: (...args: any[]) => mockReorderTasks(...args),
}));

import { useTaskHandlers } from "../../../src/ui/hooks/useTaskHandlers.js";

describe("useTaskHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handleCreateTask calls createTask with parsed input and plays sound", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleCreateTask({
        title: "Buy milk",
        priority: 1,
        tags: ["groceries"],
        project: null,
        dueDate: new Date("2026-03-01"),
        dueTime: false,
      });
    });

    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Buy milk",
        priority: 1,
        tags: ["groceries"],
        projectId: null,
      }),
    );
    expect(mockPlaySound).toHaveBeenCalledWith("create");
  });

  it("handleCreateTask matches project name to projectId", async () => {
    const projects = [
      { id: "p1", name: "Work" },
      { id: "p2", name: "Personal" },
    ];
    const { result } = renderHook(() => useTaskHandlers(null, projects));

    await act(async () => {
      await result.current.handleCreateTask({
        title: "Finish report",
        priority: null,
        tags: [],
        project: "work",
        dueDate: null,
        dueTime: false,
      });
    });

    expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1" }));
  });

  it("handleCreateTask does not create task for empty title", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleCreateTask({
        title: "   ",
        priority: null,
        tags: [],
        project: null,
        dueDate: null,
        dueTime: false,
      });
    });

    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("handleToggleTask completes a pending task via undo manager and plays sound", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleToggleTask("t1");
    });

    expect(mockPerform).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask).toHaveBeenCalledWith("t1");
    expect(mockPlaySound).toHaveBeenCalledWith("complete");
  });

  it("handleToggleTask uncompletes a completed task via undo manager", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleToggleTask("t2");
    });

    expect(mockPerform).toHaveBeenCalledTimes(1);
    expect(mockUpdateTask).toHaveBeenCalledWith("t2", {
      status: "pending",
      completedAt: null,
    });
    expect(mockPlaySound).not.toHaveBeenCalledWith("complete");
  });

  it("handleToggleTask complete action has correct description", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleToggleTask("t1");
    });

    const action = mockPerform.mock.calls[0][0];
    expect(action.description).toBe('Complete "Task 1"');
  });

  it("handleDeleteTask snapshots task and pushes delete action via undo manager", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleDeleteTask("t1");
    });

    expect(mockPerform).toHaveBeenCalledTimes(1);
    const action = mockPerform.mock.calls[0][0];
    expect(action.description).toBe('Delete "Task 1"');
    expect(mockPlaySound).toHaveBeenCalledWith("delete");
  });

  it("handleUpdateTask captures old fields and pushes update action via undo manager", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleUpdateTask("t1", { priority: 1 });
    });

    expect(mockPerform).toHaveBeenCalledTimes(1);
    expect(mockUpdateTask).toHaveBeenCalledWith("t1", { priority: 1 });

    // Verify the action can undo (old priority was 2)
    const action = mockPerform.mock.calls[0][0];
    mockUpdateTask.mockClear();
    await action.undo();
    expect(mockUpdateTask).toHaveBeenCalledWith("t1", { priority: 2 });
  });

  it("handleUpdateTask snapshots tags as string array for undo", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleUpdateTask("t1", { tags: ["urgent"] });
    });

    const action = mockPerform.mock.calls[0][0];
    mockUpdateTask.mockClear();
    await action.undo();
    // t1 has tags: [{ name: "work" }], so old snapshot should be ["work"]
    expect(mockUpdateTask).toHaveBeenCalledWith("t1", { tags: ["work"] });
  });

  it("handleUpdateDueDate sets due date via undo manager with old date snapshot", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleUpdateDueDate("t1", "2026-04-01");
    });

    expect(mockPerform).toHaveBeenCalledTimes(1);
    expect(mockUpdateTask).toHaveBeenCalledWith("t1", {
      dueDate: expect.any(String),
      dueTime: false,
    });

    // Verify undo restores old dueDate
    const action = mockPerform.mock.calls[0][0];
    mockUpdateTask.mockClear();
    await action.undo();
    expect(mockUpdateTask).toHaveBeenCalledWith("t1", {
      dueDate: "2026-03-01T00:00:00.000Z",
      dueTime: false,
    });
  });

  it("handleUpdateDueDate clears due date when null", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleUpdateDueDate("t1", null);
    });

    expect(mockUpdateTask).toHaveBeenCalledWith("t1", {
      dueDate: null,
      dueTime: false,
    });
  });

  it("handleAddSubtask creates subtask with parentId", async () => {
    const { result } = renderHook(() => useTaskHandlers("proj-1"));

    await act(async () => {
      await result.current.handleAddSubtask("t1", "Sub task");
    });

    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Sub task",
        parentId: "t1",
        projectId: "proj-1",
      }),
    );
  });

  it("handleIndent calls api.indentTask", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleIndent("t1");
    });

    expect(mockIndentTask).toHaveBeenCalledWith("t1");
  });

  it("handleOutdent calls api.outdentTask", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleOutdent("t1");
    });

    expect(mockOutdentTask).toHaveBeenCalledWith("t1");
  });

  it("handleReorder calls api.reorderTasks", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleReorder(["t2", "t1"]);
    });

    expect(mockReorderTasks).toHaveBeenCalledWith(["t2", "t1"]);
  });

  it("handleSelectTask sets selectedTaskId", () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    act(() => {
      result.current.handleSelectTask("t1");
    });

    expect(result.current.selectedTaskId).toBe("t1");
    expect(result.current.selectedTask).toEqual(expect.objectContaining({ id: "t1" }));
  });

  it("handleCloseDetail clears selectedTaskId", () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    act(() => {
      result.current.handleSelectTask("t1");
    });
    expect(result.current.selectedTaskId).toBe("t1");

    act(() => {
      result.current.handleCloseDetail();
    });
    expect(result.current.selectedTaskId).toBeNull();
  });
});
