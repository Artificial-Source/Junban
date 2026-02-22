import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  Clock: (props: any) => <svg data-testid="clock-icon" {...props} />,
}));

vi.mock("../../../src/parser/task-parser.js", () => ({
  parseTask: vi.fn(),
}));

vi.mock("../../../src/utils/format-date.js", () => ({
  toDateKey: (d: Date) => d.toISOString().split("T")[0],
}));

vi.mock("../../../src/ui/components/TaskInput.js", () => ({
  TaskInput: (_props: any) => <div data-testid="task-input" />,
}));

vi.mock("../../../src/ui/components/TaskList.js", () => ({
  TaskList: (props: any) => (
    <div data-testid="task-list">
      {props.tasks.map((t: any) => (
        <span key={t.id}>{t.title}</span>
      ))}
    </div>
  ),
}));

vi.mock("../../../src/ui/components/OverdueSection.js", () => ({
  OverdueSection: (props: any) => (
    <div data-testid="overdue-section">
      {props.tasks.map((t: any) => (
        <span key={t.id} data-testid="overdue-task">
          {t.title}
        </span>
      ))}
    </div>
  ),
}));

vi.mock("../../../src/ui/components/EmptyState.js", () => ({
  EmptyState: (props: any) => <div data-testid="empty-state">{props.title}</div>,
}));

import { Upcoming } from "../../../src/ui/views/Upcoming.js";
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

// Helper to get future/past dates
function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function pastDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

describe("Upcoming", () => {
  const defaultProps = {
    tasks: [] as Task[],
    projects: [],
    onCreateTask: vi.fn(),
    onToggleTask: vi.fn(),
    onSelectTask: vi.fn(),
    onUpdateTask: vi.fn(),
    selectedTaskId: null,
  };

  it("renders heading", () => {
    render(<Upcoming {...defaultProps} />);
    expect(screen.getByText("Upcoming")).toBeTruthy();
  });

  it("shows empty state when no upcoming tasks", () => {
    render(<Upcoming {...defaultProps} />);
    expect(screen.getByTestId("empty-state")).toBeTruthy();
    expect(screen.getByText("No upcoming tasks")).toBeTruthy();
  });

  it("shows future tasks grouped by date", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Future task", dueDate: futureDate(1) }),
      makeTask({ id: "t2", title: "Another future", dueDate: futureDate(2) }),
    ];
    render(<Upcoming {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("Future task")).toBeTruthy();
    expect(screen.getByText("Another future")).toBeTruthy();
  });

  it("shows overdue tasks in the overdue section", () => {
    const tasks = [makeTask({ id: "t1", title: "Overdue task", dueDate: pastDate(3) })];
    render(<Upcoming {...defaultProps} tasks={tasks} />);
    expect(screen.getByTestId("overdue-section")).toBeTruthy();
    expect(screen.getByText("Overdue task")).toBeTruthy();
  });

  it("shows total task count", () => {
    const tasks = [
      makeTask({ id: "t1", title: "T1", dueDate: futureDate(1) }),
      makeTask({ id: "t2", title: "T2", dueDate: futureDate(2) }),
    ];
    render(<Upcoming {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("2 tasks")).toBeTruthy();
  });

  it("shows singular count for 1 task", () => {
    const tasks = [makeTask({ id: "t1", title: "Only one", dueDate: futureDate(1) })];
    render(<Upcoming {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("1 task")).toBeTruthy();
  });

  it("does not show completed tasks", () => {
    const tasks = [
      makeTask({
        id: "t1",
        title: "Done task",
        status: "completed",
        dueDate: futureDate(1),
      }),
    ];
    render(<Upcoming {...defaultProps} tasks={tasks} />);
    expect(screen.queryByText("Done task")).toBeNull();
  });
});
