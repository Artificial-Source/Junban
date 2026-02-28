# AI Subsystem — Internal Documentation

The AI subsystem (`src/ai/`) implements Saydo's conversational AI assistant. It provides a pluggable multi-provider LLM architecture with a middleware pipeline, a tool calling system, and session management. The subsystem is designed so that AI is entirely optional: no AI code runs unless the user configures a provider.

**Total files:** 47 | **Total lines:** ~6,378

---

## Architecture Overview

```
User Message
    |
    v
ChatSession.run()
    |
    v
LLMPipeline (middleware chain)
    |  capabilityGuard -> logging -> timeout -> ...
    v
LLMExecutor.execute()  (provider-specific)
    |
    v
Stream/Complete Response
    |
    v
Tool Calls? --yes--> ToolRegistry.execute() ---> loop back to LLM
    |
    no
    v
Done (yield StreamEvents to UI)
```

---

## Core

### `types.ts`
**Path:** `src/ai/types.ts`
**Lines:** 61
**Purpose:** Canonical type definitions shared across the entire AI subsystem. Defines the message, tool, request, response, and streaming shapes.
**Key Exports:**
- `BuiltInProviderName` — union type: `"openai" | "anthropic" | "openrouter" | "ollama" | "lmstudio"`
- `ProviderName` — `string` alias for extensibility
- `AIProviderConfig` — `{ provider, apiKey?, model?, baseUrl? }`
- `ChatMessage` — `{ role, content, toolCallId?, toolCalls? }`
- `ToolCall` — `{ id, name, arguments }`
- `ToolDefinition` — `{ name, description, parameters }`
- `ChatResponse` — `{ content, toolCalls? }`
- `StreamEvent` — `{ type: "token" | "tool_call" | "tool_result" | "done" | "error", data }`
- `StreamErrorData` — `{ message, category, retryable, retryAfterMs? }`
- `LLMRequest` — `{ messages, tools?, model, options? }`
- `LLMResponse` — `{ content, toolCalls?, usage? }`
**Key Dependencies:** None (pure types)
**Used By:** Every other file in `src/ai/`

---

### `errors.ts`
**Path:** `src/ai/errors.ts`
**Lines:** 109
**Purpose:** Structured error handling for AI providers. Classifies raw provider errors (HTTP status codes, network errors) into typed AIError instances with retry guidance.
**Key Exports:**
- `AIErrorCategory` — `"auth" | "rate_limit" | "network" | "server" | "timeout" | "unknown"`
- `AIError` — extends `Error` with `category`, `retryable`, `retryAfterMs`
- `StreamErrorData` — interface for serialized error payloads
- `classifyProviderError(err, providerName?)` — converts raw errors into AIError. Handles:
  - 401/403 -> auth (not retryable)
  - 429 -> rate_limit (retryable, parses Retry-After header)
  - 5xx -> server (retryable)
  - ECONNREFUSED/ENOTFOUND -> network (retryable, with friendly messages for local providers)
  - Everything else -> unknown (retryable)
**Key Dependencies:** None
**Used By:** `chat.ts`, `openai-compat.ts`, `anthropic.ts`

---

### `chat.ts`
**Path:** `src/ai/chat.ts`
**Lines:** 569
**Purpose:** Chat session management and the main conversation loop. Contains `ChatSession` (runs the LLM + tool loop), `ChatManager` (session lifecycle), and `gatherContext()` (builds task context for the system prompt).
**Key Exports:**
- `ChatSession` — Manages a single conversation. Key methods:
  - `addUserMessage(content)` — appends a user message
  - `run()` — async generator yielding `StreamEvent`s. Runs the LLM, processes tool calls (up to 10 iterations), detects hallucination loops, and handles errors
  - `getMessages()` — returns non-system messages
  - `sessionId` — unique identifier
- `ChatManager` — Manages session lifecycle:
  - `getOrCreateSession()` — lazy session creation
  - `clearSession()` — destroys session and DB history
  - `resetWithProvider()` — clears and recreates for provider changes
  - `restoreSession()` — restores from DB-persisted messages
  - `buildSystemMessage()` — generates the system prompt (full or compact for local models)
- `gatherContext(services, options?)` — async function that fetches live task data (pending count, overdue, due today, high priority, untagged, etc.) and formats it for the system message. Supports `compact` mode for local models and `voiceCall` mode with conversational instructions.
- `ToolServices` — backward-compatibility type alias
**Key Dependencies:** `LLMExecutor`, `LLMPipeline`, `ToolRegistry`, `IStorage`, `AIError`, `classifyProviderError`
**Used By:** UI components (`AIChatPanel.tsx`, `VoiceCallOverlay.tsx`)

**Notable behaviors:**
- Local providers (Ollama, LM Studio) receive a reduced tool set (`LOCAL_PROVIDER_TOOLS`) to fit smaller context windows
- Duplicate tool call loop detection: if the same set of tool calls repeats, the loop breaks
- Stream timeout: 60 seconds per chunk
- All messages are persisted to the database via `IStorage.insertChatMessage()`

---

### `provider.ts`
**Path:** `src/ai/provider.ts`
**Lines:** 62
**Purpose:** Factory module that wires up the default provider and tool registries. This is the main entry point for initializing the AI system.
**Key Exports:**
- `createDefaultRegistry()` — creates an `LLMProviderRegistry` and registers all 5 built-in providers (OpenAI, Anthropic, OpenRouter, Ollama, LM Studio)
- `createDefaultToolRegistry()` — creates a `ToolRegistry` and registers all built-in tools (task CRUD, query, projects, reminders, analytics, tags, breakdown)
**Key Dependencies:** All provider adapters, all tool registration functions
**Used By:** `main.ts` (app initialization), `model-discovery.ts`

---

### `model-discovery.ts`
**Path:** `src/ai/model-discovery.ts`
**Lines:** 75
**Purpose:** Public API for discovering, loading, and unloading models. Delegates to the provider registry. Maintained for backward compatibility with the Vite dev server API routes.
**Key Exports:**
- `ModelInfo` — `{ id, label, loaded }`
- `fetchAvailableModels(providerName, config)` — queries the provider for available models
- `loadLMStudioModel(modelKey, baseUrl, apiKey?)` — loads a model in LM Studio
- `unloadLMStudioModel(modelKey, baseUrl, apiKey?)` — unloads a model from LM Studio
**Key Dependencies:** `createDefaultRegistry()`, LM Studio adapter
**Used By:** Vite middleware API routes (`vite.config.ts`)

---

## Pipeline

### `context.ts`
**Path:** `src/ai/core/context.ts`
**Lines:** 21
**Purpose:** Defines the execution context that flows through the LLM pipeline. Carries the request, provider capabilities, and middleware scratch space.
**Key Exports:**
- `LLMExecutionContext` — `{ request, providerName, capabilities, metadata, signal? }`
- `PipelineResult` — discriminated union:
  - `{ mode: "complete", response: LLMResponse }`
  - `{ mode: "stream", events: AsyncIterable<StreamEvent> }`
**Key Dependencies:** `LLMCapabilities`, `LLMRequest`, `LLMResponse`, `StreamEvent`
**Used By:** `pipeline.ts`, `middleware.ts`, `interface.ts`, `chat.ts`, all provider adapters

---

### `pipeline.ts`
**Path:** `src/ai/core/pipeline.ts`
**Lines:** 33
**Purpose:** Composable middleware pipeline for LLM execution. Middleware wraps the provider's execute call in an onion-like chain.
**Key Exports:**
- `Middleware` — type: `(ctx, next) => Promise<PipelineResult>`
- `LLMPipeline` — class with:
  - `use(mw)` — adds middleware to the chain
  - `execute(ctx, handler)` — runs the chain with the provider as the innermost call. Uses `reduceRight` to compose middleware.
**Key Dependencies:** `LLMExecutionContext`, `PipelineResult`
**Used By:** `chat.ts` (constructs and runs the pipeline)

---

### `capabilities.ts`
**Path:** `src/ai/core/capabilities.ts`
**Lines:** 27
**Purpose:** Declares what LLM models can do. Providers report capabilities; middleware uses them to guard operations.
**Key Exports:**
- `LLMCapabilities` — `{ streaming, toolCalling, vision, structuredOutput, maxContextLength? }`
- `ModelDescriptor` — `{ id, label, capabilities, loaded }`
- `DEFAULT_CAPABILITIES` — `{ streaming: true, toolCalling: true, vision: false, structuredOutput: false }`
**Key Dependencies:** None (pure types + constant)
**Used By:** `interface.ts`, `registry.ts`, all provider adapters, `middleware.ts`

---

### `middleware.ts`
**Path:** `src/ai/core/middleware.ts`
**Lines:** 65
**Purpose:** Built-in middleware functions for the LLM pipeline.
**Key Exports:**
- `capabilityGuard` — strips `tools` from the request if the model doesn't support tool calling
- `createTimeout(timeoutMs)` — factory that wraps streaming responses with per-chunk timeouts. Returns `AIError` with `"timeout"` category on expiry.
- `logging` — records `startTime` and `durationMs` in `ctx.metadata`
**Key Dependencies:** `Middleware` type, `AIError`
**Used By:** Pipeline construction in the app initialization

---

## Providers

### `interface.ts`
**Path:** `src/ai/provider/interface.ts`
**Lines:** 48
**Purpose:** Core interfaces that all LLM providers must implement. Separates registration (plugin) from runtime execution (executor).
**Key Exports:**
- `LLMProviderPlugin` — registration interface:
  - `name`, `displayName`, `needsApiKey`, `optionalApiKey?`, `defaultModel`, `defaultBaseUrl?`, `showBaseUrl?`
  - `createExecutor(config)` — factory for runtime executor
  - `discoverModels(config)` — returns available `ModelDescriptor[]`
  - `loadModel?(modelKey, config)` — for local providers
  - `unloadModel?(modelKey, config)` — for local providers
- `LLMExecutor` — runtime interface:
  - `execute(ctx)` — returns `PipelineResult` (stream or complete)
  - `getCapabilities(modelId)` — returns `LLMCapabilities`
**Key Dependencies:** `LLMCapabilities`, `ModelDescriptor`, `LLMExecutionContext`, `PipelineResult`, `AIProviderConfig`
**Used By:** All provider adapters, `registry.ts`, `chat.ts`

---

### `registry.ts`
**Path:** `src/ai/provider/registry.ts`
**Lines:** 108
**Purpose:** Central registry for LLM provider plugins. Manages registration, executor creation, model discovery, and model loading.
**Key Exports:**
- `ProviderRegistration` — `{ plugin, pluginId }` (pluginId is null for built-in providers)
- `LLMProviderRegistry` — class:
  - `register(plugin, pluginId?)` — register a provider (throws on duplicate)
  - `unregister(name)` / `unregisterByPlugin(pluginId)` — remove providers
  - `get(name)` / `getPlugin(name)` / `getAll()` — lookups
  - `createExecutor(config)` — validates API key requirements and creates an executor
  - `discoverModels(providerName, config)` — delegates to provider's discovery
  - `loadModel(providerName, modelKey, config)` — delegates to provider's load
  - `getCapabilities(providerName, modelId, config)` — queries executor for capabilities
**Key Dependencies:** `LLMProviderPlugin`, `LLMExecutor`, `LLMCapabilities`, `ModelDescriptor`, `AIProviderConfig`
**Used By:** `provider.ts` (factory), `model-discovery.ts`, `chat.ts` (indirectly via executor), plugin API (`api.ts`)

---

### `openai-compat.ts`
**Path:** `src/ai/provider/adapters/openai-compat.ts`
**Lines:** 260
**Purpose:** Shared base implementation for all OpenAI-compatible providers. Factory function that creates a full `LLMProviderPlugin` with customizable config. Used by OpenAI, OpenRouter, Ollama, and LM Studio.
**Key Exports:**
- `OpenAICompatConfig` — configuration interface: name, displayName, needsApiKey, optionalApiKey, defaultModel, defaultBaseUrl, showBaseUrl, fakeApiKey, defaultHeaders, modelFilter, discoverModels, loadModel, unloadModel
- `createOpenAICompatPlugin(cfg)` — factory that returns a complete `LLMProviderPlugin`
**Key internals:**
- `OpenAICompatExecutor` — implements `LLMExecutor` using the OpenAI SDK
  - `execute()` — always returns streaming mode
  - `streamResponse()` — async generator that yields `StreamEvent`s from OpenAI SSE stream
  - Accumulates tool calls by index, detects truncation (`finish_reason: "length"`)
- `toOpenAIMessages()` — converts internal `ChatMessage[]` to OpenAI format
- `toOpenAITools()` — converts internal `ToolDefinition[]` to OpenAI function calling format
- `defaultDiscoverModels()` — fetches `GET /v1/models` with optional model filter
**Key Dependencies:** `openai` SDK, `AIError`, `classifyProviderError`, `DEFAULT_CAPABILITIES`
**Used By:** `openai.ts`, `openrouter.ts`, `ollama.ts`, `lmstudio.ts`

---

### `openai.ts`
**Path:** `src/ai/provider/adapters/openai.ts`
**Lines:** 14
**Purpose:** OpenAI provider. Thin configuration wrapper over `openai-compat.ts`.
**Key Exports:**
- `openaiPlugin` — `LLMProviderPlugin` configured with: `needsApiKey: true`, `defaultModel: "gpt-4o"`, model filter matching `gpt`, `o1-9`, `chatgpt`
**Key Dependencies:** `createOpenAICompatPlugin`
**Used By:** `provider.ts`

---

### `anthropic.ts`
**Path:** `src/ai/provider/adapters/anthropic.ts`
**Lines:** 192
**Purpose:** Anthropic (Claude) provider. Standalone implementation using the Anthropic SDK directly because the API format differs from OpenAI.
**Key Exports:**
- `anthropicPlugin` — `LLMProviderPlugin` configured with: `needsApiKey: true`, `defaultModel: "claude-sonnet-4-5-20250929"`
**Key internals:**
- `AnthropicExecutor` — implements `LLMExecutor`:
  - `getCapabilities()` — reports `vision: true`
  - `execute()` — returns streaming mode
  - `streamResponse()` — processes Anthropic SSE events (`content_block_start`, `content_block_delta`, `content_block_stop`), accumulates tool calls, handles truncation (`max_tokens` stop reason)
- `toAnthropicMessages()` — converts messages (handles tool_use/tool_result format differences)
- `toAnthropicTools()` — converts to Anthropic's `input_schema` format
- Hardcoded model list: `claude-sonnet-4-5-20250929`, `claude-opus-4-6`, `claude-haiku-4-5-20251001`
**Key Dependencies:** `@anthropic-ai/sdk`, `classifyProviderError`
**Used By:** `provider.ts`

---

### `openrouter.ts`
**Path:** `src/ai/provider/adapters/openrouter.ts`
**Lines:** 18
**Purpose:** OpenRouter provider. Thin configuration wrapper with custom HTTP headers.
**Key Exports:**
- `openrouterPlugin` — `LLMProviderPlugin` configured with: `needsApiKey: true`, `defaultModel: "anthropic/claude-sonnet-4-5-20250929"`, `defaultBaseUrl: "https://openrouter.ai/api/v1"`, custom headers: `HTTP-Referer` and `X-Title`
**Key Dependencies:** `createOpenAICompatPlugin`
**Used By:** `provider.ts`

---

### `ollama.ts`
**Path:** `src/ai/provider/adapters/ollama.ts`
**Lines:** 47
**Purpose:** Ollama (local) provider. Uses OpenAI-compatible base with native `/api/tags` model discovery.
**Key Exports:**
- `ollamaPlugin` — `LLMProviderPlugin` configured with: `needsApiKey: false`, `defaultModel: "llama3.2"`, `defaultBaseUrl: "http://localhost:11434/v1"`, `showBaseUrl: true`, `fakeApiKey: "ollama"`
**Key internals:**
- `discoverOllamaModels()` — fetches `GET <host>/api/tags` (Ollama native endpoint), strips `/v1` suffix from URL
- `fetchWithTimeout()` — 5-second timeout wrapper
**Key Dependencies:** `createOpenAICompatPlugin`, `DEFAULT_CAPABILITIES`
**Used By:** `provider.ts`

---

### `lmstudio.ts`
**Path:** `src/ai/provider/adapters/lmstudio.ts`
**Lines:** 141
**Purpose:** LM Studio provider. Uses OpenAI-compatible base with native API discovery and model loading/unloading.
**Key Exports:**
- `lmstudioPlugin` — `LLMProviderPlugin` configured with: `needsApiKey: false`, `optionalApiKey: true`, `defaultModel: "default"`, `defaultBaseUrl: "http://localhost:1234/v1"`, `showBaseUrl: true`, `fakeApiKey: "lm-studio"`
- `unloadLMStudioModel(modelKey, config)` — `POST /api/v1/models/unload`
**Key internals:**
- `discoverLMStudioModels()` — tries LM Studio native API (`GET /api/v1/models`) first (v0.4.0+, returns all models with loaded status), falls back to OpenAI-compatible `GET /v1/models`
- `loadLMStudioModel()` — `POST /api/v1/models/load` with 120-second timeout
- `authHeaders()` — optional Bearer auth for remote LM Studio servers
- `LMStudioModel` — native API response shape with `type`, `key`, `display_name`, `loaded_instances`
**Key Dependencies:** `createOpenAICompatPlugin`, `DEFAULT_CAPABILITIES`
**Used By:** `provider.ts`, `model-discovery.ts`

---

## Tools

### `types.ts`
**Path:** `src/ai/tools/types.ts`
**Lines:** 32
**Purpose:** Type definitions for the extensible tool system. Shared by built-in tools and plugin-contributed tools.
**Key Exports:**
- `ToolDefinition` — `{ name, description, parameters }` (JSON Schema format for LLMs)
- `ToolContext` — `{ taskService, projectService, tagService?, statsService? }` (services available to tool executors)
- `ToolExecutor` — `(args, ctx) => Promise<string>` (returns JSON string)
- `RegisteredTool` — `{ definition, executor, source }` (source is `"builtin"` or a plugin ID)
**Key Dependencies:** `TaskService`, `ProjectService`, `TagService`
**Used By:** `registry.ts`, all built-in tools, `api.ts` (plugin API)

---

### `registry.ts`
**Path:** `src/ai/tools/registry.ts`
**Lines:** 67
**Purpose:** Central registry for AI tools. Supports registration from both built-in code and plugins at runtime.
**Key Exports:**
- `ToolRegistry` — class:
  - `register(definition, executor, source?)` — registers a tool (throws on duplicate)
  - `unregister(name)` / `unregisterBySource(source)` — remove tools
  - `getDefinitions()` — returns all `ToolDefinition[]` for passing to LLM providers
  - `get(name)` / `has(name)` — lookups
  - `size` — getter for tool count
  - `execute(name, args, ctx)` — runs a tool by name, throws if not found
**Key Dependencies:** `ToolDefinition`, `ToolExecutor`, `ToolContext`, `RegisteredTool`
**Used By:** `chat.ts` (executes tools), `provider.ts` (factory registration), plugin API

---

### Built-in Tools

#### `task-crud.ts`
**Path:** `src/ai/tools/builtin/task-crud.ts`
**Lines:** 196
**Purpose:** Core task CRUD tools for the AI assistant.
**Registered Tools:**

| Tool | Description | Required Parameters | Optional Parameters |
|------|-------------|---------------------|---------------------|
| `create_task` | Create a new task | `title` | `priority` (1-4), `dueDate` (ISO 8601), `tags` (string[]), `projectId`, `recurrence`, `remindAt` |
| `update_task` | Update task fields | `taskId` | `title`, `priority`, `dueDate`, `tags`, `recurrence`, `remindAt` (empty string clears field) |
| `complete_task` | Mark task done (auto-creates next occurrence for recurring) | `taskId` | -- |
| `delete_task` | Permanently delete | `taskId` | -- |

**Key Dependencies:** `ToolRegistry`
**Used By:** `provider.ts` (registration)

---

#### `query-tasks.ts`
**Path:** `src/ai/tools/builtin/query-tasks.ts`
**Lines:** 92
**Purpose:** Flexible task search and filtering. Replaces the old `list_tasks` tool (solves GitHub Issue #9).
**Registered Tools:**

| Tool | Description | Parameters |
|------|-------------|------------|
| `query_tasks` | Search/filter tasks by multiple criteria | `status` ("pending"/"completed"/"cancelled"), `priority` (1-4), `projectId`, `tag`, `search` (text), `dueBefore` (ISO), `dueAfter` (ISO), `limit` (default 50, max 200) |

Returns: `{ tasks, count, totalMatched }`

**Key Dependencies:** `ToolRegistry`, `TaskFilter`
**Used By:** `provider.ts` (registration)

---

#### `project-crud.ts`
**Path:** `src/ai/tools/builtin/project-crud.ts`
**Lines:** 206
**Purpose:** Full project management tools.
**Registered Tools:**

| Tool | Description | Required Parameters | Optional Parameters |
|------|-------------|---------------------|---------------------|
| `create_project` | Create project | `name` | `color` (hex), `icon` (emoji) |
| `list_projects` | List all projects | -- | `includeArchived` (boolean) |
| `get_project` | Get by ID or name | -- | `projectId`, `name` |
| `update_project` | Update fields | `projectId` | `name`, `color`, `icon`, `archived` |
| `delete_project` | Delete (tasks get null projectId) | `projectId` | -- |

**Key Dependencies:** `ToolRegistry`
**Used By:** `provider.ts` (registration)

---

#### `reminder-tools.ts`
**Path:** `src/ai/tools/builtin/reminder-tools.ts`
**Lines:** 195
**Purpose:** Reminder management tools for the AI assistant.
**Registered Tools:**

| Tool | Description | Required Parameters | Optional Parameters |
|------|-------------|---------------------|---------------------|
| `list_reminders` | List tasks with reminders | -- | `filter` ("overdue"/"upcoming"/"all") |
| `set_reminder` | Set/update reminder datetime | `taskId`, `remindAt` (ISO 8601) | -- |
| `snooze_reminder` | Push reminder forward | `taskId`, `minutes` (positive number) | -- |
| `dismiss_reminder` | Clear reminder without completing | `taskId` | -- |

**Key Dependencies:** `ToolRegistry`
**Used By:** `provider.ts` (registration)

---

#### `tag-crud.ts`
**Path:** `src/ai/tools/builtin/tag-crud.ts`
**Lines:** 120
**Purpose:** Tag/label management tools. Supports additive and subtractive tag operations.
**Registered Tools:**

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `list_tags` | List all tags with colors | -- |
| `add_tags_to_task` | Add tags without removing existing | `taskId`, `tags` (string[]) |
| `remove_tags_from_task` | Remove specific tags | `taskId`, `tags` (string[]) |

**Key Dependencies:** `ToolRegistry`, `TagService`
**Used By:** `provider.ts` (registration)

---

#### `task-breakdown.ts`
**Path:** `src/ai/tools/builtin/task-breakdown.ts`
**Lines:** 80
**Purpose:** Breaks a parent task into subtasks. The LLM decides the breakdown, then calls this tool with subtask titles.
**Registered Tools:**

| Tool | Description | Required Parameters | Optional Parameters |
|------|-------------|---------------------|---------------------|
| `break_down_task` | Create subtasks under a parent | `taskId`, `subtasks` (string[]) | `copyFields` (boolean, default true: inherits priority, dueDate, projectId, tags) |

**Key Dependencies:** `ToolRegistry`
**Used By:** `provider.ts` (registration)

---

#### `analyze-patterns.ts`
**Path:** `src/ai/tools/builtin/analyze-patterns.ts`
**Lines:** 153
**Purpose:** Mines completed task history for productivity patterns, recurring behaviors, and optimal work times. Supports Issues #14 (Recurrent Life Automation) and #10 (Context-Aware Reminders).
**Registered Tools:**

| Tool | Description | Parameters |
|------|-------------|------------|
| `analyze_completion_patterns` | Analyze completion history | `days` (default 90) |

Returns: `{ totalCompleted, daysAnalyzed, byHour, byWeekday, avgCompletionHours, topTags, repeatedPatterns }`

- `byHour`: histogram of completions by hour (0-23)
- `byWeekday`: histogram by day of week
- `repeatedPatterns`: tasks completed 3+ times with similar titles, including `avgIntervalDays` and `suggestedRecurrence` (daily, weekly, monthly, etc.)

**Key internals:**
- `normalizeTitle()` — strips numbers and normalizes whitespace for grouping
- `suggestRecurrence()` — maps average interval in days to human-readable recurrence

**Key Dependencies:** `ToolRegistry`
**Used By:** `provider.ts` (registration)

---

#### `analyze-workload.ts`
**Path:** `src/ai/tools/builtin/analyze-workload.ts`
**Lines:** 248
**Purpose:** Workload distribution analysis for smart scheduling. Supports Issue #11 (Smart Scheduling).
**Registered Tools:**

| Tool | Description | Parameters |
|------|-------------|------------|
| `check_overcommitment` | Quick check if a specific date is overloaded | `date` (ISO, default today) |
| `analyze_workload` | Full workload distribution over upcoming days | `days` (default 14) |

**`check_overcommitment`** returns: `{ date, taskCount, priorityWeight, isOverloaded, overdue, suggestion }`. Overloaded threshold: >5 tasks or >12 priority weight. When overloaded, suggests lighter days within the next 7 days.

**`analyze_workload`** returns: `{ days[], unscheduled, overdue, summary }`. Each day includes task count, priority weight, isOverloaded/isLight flags. Summary has avgPerDay, busiestDay, lightestDay.

**Constants:** `PRIORITY_WEIGHT: { 1:4, 2:3, 3:2, 4:1 }`, `OVERLOADED_TASK_THRESHOLD: 5`, `OVERLOADED_WEIGHT_THRESHOLD: 12`, `LIGHT_TASK_THRESHOLD: 2`

**Key Dependencies:** `ToolRegistry`
**Used By:** `provider.ts` (registration)

---

#### `smart-organize.ts`
**Path:** `src/ai/tools/builtin/smart-organize.ts`
**Lines:** 395
**Purpose:** Intent-based organization: tag suggestions, duplicate detection, and similar task grouping. Supports Issue #8 (Intent-Based Organization).
**Registered Tools:**

| Tool | Description | Required Parameters | Optional Parameters |
|------|-------------|---------------------|---------------------|
| `suggest_tags` | Suggest tags based on title similarity to tagged tasks | `taskId` | -- |
| `find_similar_tasks` | Find groups of similar/duplicate tasks | -- | `search` (text), `taskId` |
| `check_duplicates` | Check if a title matches existing pending tasks | `title` | `threshold` (0-1, default 0.5) |

**Key internals:**
- `tokenize()` — extracts meaningful keywords, filters stop words (100+ English stop words)
- `jaccard()` — Jaccard similarity between keyword sets
- `overlapCount()` — raw word overlap count
- `findAllSimilarGroups()` — clusters all pending tasks by similarity >0.5
- `suggest_tags` scores tags by cumulative word overlap with other tasks sharing those tags

**Key Dependencies:** `ToolRegistry`, `Task` type
**Used By:** `provider.ts` (registration)

---

#### `energy-recommendations.ts`
**Path:** `src/ai/tools/builtin/energy-recommendations.ts`
**Lines:** 144
**Purpose:** Energy-aware task recommendations. Classifies tasks as quick wins or deep work and recommends a set fitting the user's current capacity. Supports Issue #13 (Energy-Aware Planning).
**Registered Tools:**

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_energy_recommendations` | Task recommendations by time/energy | `available_minutes` (default 60), `energy_level` ("low"/"medium"/"high") |

Returns: `{ energyLevel, availableMinutes, quickWins, deepWork, recommended, estimatedMinutes }`

**Classification heuristics:**
- Quick win: short title (<=8 words), no subtasks, low priority, no description. Estimated 10 minutes.
- Deep work: long title, has subtasks, high priority (P1/P2), or has description. Estimated 45 minutes.

**Energy-based ordering:**
- Low energy: quick wins only
- Medium: quick wins first, then deep work
- High: deep work first, then quick wins

Always returns at least one recommendation even if it exceeds the time budget.

**Key Dependencies:** `ToolRegistry`, `Task` type
**Used By:** `provider.ts` (registration)

---

#### `productivity-stats.ts`
**Path:** `src/ai/tools/builtin/productivity-stats.ts`
**Lines:** 163
**Purpose:** Productivity statistics tool. Returns current and best streaks, daily completion/creation counts, time tracked, net progress, and a recent 7-day breakdown. Uses `StatsService` when available for accurate persisted data; falls back to task-based computation otherwise.
**Registered Tools:**

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_productivity_stats` | Get streak, completion counts, and daily trends | `startDate` (YYYY-MM-DD, default 30 days ago), `endDate` (YYYY-MM-DD, default today) |

Returns: `{ range, currentStreak, bestStreak, today: { completed, created, minutesTracked }, summary: { totalCompleted, totalCreated, totalMinutesTracked, daysWithCompletions, daysInRange, avgCompletionsPerDay, netProgress }, recentDays }`

**Fallback behavior:** When `StatsService` is unavailable (e.g., Markdown storage mode), computes statistics from task `completedAt` and `createdAt` fields. `bestStreak`, `minutesTracked`, and `recentDays` are `null` in fallback mode.

**Key Dependencies:** `ToolRegistry`, `StatsService` (optional via `ToolContext`)
**Used By:** `provider.ts` (registration)

---

#### `bulk-operations.ts`
**Path:** `src/ai/tools/builtin/bulk-operations.ts`
**Purpose:** Bulk operation tools for creating, completing, and updating multiple tasks. Enables "brain dump" workflows where users describe multiple tasks at once.
**Registered Tools:**

| Tool | Description | Parameters |
|------|-------------|------------|
| `bulk_create_tasks` | Create multiple tasks at once (brain dumps, meeting notes) | `tasks[]` (title, priority, dueDate, tags, projectId) |
| `bulk_complete_tasks` | Complete multiple tasks at once | `taskIds[]` |
| `bulk_update_tasks` | Update multiple tasks with shared changes | `taskIds[]`, `updates` (priority, dueDate, projectId, tags) |

**Key Dependencies:** `ToolRegistry`
**Used By:** `provider.ts` (registration)

---

#### `memory-tools.ts`
**Path:** `src/ai/tools/builtin/memory-tools.ts`
**Purpose:** AI memory management tools. Allows the AI to save, recall, and forget facts about the user across conversations. Memories are persisted in the `ai_memories` database table.
**Registered Tools:**

| Tool | Description | Parameters |
|------|-------------|------------|
| `save_memory` | Save a fact about the user for future conversations | `content` (string), `category` (preference/habit/context/instruction/pattern) |
| `recall_memories` | Search saved memories by keyword or category | `query` (optional), `category` (optional) |
| `forget_memory` | Delete a saved memory by ID | `memoryId` |

**Key Dependencies:** `ToolRegistry`, `ai_memories` table
**Used By:** `provider.ts` (registration)

---

## Tool Summary

| Tool Name | Category | Description |
|-----------|----------|-------------|
| `create_task` | Task CRUD | Create a new task |
| `update_task` | Task CRUD | Update task fields |
| `complete_task` | Task CRUD | Mark task done |
| `delete_task` | Task CRUD | Delete a task |
| `query_tasks` | Task Query | Search/filter tasks |
| `create_project` | Project CRUD | Create a project |
| `list_projects` | Project CRUD | List all projects |
| `get_project` | Project CRUD | Get project by ID/name |
| `update_project` | Project CRUD | Update project fields |
| `delete_project` | Project CRUD | Delete a project |
| `list_reminders` | Reminders | List tasks with reminders |
| `set_reminder` | Reminders | Set/update reminder |
| `snooze_reminder` | Reminders | Push reminder forward |
| `dismiss_reminder` | Reminders | Clear reminder |
| `list_tags` | Tags | List all tags |
| `add_tags_to_task` | Tags | Add tags to a task |
| `remove_tags_from_task` | Tags | Remove tags from a task |
| `break_down_task` | Organization | Break task into subtasks |
| `analyze_completion_patterns` | Analytics | Productivity pattern analysis |
| `check_overcommitment` | Analytics | Date overload check |
| `analyze_workload` | Analytics | Multi-day workload distribution |
| `suggest_tags` | Smart Organize | Tag recommendations |
| `find_similar_tasks` | Smart Organize | Duplicate/similar task detection |
| `check_duplicates` | Smart Organize | Title similarity check |
| `get_energy_recommendations` | Analytics | Energy-aware task suggestions |
| `get_productivity_stats` | Analytics | Streak, completion counts, daily trends |
| `plan_my_day` | Planning | Morning planning with prioritized task order |
| `daily_review` | Planning | End-of-day review of accomplishments |
| `bulk_create_tasks` | Bulk Operations | Create multiple tasks at once |
| `bulk_complete_tasks` | Bulk Operations | Complete multiple tasks at once |
| `bulk_update_tasks` | Bulk Operations | Update multiple tasks with shared changes |
| `save_memory` | AI Memory | Save a fact about the user |
| `recall_memories` | AI Memory | Search saved memories |
| `forget_memory` | AI Memory | Delete a saved memory |

**Total:** 34 tools across 14 files

All tools are also exposed via the [MCP server](MCP.md) for external AI agents (Claude Desktop, custom assistants, other apps).
