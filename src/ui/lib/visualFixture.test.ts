import { describe, expect, it } from "vitest";
import { isVisualFixture } from "./visualFixture";

describe("isVisualFixture", () => {
  it("matches only the explicitly requested fixture", () => {
    expect(isVisualFixture("?visual-fixture=phase-2", "phase-2")).toBe(true);
    expect(isVisualFixture("?visual-fixture=phase-3", "phase-2")).toBe(false);
    expect(isVisualFixture("?focus=1", "phase-2")).toBe(false);
  });
});
