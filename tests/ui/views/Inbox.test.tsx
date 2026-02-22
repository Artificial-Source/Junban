import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  Inbox: (props: any) => <svg data-testid="inbox-icon" {...props} />,
}));

vi.mock("../../../src/ui/components/TaskInput.js", () => ({
  TaskInput: (props: any) => <div data-testid="task-input" data-placeholder={props.placeholder} />,
}));

vi.mock("../../../src/ui/components/TaskList.js", () => ({
  TaskList: (props: any) => (
    <div data-testid="task-list">
      {props.tasks.length === 0 && <span>{props.emptyMessage}</span>}
      {props.tasks.map((t: any) => (
        <span key={t.id}>{t.title}</span>
      ))}
    </div>
  ),
}));

import { Inbox } from "../../../src/ui/views/Inbox.js";
import type { Task } from "../../../src/core/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
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
    tags: [],
    sortOrder: 0,
    createdAt: "2026-02-20T10:00:00.000Z",
    updatedAt: "2026-02-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("Inbox", () => {
  const defaultProps = {
    tasks: [] as Task[],
    onCreateTask: vi.fn(),
    onToggleTask: vi.fn(),
    onSelectTask: vi.fn(),
    selectedTaskId: null,
  };

  it("renders the heading and icon", () => {
    render(<Inbox {...defaultProps} />);
    expect(screen.getByText("Inbox")).toBeTruthy();
    expect(screen.getByTestId("inbox-icon")).toBeTruthy();
  });

  it("renders TaskInput", () => {
    render(<Inbox {...defaultProps} />);
    expect(screen.getByTestId("task-input")).toBeTruthy();
  });

  it("shows empty message when no tasks", () => {
    render(<Inbox {...defaultProps} />);
    expect(screen.getByText("Your inbox is empty. Add a task above!")).toBeTruthy();
  });

  it("filters tasks to only those without projectId", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Inbox task", projectId: null }),
      makeTask({ id: "t2", title: "Project task", projectId: "p1" }),
    ];
    render(<Inbox {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("Inbox task")).toBeTruthy();
    expect(screen.queryByText("Project task")).toBeNull();
  });

  it("shows pending tasks and filters old completed tasks", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Pending task", status: "pending" }),
      makeTask({
        id: "t2",
        title: "Recent done",
        status: "completed",
        completedAt: new Date().toISOString(),
      }),
    ];
    render(<Inbox {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("Pending task")).toBeTruthy();
    expect(screen.getByText("Recent done")).toBeTruthy();
  });

  it("shows task count for pending tasks", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Task A", status: "pending" }),
      makeTask({ id: "t2", title: "Task B", status: "pending" }),
    ];
    render(<Inbox {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("2 tasks")).toBeTruthy();
  });

  it("shows singular count for one task", () => {
    const tasks = [makeTask({ id: "t1", title: "Only task", status: "pending" })];
    render(<Inbox {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("1 task")).toBeTruthy();
  });
});
