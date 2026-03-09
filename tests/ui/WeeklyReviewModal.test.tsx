import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WeeklyReviewModal } from "../../src/ui/components/WeeklyReviewModal.js";
import type { WeeklyReviewData } from "../../src/ui/components/WeeklyReviewModal.js";

function makeData(overrides: Partial<WeeklyReviewData> = {}): WeeklyReviewData {
  return {
    weekStartDate: "2025-06-02",
    weekEndDate: "2025-06-08",
    completionRate: 75,
    taskFlow: { created: 10, completed: 8, cancelled: 1, net: -2 },
    dailyStats: [
      { date: "2025-06-02", dayName: "Monday", completed: 3, created: 2 },
      { date: "2025-06-03", dayName: "Tuesday", completed: 2, created: 1 },
      { date: "2025-06-04", dayName: "Wednesday", completed: 1, created: 3 },
      { date: "2025-06-05", dayName: "Thursday", completed: 0, created: 1 },
      { date: "2025-06-06", dayName: "Friday", completed: 2, created: 2 },
      { date: "2025-06-07", dayName: "Saturday", completed: 0, created: 1 },
      { date: "2025-06-08", dayName: "Sunday", completed: 0, created: 0 },
    ],
    busiestDay: { date: "2025-06-02", dayName: "Monday", completed: 3 },
    productiveTime: "morning",
    productiveTimeCounts: { morning: 4, afternoon: 2, evening: 1, night: 1 },
    neglectedProjects: [
      { id: "p1", name: "Side Project", overdueCount: 2, reason: "2 overdue tasks" },
    ],
    overdue: {
      count: 3,
      tasks: [
        { id: "t1", title: "Fix bug", priority: 1, dueDate: "2025-06-01" },
        { id: "t2", title: "Update docs", priority: 3, dueDate: "2025-06-02" },
        { id: "t3", title: "Review PR", priority: 2, dueDate: "2025-06-03" },
      ],
    },
    streak: { currentDays: 5, isActive: true },
    topAccomplishments: [
      {
        id: "a1",
        title: "Shipped feature",
        priority: 1,
        completedAt: "2025-06-02T10:00:00Z",
        projectId: null,
      },
      {
        id: "a2",
        title: "Wrote tests",
        priority: 2,
        completedAt: "2025-06-03T14:00:00Z",
        projectId: null,
      },
    ],
    suggestions: [
      "Tackle your 3 overdue tasks early in the week.",
      "Check in on neglected projects: Side Project.",
    ],
    ...overrides,
  };
}

describe("WeeklyReviewModal", () => {
  it("renders all sections when open with data", () => {
    const data = makeData();
    render(<WeeklyReviewModal open={true} onClose={vi.fn()} data={data} />);

    // Header
    expect(screen.getByText("Weekly Review")).toBeDefined();

    // Summary stats
    const summaryStats = screen.getByTestId("summary-stats");
    expect(summaryStats).toBeDefined();
    // Check that stat cards render with their labels
    expect(screen.getByText("Completed")).toBeDefined();
    expect(screen.getByText("Created")).toBeDefined();
    expect(screen.getByText("Overdue")).toBeDefined();
    expect(screen.getByText("Streak")).toBeDefined();
    expect(screen.getByText("5d")).toBeDefined(); // streak value

    // Chart
    expect(screen.getByTestId("daily-chart")).toBeDefined();

    // Accomplishments
    expect(screen.getByTestId("accomplishments")).toBeDefined();
    expect(screen.getByText("Shipped feature")).toBeDefined();
    expect(screen.getByText("Wrote tests")).toBeDefined();

    // Neglected
    expect(screen.getByTestId("neglected-projects")).toBeDefined();
    expect(screen.getByText("Side Project")).toBeDefined();

    // Suggestions
    expect(screen.getByTestId("suggestions")).toBeDefined();
  });

  it("renders nothing when not open", () => {
    const data = makeData();
    const { container } = render(<WeeklyReviewModal open={false} onClose={vi.fn()} data={data} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when data is null", () => {
    const { container } = render(<WeeklyReviewModal open={true} onClose={vi.fn()} data={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("closes on Escape key", () => {
    const onClose = vi.fn();
    render(<WeeklyReviewModal open={true} onClose={onClose} data={makeData()} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click", () => {
    const onClose = vi.fn();
    render(<WeeklyReviewModal open={true} onClose={onClose} data={makeData()} />);

    const backdrop = screen.getByTestId("weekly-review-backdrop");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders bars with proportional heights", () => {
    const data = makeData({
      dailyStats: [
        { date: "2025-06-02", dayName: "Monday", completed: 10, created: 0 },
        { date: "2025-06-03", dayName: "Tuesday", completed: 5, created: 0 },
        { date: "2025-06-04", dayName: "Wednesday", completed: 0, created: 0 },
        { date: "2025-06-05", dayName: "Thursday", completed: 0, created: 0 },
        { date: "2025-06-06", dayName: "Friday", completed: 0, created: 0 },
        { date: "2025-06-07", dayName: "Saturday", completed: 0, created: 0 },
        { date: "2025-06-08", dayName: "Sunday", completed: 0, created: 0 },
      ],
    });

    render(<WeeklyReviewModal open={true} onClose={vi.fn()} data={data} />);

    const mondayBar = screen.getByTestId("bar-Monday");
    const tuesdayBar = screen.getByTestId("bar-Tuesday");
    const wednesdayBar = screen.getByTestId("bar-Wednesday");

    // Monday (max) should be 100%, Tuesday 50%, Wednesday 0%
    expect(mondayBar.style.height).toBe("100%");
    expect(tuesdayBar.style.height).toBe("50%");
    expect(wednesdayBar.style.height).toBe("0%");
  });

  it("handles empty data gracefully", () => {
    const emptyData = makeData({
      taskFlow: { created: 0, completed: 0, cancelled: 0, net: 0 },
      completionRate: 0,
      dailyStats: [
        { date: "2025-06-02", dayName: "Monday", completed: 0, created: 0 },
        { date: "2025-06-03", dayName: "Tuesday", completed: 0, created: 0 },
        { date: "2025-06-04", dayName: "Wednesday", completed: 0, created: 0 },
        { date: "2025-06-05", dayName: "Thursday", completed: 0, created: 0 },
        { date: "2025-06-06", dayName: "Friday", completed: 0, created: 0 },
        { date: "2025-06-07", dayName: "Saturday", completed: 0, created: 0 },
        { date: "2025-06-08", dayName: "Sunday", completed: 0, created: 0 },
      ],
      busiestDay: null,
      productiveTime: null,
      neglectedProjects: [],
      overdue: { count: 0, tasks: [] },
      streak: { currentDays: 0, isActive: false },
      topAccomplishments: [],
      suggestions: [],
    });

    render(<WeeklyReviewModal open={true} onClose={vi.fn()} data={emptyData} />);

    // Should still render the header and chart
    expect(screen.getByText("Weekly Review")).toBeDefined();
    expect(screen.getByTestId("daily-chart")).toBeDefined();

    // Should NOT render optional sections
    expect(screen.queryByTestId("accomplishments")).toBeNull();
    expect(screen.queryByTestId("neglected-projects")).toBeNull();
    expect(screen.queryByTestId("suggestions")).toBeNull();
    expect(screen.queryByTestId("overdue-tasks")).toBeNull();
  });
});
