# Frontend API Layer Reference

> Every file in `src/ui/api/` -- the bridge between the UI and backend services.

---

## Architecture Overview

The API layer provides a unified interface for the React frontend to interact with backend services. Every function supports two execution modes:

1. **Server mode** (default) -- makes HTTP `fetch` calls to the Express REST API at `/api/*`
2. **Tauri mode** -- calls backend services directly in-process via lazy-loaded `bootstrapWeb` services

The mode is determined by `isTauri()` from `utils/tauri.js`, which checks for the Tauri runtime. This dual-mode architecture allows the same React code to run both as a web app (with a server) and as a desktop app (with embedded services).

```
src/ui/api/
  index.ts       -- Barrel export combining non-AI modules into a single `api` object
  helpers.ts     -- Shared utilities (isTauri, BASE URL, response handlers)
  direct-services.ts -- Lazy Tauri/bootstrap service loader for in-process mode
  tasks.ts       -- Task CRUD, bulk operations, tree operations, import
  projects.ts    -- Project CRUD, tag listing
  templates.ts   -- Template CRUD and instantiation
  comments.ts    -- Task comment CRUD and activity listing
  sections.ts    -- Project section CRUD and reorder
  stats.ts       -- Productivity stats (daily and today)
  plugins.ts     -- Plugin management, commands, UI registry, store
  ai.ts          -- AI provider config, chat messaging with SSE, model discovery, session management
  settings.ts    -- App settings, storage info, data export
```

---

## index.ts

- **Path:** `src/ui/api/index.ts` (40 lines)
- **Purpose:** Barrel file that imports the general frontend API modules (tasks, templates, projects, sections, comments, stats, plugins, settings) and re-exports them as a single `api` object plus related type re-exports.
- **Key Exports:**
  - `api` -- unified API object with all non-AI functions spread from submodules
  - Type re-exports: `PluginInfo`, `SettingDefinitionInfo`, `PluginCommandInfo`, `StatusBarItemInfo`, `PanelInfo`, `ViewInfo`, `StorePluginInfo`
- **Used By:** General UI codepaths that should not pull AI-specific modules into the default startup graph

---

## helpers.ts

- **Path:** `src/ui/api/helpers.ts` (45 lines)
- **Purpose:** Shared utilities for all API modules.
- **Key Exports:**
  - `isTauri` -- re-exported from `utils/tauri.js`
  - `BASE: string` -- base URL for REST API (`"/api"`)
  - `handleResponse<T>(res: Response): Promise<T>` -- parses JSON response, throws on HTTP error (extracts `error` field from JSON body if available)
  - `handleVoidResponse(res: Response): Promise<void>` -- checks for HTTP error without parsing body

---

## direct-services.ts

- **Path:** `src/ui/api/direct-services.ts`
- **Purpose:** Isolated lazy loader for Tauri/in-process service bootstrap.
- **Key Exports:**
  - `getServices(): Promise<WebServices>` -- lazy-loads and caches `bootstrapWeb()`
  - `WebServices` type -- the return type of `bootstrapWeb()`
- **Notes:** Split out of `helpers.ts` so the common API helper path does not automatically drag the heavy in-process bootstrap loader into every startup module. `getServices()` lazily imports `../../bootstrap-web.js` and caches the result.

---

## tasks.ts

- **Path:** `src/ui/api/tasks.ts` (237 lines)
- **Purpose:** Task CRUD operations, bulk operations, tree/subtask operations, reminders, and import.
- **Key Exports:**

| Function            | Signature                                                        | Description                                 |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| `listTasks`         | `(params?: { search?, projectId?, status? }) => Promise<Task[]>` | List all tasks with optional filters        |
| `createTask`        | `(input: CreateTaskInput) => Promise<Task>`                      | Create a new task                           |
| `completeTask`      | `(id) => Promise<Task>`                                          | Mark task as completed                      |
| `updateTask`        | `(id, input: UpdateTaskInput) => Promise<Task>`                  | Update task fields                          |
| `deleteTask`        | `(id) => Promise<void>`                                          | Delete a task                               |
| `completeManyTasks` | `(ids) => Promise<Task[]>`                                       | Bulk complete                               |
| `deleteManyTasks`   | `(ids) => Promise<void>`                                         | Bulk delete                                 |
| `updateManyTasks`   | `(ids, changes) => Promise<Task[]>`                              | Bulk update                                 |
| `fetchDueReminders` | `() => Promise<Task[]>`                                          | Get tasks with due reminders                |
| `listTaskTree`      | `() => Promise<Task[]>`                                          | Get flat task tree with hierarchy           |
| `getChildren`       | `(parentId) => Promise<Task[]>`                                  | Get subtasks of a parent                    |
| `indentTask`        | `(id) => Promise<Task>`                                          | Make task a subtask of the previous sibling |
| `outdentTask`       | `(id) => Promise<Task>`                                          | Move subtask up one level                   |
| `reorderTasks`      | `(orderedIds) => Promise<void>`                                  | Set manual task ordering                    |
| `importTasks`       | `(tasks: ImportedTask[]) => Promise<ImportResult>`               | Import tasks from external source           |

- **REST Endpoints (server mode):**
  - `GET /api/tasks` (with query params)
  - `POST /api/tasks`
  - `POST /api/tasks/:id/complete`
  - `PATCH /api/tasks/:id`
  - `DELETE /api/tasks/:id`
  - `POST /api/tasks/bulk/complete`
  - `POST /api/tasks/bulk/delete`
  - `POST /api/tasks/bulk/update`
  - `GET /api/tasks/reminders/due`
  - `GET /api/tasks/tree`
  - `GET /api/tasks/:id/children`
  - `POST /api/tasks/:id/indent`
  - `POST /api/tasks/:id/outdent`
  - `POST /api/tasks/reorder`
  - `POST /api/tasks/import`
- **Notes:** Imports now run with rollback safety in both direct-service and server mode. If any item fails, tasks/projects created during that import run are rolled back and the result reports `imported: 0` with error details. In Tauri mode, `svc.save()` is only called after a successful import.

---

## projects.ts

- **Path:** `src/ui/api/projects.ts` (80 lines)
- **Purpose:** Project CRUD and tag listing.
- **Key Exports:**

| Function        | Signature                                                                       | Description                                                                          |
| --------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `listTags`      | `() => Promise<{ id, name, color }[]>`                                          | List all tags                                                                        |
| `listProjects`  | `() => Promise<Project[]>`                                                      | List all projects                                                                    |
| `createProject` | `(name, color?, icon?, parentId?, isFavorite?, viewStyle?) => Promise<Project>` | Create a project with optional hierarchy and display options                         |
| `updateProject` | `(id, data) => Promise<Project \| null>`                                        | Update project fields (name, color, icon, archived, parentId, isFavorite, viewStyle) |
| `deleteProject` | `(id) => Promise<void>`                                                         | Delete a project                                                                     |

- **REST Endpoints (server mode):**
  - `GET /api/tags`
  - `GET /api/projects`
  - `POST /api/projects`
  - `PATCH /api/projects/:id`
  - `DELETE /api/projects/:id`
- **Notes:** In Tauri mode, `createProject` handles icon as a two-step operation (create then update with icon). Project creation supports `parentId` for nested projects, `isFavorite` for pinning, and `viewStyle` for display mode (`"list" | "board" | "calendar"`).

---

## templates.ts

- **Path:** `src/ui/api/templates.ts` (78 lines)
- **Purpose:** Task template CRUD and instantiation.
- **Key Exports:**

| Function              | Signature                                                   | Description                   |
| --------------------- | ----------------------------------------------------------- | ----------------------------- |
| `listTemplates`       | `() => Promise<TaskTemplate[]>`                             | List all templates            |
| `createTemplate`      | `(input: CreateTemplateInput) => Promise<TaskTemplate>`     | Create a template             |
| `updateTemplate`      | `(id, input: UpdateTemplateInput) => Promise<TaskTemplate>` | Update a template             |
| `deleteTemplate`      | `(id) => Promise<void>`                                     | Delete a template             |
| `instantiateTemplate` | `(id, variables?) => Promise<Task>`                         | Create a task from a template |

- **REST Endpoints (server mode):**
  - `GET /api/templates`
  - `POST /api/templates`
  - `PATCH /api/templates/:id`
  - `DELETE /api/templates/:id`
  - `POST /api/templates/:id/instantiate`
- **Notes:** `instantiateTemplate` accepts optional `variables` map for `{{variable}}` interpolation in template title/description.

---

## comments.ts

- **Path:** `src/ui/api/comments.ts` (74 lines)
- **Purpose:** Task comment CRUD and activity feed listing.
- **Key Exports:**

| Function            | Signature                                   | Description                      |
| ------------------- | ------------------------------------------- | -------------------------------- |
| `listTaskComments`  | `(taskId) => Promise<TaskComment[]>`        | List all comments on a task      |
| `addTaskComment`    | `(taskId, content) => Promise<TaskComment>` | Add a comment to a task          |
| `updateTaskComment` | `(commentId, content) => Promise<void>`     | Update a comment's content       |
| `deleteTaskComment` | `(commentId) => Promise<void>`              | Delete a comment                 |
| `listTaskActivity`  | `(taskId) => Promise<TaskActivity[]>`       | List activity history for a task |

- **REST Endpoints (server mode):**
  - `GET /api/tasks/:taskId/comments`
  - `POST /api/tasks/:taskId/comments`
  - `PATCH /api/comments/:commentId`
  - `DELETE /api/comments/:commentId`
  - `GET /api/tasks/:taskId/activity`
- **Notes:** In Tauri mode, `addTaskComment` generates an ID via `generateId()` and constructs the full `TaskComment` object in-process. All mutations call `svc.save()` after writing. Uses `TaskComment` and `TaskActivity` types from `core/types.js`.

---

## sections.ts

- **Path:** `src/ui/api/sections.ts` (72 lines)
- **Purpose:** Project section CRUD and reorder operations.
- **Key Exports:**

| Function          | Signature                                        | Description                            |
| ----------------- | ------------------------------------------------ | -------------------------------------- |
| `listSections`    | `(projectId) => Promise<Section[]>`              | List sections for a project            |
| `createSection`   | `(projectId, name) => Promise<Section>`          | Create a new section                   |
| `updateSection`   | `(id, { name?, isCollapsed? }) => Promise<void>` | Update section name or collapsed state |
| `deleteSection`   | `(id) => Promise<void>`                          | Delete a section                       |
| `reorderSections` | `(orderedIds) => Promise<void>`                  | Set section display order              |

- **REST Endpoints (server mode):**
  - `GET /api/sections?projectId=...`
  - `POST /api/sections`
  - `PATCH /api/sections/:id`
  - `DELETE /api/sections/:id`
  - `POST /api/sections/reorder`
- **Notes:** In Tauri mode, delegates to `svc.sectionService` methods. All mutations call `svc.save()` after writing. Uses `Section` type from `core/types.js`.

---

## stats.ts

- **Path:** `src/ui/api/stats.ts` (24 lines)
- **Purpose:** Fetch productivity statistics for date ranges or today.
- **Key Exports:**

| Function        | Signature                                      | Description                      |
| --------------- | ---------------------------------------------- | -------------------------------- |
| `getDailyStats` | `(startDate, endDate) => Promise<DailyStat[]>` | Get daily stats for a date range |
| `getTodayStats` | `() => Promise<DailyStat>`                     | Get stats for today              |

- **REST Endpoints (server mode):**
  - `GET /api/stats/daily?startDate=...&endDate=...`
  - `GET /api/stats/today`
- **Notes:** In Tauri mode, delegates to `svc.statsService.getStats()` and `svc.statsService.getToday()`. Uses `DailyStat` type from `core/types.js`. Date parameters are `YYYY-MM-DD` format strings.

---

## plugins.ts

- **Path:** `src/ui/api/plugins.ts` (269 lines)
- **Purpose:** Plugin management including lifecycle, settings, commands, UI components, permissions, and the plugin store.
- **Key Exports:**

| Function                   | Signature                                        | Description              |
| -------------------------- | ------------------------------------------------ | ------------------------ |
| `listPlugins`              | `() => Promise<PluginInfo[]>`                    | List installed plugins   |
| `getPluginSettings`        | `(pluginId) => Promise<Record<string, unknown>>` | Get plugin settings      |
| `updatePluginSetting`      | `(pluginId, key, value) => Promise<void>`        | Update a plugin setting  |
| `listPluginCommands`       | `() => Promise<PluginCommandInfo[]>`             | List registered commands |
| `executePluginCommand`     | `(id) => Promise<void>`                          | Execute a command by ID  |
| `getStatusBarItems`        | `() => Promise<StatusBarItemInfo[]>`             | Get status bar items     |
| `getPluginPanels`          | `() => Promise<PanelInfo[]>`                     | Get sidebar panels       |
| `getPluginViews`           | `() => Promise<ViewInfo[]>`                      | Get custom views         |
| `getPluginViewContent`     | `(viewId) => Promise<string>`                    | Get view HTML content    |
| `getPluginPermissions`     | `(pluginId) => Promise<string[] \| null>`        | Get approved permissions |
| `approvePluginPermissions` | `(pluginId, permissions) => Promise<void>`       | Approve permissions      |
| `revokePluginPermissions`  | `(pluginId) => Promise<void>`                    | Revoke permissions       |
| `getPluginStore`           | `() => Promise<{ plugins: StorePluginInfo[] }>`  | Fetch store index        |
| `installPlugin`            | `(pluginId, downloadUrl) => Promise<void>`       | Install from store       |
| `uninstallPlugin`          | `(pluginId) => Promise<void>`                    | Uninstall a plugin       |
| `togglePlugin`             | `(pluginId) => Promise<void>`                    | Enable/disable a plugin  |

- **Key Interfaces:**

```typescript
interface PluginInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  enabled: boolean;
  permissions: string[];
  settings: SettingDefinitionInfo[];
  builtin: boolean;
  icon?: string;
}

interface PluginCommandInfo {
  id: string;
  name: string;
  hotkey?: string;
}
interface StatusBarItemInfo {
  id: string;
  text: string;
  icon: string;
}
interface PanelInfo {
  id: string;
  title: string;
  icon: string;
  content: string;
}
interface ViewInfo {
  id: string;
  name: string;
  icon: string;
}

interface StorePluginInfo {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  repository: string;
  downloadUrl?: string;
  tags: string[];
  minJunbanVersion: string;
  icon?: string;
  downloads?: number;
  longDescription?: string;
}
```

- **Notes:** In Tauri/direct-services mode, built-in plugins are initialized during web bootstrap and surfaced through `listPlugins()`, so plugin views/commands/status items can hydrate without the server route path. Community plugin install/uninstall are still unsupported in this mode, and permission approval/revocation plus toggle fail explicitly because they require the server plugin-management surface. `PluginInfo` includes an optional `icon` field. `StorePluginInfo` includes optional `icon`, `downloads` count, and `longDescription` for the store detail view.

---

## ai.ts

- **Path:** `src/ui/api/ai.ts` (462 lines)
- **Purpose:** AI provider configuration, chat messaging with SSE streaming, model discovery, model lifecycle management, and multi-session chat management.
- **Key Exports:**

| Function               | Signature                                                   | Description                                   |
| ---------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| `listAIProviders`      | `() => Promise<AIProviderInfo[]>`                           | List available AI providers                   |
| `fetchModels`          | `(providerName, baseUrl?) => Promise<ModelDiscoveryInfo[]>` | Discover available models                     |
| `loadModel`            | `(providerName, modelKey, baseUrl?) => Promise<void>`       | Load a model (LM Studio)                      |
| `unloadModel`          | `(providerName, modelKey, baseUrl?) => Promise<void>`       | Unload a model                                |
| `getAIConfig`          | `() => Promise<AIConfigInfo>`                               | Get current AI config                         |
| `updateAIConfig`       | `(config) => Promise<void>`                                 | Update AI config (clears chat session)        |
| `sendChatMessage`      | `(message, options?) => Promise<ReadableStream \| null>`    | Send chat message, returns SSE stream         |
| `getChatMessages`      | `() => Promise<AIChatMessage[]>`                            | Get chat history (restores session if needed) |
| `clearChat`            | `() => Promise<void>`                                       | Clear chat session                            |
| `listChatSessions`     | `() => Promise<ChatSessionInfo[]>`                          | List all chat sessions                        |
| `renameChatSession`    | `(sessionId, title) => Promise<void>`                       | Rename a chat session                         |
| `deleteChatSession`    | `(sessionId) => Promise<void>`                              | Delete a chat session                         |
| `switchChatSession`    | `(sessionId) => Promise<AIChatMessage[]>`                   | Switch to a session, returns its messages     |
| `createNewChatSession` | `() => Promise<string>`                                     | Create a new empty session                    |

- **Key Interfaces:**

```typescript
interface AIConfigInfo {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  hasApiKey: boolean;
}

interface AIChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolResults?: { toolName: string; data: string }[];
  isError?: boolean;
  errorCategory?: string;
  retryable?: boolean;
}

interface ChatSessionInfo {
  sessionId: string;
  title: string;
  createdAt: string;
  messageCount: number;
}

interface AIProviderInfo {
  name: string;
  displayName: string;
  needsApiKey: boolean;
  optionalApiKey?: boolean;
  defaultModel: string;
  suggestedModels?: string[];
  defaultBaseUrl?: string;
  showBaseUrl?: boolean;
  pluginId: string | null;
}

interface ModelDiscoveryInfo {
  id: string;
  label: string;
  loaded: boolean;
}
```

- **REST Endpoints (server mode):**
  - `GET /api/ai/providers`
  - `GET /api/ai/providers/:name/models`
  - `POST /api/ai/providers/:name/models/load`
  - `POST /api/ai/providers/:name/models/unload`
  - `GET /api/ai/config`
  - `PUT /api/ai/config`
  - `POST /api/ai/chat`
  - `GET /api/ai/messages`
  - `POST /api/ai/clear`
  - `GET /api/ai/sessions`
  - `PUT /api/ai/sessions/:id/title`
  - `DELETE /api/ai/sessions/:id`
  - `POST /api/ai/sessions/:id/switch`
  - `POST /api/ai/sessions/new`

- **SSE Stream Format:** `sendChatMessage` returns a `ReadableStream<Uint8Array>`. In Tauri mode, this is constructed in-process by iterating over the chat session's async generator. Each SSE event is `data: {JSON}\n\n` with types: `token`, `tool_call`, `tool_result`, `done`, `error`.
- **Notes:** In Tauri mode, `sendChatMessage` builds the entire AI pipeline in-process: loads provider, gathers context (compact mode for local providers), creates/restores session, and streams events. The `voiceCall` option passes a flag to the context gatherer for voice-optimized prompts. `updateAIConfig` clears the chat session when the provider changes. `getChatMessages` attempts to restore the session from storage if no active session exists. `switchChatSession` in Tauri mode manually reconstructs a `ChatSession` from stored messages. `deleteChatSession` also removes the title override setting. `createNewChatSession` in Tauri mode clears the in-memory session without deleting from the database. In direct-services mode, API key and OAuth token reads/writes use the same encrypted setting helpers as the Hono API path.

---

## settings.ts

- **Path:** `src/ui/api/settings.ts`
- **Purpose:** App settings persistence, storage info, and data export.
- **Key Exports:**

| Function         | Signature                                  | Description              |
| ---------------- | ------------------------------------------ | ------------------------ |
| `exportAllData`  | `() => Promise<{ tasks, projects, tags }>` | Export all data          |
| `getAppSetting`  | `(key) => Promise<string \| null>`         | Get a single setting     |
| `getStorageInfo` | `() => Promise<{ mode, path }>`            | Get storage backend info |
| `setAppSetting`  | `(key, value) => Promise<void>`            | Set a single setting     |

- **REST Endpoints (server mode):**
  - `GET /api/settings/:key`
  - `PUT /api/settings/:key`
  - `GET /api/settings/storage`
- **Notes:** In Tauri mode, `getStorageInfo` always returns `{ mode: "sqlite", path: "(embedded database)" }`. In server mode, `exportAllData` extracts unique tags from task data since there is no dedicated tags export endpoint. Settings are key-value pairs stored in the app_settings table. Used for keyboard shortcuts, notification preferences, AI config, and general settings. In direct-services mode, settings access now mirrors the Hono settings policy: `getAllSettings` filters sensitive keys, `getAppSetting` redacts sensitive values, and `setAppSetting` enforces the writable-key allowlist.
