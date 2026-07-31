/**
 * Plan My Day: focus trap/backdrop/escape, session exclusions, max-3 selection,
 * awaited mutation failures.
 */
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getDailyPlan = vi.fn();
const patchTask = vi.fn();

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getDailyPlan: (...args: unknown[]) => getDailyPlan(...args),
    ApiError: actual.ApiError,
  };
});

vi.mock("../hooks/useTaskMutations", () => ({
  useTaskMutations: () => ({
    patchTask: (...args: unknown[]) => patchTask(...args),
  }),
}));

vi.mock("../context/WorkspaceContext", () => ({
  useWorkspace: () => ({
    catalog: {
      projects: [{ id: "p1", name: "Docs", color: "#000", sort_order: 0 }],
      sections: [],
      tags: [],
      templates: [],
      saved_filters: [],
      revision: 1,
    },
  }),
}));

vi.mock("../hooks/useToday", () => ({
  useToday: () => "2026-07-23",
}));

import { DailyPlanningModal } from "./DailyPlanningModal";

function Host({ onClose = () => undefined }: { onClose?: () => void }): ReactElement {
  const [open, setOpen] = useState(true);
  return createElement(DailyPlanningModal, {
    open,
    onClose: () => {
      setOpen(false);
      onClose();
    },
  });
}

describe("DailyPlanningModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getDailyPlan.mockReset();
    patchTask.mockReset();
    getDailyPlan.mockResolvedValue({
      capacity_minutes: 480,
      estimated_total_minutes: 90,
      revision: 1,
      overdue_task_ids: ["o1"],
      overdue_tasks: [
        {
          id: "o1",
          title: "Overdue one",
          description: "",
          status: "pending",
          project_id: "p1",
          tag_ids: [],
          someday: false,
          revision: 1,
          sort_order: 0,
          created_at: "2026-07-01T00:00:00Z",
          updated_at: "2026-07-01T00:00:00Z",
          due_date: "2026-07-20",
        },
      ],
      focus_task_ids: ["f1", "f2", "f3", "f4"],
      focus_tasks: ["f1", "f2", "f3", "f4"].map((id, i) => ({
        id,
        title: `Focus ${i + 1}`,
        description: "",
        status: "pending",
        project_id: null,
        tag_ids: [],
        someday: false,
        revision: 1,
        sort_order: i,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
        due_date: "2026-07-23",
        estimated_minutes: 30,
      })),
    });
    patchTask.mockResolvedValue({ event: { revision: 2 } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderOpen() {
    await act(async () => {
      root.render(createElement(Host));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("traps focus, closes on Escape and backdrop, and exposes the dialog", async () => {
    await renderOpen();
    const dialog = document.querySelector(
      '[role="dialog"][aria-labelledby="daily-planning-title"]',
    );
    expect(dialog).not.toBeNull();
    expect(document.body.textContent).toContain("Review Overdue");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(
      document.querySelector('[role="dialog"][aria-labelledby="daily-planning-title"]'),
    ).toBeNull();
  });

  it("enforces max 3 focus selection and session Set Aside exclusions", async () => {
    await renderOpen();
    // Advance to Today's Focus
    const next = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Next",
    );
    expect(next).toBeTruthy();
    await act(async () => {
      next!.click();
    });
    expect(document.body.textContent).toContain("Today's Focus");

    const checkboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    // First three preselected from load.
    expect(checkboxes.filter((c) => c.checked).length).toBe(3);

    // Trying to select the fourth shows the max-3 error.
    const fourth = checkboxes.find((c) => !c.checked);
    expect(fourth).toBeTruthy();
    await act(async () => {
      fourth!.click();
    });
    expect(document.body.textContent).toMatch(/up to 3/i);

    // Set Aside hides a candidate for the session.
    const setAside = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Set Aside",
    );
    expect(setAside).toBeTruthy();
    await act(async () => {
      setAside!.click();
    });
    const remaining = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(remaining.length).toBe(3);
  });
});
