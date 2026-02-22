import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const mockRegister = vi.fn();
const mockUnregister = vi.fn();
const mockLoadCustomBindings = vi.fn();
const mockHandleKeyDown = vi.fn();

vi.mock("../../../src/ui/shortcutManagerInstance.js", () => ({
  shortcutManager: {
    register: (...args: any[]) => mockRegister(...args),
    unregister: (...args: any[]) => mockUnregister(...args),
    loadCustomBindings: (...args: any[]) => mockLoadCustomBindings(...args),
    handleKeyDown: (...args: any[]) => mockHandleKeyDown(...args),
  },
}));

vi.mock("../../../src/ui/themes/manager.js", () => ({
  themeManager: {
    toggle: vi.fn(),
  },
}));

const mockGetAppSetting = vi.fn();

vi.mock("../../../src/ui/api/index.js", () => ({
  api: {
    getAppSetting: (...args: any[]) => mockGetAppSetting(...args),
  },
}));

import { useAppShortcuts } from "../../../src/ui/hooks/useAppShortcuts.js";

describe("useAppShortcuts", () => {
  const setCommandPaletteOpen = vi.fn();
  const undo = vi.fn();
  const redo = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAppSetting.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers core shortcuts on mount", () => {
    renderHook(() => useAppShortcuts(setCommandPaletteOpen, undo, redo));

    const registeredIds = mockRegister.mock.calls.map((c: any[]) => c[0].id);
    expect(registeredIds).toContain("command-palette");
    expect(registeredIds).toContain("toggle-dark-mode");
    expect(registeredIds).toContain("undo");
    expect(registeredIds).toContain("redo");
  });

  it("registers search shortcut when setSearchOpen is provided", () => {
    const setSearchOpen = vi.fn();
    renderHook(() => useAppShortcuts(setCommandPaletteOpen, undo, redo, setSearchOpen));

    const registeredIds = mockRegister.mock.calls.map((c: any[]) => c[0].id);
    expect(registeredIds).toContain("search");
  });

  it("does not register search shortcut when setSearchOpen is undefined", () => {
    renderHook(() => useAppShortcuts(setCommandPaletteOpen, undo, redo));

    const registeredIds = mockRegister.mock.calls.map((c: any[]) => c[0].id);
    expect(registeredIds).not.toContain("search");
  });

  it("registers focus mode shortcut when setFocusModeOpen is provided", () => {
    const setFocusModeOpen = vi.fn();
    renderHook(() =>
      useAppShortcuts(setCommandPaletteOpen, undo, redo, undefined, setFocusModeOpen),
    );

    const registeredIds = mockRegister.mock.calls.map((c: any[]) => c[0].id);
    expect(registeredIds).toContain("focus-mode");
  });

  it("registers quick-add shortcuts when setQuickAddOpen is provided", () => {
    const setQuickAddOpen = vi.fn();
    renderHook(() =>
      useAppShortcuts(setCommandPaletteOpen, undo, redo, undefined, undefined, setQuickAddOpen),
    );

    const registeredIds = mockRegister.mock.calls.map((c: any[]) => c[0].id);
    expect(registeredIds).toContain("quick-add");
    expect(registeredIds).toContain("quick-add-ctrl");
  });

  it("loads custom bindings from settings", async () => {
    const bindings = { undo: "ctrl+y" };
    mockGetAppSetting.mockResolvedValue(JSON.stringify(bindings));

    renderHook(() => useAppShortcuts(setCommandPaletteOpen, undo, redo));

    // Wait for async getAppSetting to resolve
    await vi.waitFor(() => {
      expect(mockLoadCustomBindings).toHaveBeenCalledWith(bindings);
    });
  });

  it("adds keydown event listener on mount", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    renderHook(() => useAppShortcuts(setCommandPaletteOpen, undo, redo));

    expect(addSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    addSpy.mockRestore();
  });

  it("removes keydown event listener on unmount", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => useAppShortcuts(setCommandPaletteOpen, undo, redo));

    unmount();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    removeSpy.mockRestore();
  });
});
