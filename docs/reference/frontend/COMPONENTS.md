# Frontend Components Reference

> Overview of the key components in `src/ui/components/`, grouped by category. Treat exact file sizes as incidental; use the code as the source of truth when a component is actively changing.
>
> Boundary note: this reference focuses on component responsibilities. For state-provider contracts, see [`CONTEXT.md`](CONTEXT.md); for page/view-level composition, see [`VIEWS.md`](VIEWS.md).

---

## Task Components

### TaskInput.tsx

- **Path:** `src/ui/components/TaskInput.tsx`
- **Purpose:** Natural language task input field. Parses free-text into structured task data in real time using the NLP parser.
- **Key Exports:** `TaskInput`
- **Props:**
  - `onAddTask: (input: CreateTaskInput) => void` -- callback fired with parsed task data on submit
  - `defaultProjectId?: string` -- pre-selects a project for the created task
- **Key Dependencies:** `parseTask` from `../../parser/task-parser.js`, `CreateTaskInput` from `../../core/types.js`
- **Used By:** `Inbox.tsx`, `Today.tsx`, `Upcoming.tsx`, `Project.tsx`
- **Notes:** Shows a live preview line below the input displaying parsed due date, priority, and tags. When the field is focused, it also reveals a lightweight metadata toolbar for click-based priority, date, and label selection without leaving the natural-language input flow. Submits on Enter, clears input on success. Preview tokens are styled as colored pill badges with icons (Flag for priority, Hash for tags, Calendar for date, FolderOpen for project, Repeat for recurrence).

---

### TaskItem.tsx

- **Path:** `src/ui/components/TaskItem.tsx`
- **Purpose:** Renders a single task row with priority-colored completion circle, title, metadata line (due date, project, tags, recurrence), drag handle, and optional subtask expand toggle.
- **Key Exports:** `TaskItem` (wrapped in `React.memo`)
- **Props:**
  - `task: Task` -- the task data
  - `onComplete: (id: string) => void`
  - `onDelete: (id: string) => void`
  - `onSelect: (id: string) => void`
  - `onNavigateToTask?: (id: string) => void`
  - `selected?: boolean`
  - `highlighted?: boolean`
  - `isMultiSelected?: boolean`
  - `depth?: number` -- indentation level for subtask hierarchy
  - `childCount?: number`
  - `isExpanded?: boolean`
  - `onToggleExpand?: (id: string) => void`
  - `dragHandleProps?: object` -- from @dnd-kit for drag handle
  - `projects?: Project[]`
- **Key Dependencies:** `lucide-react` icons, `DatePicker.tsx` (inline date editing), `core/types.js`
- **Used By:** `TaskList.tsx` (via `SortableTaskItem`), `FocusMode.tsx`
- **Notes:** Priority colors map: p1=red, p2=amber, p3=accent, p4=muted. Overdue dates shown in red. Mobile-responsive -- hides drag handle on touch devices. Supports `onContextMenu` handler for right-click context menu integration.

---

### TaskList.tsx

- **Path:** `src/ui/components/TaskList.tsx`
- **Purpose:** Startup-safe task list entry point that renders a lightweight base list immediately and lazily upgrades to the enhanced drag-and-drop/virtualized list when reordering is available.
- **Key Exports:** `TaskList`
- **Props:**
  - `tasks: Task[]`
  - `onToggle: (id: string) => void`
  - `onSelect: (id: string) => void`
  - `onReorder?: (orderedIds: string[]) => void`
  - `selectedTaskId: string | null`
  - `selectedTaskIds?: Set<string>`
  - `onMultiSelect?: (id, event) => void`
  - `onAddSubtask?: (parentId: string, title: string) => void`
  - `onUpdateDueDate?: (taskId: string, dueDate: string | null) => void`
  - `onContextMenu?: (taskId: string, position: { x: number; y: number }) => void` -- right-click context menu handler, passed through to TaskItem
- **Key Dependencies:** `task-list/TaskListBase.tsx`, `task-list/TaskListEnhanced.tsx`, `TaskItem.tsx`, `InlineAddSubtask.tsx`
- **Used By:** `Inbox.tsx`, `Today.tsx`, `Upcoming.tsx`, `Project.tsx`, `Completed.tsx`
- **Notes:** The base list handles tree flattening, expansion state, selection, inline subtask creation, due-date updates, and context menus without pulling drag/drop or virtualization code into the first render. When `onReorder` is provided, the enhanced list is preloaded during idle time and upgrades in place with drag-and-drop, drag overlay, framer-motion list transitions, and virtualization for long lists.

---

### TaskDetailPanel.tsx

- **Path:** `src/ui/components/TaskDetailPanel.tsx`
- **Purpose:** Modal dialog showing full task details in a two-column layout: content area (title, description with Markdown preview, subtasks) on the left and metadata sidebar on the right.
- **Key Exports:** `TaskDetailPanel`
- **Props:**
  - `task: Task`
  - `tasks: Task[]` -- full task list for prev/next navigation
  - `projects: Project[]`
  - `onUpdate: (id, input) => void`
  - `onComplete: (id) => void`
  - `onDelete: (id) => void`
  - `onClose: () => void`
  - `onNavigateToTask: (id) => void`
  - `onAddSubtask?: (parentId, title) => void`
  - `onCompleteSubtask?: (id) => void`
  - `onDeleteSubtask?: (id) => void`
  - `onUpdateSubtask?: (id, input) => void`
  - `onReorderSubtasks?: (ids) => void`
- **Key Dependencies:** `SubtaskSection.tsx`, `TaskMetadataSidebar.tsx`, `MarkdownMessage.tsx`, `lucide-react`
- **Used By:** `App.tsx` (rendered as overlay when a task is selected)
- **Notes:** Title is inline-editable. Description toggles between Markdown preview (using `MarkdownMessage`) and edit mode (textarea) — click preview or pencil icon to edit, blur to save. Arrow key navigation between tasks in the list. Closes on Escape. Mobile-responsive -- stacks columns vertically on small screens.

---

### SubtaskBlock.tsx

- **Path:** `src/ui/components/SubtaskBlock.tsx`
- **Purpose:** Renders an individual subtask row with inline editing, completion toggle, and delete button. Wraps in a sortable container for DnD.
- **Key Exports:** `SubtaskBlock`, `SortableSubtaskBlock`
- **Props:**
  - `subtask: Task`
  - `onComplete, onDelete, onUpdate` -- callbacks
- **Key Dependencies:** `@dnd-kit/sortable`, `@dnd-kit/utilities`, `lucide-react`
- **Used By:** `SubtaskSection.tsx`
- **Notes:** Double-click or Enter to start editing. Escape cancels edit. Saves on blur or Enter.

---

### SubtaskSection.tsx

- **Path:** `src/ui/components/SubtaskSection.tsx`
- **Purpose:** Collapsible subtask list with DnD reordering, progress bar showing completion ratio, and inline "add subtask" input.
- **Key Exports:** `SubtaskSection`
- **Props:**
  - `parentId: string`
  - `subtasks: Task[]`
  - `onAdd?: (parentId, title) => void`
  - `onComplete?, onDelete?, onUpdate?, onReorder?` -- subtask action callbacks
- **Key Dependencies:** `@dnd-kit/core`, `@dnd-kit/sortable`, `SubtaskBlock.tsx`, `lucide-react`
- **Used By:** `TaskDetailPanel.tsx`, `TaskPage.tsx`
- **Notes:** Collapsed by default if there are no subtasks. Progress bar uses accent color. Shows "X of Y" completion count.

---

### InlineAddSubtask.tsx

- **Path:** `src/ui/components/InlineAddSubtask.tsx`
- **Purpose:** Inline input for creating subtasks directly within the TaskList tree view (not the detail panel).
- **Key Exports:** `InlineAddSubtask`
- **Props:**
  - `parentId: string`
  - `depth: number`
  - `onAdd: (parentId: string, title: string) => void`
- **Key Dependencies:** `lucide-react` (Plus icon)
- **Used By:** `TaskList.tsx`
- **Notes:** Appears below expanded parent tasks. Submits on Enter, clears on success.

---

### TaskMetadataSidebar.tsx

- **Path:** `src/ui/components/TaskMetadataSidebar.tsx`
- **Purpose:** Right sidebar within task detail views showing and editing all task metadata: status, due date/time, priority, tags, project, reminder, recurrence, and delete action.
- **Key Exports:** `TaskMetadataSidebar`
- **Props:**
  - `task: Task`
  - `projects: Project[]`
  - `onUpdate, onComplete, onDelete` -- callbacks
- **Key Dependencies:** `DatePicker.tsx`, `RecurrencePicker.tsx`, `TagsInput.tsx`, `lucide-react`
- **Used By:** `TaskDetailPanel.tsx`, `TaskPage.tsx`
- **Notes:** Each metadata field is rendered as a clickable row that expands an inline editor. Reminder uses DatePicker with time enabled. Delete shows confirmation.

---

### OverdueSection.tsx

- **Path:** `src/ui/components/OverdueSection.tsx`
- **Purpose:** Shared overdue tasks section with expand/collapse, count badge, and per-task reschedule button. Extracted from duplicated code in Today.tsx and Upcoming.tsx.
- **Key Exports:** `OverdueSection`
- **Props:**
  - `tasks: Task[]` -- overdue tasks
  - `projects: Map<string, Project>` -- project lookup map
  - `onSelectTask: (id: string) => void`
  - `onToggleTask: (id: string) => void`
  - `onReschedule: (taskId: string) => void`
  - `selectedTaskId?: string | null`
- **Key Dependencies:** `lucide-react` (AlertTriangle, ChevronDown, ChevronRight, Calendar), `core/types.js`
- **Used By:** `Today.tsx`, `Upcoming.tsx`
- **Notes:** Collapsible section with red "Overdue" header and count badge. Each task has a calendar icon button to reschedule to today.

---

## Navigation Components

### Sidebar.tsx

- **Path:** `src/ui/components/Sidebar.tsx`
- **Purpose:** Main navigation sidebar with slot-based plugin view rendering. Groups views by slot (navigation, tools, workspace). Navigation views (Inbox, Today, etc.), collapsible projects section with mini progress bars, tools section (plugin views + AI Chat + Focus Mode), and workspace section (Plugin Store, Settings).
- **Key Exports:** `Sidebar`
- **Props:**
  - `currentView: string`
  - `onNavigate: (view, id?) => void`
  - `onOpenSettings?: () => void`
  - `projects: Project[]`
  - `selectedProjectId: string | null`
  - `panels?: PanelInfo[]`
  - `pluginViews?: ViewInfo[]`
  - `selectedPluginViewId?: string | null`
  - `onToggleChat?, chatOpen?` -- AI chat toggle
  - `onFocusMode?` -- focus mode trigger
  - `collapsed?: boolean, onToggleCollapsed?` -- sidebar collapse
  - `projectTaskCounts?: Map<string, number>`
  - `projectCompletedCounts?: Map<string, number>` -- for progress bars on project items
  - `onAddTask?, onSearch?` -- top action buttons
  - `inboxCount?, todayCount?` -- badge counts
  - `onOpenProjectModal?` -- add project button
  - `builtinPluginIds?: Set<string>` -- restricts navigation-slot views to built-in plugins
- **Key Dependencies:** `lucide-react`, `core/types.js`, `api/index.js` (PanelInfo, ViewInfo)
- **Used By:** `App.tsx`
- **Notes:** The core sidebar stays intentionally lean by default: built-in nav items cover Inbox, Today, and Upcoming. Filters and labels management now lives in Settings instead of the main sidebar. Advanced built-in experiences like Calendar, Stats, Someday, Completed, Cancelled, Matrix, and Quick Wins now appear only when their built-in plugin is enabled. Plugin views are grouped by slot via `useMemo`: `navigation` views render inline after built-in nav items (restricted to built-in plugins), `tools` views render in a collapsible "Tools" section between My Projects and Workspace, and `workspace` views render in the bottom Workspace section. Emoji plugin icons are handled alongside Lucide component icons. Collapsed mode shows only icons with hover tooltips (`CollapsedTooltip` internal component). Badge counts on Inbox and Today items. Project items show a mini progress bar (w-12 h-1) showing completed/total task ratio alongside the pending count, and project buttons now expose a right-click context menu for edit, favorite, subproject creation, and deletion actions. Old "Plugin Panels" and "Custom Views" sections were removed in favor of slot-based rendering.

---

### BottomNavBar.tsx

- **Path:** `src/ui/components/BottomNavBar.tsx`
- **Purpose:** Mobile-only bottom navigation bar with Inbox, Today, Search, and Settings buttons, plus a center AI orb button that supports long-press for voice mode.
- **Key Exports:** `BottomNavBar`
- **Props:**
  - `currentView: string`
  - `onNavigate: (view) => void`
  - `onToggleChat?: () => void`
  - `chatOpen?: boolean`
  - `onOpenSettings?: () => void`
  - `onSearch?: () => void`
  - `onStartVoiceCall?: () => void`
- **Key Dependencies:** `lucide-react`, `useIsMobile` (implicit -- rendered only on mobile by parent)
- **Used By:** `App.tsx`
- **Notes:** The center button uses a `setTimeout` for long-press detection (400ms). Short tap toggles AI chat; long press starts voice call. Pulsing animation on the AI orb when chat is open.

---

### MobileDrawer.tsx

- **Path:** `src/ui/components/MobileDrawer.tsx`
- **Purpose:** Slide-in drawer overlay for mobile sidebar navigation. Wraps the Sidebar component.
- **Key Exports:** `MobileDrawer`
- **Props:**
  - `open: boolean`
  - `onClose: () => void`
  - `children: ReactNode`
- **Key Dependencies:** None (pure layout component)
- **Used By:** `App.tsx`
- **Notes:** Slides in from the left with a backdrop overlay. Closes on backdrop click. Uses `useFocusTrap` hook to trap focus within the drawer while open.

---

### CommandPalette.tsx

- **Path:** `src/ui/components/CommandPalette.tsx`
- **Purpose:** Fuzzy search command palette (triggered by Ctrl+K). Filters commands by query, supports keyboard navigation (arrow keys, Enter, Escape).
- **Key Exports:** `CommandPalette`
- **Props:**
  - `commands: { id, label, icon?, action }[]`
  - `open: boolean`
  - `onClose: () => void`
- **Key Dependencies:** `lucide-react` (Search icon)
- **Used By:** `App.tsx`
- **Notes:** Case-insensitive fuzzy matching on command labels. Auto-focuses input on open. Closes on Escape or backdrop click. Each command can optionally have an icon string.

---

### SearchModal.tsx

- **Path:** `src/ui/components/SearchModal.tsx`
- **Purpose:** Global task search modal. Searches task titles, descriptions, and tag names. Shows results grouped with keyboard navigation.
- **Key Exports:** `SearchModal`
- **Props:**
  - `open: boolean`
  - `onClose: () => void`
  - `onNavigateToTask: (taskId) => void`
  - `tasks: Task[]`
  - `projects: Project[]`
- **Key Dependencies:** `lucide-react` (Search, X icons)
- **Used By:** `App.tsx`
- **Notes:** Debounced search (150ms). Highlights matching text in results. Keyboard navigation with arrow keys and Enter to select. Closes on Escape.

---

### Breadcrumb.tsx

- **Path:** `src/ui/components/Breadcrumb.tsx`
- **Purpose:** Breadcrumb navigation bar for project and task views. Shows Home icon + chevron-separated path segments.
- **Key Exports:** `Breadcrumb`
- **Props:**
  - `items: BreadcrumbItem[]` -- array of `{ label, onClick? }` segments
- **Key Dependencies:** `lucide-react` (Home, ChevronRight)
- **Used By:** `App.tsx` (rendered above view content for project and task views)
- **Notes:** Items with `onClick` are clickable links. Last item is rendered as plain text (current location). Home icon always links to inbox.

---

## AI Components

### AIChatPanel.tsx

- **Path:** `src/ui/components/AIChatPanel.tsx`
- **Purpose:** AI chat panel that operates in two modes: sidebar panel (default, 320px wide) and full view. Orchestrates SSE streaming, voice input (push-to-talk + VAD), voice call mode, session history, and delegates rendering of messages, input, and welcome state to extracted `chat/` sub-components.
- **Key Exports:** `AIChatPanel`
- **Props:**
  - `onClose: () => void`
  - `onOpenSettings: () => void`
  - `onSelectTask?: (taskId: string) => void`
  - `mode?: "panel" | "view"` -- display mode (default: "panel")
- **Key Dependencies:** `AIContext`, `VoiceContext`, `useVAD`, `useVoiceCall`, `VoiceCallOverlay.tsx`, `BrowserSTTProvider`, chat sub-components (`MessageBubble`, `TypingIndicator`, `ChatInput`, `WelcomeScreen`, `SuggestedActions`, `ChatHistory`) from `./chat/index.js`
- **Used By:** `App.tsx`
- **Notes:** After refactoring, this component focuses on state management and layout orchestration while delegating individual UI concerns to the `chat/` sub-components. Manages session history (create, switch, delete, rename), message restoration on mount, auto-scroll, TTS playback after AI responses, and browser STT recognition loop during voice calls. In view mode, renders a full-width layout with optional history sidebar. In panel mode, renders as a right-side panel on desktop and full-screen on mobile. Shows a "not configured" state with a Settings button when no AI provider is set up.

---

### Chat Components (`src/ui/components/chat/`)

Extracted sub-components used by `AIChatPanel.tsx`. Each handles a single concern of the chat UI. The barrel file `chat/index.ts` re-exports all components and the `ChatInputRef` type.

---

#### ChatHistory.tsx

- **Path:** `src/ui/components/chat/ChatHistory.tsx`
- **Purpose:** Session history sidebar/dropdown listing all chat sessions with relative timestamps, message counts, and inline rename/delete actions.
- **Key Exports:** `ChatHistory` (wrapped in `React.memo`)
- **Props:**
  - `sessions: ChatSessionInfo[]`
  - `activeSessionId: string | null`
  - `onNewChat: () => void`
  - `onSwitchSession: (sessionId: string) => void`
  - `onDeleteSession: (sessionId: string) => void`
  - `onRenameSession: (sessionId: string, title: string) => void`
  - `mode: "panel" | "view"` -- controls layout (sidebar with border in view mode, max-height dropdown in panel mode)
- **Key Dependencies:** `lucide-react` (Plus, Trash2, MessageSquare, Check, X, Pencil), `ChatSessionInfo` from `../../api/index.js`
- **Used By:** `AIChatPanel.tsx`
- **Notes:** Returns `null` when sessions list is empty. Each session entry shows title, relative time (e.g., "2h ago"), and message count. Inline rename uses input with Enter to confirm and Escape to cancel. Delete and rename buttons appear on hover via `group-hover` opacity. Includes internal `SessionEntry` component and `getRelativeTime` utility.

---

#### ChatInput.tsx

- **Path:** `src/ui/components/chat/ChatInput.tsx`
- **Purpose:** Chat message input form with send button, voice input button, and optional voice call button. Renders differently for panel and view modes.
- **Key Exports:** `ChatInput`, `ChatInputRef` (type)
- **Props:**
  - `onSubmit: (text: string) => void`
  - `isStreaming: boolean`
  - `mode: "panel" | "view"`
  - `voice: ReturnType<typeof useVoiceContext>`
  - `ttsAvailable: boolean`
  - `onVoiceResult: (text: string) => void`
  - `onStartCall?: () => void`
  - `showCallButton: boolean`
- **Key Dependencies:** `VoiceButton.tsx`, `lucide-react` (Send, Phone), `useVoiceContext` type from `../../context/VoiceContext.js`
- **Used By:** `AIChatPanel.tsx`
- **Notes:** Uses `forwardRef` with `useImperativeHandle` to expose a `focus()` method via `ChatInputRef`. View mode renders a larger, centered input with rounded-2xl styling. Panel mode renders a compact input with border. Auto-focuses after streaming ends. Submits on Enter, clears on success. Disabled while streaming.

---

#### ChatToolResultCard.tsx

- **Path:** `src/ui/components/chat/ChatToolResultCard.tsx`
- **Purpose:** Rich visualization cards for AI tool results. Renders structured data from tool calls (workload charts, completion patterns, task lists, energy recommendations, etc.) as styled UI elements instead of raw JSON.
- **Key Exports:** `ChatToolResultCard` (wrapped in `React.memo`)
- **Props:**
  - `toolResults: { toolName: string; data: string }[]`
  - `onSelectTask?: (taskId: string) => void`
- **Key Dependencies:** `lucide-react` (ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, Clock, Zap, Brain, Tag, FolderOpen)
- **Used By:** `MessageBubble.tsx`
- **Notes:** Dispatches to specialized visualization sub-components based on `toolName`:
  - `analyze_workload` -> `WorkloadChart` (horizontal bar chart with overloaded indicators)
  - `analyze_completion_patterns` -> `CompletionPatterns` (bar chart by day + top tags)
  - `get_energy_recommendations` -> `EnergyRecommendations` (quick wins + deep work pills)
  - `query_tasks` / `list_tasks` -> `TaskListCard` (expandable task list, click to navigate)
  - `break_down_task` -> `TaskBreakdown` (tree with subtask steps)
  - `check_overcommitment` -> `OvercommitmentStatus` (green/red status indicator)
  - `suggest_tags` -> `TagSuggestions` (colored tag pills)
  - `find_similar_tasks` / `check_duplicates` -> `SimilarTasks` (list with similarity %)
  - `list_projects` -> `ProjectList` (colored project pills)
  - `list_reminders` -> `ReminderList` (time + title list)
  - Returns `null` for unrecognized tools (falls back to badge display in `MessageBubble`). All cards use `animate-scale-fade-in` entrance animation.

---

#### MessageBubble.tsx

- **Path:** `src/ui/components/chat/MessageBubble.tsx`
- **Purpose:** Renders a single chat message (user, assistant, or error). Composes `ToolCallBadge`, `MarkdownMessage`, `ChatToolResultCard`, `ChatTaskCard`, and `MessageActions` for rich message display.
- **Key Exports:** `MessageBubble` (wrapped in `React.memo`)
- **Props:**
  - `message: AIChatMessage`
  - `onRetry?: () => void`
  - `onSelectTask?: (taskId: string) => void`
  - `isLatest?: boolean`
  - `isStreaming?: boolean`
  - `mode?: "panel" | "view"` -- affects avatar size (24/28px)
  - `messageIndex?: number`
  - `onEditAndResend?: (index: number, newText: string) => void`
  - `onRegenerate?: () => void`
- **Key Dependencies:** `ToolCallBadge.tsx`, `MarkdownMessage.tsx`, `ChatToolResultCard.tsx`, `ChatTaskCard.tsx`, `MessageActions.tsx`, `lucide-react` (AlertTriangle, RotateCcw, Bot), `AIChatMessage` from `../../api/index.js`
- **Used By:** `AIChatPanel.tsx`
- **Notes:** User messages render right-aligned with accent background. Assistant messages render left-aligned with Bot avatar and surface-tertiary background. Error messages show with red background, error category hint (auth, rate_limit, network, server, timeout), and retry button. Extracts inline task cards from `create_task`, `update_task`, `complete_task` tool calls via internal `extractTasksFromMessage` helper. Tool messages (`role === "tool"`) return null. Latest message gets `animate-message-enter` animation. Streaming indicator pulses the Bot avatar.

---

#### MarkdownMessage.tsx

- **Path:** `src/ui/components/chat/MarkdownMessage.tsx`
- **Purpose:** Renders AI response content as styled Markdown with custom components for code blocks, tables, blockquotes, collapsible details, and `junban://task/` deep links.
- **Key Exports:** `MarkdownMessage` (wrapped in `React.memo`)
- **Props:**
  - `content: string`
  - `onSelectTask?: (taskId: string) => void`
- **Key Dependencies:** `react-markdown`, `remark-gfm`, `lucide-react` (Check, Copy, ChevronDown, ChevronRight)
- **Used By:** `MessageBubble.tsx`
- **Notes:** Includes `CopyCodeButton` overlay on code blocks (appears on hover). `CollapsibleDetails` replaces native `<details>` with a styled toggle. Links starting with `junban://task/<id>` render as clickable buttons that call `onSelectTask`. External links open in new tab with `rel="noreferrer noopener"`. Custom URL transform preserves `junban://` scheme. Includes `extractTextFromChildren` recursive utility for extracting text from React children for the copy button.

---

#### MessageActions.tsx

- **Path:** `src/ui/components/chat/MessageActions.tsx`
- **Purpose:** Hover action toolbar for chat messages. Provides copy, edit-and-resend (user messages), and regenerate (last assistant message) actions.
- **Key Exports:** `MessageActions` (wrapped in `React.memo`)
- **Props:**
  - `message: AIChatMessage`
  - `isUser: boolean`
  - `isLastAssistant?: boolean`
  - `messageIndex?: number`
  - `onEditAndResend?: (index: number, newText: string) => void`
  - `onRegenerate?: () => void`
- **Key Dependencies:** `lucide-react` (Copy, Check, Pencil, RotateCcw, X, Send), `AIChatMessage` from `../../api/index.js`
- **Used By:** `MessageBubble.tsx`
- **Notes:** Renders as an absolutely-positioned toolbar that appears on hover via `group-hover:opacity-100`. Copy uses `navigator.clipboard` with 1.5s checkmark feedback. Edit mode replaces the toolbar with an inline input (Enter to submit, Escape to cancel). User messages show Copy + Edit; assistant messages show Copy + Regenerate (only on the last assistant message). Returns `null` if the message has no content.

---

#### SuggestedActions.tsx

- **Path:** `src/ui/components/chat/SuggestedActions.tsx`
- **Purpose:** Context-aware suggestion chips shown after assistant messages. Suggests follow-up actions based on which tools were invoked in the last response.
- **Key Exports:** `SuggestedActions` (wrapped in `React.memo`)
- **Props:**
  - `messages: AIChatMessage[]`
  - `onSend: (text: string) => void`
  - `isStreaming: boolean`
- **Key Dependencies:** `AIChatMessage` from `../../api/index.js`
- **Used By:** `AIChatPanel.tsx`
- **Notes:** Maps tool names to relevant follow-up suggestions (e.g., `create_task` -> "Break it down", "Set a reminder", "Show my tasks"). Falls back to default suggestions ("Plan my day", "What's overdue?", "Show my tasks") when no tool-specific match is found. Only renders after the last message is a non-error assistant message. Hidden while streaming or when messages list is empty. Chips have staggered `animate-fade-in` entrance animation (50ms delay per chip).

---

#### ToolCallBadge.tsx

- **Path:** `src/ui/components/chat/ToolCallBadge.tsx`
- **Purpose:** Compact pill badge displaying an AI tool call with an emoji icon and descriptive verb label. Parses tool arguments to show context (e.g., task title being created).
- **Key Exports:** `ToolCallBadge` (wrapped in `React.memo`), `TOOL_META`
- **Props:**
  - `name: string` -- tool name (e.g., "create_task")
  - `args: string` -- JSON string of tool arguments
- **Key Dependencies:** None (self-contained)
- **Used By:** `MessageBubble.tsx`
- **Notes:** `TOOL_META` maps 21 tool names to emoji + verb pairs (e.g., `create_task` -> "Creating", `analyze_workload` -> "Analyzing workload"). Falls back to the tool name with underscores replaced by spaces for unknown tools. Parses args JSON to extract contextual labels: shows task title if available, search query, or status filter.

---

#### TypingIndicator.tsx

- **Path:** `src/ui/components/chat/TypingIndicator.tsx`
- **Purpose:** Animated typing/thinking indicator shown while the AI is generating a response. Displays a pulsing Bot avatar with a shimmer bar.
- **Key Exports:** `TypingIndicator` (wrapped in `React.memo`)
- **Props:**
  - `mode?: "panel" | "view"` -- controls avatar size (24/28px)
- **Key Dependencies:** `lucide-react` (Bot)
- **Used By:** `AIChatPanel.tsx`
- **Notes:** Avatar uses `animate-pulse`. Content area shows a `typing-shimmer` CSS animation on a 20px-wide bar. Minimal component with no interactivity.

---

#### VoiceButton.tsx

- **Path:** `src/ui/components/chat/VoiceButton.tsx`
- **Purpose:** Push-to-talk voice input button with state-driven visual feedback. Handles both browser-native STT and external provider STT with audio recording.
- **Key Exports:** `VoiceButton`
- **Props:**
  - `onResult: (text: string) => void` -- callback with transcribed text
  - `disabled: boolean`
  - `voice: ReturnType<typeof useVoiceContext>`
- **Key Dependencies:** `lucide-react` (Mic, Loader2, Volume2), `BrowserSTTProvider` from `../../../ai/voice/adapters/browser-stt.js`, `createAudioRecorder` from `../../../ai/voice/audio-utils.js`, `useVoiceContext` type from `../../context/VoiceContext.js`
- **Used By:** `ChatInput.tsx`
- **Notes:** Returns `null` when voice mode is "off" or "vad". Four visual states: idle (muted border), listening (red pulse with glow shadow), transcribing (accent with spinner), speaking (green with pulse). Uses `BrowserSTTProvider.startLiveRecognition()` for browser STT, or `createAudioRecorder` + `voice.transcribeAudio()` for external providers. Toggle behavior -- click to start, click again to stop and transcribe.

---

#### WelcomeScreen.tsx

- **Path:** `src/ui/components/chat/WelcomeScreen.tsx`
- **Purpose:** Empty state / welcome screen shown when there are no chat messages. Displays a greeting, task summary stats, and quick-start suggestion buttons.
- **Key Exports:** `WelcomeScreen` (wrapped in `React.memo`)
- **Props:**
  - `mode: "panel" | "view"`
  - `onSend: (text: string) => void`
  - `isStreaming: boolean`
- **Key Dependencies:** `lucide-react` (Bot, AlertTriangle, CalendarDays, ListTodo), `useTaskContext` from `../../context/TaskContext.js`
- **Used By:** `AIChatPanel.tsx`
- **Notes:** Reads live task data via `useTaskContext` to compute overdue count, today count, and total pending count. View mode renders a large centered layout with Bot avatar (accent glow shadow), time-based greeting ("Good morning/afternoon/evening/night"), stat cards (overdue in red, today, pending), and a 2x2 grid of suggestion buttons with emojis. Panel mode renders a compact version with inline stat text and smaller suggestion pills. Includes internal `StatCard` sub-component and `getGreeting` utility.

---

### VoiceCallOverlay.tsx

- **Path:** `src/ui/components/VoiceCallOverlay.tsx`
- **Purpose:** In-call UI overlay shown within the AIChatPanel input area during a voice call. Displays a pulsing state indicator, call duration timer, optional grace period progress bar, and end call button.
- **Key Exports:** `VoiceCallOverlay`
- **Props:**
  - `callState: Exclude<CallState, "idle">` -- one of "greeting", "listening", "processing", "speaking"
  - `callDuration: number` -- seconds elapsed
  - `onEndCall: () => void`
  - `isInGracePeriod?: boolean` -- whether the VAD grace period is active
  - `gracePeriodProgress?: number` -- 0-1 progress of grace period
- **Key Dependencies:** `lucide-react` (PhoneOff), `CallState` type from `../hooks/useVoiceCall.js`
- **Used By:** `AIChatPanel.tsx`
- **Notes:** State-dependent colors: greeting=accent, listening=green, processing=accent, speaking=blue. When in grace period, label changes to "Waiting..." and a warning-colored progress bar is shown. Duration formatted as M:SS. Includes `data-testid` attributes for testing. Rendered inline in the input area (not a full-screen overlay).

---

### DailyPlanningModal.tsx

- **Path:** `src/ui/components/DailyPlanningModal.tsx`
- **Purpose:** AI-powered daily planning modal. Shows overdue tasks, today's tasks, and capacity info to help users plan their day.
- **Key Exports:** `DailyPlanningModal`
- **Props:**
  - `open: boolean`
  - `onComplete: () => void`
  - `tasks: Task[]`
  - `projects: Project[]`
- **Key Dependencies:** `lucide-react` (AlertTriangle, ListChecks, Clock, Rocket), `format-date.ts`, `SettingsContext`
- **Used By:** `App.tsx`

---

### DailyReviewModal.tsx

- **Path:** `src/ui/components/DailyReviewModal.tsx`
- **Purpose:** AI-powered daily review modal. Summarizes completed tasks, shows what's rolling over, and celebrates progress.
- **Key Exports:** `DailyReviewModal`
- **Props:**
  - `open: boolean`
  - `onComplete: () => void`
  - `tasks: Task[]`
  - `onUpdateTask: (id: string, updates: Record<string, unknown>) => void`
- **Key Dependencies:** `lucide-react` (Trophy, ArrowRight, CalendarCheck, PartyPopper), `format-date.ts`
- **Used By:** `App.tsx`

---

### ChatTaskCard.tsx

- **Path:** `src/ui/components/ChatTaskCard.tsx`
- **Purpose:** Compact task card rendered inline within AI chat messages when the AI creates, updates, or references a task. Shows task title, completion status, priority flag, due date, tags, and project.
- **Key Exports:** `ChatTaskCard`
- **Props:**
  - `task: { id: string; title: string; status?: string; priority?: number | null; dueDate?: string | null; tags?: { name: string; color?: string }[]; projectName?: string; projectColor?: string }`
  - `onClick?: (taskId: string) => void`
  - `onComplete?: (taskId: string) => void`
- **Key Dependencies:** `lucide-react` (CheckCircle2, Circle, Flag, Calendar)
- **Used By:** `MessageBubble.tsx`
- **Notes:** Clickable to navigate to task detail via `onClick`. Interactive completion checkbox via `onComplete` -- shows optimistic completion state. Priority flag uses color map: p1=error, p2=warning, p3=info, p4=muted. Displays tags as small colored dots with title tooltips. Shows project name with colored dot indicator. Uses `animate-scale-fade-in` entrance animation.

---

## Plugin Components

### StructuredContentRenderer.tsx

- **Path:** `src/ui/components/StructuredContentRenderer.tsx`
- **Purpose:** JSON-to-React renderer for plugin structured content. Accepts a JSON root structure and renders interactive UI elements.
- **Key Exports:** `StructuredContentRenderer`
- **Props:**
  - `content: string` -- JSON string with root structure `{ layout: "stack" | "center", elements: UIElement[] }`
  - `onCommand?: (commandId: string) => void` -- callback for button clicks
- **Key Dependencies:** None (self-contained with Tailwind classes)
- **Used By:** `PluginView.tsx`
- **Notes:** Supports 7 UI primitives:
  - `text` — styled text with variants: title, subtitle, body, caption, mono
  - `badge` — rounded pill with colors: default, accent, success, warning, error
  - `progress` — progress bar with `value`/`max`, optional label and color
  - `button` — clickable button with variants: primary, secondary, ghost. Fires `onCommand(commandId)`
  - `divider` — horizontal rule
  - `row` — flex container with nested elements, configurable gap and justify
  - `spacer` — vertical spacing (sm=8px, md=16px, lg=24px)
    Unknown element types are silently skipped for forward compatibility. Recursive rendering via internal `RenderElement` component.

---

### PluginBrowser.tsx

- **Path:** `src/ui/components/PluginBrowser.tsx`
- **Purpose:** Full-featured plugin browser modal for discovering, installing, uninstalling, enabling, and disabling community and built-in plugins. Master-detail layout with search, filtering, and plugin detail view.
- **Key Exports:** `PluginBrowser`
- **Props:**
  - `open: boolean`
  - `onClose: () => void`
- **Key Dependencies:** `lucide-react` (X, Search, Download, Trash2, Loader2, ExternalLink, Shield, ArrowLeft), `api` from `../api/index.js` (PluginInfo, StorePluginInfo, SettingDefinitionInfo), `usePluginContext`, `useFocusTrap`, `useIsMobile`, `PluginCard.tsx` (getGradient, formatDownloads, PluginSettings)
- **Used By:** `App.tsx`
- **Notes:** Opens as a centered modal (max 5xl, 90vh) on desktop with a two-panel layout: left panel (280px) has search input, filter tabs (All / Installed / Not Installed), and scrollable plugin list; right panel shows selected plugin detail. On mobile, renders full-screen with separate list and detail views (detail has back arrow navigation). Merges installed plugins with store plugins via internal `mergePlugins` function. Fetches store data from `api.getPluginStore()` on open. Supports install/uninstall/toggle operations with per-plugin loading states tracked via `Set<string>`. Error messages displayed in a red banner within the detail panel. Plugin detail shows gradient banner, metadata (version, author, downloads), repository link, action buttons, description, permissions (as monospace badges), tags, and settings (only when installed and enabled). Escape closes modal (or goes back on mobile). Auto-focuses search input on open. Includes internal `PluginListItem` and `PluginDetail` sub-components.

---

### PluginCard.tsx

- **Path:** `src/ui/components/PluginCard.tsx`
- **Purpose:** Reusable plugin card component with two operating modes: "store" mode (for the plugin browser grid view) and "settings" mode (for the settings panel). Includes shared utilities for gradient generation, download count formatting, and per-plugin settings UI.
- **Key Exports:** `PluginCard`, `PluginSettings`, `GradientBanner`, `getGradient`, `formatDownloads`, `hashString`, `GRADIENT_PALETTE` (type: `PluginCardProps = StoreCardProps | SettingsCardProps`)
- **Props (StoreCardProps -- mode "store"):**
  - `plugin: StorePluginInfo`
  - `expanded: boolean`
  - `onToggleExpand: () => void`
  - `installed: boolean`
  - `installing: boolean`
  - `uninstalling: boolean`
  - `onInstall: () => void`
  - `onUninstall: () => void`
  - `isBuiltin?: boolean`
  - `activating?: boolean`
  - `onActivate?: () => void`
- **Props (SettingsCardProps -- mode "settings"):**
  - `plugin: PluginInfo`
  - `expanded: boolean`
  - `onToggleExpand: () => void`
  - `toggling?: boolean`
  - `onToggle?: () => void`
  - `onRequestApproval?: () => void`
  - `onRevoke?: () => void`
- **Key Dependencies:** `lucide-react` (Download, Trash2, Loader2, ChevronDown, ChevronUp, ExternalLink, Shield), `api` from `../api/index.js` (PluginInfo, StorePluginInfo, SettingDefinitionInfo)
- **Used By:** `PluginBrowser.tsx` (utilities), `PluginsTab.tsx` (settings view)
- **Notes:** `GradientBanner` renders a colored gradient header using a 12-color palette deterministically derived from the plugin ID via `hashString`. `PluginSettings` fetches and manages per-plugin settings via `api.getPluginSettings()` / `api.updatePluginSetting()`, rendering text, number, boolean (toggle switch), and select inputs via internal `SettingField` component. Store mode cards show install/uninstall/activate buttons, tags, download count, and version. Settings mode cards show enable/disable toggle (for built-in), permission approval/revoke buttons (for community), and inline settings. Both modes have expandable detail sections with permissions display and repository links.

---

## Forms & Modals

### DatePicker.tsx

- **Path:** `src/ui/components/DatePicker.tsx`
- **Purpose:** Calendar date picker with quick-select options (Today, Tomorrow, Next week, No date), optional time input, and optional "Set reminder" shortcut button.
- **Key Exports:** `DatePicker`
- **Props:**
  - `selectedDate?: string` -- ISO date string
  - `selectedTime?: string` -- HH:MM
  - `reminderAt?: string` -- ISO datetime
  - `onSelect: (date, time?) => void`
  - `onClose: () => void`
  - `showTime?: boolean`
  - `onSetReminder?: (iso) => void`
- **Key Dependencies:** None (fully custom calendar rendering)
- **Used By:** `TaskItem.tsx`, `TaskMetadataSidebar.tsx`
- **Notes:** Calendar renders full month grid. Navigation with left/right month arrows. Today highlighted. Week start respects general settings. Positioned absolutely relative to trigger element.

---

### RecurrencePicker.tsx

- **Path:** `src/ui/components/RecurrencePicker.tsx`
- **Purpose:** Recurrence rule picker with preset options (daily, weekly, monthly, weekdays) and a custom "every N days/weeks" editor.
- **Key Exports:** `RecurrencePicker`
- **Props:**
  - `value?: string` -- current recurrence rule string
  - `onChange: (rule: string | undefined) => void`
  - `onClose: () => void`
- **Key Dependencies:** `lucide-react` (Repeat, X icons)
- **Used By:** `TaskMetadataSidebar.tsx`
- **Notes:** Returns rule strings like `"daily"`, `"weekly"`, `"every 3 days"`, `"weekdays"`. "None" option clears recurrence.

---

### TagsInput.tsx

- **Path:** `src/ui/components/TagsInput.tsx`
- **Purpose:** Tag input field with autocomplete suggestions dropdown and colored tag chips.
- **Key Exports:** `TagsInput`
- **Props:**
  - `tags: { id, name, color }[]` -- currently attached tags
  - `allTags: { id, name, color }[]` -- available tags for autocomplete
  - `onChange: (tags) => void`
  - `onClose: () => void`
- **Key Dependencies:** `lucide-react` (X, Tag icons), `hexToRgba` utility
- **Used By:** `TaskMetadataSidebar.tsx`, `BulkActionBar.tsx`
- **Notes:** Creates new tags on Enter if no match found. Autocomplete filters existing tags. Tags shown as colored chips with remove button.

---

### TemplateSelector.tsx

- **Path:** `src/ui/components/TemplateSelector.tsx`
- **Purpose:** Template browser and variable form modal. Lists available templates, and when selected shows a form for any `{{variable}}` placeholders before instantiation.
- **Key Exports:** `TemplateSelector`
- **Props:**
  - `open: boolean`
  - `onClose: () => void`
  - `onSelectTemplate: (templateId, variables?) => void`
  - `templates: TaskTemplate[]`
- **Key Dependencies:** `lucide-react` (FileText, X icons), `core/types.js`
- **Used By:** `App.tsx`
- **Notes:** Extracts variable names from title/description using `{{varName}}` regex. Shows variable input form before confirming. Empty variable list skips the form step.

---

### AddProjectModal.tsx

- **Path:** `src/ui/components/AddProjectModal.tsx`
- **Purpose:** Modal dialog for creating a new project with name, emoji icon, and color picker.
- **Key Exports:** `AddProjectModal`
- **Props:**
  - `open: boolean`
  - `onClose: () => void`
  - `onSubmit: (name, color, icon) => void`
- **Key Dependencies:** `lucide-react` (X, Check icons), `DEFAULT_PROJECT_COLORS` from `config/defaults.js`
- **Used By:** `App.tsx`
- **Notes:** Name has 120 character limit with counter. Emoji input limited to 2 characters. 8 preset colors with check mark on selected. Blue selected by default. Auto-focuses name input on open. Closes on Escape or backdrop click.

---

### PermissionDialog.tsx

- **Path:** `src/ui/components/PermissionDialog.tsx`
- **Purpose:** Plugin permission approval dialog. Shows the list of permissions a plugin requests and lets the user approve or deny.
- **Key Exports:** `PermissionDialog`
- **Props:**
  - `pluginName: string`
  - `permissions: string[]`
  - `onApprove: (permissions: string[]) => void`
  - `onCancel: () => void`
- **Key Dependencies:** `lucide-react` (Shield, X icons)
- **Used By:** `PluginsTab.tsx` (settings)
- **Notes:** Permissions shown as monospace badges. Approve sends the full permission list; there is no partial approval.

---

### ConfirmDialog.tsx

- **Path:** `src/ui/components/ConfirmDialog.tsx`
- **Purpose:** Reusable styled confirmation dialog with "danger" and "default" variants.
- **Key Exports:** `ConfirmDialog`
- **Props:**
  - `open: boolean`
  - `title: string`
  - `message: string`
  - `confirmLabel?: string`
  - `cancelLabel?: string`
  - `variant?: "danger" | "default"`
  - `onConfirm: () => void`
  - `onCancel: () => void`
- **Key Dependencies:** `lucide-react` (AlertTriangle icon for danger variant)
- **Used By:** `App.tsx` (task deletion confirmation when `confirm_delete` setting is enabled)
- **Notes:** Danger variant shows red confirm button and warning icon. Entrance animation with zoom-in effect. Closes on Escape.

---

### QuickAddModal.tsx

- **Path:** `src/ui/components/QuickAddModal.tsx`
- **Purpose:** Quick-add task modal triggered by keyboard shortcut (Ctrl+N or `q`). Centered overlay with TaskInput.
- **Key Exports:** `QuickAddModal`
- **Props:**
  - `open: boolean`
  - `onClose: () => void`
  - `onCreateTask: (input: CreateTaskInput) => void`
- **Key Dependencies:** `TaskInput.tsx`
- **Used By:** `App.tsx`
- **Notes:** Auto-focuses input on open. Closes on Escape or backdrop click. Uses `animate-scale-fade-in` entrance animation. Submits task and closes on completion.

---

### ContextMenu.tsx

- **Path:** `src/ui/components/ContextMenu.tsx`
- **Purpose:** Generic right-click context menu with submenu support and full keyboard navigation.
- **Key Exports:** `ContextMenu`, `ContextMenuItem` (interface)
- **Props:**
  - `items: ContextMenuItem[]` -- menu items with label, icon?, onClick?, children? (for submenus)
  - `position: { x: number; y: number }` -- screen coordinates
  - `onClose: () => void`
- **Key Dependencies:** `lucide-react` (ChevronRight)
- **Used By:** `App.tsx` (renders the menu with task-specific items), `TaskItem.tsx` (fires onContextMenu on right-click)
- **Notes:** Keyboard navigation: ArrowDown/Up to move, Enter to select, Escape to close, ArrowRight to open submenu. Supports nested submenus. Closes on outside click, Escape, or scroll. Viewport-aware positioning. App.tsx builds menu items: Edit, Complete/Uncomplete, Priority submenu (P1-P4), Move to project submenu (Inbox + all projects), Delete. Context menu clears on view navigation.

---

### OnboardingModal.tsx

- **Path:** `src/ui/components/OnboardingModal.tsx`
- **Purpose:** First-run onboarding wizard that guides theme setup, starter preset selection, optional AI setup, and final handoff into the app.
- **Key Exports:** `OnboardingModal`
- **Props:**
  - `open: boolean`
  - `onComplete: () => void`
  - `onRequestOpenSettings?: (tab: string) => void`
- **Key Dependencies:** `themeManager`, `useGeneralSettings`, plugin-permission approval helpers, and the onboarding step components under `src/ui/components/onboarding/`
- **Used By:** `App.tsx` (checks `onboarding_completed` setting on mount)
- **Notes:** Five-step flow: welcome, theme, preset, AI opt-in, and ready state. Persists the selected preset/theme, can pre-approve built-in plugin permissions for a preset, and can optionally deep-link the user into AI settings after completion.

Onboarding helper files:

| File                                           | Responsibility                           |
| ---------------------------------------------- | ---------------------------------------- |
| `src/ui/components/onboarding/StepWelcome.tsx` | First-run welcome copy and orientation   |
| `src/ui/components/onboarding/StepTheme.tsx`   | Theme and accent selection               |
| `src/ui/components/onboarding/StepPreset.tsx`  | Starter preset selection                 |
| `src/ui/components/onboarding/StepAI.tsx`      | AI opt-in step and branching             |
| `src/ui/components/onboarding/StepReady.tsx`   | Final confirmation / launch step         |
| `src/ui/components/onboarding/constants.ts`    | Preset metadata and total-step constants |
| `src/ui/components/onboarding/types.ts`        | Onboarding modal and step types          |

---

## UI Chrome

### BulkActionBar.tsx

- **Path:** `src/ui/components/BulkActionBar.tsx`
- **Purpose:** Sticky action bar shown when multiple tasks are selected. Provides Complete, Delete, Move (to project), and Tag bulk operations.
- **Key Exports:** `BulkActionBar`
- **Props:**
  - `selectedCount: number`
  - `onComplete: () => void`
  - `onDelete: () => void`
  - `onMove: (projectId) => void`
  - `onTag: (tagNames) => void`
  - `onClear: () => void`
  - `projects: Project[]`
  - `allTags: { id, name, color }[]`
- **Key Dependencies:** `lucide-react`, dropdown menus for project/tag selection
- **Used By:** `App.tsx`
- **Notes:** Fixed position at bottom of viewport. Shows selected count with "Clear selection" button. Move and Tag open dropdown pickers.

---

### FAB.tsx

- **Path:** `src/ui/components/FAB.tsx`
- **Purpose:** Mobile floating action button for adding tasks.
- **Key Exports:** `FAB`
- **Props:**
  - `onClick: () => void`
- **Key Dependencies:** `lucide-react` (Plus icon)
- **Used By:** `App.tsx` (mobile layout only)
- **Notes:** Fixed position, bottom-right, above the BottomNavBar. Uses accent background color.

---

### FocusMode.tsx

- **Path:** `src/ui/components/FocusMode.tsx`
- **Purpose:** Full-screen single-task focus mode. Shows one task at a time with large display, keyboard shortcuts for completion and navigation.
- **Key Exports:** `FocusMode`
- **Props:**
  - `tasks: Task[]`
  - `onComplete: (id) => void`
  - `onClose: () => void`
  - `onSkip?: () => void`
- **Key Dependencies:** `lucide-react`, `core/types.js`
- **Used By:** `App.tsx`
- **Notes:** Keyboard shortcuts: Space to complete, N for next, P for previous, Escape to exit. Shows progress bar (X of Y tasks). Dark backdrop. Displays task priority, due date, description, and tags.

---

### QueryBar.tsx

- **Path:** `src/ui/components/QueryBar.tsx`
- **Purpose:** Search and filter bar with debounced query parsing and suggestions dropdown.
- **Key Exports:** `QueryBar`
- **Props:**
  - `value: string`
  - `onChange: (query) => void`
  - `placeholder?: string`
  - `suggestions?: string[]`
- **Key Dependencies:** `lucide-react` (Search, X icons)
- **Used By:** `FiltersLabels.tsx`
- **Notes:** 200ms debounced onChange. Suggestions dropdown appears below. Supports filter syntax like `priority:p1`, `tag:work`, `project:inbox`.

---

### StatusBar.tsx

- **Path:** `src/ui/components/StatusBar.tsx`
- **Purpose:** Bottom status bar displaying plugin-registered status bar items.
- **Key Exports:** `StatusBar`
- **Props:**
  - `items: StatusBarItemInfo[]`
- **Key Dependencies:** `api/index.js` (StatusBarItemInfo type)
- **Used By:** `App.tsx`
- **Notes:** Each item shows icon + text. Only visible when plugins register status bar items.

---

### PluginPanel.tsx

- **Path:** `src/ui/components/PluginPanel.tsx`
- **Purpose:** Container for rendering plugin sidebar panel content.
- **Key Exports:** `PluginPanel`
- **Props:**
  - `panel: PanelInfo`
- **Key Dependencies:** `api/index.js` (PanelInfo type)
- **Used By:** `Sidebar.tsx`
- **Notes:** Renders panel icon, title, and content as text. Minimal wrapper component.

---

### Toast.tsx

- **Path:** `src/ui/components/Toast.tsx`
- **Purpose:** Auto-dismissing toast notification with optional action button (used for undo).
- **Key Exports:** `Toast`
- **Props:**
  - `message: string`
  - `action?: { label: string; onClick: () => void }`
  - `onDismiss: () => void`
  - `duration?: number` -- milliseconds (default 4000)
- **Key Dependencies:** None
- **Used By:** `App.tsx` (via UndoContext)
- **Notes:** Auto-dismisses after duration. Entrance animation with slide-up. Action button shown inline (e.g., "Undo" after task completion).

---

### ErrorBoundary.tsx

- **Path:** `src/ui/components/ErrorBoundary.tsx`
- **Purpose:** React class component error boundary. Catches render errors and displays a fallback UI with reset button.
- **Key Exports:** `ErrorBoundary`
- **Props:**
  - `children: ReactNode`
  - `fallback?: ReactNode` -- optional custom fallback
- **Key Dependencies:** None
- **Used By:** `App.tsx` (wraps the entire app)
- **Notes:** Shows error message and stack trace in development. "Try Again" button resets the error state. Class component (required by React error boundary API).

---

### EmptyState.tsx

- **Path:** `src/ui/components/EmptyState.tsx`
- **Purpose:** Reusable empty state component with centered layout, icon, title, optional description, and optional action button.
- **Key Exports:** `EmptyState`
- **Props:**
  - `icon: ReactNode` -- icon element (typically from lucide-react)
  - `title: string`
  - `description?: string`
  - `action?: { label: string; onClick: () => void }`
- **Key Dependencies:** None
- **Used By:** `Completed.tsx`, `FiltersLabels.tsx`, `TaskList.tsx`
- **Notes:** Standardized empty state layout: icon (40px, opacity-50), title, description, optional CTA button with accent styling.

---

### Skeleton.tsx

- **Path:** `src/ui/components/Skeleton.tsx`
- **Purpose:** Skeleton loading placeholder components for initial app load state and lazy view transitions.
- **Key Exports:** `SkeletonLine`, `SkeletonTaskItem`, `SkeletonTaskList`, `ViewSkeleton`
- **Props:**
  - `SkeletonLine`: `width?: string` -- CSS width (default "100%")
  - `SkeletonTaskItem`: none
  - `SkeletonTaskList`: `count?: number` -- number of skeleton rows (default 5)
  - `ViewSkeleton`: `view: View` -- adapts the shell to the current route
- **Key Dependencies:** `useRouting.ts` types
- **Used By:** `AppLayout.tsx`, `ViewRenderer.tsx`
- **Notes:** Uses `animate-pulse` with `bg-surface-tertiary`. Has `aria-busy="true"` and `role="status"` for accessibility. `ViewSkeleton` renders a header, input bar, task list shell, and optional side cards keyed to the active view so route changes never fall back to plain text while lazy chunks load.

---

### CompletionRing.tsx

- **Path:** `src/ui/components/CompletionRing.tsx`
- **Purpose:** SVG circle progress indicator showing task completion ratio.
- **Key Exports:** `CompletionRing`
- **Props:**
  - `completed: number` -- number of completed tasks
  - `total: number` -- total number of tasks
  - `size?: number` -- diameter in pixels (default 32)
- **Key Dependencies:** None
- **Used By:** `Today.tsx` (header), `Project.tsx` (project header)
- **Notes:** Uses SVG `stroke-dasharray` / `stroke-dashoffset` for the progress arc. Shows `completed/total` text. Includes `aria-label` for accessibility. Track color: `surface-tertiary`, progress color: `accent`.

---

### ChordIndicator.tsx

- **Path:** `src/ui/components/ChordIndicator.tsx`
- **Purpose:** Small floating pill at the bottom of the screen that displays the pending chord key while the user is mid-chord (e.g., pressed "g", waiting for the second key).
- **Key Exports:** `ChordIndicator`
- **Props:** None
- **Key Dependencies:** `useSyncExternalStore` (React), `shortcutManager` singleton from `shortcutManagerInstance.js`
- **Used By:** `App.tsx`
- **Notes:** Uses `useSyncExternalStore` to subscribe to `shortcutManager.onChordChange()` and read `shortcutManager.getPendingChord()`. Returns `null` when no chord is pending. Renders a fixed-position pill (`bottom-20`, horizontally centered, `z-50`) with a styled `<kbd>` element showing the pending key in uppercase and a "then ..." hint. Uses `animate-fade-in` entrance animation.

---

## Gamification & Motivation Components

### DreadLevelSelector.tsx

- **Path:** `src/ui/components/DreadLevelSelector.tsx`
- **Purpose:** 5-level dread rating selector using frog icons. Allows users to rate how much they dread a task on a scale of 1 (low) to 5 (maximum dread).
- **Key Exports:** `DreadLevelSelector`, `FrogIcon`, `getDreadLevelColor`
- **Props:**
  - `value: number | null` -- current dread level (1-5 or null)
  - `onChange: (level: number | null) => void` -- callback when level changes
  - `size?: number` -- icon size in pixels (default 16)
- **Key Dependencies:** None (pure SVG)
- **Used By:** `TaskDetailPanel.tsx`, `TaskMetadataSidebar.tsx`
- **Notes:** Color scale from green (1) through yellow, orange, red to dark red (5). Each level has a label (e.g., "Low dread", "Maximum dread"). Clicking the active level deselects it (sets null). `FrogIcon` and `getDreadLevelColor` are exported for reuse by `EatTheFrog.tsx`.

---

### EatTheFrog.tsx

- **Path:** `src/ui/components/EatTheFrog.tsx`
- **Purpose:** Displays the highest-dread pending task as a prominent card in the Today view, encouraging users to tackle their most dreaded task first.
- **Key Exports:** `EatTheFrog`, `selectFrogTask`
- **Props:**
  - `tasks: Task[]` -- all tasks to search for the frog
  - `onToggleTask: (id: string) => void` -- complete the frog task
  - `onSelectTask: (id: string) => void` -- navigate to task detail
- **Key Dependencies:** `FrogIcon`, `getDreadLevelColor` from `DreadLevelSelector.tsx`, `lucide-react` (Check)
- **Used By:** `Today.tsx`
- **Notes:** `selectFrogTask` picks the highest-dread pending task, breaking ties by earliest due date then alphabetical title. Card shows frog icon, dread level color, task title, and a complete button. Includes a celebratory animation on completion. Hidden when no tasks have dread levels assigned.

---

### TaskJar.tsx

- **Path:** `src/ui/components/TaskJar.tsx`
- **Purpose:** Random task picker with a slot-machine-style animation. Helps users overcome decision paralysis by randomly selecting a task from today's pool.
- **Key Exports:** `TaskJar`, `buildJarPool`, `pickRandom`
- **Props:**
  - `tasks: Task[]` -- all tasks (filtered internally to pending + due today/overdue)
  - `onSelectTask: (id: string) => void` -- navigate to the selected task
- **Key Dependencies:** `lucide-react` (Dices, X), `toDateKey` from `utils/format-date.js`
- **Used By:** `Today.tsx`
- **Notes:** `buildJarPool` filters to pending tasks due today or overdue. `pickRandom` selects a random task excluding the current one. Slot-machine CSS animation cycles through task titles before landing on the chosen one. Dismiss button (X) closes the jar. Button disabled when pool is empty.

---

### WeeklyReviewModal.tsx

- **Path:** `src/ui/components/WeeklyReviewModal.tsx`
- **Purpose:** Weekly productivity review modal with charts and analytics. Displays completion rate, task flow, daily stats, busiest day, productive time, neglected projects, overdue tasks, streaks, accomplishments, and suggestions.
- **Key Exports:** `WeeklyReviewModal`, `WeeklyReviewData`
- **Props:**
  - `open: boolean`
  - `onClose: () => void`
  - `data: WeeklyReviewData` -- pre-computed review data (from `weekly_review` AI tool)
- **Key Dependencies:** `lucide-react` (X, CheckCircle2, PlusCircle, AlertTriangle, Flame, Trophy, FolderX, Lightbulb), `useFocusTrap` hook
- **Used By:** `AIChatPanel.tsx` (opened when AI generates a weekly review)
- **Notes:** Renders as a portal modal with focus trap. Sections include: completion rate percentage, task flow (created/completed/cancelled/net), daily stats bar chart, busiest day highlight, productive time of day, neglected projects list, overdue tasks, current/best streaks, top accomplishments, and actionable suggestions. Uses `WeeklyReviewData` interface for typed data input.

---

### ExtractTasksModal.tsx

- **Path:** `src/ui/components/ExtractTasksModal.tsx`
- **Purpose:** Paste unstructured text (meeting notes, emails), and the AI extracts actionable tasks for review and batch creation.
- **Key Exports:** `ExtractTasksModal`
- **Props:**
  - `open: boolean`
  - `onClose: () => void`
  - `projects: Project[]` -- for project assignment dropdown
  - `onCreateTasks: (tasks, projectId) => Promise<void>` -- batch create callback
- **Key Dependencies:** `lucide-react` (FileText, Loader2, Check, AlertCircle), `useFocusTrap` hook
- **Used By:** `AIChatPanel.tsx`, command palette
- **Notes:** Three-step flow: (1) paste text, (2) AI extracts tasks with priority/due date/description, (3) user reviews, selects/deselects individual tasks, assigns a project, and confirms creation. Each extracted task shows priority badge (P1-P4 with color), due date, and description. Supports select-all/deselect-all toggle.

---

## Animation Components

### AnimatedPresence.tsx

- **Path:** `src/ui/components/AnimatedPresence.tsx`
- **Purpose:** Drop-in replacement for Framer Motion's `AnimatePresence` that respects reduced motion preferences (OS-level and app setting).
- **Key Exports:** `AnimatedPresence`, `useReducedMotion` (re-exported)
- **Props:** Same as `AnimatePresenceProps` from `framer-motion`
- **Key Dependencies:** `framer-motion` (AnimatePresence), `useReducedMotion` from `./useReducedMotion.js`
- **Used By:** Task list transitions, sidebar animations, modal enter/exit
- **Notes:** When reduced motion is preferred, Framer Motion internally skips animations but `AnimatePresence` still tracks presence for conditional rendering. The `useReducedMotion` hook checks both the OS `prefers-reduced-motion` media query and the app's `reduce_animations` setting.

---

### CompletionBurst.tsx

- **Path:** `src/ui/components/CompletionBurst.tsx`
- **Purpose:** CSS keyframe particle burst effect triggered on task completion. Renders 8 small colored dots that burst outward from the center.
- **Key Exports:** `CompletionBurst`
- **Props:**
  - `active: boolean` -- whether the burst animation should play
- **Key Dependencies:** `useReducedMotion` from `./useReducedMotion.js`
- **Used By:** `TaskItem.tsx` (on completion toggle)
- **Notes:** Returns `null` when `active` is false or reduced motion is preferred. Uses CSS custom properties `--burst-angle` and `--burst-color` for each particle. Colors cycle through success (green), accent (indigo), and warning (amber) using CSS variables. Animation defined in `index.css` via `completion-burst-particle` class.
