# Frontend Components Reference

> Every file in `src/ui/components/`, grouped by category.

---

## Task Components

### TaskInput.tsx

- **Path:** `src/ui/components/TaskInput.tsx` (106 lines)
- **Purpose:** Natural language task input field. Parses free-text into structured task data in real time using the NLP parser.
- **Key Exports:** `TaskInput`
- **Props:**
  - `onAddTask: (input: CreateTaskInput) => void` -- callback fired with parsed task data on submit
  - `defaultProjectId?: string` -- pre-selects a project for the created task
- **Key Dependencies:** `parseTask` from `../../parser/task-parser.js`, `CreateTaskInput` from `../../core/types.js`
- **Used By:** `Inbox.tsx`, `Today.tsx`, `Upcoming.tsx`, `Project.tsx`
- **Notes:** Shows a live preview line below the input displaying parsed due date, priority, and tags. Submits on Enter, clears input on success. Preview tokens are styled as colored pill badges with icons (Flag for priority, Hash for tags, Calendar for date, FolderOpen for project, Repeat for recurrence).

---

### TaskItem.tsx

- **Path:** `src/ui/components/TaskItem.tsx` (291 lines)
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

- **Path:** `src/ui/components/TaskList.tsx` (283 lines)
- **Purpose:** Renders a sortable list of tasks with drag-and-drop reordering, hierarchical tree flattening, and inline subtask creation.
- **Key Exports:** `TaskList`
- **Props:**
  - `tasks: Task[]`
  - `onComplete, onDelete, onSelect, onNavigateToTask` -- task action callbacks
  - `onReorder?: (orderedIds: string[]) => void`
  - `selectedTaskId?: string | null`
  - `highlightedTaskIds?: Set<string>`
  - `multiSelectedIds?: Set<string>`
  - `onMultiSelect?: (id, event) => void`
  - `projects?: Project[]`
  - `onAddSubtask?: (parentId: string, title: string) => void`
  - `onIndent?: (id: string) => void`
  - `onOutdent?: (id: string) => void`
  - `onContextMenu?: (taskId: string, position: { x: number; y: number }) => void` -- right-click context menu handler, passed through to TaskItem
- **Key Dependencies:** `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `TaskItem.tsx`, `InlineAddSubtask.tsx`
- **Used By:** `Inbox.tsx`, `Today.tsx`, `Upcoming.tsx`, `Project.tsx`, `Completed.tsx`
- **Notes:** Builds a flat tree from `parentId` relationships. Uses `DndContext` + `SortableContext` with `verticalListSortingStrategy`. Supports keyboard-based indent/outdent (Tab/Shift+Tab) on focused items. Includes a `DragOverlay` for styled drag ghost (semi-transparent, shadow, slight rotation) during drag-and-drop.

---

### TaskDetailPanel.tsx

- **Path:** `src/ui/components/TaskDetailPanel.tsx` (672 lines)
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

- **Path:** `src/ui/components/SubtaskBlock.tsx` (141 lines)
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

- **Path:** `src/ui/components/SubtaskSection.tsx` (267 lines)
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

- **Path:** `src/ui/components/InlineAddSubtask.tsx` (64 lines)
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

- **Path:** `src/ui/components/TaskMetadataSidebar.tsx` (331 lines)
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

- **Path:** `src/ui/components/OverdueSection.tsx` (98 lines)
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

- **Path:** `src/ui/components/Sidebar.tsx` (596 lines)
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
- **Notes:** Plugin views are grouped by slot via `useMemo`: `navigation` views render inline after built-in nav items (restricted to builtin plugins), `tools` views render in a collapsible "Tools" section between My Projects and Workspace, `workspace` views render in the bottom Workspace section. Emoji plugin icons handled alongside Lucide component icons. Collapsed mode shows only icons with hover tooltips (`CollapsedTooltip` internal component). Badge counts on Inbox and Today items. Project items show a mini progress bar (w-12 h-1) showing completed/total task ratio alongside the pending count. Old "Plugin Panels" and "Custom Views" sections removed in favor of slot-based rendering.

---

### BottomNavBar.tsx

- **Path:** `src/ui/components/BottomNavBar.tsx` (132 lines)
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

- **Path:** `src/ui/components/MobileDrawer.tsx` (62 lines)
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

- **Path:** `src/ui/components/CommandPalette.tsx` (150 lines)
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

- **Path:** `src/ui/components/SearchModal.tsx` (248 lines)
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

- **Path:** `src/ui/components/Breadcrumb.tsx` (35 lines)
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

- **Path:** `src/ui/components/AIChatPanel.tsx` (456 lines)
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

Extracted sub-components used by `AIChatPanel.tsx`. Each handles a single concern of the chat UI. The barrel file `chat/index.ts` (13 lines) re-exports all components and the `ChatInputRef` type.

---

#### ChatHistory.tsx

- **Path:** `src/ui/components/chat/ChatHistory.tsx` (166 lines)
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

- **Path:** `src/ui/components/chat/ChatInput.tsx` (117 lines)
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

- **Path:** `src/ui/components/chat/ChatToolResultCard.tsx` (451 lines)
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

- **Path:** `src/ui/components/chat/MessageBubble.tsx` (231 lines)
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

- **Path:** `src/ui/components/chat/MarkdownMessage.tsx` (186 lines)
- **Purpose:** Renders AI response content as styled Markdown with custom components for code blocks, tables, blockquotes, collapsible details, and `saydo://task/` deep links.
- **Key Exports:** `MarkdownMessage` (wrapped in `React.memo`)
- **Props:**
  - `content: string`
  - `onSelectTask?: (taskId: string) => void`
- **Key Dependencies:** `react-markdown`, `remark-gfm`, `lucide-react` (Check, Copy, ChevronDown, ChevronRight)
- **Used By:** `MessageBubble.tsx`
- **Notes:** Includes `CopyCodeButton` overlay on code blocks (appears on hover). `CollapsibleDetails` replaces native `<details>` with a styled toggle. Links starting with `saydo://task/<id>` render as clickable buttons that call `onSelectTask`. External links open in new tab with `rel="noreferrer noopener"`. Custom URL transform preserves `saydo://` scheme. Includes `extractTextFromChildren` recursive utility for extracting text from React children for the copy button.

---

#### MessageActions.tsx

- **Path:** `src/ui/components/chat/MessageActions.tsx` (119 lines)
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

- **Path:** `src/ui/components/chat/SuggestedActions.tsx` (65 lines)
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

- **Path:** `src/ui/components/chat/ToolCallBadge.tsx` (58 lines)
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

- **Path:** `src/ui/components/chat/TypingIndicator.tsx` (27 lines)
- **Purpose:** Animated typing/thinking indicator shown while the AI is generating a response. Displays a pulsing Bot avatar with a shimmer bar.
- **Key Exports:** `TypingIndicator` (wrapped in `React.memo`)
- **Props:**
  - `mode?: "panel" | "view"` -- controls avatar size (24/28px)
- **Key Dependencies:** `lucide-react` (Bot)
- **Used By:** `AIChatPanel.tsx`
- **Notes:** Avatar uses `animate-pulse`. Content area shows a `typing-shimmer` CSS animation on a 20px-wide bar. Minimal component with no interactivity.

---

#### VoiceButton.tsx

- **Path:** `src/ui/components/chat/VoiceButton.tsx` (103 lines)
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

- **Path:** `src/ui/components/chat/WelcomeScreen.tsx` (141 lines)
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

- **Path:** `src/ui/components/VoiceCallOverlay.tsx` (90 lines)
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

- **Path:** `src/ui/components/ChatTaskCard.tsx` (111 lines)
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

- **Path:** `src/ui/components/StructuredContentRenderer.tsx` (145 lines)
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

- **Path:** `src/ui/components/PluginBrowser.tsx` (657 lines)
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

- **Path:** `src/ui/components/PluginCard.tsx` (559 lines)
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

- **Path:** `src/ui/components/DatePicker.tsx` (217 lines)
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

- **Path:** `src/ui/components/RecurrencePicker.tsx` (131 lines)
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

- **Path:** `src/ui/components/TagsInput.tsx` (145 lines)
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

- **Path:** `src/ui/components/TemplateSelector.tsx` (206 lines)
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

- **Path:** `src/ui/components/AddProjectModal.tsx` (181 lines)
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

- **Path:** `src/ui/components/PermissionDialog.tsx` (83 lines)
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

- **Path:** `src/ui/components/ConfirmDialog.tsx` (102 lines)
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

- **Path:** `src/ui/components/QuickAddModal.tsx` (65 lines)
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

- **Path:** `src/ui/components/ContextMenu.tsx` (182 lines)
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

- **Path:** `src/ui/components/OnboardingModal.tsx` (102 lines)
- **Purpose:** First-run onboarding wizard with 3 steps: Welcome, Task Syntax Demo, and All Set.
- **Key Exports:** `OnboardingModal`
- **Props:**
  - `open: boolean`
  - `onClose: () => void`
- **Key Dependencies:** `lucide-react`, `api` (setAppSetting)
- **Used By:** `App.tsx` (checks `onboarding_completed` setting on mount)
- **Notes:** Progress dots for step indicator. Skip/Back/Next/Get Started navigation. Sets `onboarding_completed` app setting to `"true"` on completion. Step 2 shows task input syntax examples (priorities, tags, dates, projects).

---

## UI Chrome

### BulkActionBar.tsx

- **Path:** `src/ui/components/BulkActionBar.tsx` (124 lines)
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

- **Path:** `src/ui/components/FAB.tsx` (17 lines)
- **Purpose:** Mobile floating action button for adding tasks.
- **Key Exports:** `FAB`
- **Props:**
  - `onClick: () => void`
- **Key Dependencies:** `lucide-react` (Plus icon)
- **Used By:** `App.tsx` (mobile layout only)
- **Notes:** Fixed position, bottom-right, above the BottomNavBar. Uses accent background color.

---

### FocusMode.tsx

- **Path:** `src/ui/components/FocusMode.tsx` (258 lines)
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

- **Path:** `src/ui/components/QueryBar.tsx` (177 lines)
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

- **Path:** `src/ui/components/StatusBar.tsx` (20 lines)
- **Purpose:** Bottom status bar displaying plugin-registered status bar items.
- **Key Exports:** `StatusBar`
- **Props:**
  - `items: StatusBarItemInfo[]`
- **Key Dependencies:** `api/index.js` (StatusBarItemInfo type)
- **Used By:** `App.tsx`
- **Notes:** Each item shows icon + text. Only visible when plugins register status bar items.

---

### PluginPanel.tsx

- **Path:** `src/ui/components/PluginPanel.tsx` (17 lines)
- **Purpose:** Container for rendering plugin sidebar panel content.
- **Key Exports:** `PluginPanel`
- **Props:**
  - `panel: PanelInfo`
- **Key Dependencies:** `api/index.js` (PanelInfo type)
- **Used By:** `Sidebar.tsx`
- **Notes:** Renders panel icon, title, and content as text. Minimal wrapper component.

---

### Toast.tsx

- **Path:** `src/ui/components/Toast.tsx` (42 lines)
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

- **Path:** `src/ui/components/ErrorBoundary.tsx` (57 lines)
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

- **Path:** `src/ui/components/EmptyState.tsx` (26 lines)
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

- **Path:** `src/ui/components/Skeleton.tsx` (45 lines)
- **Purpose:** Skeleton loading placeholder components for initial app load state.
- **Key Exports:** `SkeletonLine`, `SkeletonTaskItem`, `SkeletonTaskList`
- **Props:**
  - `SkeletonLine`: `width?: string` -- CSS width (default "100%")
  - `SkeletonTaskItem`: none
  - `SkeletonTaskList`: `count?: number` -- number of skeleton rows (default 5)
- **Key Dependencies:** None
- **Used By:** `App.tsx` (replaces "Loading..." text during initial data fetch)
- **Notes:** Uses `animate-pulse` with `bg-surface-tertiary`. Has `aria-busy="true"` and `role="status"` for accessibility.

---

### CompletionRing.tsx

- **Path:** `src/ui/components/CompletionRing.tsx` (48 lines)
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

- **Path:** `src/ui/components/ChordIndicator.tsx` (30 lines)
- **Purpose:** Small floating pill at the bottom of the screen that displays the pending chord key while the user is mid-chord (e.g., pressed "g", waiting for the second key).
- **Key Exports:** `ChordIndicator`
- **Props:** None
- **Key Dependencies:** `useSyncExternalStore` (React), `shortcutManager` singleton from `shortcutManagerInstance.js`
- **Used By:** `App.tsx`
- **Notes:** Uses `useSyncExternalStore` to subscribe to `shortcutManager.onChordChange()` and read `shortcutManager.getPendingChord()`. Returns `null` when no chord is pending. Renders a fixed-position pill (`bottom-20`, horizontally centered, `z-50`) with a styled `<kbd>` element showing the pending key in uppercase and a "then ..." hint. Uses `animate-fade-in` entrance animation.
