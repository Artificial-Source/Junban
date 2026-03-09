import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExtractTasksModal } from "../../../src/ui/components/ExtractTasksModal.js";
import type { Project } from "../../../src/core/types.js";

const mockProjects: Project[] = [
  {
    id: "p1",
    name: "Project Alpha",
    color: "#f00",
    icon: null,
    parentId: null,
    isFavorite: false,
    viewStyle: "list",
    sortOrder: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

describe("ExtractTasksModal", () => {
  let onClose: ReturnType<typeof vi.fn>;
  let onCreateTasks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onClose = vi.fn();
    onCreateTasks = vi.fn().mockResolvedValue(undefined);
  });

  function getExtractButton() {
    return screen.getByRole("button", { name: "Extract Tasks" });
  }

  it("renders textarea and extract button when open", () => {
    render(
      <ExtractTasksModal
        open={true}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    expect(screen.getByPlaceholderText(/paste your text/i)).toBeDefined();
    expect(getExtractButton()).toBeDefined();
  });

  it("does not render when open is false", () => {
    const { container } = render(
      <ExtractTasksModal
        open={false}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("extract button is disabled when textarea is empty", () => {
    render(
      <ExtractTasksModal
        open={true}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    expect(getExtractButton()).toHaveAttribute("disabled");
  });

  it("extract button is enabled when textarea has text", () => {
    render(
      <ExtractTasksModal
        open={true}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    const textarea = screen.getByPlaceholderText(/paste your text/i);
    fireEvent.change(textarea, { target: { value: "- Review the report" } });

    expect(getExtractButton()).not.toHaveAttribute("disabled");
  });

  it("shows loading state during extraction", async () => {
    render(
      <ExtractTasksModal
        open={true}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    const textarea = screen.getByPlaceholderText(/paste your text/i);
    fireEvent.change(textarea, { target: { value: "- Review the report\n- Send the email" } });
    fireEvent.click(getExtractButton());

    expect(screen.getByText("Extracting tasks...")).toBeDefined();
  });

  it("displays extracted tasks in preview", async () => {
    render(
      <ExtractTasksModal
        open={true}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    const textarea = screen.getByPlaceholderText(/paste your text/i);
    fireEvent.change(textarea, {
      target: { value: "- Review the quarterly report\n- Send follow-up email to team" },
    });
    fireEvent.click(getExtractButton());

    await waitFor(() => {
      expect(screen.getByDisplayValue("Review the quarterly report")).toBeDefined();
    });
    expect(screen.getByDisplayValue("Send follow-up email to team")).toBeDefined();
  });

  it("allows toggling task selection via checkbox", async () => {
    render(
      <ExtractTasksModal
        open={true}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    const textarea = screen.getByPlaceholderText(/paste your text/i);
    fireEvent.change(textarea, {
      target: { value: "- Review the report\n- Update documentation" },
    });
    fireEvent.click(getExtractButton());

    await waitFor(() => {
      expect(screen.getByText(/Create 2 Tasks/)).toBeDefined();
    });

    // Uncheck the first task
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);

    expect(screen.getByText(/Create 1 Task$/)).toBeDefined();
  });

  it("creates only selected tasks", async () => {
    render(
      <ExtractTasksModal
        open={true}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    const textarea = screen.getByPlaceholderText(/paste your text/i);
    fireEvent.change(textarea, {
      target: { value: "- Review the report\n- Update documentation" },
    });
    fireEvent.click(getExtractButton());

    await waitFor(() => {
      expect(screen.getByText(/Create 2 Tasks/)).toBeDefined();
    });

    // Uncheck the first task
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);

    // Create selected
    fireEvent.click(screen.getByText(/Create 1 Task$/));

    await waitFor(() => {
      expect(onCreateTasks).toHaveBeenCalledTimes(1);
    });
    // Should only contain the second task
    const createdTasks = onCreateTasks.mock.calls[0][0];
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].title).toBe("Update documentation");
  });

  it("calls onClose when Escape is pressed", () => {
    render(
      <ExtractTasksModal
        open={true}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows error when no tasks found", async () => {
    render(
      <ExtractTasksModal
        open={true}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    const textarea = screen.getByPlaceholderText(/paste your text/i);
    fireEvent.change(textarea, {
      target: { value: "The weather is nice today." },
    });
    fireEvent.click(getExtractButton());

    await waitFor(() => {
      expect(screen.getByText(/No actionable tasks found/)).toBeDefined();
    });
  });

  it("shows success state after creating tasks", async () => {
    render(
      <ExtractTasksModal
        open={true}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    const textarea = screen.getByPlaceholderText(/paste your text/i);
    fireEvent.change(textarea, {
      target: { value: "- Review the report" },
    });
    fireEvent.click(getExtractButton());

    await waitFor(() => {
      expect(screen.getByText(/Create 1 Task$/)).toBeDefined();
    });

    fireEvent.click(screen.getByText(/Create 1 Task$/));

    await waitFor(() => {
      expect(screen.getByText(/1 task created/)).toBeDefined();
    });
  });

  it("shows project selector", () => {
    render(
      <ExtractTasksModal
        open={true}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    expect(screen.getByLabelText("Assign to project:")).toBeDefined();
    expect(screen.getByText("Project Alpha")).toBeDefined();
  });

  it("passes selected project to onCreateTasks", async () => {
    render(
      <ExtractTasksModal
        open={true}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    // Select project
    const select = screen.getByLabelText("Assign to project:");
    fireEvent.change(select, { target: { value: "p1" } });

    const textarea = screen.getByPlaceholderText(/paste your text/i);
    fireEvent.change(textarea, {
      target: { value: "- Review the report" },
    });
    fireEvent.click(getExtractButton());

    await waitFor(() => {
      expect(screen.getByText(/Create 1 Task$/)).toBeDefined();
    });

    fireEvent.click(screen.getByText(/Create 1 Task$/));

    await waitFor(() => {
      expect(onCreateTasks).toHaveBeenCalledWith(expect.any(Array), "p1");
    });
  });

  it("shows error state when creation fails", async () => {
    onCreateTasks.mockRejectedValueOnce(new Error("Network error"));

    render(
      <ExtractTasksModal
        open={true}
        onClose={onClose}
        projects={mockProjects}
        onCreateTasks={onCreateTasks}
      />,
    );

    const textarea = screen.getByPlaceholderText(/paste your text/i);
    fireEvent.change(textarea, {
      target: { value: "- Review the report" },
    });
    fireEvent.click(getExtractButton());

    await waitFor(() => {
      expect(screen.getByText(/Create 1 Task$/)).toBeDefined();
    });

    fireEvent.click(screen.getByText(/Create 1 Task$/));

    await waitFor(() => {
      expect(screen.getByText(/Failed to create/)).toBeDefined();
    });
  });
});
