# Backlog

All work items for ASF Saydo, organized by area and prioritized within each section. Items are pulled from here into sprints.

## Status Key

- `done` — Completed
- `ready` — Defined, estimated, ready for a sprint
- `needs-design` — Requires design decisions before implementation
- `blocked` — Waiting on another item
- `idea` — Not yet scoped, needs refinement

---

## Foundation & Infrastructure

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| F-01 | Project scaffold (package.json, tsconfig, lint, format) | done | — | Initial commit |
| F-02 | Core infrastructure (logger, config, validation, IDs) | done | — | Initial commit |
| F-03 | Database schema and migrations (Drizzle + SQLite) | done | — | Schema defined, migration runner ready |
| F-04 | Vite + React entry point and dev server | done | — | index.html, vite.config.ts, main.tsx |
| F-05 | CI/CD pipeline (GitHub Actions: lint, typecheck, test) | done | S7 | .github/workflows/ci.yml |
| F-06 | ESLint config file | done | S7 | eslint.config.js (flat config) |
| F-07 | Prettier config file | done | S7 | .prettierrc + .prettierignore |
| F-08 | Fix Tailwind CSS (@tailwindcss/vite plugin) | done | S8 | Vite plugin + theme imports |
| F-09 | Tauri v2 scaffold | done | S8 | src-tauri/, Cargo.toml, main.rs, icons |
| F-10 | Browser-compatible bootstrap (bootstrap-web.ts) | done | S8 | Service wiring for WebView |
| F-11 | isTauri() API branching in frontend | done | S8 | Direct service calls in Tauri mode |
| F-12 | Vite build config for Tauri production | done | S8 | Conditional apiPlugin, externals |
| F-13 | Tauri updater plugin setup | done | S13 | tauri-plugin-updater in Cargo.toml + lib.rs |
| F-14 | Update check UI in Settings | done | S13 | AboutSection with version + Tauri update check |
| F-15 | GitHub Actions release workflow | done | S13 | Multi-platform build + draft → publish |
| F-16 | Release preparation script | done | S13 | scripts/prepare-release.ts + release scripts |

## Core — Task CRUD

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| C-01 | Wire TaskService to SQLite via Drizzle queries | done | S1 | Connect tasks.ts to db/queries.ts |
| C-02 | Wire ProjectService to SQLite | done | S1 | |
| C-03 | Wire TagService to SQLite | done | S1 | |
| C-04 | Task creation with full field support | done | S1 | Depends on C-01 |
| C-05 | Task completion (mark done, set completedAt) | done | S1 | |
| C-06 | Task editing (title, priority, due, project, tags) | done | S1 | |
| C-07 | Task deletion | done | S1 | |
| C-08 | Task listing with filters (status, project, tag, priority) | done | S1 | Depends on C-01, filter logic exists |
| C-09 | Due date queries (today, upcoming, overdue) | done | S1 | |
| C-10 | Priority sorting in queries | done | S1 | Sort logic exists, wire to DB |
| C-11 | Recurring task creation on completion | done | S2 | Recurrence logic exists |
| C-12 | Task search (full-text across title + description) | done | S2 | |
| C-13 | Bulk operations (complete all, move, tag multiple) | done | S9 | Multi-select + bulk complete/move/tag/delete |
| C-14 | Sub-tasks (nested hierarchy with parentId) | done | S15 | Self-ref FK, cascade delete/complete, indent/outdent |
| C-15 | Task templates (reusable with {{variables}}) | done | S16 | TemplateService, instantiate with substitution |

## Parser & NLP

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| P-01 | Natural language date/time parsing (chrono-node) | done | — | Tested, 12 tests |
| P-02 | Priority extraction (p1–p4) | done | — | Tested, 10 tests |
| P-03 | Tag extraction (#tag) | done | — | Tested, 9 tests |
| P-04 | Project extraction (+project) | done | — | Tested, 6 tests |
| P-05 | Integrated task parser | done | — | Tested, 11 tests |
| P-06 | Parser inline preview (show parsed result as user types) | done | S2 | UI feature |
| P-07 | Natural language queries ("what's due this week?") | done | S16 | query-parser.ts + QueryBar component |

## UI — Views & Components

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| U-01 | Sidebar navigation | done | — | Component exists |
| U-02 | TaskInput component with NLP | done | — | Component exists |
| U-03 | TaskItem component | done | — | Component exists |
| U-04 | TaskList component | done | — | Component exists |
| U-05 | CommandPalette component | done | — | Component exists |
| U-06 | Wire Inbox view to live data | done | S1 | Depends on C-01 |
| U-07 | Wire Today view to live data | done | S1 | Depends on C-09 |
| U-08 | Wire Upcoming view to live data | done | S1 | Depends on C-09 |
| U-09 | Project view with task list | done | S2 | Depends on C-02 |
| U-10 | Settings view: theme toggle | done | S2 | |
| U-11 | Settings view: storage mode display | done | S14 | StorageSection in Data tab |
| U-12 | Task detail panel / editor | done | S2 | Click task → edit |
| U-13 | Keyboard navigation (j/k, enter, esc) | done | S2 | |
| U-14 | Command palette keybinding (Ctrl+K) | done | S2 | Component exists, needs global listener |
| U-15 | Light/dark theme switching | done | S2 | CSS exists, needs toggle wiring |
| U-16 | Drag-and-drop task reordering | done | S9 | @dnd-kit/core + sortable |
| U-17 | Undo/redo for task operations | done | S9 | UndoManager with Ctrl+Z/Ctrl+Shift+Z |
| U-18 | Focus mode (full-screen overlay, keyboard-driven) | done | S15 | FocusMode.tsx, Space/N/P/Esc shortcuts |
| U-19 | Design token system (@theme, semantic classes) | done | S14 | Tailwind 4 @theme, all components migrated |
| U-20 | Settings tabbed layout | done | S14 | 8 tabs: General, AI, Voice, Plugins, Templates, Keyboard, Data, About |
| U-21 | Lucide icons throughout | done | S14 | Sidebar, views, components |
| U-22 | QueryBar with NL filtering | done | S16 | Debounced search, suggestions, filterTasks integration |
| U-23 | TemplateSelector modal | done | S16 | Template picker with variable form |
| U-24 | Reminder UI + useReminders hook | done | S19 | Polls /api/tasks/reminders/due every 30s |
| U-25 | Voice settings tab in Settings | done | S21 | Microphone detection, provider selection, 8 tabs total |
| U-26 | Use datepicker in reminder date input | done | S30 | DatePicker with showTime replaces raw datetime-local. GH #20 |
| U-27 | Task status updates (revert completed, mark cancelled) | done | S30 | Allow reverting completed tasks and marking tasks as cancelled. GH #21 |
| U-28 | Project emoji/icon customization | done | S31 | Emoji input in Sidebar creation form, icon display in project header. GH #23 |
| U-29 | Clear task selection context menu on page switch | done | S30 | Context menu cleared on page navigation. GH #24 |
| U-30 | SVG app icon | done | S31 | SVG logo in sidebar + favicon with PNG fallback. GH #25 |
| U-31 | Nord theme | done | S30 | Nord color scheme with full Arctic palette. GH #26 |
| U-32 | Auto-set today's date when adding task on Today page | done | S30 | Tasks on Today page default to today's due date. GH #28 |
| U-33 | View completed task details | done | S30 | Completed tasks clickable to view details. GH #29 |
| U-34 | Fix task creation error | done | S30 | Empty title guard in useTaskHandlers. GH #30 |
| U-35 | Design proper SVG logo | ready | — | Current placeholder needs redesign. Use specialized design app for final logo. |

## CLI

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| L-01 | CLI entry point with Commander.js | done | — | Scaffolded |
| L-02 | `saydo add` — wire to TaskService | done | S1 | Depends on C-01 |
| L-03 | `saydo list` — wire to TaskService with filters | done | S1 | Depends on C-08 |
| L-04 | `saydo done` — wire to TaskService | done | S1 | Depends on C-05 |
| L-05 | `saydo edit` — wire to TaskService | done | S2 | Depends on C-06 |
| L-06 | `saydo delete` — wire to TaskService | done | S2 | Depends on C-07 |
| L-07 | JSON output format (`--json`) | done | S2 | |
| L-08 | Interactive task picker (fuzzy find) | idea | — | |

## Plugin System

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| PL-01 | Plugin manifest schema + validation | done | — | Zod schema, 13 tests |
| PL-02 | Plugin settings manager | done | — | In-memory, 7 tests |
| PL-03 | Plugin registry search | done | — | 10 tests |
| PL-04 | Plugin loader (discover + validate manifests) | done | S3 | |
| PL-05 | Plugin lifecycle (load/unload, call onLoad/onUnload) | done | S3 | |
| PL-06 | Plugin sandbox (restricted execution context) | done | S3 | Sandboxed context with controlled API access |
| PL-07 | Plugin API surface (task read/write, events) | done | S3 | |
| PL-08 | Plugin UI extension: sidebar panels | done | S4 | |
| PL-09 | Plugin UI extension: custom views | done | S4 | |
| PL-10 | Plugin UI extension: status bar | done | S4 | |
| PL-11 | Plugin commands integration with command palette | done | S4 | |
| PL-12 | Plugin settings UI in Settings view | done | S4 | |
| PL-13 | Plugin store view (browse sources.json) | done | S4 | |
| PL-14 | Plugin install/uninstall from store | done | S10 | tar.gz download + extract, PluginInstaller |
| PL-15 | Plugin permission approval UX | done | S9 | Permission prompt on install, per-plugin grants |
| PL-16 | Event bus for task lifecycle hooks | done | S3 | |
| PL-17 | Plugin-specific isolated storage (persist to DB) | done | S3 | SQLite-backed per-plugin storage |
| PL-18 | Built-in Pomodoro plugin (fully functional) | done | S4 | Timer, pause/resume, configurable durations |
| PL-19 | Plugin API versioning (version constants + meta object) | done | S13 | PLUGIN_API_VERSION, PLUGIN_API_STABILITY |
| PL-20 | Manifest targetApiVersion + loader compatibility check | done | S13 | Warns on major version mismatch |

## AI Assistant

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| A-01 | AI provider abstraction interface | done | S5 | Common interface for all providers |
| A-02 | OpenAI provider implementation | done | S5 | GPT-4, GPT-3.5 via API key |
| A-03 | Anthropic provider implementation | done | S5 | Claude models via API key |
| A-04 | OpenRouter provider implementation | done | S5 | Multi-provider gateway |
| A-05 | Ollama provider implementation | done | S5 | Local models, zero data exposure |
| A-06 | LM Studio provider implementation | done | S5 | Local via OpenAI-compatible API |
| A-07 | AI chat panel in sidebar | done | S5 | Conversational UI component |
| A-08 | Chat session management | done | S5 | Conversation history, context window |
| A-09 | AI tool definitions (task CRUD) | done | S5 | Tools for create/read/update/complete/delete |
| A-10 | Context injection (tasks, projects, schedule) | done | S6 | Rich context in system message |
| A-11 | Natural language task creation via AI | done | S5 | Via AI tool calling |
| A-12 | AI follow-up questions | done | S6 | Enhanced system prompt |
| A-13 | AI priority suggestions | done | S6 | Enhanced system prompt |
| A-14 | AI daily schedule suggestion | done | S6 | Enhanced system prompt |
| A-15 | Voice input (speech-to-text) | done | S6 | Browser Speech API |
| A-16 | Provider settings UI | done | S5 | Select provider, enter API keys |
| A-17 | Custom AI provider plugin support | done | S9 | BYOM via ai:provider permission |
| A-18 | AI reminders via integrations | idea | — | Discord bot, Google Calendar, etc. |
| A-19 | AI chat error handling & graceful degradation | done | S17 | AIError class, classifyProviderError, error bubbles with retry, safety timeout |
| A-20 | AI voice output (text-to-speech for responses) | done | S21 | TTS provider abstraction (Browser Speech Synthesis, Groq PlayAI) |
| A-21 | AI voice conversation mode (bidirectional) | done | S21 | VAD-based hands-free mode, push-to-talk, voice loop |
| A-27 | Voice provider abstraction (STTProviderPlugin, TTSProviderPlugin) | done | S21 | Mirrors LLM provider pattern |
| A-28 | Voice adapters (browser-stt, browser-tts, groq-stt, groq-tts) | done | S21 | 4 cloud/browser adapters |
| A-29 | VAD (Voice Activity Detection) via @ricky0123/vad-web | done | S21 | useVAD hook for hands-free mode |
| A-22 | AI chat streaming error recovery | done | S17 | withTimeout(), partial content preservation, structured error events |
| A-23 | Dynamic model discovery for all AI providers | done | S18 | Fetch available models from provider APIs, dynamic dropdown in Settings with Custom fallback |
| A-24 | Local AI voice models (STT/TTS) | done | S24 | Whisper local STT, Kokoro local TTS, Piper local TTS — all run in browser via WASM/ONNX |
| A-25 | Pluggable LLM core (LLMPipeline, LLMExecutor, ToolRegistry) | done | S20 | Refactored AI layer into pipeline/executor/registry pattern |
| A-26 | AI intelligence tools (analyze-patterns, workload, smart-organize, energy) | done | S22 | 5 analytical tools in src/ai/tools/builtin/ |
| A-30 | Tiered system prompts (SOTA full + compact local) | done | S26 | Full prompt for cloud, compact for Ollama/LM Studio, tool filtering, duplicate loop detection |
| A-31 | AI task breakdown (break_down_task tool) | done | S27 | LLM breaks a task into subtasks using parentId. Inspired by Todoist Assist, dypt, ClickUp. |
| A-32 | Morning briefing / daily plan (plan_my_day tool) | idea | — | Query today's tasks + overdue, sort by priority/deadline, suggest an order. Inspired by Sunsama, Morgen. |
| A-33 | Shutdown / daily review (daily_review tool) | idea | — | Summarize completions, slipped tasks, tomorrow's outlook. Reflection prompts. Inspired by Sunsama. |
| A-34 | Overcommitment warning (check_overcommitment tool) | done | S27 | Proactive warning when creating tasks: "You have 8 tasks due tomorrow." Enhance analyze_workload. Inspired by Sunsama. |
| A-35 | Smart nudges / proactive alerts | idea | — | System-level notifications: overdue at morning, deadline approaching, stale tasks (2+ weeks pending), streaks. Rule-based, no LLM needed. |
| A-36 | AI time estimation (estimatedMinutes field) | idea | — | Track actual completion times. Suggest estimates from similar past tasks. Show accuracy stats. Inspired by Sunsama, Motion. |
| A-37 | Weekly review & productivity analytics (weekly_review tool) | idea | — | Completion rate, tasks created vs done, busiest day, most productive time, neglected projects. Inspired by Reclaim, Sunsama. |
| A-38 | Enhanced voice-to-structured-tasks / voice call mode | done | S29 | Voice call overlay with continuous conversation loop (greeting→listening→processing→speaking). Browser STT fallback. |
| A-39 | Meeting notes to tasks (extract_tasks_from_text tool) | idea | — | Paste meeting notes or any text, LLM extracts action items and creates tasks. Inspired by Motion, Notion. |
| A-40 | Duplicate detection on task create (check_duplicates tool) | done | S27 | Auto-check for similar existing tasks when creating. Jaccard similarity on pending tasks. Inspired by Linear. |
| A-41 | Energy-aware suggestions (enhanced) | idea | — | User sets peak hours in settings. get_energy_recommendations uses time-of-day to suggest what to work on. Inspired by rivva, Morgen. |
| A-42 | Habit / recurring task intelligence | idea | — | Detect tasks completed on a regular cadence and suggest creating recurring tasks. Proactive suggestion in weekly review. Inspired by Reclaim. |
| A-43 | Project planning from description | idea | — | "Plan a product launch" → LLM generates full project with tasks and milestones. Multi-step agent pattern. Inspired by Notion AI. |
| A-44 | Adaptive learning (AI preference tracking) | idea | — | Track which AI suggestions users accept vs reject. Feed back into future suggestions. Requires feedback table + prompt injection. |
| A-45 | ICS calendar export/import | idea | — | Export tasks with due dates as .ics files. Import .ics to create tasks. Enables calendar interop without live APIs. Inspired by Morgen, Reclaim. |
| A-46 | Conversational daily planning (voice call mode) | done | S29 | Voice call overlay with useVoiceCall hook state machine, VoiceCallOverlay UI, auto-speak responses. Inspired by Sunsama. |
| A-47 | Auto-scheduling into time blocks | idea | — | Given tasks with durations + available hours, algorithmically schedule into time blocks. Output as timeline or ICS. Inspired by Motion, Morgen. |
| A-48 | Plugin-contributed AI tools | idea | — | Let plugins register custom AI tools at runtime via ToolRegistry. E.g., a Gmail plugin adds import_emails_as_tasks. Architecture already supports this. |
| A-49 | Inworld AI TTS provider | done | S26 | Cloud TTS via Inworld AI streaming API. Adapter, proxy (NDJSON streaming), model selection (1.5-max/mini), contextual API key UX |
| A-50 | Contextual API key UX for Voice & AI tabs | done | S26 | API key input appears inline under selected provider with "Set" indicator and help text |
| A-51 | TTS model selection interface | done | S26 | TTSProviderPlugin.getModels(), model dropdown in Voice settings, Inworld exposes 4 models |
| A-52 | Auto load/unload LM Studio models with chat | done | S31 | Auto-manage toggle in AI settings, load on chat open, unload on close. GH #18 |
| A-53 | Voice model management (delete, show sizes) | done | S31 | Delete button + size display per model in Voice settings. GH #19 |
| A-54 | Rich interactive task cards in AI chat | done | S31 | ChatTaskCard component rendered after tool calls. GH #22 |
| A-55 | Link task titles in AI chat responses | done | S31 | saydo://task/<id> links intercepted in markdown renderer. GH #27 |
| A-56 | TTS UX improvements (voice preview, audio overlap fix) | done | S30 | Voice preview button + cancellable AudioPlayback handles. GH #31 |
| A-57 | Smart voice detection for call mode | done | S31 | Grace period buffering in useVAD, smart endpoint toggle + slider in Voice settings. GH #32 |

## Storage & Data

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| D-01 | SQLite connection + WAL mode | done | — | client.ts |
| D-02 | Drizzle migration runner | done | — | migrate.ts |
| D-03 | Generate initial migration from schema | done | S1 | `pnpm db:generate` |
| D-04 | CRUD query helpers (tasks, projects, tags, task_tags) | done | S1 | queries.ts partial |
| D-05 | Markdown storage backend | done | S11 | IStorage + MarkdownBackend with YAML frontmatter |
| D-06 | Storage interface abstraction | done | S11 | SQLite and Markdown share IStorage API |
| D-07 | Data export (JSON, Markdown, CSV) | done | S9 | JSON + Markdown + CSV export |
| D-08 | Data import (Todoist JSON, plain text) | done | S10 | Saydo JSON, Todoist JSON, Markdown |
| D-09 | Generalize DB layer (BaseSQLiteDatabase) | done | S8 | better-sqlite3 + sql.js share types |
| D-10 | sql.js WebView client + bundled migrations | done | S8 | client-web.ts, migrate-web.ts |
| D-11 | Tauri FS persistence (load/save SQLite) | done | S8 | persistence.ts via @tauri-apps/plugin-fs |
| D-12 | Add remindAt column to tasks | done | S19 | Migration 0004_silky_karnak.sql |

## Testing

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| T-01 | Parser unit tests | done | — | 48 tests |
| T-02 | Core logic unit tests (priorities, recurrence, filters) | done | — | 38 tests |
| T-03 | Zod schema validation tests | done | — | 33 tests |
| T-04 | Plugin system tests (types, settings, registry) | done | — | 30 tests |
| T-05 | CLI formatter tests | done | — | 8 tests |
| T-06 | Config/env tests | done | — | 13 tests |
| T-07 | Integration tests: TaskService + SQLite | done | S1 | End-to-end CRUD |
| T-08 | Integration tests: CLI commands | done | S2 | |
| T-09 | Component tests: TaskInput, TaskList | done | S2 | |
| T-10 | Plugin loader integration tests | done | S3 | |

## Hardening & Quality

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| H-01 | Expand error types (ValidationError, StorageError) | done | S12 | Core error class hierarchy |
| H-02 | API layer res.ok checks | done | S12 | handleResponse/handleVoidResponse helpers |
| H-03 | TaskContext mutation error handling | done | S12 | try/catch on all 7 mutations |
| H-04 | Harden parseBody & API middleware | done | S12 | JSON parse error + middleware try/catch |
| H-05 | Plugin loader try/catch | done | S12 | Cleanup on load failure |
| H-06 | Markdown backend fs error handling | done | S12 | StorageError wrapping on all fs ops |
| H-07 | React Error Boundary | done | S12 | Class component with fallback UI |
| H-08 | Batch tag query (eliminate N+1) | done | S12 | listAllTaskTags() — 2 queries instead of 1+N |
| H-09 | React.memo on TaskItem/SortableTaskItem | done | S12 | Prevent unnecessary re-renders |
| H-10 | Memoize TaskContext value | done | S12 | useMemo on context provider value |
| H-11 | Debounce project refresh | done | S12 | tasks.length dependency instead of tasks |
| H-12 | Accessibility: Toast role="alert" | done | S12 | aria-live="assertive" |
| H-13 | Accessibility: Dialog ARIA (CommandPalette, PermissionDialog) | done | S12 | role="dialog", aria-modal, combobox pattern |
| H-14 | Accessibility: Sidebar ARIA | done | S12 | aria-current, aria-label, aria-hidden |
| H-15 | Accessibility: TaskItem ARIA | done | S12 | role="button", tabIndex, keyboard nav, sr-only |
| H-16 | Accessibility: Skip-to-content link | done | S12 | sr-only focus link in App.tsx |
| H-17 | Accessibility: TaskDetailPanel + AIChatPanel ARIA | done | S12 | role="complementary", aria-labels |

## Frontend Enhancements

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| FE-01 | Remove console.log from AIChatPanel | done | S32 | Cleaned 11 debug statements |
| FE-02 | Fix `(task as any).remindAt` type casts | done | S32 | remindAt is defined in types; removed stale `as any` |
| FE-03 | Fix UTC date comparison bug (toDateKey) | done | S32 | Replaced UTC `toISOString().split("T")[0]` with local-time `toDateKey()` |
| FE-04 | Fix double-fetch of projects/tags | done | S32 | Removed duplicate mount effect in App.tsx |
| FE-05 | Fix AI sidebar persistence conflict | done | S32 | Removed localStorage; use appSettings only |
| FE-06 | Fix FocusMode non-null assertions | done | S32 | Added null guard, removed `currentTask!` |
| FE-07 | Extract OverdueSection component | done | S32 | Deduplicated ~70 lines from Today + Upcoming |
| FE-08 | Create EmptyState component | done | S32 | Reusable empty state with icon, title, description, action |
| FE-09 | Create Skeleton loading components | done | S32 | SkeletonLine, SkeletonTaskItem, SkeletonTaskList |
| FE-10 | Focus trap for MobileDrawer | done | S32 | Custom useFocusTrap hook |
| FE-11 | Inline parse pills in TaskInput | done | S32 | Colored pill badges with icons for preview tokens |
| FE-12 | Quick-Add Modal | done | S32 | Ctrl+N / q shortcut, centered overlay |
| FE-13 | View transitions (fade-in animation) | done | S32 | animate-fade-in wrapper keyed by view |
| FE-14 | Enhanced empty states | done | S32 | EmptyState component in Completed, FiltersLabels, TaskList |
| FE-15 | Right-click context menu | done | S32 | ContextMenu with submenus, keyboard nav |
| FE-16 | Reminder in-app toasts | done | S32 | showToast on reminder with "View" action |
| FE-17 | Task list virtualization | done | S32 | @tanstack/react-virtual for >50 items |
| FE-18 | Task hover preview | done | S32 | TaskPreview popover on 300ms hover |
| FE-19 | Drag-and-drop DragOverlay | done | S32 | Styled drag ghost with shadow + rotation |
| FE-20 | Onboarding wizard | done | S32 | 3-step OnboardingModal on first run |
| FE-21 | Daily completion ring | done | S32 | CompletionRing SVG in Today header |
| FE-22 | Calendar view (week grid) | done | S32 | Calendar.tsx with week nav, task entries by due date |
| FE-23 | Breadcrumb navigation | done | S32 | Breadcrumb component for project/task views |

## QA — Bugs Found (Feb 2026 Full App Test)

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| QA-01 | AI Chat crashes on load — WelcomeScreen.tsx `.filter()` on undefined `tasks` | done | S33 | Fixed: `const { state } = useTaskContext(); const tasks = state.tasks ?? []` |
| QA-02 | ErrorBoundary doesn't reset on route change | done | S33 | Fixed: moved dynamic key to ErrorBoundary component |
| QA-03 | NLP `+project` syntax doesn't assign tasks to projects | done | S33 | Fixed: resolve parsed.project name → project ID in useTaskHandlers |
| QA-04 | Plugin UI polling every 1 second (massive perf issue) | done | S33 | Fixed: changed interval from 1s to 30s |
| QA-05 | Inbox task count stale after marking task completed | done | S33 | Fixed: show pending-only count in header |
| QA-06 | Calendar Day view doesn't default to today when switching modes | done | S33 | Fixed: reset date to today on mode switch |
| QA-07 | React DOM nesting violations in Calendar task items | done | S33 | Fixed: `<button>` → `<span role="button">` in week + day views |
| QA-08 | Filters & Labels route mismatch | done | S33 | Fixed: added `"filters"` case alias in useRouting |
| QA-09 | "X tasks" plural grammar — shows "1 tasks" instead of "1 task" | done | S33 | Fixed: singular/plural in Inbox, Today, Upcoming, Project |
| QA-10 | Task detail "Cancelled" status button truncated | done | S33 | Fixed: added flex-wrap to status button container |
| QA-11 | Duplicate "Quick Add Task" in keyboard shortcuts settings | done | S33 | Fixed: renamed to "Quick Add Task (Alt)" |
| QA-12 | Collapsed sidebar hides My Projects section entirely | done | S33 | Fixed: added collapsed project icons with tooltips |
| QA-13 | Reminder polling every 30s even when no reminders exist | done | S33 | Fixed: increased default interval to 60s |

## Documentation

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| DOC-01 | README.md | done | — | |
| DOC-02 | CLAUDE.md | done | — | |
| DOC-03 | docs/README.md (project overview) | done | — | |
| DOC-04 | docs/development/ARCHITECTURE.md | done | — | |
| DOC-05 | docs/plugins/API.md | done | — | |
| DOC-06 | docs/plugins/EXAMPLES.md | done | — | |
| DOC-07 | docs/planning/ROADMAP.md | done | — | |
| DOC-08 | docs/development/CONTRIBUTING.md | done | — | |
| DOC-09 | docs/development/SETUP_LOCAL.md | done | — | |
| DOC-10 | docs/development/SECURITY.md | done | — | |
| DOC-11 | docs/planning/BACKLOG.md | done | — | This file |
| DOC-12 | docs/planning/SPRINTS.md | done | — | Sprint tracking |
| DOC-13 | Plugin API versioning docs | done | S13 | API Versioning & Stability section in API.md |
| DOC-14 | v1.0 release planning docs update | done | S13 | ROADMAP, SPRINTS, BACKLOG updated |
| DOC-15 | Rebrand Docket → Saydo across all docs and code | done | S23 | All identifiers, DB files, localStorage keys updated |
