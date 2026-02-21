import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task } from "../../../src/core/types.js";

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Calendar: (props: any) => <svg data-testid="calendar-icon" {...props} />,
  Check: (props: any) => <svg data-testid="check-icon" {...props} />,
  ChevronDown: (props: any) => <svg {...props} />,
  ChevronRight: (props: any) => <svg {...props} />,
  GripVertical: (props: any) => <svg {...props} />,
  Pencil: (props: any) => <svg {...props} />,
  Repeat: (props: any) => <svg {...props} />,
  Bell: (props: any) => <svg {...props} />,
}));

// Mock DatePicker
vi.mock("../../../src/ui/components/DatePicker.js", () => ({
  DatePicker: () => null,
}));

// Mock RecurrencePicker
vi.mock("../../../src/ui/components/RecurrencePicker.js", () => ({
  formatRecurrenceLabel: (r: string) => r,
}));

// Mock @tanstack/react-virtual — jsdom has no layout engine, so the virtualizer
// never discovers visible rows. Provide a minimal mock that renders all items.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => opts.count * opts.estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({
        index: i,
        start: i * opts.estimateSize(),
        size: opts.estimateSize(),
        key: i,
      })),
  }),
}));

// Import AFTER mocks are set up
import { VirtualizedTaskList } from "../../../src/ui/components/VirtualizedTaskList.js";

function makeTask(id: string, title: string): Task {
  return {
    id,
    title,
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
  } as Task;
}

describe("VirtualizedTaskList", () => {
  it("renders a list container", () => {
    render(
      <VirtualizedTaskList
        tasks={[makeTask("1", "Task 1")]}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        selectedTaskId={null}
      />,
    );
    expect(screen.getByRole("list")).toBeDefined();
  });

  it("renders task items", () => {
    const tasks = [makeTask("1", "Task A"), makeTask("2", "Task B")];
    render(
      <VirtualizedTaskList
        tasks={tasks}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        selectedTaskId={null}
      />,
    );
    expect(screen.getByText("Task A")).toBeDefined();
    expect(screen.getByText("Task B")).toBeDefined();
  });

  it("has aria-label on the list", () => {
    render(
      <VirtualizedTaskList
        tasks={[makeTask("1", "Task 1")]}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        selectedTaskId={null}
      />,
    );
    const list = screen.getByRole("list");
    expect(list.getAttribute("aria-label")).toBe("Tasks");
  });
});
