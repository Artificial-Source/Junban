import { describe, expect, it } from "vitest";
import { shouldApplyStartupDefaultView, startScreenFromDefaultView } from "./startupView";

describe("startScreenFromDefaultView", () => {
  it("accepts only legacy Inbox/Today/Upcoming start screens", () => {
    expect(startScreenFromDefaultView("inbox")).toBe("inbox");
    expect(startScreenFromDefaultView("today")).toBe("today");
    expect(startScreenFromDefaultView("upcoming")).toBe("upcoming");
    expect(startScreenFromDefaultView("someday")).toBeNull();
    expect(startScreenFromDefaultView("completed")).toBeNull();
    expect(startScreenFromDefaultView("project")).toBeNull();
  });
});

describe("shouldApplyStartupDefaultView", () => {
  it("applies once on bare root and skips fixtures / already-applied", () => {
    expect(
      shouldApplyStartupDefaultView({
        pathname: "/",
        alreadyApplied: false,
        visualFixture: false,
      }),
    ).toBe(true);
    expect(
      shouldApplyStartupDefaultView({
        pathname: "/",
        alreadyApplied: true,
        visualFixture: false,
      }),
    ).toBe(false);
    expect(
      shouldApplyStartupDefaultView({
        pathname: "/",
        alreadyApplied: false,
        visualFixture: true,
      }),
    ).toBe(false);
    expect(
      shouldApplyStartupDefaultView({
        pathname: "/today",
        alreadyApplied: false,
        visualFixture: false,
      }),
    ).toBe(false);
    expect(
      shouldApplyStartupDefaultView({
        pathname: "/inbox",
        alreadyApplied: false,
        visualFixture: false,
      }),
    ).toBe(false);
  });
});
