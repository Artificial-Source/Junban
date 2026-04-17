/**
 * Example Plugin — demonstrates the Junban Plugin API v2.
 *
 * This plugin shows how to use:
 * - Task CRUD (list, get, create, update, complete, uncomplete, delete)
 * - Project and tag reading
 * - Event listeners (task:create, task:complete, task:uncomplete)
 * - Commands registered to the command palette
 * - Status bar items with live updates
 * - Plugin settings (defined in manifest.json)
 * - Plugin storage (key-value persistence)
 *
 * PERMISSION MODEL:
 * Every API method is always available on `this.app` — no optional chaining needed.
 * If a method requires a permission you haven't declared in manifest.json,
 * it will throw a clear error telling you exactly which permission to add.
 *
 * Use this as a starting point for your own plugins.
 * See docs/reference/plugins/API.md for the full API reference.
 */

import { Plugin } from "../../src/plugins/lifecycle.js";
import type { Task } from "../../src/core/types.js";

export default class ExamplePlugin extends Plugin {
  private statusItem: { update: (data: { text?: string; icon?: string }) => void } | null = null;
  private pendingCount = 0;

  async onLoad() {
    // ── Commands ───────────────────────────────────────────────────
    // Requires: "commands" permission

    // Simple greeting command
    this.app.commands.register({
      id: "greet",
      name: "Greet",
      callback: () => {
        const greeting = this.settings.get<string>("greeting");
        console.log(`[ExamplePlugin] ${greeting}`);
      },
    });

    // Command that creates a task using the Task API
    this.app.commands.register({
      id: "create-sample-task",
      name: "Create Sample Task",
      callback: async () => {
        const prioritySetting = this.settings.get<string>("defaultPriority");
        const priority = prioritySetting === "none" ? null : parseInt(prioritySetting, 10);

        const task = await this.app.tasks.create({
          title: "Sample task from Example Plugin",
          priority,
          tags: ["example"],
        });
        console.log(`[ExamplePlugin] Created task: ${task.title} (${task.id})`);
      },
    });

    // Command that lists projects
    this.app.commands.register({
      id: "list-projects",
      name: "List Projects",
      callback: async () => {
        const projects = await this.app.projects.list();
        console.log(`[ExamplePlugin] Projects: ${projects.map((p) => p.name).join(", ") || "(none)"}`);
      },
    });

    // Command that lists tags
    this.app.commands.register({
      id: "list-tags",
      name: "List Tags",
      callback: async () => {
        const tags = await this.app.tags.list();
        console.log(`[ExamplePlugin] Tags: ${tags.map((t) => t.name).join(", ") || "(none)"}`);
      },
    });

    // ── Status Bar ────────────────────────────────────────────────
    // Requires: "ui:status" permission

    if (this.settings.get<boolean>("showTaskCount")) {
      // Get initial count
      const tasks = await this.app.tasks.list();
      this.pendingCount = tasks.filter((t) => t.status === "pending").length;

      this.statusItem = this.app.ui.addStatusBarItem({
        id: "example-task-count",
        text: this.formatCount(),
        icon: "list",
      });
    }

    // ── Events ────────────────────────────────────────────────────
    // Requires: "task:read" permission

    this.app.events.on("task:create", this.onTaskCreate);
    this.app.events.on("task:complete", this.onTaskComplete);
    this.app.events.on("task:uncomplete", this.onTaskUncomplete);
    this.app.events.on("task:delete", this.onTaskDelete);

    // ── Storage ───────────────────────────────────────────────────
    // Track how many times the plugin has been loaded
    const loadCount = (await this.app.storage.get<number>("load-count")) ?? 0;
    await this.app.storage.set("load-count", loadCount + 1);
    console.log(`[ExamplePlugin] Loaded (${loadCount + 1} time(s) total)`);
  }

  async onUnload() {
    // Events are NOT auto-removed — clean up your listeners.
    // Commands, status bar items, and UI panels ARE auto-removed.
    this.app.events.off("task:create", this.onTaskCreate);
    this.app.events.off("task:complete", this.onTaskComplete);
    this.app.events.off("task:uncomplete", this.onTaskUncomplete);
    this.app.events.off("task:delete", this.onTaskDelete);

    this.statusItem = null;
    console.log("[ExamplePlugin] Unloaded");
  }

  // ── Event Handlers ────────────────────────────────────────────────
  // Use arrow functions so `this` is correctly bound.

  private onTaskCreate = (task: Task) => {
    console.log(`[ExamplePlugin] Task created: ${task.title}`);
    this.pendingCount++;
    this.updateStatusBar();
  };

  private onTaskComplete = (task: Task) => {
    console.log(`[ExamplePlugin] Task completed: ${task.title}`);
    this.pendingCount = Math.max(0, this.pendingCount - 1);
    this.updateStatusBar();
  };

  private onTaskUncomplete = (task: Task) => {
    console.log(`[ExamplePlugin] Task uncompleted: ${task.title}`);
    this.pendingCount++;
    this.updateStatusBar();
  };

  private onTaskDelete = (task: Task) => {
    if (task.status === "pending") {
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      this.updateStatusBar();
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────

  private updateStatusBar() {
    this.statusItem?.update({ text: this.formatCount() });
  }

  private formatCount(): string {
    return `${this.pendingCount} pending`;
  }
}
