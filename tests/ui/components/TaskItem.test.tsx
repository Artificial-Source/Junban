import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  Calendar: (props: any) => <svg data-testid="calendar-icon" {...props} />,
  Check: (props: any) => <svg data-testid="check-icon" {...props} />,
  ChevronDown: (props: any) => <svg data-testid="chevron-down" {...props} />,
  ChevronRight: (props: any) => <svg data-testid="chevron-right" {...props} />,
  GripVertical: (props: any) => <svg data-testid="grip-icon" {...props} />,
  Pencil: (props: any) => <svg data-testid="pencil-icon" {...props} />,
  Repeat: (props: any) => <svg data-testid="repeat-icon" {...props} />,
  Bell: (props: any) => <svg data-testid="bell-icon" {...props} />,
}));

vi.mock("../../../src/core/priorities.js", () => ({
  getPriority: (value: number) => {
    const map: Record<number, any> = {
      1: { value: 1, label: "Priority 1", color: "#ff0000" },
      2: { value: 2, label: "Priority 2", color: "#ff8800" },
      3: { value: 3, label: "Priority 3", color: "#0088ff" },
      4: { value: 4, label: "Priority 4", color: "#888888" },
    };
    return map[value] ?? null;
  },
}));

vi.mock("../../../src/ui/components/DatePicker.js", () => ({
  DatePicker: (_props: any) => <div data-testid="date-picker" />,
}));

vi.mock("../../../src/ui/components/RecurrencePicker.js", () => ({
  formatRecurrenceLabel: (r: string) => r,
}));

vi.mock("../../../src/utils/color.js", () => ({
  hexToRgba: (hex: string, alpha: number) => `rgba(0,0,0,${alpha})`,
}));

import { TaskItem } from "../../../src/ui/components/TaskItem.js";
import type { Task } from "../../../src/core/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "My Task",
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

describe("TaskItem", () => {
  const defaultProps = {
    task: makeTask(),
    onToggle: vi.fn(),
    onSelect: vi.fn(),
    isSelected: false,
  };

  it("renders the task title", () => {
    render(<TaskItem {...defaultProps} />);
    expect(screen.getByText("My Task")).toBeTruthy();
  });

  it("calls onToggle when checkbox button is clicked", () => {
    const onToggle = vi.fn();
    render(<TaskItem {...defaultProps} onToggle={onToggle} />);

    const btn = screen.getByLabelText("Complete task");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledWith("t1");
  });

  it("calls onSelect when task row is clicked", () => {
    const onSelect = vi.fn();
    render(<TaskItem {...defaultProps} onSelect={onSelect} />);

    fireEvent.click(screen.getByText("My Task"));
    expect(onSelect).toHaveBeenCalledWith("t1");
  });

  it("shows check mark for completed tasks", () => {
    const task = makeTask({ status: "completed" });
    render(<TaskItem {...defaultProps} task={task} />);
    expect(screen.getByLabelText("Mark task incomplete")).toBeTruthy();
  });

  it("applies line-through for completed tasks", () => {
    const task = makeTask({ status: "completed" });
    render(<TaskItem {...defaultProps} task={task} />);
    const title = screen.getByText("My Task");
    expect(title.className).toContain("line-through");
  });

  it("shows priority label in aria for priority tasks", () => {
    const task = makeTask({ priority: 1 });
    render(<TaskItem {...defaultProps} task={task} />);
    expect(screen.getByLabelText("Complete task (Priority 1)")).toBeTruthy();
  });

  it("shows due date when present", () => {
    const task = makeTask({ dueDate: "2026-03-01T00:00:00.000Z" });
    render(<TaskItem {...defaultProps} task={task} />);
    // The date is formatted by toLocaleDateString and displayed in the metadata line
    const dateEls = screen.getAllByTestId("calendar-icon");
    expect(dateEls.length).toBeGreaterThanOrEqual(1);
  });

  it("shows overdue styling for past due dates", () => {
    const task = makeTask({ dueDate: "2020-01-01T00:00:00.000Z" });
    const { container } = render(<TaskItem {...defaultProps} task={task} />);
    const overdueEl = container.querySelector(".text-error");
    expect(overdueEl).toBeTruthy();
  });

  it("renders tags", () => {
    const task = makeTask({
      tags: [
        { id: "tag-1", name: "work", color: "#ff0000" },
        { id: "tag-2", name: "urgent", color: "" },
      ],
    });
    render(<TaskItem {...defaultProps} task={task} />);
    expect(screen.getByText("work")).toBeTruthy();
    expect(screen.getByText("urgent")).toBeTruthy();
  });

  it("handles multi-select on ctrl+click", () => {
    const onMultiSelect = vi.fn();
    render(<TaskItem {...defaultProps} onMultiSelect={onMultiSelect} />);

    const row = screen.getByRole("button", { name: /Task: My Task/ });
    fireEvent.click(row, { ctrlKey: true });
    expect(onMultiSelect).toHaveBeenCalledWith("t1", expect.objectContaining({ ctrlKey: true }));
  });

  it("fires context menu handler", () => {
    const onContextMenu = vi.fn();
    render(<TaskItem {...defaultProps} onContextMenu={onContextMenu} />);

    const row = screen.getByRole("button", { name: /Task: My Task/ });
    fireEvent.contextMenu(row);
    expect(onContextMenu).toHaveBeenCalledWith("t1", expect.any(Object));
  });

  it("shows recurrence label when task has recurrence", () => {
    const task = makeTask({ recurrence: "daily" });
    render(<TaskItem {...defaultProps} task={task} />);
    expect(screen.getByText("daily")).toBeTruthy();
  });

  it("opens date picker when date button is clicked", () => {
    render(<TaskItem {...defaultProps} />);
    const dateBtn = screen.getByLabelText("Set due date");
    fireEvent.click(dateBtn);
    expect(screen.getByTestId("date-picker")).toBeTruthy();
  });
});
