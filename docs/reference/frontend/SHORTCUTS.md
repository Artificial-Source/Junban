# Frontend Keyboard Shortcuts Reference

> The keyboard shortcuts system: ShortcutManager, registration, customization, and persistence.

---

## Architecture Overview

The shortcut system consists of three layers:

1. **ShortcutManager** (`src/ui/shortcuts.ts`) -- a class that manages shortcut registration, key binding, rebinding, conflict detection, and serialization.
2. **Singleton Instance** (`src/ui/shortcutManagerInstance.ts`) -- a single shared instance used across the app.
3. **Registration Hook** (`src/ui/hooks/useAppShortcuts.ts`) -- registers the default global shortcuts on mount.
4. **Customization UI** (`src/ui/views/settings/KeyboardTab.tsx`) -- allows users to rebind shortcuts.
5. **Persistence** -- custom bindings are saved to the `keyboard_shortcuts` app setting as JSON.

---

## ShortcutManager Class

### src/ui/shortcuts.ts

- **Purpose:** Core shortcut management with registration, key normalization, rebinding, conflict detection, and persistence support.
- **Key Exports:**
  - `ShortcutManager` class
  - `ShortcutBinding` interface
  - `normalizeKeyCombo(combo: string): string`
  - `normalizeKeyEvent(e: KeyboardEvent): string`

### ShortcutBinding Interface

```typescript
interface ShortcutBinding {
  id: string; // Unique identifier (e.g., "command-palette")
  description: string; // Human-readable description
  defaultKey: string; // Default key combo (e.g., "ctrl+k")
  currentKey: string; // Current key combo (may differ if user rebound)
  callback: () => void; // Action to execute
}
```

### ShortcutManager API

| Method                     | Description                                                              |
| -------------------------- | ------------------------------------------------------------------------ |
| `register(binding)`        | Register a new shortcut. If the ID already exists, updates the callback. |
| `unregister(id)`           | Remove a shortcut by ID.                                                 |
| `rebind(id, newCombo)`     | Change the key binding for a shortcut. Returns `{ ok, conflict? }`.      |
| `resetToDefault(id)`       | Reset a shortcut to its default key binding.                             |
| `handleKeyDown(e)`         | Process a keyboard event and execute matching shortcut.                  |
| `getConflict(id, combo)`   | Check if a key combo conflicts with another shortcut.                    |
| `toJSON()`                 | Serialize custom bindings to a JSON-compatible object.                   |
| `loadCustomBindings(json)` | Restore custom bindings from a JSON object.                              |
| `getAll()`                 | Returns all registered shortcuts as an array.                            |
| `subscribe(cb)`            | Subscribe to binding changes. Returns unsubscribe function.              |

### Key Normalization

Both `normalizeKeyCombo` and `normalizeKeyEvent` produce a canonical form:

- Modifier keys sorted: `ctrl` first, then `alt`, then `shift`
- `meta` key mapped to `ctrl` (for cross-platform compatibility)
- Key names lowercased
- Space bar represented as `"space"`
- Format: `"ctrl+shift+k"`, `"alt+p"`, `"escape"`, etc.

---

## Singleton Instance

### src/ui/shortcutManagerInstance.ts

```typescript
import { ShortcutManager } from "./shortcuts.js";
export const shortcutManager = new ShortcutManager();
```

This singleton is imported by:

- `App.tsx` -- attaches `handleKeyDown` to the global `keydown` event
- `useAppShortcuts.ts` -- registers default shortcuts
- `KeyboardTab.tsx` -- reads/writes shortcut bindings
- `useAppCommands.ts` -- (indirect, via plugin commands that may have hotkeys)

---

## Default Shortcuts

Registered by `useAppShortcuts.ts` (defaults can evolve; keep `src/ui/hooks/useAppShortcuts.ts` authoritative):

| Shortcut       | ID                | Description             | Action                          |
| -------------- | ----------------- | ----------------------- | ------------------------------- |
| `Ctrl+K`       | `command-palette` | Open command palette    | Opens CommandPalette modal      |
| `Ctrl+Shift+D` | `toggle-theme`    | Toggle dark/light theme | Calls `themeManager.toggle()`   |
| `Ctrl+Z`       | `undo`            | Undo last action        | Calls `undo()` from UndoContext |
| `Ctrl+Shift+Z` | `redo`            | Redo last undone action | Calls `redo()` from UndoContext |
| `Ctrl+F`       | `search`          | Open search             | Opens SearchModal               |

Additionally, keyboard navigation shortcuts (handled separately in `useKeyboardNavigation.ts`, not through ShortcutManager):

| Key      | Action                  |
| -------- | ----------------------- |
| `j`      | Move to next task       |
| `k`      | Move to previous task   |
| `Enter`  | Open selected task      |
| `Escape` | Deselect / close panels |

Focus mode shortcuts (handled in `FocusMode.tsx`):

| Key      | Action                |
| -------- | --------------------- |
| `Space`  | Complete current task |
| `N`      | Next task             |
| `P`      | Previous task         |
| `Escape` | Exit focus mode       |

---

## Customization Flow

1. User opens Settings > Keyboard tab (`KeyboardTab.tsx`)
2. Tab lists all registered shortcuts with current bindings
3. User clicks "Edit" next to a shortcut
4. Tab enters recording mode (captures next keypress)
5. User presses desired key combination
6. `shortcutManager.rebind(id, combo)` is called
7. If successful, the new binding is persisted via `api.setAppSetting("keyboard_shortcuts", JSON.stringify(shortcutManager.toJSON()))`
8. If there is a conflict, the rebind returns `{ ok: false, conflict: existingShortcutId }`
9. User can click "Reset" to restore a single shortcut to its default binding

### Recording Mode Details

In `KeyboardTab.tsx`:

- A global `keydown` listener is attached during recording (with `capture: true`)
- Modifier-only keys (Control, Meta, Alt, Shift) are ignored
- Escape cancels recording
- The captured key combination is normalized and passed to `rebind()`

---

## Persistence

Custom bindings are stored as an app setting:

- **Key:** `"keyboard_shortcuts"`
- **Value:** JSON string from `shortcutManager.toJSON()`
- **Format:** `{ [shortcutId]: keyCombo }` (only includes shortcuts that differ from defaults)
- **Loaded:** In `App.tsx` on mount, custom bindings are loaded from the app setting and applied via `shortcutManager.loadCustomBindings(json)`

---

## Global Key Event Handling

In `App.tsx`, the ShortcutManager's `handleKeyDown` is attached to the document:

```typescript
useEffect(() => {
  const handler = (e: KeyboardEvent) => shortcutManager.handleKeyDown(e);
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}, []);
```

The `handleKeyDown` method:

1. Normalizes the keyboard event to a key combo string
2. Finds a matching registered shortcut
3. If found, calls `e.preventDefault()` and executes the callback
4. Returns `true` if a shortcut was matched, `false` otherwise

Plugin commands with hotkeys are also registered via the ShortcutManager when plugins load.
