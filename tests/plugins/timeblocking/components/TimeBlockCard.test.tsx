import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { TimeBlockCard } from "../../../../src/plugins/builtin/timeblocking/components/TimeBlockCard.js";
import type { TimeBlock } from "../../../../src/plugins/builtin/timeblocking/types.js";

function makeBlock(overrides: Partial<TimeBlock> = {}): TimeBlock {
  return {
    id: "block-1",
    title: "Focus Time",
    date: "2026-03-09",
    startTime: "09:00",
    endTime: "10:00",
    locked: false,
    createdAt: "2026-03-09T00:00:00Z",
    updatedAt: "2026-03-09T00:00:00Z",
    ...overrides,
  };
}

function renderCard(overrides: Record<string, unknown> = {}) {
  const defaults = {
    block: makeBlock(),
    pixelsPerHour: 80,
    workDayStart: "09:00",
    onResizeStart: vi.fn(),
    onClick: vi.fn(),
    ...overrides,
  };

  return render(
    <DndContext>
      <div style={{ position: "relative", height: 800 }}>
        <TimeBlockCard {...(defaults as React.ComponentProps<typeof TimeBlockCard>)} />
      </div>
    </DndContext>,
  );
}

describe("TimeBlockCard", () => {
  it("renders title", () => {
    renderCard();
    expect(screen.getByText("Focus Time")).toBeInTheDocument();
  });

  it("renders time range and duration for blocks >= 45 min", () => {
    renderCard({
      block: makeBlock({ startTime: "09:00", endTime: "10:30" }),
    });
    expect(screen.getByText(/09:00 – 10:30/)).toBeInTheDocument();
    expect(screen.getByText(/1h 30m/)).toBeInTheDocument();
  });

  it("shows compact mode (no time range) for blocks < 45 min", () => {
    renderCard({
      block: makeBlock({ startTime: "09:00", endTime: "09:30" }),
    });
    expect(screen.getByText("Focus Time")).toBeInTheDocument();
    // Time range should not be visible in compact mode
    expect(screen.queryByText(/09:00 – 09:30/)).not.toBeInTheDocument();
  });

  it("calculates correct position", () => {
    const { container } = renderCard({
      block: makeBlock({ startTime: "10:00", endTime: "11:00" }),
      pixelsPerHour: 80,
      workDayStart: "09:00",
    });
    const card = container.querySelector("[data-block-id]") as HTMLElement;
    // top = ((600 - 540) / 60) * 80 = 80px
    expect(card.style.top).toBe("80px");
    // height = (60 / 60) * 80 = 80px
    expect(card.style.height).toBe("80px");
  });

  it("shows lock icon when locked", () => {
    renderCard({ block: makeBlock({ locked: true }) });
    // Lock icon from lucide-react
    const svg = screen.getByTestId("time-block-block-1").querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("shows repeat icon when recurring", () => {
    renderCard({
      block: makeBlock({
        recurrenceRule: { frequency: "daily", interval: 1 },
      }),
    });
    const testBlock = screen.getByTestId("time-block-block-1");
    const svgs = testBlock.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThan(0);
  });

  it("shows conflict indicator (red border)", () => {
    renderCard({ isConflicting: true });
    const card = screen.getByTestId("time-block-block-1");
    expect(card.className).toContain("border-l-error");
  });

  it("shows task checkbox when linked to a task", () => {
    renderCard({ block: makeBlock({ taskId: "task-1" }) });
    const card = screen.getByTestId("time-block-block-1");
    const checkbox = card.querySelector(".rounded-full.border-2");
    expect(checkbox).toBeInTheDocument();
  });

  it("calls onClick when clicked", async () => {
    const onClick = vi.fn();
    renderCard({ onClick });
    const card = screen.getByTestId("time-block-block-1");
    card.click();
    expect(onClick).toHaveBeenCalledWith("block-1");
  });
});
