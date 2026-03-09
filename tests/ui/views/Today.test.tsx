import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock lucide-react
vi.mock("lucide-react", () => ({
  CheckCircle2: (props: any) => <svg data-testid="check-circle-icon" {...props} />,
  AlertTriangle: (props: any) => <svg data-testid="alert-icon" {...props} />,
  ChevronDown: (props: any) => <svg data-testid="chevron-down" {...props} />,
  ChevronRight: (props: any) => <svg data-testid="chevron-right" {...props} />,
  Calendar: (props: any) => <svg data-testid="calendar-icon" {...props} />,
  Dices: (props: any) => <svg data-testid="dices-icon" {...props} />,
  X: (props: any) => <svg data-testid="x-icon" {...props} />,
}));

vi.mock("../../../src/ui/components/TaskJar.js", () => ({
  TaskJar: () => <div data-testid="task-jar" />,
}));

vi.mock("../../../src/ui/context/SettingsContext.js", () => ({
  useGeneralSettings: () => ({
    settings: { daily_capacity_minutes: "480" },
    loaded: true,
    updateSetting: vi.fn(),
  }),
}));

// Mock child components to isolate Today view tests
vi.mock("../../../src/ui/components/TaskInput.js", () => ({
  TaskInput: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="task-input" data-placeholder={placeholder} />
  ),
}));

vi.mock("../../../src/ui/components/TaskList.js", () => ({
  TaskList: ({ tasks, emptyMessage }: { tasks: any[]; emptyMessage?: string }) => (
    <div data-testid="task-list" data-count={tasks.length}>
      {tasks.length === 0 && emptyMessage && <span>{emptyMessage}</span>}
      {tasks.map((t: any) => (
        <span key={t.id}>{t.title}</span>
      ))}
    </div>
  ),
}));

vi.mock("../../../src/ui/components/CompletionRing.js", () => ({
  CompletionRing: ({ completed, total }: { completed: number; total: number }) => (
    <div data-testid="completion-ring" data-completed={completed} data-total={total} />
  ),
}));

vi.mock("../../../src/ui/components/DailyPlanningModal.js", () => ({
  DailyPlanningModal: () => null,
}));

vi.mock("../../../src/ui/components/DailyReviewModal.js", () => ({
  DailyReviewModal: () => null,
}));

vi.mock("../../../src/utils/format-date.js", () => ({
  toDateKey: (d: Date) => d.toISOString().split("T")[0],
}));

import { Today } from "../../../src/ui/views/Today.js";
import type { Task } from "../../../src/core/types.js";

const today = new Date().toISOString().split("T")[0];
const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Test task",
    status: "pending",
    priority: null,
    dueDate: `${today}T10:00:00.000Z`,
    dueTime: false,
    projectId: null,
    parentId: null,
    tags: [],
    sortOrder: 0,
    recurrence: null,
    description: null,
    completedAt: null,
    createdAt: "2026-02-16T10:00:00.000Z",
    updatedAt: "2026-02-16T10:00:00.000Z",
    ...overrides,
  } as Task;
}

const defaultProps = {
  tasks: [] as Task[],
  projects: [],
  onCreateTask: vi.fn(),
  onToggleTask: vi.fn(),
  onSelectTask: vi.fn(),
  onUpdateTask: vi.fn(),
  selectedTaskId: null,
};

describe("Today", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders 'Today' heading", () => {
    render(<Today {...defaultProps} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Today");
  });

  it("shows task count in header", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Task 1" }),
      makeTask({ id: "t2", title: "Task 2" }),
    ];
    render(<Today {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("2 tasks")).toBeTruthy();
  });

  it("shows singular 'task' for 1 task", () => {
    const tasks = [makeTask({ id: "t1", title: "Task 1" })];
    render(<Today {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("1 task")).toBeTruthy();
  });

  it("shows overdue section when overdue tasks exist", () => {
    const tasks = [
      makeTask({ id: "t-overdue", title: "Overdue task", dueDate: `${yesterday}T10:00:00.000Z` }),
    ];
    render(<Today {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("Overdue")).toBeTruthy();
  });

  it("hides overdue section when no overdue tasks", () => {
    const tasks = [makeTask({ id: "t1", title: "Today task" })];
    render(<Today {...defaultProps} tasks={tasks} />);
    expect(screen.queryByText("Overdue")).toBeNull();
  });

  it("shows today section header with formatted date", () => {
    render(<Today {...defaultProps} />);
    const header = screen.getByRole("heading", { level: 2 });
    expect(header.textContent).toContain("Today");
    expect(header.textContent).toContain("·");
  });

  it("renders TaskInput", () => {
    render(<Today {...defaultProps} />);
    expect(screen.getByTestId("task-input")).toBeTruthy();
  });

  it("renders TaskList for today's tasks", () => {
    const tasks = [makeTask({ id: "t1", title: "Buy milk" })];
    render(<Today {...defaultProps} tasks={tasks} />);
    expect(screen.getByTestId("task-list")).toBeTruthy();
    expect(screen.getByText("Buy milk")).toBeTruthy();
  });

  it("shows CompletionRing when there are tasks", () => {
    const tasks = [makeTask({ id: "t1", title: "Task 1" })];
    render(<Today {...defaultProps} tasks={tasks} />);
    expect(screen.getByTestId("completion-ring")).toBeTruthy();
  });

  it("hides CompletionRing when no tasks at all", () => {
    render(<Today {...defaultProps} />);
    expect(screen.queryByTestId("completion-ring")).toBeNull();
  });

  it("shows encouraging empty message when no tasks and no overdue", () => {
    render(<Today {...defaultProps} tasks={[]} />);
    expect(screen.getByText("No tasks for today. Add one above to get started!")).toBeTruthy();
  });

  it("shows shorter empty message when overdue exist but no today tasks", () => {
    const tasks = [
      makeTask({ id: "t-overdue", title: "Old task", dueDate: `${yesterday}T10:00:00.000Z` }),
    ];
    render(<Today {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("Nothing else due today.")).toBeTruthy();
  });

  // ── V2-13: Workload capacity indicator ──

  it("shows workload capacity bar when tasks have estimated minutes", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Task 1", estimatedMinutes: 60 }),
      makeTask({ id: "t2", title: "Task 2", estimatedMinutes: 90 }),
    ];
    render(<Today {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("2h 30m / 8h planned")).toBeTruthy();
  });

  it("hides workload capacity bar when no estimated minutes", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Task 1" }),
    ];
    render(<Today {...defaultProps} tasks={tasks} />);
    expect(screen.queryByText(/planned/)).toBeNull();
  });

  it("shows over-capacity warning when planned exceeds capacity", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Task 1", estimatedMinutes: 300 }),
      makeTask({ id: "t2", title: "Task 2", estimatedMinutes: 240 }),
    ];
    render(<Today {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("+1h over")).toBeTruthy();
  });

  it("includes overdue tasks in capacity calculation", () => {
    const tasks = [
      makeTask({ id: "t-overdue", title: "Overdue", dueDate: `${yesterday}T10:00:00.000Z`, estimatedMinutes: 120 }),
      makeTask({ id: "t-today", title: "Today", estimatedMinutes: 60 }),
    ];
    render(<Today {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("3h / 8h planned")).toBeTruthy();
  });
});
