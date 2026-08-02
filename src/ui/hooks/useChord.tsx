/** Server-confirmed keyboard shortcuts and two-key chord indicator. */
import { useEffect, useRef, useState } from "react";

export interface ShortcutCommand {
  id: string;
  description: string;
  /** Platform-independent canonical binding (`cmd+k` or `g t`). */
  binding: string;
  action: () => void;
}

export interface PersistedShortcut {
  action: string;
  chord: string;
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

/** Resolve one command from an authoritative settings snapshot. */
export function shortcutBindingFor(
  shortcuts: readonly PersistedShortcut[] | null | undefined,
  action: string,
  fallback: string,
): string {
  return shortcuts?.find((shortcut) => shortcut.action === action)?.chord ?? fallback;
}

/** Present a canonical binding using the current platform's primary modifier. */
export function formatShortcutBinding(
  binding: string,
  apple: boolean = isAppleHotkeyPlatform(),
): string {
  return binding
    .split(" ")
    .map((stroke) =>
      stroke
        .split("+")
        .map((part) => {
          if (part === "cmd") return apple ? "⌘" : "Ctrl";
          if (part === "shift") return apple ? "⇧" : "Shift";
          return part.length === 1 ? part.toUpperCase() : part;
        })
        .join(apple ? "" : "+"),
    )
    .join(" ");
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

/** Normalize keydown input to the persisted platform-independent spelling. */
export function normalizeKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  apple: boolean = isAppleHotkeyPlatform(),
): string | null {
  if (e.altKey) return null;

  const primaryPressed = apple ? e.metaKey : e.ctrlKey;
  const wrongPrimary = apple ? e.ctrlKey && !e.metaKey : e.metaKey && !e.ctrlKey;
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

      if (pendingChordRef.current) {
        const chordCombo = `${pendingChordRef.current} ${pressed}`;
        clearChord();
        for (const command of commandsRef.current) {
          if (command.binding === chordCombo) {
            e.preventDefault();
            command.action();
            return;
          }
        }
      }

      for (const command of commandsRef.current) {
        const [first, second] = command.binding.split(" ");
        if (second && first === pressed) {
          e.preventDefault();
          setPendingChord(pressed);
          pendingChordRef.current = pressed;
          if (chordTimerRef.current) clearTimeout(chordTimerRef.current);
          chordTimerRef.current = setTimeout(clearChord, 1000);
          return;
        }
      }

      for (const command of commandsRef.current) {
        if (!command.binding.includes(" ") && command.binding === pressed) {
          e.preventDefault();
          command.action();
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
