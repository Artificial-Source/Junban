import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mockUpdateSetting = vi.fn();
let mockSettings: Record<string, string> = {};

vi.mock("../../../src/ui/context/SettingsContext.js", () => ({
  useGeneralSettings: () => ({
    settings: {
      feature_cancelled: "true",
      feature_stats: "true",
      feature_someday: "true",
      feature_matrix: "true",
      feature_calendar: "true",
      feature_filters_labels: "true",
      feature_completed: "true",
      sidebar_nav_order: "",
      sidebar_favorite_views: "",
      sidebar_section_order: "",
      start_view: "inbox",
      ...mockSettings,
    },
    loaded: true,
    updateSetting: mockUpdateSetting,
  }),
}));

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
    Grid2x2: icon("grid2x2"),
    Filter: icon("filter"),
    EyeOff: icon("eye-off"),
    Eye: icon("eye"),
    RotateCcw: icon("rotate-ccw"),
    ArrowUpToLine: icon("arrow-up-to-line"),
    ArrowDownToLine: icon("arrow-down-to-line"),
    Home: icon("home"),
    Link: icon("link"),
    Heart: icon("heart"),
    GripVertical: icon("grip-vertical"),
  };
});

// Mock dnd-kit to avoid DOM measurement issues in tests
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: any) => <div data-testid="dnd-context">{children}</div>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: () => [],
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: any) => <div data-testid="sortable-context">{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
  verticalListSortingStrategy: vi.fn(),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

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
  beforeEach(() => {
    mockSettings = {};
    mockUpdateSetting.mockClear();
  });

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

  // ── Context menu tests ──

  it("shows context menu on right-click of nav item", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const calendarBtn = screen.getByText("Calendar").closest("button")!;
    fireEvent.contextMenu(calendarBtn);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByText("Hide from sidebar")).toBeTruthy();
  });

  it("shows 'Hide from sidebar' for optional views", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    // Test with Stats (optional view)
    const statsBtn = screen.getByText("Stats").closest("button")!;
    fireEvent.contextMenu(statsBtn);
    expect(screen.getByText("Hide from sidebar")).toBeTruthy();
  });

  it("does NOT show 'Hide from sidebar' for core views", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const inboxBtn = screen.getByText("Inbox").closest("button")!;
    fireEvent.contextMenu(inboxBtn);
    expect(screen.queryByText("Hide from sidebar")).toBeNull();
    expect(screen.getByText("Manage in Settings")).toBeTruthy();
  });

  it("clicking 'Hide from sidebar' calls updateSetting with correct feature key", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const calendarBtn = screen.getByText("Calendar").closest("button")!;
    fireEvent.contextMenu(calendarBtn);
    fireEvent.click(screen.getByText("Hide from sidebar"));
    expect(mockUpdateSetting).toHaveBeenCalledWith("feature_calendar", "false");
  });

  it("core view context menu shows 'Manage in Settings'", () => {
    const onOpenSettings = vi.fn();
    render(<Sidebar {...defaultProps} onOpenSettings={onOpenSettings} />);
    const todayBtn = screen.getByText("Today").closest("button")!;
    fireEvent.contextMenu(todayBtn);
    fireEvent.click(screen.getByText("Manage in Settings"));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("hides calendar when feature_calendar is false", () => {
    mockSettings = { feature_calendar: "false" };
    render(<Sidebar {...defaultProps} />);
    expect(screen.queryByText("Calendar")).toBeNull();
  });

  it("hides Filters & Labels when feature_filters_labels is false", () => {
    mockSettings = { feature_filters_labels: "false" };
    render(<Sidebar {...defaultProps} />);
    expect(screen.queryByText("Filters & Labels")).toBeNull();
  });

  it("hides Completed when feature_completed is false", () => {
    mockSettings = { feature_completed: "false" };
    render(<Sidebar {...defaultProps} />);
    expect(screen.queryByText("Completed")).toBeNull();
  });

  // ── Nav ordering tests ──

  it("renders nav items in stored order from sidebar_section_order", () => {
    mockSettings = { sidebar_section_order: "stats,inbox,today,upcoming,calendar,filters-labels,completed,cancelled,matrix,someday" };
    render(<Sidebar {...defaultProps} />);
    // Get all nav buttons inside the sortable context area
    const sortable = screen.getByTestId("sortable-context");
    const buttons = Array.from(sortable.querySelectorAll("button"));
    // Stats should appear before Inbox in the nav
    const statsIdx = buttons.findIndex((b) => b.textContent?.includes("Stats"));
    const inboxIdx = buttons.findIndex((b) => b.textContent?.includes("Inbox"));
    expect(statsIdx).toBeLessThan(inboxIdx);
  });

  it("items not in stored order appear at end", () => {
    // Only specify a few items — the rest should appear at end
    mockSettings = { sidebar_section_order: "today,inbox" };
    render(<Sidebar {...defaultProps} />);
    const sortable = screen.getByTestId("sortable-context");
    const buttons = Array.from(sortable.querySelectorAll("button"));
    const todayIdx = buttons.findIndex((b) => b.textContent?.includes("Today"));
    const inboxIdx = buttons.findIndex((b) => b.textContent?.includes("Inbox"));
    const upcomingIdx = buttons.findIndex((b) => b.textContent?.includes("Upcoming"));
    expect(todayIdx).toBeLessThan(inboxIdx);
    expect(inboxIdx).toBeLessThan(upcomingIdx);
  });

  it("empty sidebar_section_order uses default order", () => {
    mockSettings = { sidebar_section_order: "" };
    render(<Sidebar {...defaultProps} />);
    const sortable = screen.getByTestId("sortable-context");
    const buttons = Array.from(sortable.querySelectorAll("button"));
    const inboxIdx = buttons.findIndex((b) => b.textContent?.includes("Inbox"));
    const todayIdx = buttons.findIndex((b) => b.textContent?.includes("Today"));
    const upcomingIdx = buttons.findIndex((b) => b.textContent?.includes("Upcoming"));
    expect(inboxIdx).toBeLessThan(todayIdx);
    expect(todayIdx).toBeLessThan(upcomingIdx);
  });

  it("'Reset order' shown in context menu when sidebar_nav_order is set", () => {
    mockSettings = { sidebar_nav_order: "today,inbox" };
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const todayBtn = screen.getByText("Today").closest("button")!;
    fireEvent.contextMenu(todayBtn);
    expect(screen.getByText("Reset order")).toBeTruthy();
  });

  it("'Reset order' clears sidebar_nav_order", () => {
    mockSettings = { sidebar_nav_order: "today,inbox" };
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const todayBtn = screen.getByText("Today").closest("button")!;
    fireEvent.contextMenu(todayBtn);
    fireEvent.click(screen.getByText("Reset order"));
    expect(mockUpdateSetting).toHaveBeenCalledWith("sidebar_nav_order", "");
  });

  // ── Move to top / bottom ──

  it("'Move to top' moves item to first position", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const statsBtn = screen.getByText("Stats").closest("button")!;
    fireEvent.contextMenu(statsBtn);
    fireEvent.click(screen.getByText("Move to top"));
    const call = mockUpdateSetting.mock.calls.find(
      (c: any[]) => c[0] === "sidebar_section_order",
    );
    expect(call).toBeTruthy();
    const order = (call![1] as string).split(",");
    expect(order[0]).toBe("stats");
  });

  it("'Move to bottom' moves item to last position", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const inboxBtn = screen.getByText("Inbox").closest("button")!;
    fireEvent.contextMenu(inboxBtn);
    fireEvent.click(screen.getByText("Move to bottom"));
    const call = mockUpdateSetting.mock.calls.find(
      (c: any[]) => c[0] === "sidebar_section_order",
    );
    expect(call).toBeTruthy();
    const order = (call![1] as string).split(",");
    expect(order[order.length - 1]).toBe("inbox");
  });

  it("does not show 'Move to top' for first item", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    // Inbox is first by default
    const inboxBtn = screen.getByText("Inbox").closest("button")!;
    fireEvent.contextMenu(inboxBtn);
    expect(screen.queryByText("Move to top")).toBeNull();
  });

  it("does not show 'Move to bottom' for last item", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    // Someday is last by default
    const somedayBtn = screen.getByText("Someday").closest("button")!;
    fireEvent.contextMenu(somedayBtn);
    expect(screen.queryByText("Move to bottom")).toBeNull();
  });

  // ── Set as Home view ──

  it("'Set as Home view' updates start_view setting", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const calendarBtn = screen.getByText("Calendar").closest("button")!;
    fireEvent.contextMenu(calendarBtn);
    fireEvent.click(screen.getByText("Set as Home view"));
    expect(mockUpdateSetting).toHaveBeenCalledWith("start_view", "calendar");
  });

  it("shows 'Home view' (disabled) when item is already the start_view", () => {
    mockSettings = { start_view: "inbox" };
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const inboxBtn = screen.getByText("Inbox").closest("button")!;
    fireEvent.contextMenu(inboxBtn);
    expect(screen.getByText("Home view")).toBeTruthy();
  });

  // ── Copy link ──

  it("'Copy link' writes to clipboard", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const todayBtn = screen.getByText("Today").closest("button")!;
    fireEvent.contextMenu(todayBtn);
    fireEvent.click(screen.getByText("Copy link"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("#/today"));
  });

  // ── Hide others ──

  it("'Hide others' hides all optional views except the target", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const calendarBtn = screen.getByText("Calendar").closest("button")!;
    fireEvent.contextMenu(calendarBtn);
    fireEvent.click(screen.getByText("Hide others"));
    // Should NOT have been called with feature_calendar = false
    expect(mockUpdateSetting).not.toHaveBeenCalledWith("feature_calendar", "false");
    // Should have been called for other optional views
    expect(mockUpdateSetting).toHaveBeenCalledWith("feature_stats", "false");
    expect(mockUpdateSetting).toHaveBeenCalledWith("feature_someday", "false");
    expect(mockUpdateSetting).toHaveBeenCalledWith("feature_cancelled", "false");
  });

  // ── Show all hidden ──

  it("'Show all hidden' re-enables all hidden views", () => {
    mockSettings = { feature_stats: "false", feature_someday: "false" };
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const inboxBtn = screen.getByText("Inbox").closest("button")!;
    fireEvent.contextMenu(inboxBtn);
    fireEvent.click(screen.getByText("Show all hidden"));
    expect(mockUpdateSetting).toHaveBeenCalledWith("feature_stats", "true");
    expect(mockUpdateSetting).toHaveBeenCalledWith("feature_someday", "true");
  });

  it("does not show 'Show all hidden' when no views are hidden", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const inboxBtn = screen.getByText("Inbox").closest("button")!;
    fireEvent.contextMenu(inboxBtn);
    expect(screen.queryByText("Show all hidden")).toBeNull();
  });

  // ── Favorites ──

  it("'Add to Favorites' saves view to sidebar_favorite_views", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const todayBtn = screen.getByText("Today").closest("button")!;
    fireEvent.contextMenu(todayBtn);
    fireEvent.click(screen.getByText("Add to Favorites"));
    expect(mockUpdateSetting).toHaveBeenCalledWith("sidebar_favorite_views", "today");
  });

  it("shows 'Remove from Favorites' when view is favorited", () => {
    mockSettings = { sidebar_favorite_views: "calendar" };
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    // Calendar is now in Favorite Views section (removed from main nav to avoid duplication)
    const calendarBtn = screen.getByText("Calendar").closest("button")!;
    fireEvent.contextMenu(calendarBtn);
    expect(screen.getByText("Remove from Favorites")).toBeTruthy();
  });

  it("renders Favorite Views section when views are favorited", () => {
    mockSettings = { sidebar_favorite_views: "today,calendar" };
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("Favorite Views")).toBeTruthy();
  });

  it("does not render Favorite Views section when empty", () => {
    mockSettings = { sidebar_favorite_views: "" };
    render(<Sidebar {...defaultProps} />);
    expect(screen.queryByText("Favorite Views")).toBeNull();
  });

  // ── Separator lines ──

  it("context menu includes separator dividers between groups", () => {
    render(<Sidebar {...defaultProps} onOpenSettings={vi.fn()} />);
    const calendarBtn = screen.getByText("Calendar").closest("button")!;
    fireEvent.contextMenu(calendarBtn);
    const menu = screen.getByRole("menu");
    const separators = menu.querySelectorAll('[role="separator"]');
    expect(separators.length).toBeGreaterThan(0);
  });

  // ── Favorite dedup: hide favorited items from main nav ──

  it("hides favorited items from main nav (no duplication)", () => {
    mockSettings = { sidebar_favorite_views: "calendar" };
    render(<Sidebar {...defaultProps} />);
    // Calendar should appear only once (in Favorite Views), not in main nav
    const calendarElements = screen.getAllByText("Calendar");
    expect(calendarElements).toHaveLength(1);
    // Favorite Views section should be visible
    expect(screen.getByText("Favorite Views")).toBeTruthy();
  });

  it("shows favorited items only in Favorite Views section", () => {
    mockSettings = { sidebar_favorite_views: "today,stats" };
    render(<Sidebar {...defaultProps} />);
    // Today and Stats removed from main nav, only in Favorite Views
    expect(screen.getByText("Favorite Views")).toBeTruthy();
    // Each should appear exactly once
    const todayElements = screen.getAllByText("Today");
    const statsElements = screen.getAllByText("Stats");
    expect(todayElements).toHaveLength(1);
    expect(statsElements).toHaveLength(1);
  });

  // ── Section ordering ──

  it("renders sections in default order when sidebar_section_order is empty", () => {
    mockSettings = {
      sidebar_favorite_views: "calendar",
      sidebar_section_order: "",
    };
    const projects = [makeProject({ id: "p1", name: "Work" })];
    const savedFilters = [{ id: "f1", name: "My Filter", query: "status:pending" }];
    render(<Sidebar {...defaultProps} projects={projects} savedFilters={savedFilters} />);
    // All sections should appear
    expect(screen.getByText("Favorite Views")).toBeTruthy();
    expect(screen.getByText("My Projects")).toBeTruthy();
    expect(screen.getByText("My Views")).toBeTruthy();
  });

  it("renders sections with drag handles", () => {
    mockSettings = { sidebar_favorite_views: "calendar" };
    const projects = [makeProject({ id: "p1", name: "Work" })];
    render(<Sidebar {...defaultProps} projects={projects} />);
    // Should have drag handle buttons for sections
    const dragHandles = screen.getAllByLabelText(/Drag .+ section/);
    expect(dragHandles.length).toBeGreaterThanOrEqual(2); // Favorite Views + My Projects at least
  });

  it("renders sections in stored order from sidebar_section_order", () => {
    mockSettings = {
      sidebar_favorite_views: "calendar",
      sidebar_section_order: "projects,favorite-views",
    };
    const projects = [makeProject({ id: "p1", name: "Work" })];
    render(<Sidebar {...defaultProps} projects={projects} />);
    // My Projects should come before Favorite Views based on section order
    const allSections = screen.getByLabelText("Views").querySelectorAll("[data-section-id]");
    const sectionOrder = Array.from(allSections).map((el) => el.getAttribute("data-section-id"));
    expect(sectionOrder.indexOf("projects")).toBeLessThan(sectionOrder.indexOf("favorite-views"));
  });

  it("nav items can be reordered below sections in flat list", () => {
    mockSettings = {
      sidebar_favorite_views: "calendar",
      sidebar_section_order: "favorite-views,inbox,today,upcoming,filters-labels,completed,cancelled,matrix,stats,someday",
    };
    render(<Sidebar {...defaultProps} />);
    const sortable = screen.getByTestId("sortable-context");
    const allElements = Array.from(sortable.querySelectorAll("[data-section-id], button"));
    // Favorite Views section should come before Inbox button
    const favViewIdx = allElements.findIndex((el) => el.getAttribute("data-section-id") === "favorite-views");
    const inboxIdx = allElements.findIndex((el) => el.textContent?.includes("Inbox"));
    expect(favViewIdx).toBeLessThan(inboxIdx);
  });

  it("individual nav items are draggable via SortableNavItem wrapper", () => {
    render(<Sidebar {...defaultProps} />);
    screen.getByTestId("sortable-context");
    // Each nav item is wrapped in a div (SortableNavItem) — check Inbox button has a parent div wrapper
    const inboxBtn = screen.getByText("Inbox").closest("button")!;
    const wrapper = inboxBtn.parentElement;
    expect(wrapper?.tagName).toBe("DIV");
    // Wrapper should have the style from SortableNavItem (opacity)
    expect(wrapper?.style.opacity).toBe("1");
  });
});
