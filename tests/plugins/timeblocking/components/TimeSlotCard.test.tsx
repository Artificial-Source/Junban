import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { TimeSlotCard } from "../../../../src/plugins/builtin/timeblocking/components/TimeSlotCard.js";
import type { TimeSlot } from "../../../../src/plugins/builtin/timeblocking/types.js";
import type { Task } from "../../../../src/core/types.js";

function makeSlot(overrides: Partial<TimeSlot> = {}): TimeSlot {
  return {
    id: "slot-1",
    title: "Focus Block",
    date: "2026-03-09",
    startTime: "09:00",
    endTime: "11:00",
    taskIds: [],
    locked: false,
    createdAt: "2026-03-09T00:00:00Z",
    updatedAt: "2026-03-09T00:00:00Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Test Task",
    status: "pending",
    priority: 4,
    createdAt: "2026-03-09T00:00:00Z",
    updatedAt: "2026-03-09T00:00:00Z",
    ...overrides,
  } as Task;
}

function renderSlotCard(
  slotOverrides: Partial<TimeSlot> = {},
  tasks: Task[] = [],
  overrides: Record<string, unknown> = {},
) {
  const slot = makeSlot(slotOverrides);
  const defaults = {
    slot,
    tasks,
    projects: [],
    pixelsPerHour: 80,
    workDayStart: "09:00",
    isConflicting: false,
    onSlotClick: vi.fn(),
    onTaskClick: vi.fn(),
    onTaskToggle: vi.fn(),
    onResizeStart: vi.fn(),
    ...overrides,
  };

  return render(
    <DndContext>
      <TimeSlotCard {...(defaults as React.ComponentProps<typeof TimeSlotCard>)} />
    </DndContext>,
  );
}

describe("TimeSlotCard", () => {
  it("renders slot title and time range", () => {
    renderSlotCard({ title: "Deep Work", startTime: "10:00", endTime: "12:00" });
    expect(screen.getByText("Deep Work")).toBeInTheDocument();
    expect(screen.getByText("10:00 – 12:00")).toBeInTheDocument();
  });

  it("shows task list inside slot", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Write docs" }),
      makeTask({ id: "t2", title: "Review PR" }),
    ];
    renderSlotCard({ taskIds: ["t1", "t2"] }, tasks);
    expect(screen.getByText("Write docs")).toBeInTheDocument();
    expect(screen.getByText("Review PR")).toBeInTheDocument();
  });

  it("shows task countdown badge with completed/total", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Done task", status: "completed" }),
      makeTask({ id: "t2", title: "Pending task", status: "pending" }),
      makeTask({ id: "t3", title: "Another pending", status: "pending" }),
    ];
    renderSlotCard({ id: "s1", taskIds: ["t1", "t2", "t3"] }, tasks);
    expect(screen.getByTestId("slot-progress-badge-s1")).toHaveTextContent("1/3");
  });

  it("shows progress bar at correct percentage", () => {
    const tasks = [
      makeTask({ id: "t1", status: "completed" }),
      makeTask({ id: "t2", status: "completed" }),
      makeTask({ id: "t3", status: "pending" }),
      makeTask({ id: "t4", status: "pending" }),
    ];
    const { container } = renderSlotCard({ id: "s1", taskIds: ["t1", "t2", "t3", "t4"] }, tasks);
    const progressBar = container.querySelector("[data-testid='slot-progress-bar-s1'] > div");
    expect(progressBar).toHaveStyle({ width: "50%" });
  });

  it("does not show progress bar when slot has no tasks", () => {
    renderSlotCard({ id: "s1", taskIds: [] });
    expect(screen.queryByTestId("slot-progress-bar-s1")).not.toBeInTheDocument();
  });

  it("shows expand/collapse for many tasks", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Task 1" }),
      makeTask({ id: "t2", title: "Task 2" }),
      makeTask({ id: "t3", title: "Task 3" }),
      makeTask({ id: "t4", title: "Task 4" }),
      makeTask({ id: "t5", title: "Task 5" }),
    ];
    renderSlotCard({ taskIds: ["t1", "t2", "t3", "t4", "t5"] }, tasks);

    // First 3 visible, 2 hidden
    expect(screen.getByText("Task 1")).toBeInTheDocument();
    expect(screen.getByText("Task 2")).toBeInTheDocument();
    expect(screen.getByText("Task 3")).toBeInTheDocument();
    expect(screen.queryByText("Task 4")).not.toBeInTheDocument();
    expect(screen.getByText("+2 more")).toBeInTheDocument();

    // Expand
    fireEvent.click(screen.getByText("+2 more"));
    expect(screen.getByText("Task 4")).toBeInTheDocument();
    expect(screen.getByText("Task 5")).toBeInTheDocument();
    expect(screen.getByText("Show less")).toBeInTheDocument();

    // Collapse
    fireEvent.click(screen.getByText("Show less"));
    expect(screen.queryByText("Task 4")).not.toBeInTheDocument();
  });

  it("does not show expand button for 3 or fewer tasks", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Task 1" }),
      makeTask({ id: "t2", title: "Task 2" }),
    ];
    renderSlotCard({ taskIds: ["t1", "t2"] }, tasks);
    expect(screen.queryByText(/more/)).not.toBeInTheDocument();
  });

  it("calls onSlotClick when clicked", () => {
    const onSlotClick = vi.fn();
    renderSlotCard({ id: "s1" }, [], { onSlotClick });
    fireEvent.click(screen.getByTestId("time-slot-s1"));
    expect(onSlotClick).toHaveBeenCalledWith("s1");
  });

  it("calls onTaskToggle when task checkbox clicked", () => {
    const onTaskToggle = vi.fn();
    const tasks = [makeTask({ id: "t1", title: "My Task", status: "pending" })];
    const { container } = renderSlotCard({ taskIds: ["t1"] }, tasks, { onTaskToggle });
    // Click the checkbox button (circle)
    const checkbox = container.querySelector("button.rounded-full");
    if (checkbox) fireEvent.click(checkbox);
    expect(onTaskToggle).toHaveBeenCalledWith("t1");
  });

  it("shows completed task with strikethrough", () => {
    const tasks = [makeTask({ id: "t1", title: "Done Task", status: "completed" })];
    renderSlotCard({ taskIds: ["t1"] }, tasks);
    const taskEl = screen.getByText("Done Task");
    expect(taskEl.className).toContain("line-through");
  });
});
