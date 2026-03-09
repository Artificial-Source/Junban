import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { TimelineColumn } from "../../../../src/plugins/builtin/timeblocking/components/TimelineColumn.js";

function renderColumn(overrides: Record<string, unknown> = {}) {
  const defaults = {
    date: new Date(2026, 2, 9),
    dateStr: "2026-03-09",
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
    onBlockResize: vi.fn(),
    onBlockClick: vi.fn(),
    ...overrides,
  };

  return render(
    <DndContext>
      <TimelineColumn {...(defaults as React.ComponentProps<typeof TimelineColumn>)} />
    </DndContext>,
  );
}

describe("TimelineColumn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 9, 10, 30));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders grid cells with correct intervals", () => {
    const { container } = renderColumn({
      workDayStart: "09:00",
      workDayEnd: "12:00",
      gridInterval: 30,
    });
    const cells = container.querySelectorAll("[data-time]");
    expect(cells).toHaveLength(6);
  });

  it("includes date in grid cell data attributes", () => {
    const { container } = renderColumn({
      dateStr: "2026-03-09",
      workDayStart: "09:00",
      workDayEnd: "10:00",
      gridInterval: 30,
    });
    const cells = container.querySelectorAll("[data-date='2026-03-09']");
    expect(cells).toHaveLength(2);
  });

  it("renders drop target zones for each grid slot", () => {
    const { container } = renderColumn({
      workDayStart: "09:00",
      workDayEnd: "11:00",
      gridInterval: 60,
    });
    const cells = container.querySelectorAll("[data-time]");
    expect(cells).toHaveLength(2);
    expect(cells[0].getAttribute("data-time")).toBe("09:00");
    expect(cells[1].getAttribute("data-time")).toBe("10:00");
  });

  it("shows current time indicator only on today", () => {
    renderColumn({ date: new Date(2026, 2, 9), dateStr: "2026-03-09" });
    expect(screen.getByTestId("current-time-indicator")).toBeInTheDocument();
  });

  it("does not show current time indicator on other days", () => {
    renderColumn({ date: new Date(2026, 2, 10), dateStr: "2026-03-10" });
    expect(screen.queryByTestId("current-time-indicator")).not.toBeInTheDocument();
  });

  it("renders time blocks positioned within the column", () => {
    const blocks = [
      {
        id: "b1",
        title: "Meeting",
        date: "2026-03-09",
        startTime: "10:00",
        endTime: "11:00",
        locked: false,
        createdAt: "2026-03-09T00:00:00Z",
        updatedAt: "2026-03-09T00:00:00Z",
      },
    ];
    renderColumn({ blocks, dateStr: "2026-03-09" });
    expect(screen.getByText("Meeting")).toBeInTheDocument();
  });

  it("filters blocks to only show those matching dateStr", () => {
    const blocks = [
      {
        id: "b1",
        title: "Today Block",
        date: "2026-03-09",
        startTime: "10:00",
        endTime: "11:00",
        locked: false,
        createdAt: "2026-03-09T00:00:00Z",
        updatedAt: "2026-03-09T00:00:00Z",
      },
      {
        id: "b2",
        title: "Other Day Block",
        date: "2026-03-10",
        startTime: "10:00",
        endTime: "11:00",
        locked: false,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ];
    renderColumn({ blocks, dateStr: "2026-03-09" });
    expect(screen.getByText("Today Block")).toBeInTheDocument();
    expect(screen.queryByText("Other Day Block")).not.toBeInTheDocument();
  });

  it("has testid with dateStr", () => {
    renderColumn({ dateStr: "2026-03-09" });
    expect(screen.getByTestId("timeline-column-2026-03-09")).toBeInTheDocument();
  });
});
