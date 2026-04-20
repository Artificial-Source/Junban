# Frontend Hooks Reference

> Every custom hook in `src/ui/hooks/` and view-specific hooks in `src/ui/views/`. This page covers hook responsibilities and integration points; canonical keyboard shortcut mappings live in `SHORTCUTS.md`.

---

## useRouting.ts

- **Path:** `src/ui/hooks/useRouting.ts`
- **Purpose:** Hash-based client-side routing. Parses the URL hash into a structured `RouteState` object and provides navigation functions. Supports focus mode and compatibility aliases for advanced built-in views that now live behind plugin routes.
- **Key Exports:** `useRouting`, `View` (type)
- **Return Value:**
  - `currentView: View` -- current view state
  - `selectedProjectId: string | null`
  - `selectedRouteTaskId: string | null`
  - `selectedPluginViewId: string | null`
  - `settingsTab: SettingsTab` -- current settings tab (managed via ref)
  - `focusModeOpen: boolean`
  - `setFocusModeOpen: Dispatch<SetStateAction<boolean>>`
  - `handleNavigate: (view: string, id?: string) => void` -- change view
  - `openSettingsTab: (tab: SettingsTab) => void` -- open a specific settings tab
- **View Type:** Union of view states including `inbox`, `today`, `upcoming`, `project` (with `projectId`), `task` (with `taskId`), `plugin-view` (with `viewId`), `filters-labels`, and `ai-chat`
- **Key Dependencies:** `window.location.hash`, `hashchange` and `popstate` event listeners, `useGeneralSettings` (for `start_view` setting)
- **Used By:** `App.tsx`
- **Notes:** Parses hash routes like `#/inbox`, `#/project/abc123`, `#/task/xyz`, `#/plugin-view/calendar%3Acalendar`, and `#/inbox?focus=1`. Legacy hashes such as `#/calendar`, `#/stats`, `#/completed`, `#/cancelled`, `#/someday`, `#/matrix`, and `#/dopamine-menu` are rewritten to their matching built-in plugin views so existing links keep working after those features moved out of the core sidebar. Uses `pushState`/`replaceState` with hash for navigation. `startView` from SettingsContext determines the default route. Old `#/settings` and `#/plugin-store` routes redirect to `inbox` (settings is now a modal, plugin store is inside Settings > Extensions). Focus mode is tracked as a `?focus=1` query parameter. Uses a `navigationKey` ref to decide between push and replace when the hash changes.

---

## useTaskHandlers.ts

- **Path:** `src/ui/hooks/useTaskHandlers.ts`
- **Purpose:** Task CRUD handler functions that wrap TaskContext dispatch with API calls and sound effects. Also manages selected task state for the detail panel.
- **Key Exports:** `useTaskHandlers`
- **Params:**
  - `selectedProjectId: string | null` -- the currently active project (used as default for new tasks and subtasks)
- **Return Value:**
  - `selectedTaskId: string | null`
  - `setSelectedTaskId: Dispatch<SetStateAction<string | null>>`
  - `selectedTask: Task | undefined` -- the full task object for the selected ID
  - `handleCreateTask: (parsed: { title, priority, tags, project, dueDate, dueTime, recurrence? }) => Promise<void>`
  - `handleToggleTask: (id: string) => Promise<void>`
  - `handleSelectTask: (id: string) => void`
  - `handleCloseDetail: () => void`
  - `handleUpdateTask: (id: string, input) => Promise<void>`
  - `handleDeleteTask: (id: string) => Promise<void>`
  - `handleUpdateDueDate: (taskId: string, dueDate: string | null) => Promise<void>`
  - `handleAddSubtask: (parentId: string, title: string) => Promise<void>`
  - `handleIndent: (id: string) => Promise<void>`
  - `handleOutdent: (id: string) => Promise<void>`
  - `handleReorder: (orderedIds: string[]) => Promise<void>`
- **Key Dependencies:** `useTaskContext`, `useSoundEffect`, `api` (indentTask, outdentTask, reorderTasks)
- **Used By:** `App.tsx` (provides handlers to all views)
- **Notes:** Sound effects triggered on create, complete, and delete (if enabled in settings). `handleDeleteTask` also clears `selectedTaskId`. `handleCreateTask` accepts a parsed task object (output of the NLP parser). `handleUpdateDueDate` is a convenience wrapper that converts date strings to ISO format. Indent/outdent/reorder silently catch errors as non-critical.

---

## useKeyboardNavigation.ts

- **Path:** `src/ui/hooks/useKeyboardNavigation.ts`
- **Purpose:** Vim-style keyboard navigation for task lists. Supports j/k (up/down), Enter (select/open), and Escape (close/deselect).
- **Key Exports:** `useKeyboardNavigation`
- **Params:** (options object)
  - `tasks: Task[]`
  - `selectedTaskId: string | null`
  - `onSelect: (id: string) => void`
  - `onOpen: (id: string) => void`
  - `onClose: () => void`
  - `enabled: boolean`
- **Return Value:** None (registers global `keydown` listener as side effect)
- **Key Dependencies:** None
- **Used By:** `App.tsx`
- **Notes:** Only active when no input/textarea/select has focus and `enabled` is true. `j` moves to next task, `k` moves to previous. `Enter` opens the selected task via `onOpen`. `Escape` calls `onClose`. If no task is selected and `j` is pressed, selects the first task.

---

## useMultiSelect.ts

- **Path:** `src/ui/hooks/useMultiSelect.ts`
- **Purpose:** Multi-task selection with Ctrl/Meta (toggle individual), Shift (range select), and plain click (single select) support.
- **Key Exports:** `useMultiSelect`
- **Params:**
  - `orderedIds: string[]` -- ordered array of task IDs (used for range selection)
- **Return Value:**
  - `selectedIds: Set<string>` -- set of selected task IDs
  - `handleMultiSelect: (id: string, event: { ctrlKey, metaKey, shiftKey }) => void`
  - `clearSelection: () => void`
  - `selectAll: () => void` -- selects all IDs in `orderedIds`
- **Key Dependencies:** None
- **Used By:** `App.tsx`
- **Notes:** Ctrl/Meta+click toggles a single task in/out of selection. Shift+click selects a range from the last-clicked task to the current one. Plain click (without modifier) replaces the selection with just the clicked task. Uses a `lastClickedId` ref to track the anchor point for range selection.

---

## useBulkActions.ts

- **Path:** `src/ui/hooks/useBulkActions.ts`
- **Purpose:** Bulk task operations on multi-selected tasks.
- **Key Exports:** `useBulkActions`
- **Params:**
  - `multiSelectedIds: Set<string>`
  - `clearSelection: () => void`
- **Return Value:**
  - `handleBulkComplete: () => Promise<void>`
  - `handleBulkDelete: () => Promise<void>`
  - `handleBulkMoveToProject: (projectId: string | null) => Promise<void>`
  - `handleBulkAddTag: (tag: string) => Promise<void>`
- **Key Dependencies:** `useTaskContext` (completeManyTasks, deleteManyTasks, updateManyTasks, updateTask), `useSoundEffect`
- **Used By:** `App.tsx` (passed to `BulkActionBar`)
- **Notes:** All operations convert the `Set<string>` to an array of IDs, call the appropriate TaskContext method, and clear selection on completion. `handleBulkComplete` and `handleBulkDelete` play sound effects. `handleBulkAddTag` iterates tasks individually to append the tag to each task's existing tags (avoids replacing existing tags). `handleBulkMoveToProject` accepts `null` to remove tasks from a project.

---

## useAppShortcuts.ts

- **Path:** `src/ui/hooks/useAppShortcuts.ts`
- **Purpose:** Registers global keyboard shortcuts with the ShortcutManager singleton. Loads custom keybindings from app settings.
- **Key Exports:** `useAppShortcuts`
- **Params:**
  - `setCommandPaletteOpen: Dispatch<SetStateAction<boolean>>`
  - `undo: () => void`
  - `redo: () => void`
  - `setSearchOpen?: Dispatch<SetStateAction<boolean>>` -- optional
  - `setFocusModeOpen?: Dispatch<SetStateAction<boolean>>` -- optional
  - `setQuickAddOpen?: Dispatch<SetStateAction<boolean>>` -- optional
- **Return Value:** None (registers shortcuts as side effect)
- **Registered shortcuts:** App-level defaults are registered here (command palette/theme/undo-redo plus optional search/focus/quick-add bindings). See `SHORTCUTS.md` for the canonical key map and persistence/customization behavior.
- **Key Dependencies:** `shortcutManager` singleton, `themeManager`, `api` (getAppSetting for custom bindings)
- **Used By:** `App.tsx`
- **Notes:** Registers on mount, unregisters on unmount via the global `keydown` listener. On mount, loads custom keybindings from the `keyboard_shortcuts` app setting after a short startup delay to avoid contending with initial render work. The ShortcutManager handles conflict detection and rebinding. Quick-add has two bindings: `Q` (for quick access when not in an input) and `Ctrl+N` (standard shortcut).

---

## useAppCommands.ts

- **Path:** `src/ui/hooks/useAppCommands.ts`
- **Purpose:** Builds the command palette command list from all available actions (navigation, settings tabs, theme, AI, focus mode, templates, projects, plugins).
- **Key Exports:** `useAppCommands`
- **Params:**
  - `handleNavigate: (view: string, id?: string) => void`
  - `openSettingsTab: (tab: SettingsTab) => void`
  - `setFocusModeOpen: Dispatch<SetStateAction<boolean>>`
  - `setTemplateSelectorOpen: Dispatch<SetStateAction<boolean>>`
  - `projects: Project[]`
  - `pluginCommands: PluginCommandInfo[]`
  - `executeCommand: (id: string) => void`
  - `setQuickAddOpen?: Dispatch<SetStateAction<boolean>>` -- optional
- **Return Value:** `Array<{ id, name, callback }>` -- array of command objects (memoized)
- **Key Dependencies:** `themeManager`
- **Used By:** `App.tsx` (passed to `CommandPalette`)
- **Notes:** Commands include: Go to Inbox/Today/Upcoming, Go to Settings (individual tabs like essentials, appearance, filters & labels, advanced, AI, templates, keyboard, data, about), Toggle Dark Mode, Switch to Light/Dark Theme, Toggle AI Chat, Enter Focus Mode, Quick Add Task, Create Task from Template, Go to Project (one per project), and all registered plugin commands. Disabled built-in views like Completed are omitted until their feature flags are enabled. Plugin commands are dynamically added from the `pluginCommands` array. The Extensions settings surface is hidden from the MVP UI, so command-palette entries no longer route there.

---

## useIsMobile.ts

- **Path:** `src/ui/hooks/useIsMobile.ts`
- **Purpose:** Detects mobile viewport using `matchMedia` for `max-width: 767px`.
- **Key Exports:** `useIsMobile`
- **Return Value:** `boolean` -- true if viewport is 767px or narrower
- **Key Dependencies:** `window.matchMedia`
- **Used By:** `App.tsx` (switches between desktop and mobile layouts)
- **Notes:** Listens for `change` events on the media query so it updates in real time when the window is resized. Uses lazy initializer in `useState` to handle SSR (returns `false` if `window` is undefined).

---

## useSoundEffect.ts

- **Path:** `src/ui/hooks/useSoundEffect.ts`
- **Purpose:** Provides a function to play sound effects for task events, respecting user sound settings.
- **Key Exports:** `useSoundEffect`
- **Return Value:** `(event: SoundEvent) => void` -- play a sound for the given event
- **Supported Events:** `complete`, `create`, `delete`, `reminder`
- **Key Dependencies:** `useGeneralSettings`, `playSoundRaw` from `utils/sounds.js`
- **Used By:** `useTaskHandlers.ts`, `useBulkActions.ts`
- **Notes:** Checks `sound_enabled` global toggle and per-event toggles (`sound_complete`, `sound_create`, `sound_delete`, `sound_reminder`) before playing. Reads `sound_volume` setting and converts to 0-1 scale. Errors from `playSoundRaw` are silently caught.

---

## useReminders.ts

- **Path:** `src/ui/hooks/useReminders.ts`
- **Purpose:** Polls for due task reminders and fires callbacks for each. Optionally clears `remindAt` on fired tasks to prevent re-firing.
- **Key Exports:** `useReminders`
- **Params:** (options object)
  - `onReminder: (task: { id: string; title: string }) => void` -- callback when a reminder fires
  - `enabled?: boolean` -- whether polling is active (default: `true`)
  - `intervalMs?: number` -- polling interval in milliseconds (default: `60000`)
  - `clearReminders?: boolean` -- whether reminder polling should clear `remindAt` after firing (default: `true`)
- **Return Value:** None (side effect only)
- **Key Dependencies:** `api` (fetchDueReminders, updateTask)
- **Used By:** `App.tsx`
- **Notes:** Uses `setInterval` with configurable polling interval. Tracks already-fired reminders by ID via a ref `Set` to avoid duplicates within the same session. When `clearReminders` is true, it calls `api.updateTask` to clear `remindAt` after firing (errors silently caught as non-critical). `App.tsx` disables reminder clears while desktop local mutations are blocked by active remote access so polling does not mutate task state in that mode. Runs an initial check shortly after mount to keep startup/network contention lower.

---

## useVAD.ts

- **Path:** `src/ui/hooks/useVAD.ts`
- **Purpose:** Voice Activity Detection for hands-free voice input. Manages the `@ricky0123/vad-web` `MicVAD` instance with optional smart endpoint grace period.
- **Key Exports:** `useVAD`
- **Params:** (options object)
  - `onSpeechStart?: () => void`
  - `onSpeechEnd?: (audio: Blob) => void` -- receives a WAV Blob of the recorded speech
  - `enabled: boolean` -- auto-starts/stops VAD when toggled
  - `deviceId?: string` -- microphone device ID for `additionalAudioConstraints`
  - `smartEndpoint?: boolean` -- enable smart endpoint detection (buffer audio during pauses, default: `false`)
  - `gracePeriodMs?: number` -- grace period in ms to wait after speech ends before finalizing (default: `1500`)
- **Return Value:**
  - `isListening: boolean`
  - `isSpeaking: boolean`
  - `start: () => Promise<void>`
  - `stop: () => void`
  - `isSupported: boolean` -- false if VAD initialization fails
  - `isInGracePeriod: boolean` -- true when in grace period (user paused but may continue)
  - `gracePeriodProgress: number` -- 0 to 1, animated via `requestAnimationFrame`
- **Key Dependencies:** `@ricky0123/vad-web` (MicVAD, dynamically imported), `float32ToWav` from `ai/voice/audio-utils.js`
- **Used By:** `AIChatPanel.tsx`
- **Notes:** Smart endpoint: when speech ends, starts a grace period timer. If speech resumes within the grace period, the timer cancels and audio continues buffering. If the grace period expires, all buffered `Float32Array` chunks are concatenated, converted to a 16kHz WAV Blob via `float32ToWav`, and delivered to `onSpeechEnd`. Without smart endpoint, each speech segment is immediately converted and delivered. VAD is auto-started/stopped when `enabled` changes. On stop, any buffered audio is flushed before destroying the VAD instance.

---

## useVoiceCall.ts

- **Path:** `src/ui/hooks/useVoiceCall.ts`
- **Purpose:** Orchestrates the voice call state machine: idle -> greeting -> listening -> processing -> speaking -> listening (loop). Coordinates VAD, STT, TTS, and AI chat.
- **Key Exports:** `useVoiceCall`, `CallState` (type), `UseVoiceCallOptions` (interface), `UseVoiceCallReturn` (interface)
- **Params:** (options object)
  - `speak: (text: string) => Promise<void>` -- TTS speak function from VoiceContext
  - `cancelSpeech: () => void` -- TTS cancel function from VoiceContext
  - `isSpeaking: boolean` -- whether TTS is currently speaking
  - `isStreaming: boolean` -- whether the AI is currently streaming a response
  - `messages: { role: string; content: string; isError?: boolean }[]` -- current chat messages
  - `ttsAvailable: boolean` -- whether TTS is enabled and a provider is available
  - `setVoiceCallMode: (active: boolean) => void` -- callback to set voice call mode on AIContext
- **Return Value:**
  - `callState: CallState` -- current state (`idle` | `greeting` | `listening` | `processing` | `speaking`)
  - `isCallActive: boolean` -- true when `callState !== "idle"`
  - `callDuration: number` -- call duration in seconds
  - `startCall: () => void`
  - `endCall: () => void`
  - `vadEnabled: boolean` -- true only when `callState === "listening"`
- **CallState Flow:**
  1. `idle` -- not in a call
  2. `greeting` -- AI sends initial greeting ("Hey! What can I help you with today?") via TTS
  3. `listening` -- VAD active, waiting for user speech
  4. `processing` -- speech ended, STT transcription in progress, then AI processing (triggered when `isStreaming` goes true while listening)
  5. `speaking` -- AI response being spoken via TTS (triggered when `isStreaming` goes false while processing)
  6. Back to `listening` when TTS finishes
- **Key Dependencies:** None (orchestration only; VAD/STT/TTS/AI are provided via props)
- **Used By:** `AIChatPanel.tsx`
- **Notes:** Duration timer ticks every second while active. State transitions are logged to console for debugging. If TTS is unavailable, greeting is skipped and goes directly to listening. If TTS fails during speaking, falls back to listening. `endCall` cancels any in-progress speech. VAD is only enabled during `listening` state to prevent interruption handling complexity.

---

## useFocusTrap.ts

- **Path:** `src/ui/hooks/useFocusTrap.ts`
- **Purpose:** Custom focus trap hook for modals and drawers. Saves the previously focused element on activation, focuses the first focusable child, traps Tab/Shift+Tab within the container, and restores focus on deactivation.
- **Key Exports:** `useFocusTrap`
- **Params:**
  - `containerRef: RefObject<HTMLElement | null>` -- ref to the container element to trap focus within
  - `active: boolean` -- whether the trap is active
- **Return Value:** None (side effect only)
- **Key Dependencies:** None
- **Used By:** `MobileDrawer.tsx`
- **Notes:** Queries all focusable elements (`a[href]`, `button:not([disabled])`, `textarea:not([disabled])`, `input:not([disabled])`, `select:not([disabled])`, `[tabindex]:not([tabindex="-1"])`) within the container. Tab on the last element wraps to the first; Shift+Tab on the first wraps to the last. Restores the originally focused element when the trap deactivates.

---

## useNudges.ts

- **Path:** `src/ui/hooks/useNudges.ts`
- **Purpose:** Evaluates contextual nudge rules periodically from existing task state. No API calls — purely derived from in-memory data. Respects per-type enable/disable settings. Session-scoped dismissed set prevents re-showing dismissed nudges.
- **Key Exports:** `useNudges`
- **Params:**
  - `options: UseNudgesOptions` -- `{ tasks: Task[], settings: GeneralSettings, intervalMs?: number }`
- **Return Value:** `{ activeNudges: Nudge[], dismiss: (id: string) => void }`
- **Key Dependencies:** `core/nudges.ts` (evaluateNudges), `format-date.ts` (toDateKey), `SettingsContext` (GeneralSettings)
- **Used By:** `App.tsx`
- **Notes:** Nudge types: `overdue_alert`, `deadline_approaching`, `stale_tasks`, `empty_today`, `overloaded_day`. Each type maps to a corresponding `nudge_*` setting key for per-type toggling. Initial evaluation is deferred to idle time (or a short timeout fallback) to avoid competing with first paint; periodic interval evaluation remains unchanged.

---

## useCalendarNavigation.ts

- **Path:** `src/ui/views/calendar/useCalendarNavigation.ts`
- **Purpose:** Calendar navigation state and actions. Manages the selected date, view mode (day/week/month), navigation (next/prev/today), and period label formatting. Respects the user's configured week start day.
- **Key Exports:** `useCalendarNavigation`, `CalendarMode` (type), `getWeekStart` (utility), `getWeekDays` (utility)
- **Params:** (options object, all optional)
  - `initialMode?: CalendarMode` -- initial calendar mode (default: `"week"`)
  - `onModeChange?: (mode: CalendarMode) => void` -- callback when mode changes
- **Return Value:**
  - `selectedDate: Date` -- the currently selected/focused date
  - `mode: CalendarMode` -- current mode (`"day"` | `"week"` | `"month"`)
  - `setMode: (mode: CalendarMode) => void` -- change mode (also calls `onModeChange`)
  - `goNext: () => void` -- advance by one day/week/month depending on mode
  - `goPrev: () => void` -- go back by one day/week/month depending on mode
  - `goToday: () => void` -- set selected date to today
  - `setDate: (d: Date) => void` -- set selected date to a specific date
  - `isCurrentPeriod: boolean` -- true if the current period contains today
  - `periodLabel: string` -- formatted label for the current period (e.g., "Monday, Feb 21, 2026", "Feb 16–22, 2026", "February 2026")
  - `weekStartDay: number` -- 0 for Sunday, 1 for Monday, 6 for Saturday
- **Key Dependencies:** `useGeneralSettings` (for `week_start` setting)
- **Used By:** `CalendarView.tsx`
- **Exported Utilities:**
  - `getWeekStart(date: Date, weekStartDay: number): Date` -- returns the start of the week containing `date`, respecting the given week start day
  - `getWeekDays(date: Date, weekStartDay: number): Date[]` -- returns all 7 days of the week containing `date`
- **Notes:** The `week_start` setting supports `"sunday"`, `"monday"`, and `"saturday"` values, which are converted to numeric offsets (0, 1, 6). `isCurrentPeriod` checks whether today falls within the currently displayed day/week/month. `periodLabel` formats differently for each mode: full date for day, date range for week (handling cross-month and cross-year ranges), and month+year for month.
