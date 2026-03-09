import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReplanBanner } from "../../../../src/plugins/builtin/timeblocking/components/ReplanBanner.js";
import type { TimeBlockStore } from "../../../../src/plugins/builtin/timeblocking/store.js";

function formatDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function createMockStore(staleBlocks: Array<{ id: string; title: string; date: string; startTime: string; endTime: string; taskId?: string }>): TimeBlockStore {
  return {
    listBlocksInRange: vi.fn().mockReturnValue(
      staleBlocks.map((b) => ({
        ...b,
        locked: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
    ),
    updateBlock: vi.fn().mockResolvedValue({}),
    deleteBlock: vi.fn().mockResolvedValue(undefined),
  } as unknown as TimeBlockStore;
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatDateStr(d);
}

describe("ReplanBanner", () => {
  const onReplanComplete = vi.fn();

  beforeEach(() => {
    onReplanComplete.mockClear();
  });

  it("does not show when no stale blocks exist", () => {
    const store = createMockStore([]);
    render(
      <ReplanBanner store={store} onReplanComplete={onReplanComplete} />,
    );
    expect(screen.queryByTestId("replan-banner")).not.toBeInTheDocument();
  });

  it("shows banner when stale blocks exist with pending tasks", () => {
    const store = createMockStore([
      { id: "b1", title: "Meeting", date: yesterdayStr(), startTime: "09:00", endTime: "10:00", taskId: "t1" },
    ]);
    const taskStatuses = new Map<string, "pending" | "completed" | "cancelled">([
      ["t1", "pending"],
    ]);
    render(
      <ReplanBanner store={store} taskStatuses={taskStatuses} onReplanComplete={onReplanComplete} />,
    );
    expect(screen.getByTestId("replan-banner")).toBeInTheDocument();
    expect(screen.getByText(/1/)).toBeInTheDocument();
    expect(screen.getByText(/incomplete/)).toBeInTheDocument();
  });

  it("does not show blocks for completed tasks", () => {
    const store = createMockStore([
      { id: "b1", title: "Meeting", date: yesterdayStr(), startTime: "09:00", endTime: "10:00", taskId: "t1" },
    ]);
    const taskStatuses = new Map<string, "pending" | "completed" | "cancelled">([
      ["t1", "completed"],
    ]);
    render(
      <ReplanBanner store={store} taskStatuses={taskStatuses} onReplanComplete={onReplanComplete} />,
    );
    expect(screen.queryByTestId("replan-banner")).not.toBeInTheDocument();
  });

  it("opens replan modal when clicking Replan button", () => {
    const store = createMockStore([
      { id: "b1", title: "Meeting", date: yesterdayStr(), startTime: "09:00", endTime: "10:00" },
    ]);
    render(
      <ReplanBanner store={store} onReplanComplete={onReplanComplete} />,
    );
    fireEvent.click(screen.getByTestId("replan-open-btn"));
    expect(screen.getByTestId("replan-modal")).toBeInTheDocument();
  });

  it("replans a single block to today", async () => {
    const store = createMockStore([
      { id: "b1", title: "Meeting", date: yesterdayStr(), startTime: "09:00", endTime: "10:00" },
    ]);
    render(
      <ReplanBanner store={store} onReplanComplete={onReplanComplete} />,
    );
    fireEvent.click(screen.getByTestId("replan-open-btn"));
    fireEvent.click(screen.getByTestId("replan-today-b1"));
    await waitFor(() => {
      expect(store.updateBlock).toHaveBeenCalledWith("b1", { date: formatDateStr(new Date()) });
    });
  });

  it("replans all blocks to today", async () => {
    const store = createMockStore([
      { id: "b1", title: "Meeting", date: yesterdayStr(), startTime: "09:00", endTime: "10:00" },
      { id: "b2", title: "Code review", date: yesterdayStr(), startTime: "10:00", endTime: "11:00" },
    ]);
    render(
      <ReplanBanner store={store} onReplanComplete={onReplanComplete} />,
    );
    fireEvent.click(screen.getByTestId("replan-open-btn"));
    fireEvent.click(screen.getByTestId("replan-all-today"));
    await waitFor(() => {
      expect(store.updateBlock).toHaveBeenCalledTimes(2);
      expect(onReplanComplete).toHaveBeenCalled();
    });
  });

  it("skips (deletes) a block", async () => {
    const store = createMockStore([
      { id: "b1", title: "Meeting", date: yesterdayStr(), startTime: "09:00", endTime: "10:00" },
    ]);
    render(
      <ReplanBanner store={store} onReplanComplete={onReplanComplete} />,
    );
    fireEvent.click(screen.getByTestId("replan-open-btn"));
    fireEvent.click(screen.getByText("Skip"));
    await waitFor(() => {
      expect(store.deleteBlock).toHaveBeenCalledWith("b1");
    });
  });

  it("dismisses banner when clicking X", () => {
    const store = createMockStore([
      { id: "b1", title: "Meeting", date: yesterdayStr(), startTime: "09:00", endTime: "10:00" },
    ]);
    render(
      <ReplanBanner store={store} onReplanComplete={onReplanComplete} />,
    );
    expect(screen.getByTestId("replan-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByTestId("replan-banner")).not.toBeInTheDocument();
  });
});
