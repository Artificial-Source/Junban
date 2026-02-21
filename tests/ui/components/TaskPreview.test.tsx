import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskPreview } from "../../../src/ui/components/TaskPreview.js";
import type { Task } from "../../../src/core/types.js";

vi.mock("lucide-react", () => ({
  Calendar: (props: any) => <svg data-testid="calendar-icon" {...props} />,
  Flag: (props: any) => <svg data-testid="flag-icon" {...props} />,
  Repeat: (props: any) => <svg data-testid="repeat-icon" {...props} />,
  Tag: (props: any) => <svg data-testid="tag-icon" {...props} />,
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Test task",
    status: "pending",
    priority: null,
    dueDate: null,
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
    remindAt: null,
    ...overrides,
  } as Task;
}

const mockRect = {
  left: 100,
  top: 200,
  bottom: 240,
  right: 300,
  width: 200,
  height: 40,
  x: 100,
  y: 200,
  toJSON: () => {},
} as DOMRect;

describe("TaskPreview", () => {
  it("renders task title", () => {
    render(
      <TaskPreview
        task={makeTask({ title: "Buy groceries" })}
        anchorRect={mockRect}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Buy groceries")).toBeDefined();
  });

  it("renders description when present", () => {
    render(
      <TaskPreview
        task={makeTask({ description: "Get milk and eggs" })}
        anchorRect={mockRect}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Get milk and eggs")).toBeDefined();
  });

  it("renders priority badge", () => {
    render(
      <TaskPreview task={makeTask({ priority: 1 })} anchorRect={mockRect} onClose={vi.fn()} />,
    );
    expect(screen.getByText("P1")).toBeDefined();
  });

  it("renders due date", () => {
    render(
      <TaskPreview
        task={makeTask({ dueDate: "2026-03-15T00:00:00Z" })}
        anchorRect={mockRect}
        onClose={vi.fn()}
      />,
    );
    // Date should be rendered
    const dateEl = screen.getByTestId("calendar-icon");
    expect(dateEl).toBeDefined();
  });

  it("has role=tooltip", () => {
    render(<TaskPreview task={makeTask()} anchorRect={mockRect} onClose={vi.fn()} />);
    expect(screen.getByRole("tooltip")).toBeDefined();
  });

  it("calls onClose on outside click", () => {
    const onClose = vi.fn();
    render(<TaskPreview task={makeTask()} anchorRect={mockRect} onClose={onClose} />);
    fireEvent.mouseDown(document);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
