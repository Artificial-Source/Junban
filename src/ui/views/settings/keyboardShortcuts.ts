/**
 * Pure helpers for Settings keyboard recording and domain-aligned validation.
 * Keep opaque chord logic out of JSX.
 */

export const DEFAULT_KEYBOARD_SHORTCUTS: ReadonlyArray<{
  action: string;
  chord: string;
  description: string;
}> = [
  { action: "quick-add", chord: "cmd+a", description: "Quick Add" },
  { action: "search", chord: "cmd+k", description: "Search" },
  { action: "command-palette", chord: "cmd+shift+p", description: "Command Palette" },
  { action: "new-project", chord: "g n", description: "New Project" },
  { action: "undo", chord: "cmd+z", description: "Undo" },
  { action: "redo", chord: "cmd+shift+z", description: "Redo" },
  { action: "today", chord: "g t", description: "Go to Today" },
  { action: "inbox", chord: "g i", description: "Go to Inbox" },
  { action: "upcoming", chord: "g u", description: "Go to Upcoming" },
  { action: "someday", chord: "g s", description: "Go to Someday" },
  { action: "completed", chord: "g c", description: "Go to Completed" },
  { action: "cancelled", chord: "g x", description: "Go to Cancelled" },
  { action: "filters", chord: "g f", description: "Go to Filters & Labels" },
  { action: "focus-mode", chord: "cmd+shift+f", description: "Enter Focus Mode" },
  { action: "plan-my-day", chord: "g p", description: "Plan My Day" },
  { action: "end-of-day", chord: "g e", description: "End of Day" },
  { action: "weekly-review", chord: "g w", description: "Weekly Review" },
];

export const RESERVED_BROWSER_CHORDS = new Set([
  "cmd+t",
  "cmd+w",
  "cmd+n",
  "cmd+d",
  "cmd+l",
  "cmd+r",
  "cmd+shift+r",
  "cmd+shift+t",
  "cmd+shift+n",
  "f5",
  "f11",
  "f12",
]);

/** Waiting window for the second stroke of a two-key chord. */
export const TWO_KEY_CHORD_TIMEOUT_MS = 1500;

const VALID_KEYS = new Set([
  "space",
  "enter",
  "escape",
  "tab",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "home",
  "end",
  "pageup",
  "pagedown",
  "delete",
  "backspace",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
]);

export type ShortcutRecord =
  | { kind: "cancel" }
  | { kind: "ignore" }
  | { kind: "pending"; first: string; prompt: string }
  | { kind: "chord"; chord: string }
  | { kind: "timeout"; message: string };

export type ShortcutValidation =
  | { ok: true; chord: string }
  | {
      ok: false;
      reason: "malformed" | "reserved" | "conflict";
      message: string;
      conflictAction?: string;
    };

function isValidKey(value: string): boolean {
  if (value.length === 1 && /[a-z0-9]/i.test(value)) return true;
  return VALID_KEYS.has(value);
}

function normalizeEventKey(key: string): string | null {
  let value = key.toLowerCase();
  if (value === " ") value = "space";
  if (value === "control" || value === "meta" || value === "shift" || value === "alt") {
    return null;
  }
  if (!isValidKey(value)) return null;
  return value;
}

/** Canonicalize one stroke (`Cmd+K` → `cmd+k`). */
export function canonicalizeStroke(stroke: string): string | null {
  const rawParts = stroke.trim().split("+");
  if (rawParts.length === 0 || rawParts.some((part) => part.trim() === "")) return null;
  const parts = rawParts.map((part) => part.trim().toLowerCase());
  if (parts.length === 0) return null;

  let cmd = false;
  let shift = false;
  let key: string | null = null;
  for (const part of parts) {
    if (["cmd", "command", "control", "ctrl", "ctl", "meta", "super", "win"].includes(part)) {
      if (cmd) return null;
      cmd = true;
      continue;
    }
    if (part === "shift") {
      if (shift) return null;
      shift = true;
      continue;
    }
    if (part === "alt" || part === "option") return null;
    if (key !== null || !isValidKey(part)) return null;
    key = part;
  }
  if (!key) return null;
  const out: string[] = [];
  if (cmd) out.push("cmd");
  if (shift) out.push("shift");
  out.push(key);
  return out.join("+");
}

/** Canonicalize a full chord (`G T` / `cmd + k`). */
export function canonicalizeChord(chord: string): string | null {
  const compact = chord.trim().replace(/\s*\+\s*/g, "+");
  if (!compact) return null;
  const strokes = compact.split(/\s+/).filter(Boolean);
  if (strokes.length === 0 || strokes.length > 2) return null;
  const canonical = strokes.map(canonicalizeStroke);
  if (canonical.some((stroke) => stroke === null)) return null;
  return canonical.join(" ");
}

function pendingPrompt(first: string): string {
  return `${first.toUpperCase()} then…`;
}

/**
 * Map a keydown into a recordable chord, pending two-key state, Escape cancel,
 * or ignore (modifier-only / Alt / invalid).
 *
 * - modifier+key commits one stroke immediately
 * - a plain first key enters pending; the next plain key commits `first second`
 * - Escape cancels (including while pending)
 * - timeout is produced separately via `recordShortcutTimeout`
 */
export function recordShortcutKeydown(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  pendingFirst: string | null = null,
): ShortcutRecord {
  if (event.key === "Escape") return { kind: "cancel" };
  if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return { kind: "ignore" };
  if (event.altKey) return { kind: "ignore" };

  const key = normalizeEventKey(event.key);
  if (!key) return { kind: "ignore" };

  const hasCmd = event.ctrlKey || event.metaKey;
  const hasShift = event.shiftKey;

  // Modifier chord commits immediately (even while a plain first key is pending).
  if (hasCmd || hasShift) {
    const parts: string[] = [];
    if (hasCmd) parts.push("cmd");
    if (hasShift) parts.push("shift");
    parts.push(key);
    const chord = canonicalizeChord(parts.join("+"));
    if (!chord) return { kind: "ignore" };
    return { kind: "chord", chord };
  }

  // Plain key — two-key chord path.
  if (pendingFirst) {
    const chord = canonicalizeChord(`${pendingFirst} ${key}`);
    if (!chord) return { kind: "ignore" };
    return { kind: "chord", chord };
  }

  const first = canonicalizeStroke(key);
  if (!first) return { kind: "ignore" };
  return { kind: "pending", first, prompt: pendingPrompt(first) };
}

/** Timeout while awaiting the second key of a two-key chord. */
export function recordShortcutTimeout(): ShortcutRecord {
  return {
    kind: "timeout",
    message: "Timed out waiting for the second key.",
  };
}

export function defaultChordForAction(action: string): string | null {
  return DEFAULT_KEYBOARD_SHORTCUTS.find((item) => item.action === action)?.chord ?? null;
}

export function descriptionForAction(action: string): string {
  return (
    DEFAULT_KEYBOARD_SHORTCUTS.find((item) => item.action === action)?.description ??
    action
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

/** Merge server shortcuts onto the known action list (stable order). */
export function mergeShortcutRows(
  server: ReadonlyArray<{ action: string; chord: string }> | null | undefined,
): Array<{ action: string; chord: string; description: string; defaultChord: string }> {
  const byAction = new Map((server ?? []).map((item) => [item.action, item.chord]));
  return DEFAULT_KEYBOARD_SHORTCUTS.map((item) => ({
    action: item.action,
    description: item.description,
    defaultChord: item.chord,
    chord: byAction.get(item.action) ?? item.chord,
  }));
}

/**
 * Validate a candidate binding for one action against the current set.
 * Enforces reserved browser chords, malformed chords, exact conflicts, and
 * one-stroke vs two-stroke prefix ambiguity (`g` vs `g t`).
 */
export function validateShortcutBinding(
  action: string,
  rawChord: string,
  current: ReadonlyArray<{ action: string; chord: string }>,
): ShortcutValidation {
  const chord = canonicalizeChord(rawChord);
  if (!chord) {
    return {
      ok: false,
      reason: "malformed",
      message: "Use a modifier+key binding or a two-key chord.",
    };
  }
  if (RESERVED_BROWSER_CHORDS.has(chord)) {
    return {
      ok: false,
      reason: "reserved",
      message: `"${chord}" is reserved by the browser.`,
    };
  }

  for (const other of current) {
    if (other.action === action) continue;
    if (other.chord === chord) {
      return {
        ok: false,
        reason: "conflict",
        conflictAction: other.action,
        message: `"${chord}" is already used by "${descriptionForAction(other.action)}"`,
      };
    }
    // Prefix ambiguity: a lone first stroke cannot coexist with a two-key chord.
    const [aFirst, aSecond] = chord.split(" ");
    const [bFirst, bSecond] = other.chord.split(" ");
    if (!aSecond && bSecond && aFirst === bFirst) {
      return {
        ok: false,
        reason: "conflict",
        conflictAction: other.action,
        message: `"${chord}" conflicts with "${other.chord}" (${descriptionForAction(other.action)})`,
      };
    }
    if (aSecond && !bSecond && aFirst === bFirst) {
      return {
        ok: false,
        reason: "conflict",
        conflictAction: other.action,
        message: `"${chord}" conflicts with "${other.chord}" (${descriptionForAction(other.action)})`,
      };
    }
  }

  return { ok: true, chord };
}

/** Produce the next full shortcuts array after a successful rebind. */
export function rebindShortcut(
  current: ReadonlyArray<{ action: string; chord: string }>,
  action: string,
  rawChord: string,
): ShortcutValidation & { next?: Array<{ action: string; chord: string }> } {
  const rows = mergeShortcutRows(current);
  const validation = validateShortcutBinding(action, rawChord, rows);
  if (!validation.ok) return validation;
  const next = rows.map((row) =>
    row.action === action
      ? { action: row.action, chord: validation.chord }
      : { action: row.action, chord: row.chord },
  );
  return { ok: true, chord: validation.chord, next };
}

/** Reset one action to its domain default chord. */
export function resetShortcutToDefault(
  current: ReadonlyArray<{ action: string; chord: string }>,
  action: string,
): ShortcutValidation & { next?: Array<{ action: string; chord: string }> } {
  const fallback = defaultChordForAction(action);
  if (!fallback) {
    return { ok: false, reason: "malformed", message: "Unknown shortcut action." };
  }
  return rebindShortcut(current, action, fallback);
}
