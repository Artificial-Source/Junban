/** Stats cards render the Rust aggregate response without client-side fixtures. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsResponse } from "../api/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getStats = vi.fn<(params: { from: string; to: string }) => Promise<StatsResponse>>();

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getStats: (...args: [{ from: string; to: string }]) => getStats(...args),
  };
});

vi.mock("../hooks/useToday", () => ({ useToday: () => "2026-07-23" }));

import { Stats } from "./Stats";

const rustStats: StatsResponse = {
  revision: 7,
  from: "2026-07-17",
  to: "2026-07-23",
  days: [
    { date: "2026-07-17", completions: 1, creations: 2, completion_minutes: 45 },
    { date: "2026-07-23", completions: 3, creations: 1, completion_minutes: 150 },
  ],
  current_streak_days: 4,
  estimate_accuracy_percent: 80,
  estimate_accuracy_samples: 2,
  average_estimated_minutes: 75,
  average_actual_minutes: 90,
  total_completion_minutes: 195,
  total_completions: 4,
  total_creations: 3,
};

describe("Stats", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getStats.mockReset().mockResolvedValue(rustStats);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders Rust-derived aggregates for the normal runtime route", async () => {
    await act(async () => {
      root.render(createElement(Stats));
      await Promise.resolve();
    });

    expect(getStats).toHaveBeenCalledWith({ from: "2026-07-17", to: "2026-07-23" });
    expect(container.textContent).toContain("3");
    expect(container.textContent).toContain("4");
    expect(container.textContent).toContain("3.3h");
    expect(container.textContent).toContain("80%");
    expect(container.textContent).toContain("1.3h → 1.5h");
  });
});
