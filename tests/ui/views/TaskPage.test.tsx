import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  ArrowLeft: (props: any) => <svg data-testid="arrow-left" {...props} />,
  Inbox: (props: any) => <svg data-testid="inbox-icon" {...props} />,
}));

vi.mock("../../../src/ui/context/SettingsContext.js", () => ({
  useGeneralSettings: () => ({
    settings: { confirm_delete: "false" },
    loaded: true,
    updateSetting: vi.fn(),
  }),
}));

vi.mock("../../../src/ui/components/TaskMetadataSidebar.js", () => ({
  TaskMetadataSidebar: (_props: any) => <div data-testid="metadata-sidebar" />,
}));

vi.mock("../../../src/ui/components/SubtaskSection.js", () => ({
  SubtaskSection: (_props: any) => <div data-testid="subtask-section" />,
}));

vi.mock("../../../src/ui/components/ConfirmDialog.js", () => ({
  ConfirmDialog: (props: any) =>
    props.open ? (
      <div data-testid="confirm-dialog">
        <button onClick={props.onConfirm}>Confirm</button>
        <button onClick={props.onCancel}>Cancel</button>
      </div>
    ) : null,
}));

import { TaskPage } from "../../../src/ui/views/TaskPage.js";
import type { Task } from "../../../src/core/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "My Task",
    description: "A description",
    status: "pending",
    priority: 1,
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

describe("TaskPage", () => {
  const defaultProps = {
    task: makeTask(),
    allTasks: [makeTask()],
    projects: [{ id: "p1", name: "Work" }],
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onNavigateBack: vi.fn(),
    onSelect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the task title in an editable input", () => {
    render(<TaskPage {...defaultProps} />);
    const input = screen.getByDisplayValue("My Task");
    expect(input).toBeTruthy();
    expect(input.tagName).toBe("INPUT");
  });

  it("renders the description textarea", () => {
    render(<TaskPage {...defaultProps} />);
    const textarea = screen.getByDisplayValue("A description");
    expect(textarea).toBeTruthy();
  });

  it("renders the back button", () => {
    render(<TaskPage {...defaultProps} />);
    const backBtn = screen.getByTitle("Go back");
    expect(backBtn).toBeTruthy();
  });

  it("calls onNavigateBack when back button is clicked", () => {
    render(<TaskPage {...defaultProps} />);
    fireEvent.click(screen.getByTitle("Go back"));
    expect(defaultProps.onNavigateBack).toHaveBeenCalled();
  });

  it("shows project name in breadcrumb", () => {
    const task = makeTask({ projectId: "p1" });
    render(<TaskPage {...defaultProps} task={task} />);
    expect(screen.getByText("Work")).toBeTruthy();
  });

  it("shows Inbox in breadcrumb when no project", () => {
    render(<TaskPage {...defaultProps} />);
    expect(screen.getByText("Inbox")).toBeTruthy();
  });

  it("calls onUpdate when title changes on blur", () => {
    render(<TaskPage {...defaultProps} />);
    const input = screen.getByDisplayValue("My Task");
    fireEvent.change(input, { target: { value: "Updated Title" } });
    fireEvent.blur(input);
    expect(defaultProps.onUpdate).toHaveBeenCalledWith("t1", {
      title: "Updated Title",
    });
  });

  it("does not call onUpdate when title is unchanged", () => {
    render(<TaskPage {...defaultProps} />);
    const input = screen.getByDisplayValue("My Task");
    fireEvent.blur(input);
    expect(defaultProps.onUpdate).not.toHaveBeenCalled();
  });

  it("calls onUpdate when description changes on blur", () => {
    render(<TaskPage {...defaultProps} />);
    const textarea = screen.getByDisplayValue("A description");
    fireEvent.change(textarea, { target: { value: "New description" } });
    fireEvent.blur(textarea);
    expect(defaultProps.onUpdate).toHaveBeenCalledWith("t1", {
      description: "New description",
    });
  });

  it("renders SubtaskSection", () => {
    render(<TaskPage {...defaultProps} />);
    expect(screen.getByTestId("subtask-section")).toBeTruthy();
  });

  it("renders TaskMetadataSidebar", () => {
    render(<TaskPage {...defaultProps} />);
    expect(screen.getByTestId("metadata-sidebar")).toBeTruthy();
  });
});
