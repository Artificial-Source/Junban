# Architecture

## Overview

Saydo is a modular TypeScript app with clear separation between core logic, storage, AI, UI, plugins, and CLI. Each layer is isolated and testable.

```
src/
├── main.ts                  # Tauri/web entry point
├── bootstrap.ts             # Desktop app initialization (branches on STORAGE_MODE)
├── bootstrap-web.ts         # Web/Tauri WebView initialization (always SQLite via sql.js)
│
├── config/                  # Configuration
│   ├── env.ts               # Zod-validated env vars
│   ├── defaults.ts          # Default settings and constants
│   └── themes.ts            # Built-in theme definitions
│
├── db/                      # Database layer
│   ├── schema.ts            # Drizzle schema (tasks, projects, tags, task_tags, templates, chat, plugin_settings)
│   ├── client.ts            # better-sqlite3 connection (Node/desktop)
│   ├── client-web.ts        # sql.js WASM connection (browser/Tauri WebView)
│   ├── queries.ts           # Query helpers (CRUD)
│   ├── migrate.ts           # Migration runner (Node)
│   ├── migrate-web.ts       # Migration runner (WebView, bundled SQL)
│   ├── persistence.ts       # Tauri FS persistence (load/save SQLite to AppData)
│   └── migrations/          # SQL migrations (0001-0004)
│
├── storage/                 # Storage abstraction
│   ├── interface.ts         # IStorage — common API for both backends
│   ├── sqlite-backend.ts    # SQLite implementation (wraps queries.ts)
│   ├── markdown-backend.ts  # Markdown YAML implementation (in-memory indexes, disk writes)
│   └── markdown-utils.ts    # File utilities for Markdown backend
│
├── core/                    # Business logic (no I/O, takes IStorage)
│   ├── tasks.ts             # TaskService — CRUD, subtasks, cascade complete
│   ├── projects.ts          # ProjectService
│   ├── tags.ts              # TagService
│   ├── templates.ts         # TemplateService — {{variable}} substitution
│   ├── priorities.ts        # Priority levels and sorting
│   ├── recurrence.ts        # Recurring task logic
│   ├── filters.ts           # Task filtering
│   ├── query-parser.ts      # Natural language query → TaskFilter
│   ├── actions.ts           # Bulk operations (multi-select)
│   ├── export.ts            # Export to JSON/CSV/Markdown
│   ├── import.ts            # Import from Todoist/Markdown/JSON
│   ├── event-bus.ts         # Plugin lifecycle event dispatch
│   ├── undo.ts              # Undo/redo stack
│   ├── errors.ts            # NotFoundError, ValidationError, StorageError
│   └── types.ts             # Zod schemas + TypeScript types
│
├── parser/                  # Natural language parsing
│   ├── nlp.ts               # Date/time extraction (chrono-node)
│   ├── task-parser.ts       # Full task string parser ("buy milk p1 #groceries tomorrow")
│   └── grammar.ts           # Grammar rules (priorities, tags, projects, recurrence, duration, deadline, someday)
│
├── ai/                      # AI layer
│   ├── provider.ts          # LLMProviderPlugin interface
│   ├── types.ts             # ChatMessage, ToolCall, etc.
│   ├── errors.ts            # AIError class, classifyProviderError
│   ├── chat.ts              # Chat session management, streaming, persistence
│   ├── model-discovery.ts   # Dynamic model fetching from provider APIs
│   │
│   ├── core/                # Pipeline and execution
│   │   ├── pipeline.ts      # LLMPipeline — input → context → provider → tools → response
│   │   ├── executor.ts      # LLMExecutor — runs tool calls
│   │   ├── capabilities.ts  # Provider capability declarations
│   │   └── middleware.ts     # Error handling, logging middleware
│   │
│   ├── provider/            # LLM provider implementations
│   │   ├── registry.ts      # createDefaultRegistry() — provider factory
│   │   └── adapters/        # 6 adapters: openai, anthropic, openrouter, ollama, lmstudio, openai-compat
│   │
│   ├── tools/               # AI tool system
│   │   ├── registry.ts      # ToolRegistry + createDefaultToolRegistry()
│   │   └── builtin/         # 25 tools total
│   │       ├── task-crud.ts           # Create/read/update/complete/delete tasks
│   │       ├── query-tasks.ts         # Search and filter tasks
│   │       ├── project-crud.ts        # Create/list/get/update/delete projects
│   │       ├── reminder-tools.ts      # List/set/snooze/dismiss reminders
│   │       ├── tag-crud.ts            # List/add/remove tags on tasks
│   │       ├── task-breakdown.ts      # Break down task into subtasks
│   │       ├── analyze-patterns.ts    # Workload pattern analysis
│   │       ├── analyze-workload.ts    # Task load, capacity, overcommitment
│   │       ├── smart-organize.ts      # Auto-tagging, prioritization, duplicate detection
│   │       └── energy-recommendations.ts  # Focus time and energy suggestions
│   │
│   └── voice/               # Voice I/O
│       ├── interface.ts     # STTProviderPlugin, TTSProviderPlugin
│       ├── registry.ts      # VoiceProviderRegistry
│       ├── provider.ts      # Voice provider factory
│       ├── audio-utils.ts   # WAV encoding, sample rate conversion
│       └── adapters/        # STT: browser, groq, whisper-local | TTS: browser, groq, kokoro-local, piper-local, inworld
│
├── plugins/                 # Plugin system
│   ├── loader.ts            # Discovery, validation, loading
│   ├── lifecycle.ts         # onLoad/onUnload hooks
│   ├── api.ts               # Plugin API surface (filtered by permissions)
│   ├── sandbox.ts           # Sandboxed execution context
│   ├── registry.ts          # Community plugin registry client
│   ├── installer.ts         # Install/uninstall from plugin store
│   ├── settings.ts          # Per-plugin settings storage
│   ├── command-registry.ts  # Command system (palette integration)
│   ├── ui-registry.ts       # UI extension points (panels, views, status bar)
│   └── types.ts             # Plugin manifest schema (Zod)
│
├── ui/                      # React frontend
│   ├── App.tsx              # Root component — routing, layout, keyboard nav, context menu, max-w-7xl constraint
│   ├── main.tsx             # React entry point, theme init
│   ├── index.css            # Global styles
│   ├── shortcuts.ts         # Keyboard shortcut definitions
│   │
│   ├── api/                 # Frontend API layer
│   │   ├── index.ts         # API entry point
│   │   ├── helpers.ts       # handleResponse<T>, handleVoidResponse
│   │   ├── tasks.ts         # /api/tasks/*
│   │   ├── projects.ts      # /api/projects/*
│   │   ├── templates.ts     # /api/templates/*
│   │   ├── ai.ts            # /api/ai/*
│   │   ├── plugins.ts       # /api/plugins/*
│   │   └── settings.ts      # /api/settings/*
│   │
│   ├── context/             # React context
│   │   ├── UndoContext.tsx   # Undo/redo state
│   │   ├── AIContext.tsx     # AI chat state, streaming, voice call mode, data mutation tracking
│   │   ├── VoiceContext.tsx  # Voice settings, STT/TTS providers, speak/cancel
│   │   └── SettingsContext.tsx # General settings (accent color, density, date format, etc.)
│   │
│   ├── hooks/               # Custom hooks
│   │   ├── useKeyboardNavigation.ts
│   │   ├── useMultiSelect.ts
│   │   ├── useVAD.ts        # Voice activity detection
│   │   ├── useVoiceCall.ts  # Voice call state machine (idle→greeting→listening→processing→speaking)
│   │   ├── useIsMobile.ts   # Mobile breakpoint detection
│   │   └── useSoundEffect.ts # Sound effect playback tied to settings
│   │
│   ├── components/          # ~30 UI components
│   │   ├── TaskInput.tsx         # NLP-driven task creation with inline preview
│   │   ├── TaskItem.tsx          # Single task row (priority stripe, tag pills, indent)
│   │   ├── TaskList.tsx          # Tree rendering with expand/collapse
│   │   ├── TaskDetailPanel.tsx   # Slide-over editor (auto-save on blur)
│   │   ├── TaskMetadataSidebar.tsx
│   │   ├── SubtaskBlock.tsx      # Sub-task display
│   │   ├── SubtaskSection.tsx    # Sub-task list within detail panel
│   │   ├── InlineAddSubtask.tsx  # Inline sub-task creation
│   │   ├── Sidebar.tsx           # Navigation + project list + search button
│   │   ├── CommandPalette.tsx    # Ctrl+K with arrow nav
│   │   ├── SearchModal.tsx       # Ctrl+F global task search with fuzzy matching
│   │   ├── FocusMode.tsx         # Full-screen overlay (Space/N/P/Esc)
│   │   ├── QueryBar.tsx          # NL search with debounced filtering
│   │   ├── AIChatPanel.tsx       # AI sidebar chat + voice call UI
│   │   ├── VoiceCallOverlay.tsx  # Voice call in-call UI (pulsing indicator, timer)
│   │   ├── ContextMenu.tsx       # Right-click context menu (Edit, Complete, Priority, Move, Delete)
│   │   ├── ConfirmDialog.tsx     # Styled confirmation dialog (replaces window.confirm)
│   │   ├── BulkActionBar.tsx     # Multi-select toolbar
│   │   ├── TemplateSelector.tsx  # Template picker modal
│   │   ├── BottomNavBar.tsx      # Mobile bottom navigation
│   │   ├── MobileDrawer.tsx      # Mobile slide-out drawer
│   │   ├── FAB.tsx               # Mobile floating action button
│   │   ├── DatePicker.tsx
│   │   ├── RecurrencePicker.tsx
│   │   ├── TagsInput.tsx
│   │   ├── RightActionRail.tsx
│   │   ├── StatusBar.tsx         # Plugin-extensible status bar
│   │   ├── PluginPanel.tsx
│   │   ├── PermissionDialog.tsx  # Plugin permission approval
│   │   ├── Toast.tsx
│   │   └── ErrorBoundary.tsx
│   │
│   ├── views/               # Main views
│   │   ├── Inbox.tsx        # All unscheduled tasks + QueryBar
│   │   ├── Today.tsx        # Tasks due today
│   │   ├── Upcoming.tsx     # Tasks grouped by due date
│   │   ├── Project.tsx      # Single project view
│   │   ├── Completed.tsx    # Historical view
│   │   ├── TaskPage.tsx     # Single task page
│   │   ├── FiltersLabels.tsx
│   │   ├── PluginStore.tsx  # Browse/install community plugins
│   │   ├── PluginView.tsx   # Plugin-provided custom views
│   │   └── Settings.tsx     # 8-tab settings
│   │       └── settings/    # Tab components
│   │           ├── GeneralTab.tsx
│   │           ├── AITab.tsx
│   │           ├── VoiceTab.tsx
│   │           ├── PluginsTab.tsx
│   │           ├── TemplatesTab.tsx
│   │           ├── KeyboardTab.tsx
│   │           ├── DataTab.tsx
│   │           └── AboutTab.tsx
│   │
│   └── themes/
│       ├── manager.ts       # ThemeManager (localStorage persistence)
│       ├── light.css        # Tailwind 4 @theme tokens
│       └── dark.css         # Tailwind 4 @theme tokens
│
├── mcp/                     # MCP server (external AI agent bridge)
│   ├── server.ts            # Entry point (bootstrap + stdio transport)
│   ├── tools.ts             # Registers ToolRegistry tools as MCP tools
│   ├── resources.ts         # Read-only resources (tasks, projects, tags, stats)
│   ├── prompts.ts           # Pre-built prompts (plan-my-day, daily-review, quick-capture)
│   ├── schema-converter.ts  # JSON Schema → Zod shape bridge
│   ├── context.ts           # ToolContext factory
│   └── errors.ts            # Error mapping to MCP responses
│
├── cli/                     # CLI companion
│   ├── index.ts             # Commander.js entry (saydo add/list/done/edit/delete)
│   ├── commands/            # Command handlers
│   └── formatter.ts         # Terminal output formatting
│
└── utils/
    ├── logger.ts            # Structured logger
    ├── ids.ts               # nanoid generation
    ├── dates.ts             # Date utilities
    └── tauri.ts             # isTauri() platform detection
```

## Data flow

### Task creation

```
User types: "buy milk tomorrow at 3pm p1 #groceries +shopping"
  │
  ▼
TaskInput → Task Parser (chrono-node + grammar rules)
  │
  ▼
ParsedTask { title: "buy milk", dueDate: ..., priority: 1, tags: ["groceries"], project: "shopping" }
  │
  ▼
TaskService.create() → validate with Zod → generate ID → link project/tags
  │
  ▼
IStorage (SQLite or Markdown backend)
  │
  ▼
EventBus → notify plugins (task:create)
  │
  ▼
UI re-renders task list
```

Same flow from CLI: `saydo add "buy milk tomorrow p1 #groceries"` → Parser → TaskService → Storage.

Same flow from MCP: external agent calls `create_task` tool → ToolRegistry.execute() → TaskService → Storage.

### MCP (external agents)

```
External MCP Client (Claude Desktop, custom agent, ASF app)
  │
  │ JSON-RPC over stdio
  ▼
src/mcp/server.ts → bootstrap() → AppServices
  │
  ├── Tools:     ToolRegistry.execute() → core services → storage
  ├── Resources: TaskService.list() / ProjectService.list() → JSON
  └── Prompts:   Pre-built conversation starters (plan-my-day, etc.)
```

The MCP server calls the same `bootstrap()` and uses the same `ToolRegistry` as the CLI and web app — no logic duplication.

### AI chat

```
User types/speaks in AI panel
  │
  ▼
(Voice: STT provider → text)
  │
  ▼
LLMPipeline: inject context (task counts, overdue, projects) + tool definitions
  │
  ▼
LLM Provider (configured by user) → streaming response via SSE
  │
  ▼
Tool execution (if tool calls): create/update/complete tasks, run queries
  │
  ▼
Response in chat + task list updated
  │
  ▼
(Voice: TTS provider → audio)
```

### Plugin loading

```
App startup → Plugin Loader scans plugins/ → validate manifests (Zod)
  │
  ▼
For each plugin: create sandbox → inject filtered API → call onLoad()
  │
  ▼
Plugin registers commands, views, panels, event listeners
  │
  ▼
Active — receives events, renders UI, responds to commands
```

## Database schema

### Tables

**tasks**

| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | nanoid |
| title | TEXT | required |
| description | TEXT | nullable |
| status | TEXT | "pending" / "completed" / "cancelled" |
| priority | INTEGER | 1-4, nullable |
| dueDate | TEXT | ISO timestamp, nullable |
| dueTime | INTEGER | 0/1 — whether due date has a time component |
| completedAt | TEXT | ISO timestamp, nullable |
| projectId | TEXT (FK) | → projects, nullable |
| parentId | TEXT (FK) | → tasks (self-ref for subtasks), nullable |
| recurrence | TEXT | RRULE-like, nullable |
| remindAt | TEXT | ISO timestamp, nullable |
| sortOrder | INTEGER | manual sort position |
| createdAt | TEXT | ISO timestamp |
| updatedAt | TEXT | ISO timestamp |

**projects** — id, name, color, icon, sortOrder, archived, createdAt

**tags** — id, name, color

**task_tags** — taskId + tagId (composite PK)

**task_templates** — id, name, description, variables (JSON)

**chat_messages** — persisted AI conversation history

**plugin_settings** — pluginId, settings (JSON), updatedAt

**app_settings** — key, value (JSON), updatedAt

### Markdown storage

When `STORAGE_MODE=markdown`, tasks are `.md` files with YAML frontmatter:

```markdown
---
completedAt: null
createdAt: "2025-01-14T10:00:00Z"
dueDate: "2025-01-15T15:00:00Z"
id: abc123
priority: 1
project: shopping
status: pending
tags: [groceries]
---

# buy milk

Optional description here.
```

File structure: `tasks/inbox/`, `tasks/<project>/`, `tasks/.saydo/` for metadata. YAML keys sorted alphabetically for minimal git diffs.

## Storage abstraction

Both backends implement `IStorage` (defined in `src/storage/interface.ts`):

```
IStorage
├── Task CRUD (create, list, get, update, delete)
├── Project CRUD
├── Tag CRUD
├── Template CRUD
├── Chat history
├── Plugin settings
├── Reminders
└── listAllTaskTags() — batch query to avoid N+1
```

Services (`TaskService`, `ProjectService`, etc.) accept `IStorage` and don't know which backend is active. `bootstrap.ts` picks the backend based on `STORAGE_MODE` env var. `bootstrap-web.ts` always uses SQLite (sql.js in browser).

## AI system

### Provider abstraction

All providers implement `LLMProviderPlugin`. Swapping models is one config change.

Supported: OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, any OpenAI-compatible API. Custom providers via `ai:provider` plugin permission.

### Tools

The AI has access to 25 structured tools:

| Tool | Category |
|---|---|
| task-crud (create/read/update/complete/delete) | Task CRUD |
| query-tasks (search, filter) | Task CRUD |
| project-crud (create/list/get/update/delete) | Project CRUD |
| reminder-tools (list/set/snooze/dismiss) | Reminders |
| tag-crud (list/add/remove tags) | Tag Management |
| break_down_task | Productivity |
| check_duplicates | Productivity |
| check_overcommitment | Productivity |
| analyze-patterns | Intelligence |
| analyze-workload | Intelligence |
| smart-organize | Intelligence |
| energy-recommendations | Intelligence |

Tools are registered in `ToolRegistry` (`createDefaultToolRegistry()`). Plugins can register additional tools. All tools are also exposed via the MCP server for external agents (see [MCP.md](../backend/MCP.md)).

### Voice

Voice I/O mirrors the LLM provider pattern:

- **STT**: `STTProviderPlugin` — Browser Speech API, Groq Whisper, local Whisper (@huggingface/transformers)
- **TTS**: `TTSProviderPlugin` — Browser Speech Synthesis, Groq PlayAI, Inworld AI (streaming, model selection), local Kokoro (kokoro-js), local Piper (piper-phonemize + onnxruntime)
- **VAD**: Voice activity detection via `@ricky0123/vad-web` for hands-free mode

Voice settings stored in localStorage (`saydo-voice-settings`). Cloud TTS providers (Groq, Inworld) are proxied through Vite middleware to avoid CORS and handle auth. Inworld uses the streaming NDJSON endpoint (`/tts/v1/voice:stream`) for lower time-to-first-audio.

## Plugin system

```
┌──────────────────────────────────────┐
│            Saydo Core                │
│                                      │
│  ┌────────────────────────────────┐  │
│  │      Plugin API Surface        │  │
│  │  Commands · Views · Settings   │  │
│  │  Events · Task API · Storage   │  │
│  └──────────────┬─────────────────┘  │
│                 │                     │
│  ┌──────────────┴─────────────────┐  │
│  │       Sandbox Layer            │  │
│  │  Restricted globals            │  │
│  │  No fs, no process, no eval    │  │
│  └──────────────┬─────────────────┘  │
│                 │                     │
│  ┌──────────┐ ┌┴─────────┐           │
│  │ Plugin A │ │ Plugin B  │           │
│  └──────────┘ └───────────┘           │
└──────────────────────────────────────┘
```

Permissions: `task:read`, `task:write`, `ui:panel`, `ui:view`, `ui:status`, `commands`, `settings`, `storage`, `network`, `ai:provider`.

Plugins declare permissions in `manifest.json`. Users approve on install. Permissions enforced at the API layer — plugins get a proxy object with only what they're allowed to use.

See [Plugin API](../plugins/API.md) for the full reference.

## State management

```
SQLite / Markdown (source of truth)
  ↓
Core Services (TaskService, ProjectService, etc.)
  ↓
React Context (UndoContext, etc.)
  ↓
React Components
```

SQLite/Markdown is the single source of truth. Core services are the only layer that writes to storage. UI reads from context, writes through services. Plugins interact through the Plugin API, never directly with storage.

No Redux or Zustand — React Context + core services handle the data flow for v1.

## Key tech choices

| Choice | Why |
|---|---|
| **Tauri** (not Electron) | ~5MB binary vs ~150MB. Uses system webview, not bundled Chromium. |
| **SQLite + Drizzle** (not IndexedDB) | Fast queries, complex filters, type-safe. Schema is Postgres-compatible for future server use. |
| **React + Tailwind** | Largest ecosystem (plugin authors know it), fast prototyping, easy theming. |
| **chrono-node** | Best JS library for natural language date parsing. |
| **Commander.js** | Industry standard for Node CLIs. CLI shares core logic with UI. |
