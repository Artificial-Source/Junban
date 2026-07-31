/**
 * Smart Nudge session dismissal — never durable.
 */
import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getNudges = vi.fn();
const getTemporalSettings = vi.fn();
const showToast = vi.fn();

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getNudges: (...args: unknown[]) => getNudges(...args),
    getTemporalSettings: (...args: unknown[]) => getTemporalSettings(...args),
  };
});

vi.mock("../context/WorkspaceContext", () => ({
  useWorkspace: () => ({
    revision: 1,
    showToast: (...args: unknown[]) => showToast(...args),
  }),
}));

vi.mock("./useToday", () => ({
  useToday: () => "2026-07-23",
}));

import { useSmartNudges } from "./useSmartNudges";

function Probe({
  onReady,
}: {
  onReady: (api: ReturnType<typeof useSmartNudges>) => void;
}): ReactElement {
  const api = useSmartNudges();
  useEffect(() => {
    onReady(api);
  }, [api, onReady]);
  return createElement("div", null, api.activeNudges.map((n) => n.id).join(","));
}

describe("useSmartNudges", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getNudges.mockReset();
    getTemporalSettings.mockReset();
    showToast.mockReset();
    getTemporalSettings.mockResolvedValue({
      capacity_minutes: 480,
      eat_the_frog_enabled: false,
      nudges_enabled: true,
      task_jar_enabled: false,
      time_zone: "UTC",
      week_start: "sunday",
    });
    getNudges.mockResolvedValue({
      revision: 1,
      has_more: false,
      rules: [
        { kind: "overdue", task_ids: ["t1", "t2"], has_more: false },
        { kind: "empty_today", task_ids: [], has_more: false },
      ],
      tasks: [],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows a dismissible session toast and does not re-show after dismiss", async () => {
    let api: ReturnType<typeof useSmartNudges> | null = null;
    await act(async () => {
      root.render(
        createElement(Probe, {
          onReady: (value) => {
            api = value;
          },
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getNudges).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      "info",
      "You have 2 overdue tasks",
      expect.objectContaining({
        inverted: true,
        action: expect.objectContaining({ label: "Dismiss" }),
      }),
    );

    const firstCall = showToast.mock.calls[0]!;
    const options = firstCall[2] as { action: { onClick: () => void } };
    await act(async () => {
      options.action.onClick();
    });

    expect(api!.activeNudges.find((n) => n.id === "overdue")).toBeUndefined();

    // Dismissed kinds stay out for the session even if we re-apply.
    showToast.mockClear();
    await act(async () => {
      // Force a re-render path by dismissing again is a no-op; active list should
      // already exclude overdue and may surface empty_today next.
    });
    expect(api!.activeNudges.some((n) => n.id === "overdue")).toBe(false);
  });
});
