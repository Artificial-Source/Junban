import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FocusTimer, isBlockActive, formatRemaining } from "../../../../src/plugins/builtin/timeblocking/components/FocusTimer.js";
import type { TimeBlock } from "../../../../src/plugins/builtin/timeblocking/types.js";

function formatDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function createBlock(overrides?: Partial<TimeBlock>): TimeBlock {
  const now = new Date();
  const startMinutes = now.getHours() * 60 + now.getMinutes() - 10;
  const endMinutes = startMinutes + 60;
  const startH = String(Math.floor(startMinutes / 60)).padStart(2, "0");
  const startM = String(startMinutes % 60).padStart(2, "0");
  const endH = String(Math.floor(endMinutes / 60)).padStart(2, "0");
  const endM = String(endMinutes % 60).padStart(2, "0");

  return {
    id: "block-1",
    title: "Focus Work",
    date: formatDateStr(now),
    startTime: `${startH}:${startM}`,
    endTime: `${endH}:${endM}`,
    locked: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

describe("FocusTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows Focus button for active block", () => {
    const block = createBlock();
    render(<FocusTimer block={block} />);
    expect(screen.getByTestId("focus-start")).toBeInTheDocument();
    expect(screen.getByText("Focus")).toBeInTheDocument();
  });

  it("does not render for non-active block (different date)", () => {
    const block = createBlock({ date: "2020-01-01" });
    const { container } = render(<FocusTimer block={block} />);
    expect(container.firstChild).toBeNull();
  });

  it("starts focus and shows remaining time", () => {
    const block = createBlock();
    render(<FocusTimer block={block} />);
    fireEvent.click(screen.getByTestId("focus-start"));
    expect(screen.getByTestId("focus-active")).toBeInTheDocument();
    expect(screen.getByText(/remaining/)).toBeInTheDocument();
  });

  it("stops focus when stop button clicked", () => {
    const block = createBlock();
    render(<FocusTimer block={block} />);
    fireEvent.click(screen.getByTestId("focus-start"));
    expect(screen.getByTestId("focus-active")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("focus-stop"));
    // Should go back to showing the Focus button
    expect(screen.getByTestId("focus-start")).toBeInTheDocument();
  });

  it("calls onStatusUpdate when focusing", () => {
    const onStatusUpdate = vi.fn();
    const block = createBlock();
    render(<FocusTimer block={block} onStatusUpdate={onStatusUpdate} />);
    fireEvent.click(screen.getByTestId("focus-start"));
    expect(onStatusUpdate).toHaveBeenCalledWith(
      expect.stringContaining("Focus: Focus Work"),
    );
  });

  it("calls onStatusUpdate with empty string when stopping", () => {
    const onStatusUpdate = vi.fn();
    const block = createBlock();
    render(<FocusTimer block={block} onStatusUpdate={onStatusUpdate} />);
    fireEvent.click(screen.getByTestId("focus-start"));
    onStatusUpdate.mockClear();
    fireEvent.click(screen.getByTestId("focus-stop"));
    expect(onStatusUpdate).toHaveBeenCalledWith("");
  });
});

describe("formatRemaining", () => {
  it("formats 0 minutes", () => {
    expect(formatRemaining(0)).toBe("0m");
  });

  it("formats minutes only", () => {
    expect(formatRemaining(45)).toBe("45m");
  });

  it("formats hours only", () => {
    expect(formatRemaining(120)).toBe("2h");
  });

  it("formats hours and minutes", () => {
    expect(formatRemaining(90)).toBe("1h 30m");
  });
});

describe("isBlockActive", () => {
  it("returns true for block within current time", () => {
    const block = createBlock();
    expect(isBlockActive(block)).toBe(true);
  });

  it("returns false for block on a different date", () => {
    const block = createBlock({ date: "2020-01-01" });
    expect(isBlockActive(block)).toBe(false);
  });

  it("returns false for block in the future", () => {
    const block = createBlock({ startTime: "23:50", endTime: "23:59" });
    // Only fails if current time is not 23:50-23:59
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (nowMinutes < 23 * 60 + 50) {
      expect(isBlockActive(block)).toBe(false);
    }
  });
});
