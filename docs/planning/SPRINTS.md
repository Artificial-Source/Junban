# Sprints

Two-week sprint cycles. Each sprint has a clear goal and pulls items from the [Backlog](BACKLOG.md).

## How Sprints Work

- **Duration**: 2 weeks
- **Planning**: Select items from backlog at sprint start, assign to sprint column in BACKLOG.md
- **Daily work**: Pick the next `ready` item, mark `in-progress`, complete it
- **Review**: At sprint end, update items to `done`, write retro notes, plan next sprint
- **Carry-over**: Incomplete items return to backlog or carry into the next sprint

### Sprint Sizing

| Size | Effort | Example |
|------|--------|---------|
| S | < 2 hours | Wire a single service to DB, add a test file |
| M | 2–6 hours | Build a complete view, implement a CLI command end-to-end |
| L | 1–2 days | Plugin loader with validation, keyboard navigation system |
| XL | 3–5 days | Sandbox implementation, storage abstraction layer |

---

## Sprint 1 — "First Blood"

**Goal**: Wire the skeleton to a real database. Tasks can be created, listed, completed, and deleted through both the UI and CLI. The app actually works.

**Dates**: TBD (2 weeks)

| ID | Item | Size | Status |
|----|------|------|--------|
| D-03 | Generate initial migration from schema | S | done |
| D-04 | CRUD query helpers (tasks, projects, tags, task_tags) | M | done |
| C-01 | Wire TaskService to SQLite via Drizzle queries | M | done |
| C-02 | Wire ProjectService to SQLite | S | done |
| C-03 | Wire TagService to SQLite | S | done |
| C-04 | Task creation with full field support | M | done |
| C-05 | Task completion (mark done, set completedAt) | S | done |
| C-06 | Task editing (title, priority, due, project, tags) | M | done |
| C-07 | Task deletion | S | done |
| C-08 | Task listing with filters | S | done |
| C-09 | Due date queries (today, upcoming, overdue) | S | done |
| C-10 | Priority sorting in queries | S | done |
| U-06 | Wire Inbox view to live data | M | done |
| U-07 | Wire Today view to live data | S | done |
| U-08 | Wire Upcoming view to live data | S | done |
| L-02 | `docket add` — wire to TaskService | S | done |
| L-03 | `docket list` — wire to TaskService | S | done |
| L-04 | `docket done` — wire to TaskService | S | done |
| T-07 | Integration tests: TaskService + SQLite | M | done |

**Capacity**: ~18 items (mostly S/M), fits a focused 2-week sprint.

**Definition of Done**:
- [x] `pnpm dev` → open browser → create a task via input → see it in the inbox
- [x] Complete a task → it disappears from inbox
- [x] Today view shows only tasks due today
- [x] `pnpm cli add "task"` → `pnpm cli list` shows the task
- [x] `pnpm cli done <id>` marks the task complete
- [x] Integration tests pass: create → read → update → complete → delete
- [x] `pnpm check` passes (lint + typecheck + test)

---

## Sprint 2 — "Feel Good"

**Goal**: The app feels polished. Keyboard navigation, command palette, theme switching, task editor, project views, recurring tasks. Users can actually use this day-to-day.

**Dates**: TBD (2 weeks, after Sprint 1)

| ID | Item | Size | Status |
|----|------|------|--------|
| C-11 | Recurring task creation on completion | M | done |
| C-12 | Task search (full-text across title + description) | S | done |
| U-09 | Project view with task list | M | done |
| U-10 | Settings view: theme toggle | S | done |
| U-12 | Task detail panel / editor | L | done |
| U-13 | Keyboard navigation (j/k, enter, esc) | L | done |
| U-14 | Command palette keybinding (Ctrl+K) | S | done |
| U-15 | Light/dark theme switching | S | done |
| P-06 | Parser inline preview (show parsed result as user types) | M | done |
| L-05 | `docket edit` — wire to TaskService | S | done |
| L-06 | `docket delete` — wire to TaskService | S | done |
| L-07 | JSON output format (`--json`) | S | done |
| T-08 | Integration tests: CLI commands | M | done |
| T-09 | Component tests: TaskInput, TaskList | M | done |

**Capacity**: ~14 items (mix of S/M/L), fits a 2-week sprint.

**Definition of Done**:
- [x] j/k navigates tasks, Enter opens editor, Esc closes
- [x] Ctrl+K opens command palette with available commands
- [x] Theme toggle switches between light and dark
- [x] Completing a recurring task creates the next occurrence
- [x] Task detail panel shows all fields and allows editing
- [x] Project view filters to a single project
- [x] CLI `edit` and `delete` commands work
- [x] `pnpm check` passes

---

## Sprint 3 — "Plugins: Foundation"

**Goal**: Plugin loader works. Plugins can be discovered, validated, loaded, and unloaded. The event bus dispatches task lifecycle hooks. The example plugin actually runs.

**Dates**: TBD (2 weeks, after Sprint 2)

| ID | Item | Size | Status |
|----|------|------|--------|
| PL-16 | Event bus for task lifecycle hooks | M | done |
| PL-04 | Plugin loader (discover + validate manifests) | L | done |
| PL-05 | Plugin lifecycle (load/unload, call onLoad/onUnload) | L | done |
| PL-06 | Plugin sandbox (restricted execution context) | XL | done |
| PL-07 | Plugin API surface (task read/write, events) | L | done |
| PL-17 | Plugin-specific isolated storage (persist to DB) | M | done |
| T-10 | Plugin loader integration tests | M | done |

**Capacity**: ~7 items but heavier (L/XL), fits a 2-week sprint.

**Definition of Done**:
- [x] Drop a plugin folder into `plugins/` → Docket discovers it on startup
- [x] Invalid manifests are rejected with clear error messages
- [x] Plugin `onLoad()` and `onUnload()` are called correctly
- [x] Plugins can register commands via the API
- [x] Plugins receive `task:create` and `task:complete` events
- [x] Plugin storage persists across app restarts
- [x] Example plugin loads and shows task count in status bar
- [x] `pnpm check` passes

---

## Sprint 4 — "Plugins: UI"

**Goal**: Plugins can extend the UI. Sidebar panels, custom views, status bar items, settings tabs, and the plugin store are all functional.

**Dates**: TBD (2 weeks, after Sprint 3)

| ID | Item | Size | Status |
|----|------|------|--------|
| PL-08 | Plugin UI extension: sidebar panels | L | done |
| PL-09 | Plugin UI extension: custom views | L | done |
| PL-10 | Plugin UI extension: status bar | M | done |
| PL-11 | Plugin commands integration with command palette | M | done |
| PL-12 | Plugin settings UI in Settings view | M | done |
| PL-13 | Plugin store view (browse sources.json) | M | done |
| PL-18 | Built-in Pomodoro plugin (fully functional) | L | done |

**Capacity**: ~7 items (M/L), fits a 2-week sprint.

**Definition of Done**:
- [x] Pomodoro plugin renders a sidebar panel with timer
- [x] Plugin-registered views appear in sidebar navigation
- [x] Status bar shows plugin-provided items
- [x] Plugin commands appear in the command palette
- [x] Plugin settings appear in Settings > Plugins
- [x] Plugin store lists plugins from sources.json
- [x] `pnpm check` passes

---

## Sprint 8 — "Styling & Desktop App"

**Goal**: Fix Tailwind CSS styling and build a full Tauri v2 desktop application. All business logic runs in the WebView via sql.js (WASM SQLite) with persistence through Tauri FS plugin. The app works both as a dev server and as a standalone desktop binary.

**Dates**: TBD (2 weeks, after Sprint 7)

| ID | Item | Size | Status |
|----|------|------|--------|
| F-08 | Fix Tailwind CSS (@tailwindcss/vite plugin) | S | done |
| F-09 | Tauri v2 scaffold (Cargo.toml, main.rs, tauri.conf.json, capabilities) | L | done |
| D-09 | Generalize DB layer (BaseSQLiteDatabase for better-sqlite3 + sql.js) | M | done |
| D-10 | sql.js WebView client + bundled migration runner | M | done |
| D-11 | Tauri FS persistence (load/save SQLite file) | S | done |
| F-10 | Browser-compatible bootstrap (bootstrap-web.ts) | M | done |
| F-11 | isTauri() API branching (direct service calls in Tauri mode) | L | done |
| F-12 | Vite build config (conditional apiPlugin, external better-sqlite3, sql.js WASM) | M | done |

**Capacity**: ~8 items (mix of S/M/L), fits a 2-week sprint.

**Definition of Done**:
- [x] `pnpm dev` → browser → app has full Tailwind styling
- [x] `pnpm tauri dev` → native window → styled app works with Vite middleware
- [x] `pnpm build` → working frontend bundle in `dist/`
- [x] `pnpm tauri build` → compiles standalone desktop binary
- [x] `pnpm check` passes (lint + typecheck + 333 tests)
- [x] Rust `cargo check` compiles successfully

---

## Future Sprints (Unscheduled)

These will be planned as we get closer. See [BACKLOG.md](BACKLOG.md) for all items.

| Sprint | Theme | Key Items |
|--------|-------|-----------|
| S11 | Markdown Storage | Storage abstraction, Markdown backend, file-based projects |
| S12 | Hardening | Accessibility audit, performance profiling, error boundaries |
| S13 | v1.0 Release | Stable API freeze, auto-updater, community plugins |

---

## Completed Sprints

### Sprint 0 — "Scaffold" (completed)

**Goal**: Project structure, documentation, config files, source skeletons, and test suite.

| ID | Item | Status |
|----|------|--------|
| F-01 | Project scaffold | done |
| F-02 | Core infrastructure | done |
| F-03 | Database schema | done |
| F-04 | Vite + React entry point | done |
| All DOC items | Full documentation suite | done |
| All T-01–T-06 | Test suite (171 tests) | done |
| PL-01 | Plugin manifest schema | done |
| PL-02 | Plugin settings manager | done |
| PL-03 | Plugin registry search | done |
| P-01–P-05 | Parser (NLP, grammar, task parser) | done |

**Result**: 69 source files, 8 documentation files, 14 test files, 171 passing tests. Dev server runs.

### Sprint 1 — "First Blood" (completed)

**Goal**: Wire the skeleton to a real database. Tasks can be created, listed, completed, and deleted through both the UI and CLI.

| ID | Item | Status |
|----|------|--------|
| D-03, D-04 | Migration generation + CRUD query helpers | done |
| C-01–C-10 | Full task CRUD with filters, priorities, due dates | done |
| U-06–U-08 | Inbox, Today, Upcoming views wired to live data | done |
| L-02–L-04 | CLI add, list, done wired to TaskService | done |
| T-07 | Integration tests: TaskService + SQLite | done |

**Result**: Full CRUD lifecycle with SQLite persistence. 219 passing tests. UI and CLI both functional.

### Sprint 2 — "Feel Good" (completed)

**Goal**: Polish for daily use. Keyboard navigation, command palette, theme switching, task editor, project views, recurring tasks, CLI fully wired.

| ID | Item | Status |
|----|------|--------|
| C-11 | Recurring task creation on completion | done |
| C-12 | Task search (full-text across title + description) | done |
| U-09 | Project view with sidebar navigation | done |
| U-10, U-15 | Settings theme toggle + light/dark switching | done |
| U-12 | Task detail panel / editor (slide-over, auto-save on blur) | done |
| U-13 | Keyboard navigation (j/k/Enter/Esc) | done |
| U-14 | Command palette (Ctrl+K) with arrow nav | done |
| P-06 | Parser inline preview | done |
| L-05–L-07 | CLI edit, delete, --json on all commands | done |
| T-08, T-09 | CLI integration tests + component tests | done |

**Result**: 7 new files, 20 modified files. 246 passing tests. Keyboard-driven workflow, persistent themes, project views, recurring tasks all working.

### Sprint 3 — "Plugins: Foundation" (completed)

**Goal**: Plugin loader works. Plugins can be discovered, validated, loaded, and unloaded. The event bus dispatches task lifecycle hooks. The example plugin actually runs.

| ID | Item | Status |
|----|------|--------|
| PL-16 | Event bus for task lifecycle hooks | done |
| PL-04 | Plugin loader (discover + validate manifests) | done |
| PL-05 | Plugin lifecycle (load/unload, call onLoad/onUnload) | done |
| PL-06 | Plugin sandbox (restricted execution context) | done |
| PL-07 | Plugin API surface (task read/write, events) | done |
| PL-17 | Plugin-specific isolated storage (persist to DB) | done |
| T-10 | Plugin loader integration tests | done |

**Result**: Full plugin system with loader, sandbox, lifecycle management, event bus, and per-plugin storage. 275 passing tests.

### Sprint 4 — "Plugins: UI" (completed)

**Goal**: Plugins can extend the UI. Sidebar panels, custom views, status bar items, settings tabs, command palette integration, plugin store, and a built-in Pomodoro plugin.

| ID | Item | Status |
|----|------|--------|
| PL-08 | Plugin UI extension: sidebar panels | done |
| PL-09 | Plugin UI extension: custom views | done |
| PL-10 | Plugin UI extension: status bar | done |
| PL-11 | Plugin commands integration with command palette | done |
| PL-12 | Plugin settings UI in Settings view | done |
| PL-13 | Plugin store view (browse sources.json) | done |
| PL-18 | Built-in Pomodoro plugin (fully functional) | done |

**Result**: Full plugin UI integration with sidebar panels, custom views, status bar, command palette, and settings. Built-in Pomodoro plugin with timer and configurable durations. 297 passing tests.

### Sprint 5 — "AI: Foundation" (completed)

**Goal**: AI assistant foundation. Provider abstraction with 5 implementations, streaming chat via SSE, tool calling for task CRUD, chat panel UI, and provider settings.

| ID | Item | Status |
|----|------|--------|
| AI-01 | AI type definitions (ChatMessage, ToolCall, etc.) | done |
| AI-02 | AIProvider interface + factory function | done |
| AI-03 | OpenAI provider implementation | done |
| AI-04 | Anthropic provider implementation | done |
| AI-05 | OpenRouter/Ollama/LM Studio provider wrappers | done |
| AI-06 | Tool definitions + execution (task CRUD) | done |
| AI-07 | Chat session + manager | done |
| AI-08 | Server API endpoints (SSE streaming) | done |
| AI-09 | Frontend API + AIContext | done |
| AI-10 | Chat panel UI component | done |
| AI-11 | Provider settings UI | done |
| AI-12 | AI provider/tools/chat tests | done |

**Result**: 14 new files, 8 modified files. Full AI assistant with 5 provider implementations, SSE streaming, task CRUD tools, chat panel, and provider settings. 321 passing tests.

### Sprint 6 — "AI: Intelligence" (completed)

**Goal**: Make the AI smarter. Rich context injection (task counts, overdue items, projects), chat persistence to SQLite, enhanced system prompt (follow-up questions, daily planning, priority suggestions), voice input via Browser Speech API, and UI enhancements (tool call badges, suggestion chips, chat restoration).

| ID | Item | Status |
|----|------|--------|
| AI-13 | Rich context injection in system message | done |
| AI-14 | Chat history persistence (SQLite) | done |
| AI-15 | Enhanced AI system prompt (follow-ups, planning) | done |
| AI-16 | Voice input via Browser Speech API | done |
| AI-17 | Tool call badges in chat UI | done |
| AI-18 | Suggestion chips for quick actions | done |
| AI-19 | Chat restoration from DB on page load | done |
| AI-20 | Server endpoints for persistence + context | done |
| AI-21 | Chat persistence + context tests | done |

**Result**: 2 new files, 5 modified files. AI assistant now has live task context, persistent chat history, voice input, enhanced UX with tool call badges and suggestion chips. 333 passing tests.

### Sprint 7 — "CI/CD & Release" (completed)

**Goal**: Every push/PR runs automated lint, format check, typecheck, and tests via GitHub Actions. Code style is enforced consistently with ESLint 9 flat config and Prettier.

| ID | Item | Status |
|----|------|--------|
| F-05 | CI/CD pipeline (GitHub Actions: lint, format, typecheck, test) | done |
| F-06 | ESLint 9 flat config (TS + React hooks/refresh + Prettier) | done |
| F-07 | Prettier config (.prettierrc + .prettierignore) | done |

**Result**: 4 new files (eslint.config.js, .prettierrc, .prettierignore, .github/workflows/ci.yml), codebase-wide formatting normalization, lint violation fixes. 333 passing tests.

### Sprint 8 — "Styling & Desktop App" (completed)

**Goal**: Fix Tailwind CSS styling and build a full Tauri v2 desktop application with sql.js WASM backend running in the WebView.

| ID | Item | Status |
|----|------|--------|
| F-08 | Fix Tailwind CSS (@tailwindcss/vite plugin + theme imports) | done |
| F-09 | Tauri v2 scaffold (Cargo.toml, main.rs, tauri.conf.json, icons, capabilities) | done |
| D-09 | Generalize DB layer (BaseSQLiteDatabase for better-sqlite3 + sql.js) | done |
| D-10 | sql.js WebView client + bundled migration runner | done |
| D-11 | Tauri FS persistence (load/save SQLite file to AppData) | done |
| F-10 | Browser-compatible bootstrap (bootstrap-web.ts with debounced auto-save) | done |
| F-11 | isTauri() API branching (all 20 endpoints branch between HTTP and direct calls) | done |
| F-12 | Vite build config (conditional apiPlugin, external better-sqlite3, sql.js WASM) | done |

**Result**: 6 new files, 4 modified files, full `src-tauri/` scaffold. Tailwind styling works. Tauri desktop app launches with native window. Production build uses sql.js in WebView with Tauri FS persistence. 333 passing tests.

### Sprint 9 — "Power User" (completed)

**Goal**: Bulk operations, plugin permissions, AI BYOM (Bring Your Own Model), data export, keyboard shortcut customization, undo/redo, and drag-and-drop reordering. Closes most of v0.2 (Polish) and v0.5 (Plugin System).

| ID | Item | Status |
|----|------|--------|
| C-13 | Bulk operations (multi-select + complete/move/tag/delete) | done |
| U-16 | Drag-and-drop task reordering (@dnd-kit/core + sortable) | done |
| U-17 | Undo/redo for task operations (UndoManager + Ctrl+Z) | done |
| PL-15 | Plugin permission approval UX | done |
| A-17 | Custom AI provider plugin support (BYOM) | done |
| D-07 | Data export (JSON, Markdown, CSV) | done |
| — | Keyboard shortcut customization | done |

**Result**: Bulk ops with multi-select toolbar, drag-and-drop via @dnd-kit, undo/redo with keyboard shortcuts, plugin permission grants, AI BYOM via ai:provider permission, data export in 3 formats. 387 passing tests.

### Sprint 10 — "Milestone Closure" (completed)

**Goal**: Close v0.2 (Polish) and v0.5 (Plugin System) milestones. Data import from Docket JSON / Todoist JSON / Markdown, custom CSS themes with live editor, and plugin install/uninstall from store.

| ID | Item | Status |
|----|------|--------|
| D-08 | Data import (Docket JSON, Todoist JSON, Markdown) | done |
| — | Custom CSS themes (18 CSS variables, inline editor, live preview) | done |
| PL-14 | Plugin install/uninstall from store (tar.gz download + extract) | done |

**Result**: 3 new files, 10+ modified files. Import with preview + auto-detection, custom themes with grouped color pickers and live preview, plugin install/uninstall with search and loading states. 424 passing tests.
