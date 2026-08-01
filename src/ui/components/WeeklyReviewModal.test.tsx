/**
 * Weekly Review consumes the prior-complete-week range from the Rust response.
 */
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getWeeklyReview = vi.fn();

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getWeeklyReview: (...args: unknown[]) => getWeeklyReview(...args),
  };
});

vi.mock("../context/WorkspaceContext", () => ({
  useWorkspace: () => ({
    catalog: {
      projects: [{ id: "proj-1", name: "Website Redesign", color: "#000", sort_order: 0 }],
      sections: [],
      tags: [],
      templates: [],
      saved_filters: [],
      revision: 1,
    },
  }),
}));

import { WeeklyReviewModal } from "./WeeklyReviewModal";

function Host(): ReactElement {
  const [open, setOpen] = useState(true);
  return createElement(WeeklyReviewModal, { open, onClose: () => setOpen(false) });
}

describe("WeeklyReviewModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getWeeklyReview.mockReset();
    getWeeklyReview.mockResolvedValue({
      // The normal API call omits week_start, so this Sunday-based range is Rust's default.
      week_start: "2026-07-19",
      week_end: "2026-07-25",
      completed_count: 9,
      created_count: 0,
      cancelled_count: 1,
      completion_rate_percent: 100,
      streak_days: 7,
      busiest_day: "2026-07-14",
      dominant_completion_bucket: "morning",
      completion_time_buckets: { morning: 4, afternoon: 3, evening: 2, night: 0 },
      daily: [
        { date: "2026-07-19", completed: 1, created: 0 },
        { date: "2026-07-20", completed: 3, created: 0 },
        { date: "2026-07-21", completed: 2, created: 0 },
        { date: "2026-07-22", completed: 3, created: 0 },
        { date: "2026-07-23", completed: 0, created: 0 },
        { date: "2026-07-24", completed: 0, created: 0 },
        { date: "2026-07-25", completed: 0, created: 0 },
      ],
      top_accomplishment_ids: [],
      top_accomplishment_tasks: [],
      overdue_task_ids: [],
      overdue_tasks: [],
      neglected_projects: [{ project_id: "proj-1", overdue_count: 1, reason: "overdue_tasks" }],
      suggestions: [{ kind: "keep_streak", days: 7 }],
      revision: 1,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the Rust default Sunday week range and aggregate facts", async () => {
    await act(async () => {
      root.render(createElement(Host));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getWeeklyReview).toHaveBeenCalledTimes(1);
    expect(getWeeklyReview).toHaveBeenCalledWith();
    expect(document.body.textContent).toMatch(/Jul 19 - 25|Jul 19 - Jul 25/);
    expect(document.body.textContent).toContain("Weekly Review");
    expect(document.body.textContent).toContain("Neglected Projects");
    expect(document.body.textContent).toContain("Website Redesign");
    expect(document.body.textContent).toContain("1 overdue task");
    expect(document.body.textContent).toMatch(/Keep your 7-day streak/);
  });
});
