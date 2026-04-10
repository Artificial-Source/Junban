import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

const taskApiMocks = vi.hoisted(() => ({
  listTasks: vi.fn().mockResolvedValue([]),
  createTask: vi.fn().mockResolvedValue({
    id: "task-1",
    title: "New task",
    status: "pending",
    priority: "none",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  }),
  updateTask: vi.fn().mockResolvedValue({
    id: "task-1",
    title: "Updated task",
    status: "pending",
    priority: "high",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  }),
  completeTask: vi.fn().mockResolvedValue({
    id: "task-1",
    title: "Done task",
    status: "completed",
    priority: "none",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  }),
  deleteTask: vi.fn().mockResolvedValue(undefined),
  completeManyTasks: vi.fn().mockResolvedValue([]),
  deleteManyTasks: vi.fn().mockResolvedValue(undefined),
  updateManyTasks: vi.fn().mockResolvedValue([]),
  restoreTask: vi.fn().mockResolvedValue({
    id: "task-1",
    title: "Restored task",
    status: "pending",
    priority: "none",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  }),
}));

vi.mock("../../../src/ui/api/tasks.js", () => taskApiMocks);
import { TaskProvider, useTaskContext } from "../../../src/ui/context/TaskContext.js";

function TestConsumer() {
  const { state, createTask, updateTask, completeTask, deleteTask, refreshTasks } =
    useTaskContext();
  return (
    <div>
      <span data-testid="loading">{String(state.loading)}</span>
      <span data-testid="error">{state.error ?? "null"}</span>
      <span data-testid="task-count">{state.tasks.length}</span>
      <span data-testid="tasks">{JSON.stringify(state.tasks)}</span>
      <button data-testid="create" onClick={() => createTask({ title: "New task" })}>
        Create
      </button>
      <button data-testid="update" onClick={() => updateTask("task-1", { priority: "high" })}>
        Update
      </button>
      <button data-testid="complete" onClick={() => completeTask("task-1")}>
        Complete
      </button>
      <button data-testid="delete" onClick={() => deleteTask("task-1")}>
        Delete
      </button>
      <button data-testid="refresh" onClick={() => refreshTasks()}>
        Refresh
      </button>
    </div>
  );
}

describe("TaskContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskApiMocks.listTasks.mockResolvedValue([]);
  });

  it("throws when used outside provider", () => {
    // Suppress React error boundary noise
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow(
      "useTaskContext must be used within TaskProvider",
    );
    spy.mockRestore();
  });

  it("fetches tasks on mount via refreshTasks", async () => {
    const mockTasks = [
      { id: "t1", title: "Task 1", status: "pending", priority: "none" },
      { id: "t2", title: "Task 2", status: "pending", priority: "high" },
    ];
    taskApiMocks.listTasks.mockResolvedValue(mockTasks);

    render(
      <TaskProvider>
        <TestConsumer />
      </TaskProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    expect(taskApiMocks.listTasks).toHaveBeenCalled();
    expect(screen.getByTestId("task-count").textContent).toBe("2");
  });

  it("sets loading state during fetch", async () => {
    let resolveFetch!: (value: any) => void;
    taskApiMocks.listTasks.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    render(
      <TaskProvider>
        <TestConsumer />
      </TaskProvider>,
    );

    await waitFor(() => {
      expect(taskApiMocks.listTasks).toHaveBeenCalled();
    });

    // Initially loading
    expect(screen.getByTestId("loading").textContent).toBe("true");
    expect(screen.getByTestId("error").textContent).toBe("null");

    await act(async () => {
      resolveFetch([]);
    });

    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("sets error state on fetch failure", async () => {
    taskApiMocks.listTasks.mockRejectedValue(new Error("Network error"));

    render(
      <TaskProvider>
        <TestConsumer />
      </TaskProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    expect(screen.getByTestId("error").textContent).toContain("Network error");
  });

  it("createTask calls api and adds task to state", async () => {
    render(
      <TaskProvider>
        <TestConsumer />
      </TaskProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    await act(async () => {
      screen.getByTestId("create").click();
    });

    expect(taskApiMocks.createTask).toHaveBeenCalledWith({ title: "New task" });
    expect(screen.getByTestId("task-count").textContent).toBe("1");
  });

  it("createTask sets error on api failure", async () => {
    taskApiMocks.createTask.mockRejectedValue(new Error("Create failed"));

    render(
      <TaskProvider>
        <TestConsumer />
      </TaskProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    await act(async () => {
      screen.getByTestId("create").click();
    });

    expect(screen.getByTestId("error").textContent).toContain("Failed to create task");
  });

  it("updateTask calls api and updates task in state", async () => {
    const existingTask = {
      id: "task-1",
      title: "Old task",
      status: "pending",
      priority: "none",
    };
    taskApiMocks.listTasks.mockResolvedValue([existingTask]);

    render(
      <TaskProvider>
        <TestConsumer />
      </TaskProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    await act(async () => {
      screen.getByTestId("update").click();
    });

    expect(taskApiMocks.updateTask).toHaveBeenCalledWith("task-1", { priority: "high" });
    const tasks = JSON.parse(screen.getByTestId("tasks").textContent!);
    expect(tasks[0].title).toBe("Updated task");
  });

  it("updateTask sets error on api failure", async () => {
    taskApiMocks.updateTask.mockRejectedValue(new Error("Update failed"));

    render(
      <TaskProvider>
        <TestConsumer />
      </TaskProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    await act(async () => {
      screen.getByTestId("update").click();
    });

    expect(screen.getByTestId("error").textContent).toContain("Failed to update task");
  });

  it("completeTask calls api and updates task in state (non-recurring)", async () => {
    const existingTask = { id: "task-1", title: "Task", status: "pending", priority: "none" };
    taskApiMocks.listTasks.mockResolvedValue([existingTask]);

    render(
      <TaskProvider>
        <TestConsumer />
      </TaskProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    await act(async () => {
      screen.getByTestId("complete").click();
    });

    expect(taskApiMocks.completeTask).toHaveBeenCalledWith("task-1");
    const tasks = JSON.parse(screen.getByTestId("tasks").textContent!);
    expect(tasks[0].status).toBe("completed");
  });

  it("completeTask refreshes all tasks for recurring tasks", async () => {
    const recurringTask = {
      id: "task-1",
      title: "Recurring",
      status: "completed",
      priority: "none",
      recurrence: "daily",
    };
    taskApiMocks.completeTask.mockResolvedValue(recurringTask);
    taskApiMocks.listTasks.mockResolvedValue([
      { id: "task-1", title: "Recurring", status: "pending" },
    ]);

    render(
      <TaskProvider>
        <TestConsumer />
      </TaskProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    // Reset call count after initial mount fetch
    taskApiMocks.listTasks.mockClear();
    taskApiMocks.listTasks.mockResolvedValue([
      { id: "task-1", title: "Recurring (next)", status: "pending" },
    ]);

    await act(async () => {
      screen.getByTestId("complete").click();
    });

    // Should have called listTasks again (refreshTasks) because of recurrence
    expect(taskApiMocks.listTasks).toHaveBeenCalled();
  });

  it("deleteTask calls api and removes task from state", async () => {
    const existingTask = { id: "task-1", title: "Task", status: "pending", priority: "none" };
    taskApiMocks.listTasks.mockResolvedValue([existingTask]);

    render(
      <TaskProvider>
        <TestConsumer />
      </TaskProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("task-count").textContent).toBe("1");
    });

    await act(async () => {
      screen.getByTestId("delete").click();
    });

    expect(taskApiMocks.deleteTask).toHaveBeenCalledWith("task-1");
    expect(screen.getByTestId("task-count").textContent).toBe("0");
  });

  it("deleteTask sets error on api failure", async () => {
    taskApiMocks.deleteTask.mockRejectedValue(new Error("Delete failed"));

    render(
      <TaskProvider>
        <TestConsumer />
      </TaskProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    await act(async () => {
      screen.getByTestId("delete").click();
    });

    expect(screen.getByTestId("error").textContent).toContain("Failed to delete task");
  });

  it("refreshTasks reloads tasks from api", async () => {
    taskApiMocks.listTasks.mockResolvedValue([]);

    render(
      <TaskProvider>
        <TestConsumer />
      </TaskProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    taskApiMocks.listTasks.mockResolvedValue([
      { id: "t1", title: "Refreshed task", status: "pending" },
    ]);

    await act(async () => {
      screen.getByTestId("refresh").click();
    });

    await waitFor(() => {
      expect(screen.getByTestId("task-count").textContent).toBe("1");
    });
  });
});
