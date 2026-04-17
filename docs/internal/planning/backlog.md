# Backlog

All work items for ASF Junban, organized by area and prioritized within each section. Items are pulled from here into sprints.

## Status Key

- `done` — Completed
- `ready` — Defined, estimated, ready for a sprint
- `needs-design` — Requires design decisions before implementation
- `blocked` — Waiting on another item
- `idea` — Not yet scoped, needs refinement

---

## Foundation & Infrastructure

| ID   | Item                                                    | Status | Sprint | Notes                                          |
| ---- | ------------------------------------------------------- | ------ | ------ | ---------------------------------------------- |
| F-01 | Project scaffold (package.json, tsconfig, lint, format) | done   | —      | Initial commit                                 |
| F-02 | Core infrastructure (logger, config, validation, IDs)   | done   | —      | Initial commit                                 |
| F-03 | Database schema and migrations (Drizzle + SQLite)       | done   | —      | Schema defined, migration runner ready         |
| F-04 | Vite + React entry point and dev server                 | done   | —      | index.html, vite.config.ts, main.tsx           |
| F-05 | CI/CD pipeline (GitHub Actions: lint, typecheck, test)  | done   | S7     | .github/workflows/ci.yml                       |
| F-06 | ESLint config file                                      | done   | S7     | eslint.config.js (flat config)                 |
| F-07 | Prettier config file                                    | done   | S7     | .prettierrc + .prettierignore                  |
| F-08 | Fix Tailwind CSS (@tailwindcss/vite plugin)             | done   | S8     | Vite plugin + theme imports                    |
| F-09 | Tauri v2 scaffold                                       | done   | S8     | src-tauri/, Cargo.toml, main.rs, icons         |
| F-10 | Browser-compatible bootstrap (bootstrap-web.ts)         | done   | S8     | Service wiring for WebView                     |
| F-11 | isTauri() API branching in frontend                     | done   | S8     | Direct service calls in Tauri mode             |
| F-12 | Vite build config for Tauri production                  | done   | S8     | Conditional apiPlugin, externals               |
| F-13 | Tauri updater plugin setup                              | done   | S13    | tauri-plugin-updater in Cargo.toml + lib.rs    |
| F-14 | Update check UI in Settings                             | done   | S13    | AboutSection with version + Tauri update check |
| F-15 | GitHub Actions release workflow                         | done   | S13    | Multi-platform build + draft → publish         |
| F-16 | Release preparation script                              | done   | S13    | scripts/prepare-release.ts + release scripts   |

## Core — Task CRUD

| ID   | Item                                                       | Status | Sprint | Notes                                                  |
| ---- | ---------------------------------------------------------- | ------ | ------ | ------------------------------------------------------ |
| C-01 | Wire TaskService to SQLite via Drizzle queries             | done   | S1     | Connect tasks.ts to db/queries.ts                      |
| C-02 | Wire ProjectService to SQLite                              | done   | S1     |                                                        |
| C-03 | Wire TagService to SQLite                                  | done   | S1     |                                                        |
| C-04 | Task creation with full field support                      | done   | S1     | Depends on C-01                                        |
| C-05 | Task completion (mark done, set completedAt)               | done   | S1     |                                                        |
| C-06 | Task editing (title, priority, due, project, tags)         | done   | S1     |                                                        |
| C-07 | Task deletion                                              | done   | S1     |                                                        |
| C-08 | Task listing with filters (status, project, tag, priority) | done   | S1     | Depends on C-01, filter logic exists                   |
| C-09 | Due date queries (today, upcoming, overdue)                | done   | S1     |                                                        |
| C-10 | Priority sorting in queries                                | done   | S1     | Sort logic exists, wire to DB                          |
| C-11 | Recurring task creation on completion                      | done   | S2     | Recurrence logic exists                                |
| C-12 | Task search (full-text across title + description)         | done   | S2     |                                                        |
| C-13 | Bulk operations (complete all, move, tag multiple)         | done   | S9     | Multi-select + bulk complete/move/tag/delete           |
| C-14 | Sub-tasks (nested hierarchy with parentId)                 | done   | S15    | Self-ref FK, cascade delete/complete, indent/outdent   |
| C-15 | Task templates (reusable with {{variables}})               | done   | S16    | TemplateService, instantiate with substitution         |
| C-16 | Project sections service (CRUD + reordering)               | done   | S35    | SectionsService with drag-and-drop reorder             |
| C-17 | Productivity stats service                                 | done   | S35    | StatsService: daily completions, streaks, trends       |
| C-18 | Task comments and activity tracking                        | done   | S35    | Comments CRUD + automatic activity log on task changes |
| C-19 | Task deadlines and time estimates                          | done   | S35    | deadline, estimatedMinutes fields on tasks             |

## Parser & NLP

| ID   | Item                                                     | Status | Sprint | Notes                                                    |
| ---- | -------------------------------------------------------- | ------ | ------ | -------------------------------------------------------- |
| P-01 | Natural language date/time parsing (chrono-node)         | done   | —      | Tested, 12 tests                                         |
| P-02 | Priority extraction (p1–p4)                              | done   | —      | Tested, 10 tests                                         |
| P-03 | Tag extraction (#tag)                                    | done   | —      | Tested, 9 tests                                          |
| P-04 | Project extraction (+project)                            | done   | —      | Tested, 6 tests                                          |
| P-05 | Integrated task parser                                   | done   | —      | Tested, 11 tests                                         |
| P-06 | Parser inline preview (show parsed result as user types) | done   | S2     | UI feature                                               |
| P-07 | Natural language queries ("what's due this week?")       | done   | S16    | query-parser.ts + QueryBar component                     |
| P-08 | NLP deadline and duration parsing                        | done   | S35    | Parse "deadline Friday" and "~2h" / "~30m" in task input |

## UI — Views & Components

| ID   | Item                                                   | Status | Sprint | Notes                                                                          |
| ---- | ------------------------------------------------------ | ------ | ------ | ------------------------------------------------------------------------------ |
| U-01 | Sidebar navigation                                     | done   | —      | Component exists                                                               |
| U-02 | TaskInput component with NLP                           | done   | —      | Component exists                                                               |
| U-03 | TaskItem component                                     | done   | —      | Component exists                                                               |
| U-04 | TaskList component                                     | done   | —      | Component exists                                                               |
| U-05 | CommandPalette component                               | done   | —      | Component exists                                                               |
| U-06 | Wire Inbox view to live data                           | done   | S1     | Depends on C-01                                                                |
| U-07 | Wire Today view to live data                           | done   | S1     | Depends on C-09                                                                |
| U-08 | Wire Upcoming view to live data                        | done   | S1     | Depends on C-09                                                                |
| U-09 | Project view with task list                            | done   | S2     | Depends on C-02                                                                |
| U-10 | Settings view: theme toggle                            | done   | S2     |                                                                                |
| U-11 | Settings view: storage mode display                    | done   | S14    | StorageSection in Data tab                                                     |
| U-12 | Task detail panel / editor                             | done   | S2     | Click task → edit                                                              |
| U-13 | Keyboard navigation (j/k, enter, esc)                  | done   | S2     |                                                                                |
| U-14 | Command palette keybinding (Ctrl+K)                    | done   | S2     | Component exists, needs global listener                                        |
| U-15 | Light/dark theme switching                             | done   | S2     | CSS exists, needs toggle wiring                                                |
| U-16 | Drag-and-drop task reordering                          | done   | S9     | @dnd-kit/core + sortable                                                       |
| U-17 | Undo/redo for task operations                          | done   | S9     | UndoManager with Ctrl+Z/Ctrl+Shift+Z                                           |
| U-18 | Focus mode (full-screen overlay, keyboard-driven)      | done   | S15    | FocusMode.tsx, Space/N/P/Esc shortcuts                                         |
| U-19 | Design token system (@theme, semantic classes)         | done   | S14    | Tailwind 4 @theme, all components migrated                                     |
| U-20 | Settings tabbed layout                                 | done   | S14    | 8 tabs: General, AI, Voice, Plugins, Templates, Keyboard, Data, About          |
| U-21 | Lucide icons throughout                                | done   | S14    | Sidebar, views, components                                                     |
| U-22 | QueryBar with NL filtering                             | done   | S16    | Debounced search, suggestions, filterTasks integration                         |
| U-23 | TemplateSelector modal                                 | done   | S16    | Template picker with variable form                                             |
| U-24 | Reminder UI + useReminders hook                        | done   | S19    | Polls /api/tasks/reminders/due every 30s                                       |
| U-25 | Voice settings tab in Settings                         | done   | S21    | Microphone detection, provider selection, 8 tabs total                         |
| U-26 | Use datepicker in reminder date input                  | done   | S30    | DatePicker with showTime replaces raw datetime-local. GH #20                   |
| U-27 | Task status updates (revert completed, mark cancelled) | done   | S30    | Allow reverting completed tasks and marking tasks as cancelled. GH #21         |
| U-28 | Project emoji/icon customization                       | done   | S31    | Emoji input in Sidebar creation form, icon display in project header. GH #23   |
| U-29 | Clear task selection context menu on page switch       | done   | S30    | Context menu cleared on page navigation. GH #24                                |
| U-30 | SVG app icon                                           | done   | S31    | SVG logo in sidebar + favicon with PNG fallback. GH #25                        |
| U-31 | Nord theme                                             | done   | S30    | Nord color scheme with full Arctic palette. GH #26                             |
| U-32 | Auto-set today's date when adding task on Today page   | done   | S30    | Tasks on Today page default to today's due date. GH #28                        |
| U-33 | View completed task details                            | done   | S30    | Completed tasks clickable to view details. GH #29                              |
| U-34 | Fix task creation error                                | done   | S30    | Empty title guard in useTaskHandlers. GH #30                                   |
| U-35 | Design proper SVG logo                                 | ready  | —      | Current placeholder needs redesign. Use specialized design app for final logo. |
| U-36 | Board / Kanban view                                    | done   | S35    | Drag-and-drop columns (by section/status/priority) via DnD Kit                 |
| U-37 | Cancelled tasks view                                   | done   | S35    | Filtered view for cancelled tasks with restore action                          |
| U-38 | Someday / Maybe view                                   | done   | S35    | Dedicated view for deferred tasks, hidden from Today/Upcoming                  |
| U-39 | Stats / Productivity view                              | done   | S35    | Daily/weekly completion charts, streaks, trends                                |
| U-40 | ChordIndicator component                               | done   | S35    | Visual indicator for multi-key shortcut chords (G+I, G+T, etc.)                |
| U-41 | Features settings tab                                  | done   | S35    | 9 toggleable features in Settings (board view, stats, comments, etc.)          |

## CLI

| ID   | Item                                            | Status | Sprint | Notes           |
| ---- | ----------------------------------------------- | ------ | ------ | --------------- |
| L-01 | CLI entry point with Commander.js               | done   | —      | Scaffolded      |
| L-02 | `saydo add` — wire to TaskService               | done   | S1     | Depends on C-01 |
| L-03 | `saydo list` — wire to TaskService with filters | done   | S1     | Depends on C-08 |
| L-04 | `saydo done` — wire to TaskService              | done   | S1     | Depends on C-05 |
| L-05 | `saydo edit` — wire to TaskService              | done   | S2     | Depends on C-06 |
| L-06 | `saydo delete` — wire to TaskService            | done   | S2     | Depends on C-07 |
| L-07 | JSON output format (`--json`)                   | done   | S2     |                 |
| L-08 | Interactive task picker (fuzzy find)            | idea   | —      |                 |

## Plugin System

| ID    | Item                                                    | Status | Sprint | Notes                                                                                                                                          |
| ----- | ------------------------------------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| PL-01 | Plugin manifest schema + validation                     | done   | —      | Zod schema, 13 tests                                                                                                                           |
| PL-02 | Plugin settings manager                                 | done   | —      | In-memory, 7 tests                                                                                                                             |
| PL-03 | Plugin registry search                                  | done   | —      | 10 tests                                                                                                                                       |
| PL-04 | Plugin loader (discover + validate manifests)           | done   | S3     |                                                                                                                                                |
| PL-05 | Plugin lifecycle (load/unload, call onLoad/onUnload)    | done   | S3     |                                                                                                                                                |
| PL-06 | Plugin sandbox (restricted execution context)           | done   | S3     | Sandboxed context with controlled API access                                                                                                   |
| PL-07 | Plugin API surface (task read/write, events)            | done   | S3     |                                                                                                                                                |
| PL-08 | Plugin UI extension: sidebar panels                     | done   | S4     |                                                                                                                                                |
| PL-09 | Plugin UI extension: custom views                       | done   | S4     |                                                                                                                                                |
| PL-10 | Plugin UI extension: status bar                         | done   | S4     |                                                                                                                                                |
| PL-11 | Plugin commands integration with command palette        | done   | S4     |                                                                                                                                                |
| PL-12 | Plugin settings UI in Settings view                     | done   | S4     |                                                                                                                                                |
| PL-13 | Plugin store view (browse sources.json)                 | done   | S4     |                                                                                                                                                |
| PL-14 | Plugin install/uninstall from store                     | done   | S10    | tar.gz download + extract, PluginInstaller                                                                                                     |
| PL-15 | Plugin permission approval UX                           | done   | S9     | Permission prompt on install, per-plugin grants                                                                                                |
| PL-16 | Event bus for task lifecycle hooks                      | done   | S3     |                                                                                                                                                |
| PL-17 | Plugin-specific isolated storage (persist to DB)        | done   | S3     | SQLite-backed per-plugin storage                                                                                                               |
| PL-18 | Built-in Pomodoro plugin (fully functional)             | done   | S4     | Timer, pause/resume, configurable durations                                                                                                    |
| PL-19 | Plugin API versioning (version constants + meta object) | done   | S13    | PLUGIN_API_VERSION, PLUGIN_API_STABILITY                                                                                                       |
| PL-20 | Manifest targetApiVersion + loader compatibility check  | done   | S13    | Warns on major version mismatch                                                                                                                |
| PL-21 | Plugin view slots + structured content renderer         | done   | S34    | ViewSlot (navigation/tools/workspace), ViewContentType (text/structured), StructuredContentRenderer, slot-based sidebar, Pomodoro view rewrite |

## AI Assistant

| ID   | Item                                                                       | Status | Sprint | Notes                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-01 | AI provider abstraction interface                                          | done   | S5     | Common interface for all providers                                                                                                                                           |
| A-02 | OpenAI provider implementation                                             | done   | S5     | GPT-4, GPT-3.5 via API key                                                                                                                                                   |
| A-03 | Anthropic provider implementation                                          | done   | S5     | Claude models via API key                                                                                                                                                    |
| A-04 | OpenRouter provider implementation                                         | done   | S5     | Multi-provider gateway                                                                                                                                                       |
| A-05 | Ollama provider implementation                                             | done   | S5     | Local models, zero data exposure                                                                                                                                             |
| A-06 | LM Studio provider implementation                                          | done   | S5     | Local via OpenAI-compatible API                                                                                                                                              |
| A-07 | AI chat panel in sidebar                                                   | done   | S5     | Conversational UI component                                                                                                                                                  |
| A-08 | Chat session management                                                    | done   | S5     | Conversation history, context window                                                                                                                                         |
| A-09 | AI tool definitions (task CRUD)                                            | done   | S5     | Tools for create/read/update/complete/delete                                                                                                                                 |
| A-10 | Context injection (tasks, projects, schedule)                              | done   | S6     | Rich context in system message                                                                                                                                               |
| A-11 | Natural language task creation via AI                                      | done   | S5     | Via AI tool calling                                                                                                                                                          |
| A-12 | AI follow-up questions                                                     | done   | S6     | Enhanced system prompt                                                                                                                                                       |
| A-13 | AI priority suggestions                                                    | done   | S6     | Enhanced system prompt                                                                                                                                                       |
| A-14 | AI daily schedule suggestion                                               | done   | S6     | Enhanced system prompt                                                                                                                                                       |
| A-15 | Voice input (speech-to-text)                                               | done   | S6     | Browser Speech API                                                                                                                                                           |
| A-16 | Provider settings UI                                                       | done   | S5     | Select provider, enter API keys                                                                                                                                              |
| A-17 | Custom AI provider plugin support                                          | done   | S9     | BYOM via ai:provider permission                                                                                                                                              |
| A-18 | AI reminders via integrations                                              | idea   | —      | Discord bot, Google Calendar, etc.                                                                                                                                           |
| A-19 | AI chat error handling & graceful degradation                              | done   | S17    | AIError class, classifyProviderError, error bubbles with retry, safety timeout                                                                                               |
| A-20 | AI voice output (text-to-speech for responses)                             | done   | S21    | TTS provider abstraction (Browser Speech Synthesis, Groq PlayAI)                                                                                                             |
| A-21 | AI voice conversation mode (bidirectional)                                 | done   | S21    | VAD-based hands-free mode, push-to-talk, voice loop                                                                                                                          |
| A-27 | Voice provider abstraction (STTProviderPlugin, TTSProviderPlugin)          | done   | S21    | Mirrors LLM provider pattern                                                                                                                                                 |
| A-28 | Voice adapters (browser-stt, browser-tts, groq-stt, groq-tts)              | done   | S21    | 4 cloud/browser adapters                                                                                                                                                     |
| A-29 | VAD (Voice Activity Detection) via @ricky0123/vad-web                      | done   | S21    | useVAD hook for hands-free mode                                                                                                                                              |
| A-22 | AI chat streaming error recovery                                           | done   | S17    | withTimeout(), partial content preservation, structured error events                                                                                                         |
| A-23 | Dynamic model discovery for all AI providers                               | done   | S18    | Fetch available models from provider APIs, dynamic dropdown in Settings with Custom fallback                                                                                 |
| A-24 | Local AI voice models (STT/TTS)                                            | done   | S24    | Whisper local STT, Kokoro local TTS, Piper local TTS — all run in browser via WASM/ONNX                                                                                      |
| A-25 | Pluggable LLM core (LLMPipeline, LLMExecutor, ToolRegistry)                | done   | S20    | Refactored AI layer into pipeline/executor/registry pattern                                                                                                                  |
| A-26 | AI intelligence tools (analyze-patterns, workload, smart-organize, energy) | done   | S22    | 5 analytical tools in src/ai/tools/builtin/                                                                                                                                  |
| A-30 | Tiered system prompts (SOTA full + compact local)                          | done   | S26    | Full prompt for cloud, compact for Ollama/LM Studio, tool filtering, duplicate loop detection                                                                                |
| A-31 | AI task breakdown (break_down_task tool)                                   | done   | S27    | LLM breaks a task into subtasks using parentId. Inspired by Todoist Assist, dypt, ClickUp.                                                                                   |
| A-32 | Morning briefing / daily plan (plan_my_day tool)                           | done   | S33    | Query today's tasks + overdue, sort by priority/deadline, suggest an order. Inspired by Sunsama, Morgen.                                                                     |
| A-33 | Shutdown / daily review (daily_review tool)                                | done   | S33    | Summarize completions, slipped tasks, tomorrow's outlook. Reflection prompts. Inspired by Sunsama.                                                                           |
| A-34 | Overcommitment warning (check_overcommitment tool)                         | done   | S27    | Proactive warning when creating tasks: "You have 8 tasks due tomorrow." Enhance analyze_workload. Inspired by Sunsama.                                                       |
| A-35 | Smart nudges / proactive alerts                                            | done   | S41    | Rule-based proactive alerts: overdue, deadline approaching, stale tasks, empty today, overloaded day. evaluateNudges() engine + useNudges hook + settings UI. No LLM needed. |
| A-36 | AI time estimation (estimatedMinutes field)                                | done   | S47    | Track actual completion times. Suggest estimates from similar past tasks. Show accuracy stats. Inspired by Sunsama, Motion.                                                  |
| A-37 | Weekly review & productivity analytics (weekly_review tool)                | done   | S47    | Completion rate, tasks created vs done, busiest day, most productive time, neglected projects. Inspired by Reclaim, Sunsama.                                                 |
| A-38 | Enhanced voice-to-structured-tasks / voice call mode                       | done   | S29    | Voice call overlay with continuous conversation loop (greeting→listening→processing→speaking). Browser STT fallback.                                                         |
| A-39 | Meeting notes to tasks (extract_tasks_from_text tool)                      | done   | S47    | Paste meeting notes or any text, LLM extracts action items and creates tasks. Inspired by Motion, Notion.                                                                    |
| A-40 | Duplicate detection on task create (check_duplicates tool)                 | done   | S27    | Auto-check for similar existing tasks when creating. Jaccard similarity on pending tasks. Inspired by Linear.                                                                |
| A-41 | Energy-aware suggestions (enhanced)                                        | idea   | —      | User sets peak hours in settings. get_energy_recommendations uses time-of-day to suggest what to work on. Inspired by rivva, Morgen.                                         |
| A-42 | Habit / recurring task intelligence                                        | idea   | —      | Detect tasks completed on a regular cadence and suggest creating recurring tasks. Proactive suggestion in weekly review. Inspired by Reclaim.                                |
| A-43 | Project planning from description                                          | idea   | —      | "Plan a product launch" → LLM generates full project with tasks and milestones. Multi-step agent pattern. Inspired by Notion AI.                                             |
| A-44 | Adaptive learning (AI preference tracking)                                 | idea   | —      | Track which AI suggestions users accept vs reject. Feed back into future suggestions. Requires feedback table + prompt injection.                                            |
| A-45 | ICS calendar export/import                                                 | idea   | —      | Export tasks with due dates as .ics files. Import .ics to create tasks. Enables calendar interop without live APIs. Inspired by Morgen, Reclaim.                             |
| A-46 | Conversational daily planning (voice call mode)                            | done   | S29    | Voice call overlay with useVoiceCall hook state machine, VoiceCallOverlay UI, auto-speak responses. Inspired by Sunsama.                                                     |
| A-47 | Auto-scheduling into time blocks                                           | done   | S49    | Given tasks with durations + available hours, algorithmically schedule into time blocks. Output as timeline or ICS. Inspired by Motion, Morgen.                              |
| A-48 | Plugin-contributed AI tools                                                | idea   | —      | Let plugins register custom AI tools at runtime via ToolRegistry. E.g., a Gmail plugin adds import_emails_as_tasks. Architecture already supports this.                      |
| A-49 | Inworld AI TTS provider                                                    | done   | S26    | Cloud TTS via Inworld AI streaming API. Adapter, proxy (NDJSON streaming), model selection (1.5-max/mini), contextual API key UX                                             |
| A-50 | Contextual API key UX for Voice & AI tabs                                  | done   | S26    | API key input appears inline under selected provider with "Set" indicator and help text                                                                                      |
| A-51 | TTS model selection interface                                              | done   | S26    | TTSProviderPlugin.getModels(), model dropdown in Voice settings, Inworld exposes 4 models                                                                                    |
| A-52 | Auto load/unload LM Studio models with chat                                | done   | S31    | Auto-manage toggle in AI settings, load on chat open, unload on close. GH #18                                                                                                |
| A-53 | Voice model management (delete, show sizes)                                | done   | S31    | Delete button + size display per model in Voice settings. GH #19                                                                                                             |
| A-54 | Rich interactive task cards in AI chat                                     | done   | S31    | ChatTaskCard component rendered after tool calls. GH #22                                                                                                                     |
| A-55 | Link task titles in AI chat responses                                      | done   | S31    | saydo://task/<id> links intercepted in markdown renderer. GH #27                                                                                                             |
| A-56 | TTS UX improvements (voice preview, audio overlap fix)                     | done   | S30    | Voice preview button + cancellable AudioPlayback handles. GH #31                                                                                                             |
| A-57 | Smart voice detection for call mode                                        | done   | S31    | Grace period buffering in useVAD, smart endpoint toggle + slider in Voice settings. GH #32                                                                                   |
| A-58 | Productivity stats AI tool                                                 | done   | S35    | `productivity_stats` tool: query daily/weekly stats, streaks, trends via AI chat                                                                                             |

## Storage & Data

| ID   | Item                                                            | Status | Sprint | Notes                                                        |
| ---- | --------------------------------------------------------------- | ------ | ------ | ------------------------------------------------------------ |
| D-01 | SQLite connection + WAL mode                                    | done   | —      | client.ts                                                    |
| D-02 | Drizzle migration runner                                        | done   | —      | migrate.ts                                                   |
| D-03 | Generate initial migration from schema                          | done   | S1     | `pnpm db:generate`                                           |
| D-04 | CRUD query helpers (tasks, projects, tags, task_tags)           | done   | S1     | queries.ts partial                                           |
| D-05 | Markdown storage backend                                        | done   | S11    | IStorage + MarkdownBackend with YAML frontmatter             |
| D-06 | Storage interface abstraction                                   | done   | S11    | SQLite and Markdown share IStorage API                       |
| D-07 | Data export (JSON, Markdown, CSV)                               | done   | S9     | JSON + Markdown + CSV export                                 |
| D-08 | Data import (Todoist JSON, plain text)                          | done   | S10    | Junban JSON, Todoist JSON, Markdown                          |
| D-09 | Generalize DB layer (BaseSQLiteDatabase)                        | done   | S8     | better-sqlite3 + sql.js share types                          |
| D-10 | sql.js WebView client + bundled migrations                      | done   | S8     | client-web.ts, migrate-web.ts                                |
| D-11 | Tauri FS persistence (load/save SQLite)                         | done   | S8     | persistence.ts via @tauri-apps/plugin-fs                     |
| D-12 | Add remindAt column to tasks                                    | done   | S19    | Migration 0004_silky_karnak.sql                              |
| D-13 | New tables: daily_stats, sections, task_comments, task_activity | done   | S35    | Migration 0006; deadline + estimatedMinutes columns on tasks |

## Testing

| ID   | Item                                                    | Status | Sprint | Notes           |
| ---- | ------------------------------------------------------- | ------ | ------ | --------------- |
| T-01 | Parser unit tests                                       | done   | —      | 48 tests        |
| T-02 | Core logic unit tests (priorities, recurrence, filters) | done   | —      | 38 tests        |
| T-03 | Zod schema validation tests                             | done   | —      | 33 tests        |
| T-04 | Plugin system tests (types, settings, registry)         | done   | —      | 30 tests        |
| T-05 | CLI formatter tests                                     | done   | —      | 8 tests         |
| T-06 | Config/env tests                                        | done   | —      | 13 tests        |
| T-07 | Integration tests: TaskService + SQLite                 | done   | S1     | End-to-end CRUD |
| T-08 | Integration tests: CLI commands                         | done   | S2     |                 |
| T-09 | Component tests: TaskInput, TaskList                    | done   | S2     |                 |
| T-10 | Plugin loader integration tests                         | done   | S3     |                 |

## Hardening & Quality

| ID   | Item                                                          | Status | Sprint | Notes                                          |
| ---- | ------------------------------------------------------------- | ------ | ------ | ---------------------------------------------- |
| H-01 | Expand error types (ValidationError, StorageError)            | done   | S12    | Core error class hierarchy                     |
| H-02 | API layer res.ok checks                                       | done   | S12    | handleResponse/handleVoidResponse helpers      |
| H-03 | TaskContext mutation error handling                           | done   | S12    | try/catch on all 7 mutations                   |
| H-04 | Harden parseBody & API middleware                             | done   | S12    | JSON parse error + middleware try/catch        |
| H-05 | Plugin loader try/catch                                       | done   | S12    | Cleanup on load failure                        |
| H-06 | Markdown backend fs error handling                            | done   | S12    | StorageError wrapping on all fs ops            |
| H-07 | React Error Boundary                                          | done   | S12    | Class component with fallback UI               |
| H-08 | Batch tag query (eliminate N+1)                               | done   | S12    | listAllTaskTags() — 2 queries instead of 1+N   |
| H-09 | React.memo on TaskItem/SortableTaskItem                       | done   | S12    | Prevent unnecessary re-renders                 |
| H-10 | Memoize TaskContext value                                     | done   | S12    | useMemo on context provider value              |
| H-11 | Debounce project refresh                                      | done   | S12    | tasks.length dependency instead of tasks       |
| H-12 | Accessibility: Toast role="alert"                             | done   | S12    | aria-live="assertive"                          |
| H-13 | Accessibility: Dialog ARIA (CommandPalette, PermissionDialog) | done   | S12    | role="dialog", aria-modal, combobox pattern    |
| H-14 | Accessibility: Sidebar ARIA                                   | done   | S12    | aria-current, aria-label, aria-hidden          |
| H-15 | Accessibility: TaskItem ARIA                                  | done   | S12    | role="button", tabIndex, keyboard nav, sr-only |
| H-16 | Accessibility: Skip-to-content link                           | done   | S12    | sr-only focus link in App.tsx                  |
| H-17 | Accessibility: TaskDetailPanel + AIChatPanel ARIA             | done   | S12    | role="complementary", aria-labels              |

## Frontend Enhancements

| ID    | Item                                    | Status | Sprint | Notes                                                                                                                         |
| ----- | --------------------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| FE-01 | Remove console.log from AIChatPanel     | done   | S32    | Cleaned 11 debug statements                                                                                                   |
| FE-02 | Fix `(task as any).remindAt` type casts | done   | S32    | remindAt is defined in types; removed stale `as any`                                                                          |
| FE-03 | Fix UTC date comparison bug (toDateKey) | done   | S32    | Replaced UTC `toISOString().split("T")[0]` with local-time `toDateKey()`                                                      |
| FE-04 | Fix double-fetch of projects/tags       | done   | S32    | Removed duplicate mount effect in App.tsx                                                                                     |
| FE-05 | Fix AI sidebar persistence conflict     | done   | S32    | Removed localStorage; use appSettings only                                                                                    |
| FE-06 | Fix FocusMode non-null assertions       | done   | S32    | Added null guard, removed `currentTask!`                                                                                      |
| FE-07 | Extract OverdueSection component        | done   | S32    | Deduplicated ~70 lines from Today + Upcoming                                                                                  |
| FE-08 | Create EmptyState component             | done   | S32    | Reusable empty state with icon, title, description, action                                                                    |
| FE-09 | Create Skeleton loading components      | done   | S32    | SkeletonLine, SkeletonTaskItem, SkeletonTaskList                                                                              |
| FE-10 | Focus trap for MobileDrawer             | done   | S32    | Custom useFocusTrap hook                                                                                                      |
| FE-11 | Inline parse pills in TaskInput         | done   | S32    | Colored pill badges with icons for preview tokens                                                                             |
| FE-12 | Quick-Add Modal                         | done   | S32    | Ctrl+N / q shortcut, centered overlay                                                                                         |
| FE-13 | View transitions (fade-in animation)    | done   | S32    | animate-fade-in wrapper keyed by view                                                                                         |
| FE-14 | Enhanced empty states                   | done   | S32    | EmptyState component in Completed, FiltersLabels, TaskList                                                                    |
| FE-15 | Right-click context menu                | done   | S32    | ContextMenu with submenus, keyboard nav. Wired to task views in S36.                                                          |
| FE-16 | Reminder in-app toasts                  | done   | S32    | showToast on reminder with "View" action                                                                                      |
| FE-17 | Task list virtualization                | done   | S32    | @tanstack/react-virtual for >50 items                                                                                         |
| FE-18 | Task hover preview                      | done   | S32    | TaskPreview popover on 300ms hover                                                                                            |
| FE-19 | Drag-and-drop DragOverlay               | done   | S32    | Styled drag ghost with shadow + rotation                                                                                      |
| FE-20 | Onboarding wizard                       | done   | S32    | 3-step OnboardingModal on first run                                                                                           |
| FE-21 | Daily completion ring                   | done   | S32    | CompletionRing SVG in Today header                                                                                            |
| FE-22 | Calendar view (week grid)               | done   | S32    | Calendar.tsx with week nav, task entries by due date                                                                          |
| FE-23 | Breadcrumb navigation                   | done   | S32    | Breadcrumb component for project/task views                                                                                   |
| FE-24 | Today view Todoist-inspired redesign    | done   | S33    | Large title, CompletionRing right-aligned, CheckCircle2 subtitle, bold date header with accent underline, TaskInput at bottom |
| FE-25 | OverdueSection enhanced task rows       | done   | S33    | Priority-colored circles, two-line layout (title + due date below), separator lines, more padding                             |

## QA — Bugs Found (Feb 2026 Full App Test)

| ID    | Item                                                                         | Status | Sprint | Notes                                                                                  |
| ----- | ---------------------------------------------------------------------------- | ------ | ------ | -------------------------------------------------------------------------------------- |
| QA-01 | AI Chat crashes on load — WelcomeScreen.tsx `.filter()` on undefined `tasks` | done   | S33    | Fixed: `const { state } = useTaskContext(); const tasks = state.tasks ?? []`           |
| QA-02 | ErrorBoundary doesn't reset on route change                                  | done   | S33    | Fixed: moved dynamic key to ErrorBoundary component                                    |
| QA-03 | NLP `+project` syntax doesn't assign tasks to projects                       | done   | S33    | Fixed: resolve parsed.project name → project ID in useTaskHandlers                     |
| QA-04 | Plugin UI polling every 1 second (massive perf issue)                        | done   | S33    | Fixed: changed interval from 1s to 30s                                                 |
| QA-05 | Inbox task count stale after marking task completed                          | done   | S33    | Fixed: show pending-only count in header                                               |
| QA-06 | Calendar Day view doesn't default to today when switching modes              | done   | S33    | Fixed: reset date to today on mode switch                                              |
| QA-07 | React DOM nesting violations in Calendar task items                          | done   | S33    | Fixed: `<button>` → `<span role="button">` in week + day views                         |
| QA-08 | Filters & Labels route mismatch                                              | done   | S33    | Fixed: added `"filters"` case alias in useRouting                                      |
| QA-09 | "X tasks" plural grammar — shows "1 tasks" instead of "1 task"               | done   | S33    | Fixed: singular/plural in Inbox, Today, Upcoming, Project                              |
| QA-10 | Task detail "Cancelled" status button truncated                              | done   | S33    | Fixed: added flex-wrap to status button container                                      |
| QA-11 | Duplicate "Quick Add Task" in keyboard shortcuts settings                    | done   | S33    | Fixed: renamed to "Quick Add Task (Alt)"                                               |
| QA-12 | Collapsed sidebar hides My Projects section entirely                         | done   | S33    | Fixed: added collapsed project icons with tooltips                                     |
| QA-13 | Reminder polling every 30s even when no reminders exist                      | done   | S33    | Fixed: increased default interval to 60s                                               |
| QA-14 | Plugin toggle doesn't refresh sidebar views                                  | done   | S34    | Fixed: PluginsTab handleToggleBuiltin now refreshes views, panels, statusBar, commands |
| QA-15 | NLP "deadline friday" keyword doesn't set deadline field                     | done   | S36    | Fixed: extractDeadline() now tries "deadline <date>" keyword before "!!" prefix        |
| QA-16 | Right-click context menu on tasks does nothing                               | done   | S36    | Fixed: onContextMenu wired through TaskList → views → App.tsx with ContextMenu items   |
| QA-17 | Ultrawide monitors: content stretches edge-to-edge                           | done   | S36    | Fixed: max-w-7xl wrapper inside main element caps content at 1280px                    |

## Documentation

| ID     | Item                                                       | Status | Sprint | Notes                                                                |
| ------ | ---------------------------------------------------------- | ------ | ------ | -------------------------------------------------------------------- |
| DOC-01 | README.md                                                  | done   | —      |                                                                      |
| DOC-02 | CLAUDE.md                                                  | done   | —      |                                                                      |
| DOC-03 | docs/README.md (project overview)                          | done   | —      |                                                                      |
| DOC-04 | docs/guides/ARCHITECTURE.md                                | done   | —      |                                                                      |
| DOC-05 | docs/reference/plugins/API.md                              | done   | —      |                                                                      |
| DOC-06 | docs/reference/plugins/EXAMPLES.md                         | done   | —      |                                                                      |
| DOC-07 | docs/product/roadmap.md                                    | done   | —      | Legacy roadmap path now redirects here                               |
| DOC-08 | docs/guides/CONTRIBUTING.md                                | done   | —      |                                                                      |
| DOC-09 | docs/guides/SETUP.md                                       | done   | —      |                                                                      |
| DOC-10 | docs/guides/SECURITY.md                                    | done   | —      |                                                                      |
| DOC-11 | docs/internal/planning/backlog.md                          | done   | —      | This file                                                            |
| DOC-12 | Sprint tracking (merged into ROADMAP.md + CONTRIBUTING.md) | done   | —      |                                                                      |
| DOC-13 | Plugin API versioning docs                                 | done   | S13    | API Versioning & Stability section in API.md                         |
| DOC-14 | v1.0 release planning docs update                          | done   | S13    | ROADMAP, SPRINTS, BACKLOG updated                                    |
| DOC-15 | Historical rebrand cleanup (Docket / Saydo era)            | done   | S23    | Earlier project identifiers were normalized before the Junban rename |

---

## v2.0 — Core Enhancements (Tier 1)

Competitive parity features drawn from Todoist, TickTick, Linear, Things 3, Notion, and Amazing Marvin.

| ID    | Item                           | Status | Sprint | Notes                                                                                                                                                                  |
| ----- | ------------------------------ | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2-01 | Task duration / time estimates | done   | S35    | `estimatedMinutes` field on tasks. NLP parsing for `~2h` / `~30m`. Inspired by TickTick, Akiflow, Sunsama, Marvin.                                                     |
| V2-02 | Sections within projects       | done   | S35    | SectionsService with CRUD + drag-and-drop reordering. Columns in Board view. Inspired by Todoist, TickTick, Things 3.                                                  |
| V2-03 | Kanban / Board view            | done   | S35    | Board.tsx with DnD Kit. Columns by section, status, or priority. Drag between columns. Inspired by Todoist, TickTick, Notion, Linear.                                  |
| V2-04 | Task description with Markdown | done   | S37    | Rich text in descriptions: bold, italic, code blocks, checklists, links. Render with MarkdownMessage. Toggle edit/preview mode. Inspired by Todoist, Notion, Things 3. |
| V2-05 | "When" date vs. Deadline       | done   | S35    | `dueDate` (soft, Today/Upcoming) + `deadline` (hard, warnings). NLP: "deadline Friday". Inspired by Things 3.                                                          |
| V2-06 | Cancelled tasks view           | done   | S35    | Cancelled.tsx with restore action. Separate from Completed. Extends U-27 status support. Inspired by TickTick.                                                         |
| V2-07 | Composable keyboard shortcuts  | done   | S35    | ChordIndicator component. `G+I` (go inbox), `G+T` (go today), etc. Inspired by Linear, Akiflow.                                                                        |
| V2-08 | Productivity stats & streaks   | done   | S35    | StatsService + Stats.tsx view + `productivity_stats` AI tool. Daily/weekly counts, streaks. Inspired by Todoist Karma, TickTick.                                       |
| V2-09 | Task comments & activity log   | done   | S35    | task_comments + task_activity tables. Comments CRUD + auto activity log. Inspired by Todoist, Linear.                                                                  |
| V2-10 | Someday / Maybe list           | done   | S35    | Someday.tsx view. Hidden from Today/Upcoming. Inspired by Things 3, Akiflow, Amazing Marvin.                                                                           |

## v2.0 — Smart Features (Tier 2)

Higher-effort features that differentiate Junban from competitors.

| ID    | Item                                 | Status | Sprint  | Notes                                                                                                                                                                    |
| ----- | ------------------------------------ | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V2-11 | Guided daily planning ritual         | done   | S38-S40 | DailyPlanningModal — step-by-step morning flow: review overdue → pick today's tasks → estimate durations → set goals. AI-assisted.                                       |
| V2-12 | Daily shutdown / review ritual       | done   | S38-S40 | DailyReviewModal — end-of-day guided reflection: what got done, what slipped, tomorrow's outlook.                                                                        |
| V2-13 | Workload capacity indicator          | done   | S37     | WorkloadCapacityBar in Today view. Sums estimatedMinutes vs daily_capacity_minutes setting (4/6/8/10h). Red bar + "+Xh over" when exceeded. Inspired by Sunsama, Marvin. |
| V2-14 | Planned vs. actual time tracking     | done   | S38-S40 | actualMinutes column on tasks. Track actual time spent, show estimation accuracy.                                                                                        |
| V2-15 | Task relations (blocks / blocked by) | done   | S38-S40 | task_relations table, BlockedTaskIdsContext, blocked indicator on TaskItem.                                                                                              |
| V2-16 | Dynamic saved views / filters + AI   | done   | S38-S40 | FilterView with saved named filters. AI-generated filter support via query parser.                                                                                       |
| V2-17 | Eisenhower matrix view               | done   | S38-S40 | Matrix.tsx — four-quadrant urgent/important grid with drag between quadrants.                                                                                            |
| V2-18 | Global quick capture (Tauri)         | done   | S46     | System-wide hotkey opens floating task input over any app. Captures task without switching context. Auto-dismisses after entry. Inspired by Things 3, Akiflow.           |
| V2-19 | Project progress tracking            | done   | S37     | CompletionRing in project headers (completed/total). Mini progress bar in sidebar project items. Inspired by Things 3, Linear, Motion.                                   |

## DX — Module Decomposition

Large file cleanup sprint. No feature changes — pure structural refactoring. All exports and behavior must remain identical.

### Sprint S38: Module Decomposition

| ID    | Item                                    | Status | Sprint | Notes                                                                |
| ----- | --------------------------------------- | ------ | ------ | -------------------------------------------------------------------- |
| DX-01 | Split App.tsx (1474→403)                | done   | S38    | + AppProviders, TaskContextMenu, ViewRenderer                        |
| DX-02 | Split Sidebar.tsx (1120→266)            | done   | S38    | + SidebarPrimitives, ProjectTree, SidebarContextMenu, ViewNavigation |
| DX-03 | Split ChatToolResultCard.tsx (1062→159) | done   | S38    | + ChatVisualizations, ChatTaskResults, ChatPlanningCards             |
| DX-04 | Split VoiceTab.tsx (849→231)            | done   | S38    | + MicrophoneSection, LocalModelsSection, ProviderApiKeyInput         |
| DX-05 | Split TaskDetailPanel.tsx (827→487)     | done   | S38    | + TaskCommentsActivity, TaskRelations, task-detail-utils             |
| DX-06 | Split chat.ts (808→512)                 | done   | S38    | + chat-context, chat-prompts                                         |
| DX-07 | Split markdown-backend.ts (1164→382)    | done   | S38    | + task-ops, project-ops, metadata-ops, persistence, types            |

## v2.0 — Timeblocking Plugin (Tier 3a)

Akiflow-inspired timeblocking plugin with drag-and-drop scheduling. Built as a real plugin to validate and extend the plugin system.

### Sprint S39: Plugin React Rendering

Extend the plugin system to support React component rendering (currently only text/HTML strings). Required foundation for any interactive plugin.

| ID    | Item                                      | Status | Sprint | Notes                                                                                                                       |
| ----- | ----------------------------------------- | ------ | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| TB-01 | Plugin React component rendering          | done   | S39    | `contentType: "react"` on ViewRegistration + PanelRegistration. ErrorBoundary wrapping. Dual render path in PluginView.tsx. |
| TB-02 | Plugin network API                        | done   | S39    | Sandboxed `fetch()` in createPluginAPI(), gated by `"network"` permission, structured logging.                              |
| TB-03 | Plugin event bus: task update/move events | done   | S39    | `task:update`, `task:moved`, `task:estimated` events emitted from TaskService. Fully typed.                                 |

### Sprint S40: Timeblocking Core

Data model, CRUD, and recurrence engine for time blocks. No UI yet — pure logic + storage.

| ID    | Item                            | Status | Sprint | Notes                                                                                                                     |
| ----- | ------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| TB-04 | TimeBlock & TimeSlot data model | done   | S40    | Types: id, taskId?, slotId?, title, date, startTime, endTime, color?, locked, recurrence?. Stored via plugin storage API. |
| TB-05 | TimeBlock CRUD operations       | done   | S40    | Create, read, update, delete time blocks. Validation (no negative durations, start < end).                                |
| TB-06 | TimeSlot container logic        | done   | S40    | Slots hold multiple tasks. Task count, completion progress, auto-color from project.                                      |
| TB-07 | Recurrence engine               | done   | S40    | Expand recurring blocks: daily, weekly (specific days), monthly. Generate instances within a date range.                  |
| TB-08 | Task ↔ TimeBlock linking        | done   | S40    | Link tasks to blocks. When task completes, block shows as done. When block deleted, task unlinked (not deleted).          |

### Sprint S41: Timeline UI — Day View

The core visual: a vertical day timeline with drag-and-drop.

| ID    | Item                                | Status | Sprint | Notes                                                                                                         |
| ----- | ----------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| TB-09 | Day timeline grid component         | done   | S41    | Vertical timeline (configurable hours, default 6am–10pm). 15/30/60min grid lines. Current time indicator.     |
| TB-10 | TimeBlock visual component          | done   | S41    | Block card: title, duration, project color, completion state. Drag handle, resize handles (top/bottom edges). |
| TB-11 | Drag task → timeline (create block) | done   | S41    | Drag from task list onto timeline to create a time block. Snap to grid. Ghost preview during drag.            |
| TB-12 | Drag to reposition blocks           | done   | S41    | Move existing blocks by dragging. Snap to grid. Conflict indicators for overlaps.                             |
| TB-13 | Resize blocks (drag edges)          | done   | S41    | Drag top/bottom edge to adjust start/end time. Minimum 15min.                                                 |
| TB-14 | Click to create block               | done   | S41    | Alt+Click on empty timeline slot to create a new standalone block (like Akiflow).                             |

### Sprint S42: Timeline UI — Week View + Slots

Week overview and the container slot system.

| ID    | Item                   | Status | Sprint | Notes                                                                                                                   |
| ----- | ---------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| TB-15 | Week timeline grid     | done   | S42    | 7-column layout, each column is a compressed day timeline. Configurable work days.                                      |
| TB-16 | TimeSlot container UI  | done   | S42    | Visual container that holds multiple tasks. Task countdown badge (3/5), progress bar at bottom. Expand/collapse.        |
| TB-17 | Drag tasks into slots  | done   | S42    | Drag task into an existing slot. Task inherits slot's project. Reorder within slot.                                     |
| TB-18 | N-day views (2–6 days) | done   | S42    | Keyboard shortcuts 1–7 for day count. Responsive column widths.                                                         |
| TB-19 | Split view layout      | done   | S42    | Task list (left) + timeline (right) side-by-side. Drag between panels. Collapsible task list. Inspired by Akiflow/Amie. |

### Sprint S43: Polish + E2E Testing

Finishing touches, settings, "Replan" feature, and full Playwright E2E test pass over the entire timeblocking flow.

| ID    | Item                            | Status | Sprint | Notes                                                                                                                                                                                                  |
| ----- | ------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TB-20 | Recurring block management UI   | done   | S43    | Create/edit recurrence rules. Edit single instance vs. all future. Visual indicators for recurring blocks.                                                                                             |
| TB-21 | Replan Undone Tasks             | done   | S43    | End of day: detect incomplete blocks from today, offer to reschedule to tomorrow or next occurrence. Inspired by Akiflow.                                                                              |
| TB-22 | Conflict detection & indicators | done   | S43    | Highlight overlapping blocks. Warning badge. Tooltip with conflict details.                                                                                                                            |
| TB-23 | Plugin settings panel           | done   | S43    | Default duration (15/30/45/60min), work hours (start/end), work days, grid interval (15/30min), week start day.                                                                                        |
| TB-24 | Focus mode integration          | done   | S43    | Pin current time block to focus mode. Timer shows block duration countdown. Auto-advance to next block.                                                                                                |
| TB-25 | Keyboard shortcuts              | done   | S43    | D (day), W (week), 1-7 (n-day), T (go to today), ←/→ (navigate days), N (new block), Delete (remove block).                                                                                            |
| TB-26 | E2E Playwright testing          | done   | S43    | Run the app with `pnpm dev`, use Playwright MCP to test full timeblocking flow: navigate to view, create blocks, drag tasks, resize, week view, slots, recurring blocks, settings. Fix any bugs found. |

### Sprint S44: UX Polish + AI Tools

| ID    | Item                                      | Status | Sprint | Notes                                                                   |
| ----- | ----------------------------------------- | ------ | ------ | ----------------------------------------------------------------------- |
| TB-40 | Plugin sidebar drag + context menu        | done   | S44    | Plugin nav items draggable and right-clickable like built-in nav items. |
| TB-41 | Right-click empty sidebar space           | done   | S44    | Context menu on empty sidebar area.                                     |
| TB-42 | Timeline grid context menu                | done   | S44    | Right-click empty timeline slot to create block/slot.                   |
| TB-43 | Time block context menu                   | done   | S44    | Right-click block for edit, delete, duplicate, lock, recurrence.        |
| TB-44 | Click tasks in plugin TaskSidebar to edit | done   | S44    | Single click opens task detail panel.                                   |
| TB-45 | Plugin AI tools (block CRUD, scheduling)  | done   | S44    | 8 AI tools via `ai:tools` permission.                                   |
| TB-46 | E2E Playwright testing + bug fixes        | done   | S44    | Full E2E pass via Playwright MCP.                                       |

### Backlog — Timeblocking Future

| ID    | Item                                          | Status | Sprint | Notes                                                                                                                              |
| ----- | --------------------------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| TB-30 | Google Calendar sync via automation connector | idea   | —      | Push time blocks as events via n8n, Activepieces, Pipedream, or Make. Webhook/API endpoint for block CRUD events. No native OAuth. |
| TB-31 | ICS export of time blocks                     | idea   | —      | Export day/week as .ics file. One-click download. Manual calendar import.                                                          |
| TB-32 | Lock block → calendar event                   | idea   | —      | Mark a block as "locked" — exported as a real calendar event (public/private/busy visibility).                                     |
| TB-33 | AI auto-scheduling                            | done   | S49    | Given tasks with durations + available hours, AI places them optimally on the timeline. Extends A-47.                              |
| TB-34 | Availability sharing                          | idea   | —      | Generate shareable availability link from unblocked time. Booking page. Inspired by Akiflow/Calendly.                              |
| TB-35 | Two-way calendar sync                         | idea   | —      | Pull external calendar events into timeline as read-only blocks. Show busy time. Requires OAuth (deferred).                        |

## DX — Module Decomposition II

God file cleanup. No feature changes — pure structural refactoring. Target: all files under 400 lines.

### Sprint S45: Module Decomposition II

| ID    | Item                                  | Status | Sprint | Notes                           |
| ----- | ------------------------------------- | ------ | ------ | ------------------------------- |
| DX-08 | Split TimeblockingView.tsx (1175→333) | done   | S45    | Hooks/utils extracted           |
| DX-09 | Split PluginBrowser.tsx (689→346)     | done   | S45    | Modules to plugin-browser/      |
| DX-10 | Split AITab.tsx (637→326)             | done   | S45    | Modules to settings/ai/         |
| DX-11 | Split PluginCard.tsx (561→30)         | done   | S45    | Re-export facade                |
| DX-12 | Split ui/api/ai.ts (547→8)            | done   | S45    | Re-export facade over 6 modules |
| DX-13 | Split AIContext.tsx (500→154)         | done   | S45    | Hooks to context/ai/            |
| DX-14 | Split AIChatPanel.tsx (484→328)       | done   | S45    | Voice/config to chat/           |

### Sprint S50: Clean Slate (Fixes)

| ID     | Item                                                 | Status | Sprint | Notes                                                                                              |
| ------ | ---------------------------------------------------- | ------ | ------ | -------------------------------------------------------------------------------------------------- |
| FIX-01 | Fix Vite dev server `@/` alias resolution in esbuild | done   | S50    | 47 files: replaced `@/` imports with relative paths (esbuild follows dynamic imports transitively) |
| FIX-02 | Fix AI chat "Open Settings" → AI tab navigation      | done   | S50    | ViewRenderer passes `handleOpenSettingsTab("ai")` instead of generic `setSettingsOpen(true)`       |
| FIX-03 | Fix Vite ENOSPC inotify watcher limit                | done   | S50    | Added `watch: { ignored: ["**/src-tauri/target/**"] }` to vite server config                       |
| FIX-04 | Fix OnboardingModal test icon mock mismatch          | done   | S50    | Updated lucide-react mock: `MessageSquare`→`Bot`, `Lightbulb`→`Type`                               |

### Sprint S51: Module Decomposition III

| ID    | Item                                       | Status | Sprint | Notes                                                       |
| ----- | ------------------------------------------ | ------ | ------ | ----------------------------------------------------------- |
| DX-15 | Split vite.config.ts (2278→68)             | done   | S51    | + vite-api-plugin.ts + vite-api-routes/ (14 route files)    |
| DX-16 | Split App.tsx (1076→422)                   | done   | S51    | + useAppState, useAppHandlers, AppModals, AppLayout         |
| DX-17 | Split OnboardingModal.tsx (800+→split)     | done   | S51    | + onboarding/ (5 step files + constants + types)            |
| DX-18 | Split ChatToolResultCard.tsx (800+→split)  | done   | S51    | + chat/planning/ (6 files)                                  |
| DX-19 | Split GeneralTab.tsx (800+→split)          | done   | S51    | + general/ (6 section files)                                |
| DX-20 | Split TaskDetailPanel.tsx (800+→split)     | done   | S51    | + TaskDetailHeader, TaskDetailDescription                   |
| DX-21 | Split TaskItem.tsx (800+→split)            | done   | S51    | + task-item/ (3 files)                                      |
| DX-22 | Split TaskMetadata components (800+→split) | done   | S51    | + task-metadata/ (8 files)                                  |
| DX-23 | Split Sidebar.tsx components               | done   | S51    | + SidebarHeader, WorkspaceSection, NavSection, CollapsedNav |
| DX-24 | Split Today.tsx view                       | done   | S51    | + today/ (5 files)                                          |
| DX-25 | Split Project.tsx view                     | done   | S51    | + project/ (2 files)                                        |

### New AI Providers (S50)

| ID   | Item                                                    | Status | Sprint | Notes                                                                                         |
| ---- | ------------------------------------------------------- | ------ | ------ | --------------------------------------------------------------------------------------------- |
| A-59 | DeepSeek provider adapter                               | done   | S50    | OpenAI-compat, deepseek-chat default, api.deepseek.com/v1                                     |
| A-60 | Google Gemini provider adapter                          | done   | S50    | OpenAI-compat, gemini-2.5-flash default, generativelanguage.googleapis.com                    |
| A-61 | Mistral AI provider adapter                             | done   | S50    | OpenAI-compat, mistral-large-latest default                                                   |
| A-62 | Kimi (Moonshot) provider adapter                        | done   | S50    | OpenAI-compat, moonshot-v1-auto default, api.moonshot.cn                                      |
| A-63 | Alibaba DashScope provider adapter                      | done   | S50    | OpenAI-compat, qwen-plus default, dashscope.aliyuncs.com                                      |
| A-64 | Groq provider adapter                                   | done   | S50    | OpenAI-compat, llama-3.3-70b-versatile default                                                |
| A-65 | ZAI (Zhipu AI) provider adapter                         | done   | S50    | OpenAI-compat, glm-4-plus default, open.bigmodel.cn                                           |
| A-66 | OpenAI OAuth support                                    | done   | S50    | authType toggle (api-key/oauth), oauthToken field, personal-use disclaimer                    |
| A-67 | Load plugins in MCP server for plugin-contributed tools | done   | S50    | MCP server now calls pluginLoader.loadAll() so timeblocking auto-schedule tools are available |

## v2.0 — Other Plugin Ideas (Tier 3b)

Features designed to be built as Junban plugins, leveraging the existing plugin system.

| ID    | Item                                          | Status | Sprint | Notes                                                                                                                                   |
| ----- | --------------------------------------------- | ------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| V2-20 | Pomodoro + white noise / ambient sounds       | idea   | —      | Extend built-in Pomodoro plugin with ambient sounds (rain, cafe, wind, etc.). Inspired by TickTick.                                     |
| V2-21 | Habit tracker plugin                          | idea   | —      | Separate from tasks: recurring habits with streaks, frequency tracking, check-in stats. Inspired by TickTick.                           |
| V2-22 | Eat the Frog (dread level)                    | done   | S48    | Add "dread" rating to tasks. Surface highest-dread tasks first in the morning. Frog icon scales with dread. Inspired by Amazing Marvin. |
| V2-23 | Beat the Clock (gamified timer)               | idea   | —      | Estimate duration, then race against your own estimate. Gamifies execution. Inspired by Amazing Marvin.                                 |
| V2-24 | Dopamine Menu (quick wins)                    | done   | S48    | Filtered list of short/easy tasks for when motivation is low. Instant momentum builder. Inspired by Amazing Marvin.                     |
| V2-25 | Task Jar (random pick)                        | done   | S48    | Can't decide? Random task selection from today's list. Overcomes decision paralysis. Inspired by Amazing Marvin.                        |
| V2-26 | Deep Work Timer                               | idea   | —      | Extended focus timer (Cal Newport style) tied to a specific task. Session tracking and stats. Inspired by Morgen.                       |
| V2-27 | Gamification (points / levels / achievements) | idea   | —      | Points for completing tasks, daily streaks, level-up system, achievement badges. Inspired by TickTick, Amazing Marvin.                  |
| V2-28 | Weekly review & analytics                     | idea   | —      | Completion rate, busiest day, time by project, neglected projects. Charts and insights. Extends A-37. Inspired by Reclaim, Sunsama.     |
| V2-29 | ICS calendar export / import                  | idea   | —      | Export tasks with due dates as .ics files. Import .ics to create tasks. Calendar interop. Extends A-45. Inspired by Morgen, Reclaim.    |

## v2.0 — Future / Motion-Inspired (Tier 4)

Ambitious features for post-Tier 1-3 development. Heavy Motion/Amie/Notion inspiration.

| ID    | Item                                         | Status | Sprint | Notes                                                                                                                                                    |
| ----- | -------------------------------------------- | ------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2-30 | Timeline / Gantt view                        | idea   | —      | Horizontal timeline showing task durations, dependencies as arrows. Zoom: days/weeks/months. Inspired by TickTick, Notion.                               |
| V2-31 | AI auto-scheduling                           | done   | S49    | Place tasks on a daily timeline optimally based on priority, deadline, duration, energy. Reshuffle on changes. Core Motion feature. Needs deep research. |
| V2-32 | Split view (tasks + calendar side-by-side)   | idea   | —      | Drag tasks from list onto calendar for time-blocking. The Akiflow/Amie core layout pattern.                                                              |
| V2-33 | Year view with activity heatmap              | idea   | —      | GitHub-style heatmap showing completion density across the year. Satisfying visualization. Inspired by TickTick v8.0.                                    |
| V2-34 | Meeting notes → tasks (AI extraction)        | idea   | —      | Paste meeting notes or any text, AI extracts action items and creates tasks. Extends A-39. Inspired by Motion, Notion.                                   |
| V2-35 | Natural language filter creation (AI)        | idea   | —      | "Show me overdue tasks in the Work project" → AI generates the filter query. Inspired by Todoist Filter Assist.                                          |
| V2-36 | Voice-to-tasks (Ramble-style batch creation) | idea   | —      | Speak naturally, AI creates multiple structured tasks from unstructured speech. Builds on existing voice system. Inspired by Todoist Ramble.             |
| V2-37 | Sequential projects                          | idea   | —      | Only show the next task in a project. Reduces overwhelm for ordered workflows. Inspired by Amazing Marvin.                                               |
| V2-38 | Email to task                                | idea   | —      | Forward emails to a local endpoint that creates tasks. Extract subject, body, dates. Plugin candidate. Inspired by Todoist, Akiflow.                     |
| V2-39 | Joyful micro-animations (Framer Motion)      | done   | S48    | Polished completion animations, smooth view transitions, playful micro-interactions. The "Amie feeling." Inspired by Amie, Things 3.                     |
