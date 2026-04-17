import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../../../src/ui/components/TaskInput.js", () => ({
  TaskInput: (props: any) => (
    <button
      data-testid="task-input"
      data-placeholder={props.placeholder}
      onClick={() =>
        props.onSubmit({
          title: "New task",
          priority: null,
          tags: [],
          project: null,
          dueDate: null,
          dueTime: false,
        })
      }
    />
  ),
}));

vi.mock("../../../src/ui/components/TaskList.js", () => ({
  TaskList: (props: any) => (
    <div data-testid="task-list">
      {props.tasks.length === 0 && <span>{props.emptyMessage}</span>}
      {props.tasks.map((t: any) => (
        <span key={t.id}>{t.title}</span>
      ))}
    </div>
  ),
}));

import { Project } from "../../../src/ui/views/Project.js";
import type { Task, Project as ProjectType, Section } from "../../../src/core/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Test task",
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
    dreadLevel: null,
    tags: [],
    sortOrder: 0,
    createdAt: "2026-02-20T10:00:00.000Z",
    updatedAt: "2026-02-20T10:00:00.000Z",
    ...overrides,
  };
}

function makeSection(overrides: Partial<Section> = {}): Section {
  return {
    id: "sec-1",
    projectId: "proj-1",
    name: "Doing",
    sortOrder: 0,
    isCollapsed: false,
    createdAt: "2026-02-20T10:00:00.000Z",
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectType> = {}): ProjectType {
  return {
    id: "proj-1",
    name: "My Project",
    color: "#3b82f6",
    icon: null,
    parentId: null,
    isFavorite: false,
    viewStyle: "list",
    sortOrder: 0,
    archived: false,
    createdAt: "2026-02-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("Project", () => {
  const defaultProps = {
    project: makeProject(),
    tasks: [] as Task[],
    onCreateTask: vi.fn(),
    onToggleTask: vi.fn(),
    onSelectTask: vi.fn(),
    selectedTaskId: null,
  };

  it("renders the project name", () => {
    render(<Project {...defaultProps} />);
    expect(screen.getByText("My Project")).toBeTruthy();
  });

  it("renders project color dot when no icon", () => {
    const { container } = render(<Project {...defaultProps} />);
    const dot = container.querySelector("[style*='background-color']");
    expect(dot).toBeTruthy();
  });

  it("renders project emoji icon when present", () => {
    const project = makeProject({ icon: "🚀" });
    render(<Project {...defaultProps} project={project} />);
    expect(screen.getByText("🚀")).toBeTruthy();
  });

  it("filters tasks to only this project's pending tasks", () => {
    const tasks = [
      makeTask({ id: "t1", title: "In project", projectId: "proj-1", status: "pending" }),
      makeTask({ id: "t2", title: "Other project", projectId: "proj-2", status: "pending" }),
      makeTask({ id: "t3", title: "Completed", projectId: "proj-1", status: "completed" }),
    ];
    render(<Project {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("In project")).toBeTruthy();
    expect(screen.queryByText("Other project")).toBeNull();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("shows empty message when no tasks in project", () => {
    render(<Project {...defaultProps} />);
    expect(screen.getByText("No tasks in this project yet.")).toBeTruthy();
  });

  it("shows task count", () => {
    const tasks = [
      makeTask({ id: "t1", title: "A", projectId: "proj-1" }),
      makeTask({ id: "t2", title: "B", projectId: "proj-1" }),
    ];
    render(<Project {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("2 tasks")).toBeTruthy();
  });

  it("renders TaskInput with project-specific placeholder", () => {
    render(<Project {...defaultProps} />);
    const input = screen.getByTestId("task-input");
    expect(input.getAttribute("data-placeholder")).toBe("Add a task to My Project...");
  });

  it("creates a task inside a section with the section id", () => {
    const onCreateTask = vi.fn();
    render(
      <Project
        {...defaultProps}
        onCreateTask={onCreateTask}
        sections={[makeSection()]}
        onCreateSection={vi.fn()}
        onUpdateSection={vi.fn()}
        onDeleteSection={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Add task to Doing"));
    fireEvent.click(screen.getAllByTestId("task-input")[1]);
    expect(onCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "New task", sectionId: "sec-1" }),
    );
  });

  it("renders the section add-task action below existing section tasks", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Existing", projectId: "proj-1", sectionId: "sec-1" }),
    ];
    render(
      <Project
        {...defaultProps}
        tasks={tasks}
        sections={[makeSection()]}
        onCreateSection={vi.fn()}
        onUpdateSection={vi.fn()}
        onDeleteSection={vi.fn()}
      />,
    );
    const existingTask = screen.getByText("Existing");
    const addTaskButton = screen.getByText("Add task to Doing");
    const position = existingTask.compareDocumentPosition(addTaskButton);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // ── V2-19: Project progress tracking ──

  it("shows CompletionRing when project has tasks", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Pending", projectId: "proj-1", status: "pending" }),
      makeTask({ id: "t2", title: "Done", projectId: "proj-1", status: "completed" }),
    ];
    render(<Project {...defaultProps} tasks={tasks} />);
    expect(screen.getByLabelText("1 of 2 tasks completed")).toBeTruthy();
  });

  it("hides CompletionRing when project has no tasks", () => {
    render(<Project {...defaultProps} />);
    expect(screen.queryByLabelText(/tasks completed/)).toBeNull();
  });

  it("counts only this project's completed tasks for progress", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Pending", projectId: "proj-1", status: "pending" }),
      makeTask({ id: "t2", title: "Done here", projectId: "proj-1", status: "completed" }),
      makeTask({ id: "t3", title: "Done other", projectId: "proj-2", status: "completed" }),
    ];
    render(<Project {...defaultProps} tasks={tasks} />);
    expect(screen.getByLabelText("1 of 2 tasks completed")).toBeTruthy();
  });
});
