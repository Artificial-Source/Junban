# Plugin Subsystem — Internal Documentation

The plugin subsystem (`src/plugins/`) implements Saydo's Obsidian-style plugin system. It handles plugin discovery, manifest validation, permission-gated loading, lifecycle management, and the API surface that plugins interact with. This document is for **Saydo developers** who need to understand or modify the plugin system internals. For plugin authors, see `docs/plugins/API.md`.

**Total files:** 11 | **Total lines:** ~1,123

---

## Architecture Overview

```
Plugin Directory Scan (discover)
    |
    v
manifest.json Validation (Zod schema)
    |
    v
Permission Check (approved? pending? never seen?)
    |
    v
Settings Load (from DB)
    |
    v
Create Permission-Gated API (createPluginAPI)
    |
    v
Dynamic Import (plugin entry file)
    |
    v
Instantiate Plugin Class
    |
    v
Wire API + Settings
    |
    v
onLoad() lifecycle hook
    |
    v
Plugin Active (commands, UI, events, AI tools registered)
    |
    ... (runtime) ...
    |
    v
onUnload() lifecycle hook
    |
    v
Cleanup (unregister commands, UI, AI providers, tools)
```

---

## Type Definitions

### `types.ts`
**Path:** `src/plugins/types.ts`
**Lines:** 72
**Purpose:** Zod schemas and TypeScript types for plugin manifests, settings, and permissions.
**Key Exports:**
- `SettingDefinition` — Zod discriminated union supporting 4 setting types:
  - `text` — `{ id, name, type: "text", default: string, description?, placeholder? }`
  - `number` — `{ id, name, type: "number", default: number, description?, min?, max? }`
  - `boolean` — `{ id, name, type: "boolean", default: boolean, description? }`
  - `select` — `{ id, name, type: "select", default: string, description?, options: string[] }`
- `PluginManifest` — Zod schema with fields:
  - `id` — lowercase alphanumeric + hyphens (regex: `/^[a-z0-9-]+$/`)
  - `name`, `version`, `author`, `description`, `main` — required strings
  - `minSaydoVersion` — required string
  - `targetApiVersion` — optional semver string for API compatibility checking
  - `permissions` — optional string array (default: `[]`)
  - `settings` — optional array of `SettingDefinition` (default: `[]`)
  - `repository` — optional URL
  - `license` — optional string
  - `keywords` — optional string array (default: `[]`)
  - `dependencies` — optional record of string to string
- `VALID_PERMISSIONS` — const tuple of all recognized permissions:
  - `"task:read"`, `"task:write"` — task access
  - `"ui:panel"`, `"ui:view"`, `"ui:status"` — UI registration
  - `"commands"` — command palette registration
  - `"settings"` — settings access
  - `"storage"` — plugin key-value storage
  - `"network"` — network access
  - `"ai:provider"` — register custom AI providers
  - `"ai:tools"` — register custom AI tools
- `Permission` — union type from `VALID_PERMISSIONS`
**Key Dependencies:** `zod`
**Used By:** `loader.ts`, `api.ts`, `installer.ts`, `registry.ts`, `settings.ts`

---

## Plugin Discovery and Loading

### `loader.ts`
**Path:** `src/plugins/loader.ts`
**Lines:** 375
**Purpose:** Central plugin loader. Discovers plugins from the filesystem, validates manifests, manages permissions, and handles the full load/unload lifecycle.
**Key Exports:**
- `LoadedPlugin` — `{ manifest, path, enabled, instance?, pendingApproval? }`
- `PluginServices` — services injected into the loader:
  - `taskService`, `eventBus`, `settingsManager`, `commandRegistry`, `uiRegistry`, `queries` (IStorage)
  - `aiProviderRegistry?`, `toolRegistry?` — optional AI integration
- `PluginLoader` — class (constructor takes `pluginDir` and `services`):
  - `discover()` — scans the plugin directory, reads and validates `manifest.json` for each subdirectory, returns `LoadedPlugin[]`
  - `load(pluginId)` — full load sequence:
    1. Checks if already loaded
    2. Permission check: if never approved, marks `pendingApproval: true` and skips
    3. Computes effective permissions (intersection of requested and approved)
    4. Warns if plugin targets a newer API major version
    5. Loads settings from DB
    6. Creates permission-gated API via `createPluginAPI()`
    7. Dynamic imports the entry file
    8. Instantiates the default-exported class
    9. Wires `instance.app` and `instance.settings`
    10. Calls `instance.onLoad()`
    11. On failure: cleans up commands, UI, AI providers, tools
  - `approveAndLoad(pluginId, permissions)` — persists permissions to DB, then loads
  - `revokePermissions(pluginId)` — unloads plugin, deletes permissions from DB, marks as pending
  - `unload(pluginId)` — calls `onUnload()`, cleans up commands/UI/AI providers
  - `loadAll()` — discovers and loads all valid plugins
  - `unloadAll()` — unloads all enabled plugins
  - `getAll()` / `get(pluginId)` — accessors
  - `discoverOne(pluginId)` — discovers a single plugin after install
  - `remove(pluginId)` — removes from internal map after uninstall
**Key Dependencies:** `node:fs`, `node:path`, `PluginManifest`, `createPluginAPI`, `Plugin`, all service types
**Used By:** App initialization (`main.ts`), plugin management API routes

---

## Plugin Lifecycle

### `lifecycle.ts`
**Path:** `src/plugins/lifecycle.ts`
**Lines:** 25
**Purpose:** Abstract base class that all plugins must extend.
**Key Exports:**
- `Plugin` — abstract class:
  - `app: PluginAPI` — the Saydo Plugin API (set by loader before `onLoad()`)
  - `settings: PluginSettingsAccessor` — settings accessor (set by loader before `onLoad()`)
  - `abstract onLoad()` — called when the plugin is activated
  - `abstract onUnload()` — called when the plugin is deactivated
  - Optional lifecycle hooks (plugins can override):
    - `onTaskCreate?(task)` — called when a task is created
    - `onTaskComplete?(task)` — called when a task is completed
    - `onTaskUpdate?(task, changes)` — called when a task is updated
    - `onTaskDelete?(task)` — called when a task is deleted
**Key Dependencies:** `Task` type, `PluginAPI`, `PluginSettingsAccessor`
**Used By:** All plugin implementations, `loader.ts`

---

## Plugin API Surface

### `api.ts`
**Path:** `src/plugins/api.ts`
**Lines:** 166
**Purpose:** Creates the permission-gated API object that plugins interact with. Each plugin gets its own API instance with access controlled by its declared permissions.
**Key Exports:**
- `PLUGIN_API_VERSION` — `"1.1.0"` (semver)
- `PLUGIN_API_STABILITY` — `"stable"` (breaking changes require major version bump)
- `PluginAPIOptions` — all services and configuration needed to construct the API
- `PluginSettingsAccessor` — `{ get<T>(key), set(key, value) }`
- `PluginAPI` — return type of `createPluginAPI()`
- `createPluginAPI(options)` — factory function returning:

| Namespace | Permission | Methods |
|-----------|-----------|---------|
| `meta` | none | `version`, `stability` |
| `tasks.list` | `task:read` | `async () => Task[]` |
| `tasks.create` | `task:write` | `async (input) => Task` |
| `commands.register` | `commands` | `(command) => void` — prefixes command ID with `pluginId:` |
| `ui.addSidebarPanel` | `ui:panel` | `(panel) => void` |
| `ui.addView` | `ui:view` | `(view) => void` — accepts `slot?` (default "tools"), `contentType?` (default "text") |
| `ui.addStatusBarItem` | `ui:status` | `(item) => StatusBarHandle` |
| `storage.get` | `storage` | `async <T>(key) => T | null` |
| `storage.set` | `storage` | `async (key, value) => void` |
| `storage.delete` | `storage` | `async (key) => void` |
| `storage.keys` | `storage` | `async () => string[]` |
| `events.on` | `task:read` | `(event, callback) => void` |
| `events.off` | none | `(event, callback) => void` |
| `ai.registerProvider` | `ai:provider` | `(plugin) => void` — prefixes provider name with `pluginId:` |
| `ai.registerTool` | `ai:tools` | `(definition, executor) => void` — registers with source = pluginId |
| `settings.get` | none | `<T>(key) => T` |
| `settings.set` | none | `async (key, value) => void` |

Methods return `undefined` when the plugin lacks the required permission.

**Key Dependencies:** All service types, `LLMProviderPlugin`, `ToolDefinition`, `ToolExecutor`
**Used By:** `loader.ts` (creates API for each plugin)

---

## Sandbox

### `sandbox.ts`
**Path:** `src/plugins/sandbox.ts`
**Lines:** 22
**Purpose:** Plugin sandbox placeholder. Currently a no-op — actual isolation is deferred to Sprint 4.
**Key Exports:**
- `SandboxOptions` — `{ pluginId, pluginDir, permissions }`
- `createSandbox(options)` — returns `{ execute, destroy }` (both no-ops)
**Current state:** Permission checks happen in `createPluginAPI()` (gating access), not via runtime isolation. Plugins run in the same process via `dynamic import()`.
**Future plans:** Full isolation via `vm` module, Web Worker, or iframe.
**Key Dependencies:** None
**Used By:** Not actively used in the current load flow (permission gating is in `api.ts`)

---

## Plugin Registry (Community)

### `registry.ts`
**Path:** `src/plugins/registry.ts`
**Lines:** 72
**Purpose:** Client for the community plugin directory. Fetches and parses the plugin registry (local file or remote URL).
**Key Exports:**
- `RegistryEntry` — Zod-validated shape:
  - `id`, `name`, `description`, `author`, `version`, `repository` — strings
  - `downloadUrl?` — optional URL for tar.gz download
  - `tags` — string array
  - `minSaydoVersion` — string
- `Registry` — `{ version: number, description?, lastUpdated?, plugins: RegistryEntry[] }`
- `PluginRegistry` — class (constructor takes `registryPath`):
  - `loadLocal()` — reads and parses a local JSON file
  - `fetchRemote(url)` — fetches and parses from a URL
  - `search(plugins, query)` — case-insensitive search by name, description, or tags
**Key Dependencies:** `node:fs`, `zod`
**Used By:** Plugin store UI, plugin management API routes

---

## Plugin Installer

### `installer.ts`
**Path:** `src/plugins/installer.ts`
**Lines:** 133
**Purpose:** Downloads and extracts plugin archives from tar.gz URLs. Handles installation and uninstallation.
**Key Exports:**
- `InstallResult` — `{ success, error? }`
- `PluginInstaller` — class (constructor takes `pluginDir`):
  - `install(pluginId, downloadUrl)` — full install sequence:
    1. Checks if already installed
    2. Downloads tar.gz to temp directory
    3. Extracts with `tar`
    4. Locates `manifest.json` (root or single subdirectory)
    5. Validates manifest with Zod
    6. Moves to `plugins/<pluginId>/`
    7. Cleans up temp files
  - `uninstall(pluginId)` — removes plugin directory with `fs.rmSync(recursive)`
**Key Dependencies:** `node:fs`, `node:os`, `node:path`, `node:stream/promises`, `tar`, `PluginManifest`
**Used By:** Plugin store UI, plugin management API routes

---

## Plugin Settings

### `settings.ts`
**Path:** `src/plugins/settings.ts`
**Lines:** 74
**Purpose:** Per-plugin settings manager. In-memory cache backed by database persistence. Defaults come from the plugin manifest.
**Key Exports:**
- `PluginSettingsManager` — class (constructor takes `IStorage`):
  - `get<T>(pluginId, settingId, definitions)` — returns cached value, or manifest default, or throws if unknown setting
  - `getAll(pluginId)` — returns all cached settings for a plugin
  - `set(pluginId, settingId, value)` — updates cache and persists to DB
  - `delete(pluginId, settingId)` — removes from cache and persists
  - `keys(pluginId)` — returns all setting keys
  - `load(pluginId)` — loads from DB into cache (`IStorage.loadPluginSettings()`)
**Key internals:**
- `cache` — `Map<string, Record<string, unknown>>` (plugin ID -> settings object)
- `persist(pluginId)` — serializes cache to JSON and saves via `IStorage.savePluginSettings()`
**Key Dependencies:** `IStorage`, `SettingDefinition`
**Used By:** `loader.ts` (loads settings before plugin activation), `api.ts` (settings accessor)

---

## Command Registry

### `command-registry.ts`
**Path:** `src/plugins/command-registry.ts`
**Lines:** 50
**Purpose:** Stores plugin-registered commands. Commands are callable programmatically and will be wired to the React command palette in Sprint 4.
**Key Exports:**
- `PluginCommand` — `{ id, name, pluginId, callback, hotkey? }`
- `CommandRegistry` — class:
  - `register(cmd)` — registers a command (throws on duplicate ID)
  - `unregister(id)` — removes by ID
  - `unregisterByPlugin(pluginId)` — removes all commands from a specific plugin
  - `get(id)` — lookup
  - `getAll()` — list all commands
  - `execute(id)` — calls the command's callback (throws if not found)
**Key Dependencies:** None
**Used By:** `loader.ts` (cleanup on unload), `api.ts` (register via plugin API)

---

## UI Registry

### `ui-registry.ts`
**Path:** `src/plugins/ui-registry.ts`
**Lines:** 100
**Purpose:** Stores plugin-registered UI components: sidebar panels, views (with slot and content type), and status bar items.
**Key Exports:**
- `ViewSlot` — `"navigation" | "tools" | "workspace"` — determines where a view appears in the sidebar
- `ViewContentType` — `"text" | "structured"` — determines how view content is rendered
- `PanelRegistration` — `{ id, pluginId, title, icon, component?, getContent? }`
- `ViewRegistration` — `{ id, pluginId, name, icon, slot: ViewSlot, contentType: ViewContentType, component?, getContent? }`
- `StatusBarRegistration` — `{ id, pluginId, text, icon, onClick? }`
- `StatusBarHandle` — `{ update(data) }` — allows updating text/icon after registration
- `UIRegistry` — class:
  - `addPanel(panel)` / `addView(view)` / `addStatusBarItem(item)` — register UI components
  - `removeByPlugin(pluginId)` — removes all panels, views, and status bar items from a plugin
  - `getPanels()` / `getViews()` / `getStatusBarItems()` — list all registered components
  - `getPanelContent(id)` / `getViewContent(id)` — calls `getContent()` if available
  - `addStatusBarItem()` returns a `StatusBarHandle` for live updates
**Key Dependencies:** None
**Used By:** `loader.ts` (cleanup on unload), `api.ts` (register via plugin API)

---

## Permission System

Permissions control what parts of the Plugin API a plugin can access. The flow is:

1. **Declaration:** Plugin declares required permissions in `manifest.json` under `permissions[]`
2. **Approval:** On first load, if permissions are non-empty and never approved, the plugin is marked `pendingApproval: true` and skipped
3. **User approves:** `approveAndLoad()` persists approved permissions to the database
4. **Effective permissions:** Intersection of requested (manifest) and approved (DB)
5. **API gating:** `createPluginAPI()` checks `hasPermission()` for each API namespace. Methods return `undefined` (not Error) when permission is missing.
6. **Revocation:** `revokePermissions()` unloads the plugin and deletes DB permissions

### Permission Reference

| Permission | Grants Access To |
|------------|------------------|
| `task:read` | `tasks.list()`, `events.on()` |
| `task:write` | `tasks.create()` |
| `ui:panel` | `ui.addSidebarPanel()` |
| `ui:view` | `ui.addView()` |
| `ui:status` | `ui.addStatusBarItem()` |
| `commands` | `commands.register()` |
| `settings` | (always available via `settings` accessor) |
| `storage` | `storage.get/set/delete/keys()` |
| `network` | (declared intent; not enforced at runtime yet) |
| `ai:provider` | `ai.registerProvider()` |
| `ai:tools` | `ai.registerTool()` |

---

## Data Flow

### Plugin Load Sequence (detailed)

```
1. PluginLoader.discover()
   - fs.readdirSync(pluginDir)
   - For each subdirectory: read manifest.json, validate with Zod
   - Store in internal Map<pluginId, LoadedPlugin>

2. PluginLoader.load(pluginId)
   - Check DB for approved permissions
   - If never approved and permissions required: set pendingApproval, return
   - Check targetApiVersion compatibility
   - PluginSettingsManager.load(pluginId)  [from DB]
   - createPluginAPI({ pluginId, effectivePermissions, ...services })
   - import(path.join(pluginPath, manifest.main))
   - new PluginClass()
   - instance.app = api
   - instance.settings = api.settings
   - instance.onLoad()

3. Runtime
   - Plugin interacts via api.tasks, api.commands, api.ui, api.events, api.ai, api.storage
   - All access checked against permissions

4. PluginLoader.unload(pluginId)
   - instance.onUnload()
   - commandRegistry.unregisterByPlugin(pluginId)
   - uiRegistry.removeByPlugin(pluginId)
   - aiProviderRegistry?.unregisterByPlugin(pluginId)
   - toolRegistry?.unregisterBySource(pluginId)
```

### Plugin Install Sequence

```
1. PluginInstaller.install(pluginId, downloadUrl)
   - Download tar.gz to temp directory
   - Extract with tar
   - Find manifest.json (root or subdirectory)
   - Validate manifest
   - Move to plugins/<pluginId>/

2. PluginLoader.discoverOne(pluginId)
   - Read and validate manifest
   - Add to internal Map

3. PluginLoader.load(pluginId)
   - Normal load sequence (permission check, etc.)
```
