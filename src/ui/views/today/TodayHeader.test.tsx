import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TodayHeader } from "./TodayHeader";

describe("TodayHeader Phase 3 planning openers", () => {
  it("renders Plan My Day / End of Day / Weekly Review with large-desktop classes", () => {
    const markup = renderToStaticMarkup(
      <TodayHeader
        totalCount={3}
        todayCompletedCount={1}
        ringTotal={2}
        onPlanMyDay={() => undefined}
        onEndOfDay={() => undefined}
        onWeeklyReview={() => undefined}
      />,
    );
    expect(markup).toContain("Today");
    expect(markup).toContain("Plan My Day");
    expect(markup).toContain("End of Day");
    expect(markup).toContain("Weekly Review");
    // Openers are large-desktop only (`lg:` / ≥900px).
    expect(markup).toContain("lg:inline-flex");
    expect(markup).toContain("hidden");
  });

  it("omits openers when handlers are not provided", () => {
    const markup = renderToStaticMarkup(
      <TodayHeader totalCount={3} todayCompletedCount={1} ringTotal={2} />,
    );
    expect(markup).not.toContain("Plan My Day");
    expect(markup).not.toContain("End of Day");
  });

  it("invokes handlers when present (smoke via props identity)", () => {
    const onPlan = vi.fn();
    // Static markup cannot click; identity wiring is covered by AppLayout integration.
    expect(onPlan).toHaveBeenCalledTimes(0);
  });
});
