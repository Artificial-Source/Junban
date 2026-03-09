import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { TaskSidebar } from "../../../../src/plugins/builtin/timeblocking/components/TaskSidebar.js";
import type { Task } from "../../../../src/core/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Write report",
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
    tags: [],
    sortOrder: 0,
    createdAt: "2026-03-09T00:00:00Z",
    updatedAt: "2026-03-09T00:00:00Z",
    ...overrides,
  };
}

function renderSidebar(
  tasks: Task[] = [],
  scheduledTaskIds: Set<string> = new Set(),
) {
  return render(
    <DndContext>
      <TaskSidebar tasks={tasks} scheduledTaskIds={scheduledTaskIds} />
    </DndContext>,
  );
}

describe("TaskSidebar", () => {
  it("renders pending tasks", () => {
    renderSidebar([makeTask({ title: "Write report" })]);
    expect(screen.getByText("Write report")).toBeInTheDocument();
  });

  it("filters out completed tasks", () => {
    renderSidebar([
      makeTask({ id: "t1", title: "Done task", status: "completed" }),
      makeTask({ id: "t2", title: "Pending task", status: "pending" }),
    ]);
    expect(screen.queryByText("Done task")).not.toBeInTheDocument();
    expect(screen.getByText("Pending task")).toBeInTheDocument();
  });

  it("shows 'scheduled' badge for scheduled tasks", () => {
    renderSidebar(
      [makeTask({ id: "t1", title: "Scheduled task" })],
      new Set(["t1"]),
    );
    expect(screen.getByText("scheduled")).toBeInTheDocument();
  });

  it("shows empty state when no pending tasks", () => {
    renderSidebar([]);
    expect(screen.getByText("No pending tasks")).toBeInTheDocument();
  });

  it("shows estimated minutes when available", () => {
    renderSidebar([makeTask({ estimatedMinutes: 45 })]);
    expect(screen.getByText("45m")).toBeInTheDocument();
  });

  it("shows due date when available", () => {
    renderSidebar([makeTask({ dueDate: "2026-03-15" })]);
    expect(screen.getByText("Mar 15")).toBeInTheDocument();
  });

  it("shows header text", () => {
    renderSidebar();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.getByText("Drag to schedule")).toBeInTheDocument();
  });
});
