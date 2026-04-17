# V2-18: Global Quick Capture

## Objective

Implement a system-wide hotkey that opens a floating task input window over any application. Inspired by Things 3 and Akiflow quick capture. Press a hotkey anywhere on your system, type a task with full NLP parsing, hit Enter, and you're back to what you were doing.

---

## Context

### Tauri Setup

- **Runtime:** Tauri v2 with `src-tauri/src/lib.rs` using a simple builder pattern
- **Existing plugins:** `fs` and `updater` already registered in the builder
- **Tauri detection:** `src/utils/tauri.ts` checks `window.__TAURI__` to determine if running in Tauri or browser mode
- **Config:** `src-tauri/tauri.conf.json` defines window configuration

### Task Input

- **`src/ui/components/TaskInput.tsx`** — Controlled input with real-time NLP parsing preview, inline chips for priority/date/tags, submits on Enter
- This component is self-contained and accepts callbacks for task creation
- It already handles focus management, keyboard events, and NLP preview rendering

### Tech Stack

- TypeScript strict mode, React + Tailwind CSS (no inline styles, no CSS modules)
- pnpm package manager, Vite bundler
- ESLint + Prettier enforced
- Conventional Commits: `feat(tauri): ...`

### Key Files

| File                                  | Purpose                                        |
| ------------------------------------- | ---------------------------------------------- |
| `src-tauri/src/lib.rs`                | Tauri app builder — register plugins here      |
| `src-tauri/Cargo.toml`                | Rust dependencies — add global-shortcut plugin |
| `src-tauri/tauri.conf.json`           | Window definitions and plugin permissions      |
| `src-tauri/capabilities/default.json` | Tauri v2 capability permissions                |
| `src/utils/tauri.ts`                  | `isTauri()` detection helper                   |
| `src/ui/components/TaskInput.tsx`     | The task input component to reuse              |
| `src/ui/views/Settings.tsx`           | Settings page (General tab for hotkey config)  |
| `src/ui/context/SettingsContext.tsx`  | Settings state management                      |
| `src/ui/main.tsx`                     | React entry point — routing setup              |
| `src/ui/App.tsx`                      | Root component — view rendering                |

---

## Phase 1: Tauri Plugin Setup + Window Configuration

### 1.1 Add `tauri-plugin-global-shortcut`

In `src-tauri/Cargo.toml`, add the global-shortcut plugin dependency:

```toml
[dependencies]
tauri-plugin-global-shortcut = "2"
```

In `src-tauri/src/lib.rs`, register the plugin in the builder chain:

```rust
.plugin(tauri_plugin_global_shortcut::Builder::new().build())
```

### 1.2 Configure the Capture Window

In `src-tauri/tauri.conf.json`, add a second window definition for the capture overlay:

```json
{
  "label": "quick-capture",
  "title": "Quick Capture",
  "url": "/quick-capture",
  "width": 680,
  "height": 72,
  "resizable": false,
  "decorations": false,
  "alwaysOnTop": true,
  "center": true,
  "visible": false,
  "skipTaskbar": true,
  "focus": true
}
```

Key properties:

- **`visible: false`** — hidden by default, shown on hotkey
- **`decorations: false`** — borderless, no title bar
- **`alwaysOnTop: true`** — floats over everything
- **`skipTaskbar: true`** — no taskbar entry
- **`center: true`** — appears centered on screen
- Height is small (72px) — just enough for the input + NLP preview. May need adjustment to ~120px if the preview chips add height.

### 1.3 Add Permissions

In `src-tauri/capabilities/default.json` (or the relevant capability file), add permissions for global shortcut and window management:

```json
{
  "permissions": [
    "global-shortcut:default",
    "global-shortcut:allow-register",
    "global-shortcut:allow-unregister",
    "global-shortcut:allow-is-registered"
  ]
}
```

Ensure existing window permissions allow `show`, `hide`, `set-focus` on the quick-capture window.

### 1.4 Hotkey Registration (Frontend)

Create `src/ui/hooks/useGlobalShortcut.ts`:

```typescript
import { isTauri } from "../../utils/tauri";

/**
 * Register a system-wide hotkey for quick capture.
 * Only works in Tauri — no-op in browser mode.
 */
export function useGlobalShortcut(
  shortcut: string,
  onTrigger: () => void,
): {
  registered: boolean;
  error: string | null;
};
```

- Use `@tauri-apps/plugin-global-shortcut` APIs: `register()`, `unregister()`, `isRegistered()`
- On trigger, use `@tauri-apps/api/window` to get the `quick-capture` window by label, call `.show()` and `.setFocus()`
- Clean up on unmount: unregister the shortcut
- If `!isTauri()`, return `{ registered: false, error: null }` (silently unavailable)

Install the JS binding:

```bash
pnpm add @tauri-apps/plugin-global-shortcut
```

---

### Code Reviewer Checkpoint 1

Pause and verify:

- [ ] `cargo build` succeeds with the new plugin dependency
- [ ] `pnpm dev` (Tauri dev mode) launches without errors
- [ ] The `quick-capture` window is defined in `tauri.conf.json` but stays hidden on launch
- [ ] Global shortcut can be registered and fires a callback (test with a `console.log`)
- [ ] Browser mode (`pnpm dev` without Tauri) does not crash — `isTauri()` returns false gracefully
- [ ] No lint errors (`pnpm lint`)

---

## Phase 2: QuickCapture View + Window Behavior

### 2.1 Create `src/ui/views/QuickCapture.tsx`

A minimal view that wraps `TaskInput`:

```typescript
/**
 * QuickCapture — Floating overlay window for system-wide task capture.
 * Renders only TaskInput in a compact layout.
 * Shown/hidden by global hotkey (Tauri only).
 */
export default function QuickCapture() { ... }
```

Requirements:

- Render `TaskInput` with appropriate callbacks
- Minimal chrome: just a subtle border/shadow container with rounded corners
- Background should be the theme's surface color (respect dark/light mode)
- No sidebar, no navigation, no header — just the input
- Apply a subtle `shadow-xl` and `rounded-xl` for the floating feel
- Use `ring-1 ring-border` or similar for a subtle border

### 2.2 Route Setup

Add a route for `/quick-capture` in the app's routing. This should:

- Render `QuickCapture` without the main app shell (no sidebar, no nav)
- Detect the route and skip `App.tsx`'s normal layout wrapping
- One approach: check `window.location.pathname` in `main.tsx` and conditionally render `QuickCapture` instead of `App`

### 2.3 Window Lifecycle

When the capture window is active, it needs these behaviors:

**On show (hotkey pressed):**

- Window becomes visible and focused
- TaskInput auto-focuses (it likely already does this)

**On task submit (Enter):**

- Task is created via the existing task creation flow
- Window hides itself
- Focus returns to the previously active application (Tauri handles this when the window hides)

**On dismiss (Escape):**

- Window hides without creating a task
- Focus returns to the previously active application

**On blur (click outside):**

- Window hides (auto-dismiss on focus loss)
- Use the Tauri window `onFocusChanged` event listener

Create `src/ui/hooks/useQuickCaptureWindow.ts` to encapsulate the show/hide/focus logic:

```typescript
/**
 * Manages the quick capture window lifecycle.
 * Handles show/hide/blur events and task submission callbacks.
 */
export function useQuickCaptureWindow(): {
  hideWindow: () => Promise<void>;
  isCapture: boolean;
};
```

- Use `getCurrentWindow()` from `@tauri-apps/api/window`
- Listen for `onFocusChanged` — if focus lost, hide
- On hide: call `window.hide()`, which returns focus to the previous app
- Clear the input state on hide so it's fresh next time

### 2.4 Task Creation in Capture Window

The capture window needs access to the task creation logic. Two approaches:

**Option A (Preferred): IPC to main window**

- The capture window sends task data to the main window via Tauri's `emit`/`listen` events
- Main window handles creation using existing `TaskContext`
- Pro: No need to duplicate DB/service wiring in the capture window

**Option B: Direct creation**

- The capture window bootstraps its own minimal service layer
- Pro: Independent. Con: More complex, potential DB locking issues.

Go with **Option A**. The flow:

1. Capture window calls `emit("quick-capture-submit", { rawInput: "..." })`
2. Main window listens for `quick-capture-submit` and creates the task
3. Main window emits `quick-capture-ack` back (optional, for confirmation feedback)
4. Capture window hides

---

### Code Reviewer Checkpoint 2

Pause and verify:

- [ ] `/quick-capture` route renders TaskInput without the app shell
- [ ] Pressing the global hotkey shows the capture window centered on screen
- [ ] TaskInput receives focus automatically when the window appears
- [ ] Typing a task and pressing Enter creates the task and hides the window
- [ ] Pressing Escape hides the window without creating a task
- [ ] Clicking outside the window hides it (blur behavior)
- [ ] The input is cleared each time the window re-opens
- [ ] Task creation works correctly (NLP parsing, priority, tags, dates all function)
- [ ] The main window's task list reflects the newly created task
- [ ] Dark/light theme is respected in the capture window
- [ ] No lint errors

---

## Phase 3: Settings Integration

### 3.1 Hotkey Setting

Add a `quickCaptureHotkey` setting to the settings system:

- **Key:** `quick_capture_hotkey`
- **Default value:** `CmdOrCtrl+Shift+Space`
- **Type:** `string`
- **Location:** Settings > General tab

Use `CmdOrCtrl` as the Tauri modifier that maps to Cmd on macOS and Ctrl on Linux/Windows.

### 3.2 Settings UI

In the General settings tab, add a "Quick Capture" section:

```
Quick Capture
  Global hotkey: [CmdOrCtrl+Shift+Space] [Record] [Reset]
```

- **Hotkey input:** A small input field that shows the current shortcut
- **Record button:** Click to start recording, then press the desired key combo. Display the recorded combo in the input. Use a "recording..." state with visual feedback.
- **Reset button:** Restore to default (`CmdOrCtrl+Shift+Space`)
- **Validation:** Reject single-key shortcuts (must include at least one modifier). Show inline error for invalid combos.
- This entire section should only render when `isTauri()` returns true (hidden in browser mode)

### 3.3 Re-registration on Change

When the hotkey setting changes:

1. Unregister the old shortcut
2. Register the new one
3. If registration fails (e.g., conflict with system shortcut), show an error toast and revert to the previous working shortcut
4. Persist only after successful registration

### 3.4 Enable/Disable Toggle

Add a toggle to enable/disable quick capture entirely:

- **Key:** `quick_capture_enabled`
- **Default:** `true`
- When disabled, unregister the global shortcut
- When enabled, register it

---

### Code Reviewer Checkpoint 3

Pause and verify:

- [ ] Default hotkey (`CmdOrCtrl+Shift+Space`) works out of the box
- [ ] Changing the hotkey in settings re-registers the shortcut correctly
- [ ] Invalid/conflicting shortcuts show an error and don't break the app
- [ ] The "Record" flow captures modifier+key combos correctly
- [ ] Reset restores the default hotkey
- [ ] Enable/disable toggle registers/unregisters the shortcut
- [ ] Quick Capture settings section is hidden in browser mode
- [ ] Settings persist across app restarts
- [ ] No lint errors

---

## Phase 4: Tests

### 4.1 Unit Tests

Create `tests/ui/hooks/useGlobalShortcut.test.ts`:

- Mock `@tauri-apps/plugin-global-shortcut` and `@tauri-apps/api/window`
- Test: registers shortcut on mount, unregisters on unmount
- Test: calls onTrigger callback when shortcut fires
- Test: no-ops gracefully when `isTauri()` is false
- Test: re-registers when shortcut string changes

Create `tests/ui/views/QuickCapture.test.tsx`:

- Test: renders TaskInput
- Test: does not render sidebar or navigation
- Test: hides window on Escape keypress
- Test: emits task data on Enter

Create `tests/ui/settings/quick-capture-settings.test.tsx`:

- Test: renders hotkey input with default value
- Test: record mode captures key combos
- Test: rejects single-key (no modifier) shortcuts
- Test: reset restores default
- Test: toggle enables/disables

### 4.2 E2E Tests (if Tauri testing is feasible)

If Tauri E2E is set up, add to `tests/e2e/quick-capture.spec.ts`:

- Test: hotkey opens capture window
- Test: type task + Enter creates task and closes window
- Test: Escape closes without creating

If Tauri E2E is not feasible, note this in the Definition of Done and skip.

---

## Definition of Done

- [ ] `tauri-plugin-global-shortcut` installed and registered
- [ ] `quick-capture` window defined in `tauri.conf.json` (borderless, always-on-top, hidden)
- [ ] `QuickCapture.tsx` renders TaskInput in a minimal floating layout
- [ ] `/quick-capture` route renders without the app shell
- [ ] Global hotkey shows the capture window and focuses the input
- [ ] Enter submits the task (via IPC to main window) and hides the capture window
- [ ] Escape and blur hide the capture window
- [ ] Input is cleared on each open
- [ ] Hotkey is customizable in Settings > General (with record, reset, validation)
- [ ] Enable/disable toggle for quick capture
- [ ] Feature is fully hidden in browser mode (`isTauri()` false)
- [ ] Theme (dark/light) is respected in the capture window
- [ ] All unit tests pass
- [ ] No new lint errors or warnings
- [ ] Commit(s) follow Conventional Commits: `feat(tauri): add global quick capture window`

---

### Final Code Reviewer Checkpoint

Review the complete implementation end-to-end:

- [ ] No Tauri API calls without `isTauri()` guards
- [ ] No hardcoded hotkey strings outside of defaults — all read from settings
- [ ] Window cleanup on app quit (unregister shortcut)
- [ ] No memory leaks from event listeners (all cleaned up on unmount)
- [ ] TaskInput works identically in capture window and main app (same NLP, same chips, same behavior)
- [ ] No new `any` types introduced
- [ ] All files follow project conventions (named exports, JSDoc for complex logic, Tailwind only)
- [ ] Run `pnpm check` — must pass clean
