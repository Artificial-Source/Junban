import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { DayTimeline } from "../../../../src/plugins/builtin/timeblocking/components/DayTimeline.js";

function renderTimeline(overrides: Record<string, unknown> = {}) {
  const defaults = {
    date: new Date(2026, 2, 9), // March 9, 2026 (Monday)
    blocks: [],
    slots: [],
    workDayStart: "09:00",
    workDayEnd: "17:00",
    gridInterval: 30,
    pixelsPerHour: 80,
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
      <DayTimeline {...(defaults as React.ComponentProps<typeof DayTimeline>)} />
    </DndContext>,
  );
}

describe("DayTimeline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 9, 10, 30)); // March 9, 2026 10:30 AM
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders hour labels for work day range", () => {
    renderTimeline({ workDayStart: "09:00", workDayEnd: "13:00" });
    expect(screen.getByText("9 AM")).toBeInTheDocument();
    expect(screen.getByText("10 AM")).toBeInTheDocument();
    expect(screen.getByText("11 AM")).toBeInTheDocument();
    expect(screen.getByText("12 PM")).toBeInTheDocument();
  });

  it("renders date header", () => {
    renderTimeline({ date: new Date(2026, 2, 9) });
    expect(screen.getByText("Monday, March 9, 2026")).toBeInTheDocument();
  });

  it("hides date header when showHeader is false", () => {
    renderTimeline({ date: new Date(2026, 2, 9), showHeader: false });
    expect(screen.queryByText("Monday, March 9, 2026")).not.toBeInTheDocument();
  });

  it("shows current time indicator on today", () => {
    renderTimeline({ date: new Date(2026, 2, 9) });
    expect(screen.getByTestId("current-time-indicator")).toBeInTheDocument();
  });

  it("does not show current time indicator on a different day", () => {
    renderTimeline({ date: new Date(2026, 2, 10) });
    expect(screen.queryByTestId("current-time-indicator")).not.toBeInTheDocument();
  });

  it("renders correct number of grid slots for 30-min interval", () => {
    const { container } = renderTimeline({
      workDayStart: "09:00",
      workDayEnd: "12:00",
      gridInterval: 30,
    });
    // 3 hours = 6 slots at 30-min intervals
    const slots = container.querySelectorAll("[data-time]");
    expect(slots).toHaveLength(6);
  });

  it("renders correct number of grid slots for 15-min interval", () => {
    const { container } = renderTimeline({
      workDayStart: "09:00",
      workDayEnd: "11:00",
      gridInterval: 15,
    });
    // 2 hours = 8 slots at 15-min intervals
    const slots = container.querySelectorAll("[data-time]");
    expect(slots).toHaveLength(8);
  });

  it("renders correct number of grid slots for 60-min interval", () => {
    const { container } = renderTimeline({
      workDayStart: "09:00",
      workDayEnd: "17:00",
      gridInterval: 60,
    });
    // 8 hours = 8 slots
    const slots = container.querySelectorAll("[data-time]");
    expect(slots).toHaveLength(8);
  });

  it("renders time blocks", () => {
    const blocks = [
      {
        id: "b1",
        title: "Focus Time",
        date: "2026-03-09",
        startTime: "09:00",
        endTime: "10:00",
        locked: false,
        createdAt: "2026-03-09T00:00:00Z",
        updatedAt: "2026-03-09T00:00:00Z",
      },
    ];
    renderTimeline({ blocks });
    expect(screen.getByText("Focus Time")).toBeInTheDocument();
  });
});
