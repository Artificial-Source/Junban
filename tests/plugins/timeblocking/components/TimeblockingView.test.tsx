import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TimeblockingView } from "../../../../src/plugins/builtin/timeblocking/components/TimeblockingView.js";
import { TimeblockingContext } from "../../../../src/plugins/builtin/timeblocking/context.js";
import type TimeblockingPlugin from "../../../../src/plugins/builtin/timeblocking/index.js";

function createMockPlugin(): TimeblockingPlugin {
  return {
    store: {
      listBlocks: vi.fn().mockReturnValue([]),
      listBlocksInRange: vi.fn().mockReturnValue([]),
      listSlots: vi.fn().mockReturnValue([]),
      listSlotsInRange: vi.fn().mockReturnValue([]),
      createBlock: vi.fn().mockResolvedValue({ id: "new-block", title: "New Block" }),
      createSlot: vi.fn().mockResolvedValue({ id: "new-slot", title: "Focus Block" }),
      updateBlock: vi.fn().mockResolvedValue({}),
      deleteBlock: vi.fn().mockResolvedValue(undefined),
      addTaskToSlot: vi.fn().mockResolvedValue({}),
      reorderSlotTasks: vi.fn().mockResolvedValue({}),
    },
    app: {
      tasks: {
        list: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({}),
      },
    },
    settings: {
      get: vi.fn((key: string) => {
        const defaults: Record<string, string> = {
          workDayStart: "09:00",
          workDayEnd: "17:00",
          gridIntervalMinutes: "30",
          defaultDurationMinutes: "30",
        };
        return defaults[key];
      }),
    },
  } as unknown as TimeblockingPlugin;
}

function renderView(plugin?: TimeblockingPlugin) {
  const p = plugin ?? createMockPlugin();
  return render(
    <TimeblockingContext.Provider value={p}>
      <TimeblockingView />
    </TimeblockingContext.Provider>,
  );
}

describe("TimeblockingView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 9, 10, 0));
  });

  it("renders task sidebar and timeline", () => {
    renderView();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.getByTestId("date-range-label")).toHaveTextContent("Monday, March 9, 2026");
  });

  it("renders date navigation buttons", () => {
    renderView();
    expect(screen.getByLabelText("Previous day")).toBeInTheDocument();
    expect(screen.getByLabelText("Next day")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
  });

  it("navigates to next day", () => {
    renderView();
    fireEvent.click(screen.getByLabelText("Next day"));
    expect(screen.getByTestId("date-range-label")).toHaveTextContent("Tuesday, March 10, 2026");
  });

  it("navigates to previous day", () => {
    renderView();
    fireEvent.click(screen.getByLabelText("Previous day"));
    expect(screen.getByTestId("date-range-label")).toHaveTextContent("Sunday, March 8, 2026");
  });

  it("today button resets to today", () => {
    renderView();
    fireEvent.click(screen.getByLabelText("Next day"));
    fireEvent.click(screen.getByLabelText("Next day"));
    expect(screen.getByTestId("date-range-label")).toHaveTextContent("Wednesday, March 11, 2026");
    fireEvent.click(screen.getByText("Today"));
    expect(screen.getByTestId("date-range-label")).toHaveTextContent("Monday, March 9, 2026");
  });

  it("loads blocks and tasks on mount", () => {
    const plugin = createMockPlugin();
    renderView(plugin);
    expect(plugin.store.listBlocks).toHaveBeenCalled();
    expect(plugin.app.tasks.list).toHaveBeenCalled();
  });
});
