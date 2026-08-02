import { describe, expect, it } from "vitest";
import type { TaskDto } from "../../api/client";
import {
  CALENDAR_MAX_RANGE_DAYS,
  addCivilDays,
  calendarRequestRange,
  groupTasksByDueDate,
  inclusiveDayCount,
  splitDayTasks,
  toCivilDateKey,
  weekStartToDayNumber,
} from "./calendarRange";

function task(partial: Partial<TaskDto> & { id: string; title: string }): TaskDto {
  return {
    description: "",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    status: "pending",
    created_at: "2026-07-23T00:00:00Z",
    updated_at: "2026-07-23T00:00:00Z",
    revision: 1,
    ...partial,
  };
}

describe("calendar civil-date grouping", () => {
  it("groups by exact due_date civil keys without UTC shifting", () => {
    const tasks = [
      task({ id: "a", title: "A", due_date: "2026-07-23" }),
      task({ id: "b", title: "B", due_date: "2026-07-23" }),
      task({ id: "c", title: "C", due_date: "2026-07-24" }),
      task({ id: "d", title: "D", due_date: null }),
    ];
    const grouped = groupTasksByDueDate(tasks);
    expect(grouped.get("2026-07-23")?.map((t) => t.id)).toEqual(["a", "b"]);
    expect(grouped.get("2026-07-24")?.map((t) => t.id)).toEqual(["c"]);
    expect(grouped.has("2026-07-22")).toBe(false);
  });

  it("splits timed vs all-day using due_time only", () => {
    const tasks = [
      task({ id: "all", title: "All day", due_date: "2026-07-23" }),
      task({
        id: "timed",
        title: "Timed",
        due_date: "2026-07-23",
        due_time: { time: "09:30", time_zone: "UTC" },
      }),
      task({
        id: "later",
        title: "Later",
        due_date: "2026-07-23",
        due_time: { time: "14:00", time_zone: "UTC" },
      }),
    ];
    const { allDayTasks, timedTasks } = splitDayTasks(tasks);
    expect(allDayTasks.map((t) => t.id)).toEqual(["all"]);
    expect(timedTasks.map((t) => t.id)).toEqual(["timed", "later"]);
  });

  it("keeps month request ranges within the 42-day bound", () => {
    const selected = new Date(2026, 6, 15); // July 15, 2026
    const range = calendarRequestRange(selected, "month", 0);
    expect(inclusiveDayCount(range.from, range.to)).toBe(CALENDAR_MAX_RANGE_DAYS);
    expect(inclusiveDayCount(range.from, range.to)).toBeLessThanOrEqual(42);
  });

  it("builds single-day and week ranges from local civil dates", () => {
    const selected = new Date(2026, 6, 23); // Thursday
    expect(calendarRequestRange(selected, "day", 0)).toEqual({
      from: "2026-07-23",
      to: "2026-07-23",
    });
    const week = calendarRequestRange(selected, "week", 0); // Sunday start
    expect(week.from).toBe("2026-07-19");
    expect(week.to).toBe("2026-07-25");
    expect(toCivilDateKey(selected)).toBe("2026-07-23");
    expect(addCivilDays("2026-07-23", 1)).toBe("2026-07-24");
    const saturdayWeek = calendarRequestRange(selected, "week", 6);
    expect(saturdayWeek.from).toBe("2026-07-18");
    expect(saturdayWeek.to).toBe("2026-07-24");
  });

  it("maps week_start enums onto JS day numbers", () => {
    expect(weekStartToDayNumber("sunday")).toBe(0);
    expect(weekStartToDayNumber("monday")).toBe(1);
    expect(weekStartToDayNumber("saturday")).toBe(6);
  });
});
