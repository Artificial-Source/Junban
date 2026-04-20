# Frontend API Layer Reference

> Every file in `src/ui/api/` -- the frontend transport/facade layer between UI state/providers and backend services.

---

## Architecture Overview

The API layer provides a unified interface for the React frontend to interact with backend services. It does not own UI state; contexts/hooks consume this layer. The transport now has three practical runtime shapes:

1. **Server mode** (default) -- makes HTTP `fetch` calls to the Hono API at `/api/*`
2. **Packaged desktop mode** -- makes HTTP `fetch` calls to the localhost Node sidecar API
3. **Direct-services mode** -- lazy-loads `bootstrapWeb()` only for browser-owned embedded runtimes that still keep persistence in-browser

`helpers.ts` decides which transport to use based on the active runtime. This keeps packaged desktop and remote-desktop clients on the backend-owned data/API path while preserving the direct-services loader for runtimes that still do not have a backend.

This reference summarizes stable transport contracts. For exact request/response shapes and implementation details, treat each source file in `src/ui/api/` as canonical.

```
src/ui/api/
  index.ts       -- Barrel export combining non-AI modules into a single `api` object
  helpers.ts     -- Shared utilities (runtime-aware API base, readiness validation, response handlers)
  direct-services.ts -- Lazy Tauri/bootstrap service loader for in-process mode
  desktop-server.ts -- Packaged-desktop remote-access config/status helpers and remote session actions
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

- **Path:** `src/ui/api/index.ts`
- **Purpose:** Barrel file that imports the general frontend API modules (tasks, templates, projects, sections, comments, stats, plugins, settings) and re-exports them as a single `api` object plus related type re-exports.
- **Key Exports:**
  - `api` -- unified API object with all non-AI functions spread from submodules
  - Type re-exports: `PluginInfo`, `SettingDefinitionInfo`, `PluginCommandInfo`, `StatusBarItemInfo`, `PanelInfo`, `ViewInfo`, `StorePluginInfo`
- **Used By:** General UI codepaths that should not pull AI-specific modules into the default startup graph

---

## helpers.ts

- **Path:** `src/ui/api/helpers.ts`
- **Purpose:** Shared utilities for all API modules.
- **Key Exports:**
  - `isTauri` -- re-exported from `utils/tauri.js`
  - `getApiBase(): string` -- resolves the active REST base (`"/api"` in browser/server mode, runtime-provided localhost base in packaged desktop mode)
  - `BASE: string` -- legacy string-like export backed by `getApiBase()` for existing fetch call sites
  - `useDirectServices(): boolean` -- whether the caller should use lazy `bootstrapWeb()` services instead of HTTP
  - `waitForDesktopApiReady(): Promise<void>` -- packaged-desktop startup guard that validates the runtime-provided sidecar health contract before API helpers are used
  - `handleResponse<T>(res: Response): Promise<T>` -- parses JSON response, throws on HTTP error (extracts `error` field from JSON body if available)
  - `handleVoidResponse(res: Response): Promise<void>` -- checks for HTTP error without parsing body
- **Notes:** In packaged desktop mode, Tauri injects `window.__JUNBAN_RUNTIME_READY__` before the UI imports API helpers. That handshake provides the sidecar's dynamic localhost API base plus `ready/error` status. `waitForDesktopApiReady()` first honors that descriptor; only ready descriptors proceed to the health-check probe, and unready descriptors fail fast so the shell can render a controlled startup error state. After startup, the runtime layer also listens for `junban:desktop-runtime-descriptor-changed` events from the Tauri shell and updates `window.__JUNBAN_RUNTIME__` in place so API calls stop using stale ready descriptors if the sidecar later dies. Remote-desktop browsers still use the remote runtime gate/UI, but once authorized they stay on ordinary `fetch("/api/*")` calls and let the Rust host proxy those requests to the desktop sidecar backend. The remote session status read is now side-effect free; passwordless browsers must explicitly `POST` a claim action before API access is authorized.

---

## direct-services.ts

- **Path:** `src/ui/api/direct-services.ts`
- **Purpose:** Isolated lazy loader for browser-owned embedded service bootstrap.
- **Key Exports:**
  - `getServices(): Promise<WebServices>` -- lazy-loads and caches `bootstrapWeb()`
  - `WebServices` type -- the return type of `bootstrapWeb()`
- **Notes:** Split out of `helpers.ts` so the common API helper path does not automatically drag the heavy in-process bootstrap loader into every startup module. `getServices()` lazily imports `../../bootstrap-web.js` and caches the result. Packaged desktop and the remote-desktop browser path no longer use this path for normal app traffic; it remains for runtime shapes that still own persistence in-browser.

---

## desktop-server.ts

- **Path:** `src/ui/api/desktop-server.ts`
- **Purpose:** Thin transport helpers for packaged-desktop remote access settings plus the remote-browser session gate.
- **Key Exports:**
  - `getDesktopRemoteServerStatus()` / `startDesktopRemoteServer()` / `stopDesktopRemoteServer()`
  - `getDesktopRemoteServerConfig()` / `updateDesktopRemoteServerConfig()`
  - `DESKTOP_REMOTE_SERVER_STATUS_CHANGED_EVENT` -- packaged-desktop status sync event for banner/settings UI
  - `getRemoteSessionStatus()` -- read-only session status fetch
  - `claimRemoteSession()` -- explicit passwordless `POST` claim action
  - `loginRemoteSession()` -- passworded `POST` claim action
- **Notes:** Remote browsers should never infer authorization from `GET /_junban/session`. They first read status, then explicitly claim a session with `claimRemoteSession()` when passwordless access is allowed, or `loginRemoteSession()` when password protection is enabled. The packaged desktop UI also dispatches `DESKTOP_REMOTE_SERVER_STATUS_CHANGED_EVENT` after start/stop/status reads so the startup banner, mutation guard, and Settings → Data controls stay synchronized. The Rust host now enforces same-origin browser metadata (`Origin` with `Referer` fallback) for these POST actions and can return lockout responses (`HTTP 429`) after repeated failed password attempts.

---

## tasks.ts

- **Path:** `src/ui/api/tasks.ts`
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

- **Server route family:** `/api/tasks/*` (CRUD, bulk operations, hierarchy operations, reminders, import)
- **Notes:** Imports now run with rollback safety in both direct-service and server mode. If any item fails, tasks/projects created during that import run are rolled back and the result reports `imported: 0` with error details. In Tauri mode, `svc.save()` is only called after a successful import.

---

## projects.ts

- **Path:** `src/ui/api/projects.ts`
- **Purpose:** Project CRUD and tag listing.
- **Key Exports:**

| Function        | Signature                                                                       | Description                                                                          |
| --------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `listTags`      | `() => Promise<{ id, name, color }[]>`                                          | List all tags                                                                        |
| `listProjects`  | `() => Promise<Project[]>`                                                      | List all projects                                                                    |
| `createProject` | `(name, color?, icon?, parentId?, isFavorite?, viewStyle?) => Promise<Project>` | Create a project with optional hierarchy and display options                         |
| `updateProject` | `(id, data) => Promise<Project \| null>`                                        | Update project fields (name, color, icon, archived, parentId, isFavorite, viewStyle) |
| `deleteProject` | `(id) => Promise<void>`                                                         | Delete a project                                                                     |

- **Server route families:** `/api/projects/*` and `/api/tags`
- **Notes:** In Tauri mode, `createProject` handles icon as a two-step operation (create then update with icon). Project creation supports `parentId` for nested projects, `isFavorite` for pinning, and `viewStyle` for display mode (`"list" | "board" | "calendar"`).

---

## templates.ts

- **Path:** `src/ui/api/templates.ts`
- **Purpose:** Task template CRUD and instantiation.
- **Key Exports:**

| Function              | Signature                                                   | Description                   |
| --------------------- | ----------------------------------------------------------- | ----------------------------- |
| `listTemplates`       | `() => Promise<TaskTemplate[]>`                             | List all templates            |
| `createTemplate`      | `(input: CreateTemplateInput) => Promise<TaskTemplate>`     | Create a template             |
| `updateTemplate`      | `(id, input: UpdateTemplateInput) => Promise<TaskTemplate>` | Update a template             |
| `deleteTemplate`      | `(id) => Promise<void>`                                     | Delete a template             |
| `instantiateTemplate` | `(id, variables?) => Promise<Task>`                         | Create a task from a template |

- **Server route family:** `/api/templates/*`
- **Notes:** `instantiateTemplate` accepts optional `variables` map for `{{variable}}` interpolation in template title/description.

---

## comments.ts

- **Path:** `src/ui/api/comments.ts`
- **Purpose:** Task comment CRUD and activity feed listing.
- **Key Exports:**

| Function            | Signature                                   | Description                      |
| ------------------- | ------------------------------------------- | -------------------------------- |
| `listTaskComments`  | `(taskId) => Promise<TaskComment[]>`        | List all comments on a task      |
| `addTaskComment`    | `(taskId, content) => Promise<TaskComment>` | Add a comment to a task          |
| `updateTaskComment` | `(commentId, content) => Promise<void>`     | Update a comment's content       |
| `deleteTaskComment` | `(commentId) => Promise<void>`              | Delete a comment                 |
| `listTaskActivity`  | `(taskId) => Promise<TaskActivity[]>`       | List activity history for a task |

- **Server route families:** `/api/tasks/:taskId/comments`, `/api/comments/:commentId`, `/api/tasks/:taskId/activity`
- **Notes:** In Tauri mode, `addTaskComment` generates an ID via `generateId()` and constructs the full `TaskComment` object in-process. All mutations call `svc.save()` after writing. Uses `TaskComment` and `TaskActivity` types from `core/types.js`.

---

## sections.ts

- **Path:** `src/ui/api/sections.ts`
- **Purpose:** Project section CRUD and reorder operations.
- **Key Exports:**

| Function          | Signature                                        | Description                            |
| ----------------- | ------------------------------------------------ | -------------------------------------- |
| `listSections`    | `(projectId) => Promise<Section[]>`              | List sections for a project            |
| `createSection`   | `(projectId, name) => Promise<Section>`          | Create a new section                   |
| `updateSection`   | `(id, { name?, isCollapsed? }) => Promise<void>` | Update section name or collapsed state |
| `deleteSection`   | `(id) => Promise<void>`                          | Delete a section                       |
| `reorderSections` | `(orderedIds) => Promise<void>`                  | Set section display order              |

- **Server route family:** `/api/sections/*`
- **Notes:** In Tauri mode, delegates to `svc.sectionService` methods. All mutations call `svc.save()` after writing. Uses `Section` type from `core/types.js`.

---

## stats.ts

- **Path:** `src/ui/api/stats.ts`
- **Purpose:** Fetch productivity statistics for date ranges or today.
- **Key Exports:**

| Function        | Signature                                      | Description                      |
| --------------- | ---------------------------------------------- | -------------------------------- |
| `getDailyStats` | `(startDate, endDate) => Promise<DailyStat[]>` | Get daily stats for a date range |
| `getTodayStats` | `() => Promise<DailyStat>`                     | Get stats for today              |

- **Server route family:** `/api/stats/*`
- **Notes:** In Tauri mode, delegates to `svc.statsService.getStats()` and `svc.statsService.getToday()`. Uses `DailyStat` type from `core/types.js`. Date parameters are `YYYY-MM-DD` format strings.

---

## plugins.ts

- **Path:** `src/ui/api/plugins.ts`
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

- **Key interfaces:** Re-exported through `src/ui/api/index.ts` and defined in `src/ui/api/plugins.ts`. Keep that source authoritative to avoid drift in optional fields.

- **Notes:** In Tauri/direct-services mode, built-in plugins are discovered during web bootstrap but stay disabled until the user activates them. Direct-services now supports built-in permission approval, revocation, and toggle so plugin views/commands/status items can appear without the server route path once enabled. Community plugin install/uninstall is still unsupported in this mode. Existing desktop users are grandfathered for the legacy `pomodoro` and `timeblocking` built-ins so upgrades do not silently remove those views. `PluginInfo` includes an optional `icon` field. `StorePluginInfo` includes optional `icon`, `downloads` count, and `longDescription` for the store detail view.

---

## ai.ts

- **Path:** `src/ui/api/ai.ts`
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

- **Key interfaces:** `AIConfigInfo`, `AIChatMessage`, `ChatSessionInfo`, `AIProviderInfo`, and `ModelDiscoveryInfo` are defined in `src/ui/api/ai.ts` and should be treated as canonical.

- **Server route family:** `/api/ai/*` (providers, config, streaming chat, and session management)

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
