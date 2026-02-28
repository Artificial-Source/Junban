# Plugin Examples

Step-by-step walkthroughs for building Saydo plugins. Each example builds on the previous one, introducing more of the Plugin API.

## Example 1: Hello World (Commands)

The simplest possible plugin — registers a command in the command palette.

### Manifest

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "A minimal example plugin that says hello.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["commands"]
}
```

### Entry File

```typescript
import { Plugin } from "@asf-saydo/plugin-api";

export default class HelloWorldPlugin extends Plugin {
  async onLoad() {
    this.app.commands.register({
      id: "hello-world:greet",
      name: "Say Hello",
      callback: () => {
        alert("Hello from my first Saydo plugin!");
      },
    });
  }

  async onUnload() {
    // Commands are auto-unregistered, but you can clean up other resources here
  }
}
```

### What This Teaches

- Basic plugin structure: manifest + entry file
- Extending `Plugin` base class
- Registering commands in `onLoad()`
- Commands appear in the command palette (Ctrl+K)

---

## Example 2: Task Counter (Events + Status Bar)

A plugin that counts completed tasks today and shows the count in the status bar.

### Manifest

```json
{
  "id": "task-counter",
  "name": "Task Counter",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "Shows how many tasks you've completed today in the status bar.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["task:read", "ui:status"]
}
```

### Entry File

```typescript
import { Plugin, type Task } from "@asf-saydo/plugin-api";

export default class TaskCounterPlugin extends Plugin {
  private count = 0;
  private statusItem: StatusBarItem | null = null;

  async onLoad() {
    // Count already-completed tasks for today
    const today = await this.app.tasks.listToday();
    this.count = today.filter((t) => t.status === "completed").length;

    // Add status bar item
    this.statusItem = this.app.ui.addStatusBarItem({
      id: "task-counter",
      text: this.formatCount(),
      icon: "check-circle",
    });

    // Listen for completions
    this.app.events.on("task:complete", this.onComplete.bind(this));
    this.app.events.on("task:uncomplete", this.onUncomplete.bind(this));
  }

  async onUnload() {
    // Status bar item is auto-removed, but nullify our reference
    this.statusItem = null;
  }

  private onComplete(task: Task) {
    this.count++;
    this.statusItem?.update({ text: this.formatCount() });
  }

  private onUncomplete(task: Task) {
    this.count = Math.max(0, this.count - 1);
    this.statusItem?.update({ text: this.formatCount() });
  }

  private formatCount(): string {
    return `${this.count} done today`;
  }
}
```

### What This Teaches

- Reading tasks with `this.app.tasks`
- Listening to task events
- Adding and updating status bar items
- Cleaning up in `onUnload()`

---

## Example 3: Pomodoro Timer (Settings + UI Panel + Storage)

A full-featured Pomodoro timer plugin with configurable intervals, a sidebar panel, and persistent stats.

### Manifest

```json
{
  "id": "pomodoro",
  "name": "Pomodoro Timer",
  "version": "1.0.0",
  "author": "ASF",
  "description": "Pomodoro technique timer with task integration and daily stats.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["task:read", "ui:panel", "ui:status", "commands", "settings", "storage"],
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
      "description": "Automatically start break when work interval ends"
    }
  ]
}
```

### Entry File

```typescript
import { Plugin } from "@asf-saydo/plugin-api";
import { PomodoroPanel } from "./components/Panel";

interface PomodoroStats {
  date: string;
  sessions: number;
  totalMinutes: number;
}

export default class PomodoroPlugin extends Plugin {
  private timer: ReturnType<typeof setInterval> | null = null;
  private secondsRemaining = 0;
  private isWorking = true;
  private statusItem: StatusBarItem | null = null;

  async onLoad() {
    const workMinutes = this.settings.get<number>("workMinutes");
    this.secondsRemaining = workMinutes * 60;

    // Register commands
    this.app.commands.register({
      id: "pomodoro:start",
      name: "Start Pomodoro",
      hotkey: "Ctrl+Shift+P",
      callback: () => this.start(),
    });

    this.app.commands.register({
      id: "pomodoro:stop",
      name: "Stop Pomodoro",
      check: () => this.timer !== null,
      callback: () => this.stop(),
    });

    // Add sidebar panel
    this.app.ui.addSidebarPanel({
      id: "pomodoro-panel",
      title: "Pomodoro",
      icon: "timer",
      component: PomodoroPanel,
    });

    // Add status bar item
    this.statusItem = this.app.ui.addStatusBarItem({
      id: "pomodoro-status",
      text: this.formatTime(),
      icon: "timer",
      onClick: () => (this.timer ? this.stop() : this.start()),
    });

    // Listen for settings changes
    this.app.events.on("plugin:settings:change", (settings) => {
      if (!this.timer) {
        this.secondsRemaining = (settings.workMinutes as number) * 60;
        this.statusItem?.update({ text: this.formatTime() });
      }
    });
  }

  async onUnload() {
    this.stop();
    this.statusItem = null;
  }

  private start() {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.secondsRemaining--;
      this.statusItem?.update({ text: this.formatTime() });

      if (this.secondsRemaining <= 0) {
        this.onIntervalComplete();
      }
    }, 1000);
  }

  private stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async onIntervalComplete() {
    this.stop();

    if (this.isWorking) {
      // Work interval done — record stats
      await this.recordSession();

      // Switch to break
      this.isWorking = false;
      this.secondsRemaining = this.settings.get<number>("breakMinutes") * 60;

      if (this.settings.get<boolean>("autoStartBreak")) {
        this.start();
      }
    } else {
      // Break done — switch to work
      this.isWorking = true;
      this.secondsRemaining = this.settings.get<number>("workMinutes") * 60;
    }

    this.statusItem?.update({ text: this.formatTime() });
  }

  private async recordSession() {
    const today = new Date().toISOString().split("T")[0];
    const stats = (await this.app.storage.get<PomodoroStats[]>("stats")) ?? [];

    const todayStats = stats.find((s) => s.date === today);
    if (todayStats) {
      todayStats.sessions++;
      todayStats.totalMinutes += this.settings.get<number>("workMinutes");
    } else {
      stats.push({
        date: today,
        sessions: 1,
        totalMinutes: this.settings.get<number>("workMinutes"),
      });
    }

    await this.app.storage.set("stats", stats);
  }

  private formatTime(): string {
    const mins = Math.floor(this.secondsRemaining / 60);
    const secs = this.secondsRemaining % 60;
    const label = this.isWorking ? "Work" : "Break";
    return `${label} ${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
}
```

### Panel Component

```tsx
// components/Panel.tsx
import React, { useState, useEffect } from "react";
import { usePlugin } from "@asf-saydo/plugin-api/react";

export function PomodoroPanel() {
  const plugin = usePlugin<PomodoroPlugin>();
  const [stats, setStats] = useState<PomodoroStats[]>([]);

  useEffect(() => {
    plugin.app.storage.get<PomodoroStats[]>("stats").then((s) => setStats(s ?? []));
  }, []);

  const today = new Date().toISOString().split("T")[0];
  const todayStats = stats.find((s) => s.date === today);

  return (
    <div className="p-4">
      <h3 className="text-lg font-semibold mb-2">Today</h3>
      <p>{todayStats?.sessions ?? 0} sessions completed</p>
      <p>{todayStats?.totalMinutes ?? 0} minutes focused</p>

      <h3 className="text-lg font-semibold mt-4 mb-2">This Week</h3>
      <ul>
        {stats.slice(-7).map((s) => (
          <li key={s.date}>
            {s.date}: {s.sessions} sessions ({s.totalMinutes}m)
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### What This Teaches

- Plugin settings (defined in manifest, read via `this.settings`)
- Sidebar panels with React components
- Status bar items with click handlers
- Plugin-specific storage (persistent, isolated)
- Timer management and cleanup
- Responding to settings changes

---

## Example 4: Kanban View (Custom Views)

A plugin that adds a full Kanban board view.

### Manifest

```json
{
  "id": "kanban",
  "name": "Kanban Board",
  "version": "1.0.0",
  "author": "ASF",
  "description": "Drag-and-drop Kanban board view for tasks.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["task:read", "task:write", "ui:view", "commands", "settings"],
  "settings": [
    {
      "id": "columns",
      "name": "Column Names",
      "type": "text",
      "default": "To Do,In Progress,Done",
      "description": "Comma-separated list of column names"
    }
  ]
}
```

### Entry File

```typescript
import { Plugin } from "@asf-saydo/plugin-api";
import { KanbanView } from "./components/KanbanView";

export default class KanbanPlugin extends Plugin {
  async onLoad() {
    // Register the Kanban view
    this.app.ui.addView({
      id: "kanban",
      name: "Kanban Board",
      icon: "columns",
      component: KanbanView,
    });

    // Add a command to navigate to the view
    this.app.commands.register({
      id: "kanban:open",
      name: "Open Kanban Board",
      hotkey: "Ctrl+Shift+K",
      callback: () => this.app.ui.navigateToView("kanban"),
    });
  }

  async onUnload() {}
}
```

### View Component (abbreviated)

```tsx
// components/KanbanView.tsx
import React, { useState, useEffect } from "react";
import { usePlugin, type Task } from "@asf-saydo/plugin-api/react";

export function KanbanView() {
  const plugin = usePlugin<KanbanPlugin>();
  const [tasks, setTasks] = useState<Task[]>([]);

  const columnsStr = plugin.settings.get<string>("columns");
  const columns = columnsStr.split(",").map((s) => s.trim());

  useEffect(() => {
    plugin.app.tasks.list({ status: "pending" }).then(setTasks);
  }, []);

  // Map tasks to columns by tag (e.g., #todo, #in-progress, #done)
  const getColumnTasks = (column: string) => {
    const tag = column.toLowerCase().replace(/\s+/g, "-");
    return tasks.filter((t) => t.tags.some((tg) => tg.name === tag));
  };

  return (
    <div className="flex gap-4 p-4 overflow-x-auto h-full">
      {columns.map((column) => (
        <div key={column} className="flex-shrink-0 w-72 bg-gray-100 dark:bg-gray-800 rounded-lg p-3">
          <h3 className="font-semibold mb-3">{column}</h3>
          <div className="space-y-2">
            {getColumnTasks(column).map((task) => (
              <div key={task.id} className="bg-white dark:bg-gray-700 rounded p-3 shadow-sm">
                <p>{task.title}</p>
                {task.dueDate && (
                  <span className="text-xs text-gray-500">{task.dueDate.toLocaleDateString()}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

### What This Teaches

- Registering full-page views
- Navigating to custom views from commands
- Reading and using plugin settings for configuration
- Building React components that interact with the task API

---

## Example 5: Daily Planner (Multiple Features Combined)

A more complete plugin that combines several API features: a sidebar panel, task events, commands, storage, and settings.

### Manifest

```json
{
  "id": "daily-planner",
  "name": "Daily Planner",
  "version": "1.0.0",
  "author": "ASF",
  "description": "Plan your day by ordering today's tasks and tracking progress.",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["task:read", "task:write", "ui:panel", "commands", "storage", "settings"],
  "settings": [
    {
      "id": "planningReminder",
      "name": "Planning Reminder",
      "type": "boolean",
      "default": true,
      "description": "Show a reminder to plan your day when Saydo opens"
    },
    {
      "id": "dayStartHour",
      "name": "Day Start Hour",
      "type": "number",
      "default": 9,
      "min": 0,
      "max": 23,
      "description": "Hour of the day when your workday starts (24h format)"
    }
  ]
}
```

### Entry File

```typescript
import { Plugin, type Task } from "@asf-saydo/plugin-api";
import { PlannerPanel } from "./components/PlannerPanel";

interface DayPlan {
  date: string;
  taskOrder: string[]; // task IDs in planned order
  completedCount: number;
}

export default class DailyPlannerPlugin extends Plugin {
  async onLoad() {
    // Sidebar panel
    this.app.ui.addSidebarPanel({
      id: "daily-planner",
      title: "Today's Plan",
      icon: "calendar-check",
      component: PlannerPanel,
    });

    // Commands
    this.app.commands.register({
      id: "planner:plan-day",
      name: "Plan Today",
      hotkey: "Ctrl+Shift+D",
      callback: () => this.app.ui.focusPanel("daily-planner"),
    });

    // Track completions for daily stats
    this.app.events.on("task:complete", async (task: Task) => {
      const plan = await this.getTodayPlan();
      if (plan && plan.taskOrder.includes(task.id)) {
        plan.completedCount++;
        await this.savePlan(plan);
      }
    });

    // Show planning reminder on startup
    if (this.settings.get<boolean>("planningReminder")) {
      const plan = await this.getTodayPlan();
      if (!plan) {
        // No plan for today yet — could show a notification
      }
    }
  }

  async onUnload() {}

  private async getTodayPlan(): Promise<DayPlan | null> {
    const today = new Date().toISOString().split("T")[0];
    const plans = (await this.app.storage.get<DayPlan[]>("plans")) ?? [];
    return plans.find((p) => p.date === today) ?? null;
  }

  private async savePlan(plan: DayPlan): Promise<void> {
    const plans = (await this.app.storage.get<DayPlan[]>("plans")) ?? [];
    const idx = plans.findIndex((p) => p.date === plan.date);
    if (idx >= 0) {
      plans[idx] = plan;
    } else {
      plans.push(plan);
    }
    // Keep only last 30 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const filtered = plans.filter((p) => p.date >= cutoff.toISOString().split("T")[0]);
    await this.app.storage.set("plans", filtered);
  }
}
```

### What This Teaches

- Combining multiple permissions and API features in one plugin
- Persistent plans via plugin storage with data retention
- Reacting to task events to update plugin state
- Using settings to control plugin behavior
- Startup logic in `onLoad()` (checking for existing plan)

---

## Next Steps

- Read the full [Plugin API Reference](API.md) for all available methods
- Check [SECURITY.md](../guides/SECURITY.md) for sandbox restrictions and best practices
- Browse `sources.json` in the project root for the community plugin directory
- Join the ASF community to share your plugin
