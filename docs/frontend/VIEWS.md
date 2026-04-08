# Frontend Views Reference

> Overview of the main views in `src/ui/views/`, calendar subviews, and settings tabs. This document is meant to explain view responsibilities and routing, not to be a fragile inventory ledger.

---

## Main Views

### Inbox.tsx

- **Path:** `src/ui/views/Inbox.tsx` (84 lines)
- **Purpose:** Default inbox view. Shows tasks that have no project assignment and are still pending, plus recently completed tasks (within the last 14 days).
- **Key Exports:** `Inbox`
- **Props:**
  - `tasks: Task[]`
  - `onCreateTask` -- callback receiving parsed task input (title, priority, tags, project, dueDate, dueTime)
  - `onToggleTask, onSelectTask` -- task action callbacks
  - `selectedTaskId: string | null`
  - `selectedTaskIds?: Set<string>`
  - `onMultiSelect?, onReorder?, onAddSubtask?, onUpdateDueDate?`
  - `autoFocusTrigger?: number`
- **Key Dependencies:** `TaskInput.tsx`, `TaskList.tsx`, `lucide-react` (Inbox icon)
- **Used By:** `App.tsx`
- **Notes:** Filters tasks by `!task.projectId && (pending || recently completed)`. Recent completed cutoff is 14 days from when the view was first mounted (uses `useState` to capture mount time). Displays task count in the header.

---

### Today.tsx

- **Path:** `src/ui/views/Today.tsx` (194 lines)
- **Purpose:** Shows tasks due today and overdue tasks with a reschedule option. Includes a CompletionRing in the header and a workload capacity bar.
- **Key Exports:** `Today`
- **Props:**
  - `tasks: Task[]`
  - `projects: Project[]`
  - `onCreateTask, onToggleTask, onSelectTask`
  - `onUpdateTask: (id: string, updates: Record<string, unknown>) => void` -- needed for reschedule
  - `selectedTaskId: string | null`
  - `selectedTaskIds?, onMultiSelect?, onReorder?, onAddSubtask?, onUpdateDueDate?`
  - `autoFocusTrigger?: number`
- **Key Dependencies:** `TaskInput.tsx`, `TaskList.tsx`, `CompletionRing.tsx`, `OverdueSection.tsx`, `SettingsContext.tsx`, `toDateKey` from `utils/format-date.js`, `parseTask` from `parser/task-parser.js`
- **Used By:** `App.tsx`
- **Notes:** Uses OverdueSection component for the overdue section. CompletionRing SVG shows completed/total for today's tasks. TaskInput defaults new tasks to today's date. Reschedule moves all overdue tasks to today. `WorkloadCapacityBar` (local component) sums `estimatedMinutes` from overdue + today tasks and shows planned vs capacity (from `daily_capacity_minutes` setting). Bar turns red with "+Xh over" text when exceeding capacity. Hidden when no tasks have estimated durations.

---

### Upcoming.tsx

- **Path:** `src/ui/views/Upcoming.tsx` (177 lines)
- **Purpose:** Shows upcoming tasks grouped by date, plus an overdue section at the top.
- **Key Exports:** `Upcoming`
- **Props:**
  - Same as TodayView plus `autoFocusTrigger`
- **Key Dependencies:** `TaskInput.tsx`, `TaskList.tsx`, `OverdueSection.tsx`, `EmptyState.tsx`, `toDateKey` from `utils/format-date.js`, `parseTask` from `parser/task-parser.js`
- **Used By:** `App.tsx`
- **Notes:** Groups tasks by due date with date headers (e.g., "Mon, Jan 15"). Overdue section with reschedule support (shared OverdueSection component with Today view). Month header displayed above date groups. EmptyState shown when no upcoming tasks exist.

---

### Project.tsx

- **Path:** `src/ui/views/Project.tsx` (415 lines)
- **Purpose:** Single project view with list and board layouts. Shows pending tasks belonging to the selected project with completion progress tracking.
- **Key Exports:** `Project`
- **Props:**
  - `project: ProjectType`
  - `tasks: Task[]`
  - `onCreateTask` -- parsed task input callback
  - `onToggleTask, onSelectTask`
  - `selectedTaskId: string | null`
  - `selectedTaskIds?, onMultiSelect?, onReorder?, onAddSubtask?, onUpdateDueDate?`
  - `autoFocusTrigger?: number`
  - `sections?, onCreateSection?, onUpdateSection?, onDeleteSection?, onMoveTask?`
  - `viewStyle?: "list" | "board" | "calendar"`
- **Key Dependencies:** `TaskInput.tsx`, `TaskList.tsx`, `Board.tsx`, `CompletionRing.tsx`, `SettingsContext.tsx`
- **Used By:** `App.tsx`
- **Notes:** Filters tasks to only show pending tasks for the current project. TaskInput placeholder customized with project name. Shows project icon (emoji) or color dot, name, task count, and `CompletionRing` showing completed/total progress in header. Supports sectioned list view and board (kanban) view. Section CRUD with inline editing, collapsible sections, and drag-and-drop task movement between sections.

---

### Completed.tsx

- **Path:** `src/ui/views/Completed.tsx` (161 lines)
- **Purpose:** Shows completed (and cancelled) tasks grouped by completion date, with project filter dropdown.
- **Key Exports:** `Completed`
- **Props:**
  - `tasks: Task[]`
  - `projects: Project[]`
  - `onSelectTask?: (id: string) => void`
- **Key Dependencies:** `EmptyState.tsx`, `lucide-react` (CheckCircle2)
- **Used By:** `App.tsx`
- **Notes:** Tasks grouped by `completedAt` date into sections with date headers. Filter by project dropdown in header. No TaskInput here (cannot add tasks to completed view). Uses EmptyState component when no completed tasks exist. Each task row is clickable (when onSelectTask provided) and shows project color dot and completion time.

---

### FiltersLabels.tsx

- **Path:** `src/ui/views/FiltersLabels.tsx` (284 lines)
- **Purpose:** Saved filters and labels (tags) management view with CRUD for both.
- **Key Exports:** `FiltersLabels`
- **Props:**
  - `tasks: Task[]`
  - `onNavigateToFilter: (query: string) => void`
- **Key Dependencies:** `api` (getAppSetting, setAppSetting, listTags), `lucide-react` (SlidersHorizontal, Tag, ChevronDown, ChevronRight, Plus, X, Filter)
- **Used By:** `App.tsx`
- **Notes:** Two collapsible sections: "My Filters" (saved query presets persisted via app settings) and "Labels" (tags loaded from API with per-tag pending task counts). Add filter form accepts name + query string. Tags are auto-created when assigned to tasks. Clicking a filter or label navigates via `onNavigateToFilter` callback.

---

### Board.tsx

- **Path:** `src/ui/views/Board.tsx` (313 lines)
- **Purpose:** Kanban board view for projects. Displays tasks as draggable cards organized into droppable section columns.
- **Key Exports:** `Board`
- **Props:**
  - `project: Project`
  - `tasks: Task[]`
  - `sections: Section[]`
  - `onMoveTask: (taskId: string, sectionId: string | null) => void`
  - `onToggleTask: (id: string) => void`
  - `onSelectTask: (id: string) => void`
  - `selectedTaskId: string | null`
- **Key Dependencies:** `@dnd-kit/core` (DndContext, DragOverlay, useDroppable, useDraggable, PointerSensor), `lucide-react` (Calendar, GripVertical), `getPriority` from `core/priorities.js`, `hexToRgba` from `utils/color.js`
- **Used By:** `App.tsx`
- **Notes:** Contains three internal sub-components: `DraggableCard` (individual task card with drag handle, priority circle, title, tags, due date), `BoardColumn` (droppable column with header showing section name and task count), and `DragOverlayCard` (floating ghost card rendered during drag with slight rotation and shadow). Groups tasks by `sectionId` -- tasks with no section appear in a "No section" column. Columns are sorted by `sortOrder`. Priority borders (p1=red, p2=amber, p3=accent) shown as left-border colors on cards. Overdue dates highlighted in red. Drag activation requires 8px distance to avoid accidental drags. Drop highlight shown as accent ring on target column.

---

### Cancelled.tsx

- **Path:** `src/ui/views/Cancelled.tsx` (157 lines)
- **Purpose:** Shows cancelled tasks grouped by cancellation date, with a "Restore" button to move tasks back to pending.
- **Key Exports:** `Cancelled`
- **Props:**
  - `tasks: Task[]`
  - `projects: Project[]`
  - `onSelectTask?: (id: string) => void`
  - `onRestoreTask?: (id: string) => void`
- **Key Dependencies:** `EmptyState.tsx`, `lucide-react` (XCircle)
- **Used By:** `App.tsx`
- **Notes:** Filters tasks by `status === "cancelled"` and sorts by `completedAt` (or `updatedAt` as fallback) in reverse chronological order. Tasks grouped by date with date headers (e.g., "Monday, Feb 15"). Each task row shows an XCircle icon, strikethrough title, project color dot with name, cancellation time, and optional "Restore" button. EmptyState shown when no cancelled tasks exist. Clickable task rows when `onSelectTask` is provided.

---

### Someday.tsx

- **Path:** `src/ui/views/Someday.tsx` (75 lines)
- **Purpose:** Someday/Maybe view for parked tasks. Shows tasks marked with `isSomeday=true` with an "Activate" button to move them back to active.
- **Key Exports:** `Someday`
- **Props:**
  - `tasks: Task[]`
  - `onSelectTask?: (id: string) => void`
  - `onActivateTask?: (id: string) => void`
- **Key Dependencies:** `EmptyState.tsx`, `lucide-react` (Lightbulb)
- **Used By:** `App.tsx`
- **Notes:** Filters tasks by `isSomeday === true && status === "pending"`, sorted by `createdAt` descending. Each task row shows a Lightbulb icon, title, and optional "Activate" button. EmptyState shown when no someday tasks exist. Clickable rows when `onSelectTask` is provided.

---

### Stats.tsx

- **Path:** `src/ui/views/Stats.tsx` (213 lines)
- **Purpose:** Productivity statistics dashboard with 4 stat cards and a 7-day completion bar chart.
- **Key Exports:** `Stats`
- **Props:**
  - `tasks: Task[]`
- **Key Dependencies:** `toDateKey` from `utils/format-date.js`, `lucide-react` (BarChart3, Flame, Calendar, Clock)
- **Used By:** `App.tsx`
- **Notes:** Four stat cards in a 2-column grid: "Today" (tasks completed today), "This Week" (tasks completed since Monday), "Streak" (consecutive days with at least 1 completion), and "Time Tracked" (total `estimatedMinutes` from completed tasks). Below the cards, a 7-day bar chart shows daily completion counts with today highlighted in accent color. Contains internal helpers: `formatMinutes` (converts minutes to "30m"/"1.5h"), `getWeekStart` (Monday-based), `getLast7Days`, and `computeStreak`. Bar heights proportional to max count, minimum 2px bar for zero-count days at 0.2 opacity.

---

### TaskPage.tsx

- **Path:** `src/ui/views/TaskPage.tsx` (218 lines)
- **Purpose:** Full-page task detail view. Two-column layout with content and metadata sidebar.
- **Key Exports:** `TaskPage`
- **Props:**
  - `task: Task`
  - `allTasks: Task[]`
  - `projects: { id: string; name: string }[]`
  - `onUpdate: (id: string, input: UpdateTaskInput) => void`
  - `onDelete: (id: string) => void`
  - `onNavigateBack: () => void`
  - `onSelect: (id: string) => void`
  - `onAddSubtask?, onToggleSubtask?, onReorder?`
  - `availableTags?: string[]`
- **Key Dependencies:** `SubtaskSection.tsx`, `TaskMetadataSidebar.tsx`, `ConfirmDialog.tsx`, `MarkdownMessage.tsx`, `useGeneralSettings` context
- **Used By:** `App.tsx`
- **Notes:** Title inline-editable with blur-to-save. Description toggles between Markdown preview (using `MarkdownMessage`) and edit mode (textarea) — click preview or pencil icon to edit, blur to save. Breadcrumb navigation at top shows project name (or "Inbox"). Subtask inline editing with save/cancel. Delete honors `confirm_delete` setting via ConfirmDialog. Responsive: stacks vertically on mobile, side-by-side on desktop.

---

### AIChat.tsx

- **Path:** `src/ui/views/AIChat.tsx` (49 lines)
- **Purpose:** Full-view AI chat interface. Wraps the `AIChatPanel` component in "view" mode (as opposed to sidebar/overlay mode).
- **Key Exports:** `AIChat`
- **Props:**
  - `onOpenSettings: () => void`
  - `onSelectTask?: (taskId: string) => void`
- **Key Dependencies:** `AIChatPanel.tsx`, `useAIContext`, `api` (loadModel, unloadModel)
- **Used By:** `App.tsx`
- **Notes:** Auto-manages LM Studio models when the view is active: loads the configured model on mount and unloads it on unmount, if the `junban.ai.auto-manage-lmstudio` localStorage flag is set. Renders AIChatPanel with `mode="view"` which changes its layout to fill the full content area instead of appearing as a sidebar panel.

---

### PluginView.tsx

- **Path:** `src/ui/views/PluginView.tsx` (70 lines)
- **Purpose:** Renders content from a plugin-registered custom view. Supports both text and structured content modes.
- **Key Exports:** `PluginView`
- **Props:**
  - `viewId: string`
  - `viewInfo?: ViewInfo` -- optional view metadata (slot, contentType, pluginId)
- **Key Dependencies:** `api.getPluginViewContent`, `StructuredContentRenderer`, `ViewInfo` from `../api/index.js`
- **Used By:** `App.tsx`
- **Notes:** If `viewInfo.contentType === "structured"`: parses content as JSON and renders via `StructuredContentRenderer` with 500ms polling (for responsive timer updates). If `contentType === "text"` (default): renders as monospace preformatted text with 1000ms polling. Uses a `mountedRef` to prevent state updates after unmount. Passes `handleCommand` callback to StructuredContentRenderer for button interactions.

---

### DopamineMenu.tsx

- **Path:** `src/ui/views/DopamineMenu.tsx` (157 lines)
- **Purpose:** Quick wins filtered view for low-motivation moments. Shows short, easy tasks to help users build momentum when they lack energy or motivation.
- **Key Exports:** `DopamineMenu`, `filterQuickWins`, `sortQuickWins`
- **Props:**
  - `tasks: Task[]`
  - `onToggleTask, onSelectTask`
  - `selectedTaskId: string | null`
  - `selectedTaskIds?, onMultiSelect?, onReorder?, onAddSubtask?, onUpdateDueDate?`
- **Key Dependencies:** `TaskList.tsx`, `lucide-react` (Zap)
- **Used By:** `App.tsx` (route: `dopamine-menu`)
- **Notes:** `filterQuickWins` selects pending tasks with `estimatedMinutes <= 15` or `priority >= 3` (low priority = easy). `sortQuickWins` orders by shortest estimated time first (nulls last). Shows a Zap icon header with task count. Renders the filtered list using standard `TaskList` component.

---

### QuickCapture.tsx

- **Path:** `src/ui/views/QuickCapture.tsx` (82 lines)
- **Purpose:** Minimal task input view for the Tauri global hotkey capture window. Contains only a `TaskInput` with no sidebar, navigation, or chrome.
- **Key Exports:** `QuickCapture`
- **Props:** None
- **Key Dependencies:** `TaskInput.tsx`, `isTauri` from `utils/tauri.js`, `@tauri-apps/api/window` (lazy import)
- **Used By:** `App.tsx` (route: `/quick-capture`)
- **Notes:** Lifecycle: on Enter (task submit) emits `quick-capture-submit` event to main window then hides; on Escape hides the window; on blur hides the window. Uses `getCurrentWindow().hide()` from Tauri APIs. Degrades gracefully in non-Tauri environments.

---

### Calendar.tsx

- **Path:** `src/ui/views/Calendar.tsx` (147 lines)
- **Purpose:** Calendar container view with day/week/month mode switcher. Delegates rendering to sub-views in `calendar/` directory.
- **Key Exports:** `Calendar`
- **Props:**
  - `tasks: Task[]`
  - `projects: Project[]`
  - `onSelectTask: (id: string) => void`
  - `onToggleTask: (id: string) => void`
  - `onUpdateDueDate?: (taskId: string, dueDate: string | null) => void`
  - `mode?: CalendarMode | null` -- externally controlled mode (from route)
  - `onModeChange?: (mode: CalendarMode) => void`
- **Key Dependencies:** `SegmentedControl` from `settings/components.js`, `useCalendarNavigation` hook, `CalendarWeekView`, `CalendarMonthView`, `CalendarDayView`, `useGeneralSettings` context, `lucide-react` (CalendarRange, ChevronLeft, ChevronRight)
- **Used By:** `App.tsx`
- **Notes:** Header contains a `SegmentedControl` for Day/Week/Month mode switching and Previous/Next/Today navigation buttons. Period label dynamically formatted based on current mode. Mode can be controlled externally via `mode` prop or defaults to the `calendar_default_mode` general setting. Clicking a day in week or month view drills down to day view. Task count badge shown in day mode. Uses `animate-fade-in` transition when switching modes.

---

## Calendar Sub-Views

### calendar/useCalendarNavigation.ts

- **Path:** `src/ui/views/calendar/useCalendarNavigation.ts` (165 lines)
- **Purpose:** Custom hook encapsulating all calendar navigation state and logic (date selection, mode switching, period labels, previous/next/today navigation).
- **Key Exports:**
  - `useCalendarNavigation(options?)` -- the main hook
  - `CalendarMode` type (`"day" | "week" | "month"`)
  - `getWeekStart(date, weekStartDay)` -- utility to get the start of a week
  - `getWeekDays(date, weekStartDay)` -- utility to get all 7 days of a week
- **Return value:** `{ selectedDate, mode, setMode, goNext, goPrev, goToday, setDate, isCurrentPeriod, periodLabel, weekStartDay }`
- **Key Dependencies:** `useGeneralSettings` context
- **Used By:** `Calendar.tsx`
- **Notes:** Respects the `week_start` setting (Sunday/Monday/Saturday). `isCurrentPeriod` is `true` when the selected date falls within the current day/week/month. `periodLabel` generates human-readable labels like "February 15-21, 2026" (week), "Friday, Feb 21, 2026" (day), or "February 2026" (month). Handles cross-month and cross-year week labels.

---

### calendar/CalendarDayView.tsx

- **Path:** `src/ui/views/calendar/CalendarDayView.tsx` (189 lines)
- **Purpose:** Single-day calendar view showing all tasks for the selected date, split into "All Day" and "Scheduled" (timed) sections.
- **Key Exports:** `CalendarDayView`
- **Props:**
  - `selectedDate: Date`
  - `tasks: Task[]`
  - `projects: Project[]`
  - `onSelectTask: (id: string) => void`
  - `onToggleTask: (id: string) => void`
- **Key Dependencies:** `toDateKey`, `formatTaskTime` from `utils/format-date.js`, `useGeneralSettings` context, `EmptyState.tsx`, `lucide-react` (Circle, CheckCircle2, CalendarOff)
- **Used By:** `Calendar.tsx`
- **Notes:** Tasks separated into all-day (no `dueTime`) and timed (with `dueTime`) groups. Timed tasks sorted chronologically. Task cards show priority border (P1=red, P2=amber, P3=accent), completion toggle, project color dot, priority tag, and hashtags. Completed tasks shown with strikethrough and reduced opacity. EmptyState displayed when no tasks exist for the day. Respects `time_format` setting (12h/24h) for timed tasks.

---

### calendar/CalendarWeekView.tsx

- **Path:** `src/ui/views/calendar/CalendarWeekView.tsx` (174 lines)
- **Purpose:** 7-day week grid showing tasks plotted by due date in columns.
- **Key Exports:** `CalendarWeekView`
- **Props:**
  - `selectedDate: Date`
  - `weekStartDay: number`
  - `tasks: Task[]`
  - `projects: Project[]`
  - `onSelectTask: (id: string) => void`
  - `onToggleTask: (id: string) => void`
  - `onDayClick: (date: Date) => void`
- **Key Dependencies:** `toDateKey` from `utils/format-date.js`, `getWeekDays` from `useCalendarNavigation.js`, `lucide-react` (Circle, CheckCircle2)
- **Used By:** `Calendar.tsx`
- **Notes:** Day headers are clickable buttons that drill down to day view via `onDayClick`. Today's column highlighted with accent background. Today's date shown as a filled accent circle. Task cards show priority left-border color, completion toggle, title (2-line clamp), and project color dot with name. Responsive 7-column grid layout with per-column scrolling.

---

### calendar/CalendarMonthView.tsx

- **Path:** `src/ui/views/calendar/CalendarMonthView.tsx` (178 lines)
- **Purpose:** Full-month grid showing task chips on each day cell.
- **Key Exports:** `CalendarMonthView`
- **Props:**
  - `selectedDate: Date`
  - `weekStartDay: number`
  - `tasks: Task[]`
  - `projects: Project[]`
  - `onSelectTask: (id: string) => void`
  - `onDayClick: (date: Date) => void`
- **Key Dependencies:** `toDateKey` from `utils/format-date.js`
- **Used By:** `Calendar.tsx`
- **Notes:** Always renders 6 rows (42 cells) for consistent height. Days outside the current month shown with muted background. Today highlighted with accent circle and subtle background. Maximum 3 visible task chips per day cell; overflow shown as "+N more" link that drills down to day view. Task chips show priority left-border, project color dot, and truncated title. Weekday headers respect `weekStartDay` setting.

---

### Settings.tsx

- **Path:** `src/ui/views/Settings.tsx` (322 lines)
- **Purpose:** Settings view with 10 tabs. Desktop layout shows sidebar tab list + content area in a modal. Mobile layout uses full-screen drill-down navigation (grouped index page -> tab content with back button).
- **Key Exports:** `Settings`, `SettingsTab` (re-exported type)
- **Props:**
  - `activeTab?: SettingsTab`
  - `onClose: () => void`
- **Key Dependencies:** All settings tab components, `useIsMobile` hook, `lucide-react` (X, SlidersHorizontal, Palette, Bot, Mic, Puzzle, Keyboard, Database, Info, FileText, ArrowLeft, ChevronRight)
- **Used By:** `App.tsx`
- **Notes:** Tabs: General, Appearance, Features, AI Assistant, Voice, Plugins, Templates, Keyboard, Data, About. Each tab has its own icon (separate desktop/mobile icon sizes). Closes on Escape (mobile: Escape navigates back to index first). Desktop: modal with backdrop that closes on click-outside. Mobile: full-screen with grouped sections (General, AI & Voice, Extensions, Info) on the index page and drill-down navigation with back button. Syncs `activeTab` prop changes (e.g., from command palette "Open AI settings"). Tab metadata includes optional subtitles shown on mobile index.

---

## Settings Tabs

### settings/types.ts

- **Path:** `src/ui/views/settings/types.ts` (11 lines)
- **Purpose:** Type definition for the `SettingsTab` union type.
- **Key Exports:** `SettingsTab` type (`"general" | "appearance" | "features" | "ai" | "voice" | "plugins" | "templates" | "keyboard" | "data" | "about"`)
- **Used By:** `Settings.tsx`, all tab components

---

### settings/components.tsx

- **Path:** `src/ui/views/settings/components.tsx` (130 lines)
- **Purpose:** Shared UI primitives for settings tabs.
- **Key Exports:**
  - `SegmentedControl<T>` -- horizontal button group for enum-like options (also used by Calendar header)
  - `ColorSwatchPicker` -- color circle picker with check mark
  - `SettingRow` -- label + description + control layout
  - `SettingSelect<T>` -- styled `<select>` dropdown
  - `Toggle` -- on/off toggle switch
- **Key Dependencies:** `lucide-react` (Check)
- **Used By:** `GeneralTab.tsx`, `AppearanceTab.tsx`, `Calendar.tsx`
- **Notes:** These are generic, reusable primitives. `Toggle` renders as a rounded pill with sliding circle indicator. `SegmentedControl` highlights the active option with accent color and white text. Supports disabled state on `Toggle`.

---

### settings/GeneralTab.tsx

- **Path:** `src/ui/views/settings/GeneralTab.tsx` (357 lines)
- **Purpose:** General settings: Date & Time (week start, date format, time format, default calendar view), Task Behavior (default priority, confirm delete, start view, daily capacity), Sound Effects (enable/disable, volume, per-event toggles with preview), and Notifications (browser notifications, toast notifications, default reminder offset).
- **Key Exports:** `GeneralTab`
- **Props:** None (reads from `useGeneralSettings` context)
- **Key Dependencies:** `SettingsContext`, settings `components.tsx`, `previewSound` from `utils/sounds.js`, `api` (getAppSetting, setAppSetting), `lucide-react` (Bell, Volume2)
- **Used By:** `Settings.tsx`
- **Notes:** Contains three sub-components: `SoundSettings` and `NotificationSettings` (defined in the same file), plus a `dateFormatPreview` helper. Sound section includes per-event preview buttons for complete, create, delete, and reminder events. Notification section handles browser permission requests with fallback for denied/unsupported states. Date format shows live preview. "Default calendar view" setting added for Day/Week/Month mode. "Daily capacity" setting (4h/6h/8h/10h) controls the workload capacity bar in Today view.

---

### settings/AppearanceTab.tsx

- **Path:** `src/ui/views/settings/AppearanceTab.tsx` (98 lines)
- **Purpose:** Appearance settings: Theme (system/light/dark/nord), Accent color (preset color swatches), Layout (density: compact/default/comfortable, font size: small/default/large), and Accessibility (reduce animations toggle).
- **Key Exports:** `AppearanceTab`
- **Props:** None (reads from `useGeneralSettings` context and `themeManager`)
- **Key Dependencies:** `SettingsContext`, `ThemeManager`, `DEFAULT_PROJECT_COLORS`, settings `components.tsx`
- **Used By:** `Settings.tsx`
- **Notes:** Theme changes take effect immediately via ThemeManager. Accent color, density, and font size also apply immediately via CSS custom properties and classes. Uses `ColorSwatchPicker` for accent color selection and `SegmentedControl` for theme, density, and font size choices.

---

### settings/AITab.tsx

- **Path:** `src/ui/views/settings/AITab.tsx` (323 lines)
- **Purpose:** AI provider configuration: provider selection, API key input, model selection (dropdown or custom text), base URL, save button, and LM Studio auto-manage toggle.
- **Key Exports:** `AITab`
- **Props:** None (reads from `useAIContext`)
- **Key Dependencies:** `AIContext`, `api` (listAIProviders, fetchModels, loadModel)
- **Used By:** `Settings.tsx`
- **Notes:** Provider help text shown below API key input. Model dropdown auto-populated via `fetchModels` API call with 300ms debounce on baseUrl changes. When a model is selected in LM Studio, it auto-loads the model. Supports custom model input with a "Back to model list" toggle. Shows "Connected" or "Not configured" status. LM Studio-specific auto-manage checkbox stores preference in localStorage (`junban.ai.auto-manage-lmstudio`). Plugin-provided providers shown with "(plugin)" label.

---

### settings/VoiceTab.tsx

- **Path:** `src/ui/views/settings/VoiceTab.tsx` (842 lines)
- **Purpose:** Voice settings: Microphone selection (with permission handling), STT provider selection, TTS provider and voice/model selection with preview, Voice interaction mode (off/push-to-talk/VAD), auto-send, smart endpoint with grace period slider, and Local Models management (download, preload, delete browser-cached ML models).
- **Key Exports:** `VoiceTab`
- **Props:** None (reads from `useVoiceContext`)
- **Key Dependencies:** `VoiceContext`, `VoiceProviderRegistry`, `enumerateMicrophones`, `triggerMicPermissionPrompt` from `audio-utils.js`, `lucide-react` (Mic, RefreshCw, AlertCircle, CheckCircle2, Download, Loader2, Play, Trash2)
- **Used By:** `Settings.tsx`
- **Notes:** Contains multiple sub-components defined in the same file: `ProviderApiKeyInput` (handles Groq and Inworld API keys), `MicrophoneSection` (permission prompt with timeout fallback for Linux/PipeWire issues, device enumeration, device change listener), and `LocalModelsSection` (two-phase cache check: fast cached/not-cached status then lazy size fetching via requestIdleCallback). Voice preview button speaks a test sentence. Grace period slider ranges from 0.5s to 3.0s. Local models show download progress bars, cached status with size, and delete confirmation.

---

### settings/PluginsTab.tsx

- **Path:** `src/ui/views/settings/PluginsTab.tsx` (123 lines)
- **Purpose:** Plugin management: lists built-in extensions and community plugins with enable/disable toggle, permission approval/revocation, and a button to browse community plugins.
- **Key Exports:** `PluginsTab`
- **Props:** None (reads from `usePluginContext`)
- **Key Dependencies:** `PluginContext`, `PermissionDialog.tsx`, `PluginCard.tsx`, `PluginBrowser.tsx`, `api` (approvePluginPermissions, revokePluginPermissions, togglePlugin), `lucide-react` (Puzzle)
- **Used By:** `Settings.tsx`
- **Notes:** Separates plugins into "Built-in Extensions" (with enable/disable toggle) and "Community Plugins" (with permission approval/revocation) sections. Built-in plugins displayed in a 2-column grid of PluginCard components. "Browse Community Plugins" button opens the PluginBrowser modal. PermissionDialog shown when approving community plugin permissions.

---

### settings/TemplatesTab.tsx

- **Path:** `src/ui/views/settings/TemplatesTab.tsx` (296 lines)
- **Purpose:** Task template management: create, edit, and delete templates. Template form supports name, title template (with `{{variable}}` syntax), description, priority, tags, and recurrence.
- **Key Exports:** `TemplatesTab`
- **Props:** None (uses `api` directly)
- **Key Dependencies:** `api` (listTemplates, createTemplate, updateTemplate, deleteTemplate), `core/types.js` (TaskTemplate, CreateTemplateInput), `utils/logger.js`, `lucide-react` (Plus, Pencil, Trash2)
- **Used By:** `Settings.tsx`
- **Notes:** TemplateForm sub-component for create/edit with form validation (name and title required). Tags entered as comma-separated string. Priority and recurrence via dropdown selects. Template list shows priority badge, tag badges, and recurrence badge. Empty state with prompt to create first template.

---

### settings/KeyboardTab.tsx

- **Path:** `src/ui/views/settings/KeyboardTab.tsx` (93 lines)
- **Purpose:** Keyboard shortcut customization. Lists all registered shortcuts with current key bindings. Supports recording new bindings and resetting to defaults.
- **Key Exports:** `KeyboardTab`
- **Props:** None (uses `shortcutManager` singleton)
- **Key Dependencies:** `shortcutManager` from `shortcutManagerInstance.js`, `api` (persists custom bindings via setAppSetting)
- **Used By:** `Settings.tsx`
- **Notes:** Recording mode captures next keypress as new binding (captures on `keydown` with `useCapture: true`). Escape cancels recording. Modifier-only keys (Control, Meta, Alt, Shift) are ignored during recording. Reset button shown only when binding differs from default. Persists to `keyboard_shortcuts` app setting as JSON. Subscribes to shortcutManager changes for reactive updates.

---

### settings/DataTab.tsx

- **Path:** `src/ui/views/settings/DataTab.tsx` (294 lines)
- **Purpose:** Data management: storage info display, export (JSON/CSV/Markdown), and import (Junban JSON, Todoist JSON, Markdown/text) with preview step.
- **Key Exports:** `DataTab`
- **Props:** None (uses `api` and `useTaskContext`)
- **Key Dependencies:** `api` (exportAllData, importTasks, getStorageInfo), `core/export.js` (exportJSON, exportCSV, exportMarkdown), `core/import.js` (parseImport), `TaskContext`
- **Used By:** `Settings.tsx`
- **Notes:** Contains two sub-components: `StorageSection` (shows current mode SQLite/Markdown and path, with explanation of each mode) and `DataSection` (export/import). Export triggers browser file download via Blob URL. Import has a multi-step flow: file selection -> preview (showing task count, projects, tags, warnings) -> confirm import -> success with result summary. File input accepts `.json`, `.txt`, `.md`. Refreshes task list after successful import.

---

### settings/FeaturesTab.tsx

- **Path:** `src/ui/views/settings/FeaturesTab.tsx` (82 lines)
- **Purpose:** Feature flag toggles. Lets users enable or disable optional features (project sections, kanban, time estimates, deadlines, comments, stats, someday, cancelled tasks, keyboard chords).
- **Key Exports:** `FeaturesTab`
- **Props:** None (reads from `useGeneralSettings` context)
- **Key Dependencies:** `SettingsContext`, settings `components.tsx` (SettingRow, Toggle)
- **Used By:** `Settings.tsx`
- **Notes:** 9 feature flags, each stored as a `feature_*` key in general settings. Toggling a feature hides it from the interface but preserves underlying data. Uses a `FEATURES` array of `{ key, label, description }` objects for declarative rendering. Each feature flag reads as a string `"true"` / `"false"` from settings.

---

### settings/FeaturesTab.tsx

- **Path:** `src/ui/views/settings/FeaturesTab.tsx` (97 lines)
- **Purpose:** Feature toggles — lets users enable/disable optional features (sections, kanban, time estimates, deadlines, comments, calendar view, filters/labels, completed view, stats, someday, cancelled, keyboard chords). Disabled features are hidden from the UI but data is preserved.
- **Key Exports:** `FeaturesTab`
- **Props:** None
- **Key Dependencies:** `SettingsContext` (useGeneralSettings), settings `SettingRow`/`Toggle` components
- **Used By:** `Settings.tsx`

---

### settings/AboutTab.tsx

- **Path:** `src/ui/views/settings/AboutTab.tsx` (314 lines)
- **Purpose:** About page with app info, version, update checker (Tauri only), and open source credits listing all dependencies organized by category.
- **Key Exports:** `AboutTab`
- **Props:** None
- **Key Dependencies:** `@tauri-apps/plugin-updater` (lazy import), `@tauri-apps/plugin-process` (lazy import), `isTauri` utility, `lucide-react` (ExternalLink)
- **Used By:** `Settings.tsx`
- **Notes:** Update check only available in Tauri desktop mode. Credits organized into 6 categories: AI & Machine Learning (5 items), Frontend (5 items), Database & Storage (3 items), Desktop & Platform (2 items), Parsing & Utilities (4 items), Testing (2 items). Each credit links to its repository and shows its license. Footer links to AI Strategic Forum GitHub. App version shown as v1.0.0.
