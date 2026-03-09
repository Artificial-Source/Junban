import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
      ui: {
        statusBarItems: [],
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
      set: vi.fn(),
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

// Helper to match matchMedia for mobile tests
function _setMobileViewport() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("TimeblockingView - Extended", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 9, 10, 0)); // Monday March 9
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("N-day view switching", () => {
    it("defaults to day view", () => {
      renderView();
      screen.getByTestId("view-mode-selector");
      // Day button should have accent background
      const dayButton = screen.getByTestId("view-mode-1");
      expect(dayButton.className).toContain("bg-accent");
    });

    it("switches to week view via button", () => {
      renderView();
      fireEvent.click(screen.getByTestId("view-mode-7"));
      // Should show multiple column headers
      expect(screen.getByTestId("column-header-2026-03-09")).toBeInTheDocument();
      expect(screen.getByTestId("column-header-2026-03-15")).toBeInTheDocument();
    });

    it("switches to 3-day view via button", () => {
      renderView();
      fireEvent.click(screen.getByTestId("view-mode-3"));
      expect(screen.getByTestId("column-header-2026-03-09")).toBeInTheDocument();
      expect(screen.getByTestId("column-header-2026-03-11")).toBeInTheDocument();
      expect(screen.queryByTestId("column-header-2026-03-12")).not.toBeInTheDocument();
    });

    it("switches to day view via D key", () => {
      renderView();
      // First switch to week
      fireEvent.click(screen.getByTestId("view-mode-7"));
      expect(screen.getByTestId("column-header-2026-03-15")).toBeInTheDocument();
      // Then press D
      fireEvent.keyDown(window, { key: "D" });
      expect(screen.queryByTestId("column-header-2026-03-15")).not.toBeInTheDocument();
    });

    it("switches to week view via W key", () => {
      renderView();
      fireEvent.keyDown(window, { key: "W" });
      expect(screen.getByTestId("column-header-2026-03-09")).toBeInTheDocument();
      expect(screen.getByTestId("column-header-2026-03-15")).toBeInTheDocument();
    });

    it("switches day count via number keys 1-7", () => {
      renderView();
      fireEvent.keyDown(window, { key: "5" });
      // 5-day view from Monday March 9
      expect(screen.getByTestId("column-header-2026-03-09")).toBeInTheDocument();
      expect(screen.getByTestId("column-header-2026-03-13")).toBeInTheDocument();
      expect(screen.queryByTestId("column-header-2026-03-14")).not.toBeInTheDocument();
    });
  });

  describe("Date range navigation", () => {
    it("advances by dayCount in week view", () => {
      renderView();
      fireEvent.keyDown(window, { key: "W" }); // Switch to week view
      fireEvent.click(screen.getByLabelText("Next day"));
      // Should advance by 7 days: March 16 – March 22
      expect(screen.getByTestId("column-header-2026-03-16")).toBeInTheDocument();
    });

    it("goes back by dayCount in week view", () => {
      renderView();
      fireEvent.keyDown(window, { key: "W" });
      fireEvent.click(screen.getByLabelText("Previous day"));
      // Should go back by 7 days: March 2 – March 8
      expect(screen.getByTestId("column-header-2026-03-02")).toBeInTheDocument();
    });

    it("today button works in all view modes", () => {
      renderView();
      fireEvent.keyDown(window, { key: "W" });
      fireEvent.click(screen.getByLabelText("Next day"));
      fireEvent.click(screen.getByLabelText("Next day"));
      // Now showing March 23-29
      expect(screen.getByTestId("column-header-2026-03-23")).toBeInTheDocument();
      // Click today
      fireEvent.click(screen.getByText("Today"));
      expect(screen.getByTestId("column-header-2026-03-09")).toBeInTheDocument();
    });
  });

  describe("Split view layout", () => {
    it("renders sidebar toggle button", () => {
      renderView();
      expect(screen.getByTestId("sidebar-toggle")).toBeInTheDocument();
    });

    it("toggles sidebar collapse", () => {
      renderView();
      // Sidebar should be visible initially
      expect(screen.getByText("Tasks")).toBeInTheDocument();

      // Toggle collapse
      fireEvent.click(screen.getByTestId("sidebar-toggle"));
      expect(screen.queryByText("Tasks")).not.toBeInTheDocument();

      // Toggle expand
      fireEvent.click(screen.getByTestId("sidebar-toggle"));
      expect(screen.getByText("Tasks")).toBeInTheDocument();
    });

    it("toggles sidebar via S key", () => {
      renderView();
      expect(screen.getByText("Tasks")).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "s" });
      expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
      fireEvent.keyDown(window, { key: "s" });
      expect(screen.getByText("Tasks")).toBeInTheDocument();
    });

    it("renders resize divider", () => {
      renderView();
      expect(screen.getByTestId("sidebar-divider")).toBeInTheDocument();
    });
  });

  describe("View mode selector", () => {
    it("renders all view mode buttons", () => {
      renderView();
      expect(screen.getByTestId("view-mode-1")).toHaveTextContent("Day");
      expect(screen.getByTestId("view-mode-3")).toHaveTextContent("3D");
      expect(screen.getByTestId("view-mode-5")).toHaveTextContent("5D");
      expect(screen.getByTestId("view-mode-7")).toHaveTextContent("Week");
    });

    it("highlights active view mode", () => {
      renderView();
      expect(screen.getByTestId("view-mode-1").className).toContain("bg-accent");
      expect(screen.getByTestId("view-mode-7").className).not.toContain("bg-accent");

      fireEvent.click(screen.getByTestId("view-mode-7"));
      expect(screen.getByTestId("view-mode-7").className).toContain("bg-accent");
      expect(screen.getByTestId("view-mode-1").className).not.toContain("bg-accent");
    });
  });

  describe("Data loading", () => {
    it("uses listBlocksInRange for multi-day views", () => {
      const plugin = createMockPlugin();
      renderView(plugin);
      fireEvent.keyDown(window, { key: "W" });
      expect(plugin.store.listBlocksInRange).toHaveBeenCalled();
      expect(plugin.store.listSlotsInRange).toHaveBeenCalled();
    });

    it("uses listBlocks for single-day view", () => {
      const plugin = createMockPlugin();
      renderView(plugin);
      expect(plugin.store.listBlocks).toHaveBeenCalled();
      expect(plugin.store.listSlots).toHaveBeenCalled();
    });
  });
});
