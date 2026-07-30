/**
 * P2-A11Y-005: global chords stay disabled under blocking chrome.
 */
import { describe, expect, it } from "vitest";
import { shouldEnableAppShortcuts } from "./shortcutGate";

const clear = {
  quickAddOpen: false,
  searchOpen: false,
  paletteOpen: false,
  selectedTaskId: null as string | null,
  projectModalOpen: false,
  drawerOpen: false,
};

describe("shouldEnableAppShortcuts (P2-A11Y-005)", () => {
  it("enables shortcuts when no blocking UI is open", () => {
    expect(shouldEnableAppShortcuts(clear)).toBe(true);
  });

  it("disables under Add Project modal", () => {
    expect(shouldEnableAppShortcuts({ ...clear, projectModalOpen: true })).toBe(false);
  });

  it("disables under the mobile drawer", () => {
    expect(shouldEnableAppShortcuts({ ...clear, drawerOpen: true })).toBe(false);
  });

  it("disables under existing blocking modals and detail", () => {
    expect(shouldEnableAppShortcuts({ ...clear, quickAddOpen: true })).toBe(false);
    expect(shouldEnableAppShortcuts({ ...clear, searchOpen: true })).toBe(false);
    expect(shouldEnableAppShortcuts({ ...clear, paletteOpen: true })).toBe(false);
    expect(shouldEnableAppShortcuts({ ...clear, selectedTaskId: "task-1" })).toBe(false);
  });
});
