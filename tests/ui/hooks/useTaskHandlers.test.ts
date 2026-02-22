import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mockCreateTask = vi.fn();
const mockUpdateTask = vi.fn();
const mockCompleteTask = vi.fn();
const mockDeleteTask = vi.fn();
const mockPlaySound = vi.fn();
const mockIndentTask = vi.fn();
const mockOutdentTask = vi.fn();
const mockReorderTasks = vi.fn();

vi.mock("../../../src/ui/context/TaskContext.js", () => ({
  useTaskContext: () => ({
    state: {
      tasks: [
        { id: "t1", title: "Task 1", status: "pending", tags: [] },
        { id: "t2", title: "Task 2", status: "completed", tags: [] },
      ],
    },
    createTask: (...args: any[]) => mockCreateTask(...args),
    updateTask: (...args: any[]) => mockUpdateTask(...args),
    completeTask: (...args: any[]) => mockCompleteTask(...args),
    deleteTask: (...args: any[]) => mockDeleteTask(...args),
  }),
}));

vi.mock("../../../src/ui/hooks/useSoundEffect.js", () => ({
  useSoundEffect:
    () =>
    (...args: any[]) =>
      mockPlaySound(...args),
}));

vi.mock("../../../src/ui/api/index.js", () => ({
  api: {
    indentTask: (...args: any[]) => mockIndentTask(...args),
    outdentTask: (...args: any[]) => mockOutdentTask(...args),
    reorderTasks: (...args: any[]) => mockReorderTasks(...args),
  },
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

  it("handleToggleTask completes a pending task and plays sound", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleToggleTask("t1");
    });

    expect(mockCompleteTask).toHaveBeenCalledWith("t1");
    expect(mockPlaySound).toHaveBeenCalledWith("complete");
  });

  it("handleToggleTask uncompletes a completed task", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleToggleTask("t2");
    });

    expect(mockUpdateTask).toHaveBeenCalledWith("t2", {
      status: "pending",
      completedAt: null,
    });
    expect(mockPlaySound).not.toHaveBeenCalledWith("complete");
  });

  it("handleDeleteTask calls deleteTask and plays sound", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleDeleteTask("t1");
    });

    expect(mockDeleteTask).toHaveBeenCalledWith("t1");
    expect(mockPlaySound).toHaveBeenCalledWith("delete");
  });

  it("handleUpdateDueDate sets due date", async () => {
    const { result } = renderHook(() => useTaskHandlers(null));

    await act(async () => {
      await result.current.handleUpdateDueDate("t1", "2026-04-01");
    });

    expect(mockUpdateTask).toHaveBeenCalledWith("t1", {
      dueDate: expect.any(String),
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
