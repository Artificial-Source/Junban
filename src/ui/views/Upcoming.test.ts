import { describe, expect, it } from "vitest";
import type { TaskDto } from "../api/client";
import { partitionUpcomingByAsOfDate } from "./Upcoming";

function makeTask(
  overrides: Partial<TaskDto> & Pick<TaskDto, "id" | "title" | "due_date">,
): TaskDto {
  return {
    created_at: "2026-07-28T00:00:00Z",
    updated_at: "2026-07-28T00:00:00Z",
    status: "pending",
    revision: 1,
    completed_at: null,
    description: "",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    ...overrides,
  };
}

describe("partitionUpcomingByAsOfDate", () => {
  it("partitions with response asOfDate, not a mismatched browser today", () => {
    // Browser local day might be 2026-07-27 while the list response says 2026-07-29.
    const browserToday = "2026-07-27";
    const asOfDate = "2026-07-29";
    const tasks = [
      makeTask({ id: "overdue", title: "Was future on browser day", due_date: "2026-07-28" }),
      makeTask({ id: "as-of", title: "Due on server as-of day", due_date: asOfDate }),
      makeTask({ id: "future", title: "Still upcoming", due_date: "2026-07-30" }),
    ];

    const withServerDate = partitionUpcomingByAsOfDate(tasks, asOfDate);
    expect(withServerDate.overdueTasks.map((task) => task.id)).toEqual(["overdue"]);
    expect(withServerDate.upcomingTasks.map((task) => task.id)).toEqual(["future"]);

    // Using the browser day would mis-bucket the 28th as upcoming and include the 29th.
    const withBrowserDate = partitionUpcomingByAsOfDate(tasks, browserToday);
    expect(withBrowserDate.overdueTasks.map((task) => task.id)).toEqual([]);
    expect(withBrowserDate.upcomingTasks.map((task) => task.id)).toEqual([
      "overdue",
      "as-of",
      "future",
    ]);
  });
});
