import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChordIndicator,
  formatShortcutBinding,
  isAppleHotkeyPlatform,
  normalizeKey,
  shortcutBindingFor,
  useChord,
  type HotkeyPlatform,
} from "./useChord";

function keyEvent(
  partial: Partial<Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">>,
): Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> {
  return {
    key: "k",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe("ChordIndicator", () => {
  it("renders nothing when no chord is pending", () => {
    const markup = renderToStaticMarkup(<ChordIndicator chord={{ pending: null }} />);
    expect(markup).toBe("");
  });

  it("renders the pending chord key", () => {
    const markup = renderToStaticMarkup(<ChordIndicator chord={{ pending: "g" }} />);
    expect(markup).toContain("g…");
  });
});

describe("isAppleHotkeyPlatform", () => {
  it("detects Apple platforms from platform/userAgent without depending on live navigator", () => {
    const mac: HotkeyPlatform = { platform: "MacIntel", userAgent: "Mozilla/5.0" };
    const ipad: HotkeyPlatform = {
      platform: "iPad",
      userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)",
    };
    const linux: HotkeyPlatform = {
      platform: "Linux x86_64",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    };
    const windows: HotkeyPlatform = {
      platform: "Win32",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    };

    expect(isAppleHotkeyPlatform(mac)).toBe(true);
    expect(isAppleHotkeyPlatform(ipad)).toBe(true);
    expect(isAppleHotkeyPlatform(linux)).toBe(false);
    expect(isAppleHotkeyPlatform(windows)).toBe(false);
  });
});

describe("persisted shortcut helpers", () => {
  it("resolves by canonical action id and formats the platform modifier", () => {
    const shortcuts = [{ action: "quick-add", chord: "cmd+j" }];
    expect(shortcutBindingFor(shortcuts, "quick-add", "cmd+a")).toBe("cmd+j");
    expect(shortcutBindingFor(shortcuts, "search", "cmd+k")).toBe("cmd+k");
    expect(formatShortcutBinding("cmd+shift+p", true)).toBe("⌘⇧P");
    expect(formatShortcutBinding("cmd+shift+p", false)).toBe("Ctrl+Shift+P");
    expect(formatShortcutBinding("g t", false)).toBe("G T");
  });

  it("switches command handling when the confirmed binding snapshot reloads", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const action = vi.fn();

    function Harness({ binding }: { binding: string }) {
      useChord([{ id: "quick-add", description: "Quick Add", binding, action }], true);
      return null;
    }

    act(() => root.render(<Harness binding="cmd+k" />));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })));
    expect(action).toHaveBeenCalledOnce();

    act(() => root.render(<Harness binding="cmd+j" />));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })));
    expect(action).toHaveBeenCalledOnce();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", ctrlKey: true })));
    expect(action).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
    container.remove();
  });
});

describe("normalizeKey platform-neutral cmd modifier", () => {
  it("maps Control to cmd on non-Apple platforms (Linux/Windows)", () => {
    expect(normalizeKey(keyEvent({ key: "k", ctrlKey: true }), false)).toBe("cmd+k");
    expect(normalizeKey(keyEvent({ key: "z", ctrlKey: true }), false)).toBe("cmd+z");
    expect(normalizeKey(keyEvent({ key: "p", ctrlKey: true, shiftKey: true }), false)).toBe(
      "cmd+shift+p",
    );
  });

  it("maps Meta to cmd on Apple platforms", () => {
    expect(normalizeKey(keyEvent({ key: "k", metaKey: true }), true)).toBe("cmd+k");
    expect(normalizeKey(keyEvent({ key: "z", metaKey: true }), true)).toBe("cmd+z");
    expect(normalizeKey(keyEvent({ key: "n", metaKey: true, shiftKey: true }), true)).toBe(
      "cmd+shift+n",
    );
  });

  it("rejects the wrong primary modifier and Alt combinations", () => {
    // Ctrl on macOS is not the configured cmd accelerator.
    expect(normalizeKey(keyEvent({ key: "k", ctrlKey: true }), true)).toBeNull();
    // Super/Meta on Linux/Windows is not cmd.
    expect(normalizeKey(keyEvent({ key: "k", metaKey: true }), false)).toBeNull();
    // Alt never participates.
    expect(normalizeKey(keyEvent({ key: "k", ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(normalizeKey(keyEvent({ key: "k", metaKey: true, altKey: true }), true)).toBeNull();
  });

  it("keeps bare and chord keys without inventing modifiers", () => {
    expect(normalizeKey(keyEvent({ key: "g" }), false)).toBe("g");
    expect(normalizeKey(keyEvent({ key: "t" }), true)).toBe("t");
    expect(normalizeKey(keyEvent({ key: " " }), false)).toBe("space");
    expect(normalizeKey(keyEvent({ key: "Control", ctrlKey: true }), false)).toBeNull();
  });
});
