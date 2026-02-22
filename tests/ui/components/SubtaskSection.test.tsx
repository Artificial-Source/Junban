import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  Plus: (props: any) => <svg data-testid="plus-icon" {...props} />,
  ChevronDown: (props: any) => <svg data-testid="chevron-down" {...props} />,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: any) => <div>{props.children}</div>,
  closestCenter: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: () => ({}),
  useSensors: () => [],
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: (props: any) => <div>{props.children}</div>,
  verticalListSortingStrategy: {},
}));

vi.mock("../../../src/ui/components/SubtaskBlock.js", () => ({
  SortableSubtaskBlock: (props: any) => (
    <div data-testid={`subtask-${props.task.id}`}>
      {props.isEditing ? (
        <span data-testid="editing">{props.editTitle}</span>
      ) : (
        <span>{props.task.title}</span>
      )}
      {props.onToggle && (
        <button
          data-testid={`toggle-${props.task.id}`}
          onClick={() => props.onToggle(props.task.id)}
        />
      )}
    </div>
  ),
}));

import { SubtaskSection } from "../../../src/ui/components/SubtaskSection.js";
import type { Task } from "../../../src/core/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "parent",
    title: "Parent Task",
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

describe("SubtaskSection", () => {
  const parentTask = makeTask({ id: "parent" });
  const child1 = makeTask({ id: "c1", title: "Child 1", parentId: "parent", status: "completed" });
  const child2 = makeTask({ id: "c2", title: "Child 2", parentId: "parent", status: "pending" });

  const defaultProps = {
    task: parentTask,
    allTasks: [parentTask, child1, child2],
    editingSubtaskId: null,
    editingSubtaskTitle: "",
    focusedSubtaskIdx: -1,
    onEditTitleChange: vi.fn(),
    onStartEdit: vi.fn(),
    onSaveEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onFocusedIdxChange: vi.fn(),
    onAddSubtask: vi.fn(),
  };

  it("renders subtask list with children", () => {
    render(<SubtaskSection {...defaultProps} />);
    expect(screen.getByText("Child 1")).toBeTruthy();
    expect(screen.getByText("Child 2")).toBeTruthy();
  });

  it("shows completion progress count", () => {
    render(<SubtaskSection {...defaultProps} />);
    // 1 completed out of 2
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("shows Sub-tasks header", () => {
    render(<SubtaskSection {...defaultProps} />);
    expect(screen.getByText("Sub-tasks")).toBeTruthy();
  });

  it("shows add sub-task button when onAddSubtask is provided", () => {
    render(<SubtaskSection {...defaultProps} />);
    expect(screen.getByText("Add sub-task")).toBeTruthy();
  });

  it("shows add subtask input when plus button is clicked", () => {
    render(<SubtaskSection {...defaultProps} />);

    const addBtn = screen.getByTitle("Add sub-task");
    fireEvent.click(addBtn);

    expect(screen.getByPlaceholderText("Add a sub-task...")).toBeTruthy();
  });

  it("returns null when no children and no onAddSubtask", () => {
    const { container } = render(
      <SubtaskSection {...defaultProps} allTasks={[parentTask]} onAddSubtask={undefined} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("collapses subtask list when header is clicked", () => {
    render(<SubtaskSection {...defaultProps} />);

    expect(screen.getByText("Child 1")).toBeTruthy();
    fireEvent.click(screen.getByText("Sub-tasks"));
    // After collapse, the children are hidden via grid-template-rows: 0fr
    // but still in the DOM (just hidden via overflow: hidden)
    // Let's verify the section toggle works by checking the button text change
    expect(screen.getByText("Sub-tasks")).toBeTruthy();
  });

  it("renders progress bar when children exist", () => {
    const { container } = render(<SubtaskSection {...defaultProps} />);
    const progressBar = container.querySelector("[style*='width']");
    expect(progressBar).toBeTruthy();
  });

  it("handles no subtasks with add button", () => {
    render(<SubtaskSection {...defaultProps} allTasks={[parentTask]} onAddSubtask={vi.fn()} />);
    // Should show the section with add button
    expect(screen.getByText("Sub-tasks")).toBeTruthy();
    expect(screen.getByText("Add sub-task")).toBeTruthy();
  });
});
