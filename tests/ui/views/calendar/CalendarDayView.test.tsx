import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  Circle: (props: any) => <svg data-testid="circle-icon" {...props} />,
  CheckCircle2: (props: any) => <svg data-testid="check-circle" {...props} />,
  CalendarOff: (props: any) => <svg data-testid="calendar-off" {...props} />,
}));

vi.mock("../../../../src/utils/format-date.js", () => ({
  toDateKey: (date: Date) => date.toISOString().split("T")[0],
  formatTaskTime: (_isoDate: string) => "10:00 AM",
}));

vi.mock("../../../../src/ui/context/SettingsContext.js", () => ({
  useGeneralSettings: () => ({
    settings: { time_format: "12h" },
  }),
}));

vi.mock("../../../../src/ui/components/EmptyState.js", () => ({
  EmptyState: ({ title }: any) => <div data-testid="empty-state">{title}</div>,
}));

import { CalendarDayView } from "../../../../src/ui/views/calendar/CalendarDayView.js";
import type { Task, Project } from "../../../../src/core/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Test Task",
    description: null,
    status: "pending",
    priority: null,
    dueDate: "2026-02-21T00:00:00.000Z",
    dueTime: false,
    completedAt: null,
    projectId: null,
    recurrence: null,
    parentId: null,
    remindAt: null,
    tags: [],
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("CalendarDayView", () => {
  const defaultProps = {
    selectedDate: new Date("2026-02-21"),
    tasks: [makeTask()],
    projects: [] as Project[],
    onSelectTask: vi.fn(),
    onToggleTask: vi.fn(),
  };

  it("renders task for the selected day", () => {
    render(<CalendarDayView {...defaultProps} />);
    expect(screen.getByText("Test Task")).toBeDefined();
  });

  it("shows all-day section for tasks without time", () => {
    render(<CalendarDayView {...defaultProps} />);
    expect(screen.getByText("All Day")).toBeDefined();
  });

  it("shows scheduled section for timed tasks", () => {
    const timedTask = makeTask({
      id: "t2",
      title: "Timed Task",
      dueDate: "2026-02-21T10:00:00.000Z",
      dueTime: true,
    });
    render(<CalendarDayView {...defaultProps} tasks={[...defaultProps.tasks, timedTask]} />);
    expect(screen.getByText("Scheduled")).toBeDefined();
    expect(screen.getByText("Timed Task")).toBeDefined();
  });

  it("shows empty state when no tasks for the day", () => {
    render(<CalendarDayView {...defaultProps} tasks={[]} />);
    expect(screen.getByText("No tasks for this day")).toBeDefined();
  });

  it("calls onSelectTask when task is clicked", () => {
    render(<CalendarDayView {...defaultProps} />);
    fireEvent.click(screen.getByText("Test Task"));
    expect(defaultProps.onSelectTask).toHaveBeenCalledWith("t1");
  });

  it("shows completed task with strikethrough styling", () => {
    const completed = makeTask({ status: "completed", title: "Done Task" });
    render(<CalendarDayView {...defaultProps} tasks={[completed]} />);
    const taskText = screen.getByText("Done Task");
    expect(taskText.className).toContain("line-through");
  });

  it("shows project name when task has a project", () => {
    const project: Project = {
      id: "p1",
      name: "Frontend",
      color: "#4073ff",
      icon: null,
      archived: false,
      parentId: null,
      isFavorite: false,
      viewStyle: "list",
      sortOrder: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    const taskWithProject = makeTask({ projectId: "p1" });
    render(<CalendarDayView {...defaultProps} tasks={[taskWithProject]} projects={[project]} />);
    expect(screen.getByText("Frontend")).toBeDefined();
  });

  it("shows priority badge for prioritized tasks", () => {
    const prioritized = makeTask({ priority: 1, title: "Urgent Task" });
    render(<CalendarDayView {...defaultProps} tasks={[prioritized]} />);
    expect(screen.getByText("P1")).toBeDefined();
  });
});
