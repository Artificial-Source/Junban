# Master File Index

Complete index of every non-UI source file in `src/`. Sorted by directory, then filename.

| File | Path | Lines | Purpose |
|------|------|------:|---------|
| `anthropic.ts` | `src/ai/provider/adapters/anthropic.ts` | 193 | Anthropic provider adapter using the native Anthropic SDK |
| `lmstudio.ts` | `src/ai/provider/adapters/lmstudio.ts` | 142 | LM Studio provider with native API discovery and model loading/unloading |
| `ollama.ts` | `src/ai/provider/adapters/ollama.ts` | 48 | Ollama provider with native /api/tags model discovery |
| `openai-compat.ts` | `src/ai/provider/adapters/openai-compat.ts` | 261 | Shared base for OpenAI-compatible providers (OpenAI, OpenRouter, Ollama, LM Studio) |
| `openai.ts` | `src/ai/provider/adapters/openai.ts` | 15 | OpenAI provider (thin config over openai-compat) |
| `openrouter.ts` | `src/ai/provider/adapters/openrouter.ts` | 19 | OpenRouter provider (thin config over openai-compat with custom headers) |
| `interface.ts` | `src/ai/provider/interface.ts` | 49 | LLMProviderPlugin and LLMExecutor interfaces |
| `registry.ts` | `src/ai/provider/registry.ts` | 109 | LLMProviderRegistry -- manages provider plugin registration, executor creation, model discovery |
| `capabilities.ts` | `src/ai/core/capabilities.ts` | 28 | LLMCapabilities and ModelDescriptor interfaces, default capabilities |
| `context.ts` | `src/ai/core/context.ts` | 22 | LLMExecutionContext and PipelineResult types for the middleware pipeline |
| `middleware.ts` | `src/ai/core/middleware.ts` | 66 | Built-in middleware: capability guard, timeout wrapper, logging |
| `pipeline.ts` | `src/ai/core/pipeline.ts` | 34 | Composable middleware pipeline for LLM execution |
| `analyze-patterns.ts` | `src/ai/tools/builtin/analyze-patterns.ts` | 154 | analyze_completion_patterns tool -- productivity pattern mining |
| `analyze-workload.ts` | `src/ai/tools/builtin/analyze-workload.ts` | 249 | analyze_workload and check_overcommitment tools |
| `energy-recommendations.ts` | `src/ai/tools/builtin/energy-recommendations.ts` | 145 | get_energy_recommendations tool -- energy-aware task planning |
| `project-crud.ts` | `src/ai/tools/builtin/project-crud.ts` | 247 | Project CRUD tools: create, list, get, update, delete (supports icon, parentId, isFavorite, viewStyle) |
| `query-tasks.ts` | `src/ai/tools/builtin/query-tasks.ts` | 93 | query_tasks tool -- flexible task search/filter with TaskFilter |
| `reminder-tools.ts` | `src/ai/tools/builtin/reminder-tools.ts` | 196 | Reminder tools: list, set, snooze, dismiss |
| `smart-organize.ts` | `src/ai/tools/builtin/smart-organize.ts` | 396 | suggest_tags, find_similar_tasks, and check_duplicates tools |
| `tag-crud.ts` | `src/ai/tools/builtin/tag-crud.ts` | 121 | Tag tools: list_tags, add_tags_to_task, remove_tags_from_task |
| `task-breakdown.ts` | `src/ai/tools/builtin/task-breakdown.ts` | 81 | break_down_task tool -- creates subtasks under a parent |
| `task-crud.ts` | `src/ai/tools/builtin/task-crud.ts` | 197 | Task CRUD tools: create, update, complete, delete |
| `registry.ts` | `src/ai/tools/registry.ts` | 68 | ToolRegistry -- extensible registry for built-in and plugin tools |
| `types.ts` | `src/ai/tools/types.ts` | 33 | ToolDefinition, ToolContext, ToolExecutor, RegisteredTool types |
| `browser-stt.ts` | `src/ai/voice/adapters/browser-stt.ts` | 91 | Browser Web Speech API STT adapter |
| `browser-tts.ts` | `src/ai/voice/adapters/browser-tts.ts` | 72 | Browser SpeechSynthesis TTS adapter |
| `groq-stt.ts` | `src/ai/voice/adapters/groq-stt.ts` | 48 | Groq Whisper STT adapter |
| `groq-tts.ts` | `src/ai/voice/adapters/groq-tts.ts` | 76 | Groq TTS adapter |
| `inworld-tts.ts` | `src/ai/voice/adapters/inworld-tts.ts` | 77 | Inworld TTS adapter |
| `kokoro-local-tts.ts` | `src/ai/voice/adapters/kokoro-local-tts.ts` | 275 | Kokoro local TTS adapter (WebAssembly Web Worker, cache management, model delete/size) |
| `piper-local-tts.ts` | `src/ai/voice/adapters/piper-local-tts.ts` | 146 | Piper local TTS adapter |
| `whisper-local-stt.ts` | `src/ai/voice/adapters/whisper-local-stt.ts` | 180 | Whisper local STT adapter (transformers.js, cache management, model delete/size) |
| `kokoro-worker-types.ts` | `src/ai/voice/workers/kokoro-worker-types.ts` | 15 | Type definitions for the Kokoro Web Worker |
| `kokoro.worker.ts` | `src/ai/voice/workers/kokoro.worker.ts` | 62 | Web Worker for Kokoro TTS model execution |
| `audio-utils.ts` | `src/ai/voice/audio-utils.ts` | 193 | WAV conversion, MediaRecorder wrapper, mic enumeration, audio playback |
| `interface.ts` | `src/ai/voice/interface.ts` | 71 | STTProviderPlugin and TTSProviderPlugin interfaces |
| `provider.ts` | `src/ai/voice/provider.ts` | 45 | Voice provider factory -- creates VoiceProviderRegistry with defaults |
| `registry.ts` | `src/ai/voice/registry.ts` | 63 | VoiceProviderRegistry for STT/TTS providers |
| `chat.ts` | `src/ai/chat.ts` | 570 | ChatSession (message loop, tool execution, streaming) and ChatManager (session lifecycle, context gathering) |
| `errors.ts` | `src/ai/errors.ts` | 110 | AIError class and classifyProviderError -- categorizes provider errors (auth, rate_limit, network, etc.) |
| `model-discovery.ts` | `src/ai/model-discovery.ts` | 76 | Model discovery shim -- delegates to provider registry for backward compatibility |
| `provider.ts` | `src/ai/provider.ts` | 63 | Factory functions: createDefaultRegistry (5 LLM providers) and createDefaultToolRegistry (all built-in tools) |
| `types.ts` | `src/ai/types.ts` | 62 | Shared AI types: ChatMessage, ToolCall, ChatResponse, StreamEvent, LLMRequest, LLMResponse |
| `index.ts` | `src/cli/index.ts` | 63 | CLI entry point -- Commander.js command registration |
| `add.ts` | `src/cli/commands/add.ts` | 40 | CLI `add` command handler |
| `delete.ts` | `src/cli/commands/delete.ts` | 22 | CLI `delete` command handler |
| `done.ts` | `src/cli/commands/done.ts` | 25 | CLI `done` command handler |
| `edit.ts` | `src/cli/commands/edit.ts` | 53 | CLI `edit` command handler |
| `list.ts` | `src/cli/commands/list.ts` | 72 | CLI `list` command handler |
| `formatter.ts` | `src/cli/formatter.ts` | 28 | Terminal output formatting for parsed tasks |
| `defaults.ts` | `src/config/defaults.ts` | 59 | Priority definitions, status list, color palette with labels, command palette hotkey, UI constants |
| `env.ts` | `src/config/env.ts` | 26 | Zod-validated environment variable loading |
| `themes.ts` | `src/config/themes.ts` | 14 | Built-in theme definitions (Light, Dark, Nord) |
| `actions.ts` | `src/core/actions.ts` | 149 | UndoableAction factory functions for task mutations |
| `errors.ts` | `src/core/errors.ts` | 22 | Custom error classes: NotFoundError, ValidationError, StorageError |
| `event-bus.ts` | `src/core/event-bus.ts` | 67 | Typed pub/sub event bus for task lifecycle events |
| `export.ts` | `src/core/export.ts` | 75 | Data export: JSON, CSV, Markdown formats |
| `filters.ts` | `src/core/filters.ts` | 31 | TaskFilter interface and in-memory filtering |
| `import.ts` | `src/core/import.ts` | 317 | Data import: Saydo JSON, Todoist JSON, Markdown/text formats |
| `priorities.ts` | `src/core/priorities.ts` | 23 | Priority metadata lookup and task sorting |
| `projects.ts` | `src/core/projects.ts` | 80 | ProjectService -- project CRUD with archive, parentId, isFavorite, viewStyle |
| `query-parser.ts` | `src/core/query-parser.ts` | 171 | Natural language query to TaskFilter parser |
| `recurrence.ts` | `src/core/recurrence.ts` | 46 | Recurring task next-occurrence calculator |
| `tags.ts` | `src/core/tags.ts` | 44 | TagService -- tag CRUD |
| `tasks.ts` | `src/core/tasks.ts` | 435 | TaskService -- task CRUD, subtasks, batch ops, recurrence |
| `templates.ts` | `src/core/templates.ts` | 133 | TemplateService -- task template CRUD with variable substitution |
| `types.ts` | `src/core/types.ts` | 92 | Core type definitions and Zod schemas (Task, Project, Tag, Template, CreateTemplateInput) |
| `undo.ts` | `src/core/undo.ts` | 68 | UndoManager -- command pattern undo/redo with 50-deep stack |
| `client.ts` | `src/db/client.ts` | 21 | better-sqlite3 database connection (Node.js) |
| `client-web.ts` | `src/db/client-web.ts` | 19 | sql.js database connection (browser/WebAssembly) |
| `migrate.ts` | `src/db/migrate.ts` | 26 | Drizzle ORM migration runner (Node.js) |
| `migrate-web.ts` | `src/db/migrate-web.ts` | 17 | Raw SQL migration runner (browser) |
| `persistence.ts` | `src/db/persistence.ts` | 24 | Tauri AppData file persistence for sql.js database |
| `queries.ts` | `src/db/queries.ts` | 229 | Drizzle query factory for all entity CRUD, chat sessions, templates, plugin permissions |
| `schema.ts` | `src/db/schema.ts` | 90 | Drizzle ORM table definitions (8 tables) |
| `grammar.ts` | `src/parser/grammar.ts` | 75 | Regex extraction rules: priority, tags, project, recurrence |
| `nlp.ts` | `src/parser/nlp.ts` | 51 | chrono-node date/time extraction and cleanup |
| `task-parser.ts` | `src/parser/task-parser.ts` | 58 | Main task parser orchestrator |
| `api.ts` | `src/plugins/api.ts` | 167 | Plugin API surface -- permission-gated access to tasks, commands, UI, events, storage, AI |
| `command-registry.ts` | `src/plugins/command-registry.ts` | 51 | Plugin command registry |
| `installer.ts` | `src/plugins/installer.ts` | 134 | Plugin installer -- download, extract, validate tar.gz archives |
| `lifecycle.ts` | `src/plugins/lifecycle.ts` | 26 | Plugin abstract base class with lifecycle hooks |
| `loader.ts` | `src/plugins/loader.ts` | 388 | Plugin loader -- discovery (user + builtin), validation, loading, permission management |
| `registry.ts` | `src/plugins/registry.ts` | 73 | Community plugin registry client (local + remote) |
| `sandbox.ts` | `src/plugins/sandbox.ts` | 23 | Plugin sandbox placeholder (permission checks in API, full isolation deferred) |
| `settings.ts` | `src/plugins/settings.ts` | 75 | Per-plugin settings manager with DB persistence and caching |
| `types.ts` | `src/plugins/types.ts` | 74 | Plugin manifest Zod schema, setting definitions, permission list |
| `ui-registry.ts` | `src/plugins/ui-registry.ts` | 95 | Plugin UI registry -- panels, views, status bar items |
| `index.ts` | `src/plugins/builtin/pomodoro/index.ts` | 195 | Built-in Pomodoro timer plugin -- work/break phases, start/pause/reset commands, status bar, sidebar panel |
| `interface.ts` | `src/storage/interface.ts` | 159 | IStorage interface, all row types, ChatSessionInfo, MutationResult |
| `markdown-backend.ts` | `src/storage/markdown-backend.ts` | 827 | Markdown storage backend (files + in-memory indexes, chat sessions, templates) |
| `markdown-utils.ts` | `src/storage/markdown-utils.ts` | 168 | YAML frontmatter, slugify, task file parse/serialize |
| `sqlite-backend.ts` | `src/storage/sqlite-backend.ts` | 234 | SQLite storage backend (wraps Drizzle queries, chat sessions, templates) |
| `color.ts` | `src/utils/color.ts` | 28 | Hex to rgba conversion |
| `dates.ts` | `src/utils/dates.ts` | 36 | Date utility functions (isToday, isOverdue, todayStart/End, startOfWeek) |
| `format-date.ts` | `src/utils/format-date.ts` | 66 | Advanced date/time formatting (relative, short, long, ISO, 12h/24h) |
| `ids.ts` | `src/utils/ids.ts` | 13 | 21-char URL-safe ID generator |
| `logger.ts` | `src/utils/logger.ts` | 50 | Structured JSON logger with module scope |
| `sounds.ts` | `src/utils/sounds.ts` | 87 | Web Audio API procedural sound effects |
| `tauri.ts` | `src/utils/tauri.ts` | 7 | Tauri WebView detection |
| `bootstrap.ts` | `src/bootstrap.ts` | 121 | Node.js application bootstrap -- initializes storage, services, plugins, AI registries |
| `bootstrap-web.ts` | `src/bootstrap-web.ts` | 102 | Browser/Tauri application bootstrap with auto-save and debounce |
| `main.ts` | `src/main.ts` | 27 | Entry point -- loads env, bootstraps services, loads plugins |
| `vite-env.d.ts` | `src/vite-env.d.ts` | 7 | Vite type declarations for SQL raw imports |

**Total non-UI source files:** 86
**Total non-UI lines of code:** 11,259
