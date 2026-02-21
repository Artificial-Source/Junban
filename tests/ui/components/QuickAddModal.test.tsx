import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuickAddModal } from "../../../src/ui/components/QuickAddModal.js";

// Mock TaskInput since it has complex deps
vi.mock("../../../src/ui/components/TaskInput.js", () => ({
  TaskInput: ({
    onSubmit,
    placeholder,
  }: {
    onSubmit: (v: unknown) => void;
    placeholder?: string;
  }) => (
    <input
      data-testid="task-input"
      placeholder={placeholder}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          onSubmit({
            title: (e.target as HTMLInputElement).value,
            priority: null,
            tags: [],
            projectId: null,
            dueDate: null,
            recurrence: null,
          });
        }
      }}
    />
  ),
}));

describe("QuickAddModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <QuickAddModal open={false} onClose={vi.fn()} onCreateTask={vi.fn()} />,
    );
    expect(container.firstElementChild).toBeNull();
  });

  it("renders when open", () => {
    render(<QuickAddModal open={true} onClose={vi.fn()} onCreateTask={vi.fn()} />);
    expect(screen.getByText("Quick Add")).toBeDefined();
    expect(screen.getByTestId("task-input")).toBeDefined();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<QuickAddModal open={true} onClose={onClose} onCreateTask={vi.fn()} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(<QuickAddModal open={true} onClose={onClose} onCreateTask={vi.fn()} />);
    const closeBtn = screen.getByLabelText("Close");
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <QuickAddModal open={true} onClose={onClose} onCreateTask={vi.fn()} />,
    );
    // Click the backdrop overlay (root div)
    const overlay = container.firstElementChild!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onCreateTask and onClose on submit", () => {
    const onClose = vi.fn();
    const onCreateTask = vi.fn();
    render(<QuickAddModal open={true} onClose={onClose} onCreateTask={onCreateTask} />);
    const input = screen.getByTestId("task-input");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
