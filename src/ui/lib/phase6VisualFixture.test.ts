import { describe, expect, it } from "vitest";
import {
  isPhase6VisualFixture,
  PHASE6_SCENE_IDS,
  readPhase6VisualScene,
} from "./phase6VisualFixture";

describe("phase6VisualFixture", () => {
  it("activates only for exact phase-6 fixture + allowlisted scene", () => {
    expect(
      readPhase6VisualScene("?visual-fixture=phase-6&scene=ai-welcome-briefing-desktop-light"),
    ).toBe("ai-welcome-briefing-desktop-light");
    expect(isPhase6VisualFixture("?visual-fixture=phase-6&scene=ptt-error-desktop-light")).toBe(
      true,
    );
  });

  it("rejects other fixtures, missing scene, and unknown scene ids", () => {
    expect(
      readPhase6VisualScene("?visual-fixture=phase-4&scene=ai-welcome-briefing-desktop-light"),
    ).toBe(null);
    expect(readPhase6VisualScene("?visual-fixture=phase-6")).toBe(null);
    expect(readPhase6VisualScene("?visual-fixture=phase-6&scene=not-a-scene")).toBe(null);
    expect(isPhase6VisualFixture("")).toBe(false);
  });

  it("freezes exactly sixteen allowlisted scenes", () => {
    expect(PHASE6_SCENE_IDS).toHaveLength(16);
  });
});
