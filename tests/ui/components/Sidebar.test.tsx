import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const icon = (name: string) => (props: any) => <svg data-testid={`${name}-icon`} {...props} />;
  return {
    Inbox: icon("inbox"),
    CalendarDays: icon("calendar-days"),
    CalendarRange: icon("calendar-range"),
    Clock: icon("clock"),
    Settings: icon("settings"),
    MessageSquare: icon("message"),
    ChevronDown: icon("chevron-down"),
    ChevronLeft: icon("chevron-left"),
    ChevronRight: icon("chevron-right"),
    Plus: icon("plus"),
    Search: icon("search"),
    SlidersHorizontal: icon("sliders"),
    CheckCircle2: icon("check-circle"),
    Star: icon("star"),
    XCircle: icon("x-circle"),
    BarChart3: icon("bar-chart"),
    Lightbulb: icon("lightbulb"),
  };
});

import { Sidebar } from "../../../src/ui/components/Sidebar.js";
import type { Project } from "../../../src/core/types.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Work",
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

describe("Sidebar", () => {
  const defaultProps = {
    currentView: "inbox",
    onNavigate: vi.fn(),
    projects: [] as Project[],
    selectedProjectId: null,
  };

  it("renders nav links", () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("Inbox")).toBeTruthy();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Upcoming")).toBeTruthy();
    expect(screen.getByText("Calendar")).toBeTruthy();
    expect(screen.getByText("Filters & Labels")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
  });

  it("highlights the active view", () => {
    render(<Sidebar {...defaultProps} currentView="today" />);
    const todayBtn = screen.getByText("Today").closest("button");
    expect(todayBtn?.getAttribute("aria-current")).toBe("page");
  });

  it("does not highlight inactive views", () => {
    render(<Sidebar {...defaultProps} currentView="inbox" />);
    const todayBtn = screen.getByText("Today").closest("button");
    expect(todayBtn?.getAttribute("aria-current")).toBeNull();
  });

  it("navigates when clicking a nav link", () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...defaultProps} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Today"));
    expect(onNavigate).toHaveBeenCalledWith("today");
  });

  it("renders project list", () => {
    const projects = [
      makeProject({ id: "p1", name: "Work" }),
      makeProject({ id: "p2", name: "Personal" }),
    ];
    render(<Sidebar {...defaultProps} projects={projects} />);
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText("Personal")).toBeTruthy();
  });

  it("shows project task counts when provided", () => {
    const projects = [makeProject({ id: "p1", name: "Work" })];
    const counts = new Map([["p1", 5]]);
    render(<Sidebar {...defaultProps} projects={projects} projectTaskCounts={counts} />);
    expect(screen.getByText("5")).toBeTruthy();
  });

  it("shows inbox count when provided", () => {
    render(<Sidebar {...defaultProps} inboxCount={3} />);
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("shows today count when provided", () => {
    render(<Sidebar {...defaultProps} todayCount={7} />);
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("renders Settings button when onOpenSettings is provided", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("calls onOpenSettings when settings is clicked", () => {
    const onOpenSettings = vi.fn();
    render(<Sidebar {...defaultProps} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByText("Settings"));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("shows collapse button when onToggleCollapsed is provided", () => {
    render(<Sidebar {...defaultProps} onToggleCollapsed={vi.fn()} />);
    expect(screen.getByLabelText("Collapse sidebar")).toBeTruthy();
  });

  it("calls onToggleCollapsed when collapse button is clicked", () => {
    const onToggle = vi.fn();
    render(<Sidebar {...defaultProps} onToggleCollapsed={onToggle} />);
    fireEvent.click(screen.getByLabelText("Collapse sidebar"));
    expect(onToggle).toHaveBeenCalled();
  });

  it("shows expand button when collapsed", () => {
    render(<Sidebar {...defaultProps} collapsed={true} onToggleCollapsed={vi.fn()} />);
    expect(screen.getByLabelText("Expand sidebar")).toBeTruthy();
  });

  it("renders Add task button when onAddTask is provided", () => {
    render(<Sidebar {...defaultProps} onAddTask={vi.fn()} />);
    expect(screen.getByText("Add task")).toBeTruthy();
  });

  it("renders AI Chat link", () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("AI Chat")).toBeTruthy();
  });

  it("navigates to project when clicked", () => {
    const onNavigate = vi.fn();
    const projects = [makeProject({ id: "p1", name: "Work" })];
    render(<Sidebar {...defaultProps} onNavigate={onNavigate} projects={projects} />);
    fireEvent.click(screen.getByText("Work"));
    expect(onNavigate).toHaveBeenCalledWith("project", "p1");
  });

  it("hides project labels when collapsed", () => {
    const projects = [makeProject({ id: "p1", name: "Work" })];
    render(<Sidebar {...defaultProps} projects={projects} collapsed={true} />);
    // In collapsed mode, the project name is not displayed as text
    // but the My Projects section header is hidden
    expect(screen.queryByText("My Projects")).toBeNull();
  });
});
