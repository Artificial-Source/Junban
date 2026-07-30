/**
 * Phase 2 keyboard shortcuts hook.
 * Re-exports the chord logic from useChord for backward compatibility.
 */
export { useChord as useKeyboardShortcuts, ChordIndicator } from "./useChord";
export type { ShortcutCommand, ChordState } from "./useChord";
