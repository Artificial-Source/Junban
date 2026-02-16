# Backlog

All work items for ASF Docket, organized by area and prioritized within each section. Items are pulled from here into sprints.

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
| U-20 | Settings tabbed layout | done | S14 | 7 tabs: General, AI, Plugins, Templates, Keyboard, Data, About |
| U-21 | Lucide icons throughout | done | S14 | Sidebar, views, components |
| U-22 | QueryBar with NL filtering | done | S16 | Debounced search, suggestions, filterTasks integration |
| U-23 | TemplateSelector modal | done | S16 | Template picker with variable form |

## CLI

| ID | Item | Status | Sprint | Notes |
|----|------|--------|--------|-------|
| L-01 | CLI entry point with Commander.js | done | — | Scaffolded |
| L-02 | `docket add` — wire to TaskService | done | S1 | Depends on C-01 |
| L-03 | `docket list` — wire to TaskService with filters | done | S1 | Depends on C-08 |
| L-04 | `docket done` — wire to TaskService | done | S1 | Depends on C-05 |
| L-05 | `docket edit` — wire to TaskService | done | S2 | Depends on C-06 |
| L-06 | `docket delete` — wire to TaskService | done | S2 | Depends on C-07 |
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
| A-20 | AI voice output (text-to-speech for responses) | needs-design | — | TTS for AI assistant responses, provider abstraction (Browser Speech Synthesis, ElevenLabs, etc.) |
| A-21 | AI voice conversation mode (bidirectional) | needs-design | — | Full voice-in/voice-out conversational flow, wake word or push-to-talk |
| A-22 | AI chat streaming error recovery | done | S17 | withTimeout(), partial content preservation, structured error events |
| A-23 | Dynamic model discovery for all AI providers | done | S18 | Fetch available models from provider APIs, dynamic dropdown in Settings with Custom fallback |
| A-24 | Local AI voice models (STT/TTS) | needs-design | — | Local speech-to-text and text-to-speech models for mobile & desktop (Whisper, Piper, etc.) |

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
| D-08 | Data import (Todoist JSON, plain text) | done | S10 | Docket JSON, Todoist JSON, Markdown |
| D-09 | Generalize DB layer (BaseSQLiteDatabase) | done | S8 | better-sqlite3 + sql.js share types |
| D-10 | sql.js WebView client + bundled migrations | done | S8 | client-web.ts, migrate-web.ts |
| D-11 | Tauri FS persistence (load/save SQLite) | done | S8 | persistence.ts via @tauri-apps/plugin-fs |

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
