# ASF Junban — Development Guide

## What Is This

**Build the task manager you've always wanted.**

ASF Junban is an open-source, AI-native task manager with an Obsidian-style plugin system. Built by the **AI Strategic Forum (ASF)** community. **Simple. Smart. Yours.**

It's the task manager that doesn't exist yet — beautiful and simple out of the box, with a real AI assistant (not a gimmick), and a plugin system so simple that anyone can build features through AI-generated code. No coding experience required.

This is the second ASF project, alongside [ASF Sentinel](https://github.com/ASF-GROUP/sentinel) (a Discord bot for AI news curation).

## ASF Values (MUST Follow)

- **Accuracy > Speed** — get it right, not just first
- **Sources > Vibes** — always cite, always link
- **Disclosure > Persuasion** — be transparent
- **Label speculation** — if it's a guess, say so
- **No hidden promotion** — disclose affiliations

## Core Principles

1. **Local-first, private by default** — data lives on the user's machine. Zero network calls by default. No accounts, no telemetry, no analytics.
2. **AI-native, not AI-bolted-on** — the AI assistant is a core part of the experience: conversational sidebar, voice input, BYOM (Bring Your Own Model). But completely optional — Junban works perfectly without AI.
3. **Vibe-code extensible** — the plugin API is designed so anyone can ask Claude or ChatGPT to build a plugin. If the API is too complicated for AI to generate correct code, it's too complicated.
4. **Minimal by default, powerful when needed** — clean UI out of the box. The app is a canvas — plugins paint the picture.
5. **Open source (MIT), honest business model** — free forever. Revenue from optional paid sync hosting (Junban Sync), not dark patterns.
6. **No vendor lock-in** — SQLite or Markdown files. Export anytime. Switching away should be trivial.

## Tech Stack

| Component       | Choice                        | Why                                                                  |
| --------------- | ----------------------------- | -------------------------------------------------------------------- |
| Runtime         | Node.js 22+ / TypeScript      | Type safety, ecosystem                                               |
| Desktop         | Tauri                         | Cross-platform, small binary (~5MB vs Electron ~150MB)               |
| Frontend        | React + Tailwind CSS          | Fast, huge ecosystem                                                 |
| Local DB        | SQLite (better-sqlite3)       | Local-first, portable, zero config                                   |
| ORM             | Drizzle                       | Type-safe, lightweight, SQL-close                                    |
| AI              | Pluggable providers           | OpenAI, Anthropic, OpenRouter, Ollama, LM Studio — or build your own |
| Plugin Runtime  | Custom loader with sandboxing | Obsidian-style, controlled execution                                 |
| MCP             | @modelcontextprotocol/sdk     | External AI agent bridge (Claude Desktop, custom agents)             |
| CLI             | Commander.js                  | Companion CLI tool                                                   |
| NLP             | chrono-node                   | Natural language date/time parsing                                   |
| Testing         | Vitest                        | Fast, ESM native                                                     |
| Build           | Vite                          | Fast bundling                                                        |
| Package Manager | pnpm                          | Fast, disk-efficient                                                 |
| Validation      | Zod                           | Runtime type checking                                                |

## Project Structure

```
src/
├── main.ts                  # Entry point — wires everything together
├── bootstrap.ts             # Node.js service wiring
├── bootstrap-web.ts         # Browser/WebView service wiring
├── config/                  # Configuration & environment (3 files)
│   ├── env.ts               # Zod-validated env vars
│   ├── defaults.ts          # Default settings and constants
│   └── themes.ts            # Built-in theme definitions
├── db/                      # Database layer (7 files + 9 migrations)
│   ├── schema.ts            # Drizzle schema definitions (14 tables)
│   ├── client.ts            # SQLite connection (Node.js / better-sqlite3)
│   ├── client-web.ts        # SQLite connection (browser / sql.js WASM)
│   ├── migrate.ts           # Migration runner (Node.js)
│   ├── migrate-web.ts       # Migration runner (browser)
│   ├── persistence.ts       # OPFS persistence for browser SQLite
│   ├── queries.ts           # Query helpers (CRUD for tasks, projects, tags)
│   └── migrations/          # 9 SQL migration files
├── storage/                 # Storage abstraction layer (4 files)
│   ├── interface.ts         # IStorage interface + row types
│   ├── sqlite-backend.ts    # SQLite implementation via Drizzle
│   ├── markdown-backend.ts  # Markdown files with YAML frontmatter
│   └── markdown-utils.ts    # YAML parsing/formatting helpers
├── core/                    # Core task management logic (19 files)
│   ├── tasks.ts             # Task CRUD operations
│   ├── projects.ts          # Project management
│   ├── tags.ts              # Tag system
│   ├── sections.ts          # Project sections
│   ├── stats.ts             # Productivity statistics
│   ├── templates.ts         # Task templates
│   ├── priorities.ts        # Priority levels and sorting
│   ├── recurrence.ts        # Recurring task logic
│   ├── filters.ts           # Task filtering and search
│   ├── query-parser.ts      # Natural language query → TaskFilter
│   ├── nudges.ts            # Contextual nudge suggestions
│   ├── timer.ts             # In-memory timer (start/stop, format, parse estimates)
│   ├── export.ts            # Data export (JSON, CSV, Markdown)
│   ├── import.ts            # Data import (Todoist, plain text)
│   ├── event-bus.ts         # Internal event system
│   ├── undo.ts              # Undo/redo stack
│   ├── actions.ts           # Action definitions for undo
│   ├── errors.ts            # NotFoundError, ValidationError, StorageError
│   └── types.ts             # Core type definitions (Zod + TS)
├── parser/                  # Natural language parsing (3 files)
│   ├── nlp.ts               # Date/time extraction (chrono-node)
│   ├── task-parser.ts       # Full task string parser
│   └── grammar.ts           # Grammar rules for task input
├── mcp/                     # MCP server — external AI agent bridge (7 files)
│   ├── server.ts            # Entry point — bootstrap + stdio transport
│   ├── tools.ts             # Bridges ToolRegistry → MCP tools
│   ├── resources.ts         # Read-only resources (tasks, projects, tags, stats)
│   ├── prompts.ts           # Pre-built prompts (plan-my-day, daily-review, quick-capture)
│   ├── schema-converter.ts  # JSON Schema → Zod converter
│   ├── context.ts           # ToolContext factory
│   └── errors.ts            # Error mapping to MCP responses
├── plugins/                 # Plugin system (11 files + builtin/)
│   ├── loader.ts            # Plugin discovery and loading
│   ├── lifecycle.ts         # Plugin lifecycle management
│   ├── api.ts               # Plugin API surface (what plugins can access)
│   ├── sandbox.ts           # Sandboxed execution environment
│   ├── registry.ts          # Community plugin registry client
│   ├── installer.ts         # Plugin install/uninstall
│   ├── settings.ts          # Per-plugin settings storage
│   ├── command-registry.ts  # Plugin command registration
│   ├── ui-registry.ts       # Plugin UI panel/view registration
│   ├── types.ts             # Plugin manifest and API types
│   └── builtin/             # Built-in plugins
│       ├── pomodoro/        # Pomodoro timer plugin
│       └── timeblocking/    # Timeblocking plugin (day/week views, auto-scheduler, DnD)
├── ai/                      # AI assistant layer (45 files)
│   ├── chat.ts              # Chat session management
│   ├── provider.ts          # Provider setup + default registries
│   ├── model-discovery.ts   # Dynamic model list fetching
│   ├── errors.ts            # AI error classification
│   ├── types.ts             # AI type definitions
│   ├── core/                # Pipeline architecture (4 files)
│   │   ├── pipeline.ts      # LLMPipeline — orchestrates execution
│   │   ├── middleware.ts     # Middleware chain (retry, timeout)
│   │   ├── context.ts       # Execution context
│   │   └── capabilities.ts  # Provider capability detection
│   ├── provider/            # Provider abstraction (8 files)
│   │   ├── interface.ts     # LLMProviderPlugin interface
│   │   ├── registry.ts      # Provider registry
│   │   └── adapters/        # 6 adapters: openai, anthropic, openrouter, ollama, lmstudio, openai-compat
│   ├── tools/               # Tool system (20 files)
│   │   ├── registry.ts      # ToolRegistry
│   │   ├── types.ts         # Tool type definitions
│   │   └── builtin/         # 18 tool files: task-crud, project-crud, tag-crud, reminder-tools,
│   │                        #   query-tasks, daily-planning, task-breakdown, analyze-patterns,
│   │                        #   analyze-workload, smart-organize, energy-recommendations,
│   │                        #   productivity-stats, bulk-operations, memory-tools,
│   │                        #   time-estimation, weekly-review, extract-tasks-from-text, auto-schedule
│   └── voice/               # Voice I/O (14 files)
│       ├── interface.ts     # STT/TTS provider interfaces
│       ├── registry.ts      # Voice provider registry
│       ├── provider.ts      # Default voice registry setup
│       ├── audio-utils.ts   # Audio format conversion
│       ├── adapters/        # 8 adapters: browser-stt, browser-tts, groq-stt, groq-tts,
│       │                    #   inworld-tts, kokoro-local-tts, piper-local-tts, whisper-local-stt
│       └── workers/         # 2 Web Workers: kokoro.worker.ts, kokoro-worker-types.ts
├── server.ts                # Hono API server entry point (standalone backend)
├── api/                     # API route modules for Hono server (11 files)
│   ├── tasks.ts, projects.ts, tags.ts, sections.ts, comments.ts
│   ├── templates.ts, settings.ts, stats.ts, plugins.ts
│   ├── ai.ts                # AI chat streaming + config
│   └── voice.ts             # STT/TTS proxy endpoints
├── ui/                      # React frontend (~140 files)
│   ├── App.tsx              # Root React component
│   ├── main.tsx             # React entry point
│   ├── index.css            # Global styles
│   ├── shortcuts.ts         # Shortcut definitions
│   ├── shortcutManagerInstance.ts  # Singleton ShortcutManager
│   ├── api/                 # Frontend API layer (11 files)
│   │   ├── index.ts         # API entry point
│   │   ├── helpers.ts       # handleResponse, handleVoidResponse
│   │   ├── tasks.ts         # Task API calls
│   │   ├── projects.ts      # Project API calls
│   │   ├── sections.ts      # Section API calls
│   │   ├── comments.ts      # Comment API calls
│   │   ├── templates.ts     # Template API calls
│   │   ├── plugins.ts       # Plugin API calls
│   │   ├── settings.ts      # Settings API calls
│   │   ├── stats.ts         # Stats API calls
│   │   └── ai.ts            # AI chat API calls
│   ├── components/          # Reusable UI components (~52 files + 11 chat/)
│   │   ├── TaskItem.tsx, TaskInput.tsx, TaskList.tsx, TaskDetailPanel.tsx
│   │   ├── Sidebar.tsx, CommandPalette.tsx, SearchModal.tsx
│   │   ├── AIChatPanel.tsx, VoiceCallOverlay.tsx, DailyPlanningModal.tsx
│   │   ├── DreadLevelSelector.tsx, EatTheFrog.tsx, TaskJar.tsx
│   │   ├── WeeklyReviewModal.tsx, ExtractTasksModal.tsx
│   │   ├── AnimatedPresence.tsx, CompletionBurst.tsx
│   │   ├── chat/            # Chat sub-components (11 files)
│   │   └── ... (BottomNavBar, FAB, MobileDrawer, DatePicker, etc.)
│   ├── context/             # React contexts (9 files + ai/ subdirectory)
│   │   ├── AIContext.tsx     # AI context facade (composes 3 granular contexts)
│   │   ├── ai/              # Split AI contexts: AIConfigContext, AIChatContext, AISessionContext
│   │   ├── AppStateContext.tsx  # Read-only app state (reduces prop drilling)
│   │   ├── TaskContext.tsx, PluginContext.tsx
│   │   ├── VoiceContext.tsx, SettingsContext.tsx, UndoContext.tsx
│   │   └── BlockedTaskIdsContext.tsx
│   ├── hooks/               # Custom hooks (17 files)
│   │   ├── useRouting.ts, useTaskHandlers.ts, useBulkActions.ts
│   │   ├── useKeyboardNavigation.ts, useAppCommands.ts, useAppShortcuts.ts
│   │   ├── useReminders.ts, useNudges.ts, useSoundEffect.ts, useVoiceCall.ts
│   │   ├── useVAD.ts, useIsMobile.ts, useMultiSelect.ts
│   │   ├── useGlobalShortcut.ts, useQuickCaptureWindow.ts, useClickOutside.ts
│   │   └── useFocusTrap.ts
│   ├── views/               # Application views (19 + calendar/ + settings/)
│   │   ├── Inbox.tsx, Today.tsx, Upcoming.tsx, Project.tsx
│   │   ├── Board.tsx, Calendar.tsx, Matrix.tsx, Stats.tsx
│   │   ├── Completed.tsx, Cancelled.tsx, Someday.tsx
│   │   ├── Settings.tsx, TaskPage.tsx, AIChat.tsx
│   │   ├── FiltersLabels.tsx, FilterView.tsx, PluginView.tsx
│   │   ├── DopamineMenu.tsx, QuickCapture.tsx
│   │   ├── calendar/        # Calendar sub-views (3 files)
│   │   └── settings/        # Settings tabs (10 tabs + components.tsx)
│   └── themes/              # Theme system (4 files)
│       ├── manager.ts       # Theme loading and switching
│       ├── light.css        # Default light theme (design tokens)
│       ├── dark.css         # Default dark theme
│       └── nord.css         # Nord theme
├── cli/                     # CLI companion tool (7 files)
│   ├── index.ts             # CLI entry point (Commander.js)
│   ├── formatter.ts         # Terminal output formatting
│   └── commands/            # 5 commands: add, list, done, edit, delete
└── utils/                   # Shared utilities (7 files)
    ├── logger.ts            # Structured logger
    ├── ids.ts               # ID generation (nanoid)
    ├── dates.ts             # Date utilities
    ├── format-date.ts       # User-facing date/time formatting
    ├── sounds.ts            # Web Audio API sound effects
    ├── color.ts             # Color manipulation
    └── tauri.ts             # Tauri detection helper
```

## Development Conventions

### Branching

- `main` — stable, deployable
- `feat/<name>` — new features
- `fix/<name>` — bug fixes
- `docs/<name>` — documentation only
- `plugin/<name>` — plugin system changes

### Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(core): add recurring task support
fix(parser): handle "next Monday" edge case in NLP
docs(plugin): add settings API documentation
test(core): add edge cases for priority sorting
plugin(loader): implement sandbox isolation
```

### Code Style

- TypeScript strict mode enabled
- ESLint + Prettier enforced
- No `any` types (warn level — avoid)
- Named exports preferred
- Errors are handled, not swallowed
- All public functions have JSDoc for complex logic
- React components use function syntax (not class)
- Tailwind for styling — no inline styles, no CSS modules

### Testing

- Tests in `tests/` mirror `src/` structure
- Unit tests for pure logic (task CRUD, parsing, filtering, plugin lifecycle)
- Component tests for critical UI flows
- Run: `pnpm test` (vitest)
- Coverage: `pnpm test:coverage`

### Running

```bash
pnpm dev           # Dev mode (Vite dev server with HMR, in-browser SQLite)
pnpm dev:full      # Full dev mode (Vite + Hono API server, shared ./data/junban.db)
pnpm server        # Standalone API server on port 4822
pnpm build         # Build for production
pnpm start         # Preview production build
pnpm check         # Lint + format check + typecheck + test
pnpm cli           # Run CLI companion
pnpm mcp           # Start MCP server (for external AI agents)
```

## Architecture Decisions

### Local-First Storage

Two storage backends, selected by `STORAGE_MODE` env var:

- **SQLite** (default): better-sqlite3 + Drizzle ORM. Faster queries, structured data, supports complex filters.
- **Markdown**: Flat `.md` files with YAML frontmatter. Human-readable, git-friendly, portable.

Both backends implement the same interface. The user chooses; the app doesn't care.

### AI Assistant

The AI assistant is a conversational interface that lives in the sidebar:

- **Provider abstraction**: All AI providers implement a common interface. Swapping providers is one config change.
- **BYOM (Bring Your Own Model)**: OpenAI, Anthropic, OpenRouter, Ollama, LM Studio — or build a custom provider plugin.
- **Tool use**: The AI can read/write tasks, manage projects, suggest priorities, auto-schedule. Tools are defined in `src/ai/tools.ts`.
- **Voice input**: Speech-to-text feeds into the same chat interface. The AI parses natural language into structured tasks.
- **Context-aware**: The AI sees the user's task list, projects, priorities, and schedule to give relevant suggestions.
- **Fully optional**: Zero AI code runs unless the user configures a provider. No API keys required for core functionality.

### Plugin System (API v2.0.0)

```
Plugin Discovery → Manifest Validation → Sandbox Creation → Lifecycle Hooks
```

- Plugins are directories in `plugins/` with a `manifest.json` and entry file
- Manifests declare: id, name, version, author, description, minJunbanVersion, permissions
- Plugins run in a sandboxed context with access only to the Plugin API
- Lifecycle: `onLoad()` → active → `onUnload()`. Plugins can also hook into task events.
- **Full CRUD APIs**: tasks (list/get/create/update/complete/uncomplete/delete), projects (list/get/create/update/delete), tags (list/create/delete)
- **15 permissions**: task:read, task:write, project:read, project:write, tag:read, tag:write, ui:panel, ui:view, ui:status, commands, settings, storage, network, ai:provider, ai:tools
- **Clear error model**: all API methods always exist. Calling without permission throws with a message telling exactly which permission to add to manifest.json. No optional chaining needed.
- Plugins can: register commands, add sidebar panels, add views, add settings tabs, listen to task events, register AI tools/providers
- Plugin settings stored in SQLite (or JSON file in Markdown mode), keyed by plugin ID
- **Vibe-code friendly**: The API is designed so AI (Claude/ChatGPT) can generate working plugins. If the API is too complex for AI to produce correct code, it's too complex.

### State Management

- React state for UI (useState/useReducer for local, context for shared)
- SQLite as the source of truth — UI reads from DB, writes go through core module
- No external state library (Redux, Zustand) unless complexity demands it later
- Plugin state isolated per-plugin

### Natural Language Parsing

- `chrono-node` for date/time extraction
- Custom grammar layer on top for task-specific syntax: priorities (`p1`-`p4`), tags (`#tag`), projects (`+project`)
- Parser returns structured `ParsedTask` with all extracted fields

### Error Philosophy

- Parse errors: show inline feedback, don't block input
- Storage errors: surface to user (these are critical)
- Plugin errors: isolate and disable the plugin, don't crash the app
- AI errors: degrade gracefully — if the provider fails, the app works fine without AI
- Network errors (registry, sync): retry with backoff, degrade gracefully

## Key Files

| File                              | Purpose                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `src/config/env.ts`               | All env var definitions with Zod validation                |
| `src/db/schema.ts`                | Database schema (source of truth for tables)               |
| `src/storage/interface.ts`        | IStorage interface — storage abstraction for both backends |
| `src/core/tasks.ts`               | Task CRUD — the heart of the app                           |
| `src/core/types.ts`               | Core type definitions (Task, Project, Tag, etc.)           |
| `src/parser/task-parser.ts`       | Natural language task input parser                         |
| `src/ai/provider.ts`              | AI provider setup + default registries                     |
| `src/ai/tools/registry.ts`        | AI tool registry (42 tools)                                |
| `src/ai/voice/interface.ts`       | STT/TTS provider interfaces                                |
| `src/plugins/loader.ts`           | Plugin discovery and loading                               |
| `src/plugins/api.ts`              | Plugin API surface — what plugins can do                   |
| `src/plugins/sandbox.ts`          | Plugin execution sandbox                                   |
| `src/ui/App.tsx`                  | Root React component                                       |
| `src/ui/components/TaskInput.tsx` | The main task input field                                  |
| `src/mcp/server.ts`               | MCP server entry point (external agent bridge)             |
| `src/cli/index.ts`                | CLI entry point                                            |
| `sources.json`                    | Community plugin registry seed                             |

## Common Tasks

### Add a task field

1. Add the field to `src/core/types.ts` (Zod schema + TS type)
2. Add the column to `src/db/schema.ts`
3. Generate migration: `pnpm db:generate`
4. Update CRUD in `src/core/tasks.ts`
5. Update the parser in `src/parser/task-parser.ts` if the field is parseable from natural language
6. Update `TaskItem.tsx` to display the field
7. Update CLI `list` and `add` commands if applicable

### Create a plugin

1. Create a directory in `plugins/<plugin-name>/`
2. Add `manifest.json` with required fields (id, name, version, author, description, main)
3. Create entry file (e.g., `index.ts`) that exports a class extending `Plugin`
4. Implement `onLoad()` and `onUnload()` lifecycle hooks
5. See [docs/plugins/API.md](docs/plugins/API.md) for the full API reference

### Add a UI view

1. Create component in `src/ui/views/<ViewName>.tsx`
2. Add route/navigation entry in `src/ui/App.tsx`
3. Add sidebar link in `src/ui/components/Sidebar.tsx`

### Add a CLI command

1. Create handler in `src/cli/commands/<name>.ts`
2. Register with Commander in `src/cli/index.ts`
3. Use shared core logic from `src/core/` — CLI and UI share the same backend

### Modify the database schema

1. Edit `src/db/schema.ts`
2. Run `pnpm db:generate` to create a migration
3. Run `pnpm db:migrate` to apply it
4. Update queries in `src/db/queries.ts`

### Add a keyboard shortcut

1. Define the command in the command registry
2. Add default keybinding in `src/ui/components/CommandPalette.tsx`
3. Commands are also available to plugins via the Plugin API

## Documentation

- Start with [docs/README.md](docs/README.md) for the canonical documentation index and maintenance policy.
- Use [AGENTS.md](AGENTS.md) for AI-agent task routing.
