# Plugin Examples

Five progressively complex examples showing how to build Saydo plugins. Each example is complete and working -- you can copy the files directly into your `plugins/` directory.

---

## Example 1: Hello World

A command that logs to the console. The simplest possible plugin.

### `plugins/hello-world/manifest.json`

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "A minimal plugin that registers a command.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["commands"]
}
```

### `plugins/hello-world/index.ts`

```typescript
import { Plugin } from "../../src/plugins/lifecycle.js";

export default class HelloWorldPlugin extends Plugin {
  async onLoad() {
    this.app.commands.register({
      id: "greet",
      name: "Say Hello",
      callback: () => {
        console.log("Hello from my first Saydo plugin!");
      },
    });
  }

  async onUnload() {
    // Commands are auto-removed. Nothing to clean up.
  }
}
```

**What this teaches:**
- Plugin structure: manifest.json + entry file
- Extending the `Plugin` base class
- Registering commands in `onLoad()`
- Commands appear in the command palette (Ctrl+K)

**Permissions needed:** `commands` -- to register commands in the command palette.

---

## Example 2: Task Counter

A status bar item that shows how many pending tasks you have, updated in real time as tasks are created, completed, uncompleted, or deleted.

### `plugins/task-counter/manifest.json`

```json
{
  "id": "task-counter",
  "name": "Task Counter",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "Shows the number of pending tasks in the status bar.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["task:read", "ui:status"]
}
```

### `plugins/task-counter/index.ts`

```typescript
import { Plugin } from "../../src/plugins/lifecycle.js";
import type { Task } from "../../src/core/types.js";

export default class TaskCounterPlugin extends Plugin {
  private count = 0;
  private statusItem: { update: (data: { text?: string }) => void } | null = null;

  async onLoad() {
    // Get initial count
    const tasks = await this.app.tasks.list();
    this.count = tasks.filter((t) => t.status === "pending").length;

    // Add status bar item
    this.statusItem = this.app.ui.addStatusBarItem({
      id: "task-counter",
      text: `${this.count} pending`,
      icon: "check-circle",
    });

    // Update count on events
    this.app.events.on("task:create", this.onTaskCreate);
    this.app.events.on("task:complete", this.onTaskComplete);
    this.app.events.on("task:uncomplete", this.onTaskUncomplete);
    this.app.events.on("task:delete", this.onTaskDelete);
  }

  async onUnload() {
    // IMPORTANT: Remove event listeners. They are NOT auto-removed.
    this.app.events.off("task:create", this.onTaskCreate);
    this.app.events.off("task:complete", this.onTaskComplete);
    this.app.events.off("task:uncomplete", this.onTaskUncomplete);
    this.app.events.off("task:delete", this.onTaskDelete);
    this.statusItem = null;
  }

  // Arrow functions so `this` is correctly bound
  private onTaskCreate = (_task: Task) => {
    this.count++;
    this.statusItem?.update({ text: `${this.count} pending` });
  };

  private onTaskComplete = (_task: Task) => {
    this.count = Math.max(0, this.count - 1);
    this.statusItem?.update({ text: `${this.count} pending` });
  };

  private onTaskUncomplete = (_task: Task) => {
    this.count++;
    this.statusItem?.update({ text: `${this.count} pending` });
  };

  private onTaskDelete = (task: Task) => {
    if (task.status === "pending") {
      this.count = Math.max(0, this.count - 1);
      this.statusItem?.update({ text: `${this.count} pending` });
    }
  };
}
```

**What this teaches:**
- Reading tasks with `tasks.list()`
- Subscribing to events (`task:create`, `task:complete`, `task:uncomplete`, `task:delete`)
- Adding and updating status bar items
- Cleaning up event listeners in `onUnload()`
- Using arrow functions for bound event handlers

**Permissions needed:**
- `task:read` -- to list tasks and subscribe to events
- `ui:status` -- to add a status bar item

---

## Example 3: Daily Digest

A sidebar panel that lists today's tasks, grouped by priority.

### `plugins/daily-digest/manifest.json`

```json
{
  "id": "daily-digest",
  "name": "Daily Digest",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "Sidebar panel showing today's tasks grouped by priority.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["task:read", "project:read", "ui:panel", "commands"]
}
```

### `plugins/daily-digest/index.ts`

```typescript
import { Plugin } from "../../src/plugins/lifecycle.js";

export default class DailyDigestPlugin extends Plugin {
  async onLoad() {
    // Sidebar panel with structured text content
    this.app.ui.addSidebarPanel({
      id: "daily-digest",
      title: "Today's Digest",
      icon: "calendar",
      contentType: "text",
      render: () => this.buildDigest(),
    });

    // Command to refresh the digest
    this.app.commands.register({
      id: "refresh",
      name: "Daily Digest: Refresh",
      callback: () => {
        // The panel re-renders automatically since render() is called each time
        console.log("[DailyDigest] Refreshed");
      },
    });
  }

  async onUnload() {}

  private buildDigest(): string {
    // Note: render() is synchronous, so we can't await here.
    // For async data, use a React component (contentType: "react") instead.
    const today = new Date().toLocaleDateString();
    return `Daily Digest for ${today}\n\nOpen the command palette (Ctrl+K) and run "Daily Digest: Refresh" to update.`;
  }
}
```

**What this teaches:**
- Adding sidebar panels with text content
- Combining commands and UI panels
- Using `project:read` to access project data

**Permissions needed:**
- `task:read` -- to list and filter tasks
- `project:read` -- to look up project names
- `ui:panel` -- to add a sidebar panel
- `commands` -- to register a refresh command

---

## Example 4: Task Tagger

A command that finds all overdue tasks and adds a configurable tag to them. Demonstrates task writing, tag creation, and settings.

### `plugins/task-tagger/manifest.json`

```json
{
  "id": "task-tagger",
  "name": "Task Tagger",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "Bulk-tags overdue tasks with a configurable tag.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["task:read", "task:write", "tag:write", "commands"],
  "settings": [
    {
      "id": "overdueTag",
      "name": "Overdue Tag",
      "type": "text",
      "default": "overdue",
      "description": "Tag name to apply to overdue tasks"
    },
    {
      "id": "autoTag",
      "name": "Auto-tag on startup",
      "type": "boolean",
      "default": false,
      "description": "Automatically tag overdue tasks when the plugin loads"
    }
  ]
}
```

### `plugins/task-tagger/index.ts`

```typescript
import { Plugin } from "../../src/plugins/lifecycle.js";

export default class TaskTaggerPlugin extends Plugin {
  async onLoad() {
    // Register the bulk-tag command
    this.app.commands.register({
      id: "tag-overdue",
      name: "Tag Overdue Tasks",
      callback: () => this.tagOverdueTasks(),
    });

    // Auto-tag on startup if enabled
    if (this.settings.get<boolean>("autoTag")) {
      await this.tagOverdueTasks();
    }
  }

  async onUnload() {}

  private async tagOverdueTasks(): Promise<void> {
    const tagName = this.settings.get<string>("overdueTag");
    const now = new Date().toISOString();

    // Get all pending tasks
    const tasks = await this.app.tasks.list();
    const overdue = tasks.filter(
      (t) => t.status === "pending" && t.dueDate && t.dueDate < now,
    );

    if (overdue.length === 0) {
      console.log("[TaskTagger] No overdue tasks found.");
      return;
    }

    // Ensure the tag exists
    await this.app.tags.create(tagName);

    // Add the tag to each overdue task
    let tagged = 0;
    for (const task of overdue) {
      const existingTagNames = task.tags.map((t) => t.name);
      if (!existingTagNames.includes(tagName)) {
        await this.app.tasks.update(task.id, {
          tags: [...existingTagNames, tagName],
        });
        tagged++;
      }
    }

    console.log(`[TaskTagger] Tagged ${tagged} overdue task(s) with #${tagName}`);
  }
}
```

**What this teaches:**
- Reading and writing tasks
- Creating tags
- Using plugin settings for configurable behavior
- Bulk operations with task filtering
- Startup logic in `onLoad()` controlled by a setting

**Permissions needed:**
- `task:read` -- to list and filter tasks
- `task:write` -- to update task tags
- `tag:write` -- to create the tag if it doesn't exist
- `commands` -- to register the bulk-tag command

---

## Example 5: Pomodoro Timer

A full plugin with a structured view, status bar, settings, storage, and commands. See the built-in Pomodoro plugin at `src/plugins/builtin/pomodoro/` for the complete implementation.

### `plugins/pomodoro/manifest.json`

```json
{
  "id": "pomodoro",
  "name": "Pomodoro Timer",
  "version": "1.0.0",
  "author": "ASF",
  "description": "Focus timer with configurable work/break intervals.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["task:read", "commands", "ui:status", "ui:view", "storage"],
  "settings": [
    {
      "id": "workMinutes",
      "name": "Work Duration",
      "type": "number",
      "default": 25,
      "min": 1,
      "max": 120
    },
    {
      "id": "breakMinutes",
      "name": "Break Duration",
      "type": "number",
      "default": 5,
      "min": 1,
      "max": 60
    },
    {
      "id": "longBreakMinutes",
      "name": "Long Break Duration",
      "type": "number",
      "default": 15,
      "min": 1,
      "max": 60
    },
    {
      "id": "sessionsBeforeLongBreak",
      "name": "Sessions Before Long Break",
      "type": "number",
      "default": 4,
      "min": 1,
      "max": 10
    }
  ]
}
```

### `plugins/pomodoro/index.ts`

```typescript
import { Plugin } from "../../src/plugins/lifecycle.js";

type TimerState = "idle" | "running" | "paused";
type Phase = "work" | "break" | "longBreak";

export default class PomodoroPlugin extends Plugin {
  private state: TimerState = "idle";
  private phase: Phase = "work";
  private timeLeft = 0;
  private session = 1;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private statusHandle: { update: (data: { text?: string }) => void } | null = null;

  async onLoad() {
    this.timeLeft = this.settings.get<number>("workMinutes") * 60;

    // Register commands
    this.app.commands.register({
      id: "start",
      name: "Pomodoro: Start",
      callback: () => this.start(),
    });

    this.app.commands.register({
      id: "pause",
      name: "Pomodoro: Pause",
      callback: () => this.pause(),
    });

    this.app.commands.register({
      id: "reset",
      name: "Pomodoro: Reset",
      callback: () => this.reset(),
    });

    // Status bar
    this.statusHandle = this.app.ui.addStatusBarItem({
      id: "pomodoro-timer",
      text: "Ready",
      icon: "timer",
    });

    // Structured view (renders as interactive UI without React)
    this.app.ui.addView({
      id: "pomodoro",
      name: "Pomodoro",
      icon: "timer",
      slot: "tools",
      contentType: "structured",
      render: () => this.getViewContent(),
    });

    // Track sessions in storage
    const totalSessions = (await this.app.storage.get<number>("total-sessions")) ?? 0;
    console.log(`[Pomodoro] Total sessions completed: ${totalSessions}`);
  }

  async onUnload() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.statusHandle = null;
  }

  private start() {
    if (this.state === "running") return;
    this.state = "running";
    this.intervalId = setInterval(() => this.tick(), 1000);
    this.updateStatus();
  }

  private pause() {
    if (this.state !== "running") return;
    this.state = "paused";
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.updateStatus();
  }

  private reset() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.timeLeft = this.getPhaseSeconds();
    this.state = "idle";
    this.updateStatus();
  }

  private tick() {
    this.timeLeft--;
    if (this.timeLeft <= 0) {
      this.advancePhase();
    }
    this.updateStatus();
  }

  private async advancePhase() {
    if (this.phase === "work") {
      // Record completed session
      const total = ((await this.app.storage.get<number>("total-sessions")) ?? 0) + 1;
      await this.app.storage.set("total-sessions", total);

      const sessionsBeforeLong = this.settings.get<number>("sessionsBeforeLongBreak");
      if (this.session >= sessionsBeforeLong) {
        this.phase = "longBreak";
        this.session = 1;
      } else {
        this.phase = "break";
        this.session++;
      }
    } else {
      this.phase = "work";
    }
    this.timeLeft = this.getPhaseSeconds();
  }

  private getPhaseSeconds(): number {
    switch (this.phase) {
      case "work":
        return this.settings.get<number>("workMinutes") * 60;
      case "break":
        return this.settings.get<number>("breakMinutes") * 60;
      case "longBreak":
        return this.settings.get<number>("longBreakMinutes") * 60;
    }
  }

  private updateStatus() {
    const time = this.formatTime(this.timeLeft);
    if (this.state === "idle") {
      this.statusHandle?.update({ text: "Ready" });
    } else if (this.state === "paused") {
      this.statusHandle?.update({ text: `${time} (paused)` });
    } else {
      this.statusHandle?.update({ text: time });
    }
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  private getViewContent(): string {
    const time = this.formatTime(this.timeLeft);
    const phaseLabels = { work: "Work", break: "Break", longBreak: "Long Break" };

    return JSON.stringify({
      layout: "center",
      elements: [
        { type: "text", value: phaseLabels[this.phase], variant: "subtitle" },
        { type: "spacer", size: "sm" },
        { type: "text", value: time, variant: "mono" },
        { type: "spacer", size: "sm" },
        {
          type: "progress",
          value: this.getPhaseSeconds() - this.timeLeft,
          max: this.getPhaseSeconds(),
          color: this.phase === "work" ? "accent" : "success",
        },
        { type: "spacer", size: "sm" },
        {
          type: "row",
          justify: "center",
          gap: "md",
          elements: [
            {
              type: "button",
              label: this.state === "running" ? "Pause" : "Start",
              commandId: this.state === "running" ? "pomodoro:pause" : "pomodoro:start",
              variant: "primary",
            },
            { type: "button", label: "Reset", commandId: "pomodoro:reset", variant: "ghost" },
          ],
        },
        { type: "spacer", size: "sm" },
        {
          type: "badge",
          value: `Session ${this.session}`,
          color: "default",
        },
      ],
    });
  }
}
```

**What this teaches:**
- Structured views with interactive UI elements
- Status bar with live updates
- Timer management with `setInterval` / `clearInterval`
- Persistent state with storage
- Settings for user-configurable values
- Multiple commands
- Cleanup in `onUnload()`

**Permissions needed:**
- `task:read` -- to potentially integrate with tasks
- `commands` -- for start/pause/reset commands
- `ui:status` -- for the status bar timer display
- `ui:view` -- for the structured Pomodoro view
- `storage` -- to persist session counts

---

## Example 6: Plugin with Settings

A plugin that uses manifest-defined settings to control its behavior. The settings form is automatically rendered in the plugin settings panel -- no UI code needed.

### `plugins/focus-mode/manifest.json`

```json
{
  "id": "focus-mode",
  "name": "Focus Mode",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "Hides low-priority tasks to help you focus.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["task:read", "commands", "ui:status"],
  "settings": [
    {
      "id": "minPriority",
      "name": "Minimum Priority",
      "type": "select",
      "default": "2",
      "options": ["1", "2", "3", "4"],
      "description": "Only show tasks at this priority level or higher (1 = highest)"
    },
    {
      "id": "showCount",
      "name": "Show Task Count",
      "type": "boolean",
      "default": true,
      "description": "Display the number of focus tasks in the status bar"
    },
    {
      "id": "maxTasks",
      "name": "Max Tasks Shown",
      "type": "number",
      "default": 5,
      "min": 1,
      "max": 20,
      "description": "Maximum number of tasks to show in focus mode"
    }
  ]
}
```

### `plugins/focus-mode/index.ts`

```typescript
import { Plugin } from "../../src/plugins/lifecycle.js";

export default class FocusModePlugin extends Plugin {
  private statusHandle: { update: (data: { text?: string }) => void } | null = null;

  async onLoad() {
    this.app.commands.register({
      id: "show-focus",
      name: "Focus Mode: Show Focus Tasks",
      callback: () => this.showFocusTasks(),
    });

    if (this.settings.get<boolean>("showCount")) {
      this.statusHandle = this.app.ui.addStatusBarItem({
        id: "focus-count",
        text: "Focus: ...",
        icon: "target",
      });
      await this.updateCount();
    }
  }

  async onUnload() {
    this.statusHandle = null;
  }

  private async updateCount() {
    const tasks = await this.getFocusTasks();
    this.statusHandle?.update({ text: `Focus: ${tasks.length}` });
  }

  private async getFocusTasks() {
    const minPriority = Number(this.settings.get<string>("minPriority"));
    const maxTasks = this.settings.get<number>("maxTasks");
    const all = await this.app.tasks.list({ status: "pending" });
    return all
      .filter((t) => t.priority !== null && t.priority <= minPriority)
      .slice(0, maxTasks);
  }

  private async showFocusTasks() {
    const tasks = await this.getFocusTasks();
    console.log(`[FocusMode] ${tasks.length} focus tasks:`);
    for (const t of tasks) {
      console.log(`  P${t.priority}: ${t.title}`);
    }
    this.statusHandle?.update({ text: `Focus: ${tasks.length}` });
  }
}
```

**What this teaches:**

- Defining settings in `manifest.json` (select, boolean, number types)
- Reading settings with `this.settings.get<T>(id)` at runtime
- Settings are automatically rendered as a form in Settings > Plugins > Focus Mode

**Permissions needed:**

- `task:read` -- to list and filter tasks
- `commands` -- to register the focus command
- `ui:status` -- for the status bar counter

---

## Example 7: Plugin with UI View

A plugin that registers a custom view using `structured` content -- a JSON layout rendered by Saydo without needing React.

### `plugins/project-overview/manifest.json`

```json
{
  "id": "project-overview",
  "name": "Project Overview",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "A dashboard view showing project stats.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["task:read", "project:read", "ui:view"]
}
```

### `plugins/project-overview/index.ts`

```typescript
import { Plugin } from "../../src/plugins/lifecycle.js";

export default class ProjectOverviewPlugin extends Plugin {
  async onLoad() {
    this.app.ui.addView({
      id: "project-overview",
      name: "Project Overview",
      icon: "bar-chart",
      slot: "tools",
      contentType: "structured",
      render: () => this.buildView(),
    });
  }

  async onUnload() {}

  private buildView(): string {
    // render() is synchronous, so we build from cached/static data.
    // For dynamic data, fetch it in onLoad() or via a command and store it.
    return JSON.stringify({
      layout: "stack",
      elements: [
        { type: "text", value: "Project Overview", variant: "title" },
        { type: "spacer", size: "md" },
        {
          type: "row",
          gap: "lg",
          elements: [
            { type: "badge", value: "3 Active", color: "accent" },
            { type: "badge", value: "12 Tasks", color: "default" },
            { type: "badge", value: "2 Overdue", color: "danger" },
          ],
        },
        { type: "spacer", size: "md" },
        {
          type: "text",
          value: "Use the command palette to refresh data.",
          variant: "muted",
        },
      ],
    });
  }
}
```

**What this teaches:**

- Registering a custom view with `ui.addView()`
- Using `contentType: "structured"` with a JSON layout
- Structured elements: `text`, `row`, `badge`, `spacer`
- Views appear in the sidebar under the specified `slot`

**Permissions needed:**

- `task:read` -- to read task counts
- `project:read` -- to list projects
- `ui:view` -- to register the view

---

## Next Steps

- Read the full [Plugin API Reference](API.md) for all methods and types
- Browse the built-in Pomodoro plugin at `src/plugins/builtin/pomodoro/` for a production example
- Browse the example plugin at `plugins/example-plugin/` for a comprehensive API demo
