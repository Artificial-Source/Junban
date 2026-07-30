import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TodayHeader } from "./TodayHeader";

describe("TodayHeader Phase 2 scope", () => {
  it("does not render Phase 3 Plan My Day or End of Day controls", () => {
    const markup = renderToStaticMarkup(
      <TodayHeader totalCount={3} todayCompletedCount={1} ringTotal={2} />,
    );
    expect(markup).toContain("Today");
    expect(markup).toContain("3 tasks");
    expect(markup).not.toContain("Plan My Day");
    expect(markup).not.toContain("End of Day");
    expect(markup).not.toContain("unavailable");
  });
});
