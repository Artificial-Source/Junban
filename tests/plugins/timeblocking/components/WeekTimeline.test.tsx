import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { WeekTimeline } from "../../../../src/plugins/builtin/timeblocking/components/WeekTimeline.js";

function renderWeekTimeline(overrides: Record<string, unknown> = {}) {
  const defaults = {
    startDate: new Date(2026, 2, 9), // Monday March 9
    dayCount: 7,
    blocks: [],
    slots: [],
    workDayStart: "09:00",
    workDayEnd: "17:00",
    gridInterval: 30,
    pixelsPerHour: 64,
    taskStatuses: new Map(),
    editingBlockId: null,
    editingTitle: "",
    onEditingTitleChange: vi.fn(),
    onEditingConfirm: vi.fn(),
    onEditingCancel: vi.fn(),
    onBlockCreate: vi.fn(),
    onBlockMove: vi.fn(),
    onBlockResize: vi.fn(),
    onBlockClick: vi.fn(),
    onSlotClick: vi.fn(),
    ...overrides,
  };

  return render(
    <DndContext>
      <WeekTimeline {...(defaults as React.ComponentProps<typeof WeekTimeline>)} />
    </DndContext>,
  );
}

describe("WeekTimeline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 9, 10, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders correct number of day columns for 7 days", () => {
    renderWeekTimeline({ dayCount: 7 });
    // Mon 9 through Sun 15
    expect(screen.getByTestId("column-header-2026-03-09")).toBeInTheDocument();
    expect(screen.getByTestId("column-header-2026-03-10")).toBeInTheDocument();
    expect(screen.getByTestId("column-header-2026-03-11")).toBeInTheDocument();
    expect(screen.getByTestId("column-header-2026-03-12")).toBeInTheDocument();
    expect(screen.getByTestId("column-header-2026-03-13")).toBeInTheDocument();
    expect(screen.getByTestId("column-header-2026-03-14")).toBeInTheDocument();
    expect(screen.getByTestId("column-header-2026-03-15")).toBeInTheDocument();
  });

  it("renders correct number of day columns for 3 days", () => {
    renderWeekTimeline({ dayCount: 3 });
    expect(screen.getByTestId("column-header-2026-03-09")).toBeInTheDocument();
    expect(screen.getByTestId("column-header-2026-03-10")).toBeInTheDocument();
    expect(screen.getByTestId("column-header-2026-03-11")).toBeInTheDocument();
    expect(screen.queryByTestId("column-header-2026-03-12")).not.toBeInTheDocument();
  });

  it("renders correct number of day columns for 1 day", () => {
    renderWeekTimeline({ dayCount: 1 });
    expect(screen.getByTestId("column-header-2026-03-09")).toBeInTheDocument();
    expect(screen.queryByTestId("column-header-2026-03-10")).not.toBeInTheDocument();
  });

  it("renders 5 day columns for work week", () => {
    renderWeekTimeline({ dayCount: 5 });
    expect(screen.getByTestId("column-header-2026-03-09")).toBeInTheDocument();
    expect(screen.getByTestId("column-header-2026-03-13")).toBeInTheDocument();
    expect(screen.queryByTestId("column-header-2026-03-14")).not.toBeInTheDocument();
  });

  it("highlights today's column header", () => {
    renderWeekTimeline({ dayCount: 7 });
    const todayHeader = screen.getByTestId("column-header-2026-03-09");
    expect(todayHeader.className).toContain("bg-accent/10");
    expect(todayHeader.className).toContain("text-accent");
  });

  it("distributes blocks to correct day columns", () => {
    const blocks = [
      {
        id: "b1",
        title: "Monday Meeting",
        date: "2026-03-09",
        startTime: "10:00",
        endTime: "11:00",
        locked: false,
        createdAt: "2026-03-09T00:00:00Z",
        updatedAt: "2026-03-09T00:00:00Z",
      },
      {
        id: "b2",
        title: "Wednesday Workshop",
        date: "2026-03-11",
        startTime: "14:00",
        endTime: "15:00",
        locked: false,
        createdAt: "2026-03-11T00:00:00Z",
        updatedAt: "2026-03-11T00:00:00Z",
      },
    ];

    renderWeekTimeline({ blocks, dayCount: 7 });
    expect(screen.getByText("Monday Meeting")).toBeInTheDocument();
    expect(screen.getByText("Wednesday Workshop")).toBeInTheDocument();

    // Verify blocks are in correct columns
    const mondayCol = screen.getByTestId("timeline-column-2026-03-09");
    const wednesdayCol = screen.getByTestId("timeline-column-2026-03-11");
    expect(mondayCol).toContainElement(screen.getByText("Monday Meeting"));
    expect(wednesdayCol).toContainElement(screen.getByText("Wednesday Workshop"));
  });

  it("renders hour labels on the left", () => {
    renderWeekTimeline({ workDayStart: "09:00", workDayEnd: "12:00" });
    expect(screen.getByText("9 AM")).toBeInTheDocument();
    expect(screen.getByText("10 AM")).toBeInTheDocument();
    expect(screen.getByText("11 AM")).toBeInTheDocument();
  });

  it("renders column headers with day name and date", () => {
    renderWeekTimeline({ dayCount: 3 });
    expect(screen.getByTestId("column-header-2026-03-09")).toHaveTextContent("Mon 9");
    expect(screen.getByTestId("column-header-2026-03-10")).toHaveTextContent("Tue 10");
    expect(screen.getByTestId("column-header-2026-03-11")).toHaveTextContent("Wed 11");
  });
});
