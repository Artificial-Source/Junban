import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeChord,
  DEFAULT_KEYBOARD_SHORTCUTS,
  mergeShortcutRows,
  rebindShortcut,
  recordShortcutKeydown,
  recordShortcutTimeout,
  resetShortcutToDefault,
  TWO_KEY_CHORD_TIMEOUT_MS,
  validateShortcutBinding,
} from "./keyboardShortcuts";

describe("keyboard shortcut helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("canonicalizes modifier bindings and two-key chords", () => {
    expect(canonicalizeChord("Cmd+K")).toBe("cmd+k");
    expect(canonicalizeChord("Control + Shift + P")).toBe("cmd+shift+p");
    expect(canonicalizeChord("G T")).toBe("g t");
    expect(canonicalizeChord("cmd++k")).toBeNull();
    expect(canonicalizeChord("alt+k")).toBeNull();
  });

  it("records modifier+key immediately and cancels on Escape", () => {
    expect(
      recordShortcutKeydown({
        key: "k",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toEqual({ kind: "chord", chord: "cmd+k" });
    expect(
      recordShortcutKeydown({
        key: "Escape",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toEqual({ kind: "cancel" });
    expect(
      recordShortcutKeydown({
        key: "Shift",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      }),
    ).toEqual({ kind: "ignore" });
    expect(
      recordShortcutKeydown({
        key: "k",
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
    ).toEqual({ kind: "ignore" });
  });

  it("records a plain two-key chord across pending state", () => {
    const first = recordShortcutKeydown({
      key: "g",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
    expect(first).toEqual({
      kind: "pending",
      first: "g",
      prompt: "G then…",
    });
    if (first.kind !== "pending") throw new Error("expected pending");
    expect(
      recordShortcutKeydown(
        {
          key: "t",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        first.first,
      ),
    ).toEqual({ kind: "chord", chord: "g t" });
  });

  it("cancels pending two-key recording on Escape and timeout", () => {
    expect(
      recordShortcutKeydown(
        {
          key: "Escape",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "g",
      ),
    ).toEqual({ kind: "cancel" });
    expect(recordShortcutTimeout()).toEqual({
      kind: "timeout",
      message: "Timed out waiting for the second key.",
    });
    expect(TWO_KEY_CHORD_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("rejects reserved, conflicting, and prefix-ambiguous bindings", () => {
    const current = mergeShortcutRows(
      DEFAULT_KEYBOARD_SHORTCUTS.map(({ action, chord }) => ({ action, chord })),
    );
    expect(validateShortcutBinding("search", "cmd+t", current).ok).toBe(false);
    expect(validateShortcutBinding("search", "cmd+a", current)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(validateShortcutBinding("today", "g", current)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(validateShortcutBinding("search", "cmd+shift+k", current)).toEqual({
      ok: true,
      chord: "cmd+shift+k",
    });
  });

  it("rebinds and resets to domain defaults", () => {
    const current = DEFAULT_KEYBOARD_SHORTCUTS.map(({ action, chord }) => ({ action, chord }));
    const rebound = rebindShortcut(current, "search", "cmd+shift+k");
    expect(rebound.ok).toBe(true);
    if (!rebound.ok || !rebound.next) throw new Error("expected rebind");
    expect(rebound.next.find((row) => row.action === "search")?.chord).toBe("cmd+shift+k");

    const reset = resetShortcutToDefault(rebound.next, "search");
    expect(reset.ok).toBe(true);
    if (!reset.ok || !reset.next) throw new Error("expected reset");
    expect(reset.next.find((row) => row.action === "search")?.chord).toBe("cmd+k");
  });
});
