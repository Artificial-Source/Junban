/**
 * Example Plugin — demonstrates the Junban Plugin API v2.
 */

export default class ExamplePlugin {
  statusItem = null;
  pendingCount = 0;

  async onLoad() {
    this.app.commands.register({
      id: "greet",
      name: "Greet",
      callback: () => {
        const greeting = this.settings.get("greeting");
        console.log(`[ExamplePlugin] ${greeting}`);
      },
    });

    this.app.commands.register({
      id: "create-sample-task",
      name: "Create Sample Task",
      callback: async () => {
        const prioritySetting = this.settings.get("defaultPriority");
        const priority =
          prioritySetting === "none"
            ? null
            : Number.parseInt(prioritySetting, 10);

        const task = await this.app.tasks.create({
          title: "Sample task from Example Plugin",
          priority,
          tags: ["example"],
        });
        console.log(`[ExamplePlugin] Created task: ${task.title} (${task.id})`);
      },
    });

    this.app.commands.register({
      id: "list-projects",
      name: "List Projects",
      callback: async () => {
        const projects = await this.app.projects.list();
        console.log(
          `[ExamplePlugin] Projects: ${projects.map((p) => p.name).join(", ") || "(none)"}`,
        );
      },
    });

    this.app.commands.register({
      id: "list-tags",
      name: "List Tags",
      callback: async () => {
        const tags = await this.app.tags.list();
        console.log(
          `[ExamplePlugin] Tags: ${tags.map((t) => t.name).join(", ") || "(none)"}`,
        );
      },
    });

    if (this.settings.get("showTaskCount")) {
      const tasks = await this.app.tasks.list();
      this.pendingCount = tasks.filter((t) => t.status === "pending").length;

      this.statusItem = this.app.ui.addStatusBarItem({
        id: "example-task-count",
        text: this.formatCount(),
        icon: "list",
      });
    }

    this.app.events.on("task:create", this.onTaskCreate);
    this.app.events.on("task:complete", this.onTaskComplete);
    this.app.events.on("task:uncomplete", this.onTaskUncomplete);
    this.app.events.on("task:delete", this.onTaskDelete);

    const loadCount = (await this.app.storage.get("load-count")) ?? 0;
    await this.app.storage.set("load-count", loadCount + 1);
    console.log(`[ExamplePlugin] Loaded (${loadCount + 1} time(s) total)`);
  }

  async onUnload() {
    this.app.events.off("task:create", this.onTaskCreate);
    this.app.events.off("task:complete", this.onTaskComplete);
    this.app.events.off("task:uncomplete", this.onTaskUncomplete);
    this.app.events.off("task:delete", this.onTaskDelete);

    this.statusItem = null;
    console.log("[ExamplePlugin] Unloaded");
  }

  onTaskCreate = (task) => {
    console.log(`[ExamplePlugin] Task created: ${task.title}`);
    this.pendingCount++;
    this.updateStatusBar();
  };

  onTaskComplete = (task) => {
    console.log(`[ExamplePlugin] Task completed: ${task.title}`);
    this.pendingCount = Math.max(0, this.pendingCount - 1);
    this.updateStatusBar();
  };

  onTaskUncomplete = (task) => {
    console.log(`[ExamplePlugin] Task uncompleted: ${task.title}`);
    this.pendingCount++;
    this.updateStatusBar();
  };

  onTaskDelete = (task) => {
    if (task.status === "pending") {
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      this.updateStatusBar();
    }
  };

  updateStatusBar() {
    this.statusItem?.update({ text: this.formatCount() });
  }

  formatCount() {
    return `${this.pendingCount} pending`;
  }
}
