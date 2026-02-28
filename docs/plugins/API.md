# Plugin API Reference

## Overview

Saydo's plugin system is inspired by Obsidian. Plugins are JS/TS packages that extend the app's functionality through a controlled API surface. Plugins can register commands, add UI panels and views, hook into task lifecycle events, and manage their own settings.

## Quick Start

```bash
# Create a plugin directory
mkdir -p plugins/my-plugin

# Create manifest
cat > plugins/my-plugin/manifest.json << 'EOF'
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "A brief description of what this plugin does",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["task:read", "commands"]
}
EOF

# Create entry file
cat > plugins/my-plugin/index.ts << 'EOF'
import { Plugin } from "@asf-saydo/plugin-api";

export default class MyPlugin extends Plugin {
  async onLoad() {
    console.log("My plugin loaded!");
  }

  async onUnload() {
    console.log("My plugin unloaded!");
  }
}
EOF
```

Restart Saydo (or toggle the plugin in Settings) to activate.

## Plugin Manifest

Every plugin must have a `manifest.json` in its root directory.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (lowercase, hyphens, e.g., `my-plugin`) |
| `name` | string | Human-readable display name |
| `version` | string | Semver version (e.g., `1.0.0`) |
| `author` | string | Author name or organization |
| `description` | string | Brief description (shown in plugin store) |
| `main` | string | Entry file path relative to plugin directory |
| `minSaydoVersion` | string | Minimum Saydo version required |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `targetApiVersion` | string | Plugin API version this plugin targets (see [API Versioning](#api-versioning--stability)) |
| `permissions` | string[] | Required permissions (see [Permissions](#permissions)) |
| `settings` | SettingDef[] | Plugin settings schema (see [Settings](#settings-api)) |
| `repository` | string | URL to source code |
| `license` | string | SPDX license identifier |
| `keywords` | string[] | Tags for plugin discovery |
| `dependencies` | object | Other plugins this plugin depends on |

### Full Example

```json
{
  "id": "pomodoro-timer",
  "name": "Pomodoro Timer",
  "version": "1.2.0",
  "author": "ASF",
  "description": "Pomodoro technique timer with task integration and statistics.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "license": "MIT",
  "repository": "https://github.com/asf-org/saydo-plugin-pomodoro",
  "keywords": ["pomodoro", "timer", "productivity"],
  "permissions": ["task:read", "task:write", "ui:panel", "ui:status", "commands", "storage"],
  "settings": [
    {
      "id": "workMinutes",
      "name": "Work Duration",
      "type": "number",
      "default": 25,
      "description": "Length of a work interval in minutes",
      "min": 1,
      "max": 120
    },
    {
      "id": "breakMinutes",
      "name": "Break Duration",
      "type": "number",
      "default": 5,
      "description": "Length of a break interval in minutes",
      "min": 1,
      "max": 60
    },
    {
      "id": "autoStartBreak",
      "name": "Auto-start Break",
      "type": "boolean",
      "default": true,
      "description": "Automatically start break timer after work interval"
    },
    {
      "id": "notificationSound",
      "name": "Notification Sound",
      "type": "select",
      "default": "bell",
      "description": "Sound to play when timer ends",
      "options": ["bell", "chime", "ding", "none"]
    }
  ]
}
```

## Plugin Base Class

All plugins extend the `Plugin` base class:

```typescript
import { Plugin, type SaydoAPI, type PluginManifest } from "@asf-saydo/plugin-api";

export default class MyPlugin extends Plugin {
  // Called when the plugin is activated
  async onLoad(): Promise<void> {}

  // Called when the plugin is deactivated
  async onUnload(): Promise<void> {}
}
```

### Properties Available in `this`

| Property | Type | Description |
|----------|------|-------------|
| `this.app` | `SaydoAPI` | Full Saydo API access (filtered by permissions) |
| `this.manifest` | `PluginManifest` | This plugin's parsed manifest |
| `this.settings` | `PluginSettings` | This plugin's settings (read/write) |

## Lifecycle Hooks

### Core Lifecycle

```typescript
export default class MyPlugin extends Plugin {
  async onLoad(): Promise<void> {
    // Plugin is being activated
    // Register commands, views, panels, event listeners here
  }

  async onUnload(): Promise<void> {
    // Plugin is being deactivated
    // Clean up timers, listeners, subscriptions
    // UI elements are auto-removed, but clean up any side effects
  }
}
```

### Task Event Hooks

Register listeners for task events in `onLoad()`:

```typescript
async onLoad() {
  // Listen to task creation
  this.app.events.on("task:create", (task: Task) => {
    console.log(`Task created: ${task.title}`);
  });

  // Listen to task completion
  this.app.events.on("task:complete", (task: Task) => {
    console.log(`Task completed: ${task.title}`);
  });

  // Listen to task updates
  this.app.events.on("task:update", (task: Task, changes: Partial<Task>) => {
    console.log(`Task updated: ${task.title}`, changes);
  });

  // Listen to task deletion
  this.app.events.on("task:delete", (task: Task) => {
    console.log(`Task deleted: ${task.title}`);
  });
}
```

### Available Events

| Event | Payload | When |
|-------|---------|------|
| `task:create` | `(task: Task)` | After a task is created |
| `task:complete` | `(task: Task)` | After a task is marked complete |
| `task:uncomplete` | `(task: Task)` | After a task is uncompleted |
| `task:update` | `(task: Task, changes: Partial<Task>)` | After a task is modified |
| `task:delete` | `(task: Task)` | After a task is deleted |
| `project:create` | `(project: Project)` | After a project is created |
| `project:delete` | `(project: Project)` | After a project is deleted |
| `settings:change` | `(key: string, value: unknown)` | After app settings change |
| `plugin:settings:change` | `(settings: Record<string, unknown>)` | After this plugin's settings change |
| `theme:change` | `(theme: string)` | After theme is switched |

## Saydo API

The `this.app` object provides access to Saydo functionality, filtered by the plugin's declared permissions.

### Task API (`task:read` + `task:write`)

```typescript
// Read tasks
const tasks = await this.app.tasks.list({ project: "work", status: "pending" });
const task = await this.app.tasks.get("task-id");
const today = await this.app.tasks.listToday();
const overdue = await this.app.tasks.listOverdue();

// Write tasks (requires task:write)
const newTask = await this.app.tasks.create({
  title: "Review PR",
  dueDate: new Date("2025-02-01"),
  priority: 2,
  tags: ["dev"],
  project: "work",
});

await this.app.tasks.update("task-id", { priority: 1 });
await this.app.tasks.complete("task-id");
await this.app.tasks.uncomplete("task-id");
await this.app.tasks.delete("task-id");
```

### Project API (`task:read` + `task:write`)

```typescript
const projects = await this.app.projects.list();
const project = await this.app.projects.get("project-id");
const newProject = await this.app.projects.create({ name: "Work", color: "#3b82f6" });
await this.app.projects.update("project-id", { color: "#ef4444" });
await this.app.projects.archive("project-id");
await this.app.projects.delete("project-id");
```

### Tag API (`task:read` + `task:write`)

```typescript
const tags = await this.app.tags.list();
const tagged = await this.app.tasks.list({ tag: "urgent" });
await this.app.tags.create({ name: "urgent", color: "#ef4444" });
await this.app.tags.delete("tag-id");
```

### Command API (`commands`)

```typescript
// Register a command (appears in command palette, can have a hotkey)
this.app.commands.register({
  id: "pomodoro:start",
  name: "Start Pomodoro Timer",
  icon: "timer",
  hotkey: "Ctrl+Shift+P",
  callback: () => {
    this.startTimer();
  },
});

// Register a command with a check function (only shown when condition is met)
this.app.commands.register({
  id: "pomodoro:stop",
  name: "Stop Pomodoro Timer",
  check: () => this.isTimerRunning,
  callback: () => {
    this.stopTimer();
  },
});
```

### UI API

#### Sidebar Panel (`ui:panel`)

```typescript
// Add a panel to the sidebar
this.app.ui.addSidebarPanel({
  id: "pomodoro-panel",
  title: "Pomodoro",
  icon: "timer",
  component: PomodoroPanel, // React component
});
```

#### Custom View (`ui:view`)

```typescript
// Register a full-page view (text content, default)
this.app.ui.addView({
  id: "kanban",
  name: "Kanban Board",
  icon: "columns",
  component: KanbanView, // React component
});

// Register a view with structured JSON content (interactive UI)
this.app.ui.addView({
  id: "my-timer",
  name: "Timer",
  icon: "⏱️",
  slot: "tools",         // "navigation" | "tools" | "workspace" (default: "tools")
  contentType: "structured", // "text" | "structured" (default: "text")
  render: () => JSON.stringify({
    layout: "center",
    elements: [
      { type: "text", value: "25:00", variant: "mono" },
      { type: "progress", value: 60, max: 100, color: "accent" },
      { type: "row", justify: "center", gap: "md", elements: [
        { type: "button", label: "Start", commandId: "my-plugin:start", variant: "primary" },
        { type: "button", label: "Reset", commandId: "my-plugin:reset", variant: "ghost" },
      ]},
      { type: "badge", value: "Idle", color: "default" },
    ],
  }),
});
```

##### View Slots

| Slot | Sidebar Location | Notes |
|------|-----------------|-------|
| `navigation` | After built-in nav items (Inbox, Today, etc.) | Restricted to built-in plugins |
| `tools` | Collapsible "Tools" section between projects and workspace | Default for all plugins |
| `workspace` | Bottom section alongside AI Chat and Settings | |

##### Structured Content Elements

| Type | Props | Renders As |
|------|-------|-----------|
| `text` | `value`, `variant` (title/subtitle/body/caption/mono) | Styled text |
| `badge` | `value`, `color` (default/accent/success/warning/error) | Rounded pill |
| `progress` | `value`, `max`, `label?`, `color?` | Progress bar |
| `button` | `label`, `commandId`, `variant` (primary/secondary/ghost) | Button that executes a plugin command |
| `divider` | — | Horizontal rule |
| `row` | `elements[]`, `gap?` (sm/md/lg), `justify?` (start/center/end/between) | Flex row |
| `spacer` | `size` (sm/md/lg) | Vertical spacing |

Unknown element types are silently skipped (forward-compatible).

#### Status Bar (`ui:status`)

```typescript
// Add an item to the status bar
const statusItem = this.app.ui.addStatusBarItem({
  id: "pomodoro-status",
  text: "25:00",
  icon: "timer",
  onClick: () => this.toggleTimer(),
});

// Update it later
statusItem.update({ text: "24:59" });
```

### Storage API (`storage`)

Plugin-specific key-value storage, isolated from other plugins:

```typescript
// Store data
await this.app.storage.set("sessions-today", 3);
await this.app.storage.set("history", [{ date: "2025-01-15", sessions: 8 }]);

// Read data
const count = await this.app.storage.get<number>("sessions-today");
const history = await this.app.storage.get<SessionHistory[]>("history");

// Delete data
await this.app.storage.delete("sessions-today");

// List all keys
const keys = await this.app.storage.keys();
```

### Settings API (`settings`)

Settings are defined in `manifest.json` and managed by Saydo. Plugins read their values:

```typescript
// Read a setting (returns the value or the default from manifest)
const workMinutes = this.settings.get<number>("workMinutes"); // 25
const autoStart = this.settings.get<boolean>("autoStartBreak"); // true

// Listen for settings changes
this.app.events.on("plugin:settings:change", (settings) => {
  this.workMinutes = settings.workMinutes as number;
  this.restartTimerIfNeeded();
});
```

Users configure plugin settings in the Settings view (Settings > Plugins > Your Plugin).

## Permissions

Plugins declare required permissions in `manifest.json`. Users see these permissions when installing a plugin and can choose to approve or deny.

| Permission | Grants Access To |
|------------|-----------------|
| `task:read` | Read tasks, projects, tags |
| `task:write` | Create, update, delete tasks/projects/tags |
| `ui:panel` | Add sidebar panels |
| `ui:view` | Register full-page views |
| `ui:status` | Add status bar items |
| `commands` | Register commands in command palette |
| `settings` | Add a settings tab for this plugin |
| `storage` | Plugin-specific key-value storage |
| `network` | Make HTTP requests (prompted per-domain) |

### Permission Principles

- **Least privilege**: Only request what you need
- **Transparent**: Users see exactly what a plugin can do before installing
- **Granular**: Read and write are separate — a view-only plugin doesn't need write access
- **Network is special**: `network` permission shows a domain allowlist prompt on first use

## Plugin Directory Structure

```
plugins/
└── my-plugin/
    ├── manifest.json     # Required: plugin metadata and config
    ├── index.ts          # Required: entry point (exports Plugin subclass)
    ├── components/       # Optional: React components for UI
    │   └── Panel.tsx
    ├── styles.css        # Optional: plugin-specific styles
    └── README.md         # Optional: plugin documentation
```

## Type Reference

### Task

```typescript
interface Task {
  id: string;
  title: string;
  description: string | null;
  status: "pending" | "completed" | "cancelled";
  priority: 1 | 2 | 3 | 4 | null;
  dueDate: Date | null;
  dueTime: boolean;
  completedAt: Date | null;
  projectId: string | null;
  recurrence: string | null;
  tags: Tag[];
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}
```

### Project

```typescript
interface Project {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  sortOrder: number;
  archived: boolean;
  createdAt: Date;
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

### PluginManifest

```typescript
interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  main: string;
  minSaydoVersion: string;
  targetApiVersion?: string;
  permissions?: string[];
  settings?: SettingDefinition[];
  repository?: string;
  license?: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
}
```

### SettingDefinition

```typescript
type SettingDefinition =
  | { id: string; name: string; type: "text"; default: string; description?: string; placeholder?: string }
  | { id: string; name: string; type: "number"; default: number; description?: string; min?: number; max?: number }
  | { id: string; name: string; type: "boolean"; default: boolean; description?: string }
  | { id: string; name: string; type: "select"; default: string; description?: string; options: string[] };
```

## API Versioning & Stability

### Current Version

- **API Version**: 1.1.0
- **Stability**: Stable

The Plugin API follows [semver](https://semver.org/):

| Version Change | Meaning | Example |
|----------------|---------|---------|
| Major (2.0.0) | Breaking changes — plugins may need updates | Removing an API method, changing return types |
| Minor (1.1.0) | Additive — new features, fully backward-compatible | Adding a new `this.app.tags.rename()` method |
| Patch (1.0.1) | Bug fixes only — no API surface changes | Fixing an edge case in `this.app.tasks.list()` |

### `targetApiVersion` Manifest Field

Plugins can declare which API version they target:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "You",
  "description": "Example plugin",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "targetApiVersion": "1.0.0"
}
```

If a plugin targets a newer major version than the running Saydo instance provides, a warning is logged and the plugin may not function correctly.

### Runtime Introspection

Plugins can check the API version at runtime via `this.app.meta`:

```typescript
async onLoad() {
  console.log(`API version: ${this.app.meta.version}`);    // "1.0.0"
  console.log(`Stability: ${this.app.meta.stability}`);      // "stable"
}
```

### Stability Levels

| Level | Meaning |
|-------|---------|
| `stable` | Breaking changes require a major version bump. Safe for production plugins. |
| `experimental` | API may change between minor versions. Used for new features under development. |

The current Plugin API is **stable** as of v1.0.0.

## Sandbox Restrictions

Plugins run in a sandboxed environment with the following restrictions:

| Feature | Access |
|---------|--------|
| Saydo API | Yes (filtered by permissions) |
| React rendering | Yes (within allocated UI slots) |
| `setTimeout` / `setInterval` | Yes (auto-cleared on unload) |
| `fetch` / HTTP requests | Only with `network` permission |
| Filesystem access | No (use Storage API instead) |
| `eval` / `new Function` | No |
| `process` / `require` | No |
| DOM manipulation outside plugin slots | No |
| Other plugin data | No |

See [SECURITY.md](../guides/SECURITY.md) for the full threat model and sandboxing details.
