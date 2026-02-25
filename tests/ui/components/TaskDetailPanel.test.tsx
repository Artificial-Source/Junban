import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const icon = (name: string) => (props: any) => <svg data-testid={`${name}-icon`} {...props} />;
  return {
    X: icon("x"),
    Trash2: icon("trash"),
    ArrowRight: icon("arrow-right"),
    ArrowLeft: icon("arrow-left"),
    ChevronDown: icon("chevron-down"),
    ChevronUp: icon("chevron-up"),
    MoreHorizontal: icon("more"),
    Maximize2: icon("maximize"),
    Inbox: icon("inbox"),
    MessageSquare: icon("message-square"),
    History: icon("history"),
    PlusCircle: icon("plus-circle"),
    CheckCircle2: icon("check-circle"),
    Pencil: icon("pencil"),
    Send: icon("send"),
  };
});

vi.mock("../../../src/ui/components/chat/MarkdownMessage.js", () => ({
  MarkdownMessage: ({ content }: { content: string }) => <div data-testid="markdown-preview">{content}</div>,
}));

vi.mock("../../../src/ui/context/SettingsContext.js", () => ({
  useGeneralSettings: () => ({
    settings: { confirm_delete: "false" },
    loaded: true,
    updateSetting: vi.fn(),
  }),
}));

vi.mock("../../../src/ui/components/SubtaskSection.js", () => ({
  SubtaskSection: () => <div data-testid="subtask-section" />,
}));

vi.mock("../../../src/ui/components/TaskMetadataSidebar.js", () => ({
  TaskMetadataSidebar: () => <div data-testid="metadata-sidebar" />,
}));

vi.mock("../../../src/ui/components/ConfirmDialog.js", () => ({
  ConfirmDialog: (props: any) =>
    props.open ? (
      <div data-testid="confirm-dialog">
        <button onClick={props.onConfirm}>Confirm</button>
      </div>
    ) : null,
}));

import { TaskDetailPanel } from "../../../src/ui/components/TaskDetailPanel.js";
import type { Task } from "../../../src/core/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Detail Task",
    description: "Some notes",
    status: "pending",
    priority: 2,
    dueDate: "2026-03-01T00:00:00.000Z",
    dueTime: false,
    completedAt: null,
    projectId: null,
    recurrence: null,
    parentId: null,
    remindAt: null,
    tags: [{ id: "tag-1", name: "work", color: "#ff0000" }],
    sortOrder: 0,
    createdAt: "2026-02-20T10:00:00.000Z",
    updatedAt: "2026-02-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("TaskDetailPanel", () => {
  const defaultProps = {
    task: makeTask(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  };

  it("renders as a dialog", () => {
    render(<TaskDetailPanel {...defaultProps} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("displays task title in editable input", () => {
    render(<TaskDetailPanel {...defaultProps} />);
    expect(screen.getByDisplayValue("Detail Task")).toBeTruthy();
  });

  it("displays description as markdown preview", () => {
    render(<TaskDetailPanel {...defaultProps} />);
    expect(screen.getByTestId("markdown-preview")).toBeTruthy();
    expect(screen.getByText("Some notes")).toBeTruthy();
  });

  it("calls onUpdate when title is changed and blurred", () => {
    const onUpdate = vi.fn();
    render(<TaskDetailPanel {...defaultProps} onUpdate={onUpdate} />);

    const input = screen.getByDisplayValue("Detail Task");
    fireEvent.change(input, { target: { value: "New Title" } });
    fireEvent.blur(input);

    expect(onUpdate).toHaveBeenCalledWith("t1", { title: "New Title" });
  });

  it("enters edit mode on click and calls onUpdate when description is changed and blurred", () => {
    const onUpdate = vi.fn();
    render(<TaskDetailPanel {...defaultProps} onUpdate={onUpdate} />);

    // Click the markdown preview to enter edit mode
    fireEvent.click(screen.getByTestId("markdown-preview"));

    const textarea = screen.getByDisplayValue("Some notes");
    fireEvent.change(textarea, { target: { value: "Updated notes" } });
    fireEvent.blur(textarea);

    expect(onUpdate).toHaveBeenCalledWith("t1", { description: "Updated notes" });
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(<TaskDetailPanel {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByLabelText("Close task details"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when clicking the backdrop", () => {
    const onClose = vi.fn();
    render(<TaskDetailPanel {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows project name in breadcrumb", () => {
    render(<TaskDetailPanel {...defaultProps} projectName="Work" />);
    expect(screen.getByText("Work")).toBeTruthy();
  });

  it("shows Inbox in breadcrumb by default", () => {
    render(<TaskDetailPanel {...defaultProps} />);
    expect(screen.getByText("Inbox")).toBeTruthy();
  });

  it("shows more menu with delete option", () => {
    render(<TaskDetailPanel {...defaultProps} />);

    // Click more options button
    fireEvent.click(screen.getByTitle("More options"));
    expect(screen.getByText("Delete task")).toBeTruthy();
  });

  it("calls onDelete from more menu", () => {
    const onDelete = vi.fn();
    render(<TaskDetailPanel {...defaultProps} onDelete={onDelete} />);

    fireEvent.click(screen.getByTitle("More options"));
    fireEvent.click(screen.getByText("Delete task"));
    expect(onDelete).toHaveBeenCalledWith("t1");
  });

  it("renders SubtaskSection and MetadataSidebar", () => {
    render(<TaskDetailPanel {...defaultProps} />);
    expect(screen.getByTestId("subtask-section")).toBeTruthy();
    expect(screen.getByTestId("metadata-sidebar")).toBeTruthy();
  });

  it("shows prev/next navigation buttons", () => {
    render(
      <TaskDetailPanel
        {...defaultProps}
        onNavigatePrev={vi.fn()}
        onNavigateNext={vi.fn()}
        hasPrev={true}
        hasNext={true}
      />,
    );
    expect(screen.getByTitle("Previous task")).toBeTruthy();
    expect(screen.getByTitle("Next task")).toBeTruthy();
  });

  it("disables prev button when hasPrev is false", () => {
    render(
      <TaskDetailPanel
        {...defaultProps}
        onNavigatePrev={vi.fn()}
        onNavigateNext={vi.fn()}
        hasPrev={false}
        hasNext={true}
      />,
    );
    const prevBtn = screen.getByTitle("Previous task");
    expect(prevBtn.hasAttribute("disabled")).toBe(true);
  });

  it("calls onOpenFullPage when open full page button is clicked", () => {
    const onOpenFullPage = vi.fn();
    const onClose = vi.fn();
    render(<TaskDetailPanel {...defaultProps} onOpenFullPage={onOpenFullPage} onClose={onClose} />);

    fireEvent.click(screen.getByLabelText("Open full page"));
    expect(onOpenFullPage).toHaveBeenCalledWith("t1");
    expect(onClose).toHaveBeenCalled();
  });
});
