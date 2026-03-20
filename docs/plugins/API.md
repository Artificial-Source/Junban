# Plugin API Reference

> **API Version**: 2.0.0 | **Stability**: Stable

## 1. Getting Started

A Saydo plugin is a directory with two files:

```
plugins/my-plugin/
  manifest.json   # Metadata, permissions, settings
  index.ts        # Entry file — exports a Plugin subclass
```

### manifest.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "What this plugin does.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["task:read", "commands"]
}
```

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique identifier. Lowercase letters, digits, and hyphens only (`/^[a-z0-9-]+$/`). |
| `name` | `string` | Human-readable display name. |
| `version` | `string` | Semver version (e.g. `1.0.0`). |
| `author` | `string` | Author name or organization. |
| `description` | `string` | Brief description (shown in the plugin store). |
| `main` | `string` | Entry file path relative to the plugin directory. |
| `minSaydoVersion` | `string` | Minimum Saydo version required. |

**Optional fields:**

| Field | Type | Description |
|-------|------|-------------|
| `targetApiVersion` | `string` | Plugin API version this plugin targets. If the plugin targets a newer major version than the running Saydo, a warning is logged. |
| `icon` | `string` | Emoji or icon name for the plugin. |
| `permissions` | `string[]` | Required permissions (see [Permissions](#2-permissions)). Defaults to `[]`. |
| `settings` | `SettingDefinition[]` | Plugin settings schema (see [Settings](#9-settings)). |
| `repository` | `string` | URL to source code repository. |
| `license` | `string` | SPDX license identifier. |
| `keywords` | `string[]` | Tags for plugin discovery. |
| `dependencies` | `Record<string, string>` | Other plugins this plugin depends on. |

### Entry File

```typescript
import { Plugin } from "../../src/plugins/lifecycle.js";

export default class MyPlugin extends Plugin {
  async onLoad() {
    // Called when the plugin is activated.
    // Register commands, views, panels, event listeners here.
  }

  async onUnload() {
    // Called when the plugin is deactivated.
    // Clean up timers, event listeners, subscriptions.
    // Commands, UI panels, views, and status bar items are auto-removed.
  }
}
```

### Properties Available in `this`

| Property | Type | Description |
|----------|------|-------------|
| `this.app` | `PluginAPI` | The full Saydo API. Every method is always present. Methods you lack permission for throw a clear error. |
| `this.settings` | `PluginSettingsAccessor` | Read/write this plugin's settings. |

### Lifecycle

1. Saydo discovers the plugin directory and validates `manifest.json`.
2. The user approves the requested permissions.
3. Saydo calls `onLoad()`. Register everything here.
4. The plugin is active until the user disables it or Saydo shuts down.
5. Saydo calls `onUnload()`. Clean up side effects here.

## 2. Permissions

Plugins declare required permissions in `manifest.json`. Users see these permissions before activating the plugin.

| Permission | Grants Access To |
|------------|-----------------|
| `task:read` | `tasks.list()`, `tasks.get()`, `events.on()` |
| `task:write` | `tasks.create()`, `tasks.update()`, `tasks.complete()`, `tasks.uncomplete()`, `tasks.delete()` |
| `project:read` | `projects.list()`, `projects.get()` |
| `project:write` | `projects.create()`, `projects.update()`, `projects.delete()` |
| `tag:read` | `tags.list()` |
| `tag:write` | `tags.create()`, `tags.delete()` |
| `ui:panel` | `ui.addSidebarPanel()` |
| `ui:view` | `ui.addView()` |
| `ui:status` | `ui.addStatusBarItem()` |
| `commands` | `commands.register()` |
| `settings` | Settings tab in the Settings view |
| `storage` | `storage.get()`, `storage.set()`, `storage.delete()`, `storage.keys()` |
| `network` | `network.fetch()` |
| `ai:provider` | `ai.registerProvider()` |
| `ai:tools` | `ai.registerTool()` |

### How Permission Errors Work

Every API method is always present on `this.app` -- there is no `undefined`. If you call a method without the required permission, it throws an error with a clear message:

```
Plugin "my-plugin" requires the "task:write" permission to call tasks.create().
Add "task:write" to the "permissions" array in your manifest.json.
```

This means:
- No optional chaining (`?.`) needed -- ever.
- TypeScript types are always clean.
- Errors tell you exactly what to fix.

## 3. Task API

### `tasks.list(filter?)`

**Permission:** `task:read`

```typescript
// List all tasks
const tasks = await this.app.tasks.list();

// List with a filter
const pending = await this.app.tasks.list({ status: "pending" });
const overdue = await this.app.tasks.list({ overdue: true });
```

**Parameters:**
- `filter` (optional): `TaskFilter` object with fields like `status`, `projectId`, `tag`, `overdue`, `search`, etc.

**Returns:** `Promise<Task[]>`

### `tasks.get(id)`

**Permission:** `task:read`

```typescript
const task = await this.app.tasks.get("task-id");
if (task) {
  console.log(task.title, task.status, task.priority);
}
```

**Parameters:**
- `id`: `string` -- the task ID.

**Returns:** `Promise<Task | null>` -- `null` if not found.

### `tasks.create(input)`

**Permission:** `task:write`

```typescript
const task = await this.app.tasks.create({
  title: "Review PR #42",
  priority: 2,
  dueDate: new Date().toISOString(),
  tags: ["work", "code-review"],
  projectId: "project-id",
});
```

**Parameters:**
- `input`: `CreateTaskInput` object:
  - `title` (required): `string` (1-500 chars)
  - `description` (optional): `string | null`
  - `priority` (optional): `1 | 2 | 3 | 4 | null`
  - `dueDate` (optional): ISO 8601 datetime string or `null`
  - `dueTime` (optional): `boolean` (default `false` -- whether dueDate includes a time component)
  - `projectId` (optional): `string | null`
  - `tags` (optional): `string[]` (tag names, created if they don't exist)
  - `recurrence` (optional): `string | null` (e.g. `"daily"`, `"weekly"`)
  - `parentId` (optional): `string | null` (for sub-tasks)
  - `remindAt` (optional): ISO 8601 datetime string or `null`
  - `estimatedMinutes` (optional): `number | null`
  - `deadline` (optional): ISO 8601 datetime string or `null`
  - `isSomeday` (optional): `boolean`
  - `sectionId` (optional): `string | null`
  - `dreadLevel` (optional): `1-5 | null`

**Returns:** `Promise<Task>`

### `tasks.update(id, changes)`

**Permission:** `task:write`

```typescript
await this.app.tasks.update("task-id", {
  title: "Updated title",
  priority: 1,
  tags: ["urgent"],
});
```

**Parameters:**
- `id`: `string`
- `changes`: `UpdateTaskInput` -- partial `CreateTaskInput` plus optional `status` and `completedAt`.

**Returns:** `Promise<Task>` -- the updated task.

**Throws:** `NotFoundError` if the task doesn't exist.

### `tasks.complete(id)`

**Permission:** `task:write`

```typescript
const completed = await this.app.tasks.complete("task-id");
// completed.status === "completed"
// completed.completedAt is set
```

**Returns:** `Promise<Task>` -- the completed task.

**Throws:** `NotFoundError` if the task doesn't exist.

**Side effects:** If the task has a recurrence rule, a new occurrence is automatically created.

### `tasks.uncomplete(id)`

**Permission:** `task:write`

```typescript
const reopened = await this.app.tasks.uncomplete("task-id");
// reopened.status === "pending"
// reopened.completedAt === null
```

**Returns:** `Promise<Task>` -- the uncompleted task.

**Throws:** `NotFoundError` if the task doesn't exist.

### `tasks.delete(id)`

**Permission:** `task:write`

```typescript
const wasDeleted = await this.app.tasks.delete("task-id");
// wasDeleted === true if the task existed
```

**Returns:** `Promise<boolean>` -- `true` if the task was deleted.

## 4. Project API

### `projects.list()`

**Permission:** `project:read`

```typescript
const projects = await this.app.projects.list();
for (const project of projects) {
  console.log(project.name, project.color);
}
```

**Returns:** `Promise<Project[]>`

### `projects.get(id)`

**Permission:** `project:read`

```typescript
const project = await this.app.projects.get("project-id");
```

**Returns:** `Promise<Project | null>`

### `projects.create(name, opts?)`

**Permission:** `project:write`

```typescript
const project = await this.app.projects.create("Work", {
  color: "#3b82f6",
  viewStyle: "board",
});
```

**Parameters:**
- `name`: `string`
- `opts` (optional): `{ color?: string, parentId?: string | null, isFavorite?: boolean, viewStyle?: "list" | "board" | "calendar" }`

**Returns:** `Promise<Project>`

### `projects.update(id, changes)`

**Permission:** `project:write`

```typescript
await this.app.projects.update("project-id", {
  name: "Renamed",
  color: "#ef4444",
  archived: true,
});
```

**Parameters:**
- `id`: `string`
- `changes`: `Partial<{ name, color, icon, archived, parentId, isFavorite, viewStyle }>`

**Returns:** `Promise<Project | null>` -- `null` if the project doesn't exist.

### `projects.delete(id)`

**Permission:** `project:write`

```typescript
const wasDeleted = await this.app.projects.delete("project-id");
```

**Returns:** `Promise<boolean>`

## 5. Tag API

### `tags.list()`

**Permission:** `tag:read`

```typescript
const tags = await this.app.tags.list();
for (const tag of tags) {
  console.log(tag.name, tag.color);
}
```

**Returns:** `Promise<Tag[]>`

### `tags.create(name, color?)`

**Permission:** `tag:write`

```typescript
const tag = await this.app.tags.create("urgent", "#ef4444");
```

**Parameters:**
- `name`: `string` (auto-lowercased and trimmed)
- `color` (optional): `string` (hex color, defaults to `"#6b7280"`)

**Returns:** `Promise<Tag>`

### `tags.delete(id)`

**Permission:** `tag:write`

```typescript
const wasDeleted = await this.app.tags.delete("tag-id");
```

**Returns:** `Promise<boolean>`

## 6. Events

**Permission:** `task:read` (required for `events.on()`)

### Subscribing

```typescript
async onLoad() {
  this.app.events.on("task:create", this.handleCreate);
  this.app.events.on("task:complete", this.handleComplete);
}

async onUnload() {
  // IMPORTANT: Always remove your listeners in onUnload.
  // Events are NOT auto-removed.
  this.app.events.off("task:create", this.handleCreate);
  this.app.events.off("task:complete", this.handleComplete);
}

// Use arrow functions so `this` is correctly bound:
private handleCreate = (task: Task) => { /* ... */ };
private handleComplete = (task: Task) => { /* ... */ };
```

### Available Events

| Event | Payload Type | When |
|-------|-------------|------|
| `task:create` | `Task` | After a task is created |
| `task:complete` | `Task` | After a task is marked complete |
| `task:uncomplete` | `Task` | After a completed task is set back to pending |
| `task:update` | `{ task: Task; changes: Partial<Task> }` | After a task is modified |
| `task:delete` | `Task` | After a task is deleted |
| `task:moved` | `{ task: Task; fromProjectId: string \| null; toProjectId: string \| null }` | After a task is moved between projects |
| `task:estimated` | `{ task: Task; previousMinutes: number \| null; newMinutes: number \| null }` | After a task's estimated minutes changes |
| `task:reorder` | `string[]` | After tasks are reordered (array of IDs) |
| `section:create` | `Section` | After a section is created |
| `section:update` | `Section` | After a section is updated |
| `section:delete` | `Section` | After a section is deleted |
| `section:reorder` | `string[]` | After sections are reordered |

## 7. Commands

**Permission:** `commands`

```typescript
this.app.commands.register({
  id: "do-thing",          // Prefixed with pluginId automatically: "my-plugin:do-thing"
  name: "Do the Thing",    // Shown in command palette
  callback: () => {
    // Called when the user runs this command
  },
  hotkey: "Ctrl+Shift+T",  // Optional keyboard shortcut
});
```

Commands appear in the command palette (Ctrl+K). They are auto-removed when the plugin is unloaded.

## 8. UI

### Sidebar Panel (`ui:panel`)

```typescript
this.app.ui.addSidebarPanel({
  id: "my-panel",
  title: "My Panel",
  icon: "list",
  contentType: "react",       // "text" (default) or "react"
  component: MyPanelComponent, // Required if contentType is "react"
  render: () => "Hello",       // Required if contentType is "text"
});
```

### Custom View (`ui:view`)

```typescript
this.app.ui.addView({
  id: "my-view",
  name: "My View",
  icon: "columns",
  slot: "tools",              // "navigation" | "tools" (default) | "workspace"
  contentType: "react",       // "text" | "structured" | "react"
  component: MyViewComponent, // Required if contentType is "react"
  render: () => "Hello",      // Required if contentType is "text" or "structured"
});
```

**View Slots:**

| Slot | Sidebar Location |
|------|-----------------|
| `navigation` | After built-in nav items (Inbox, Today, etc.) |
| `tools` | Collapsible "Tools" section (default) |
| `workspace` | Bottom section alongside AI Chat and Settings |

**Content Types:**

| Type | Description | When to Use |
|------|-------------|-------------|
| `text` | Plain text returned by `render()`. Rendered as a simple text block. | Static info, summaries, logs. |
| `structured` | JSON string returned by `render()` describing a structured UI layout with elements like buttons, progress bars, badges, and text. | Interactive views without React (timers, dashboards). Works in all plugin types. |
| `react` | React component passed via the `component` property. Full React rendering with hooks, state, and event handlers. | Rich interactive UIs. Best for built-in plugins that ship with the app. Community plugins should prefer `structured` for portability. |

**Choosing a content type:**

- Use `text` for the simplest case -- just showing a string.
- Use `structured` when you need interactive elements (buttons, progress bars) but want your plugin to work without bundling React. The JSON format supports: `text`, `button`, `progress`, `badge`, `row`, `spacer`, and more.
- Use `react` when you need full control over rendering. Note that React components only work for built-in plugins that are compiled alongside Saydo. Community plugins distributed as standalone files should use `structured` instead.

### Status Bar (`ui:status`)

```typescript
const handle = this.app.ui.addStatusBarItem({
  id: "my-status",
  text: "Ready",
  icon: "timer",
  onClick: () => { /* ... */ },
});

// Update later:
handle.update({ text: "Running", icon: "play" });
```

The `addStatusBarItem()` call returns a handle object with an `update()` method. Call `handle.update({ text, icon })` to change the displayed text or icon at any time -- this is how you build live-updating status indicators (e.g., a running timer).

Status bar items are auto-removed when the plugin is unloaded.

## 9. Settings

Settings are defined in `manifest.json` and shown in the Settings view (Settings > Plugins > Your Plugin). Plugins read their values at runtime:

```typescript
const value = this.settings.get<number>("workMinutes"); // Returns the user's value or the manifest default
await this.settings.set("workMinutes", 30);             // Override the value
```

### Setting Types

```json
{
  "settings": [
    { "id": "name", "name": "Display Name", "type": "text", "default": "hello", "placeholder": "Enter name..." },
    { "id": "count", "name": "Count", "type": "number", "default": 25, "min": 1, "max": 120 },
    { "id": "enabled", "name": "Enabled", "type": "boolean", "default": true },
    { "id": "mode", "name": "Mode", "type": "select", "default": "auto", "options": ["auto", "manual", "off"] }
  ]
}
```

Each setting has: `id`, `name`, `type`, `default`, and optional `description`.

### Settings UI (Automatic Rendering)

When a plugin declares `settings` in its manifest, Saydo automatically renders a settings form in the plugin settings panel (Settings > Plugins > Your Plugin). No UI code is needed from the plugin author.

| Type | Rendered As |
|------|-------------|
| `text` | Text input. Supports optional `placeholder`. |
| `number` | Number input with stepper. Supports optional `min` and `max`. |
| `boolean` | Toggle switch. |
| `select` | Dropdown menu. Requires `options` array of strings. |

Each setting's `name` is used as the label and `description` (if provided) appears as helper text below the input. The `default` value is used until the user changes it.

## 10. Storage

**Permission:** `storage`

Plugin-specific key-value storage, isolated from other plugins. Persisted to the database.

```typescript
// Write
await this.app.storage.set("sessions-today", 3);
await this.app.storage.set("history", [{ date: "2025-01-15", count: 8 }]);

// Read
const count = await this.app.storage.get<number>("sessions-today");    // 3 or null
const history = await this.app.storage.get<object[]>("history");       // array or null

// Delete
await this.app.storage.delete("sessions-today");

// List all keys
const keys = await this.app.storage.keys(); // ["history"]
```

### Settings vs. Storage

| | Settings | Storage |
|---|---------|---------|
| Defined in | `manifest.json` | Code |
| UI | Auto-generated settings tab | None |
| Use for | User-configurable options | Plugin internal state |
| Defaults | Manifest `default` value | `null` |
| Permission | Always available | Requires `storage` |

## 11. Network

**Permission:** `network`

```typescript
const response = await this.app.network.fetch("https://api.example.com/data", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ key: "value" }),
});
const data = await response.json();
```

Wraps the standard `fetch()` API. All requests are logged.

## 12. AI

### Register a Provider (`ai:provider`)

```typescript
this.app.ai.registerProvider({
  name: "my-provider",
  // ... LLMProviderPlugin interface
});
```

### Register a Tool (`ai:tools`)

```typescript
this.app.ai.registerTool(
  {
    name: "my-tool",
    description: "Does something useful",
    parameters: { /* JSON Schema */ },
  },
  async (params) => {
    // Tool executor
    return { result: "done" };
  },
);
```

## 13. Error Handling

- **Permission errors**: Thrown synchronously with a message telling you which permission to add.
- **Not found errors**: `tasks.update()`, `tasks.complete()`, `tasks.uncomplete()` throw `NotFoundError` if the task ID doesn't exist.
- **Plugin crashes**: If `onLoad()` throws, the plugin is disabled and all its registrations are cleaned up.
- **Event listener errors**: Errors in event callbacks are caught and logged. They don't crash the app or other listeners.

## 14. Best Practices for AI-Generated Plugins

1. **Never use optional chaining on `this.app`**. Every method is always a function. If permission is missing, it throws.
2. **Declare all needed permissions in manifest.json**. The error message tells you exactly what to add.
3. **Use arrow functions for event handlers** so `this` is correctly bound.
4. **Clean up event listeners in `onUnload()`**. Events are NOT auto-removed. Commands, UI panels, and status bar items ARE auto-removed.
5. **Use `storage` for persistent state, `settings` for user-configurable options**.
6. **Keep `onLoad()` fast**. Don't do heavy computation during startup.

## Type Reference

### Task

```typescript
interface Task {
  id: string;
  title: string;
  description: string | null;
  status: "pending" | "completed" | "cancelled";
  priority: 1 | 2 | 3 | 4 | null;
  dueDate: string | null;       // ISO 8601 datetime
  dueTime: boolean;
  completedAt: string | null;   // ISO 8601 datetime
  projectId: string | null;
  recurrence: string | null;
  parentId: string | null;
  remindAt: string | null;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  deadline: string | null;
  isSomeday: boolean;
  sectionId: string | null;
  dreadLevel: number | null;    // 1-5
  tags: Tag[];
  children?: Task[];
  sortOrder: number;
  createdAt: string;            // ISO 8601 datetime
  updatedAt: string;            // ISO 8601 datetime
}
```

### Project

```typescript
interface Project {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  parentId: string | null;
  isFavorite: boolean;
  viewStyle: "list" | "board" | "calendar";
  sortOrder: number;
  archived: boolean;
  createdAt: string;
}
```

### Tag

```typescript
interface Tag {
  id: string;
  name: string;
  color: string;
}
```

## API Versioning

The Plugin API follows semver. The current version is `2.0.0`.

| Version Change | Meaning |
|----------------|---------|
| Major (3.0.0) | Breaking changes -- plugins may need updates |
| Minor (2.1.0) | Additive -- new features, fully backward-compatible |
| Patch (2.0.1) | Bug fixes only -- no API surface changes |

Plugins can check the version at runtime:

```typescript
console.log(this.app.meta.version);   // "2.0.0"
console.log(this.app.meta.stability); // "stable"
```
