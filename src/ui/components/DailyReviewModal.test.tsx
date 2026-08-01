/** End-of-day carry-over keeps the server's civil-day authority. */
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { todayKey } from "../lib/dates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const testEnvironment = (
  globalThis as unknown as {
    process: { env: Record<string, string | undefined> };
  }
).process.env;
const getEndOfDayPlan = vi.fn();
const patchTask = vi.fn();

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getEndOfDayPlan: (...args: unknown[]) => getEndOfDayPlan(...args),
    ApiError: actual.ApiError,
  };
});

vi.mock("../hooks/useTaskMutations", () => ({
  useTaskMutations: () => ({
    patchTask: (...args: unknown[]) => patchTask(...args),
  }),
}));

import { DailyReviewModal } from "./DailyReviewModal";

function Host(): ReactElement {
  const [open, setOpen] = useState(true);
  return createElement(DailyReviewModal, { open, onClose: () => setOpen(false) });
}

describe("DailyReviewModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getEndOfDayPlan.mockReset();
    patchTask.mockReset();
    getEndOfDayPlan.mockResolvedValue({
      as_of_date: "2026-07-24",
      win_task_ids: [],
      win_tasks: [],
      carry_over_task_ids: ["carry-1"],
      carry_over_tasks: [
        {
          id: "carry-1",
          title: "Carry this forward",
          description: "",
          status: "pending",
          someday: false,
          tag_ids: [],
          sort_order: 0,
          revision: 1,
          created_at: "2026-07-20T00:00:00Z",
          updated_at: "2026-07-20T00:00:00Z",
          due_date: "2026-07-24",
        },
      ],
      tomorrow_task_ids: [],
      tomorrow_tasks: [],
      tomorrow_estimated_minutes: 0,
      completion_rate_percent: 0,
      capacity_minutes: 480,
      revision: 1,
    });
    patchTask.mockResolvedValue({ event: { revision: 2 } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("uses the server review date for carry-over in a browser timezone one day behind", async () => {
    const originalTimeZone = testEnvironment.TZ;
    try {
      testEnvironment.TZ = "America/Los_Angeles";
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-24T00:30:00Z"));
      expect(todayKey()).toBe("2026-07-23");

      await act(async () => {
        root.render(createElement(Host));
      });
      await act(async () => {
        await Promise.resolve();
      });
      const next = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Next",
      );
      expect(next).toBeTruthy();
      await act(async () => {
        next!.click();
      });
      const moveToTomorrow = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Move to Tomorrow",
      );
      expect(moveToTomorrow).toBeTruthy();
      await act(async () => {
        moveToTomorrow!.click();
      });

      expect(patchTask).toHaveBeenCalledWith(
        "carry-1",
        { due_date: "2026-07-25" },
        "Move to tomorrow",
      );
    } finally {
      vi.useRealTimers();
      if (originalTimeZone === undefined) delete testEnvironment.TZ;
      else testEnvironment.TZ = originalTimeZone;
    }
  });
});
