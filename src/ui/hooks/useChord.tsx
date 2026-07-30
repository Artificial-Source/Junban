/**
 * Phase 2 keyboard shortcuts and chord indicator.
 * Ships only working Phase 2 commands. Later-phase commands are absent.
 * Shortcuts do not intercept focused inputs or modal focus traps.
 *
 * Config keys use the `cmd+…` spelling. That primary modifier is Meta on
 * Apple platforms and Control elsewhere (Linux/Windows).
 */
import { useEffect, useRef, useState } from "react";

export interface ShortcutCommand {
  id: string;
  description: string;
  defaultKey: string;
  chord?: string;
  action: () => void;
}

export interface ChordState {
  pending: string | null;
}

/** Minimal navigator surface so tests can stub platform without brittle UA parsing. */
export type HotkeyPlatform = Pick<Navigator, "platform" | "userAgent">;

/** True when the primary accelerator is Meta (⌘); false when it is Control. */
export function isAppleHotkeyPlatform(
  nav: HotkeyPlatform | undefined = typeof navigator !== "undefined" ? navigator : undefined,
): boolean {
  if (!nav) return false;
  const haystack = `${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/.test(haystack);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

/**
 * Normalize a keydown into the config spelling (`cmd+k`, `cmd+shift+p`, `g`, …).
 * Returns null when the event should not match shortcuts (Alt, wrong-platform
 * primary modifier, or modifier-only keydowns).
 */
export function normalizeKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  apple: boolean = isAppleHotkeyPlatform(),
): string | null {
  if (e.altKey) return null;

  const primaryPressed = apple ? e.metaKey : e.ctrlKey;
  const wrongPrimary = apple ? e.ctrlKey && !e.metaKey : e.metaKey && !e.ctrlKey;
  // Reject the non-primary accelerator used alone (Ctrl on macOS, Super on Linux/Windows).
  if (wrongPrimary && !primaryPressed) return null;

  const parts: string[] = [];
  if (primaryPressed) parts.push("cmd");
  if (e.shiftKey) parts.push("shift");

  let key = e.key.toLowerCase();
  if (key === " ") key = "space";
  if (key === "control" || key === "meta" || key === "shift" || key === "alt" || key === "cmd") {
    return null;
  }
  parts.push(key);
  return parts.join("+");
}

export function useChord(commands: ShortcutCommand[], enabled: boolean): { chord: ChordState } {
  const [pendingChord, setPendingChord] = useState<string | null>(null);
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const pendingChordRef = useRef<string | null>(null);
  const chordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    function clearChord() {
      setPendingChord(null);
      pendingChordRef.current = null;
      if (chordTimerRef.current) {
        clearTimeout(chordTimerRef.current);
        chordTimerRef.current = null;
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;

      const pressed = normalizeKey(e);
      if (!pressed) return;

      // Check for chord completion.
      if (pendingChordRef.current) {
        const chordCombo = `${pendingChordRef.current} ${pressed}`;
        clearChord();
        for (const cmd of commandsRef.current) {
          if (cmd.chord && cmd.chord.toLowerCase() === chordCombo) {
            e.preventDefault();
            cmd.action();
            return;
          }
        }
        // No match — fall through to single-key handling below.
      }

      // Check if this key starts any chord.
      for (const cmd of commandsRef.current) {
        if (cmd.chord) {
          const firstKey = cmd.chord.toLowerCase().split(" ")[0];
          if (firstKey === pressed) {
            e.preventDefault();
            setPendingChord(pressed);
            pendingChordRef.current = pressed;
            if (chordTimerRef.current) clearTimeout(chordTimerRef.current);
            chordTimerRef.current = setTimeout(clearChord, 1000);
            return;
          }
        }
      }

      // Single-key shortcuts.
      for (const cmd of commandsRef.current) {
        if (cmd.defaultKey && cmd.defaultKey.toLowerCase() === pressed) {
          e.preventDefault();
          cmd.action();
          return;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (chordTimerRef.current) clearTimeout(chordTimerRef.current);
    };
  }, [enabled]);

  return { chord: { pending: pendingChord } };
}

/**
 * Chord indicator component showing pending chord state.
 */
export function ChordIndicator({ chord }: { chord: ChordState }) {
  if (!chord.pending) return null;

  return (
    <div
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-mono text-on-surface-muted shadow-md animate-fade-in"
    >
      {chord.pending}…
    </div>
  );
}
