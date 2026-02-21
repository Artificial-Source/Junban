# Frontend Files Index

> Master index of every file in `src/ui/`, sorted by directory.

---

## Root Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/App.tsx` | 791 | Root React component. Wraps everything in 6 nested context providers. Contains `AppContent` which handles routing, layout, state orchestration, and renders all views. |
| `src/ui/main.tsx` | 12 | Entry point. Renders `<App />` in `React.StrictMode`. Imports theme manager to trigger initialization. |
| `src/ui/index.css` | 135 | Root CSS. Imports Tailwind and all theme CSS files. Defines custom fonts (Outfit, Space Grotesk, Space Mono), density scaling, font size variants, reduce-motion class, and 8 animations (fade-in, slide-up-fade, scale-fade-in, drop-fade-in, toast-in, pop-in, message-enter, typing-shimmer). |
| `src/ui/shortcuts.ts` | 160 | `ShortcutManager` class. Handles registration, rebinding, conflict detection, key normalization, serialization, and subscription for keyboard shortcuts. |
| `src/ui/shortcutManagerInstance.ts` | 3 | Singleton `ShortcutManager` instance shared across the app. |

---

## API Layer (`src/ui/api/`)

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/api/index.ts` | 28 | Barrel export. Combines all submodules into unified `api` object. Re-exports types. |
| `src/ui/api/helpers.ts` | 45 | Shared utilities: `isTauri`, `BASE` URL, `handleResponse`, `handleVoidResponse`, lazy `getServices`. |
| `src/ui/api/tasks.ts` | 237 | Task CRUD, bulk operations, tree/subtask ops, reminders, reorder, import. |
| `src/ui/api/projects.ts` | 80 | Project CRUD (list, create, update, delete) and tag listing. |
| `src/ui/api/templates.ts` | 78 | Template CRUD and instantiation with variable interpolation. |
| `src/ui/api/plugins.ts` | 269 | Plugin management, commands, UI registry, permissions, store, install/uninstall, toggle. |
| `src/ui/api/ai.ts` | 462 | AI provider config, SSE chat streaming, model discovery, load/unload, chat sessions (list, rename, delete, switch, create new). |
| `src/ui/api/settings.ts` | 65 | App settings get/set, storage info, data export. |

---

## Components (`src/ui/components/`)

### Task Components

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/components/TaskInput.tsx` | 107 | Natural language task input with live NLP preview. |
| `src/ui/components/TaskItem.tsx` | 300 | Single task row with priority circle, metadata, drag handle. `React.memo` wrapped. |
| `src/ui/components/TaskList.tsx` | 278 | Sortable task list with @dnd-kit, tree flattening, inline subtask creation. |
| `src/ui/components/TaskDetailPanel.tsx` | 350 | Modal task detail with two-column layout, inline editing, subtask section. |
| `src/ui/components/SubtaskBlock.tsx` | 142 | Individual subtask row with inline editing and DnD sortable wrapper. |
| `src/ui/components/SubtaskSection.tsx` | 268 | Collapsible subtask list with DnD, progress bar, inline add. |
| `src/ui/components/InlineAddSubtask.tsx` | 65 | Inline subtask creation input for tree view. |
| `src/ui/components/TaskMetadataSidebar.tsx` | 332 | Task metadata editor sidebar (date, priority, tags, reminder, recurrence, status). |
| `src/ui/components/OverdueSection.tsx` | 99 | Shared overdue tasks section with expand/collapse and reschedule. |
| `src/ui/components/VirtualizedTaskList.tsx` | 72 | Virtualized task list using @tanstack/react-virtual for large lists. |
| `src/ui/components/TaskPreview.tsx` | 74 | Hover popover showing task metadata on 300ms delay. |

### Navigation Components

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/components/Sidebar.tsx` | 480 | Main navigation sidebar with views, projects, favorites, plugins, workspace tools. Collapsible. |
| `src/ui/components/BottomNavBar.tsx` | 128 | Mobile bottom nav with AI orb (long-press for voice). |
| `src/ui/components/MobileDrawer.tsx` | 62 | Slide-in drawer for mobile sidebar. |
| `src/ui/components/CommandPalette.tsx` | 150 | Fuzzy search command palette (Ctrl+K). |
| `src/ui/components/SearchModal.tsx` | 248 | Global task search with debounced query and keyboard nav. |
| `src/ui/components/Breadcrumb.tsx` | 35 | Breadcrumb navigation for project and task views. |

### AI Components

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/components/AIChatPanel.tsx` | 456 | AI chat panel with SSE streaming, markdown, voice, tool calls, session history. Supports `panel` and `view` modes. |
| `src/ui/components/VoiceCallOverlay.tsx` | 89 | Voice call full-screen overlay with state indicator and timer. |
| `src/ui/components/ChatTaskCard.tsx` | 111 | Compact task card rendered inline in AI chat messages after tool calls. |

### Chat Sub-Components (`src/ui/components/chat/`)

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/components/chat/index.ts` | 13 | Barrel export for all chat sub-components and types. |
| `src/ui/components/chat/MessageBubble.tsx` | 231 | Renders user, assistant, and error message bubbles with tool call extraction. `React.memo` wrapped. |
| `src/ui/components/chat/ChatInput.tsx` | 117 | Chat text input with send button, voice button, and call button. `forwardRef` for focus management. |
| `src/ui/components/chat/ChatToolResultCard.tsx` | 451 | Rich tool result visualizations: workload chart, completion patterns, energy recommendations, task lists, breakdowns, overcommitment, tag suggestions, similar tasks, project list, reminder list. |
| `src/ui/components/chat/MarkdownMessage.tsx` | 186 | Markdown renderer using react-markdown + remark-gfm. Supports code copy, collapsible details, `saydo://` task links, tables. |
| `src/ui/components/chat/MessageActions.tsx` | 119 | Hover action bar for messages: copy, edit & resend (user), regenerate (assistant). |
| `src/ui/components/chat/SuggestedActions.tsx` | 65 | Context-aware follow-up suggestion chips shown after assistant responses. |
| `src/ui/components/chat/ToolCallBadge.tsx` | 58 | Emoji-labeled badge for in-progress or completed tool calls (30 tool types mapped). |
| `src/ui/components/chat/TypingIndicator.tsx` | 27 | Animated shimmer typing indicator shown while AI is responding. |
| `src/ui/components/chat/VoiceButton.tsx` | 103 | Push-to-talk voice button with state indicators (idle, listening, transcribing, speaking). |
| `src/ui/components/chat/WelcomeScreen.tsx` | 141 | AI chat welcome screen with greeting, task stats, and suggestion cards. |
| `src/ui/components/chat/ChatHistory.tsx` | 166 | Chat session history panel with new chat, switch, rename, and delete. |

### Plugin Components

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/components/PluginBrowser.tsx` | 657 | Full-screen plugin browser modal with search, filter tabs (all/installed/not-installed), split-pane detail view, install/uninstall/toggle actions. |
| `src/ui/components/PluginCard.tsx` | 559 | Reusable plugin card with two modes: `store` (install/uninstall) and `settings` (toggle/permissions). Includes gradient banners, plugin settings editor. |

### Forms & Modals

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/components/DatePicker.tsx` | 217 | Calendar date picker with quick options and time input. |
| `src/ui/components/RecurrencePicker.tsx` | 131 | Recurrence rule picker (daily, weekly, monthly, custom). |
| `src/ui/components/TagsInput.tsx` | 145 | Tag input with autocomplete and colored chips. |
| `src/ui/components/TemplateSelector.tsx` | 206 | Template browser with variable form. |
| `src/ui/components/AddProjectModal.tsx` | 375 | Project creation modal with name, emoji, color, parent project, view style. |
| `src/ui/components/PermissionDialog.tsx` | 83 | Plugin permission approval dialog. |
| `src/ui/components/ConfirmDialog.tsx` | 102 | Styled confirmation dialog (danger/default). |
| `src/ui/components/QuickAddModal.tsx` | 65 | Quick-add task modal (Ctrl+N / q shortcut). |
| `src/ui/components/ContextMenu.tsx` | 182 | Generic right-click context menu with submenus and keyboard nav. |
| `src/ui/components/OnboardingModal.tsx` | 102 | 3-step onboarding wizard for first-run experience. |

### UI Chrome

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/components/BulkActionBar.tsx` | 124 | Sticky bar for multi-select bulk operations. |
| `src/ui/components/FAB.tsx` | 17 | Mobile floating action button. |
| `src/ui/components/FocusMode.tsx` | 258 | Full-screen single-task focus mode with keyboard shortcuts. |
| `src/ui/components/QueryBar.tsx` | 177 | Search/filter bar with debounced parsing and suggestions. |
| `src/ui/components/StatusBar.tsx` | 20 | Bottom status bar for plugin items. |
| `src/ui/components/PluginPanel.tsx` | 17 | Plugin sidebar panel container. |
| `src/ui/components/Toast.tsx` | 42 | Auto-dismissing toast notification with undo action. |
| `src/ui/components/EmptyState.tsx` | 26 | Reusable empty state with icon, title, description, and optional action. |
| `src/ui/components/Skeleton.tsx` | 45 | Skeleton loading components (SkeletonLine, SkeletonTaskItem, SkeletonTaskList). |
| `src/ui/components/CompletionRing.tsx` | 45 | SVG circle progress ring for daily completion stats. |
| `src/ui/components/ErrorBoundary.tsx` | 57 | React error boundary with fallback UI. |

---

## Views (`src/ui/views/`)

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/views/Inbox.tsx` | 83 | Inbox view -- unassigned pending tasks. |
| `src/ui/views/Today.tsx` | 142 | Today's tasks + overdue section with reschedule. |
| `src/ui/views/Upcoming.tsx` | 176 | Date-grouped upcoming tasks + overdue section. |
| `src/ui/views/Project.tsx` | 79 | Single project view. |
| `src/ui/views/Completed.tsx` | 160 | Completed tasks grouped by date with project filter. |
| `src/ui/views/FiltersLabels.tsx` | 283 | Saved filters and tag/label management. |
| `src/ui/views/TaskPage.tsx` | 183 | Full-page task detail view. |
| `src/ui/views/PluginView.tsx` | 40 | Plugin custom view renderer (polls content). |
| `src/ui/views/Calendar.tsx` | 147 | Calendar view shell with day/week/month mode switcher, navigation controls, and sub-view rendering. |
| `src/ui/views/AIChat.tsx` | 49 | AI Chat full-page view wrapper. Auto-manages LM Studio model loading/unloading. |
| `src/ui/views/Settings.tsx` | 322 | Settings modal with 9 tabs, responsive layout (mobile index page with sections, desktop split-pane). |

### Calendar Sub-Views (`src/ui/views/calendar/`)

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/views/calendar/useCalendarNavigation.ts` | 165 | Calendar navigation hook: mode switching (day/week/month), prev/next/today, period labels, week start offset. Exports `getWeekStart` and `getWeekDays` helpers. |
| `src/ui/views/calendar/CalendarDayView.tsx` | 189 | Day view with all-day and timed task sections, priority borders, project/tag display. |
| `src/ui/views/calendar/CalendarWeekView.tsx` | 174 | 7-column week grid with day headers, task cards with priority borders, day click navigation. |
| `src/ui/views/calendar/CalendarMonthView.tsx` | 178 | 6-row month grid with day numbers, task chips (max 3 visible + overflow count), cross-month fading. |

### Settings Tabs (`src/ui/views/settings/`)

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/views/settings/types.ts` | 10 | `SettingsTab` union type. |
| `src/ui/views/settings/components.tsx` | 129 | Shared primitives: SegmentedControl, ColorSwatchPicker, SettingRow, SettingSelect, Toggle. |
| `src/ui/views/settings/GeneralTab.tsx` | 341 | Date/time, task behavior, sound effects, notifications, calendar defaults. |
| `src/ui/views/settings/AppearanceTab.tsx` | 97 | Theme, accent color, density, font size, reduce animations. |
| `src/ui/views/settings/AITab.tsx` | 322 | AI provider config, model selection, connection status. |
| `src/ui/views/settings/VoiceTab.tsx` | 841 | Microphone, STT/TTS providers, voice mode, local models. |
| `src/ui/views/settings/PluginsTab.tsx` | 122 | Plugin cards with settings, permissions, enable/disable, plugin browser launch. |
| `src/ui/views/settings/TemplatesTab.tsx` | 295 | Template CRUD with variable syntax support. |
| `src/ui/views/settings/KeyboardTab.tsx` | 92 | Keyboard shortcut customization with recording. |
| `src/ui/views/settings/DataTab.tsx` | 293 | Storage info, export (JSON/CSV/MD), import with preview. |
| `src/ui/views/settings/AboutTab.tsx` | 313 | App info, update checker, open source credits. |

---

## Context Providers (`src/ui/context/`)

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/context/TaskContext.tsx` | 234 | Task/project/tag state with useReducer. Central data store. |
| `src/ui/context/AIContext.tsx` | 481 | AI chat state, SSE streaming, tool calls, voice call mode, session management (create, switch, delete, rename). |
| `src/ui/context/PluginContext.tsx` | 138 | Plugin state: plugins, commands, status bar, panels, views. |
| `src/ui/context/VoiceContext.tsx` | 291 | Voice state: STT/TTS providers, recording, playback, settings. |
| `src/ui/context/UndoContext.tsx` | 93 | Undo/redo stack with toast notifications. |
| `src/ui/context/SettingsContext.tsx` | 178 | General settings with live CSS property application. |

---

## Hooks (`src/ui/hooks/`)

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/hooks/useRouting.ts` | 280 | Hash-based routing with View type and navigation functions. |
| `src/ui/hooks/useTaskHandlers.ts` | 124 | Task CRUD handlers with sound effects and undo support. |
| `src/ui/hooks/useKeyboardNavigation.ts` | 71 | Vim-style j/k/Enter/Escape task list navigation. |
| `src/ui/hooks/useMultiSelect.ts` | 52 | Ctrl/Shift multi-select with range support. |
| `src/ui/hooks/useBulkActions.ts` | 51 | Bulk complete/delete/move/tag operations. |
| `src/ui/hooks/useAppShortcuts.ts` | 87 | Registers global keyboard shortcuts (Ctrl+K, Ctrl+Z, etc.). |
| `src/ui/hooks/useAppCommands.ts` | 129 | Builds command palette command list. |
| `src/ui/hooks/useIsMobile.ts` | 19 | Mobile viewport detection via matchMedia. |
| `src/ui/hooks/useSoundEffect.ts` | 30 | Sound playback respecting user settings. |
| `src/ui/hooks/useReminders.ts` | 51 | Polls for due reminders, fires browser notifications. |
| `src/ui/hooks/useVAD.ts` | 202 | Voice Activity Detection with smart endpoint grace period. |
| `src/ui/hooks/useVoiceCall.ts` | 197 | Voice call state machine orchestration. |
| `src/ui/hooks/useFocusTrap.ts` | 50 | Focus trapping for modals/drawers (saves/restores focus, traps Tab). |

---

## Theme System (`src/ui/themes/`)

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/themes/manager.ts` | 90 | ThemeManager class: load, switch, toggle, persist themes. |
| `src/ui/themes/light.css` | 27 | Light theme design tokens (default). |
| `src/ui/themes/dark.css` | 22 | Dark theme token overrides. |
| `src/ui/themes/nord.css` | 22 | Nord palette token overrides. |

---

## Total Line Count Summary

| Category | Files | Total Lines |
|----------|-------|-------------|
| Root files | 5 | 1,101 |
| API layer | 8 | 1,264 |
| Components | 41 | 6,282 |
| Chat sub-components | 12 | 1,677 |
| Plugin components | 2 | 1,216 |
| Views | 11 | 1,664 |
| Calendar sub-views | 4 | 706 |
| Settings tabs | 11 | 2,855 |
| Context providers | 6 | 1,415 |
| Hooks | 13 | 1,343 |
| Theme system | 4 | 161 |
| **Total** | **117** | **19,684** |
