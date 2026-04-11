import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  SlidersHorizontal: (props: any) => <svg data-testid="sliders-icon" {...props} />,
  Tag: (props: any) => <svg data-testid="tag-icon" {...props} />,
  ChevronDown: (props: any) => <svg data-testid="chevron-down" {...props} />,
  ChevronRight: (props: any) => <svg data-testid="chevron-right" {...props} />,
  Plus: (props: any) => <svg data-testid="plus-icon" {...props} />,
  X: (props: any) => <svg data-testid="x-icon" {...props} />,
  Filter: (props: any) => <svg data-testid="filter-icon" {...props} />,
}));

const mockGetAppSetting = vi.fn();
const mockSetAppSetting = vi.fn();
const mockListTags = vi.fn();

vi.mock("../../../src/ui/api/index.js", () => ({
  api: {
    getAppSetting: (...args: any[]) => mockGetAppSetting(...args),
    setAppSetting: (...args: any[]) => mockSetAppSetting(...args),
    listTags: (...args: any[]) => mockListTags(...args),
  },
}));

import { FiltersLabels } from "../../../src/ui/views/FiltersLabels.js";
import type { Task } from "../../../src/core/types.js";

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
    tags: [],
    sortOrder: 0,
    createdAt: "2026-02-20T10:00:00.000Z",
    updatedAt: "2026-02-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("FiltersLabels", () => {
  const onNavigateToFilter = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAppSetting.mockResolvedValue(null);
    mockSetAppSetting.mockResolvedValue(undefined);
    mockListTags.mockResolvedValue([]);
  });

  it("renders the heading", () => {
    render(<FiltersLabels tasks={[]} onNavigateToFilter={onNavigateToFilter} />);
    expect(screen.getByText("Filters & Labels")).toBeTruthy();
  });

  it("shows empty filter message when no saved filters", () => {
    render(<FiltersLabels tasks={[]} onNavigateToFilter={onNavigateToFilter} />);
    expect(screen.getByText("Your list of filters will show up here.")).toBeTruthy();
  });

  it("shows empty label message when no tags", () => {
    render(<FiltersLabels tasks={[]} onNavigateToFilter={onNavigateToFilter} />);
    expect(
      screen.getByText("No labels yet. Labels are created when you add tags to tasks."),
    ).toBeTruthy();
  });

  it("shows tags loaded from API", async () => {
    mockListTags.mockResolvedValue([
      { id: "tag-1", name: "work", color: "#ff0000" },
      { id: "tag-2", name: "home", color: "" },
    ]);

    render(<FiltersLabels tasks={[]} onNavigateToFilter={onNavigateToFilter} />);

    await waitFor(() => {
      expect(screen.getByText("work")).toBeTruthy();
      expect(screen.getByText("home")).toBeTruthy();
    });
  });

  it("shows tag counts for pending tasks", async () => {
    mockListTags.mockResolvedValue([{ id: "tag-1", name: "work", color: "#ff0000" }]);

    const tasks = [
      makeTask({
        id: "t1",
        tags: [{ id: "tag-1", name: "work", color: "#ff0000" }],
      }),
      makeTask({
        id: "t2",
        tags: [{ id: "tag-1", name: "work", color: "#ff0000" }],
      }),
    ];

    render(<FiltersLabels tasks={tasks} onNavigateToFilter={onNavigateToFilter} />);

    await waitFor(() => {
      expect(screen.getByText("2")).toBeTruthy();
    });
  });

  it("shows add filter form when Add filter button is clicked", async () => {
    render(<FiltersLabels tasks={[]} onNavigateToFilter={onNavigateToFilter} />);
    fireEvent.click(screen.getByText("Add filter"));
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Filter name")).toBeTruthy();
    });
  });

  it("adds a filter when form is submitted", async () => {
    render(<FiltersLabels tasks={[]} onNavigateToFilter={onNavigateToFilter} />);
    fireEvent.click(screen.getByText("Add filter"));

    fireEvent.change(screen.getByPlaceholderText("Filter name"), {
      target: { value: "High priority" },
    });
    fireEvent.change(screen.getByPlaceholderText("Query (e.g., p1, #work, overdue)"), {
      target: { value: "p1" },
    });
    fireEvent.click(screen.getByText("Add"));

    await waitFor(() => {
      expect(screen.getByText("High priority")).toBeTruthy();
      expect(mockSetAppSetting).toHaveBeenCalled();
    });
  });

  it("clicking on a tag navigates to filter", async () => {
    mockListTags.mockResolvedValue([{ id: "tag-1", name: "work", color: "#ff0000" }]);

    render(<FiltersLabels tasks={[]} onNavigateToFilter={onNavigateToFilter} />);

    await waitFor(() => {
      expect(screen.getByText("work")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("work"));
    expect(onNavigateToFilter).toHaveBeenCalledWith("#work");
  });

  it("collapses and expands My Filters section", async () => {
    render(<FiltersLabels tasks={[]} onNavigateToFilter={onNavigateToFilter} />);
    // Both sections start expanded
    expect(screen.getByText("Your list of filters will show up here.")).toBeTruthy();

    // Click My Filters to collapse
    fireEvent.click(screen.getByText("My Filters"));
    await waitFor(() => {
      expect(screen.queryByText("Your list of filters will show up here.")).toBeNull();
    });
  });
});
