import React from "react";
import { Plugin } from "../../lifecycle.js";
import type { Task } from "../../../core/types.js";
import { createLogger } from "../../../utils/logger.js";
import { TimeBlockStore } from "./store.js";
import { TimeblockingContext } from "./context.js";
import { TimeblockingView as TimeblockingViewComponent } from "./components/TimeblockingView.js";
import { buildTimeblockingTools } from "./ai-tools.js";
import { buildAutoScheduleTools } from "../../../ai/tools/builtin/auto-schedule.js";

const log = createLogger("timeblocking");

/** Wrapper that provides the plugin instance via context. */
function TimeblockingViewWrapper({ plugin }: { plugin: TimeblockingPlugin }) {
  return React.createElement(
    TimeblockingContext.Provider,
    { value: plugin },
    React.createElement(TimeblockingViewComponent),
  );
}

export default class TimeblockingPlugin extends Plugin {
  store!: TimeBlockStore;

  async onLoad(): Promise<void> {
    this.store = new TimeBlockStore(this.app.storage);
    await this.store.initialize();

    this.app.ui.addView({
      id: "timeblocking",
      name: "Timeblocking",
      icon: "📅",
      slot: "navigation",
      contentType: "react",
      component: this.createViewComponent,
    });

    this.app.commands.register({
      id: "tb-new-block",
      name: "Timeblocking: New Block",
      callback: () => {
        // Dispatched via keyboard shortcut 'N' in TimeblockingView
      },
    });

    this.app.commands.register({
      id: "tb-new-slot",
      name: "Timeblocking: New Slot",
      callback: () => {
        // Dispatched via keyboard shortcut in TimeblockingView
      },
    });

    this.app.commands.register({
      id: "tb-day-view",
      name: "Timeblocking: Day View",
      callback: () => {
        // Dispatched via keyboard shortcut 'D' in TimeblockingView
      },
    });

    this.app.commands.register({
      id: "tb-week-view",
      name: "Timeblocking: Week View",
      callback: () => {
        // Dispatched via keyboard shortcut 'W' in TimeblockingView
      },
    });

    this.app.commands.register({
      id: "tb-today",
      name: "Timeblocking: Go to Today",
      callback: () => {
        // Dispatched via keyboard shortcut 'T' in TimeblockingView
      },
    });

    this.app.commands.register({
      id: "tb-toggle-sidebar",
      name: "Timeblocking: Toggle Sidebar",
      callback: () => {
        // Dispatched via keyboard shortcut 'S' in TimeblockingView
      },
    });

    this.app.commands.register({
      id: "tb-focus",
      name: "Timeblocking: Focus on Block",
      callback: () => {
        // Dispatched via keyboard shortcut 'F' in TimeblockingView
      },
    });

    // Register AI tools (requires ai:tools permission)
    const tools = buildTimeblockingTools(this.store, () => ({
      workDayStart: this.settings.get<string>("workDayStart") ?? "09:00",
      workDayEnd: this.settings.get<string>("workDayEnd") ?? "17:00",
      defaultDurationMinutes: parseInt(this.settings.get<string>("defaultDurationMinutes") ?? "30", 10),
    }));
    const autoScheduleTools = buildAutoScheduleTools(this.store, () => ({
      workDayStart: this.settings.get<string>("workDayStart") ?? "09:00",
      workDayEnd: this.settings.get<string>("workDayEnd") ?? "17:00",
      defaultDurationMinutes: parseInt(this.settings.get<string>("defaultDurationMinutes") ?? "30", 10),
      gridIntervalMinutes: parseInt(this.settings.get<string>("gridIntervalMinutes") ?? "15", 10),
    }));
    const allTools = [...tools, ...autoScheduleTools];
    for (const tool of allTools) {
      this.app.ai.registerTool(tool.definition, tool.executor);
    }
    log.info("Registered AI tools", { count: allTools.length });

    log.info("Timeblocking plugin loaded");
  }

  async onUnload(): Promise<void> {
    log.info("Timeblocking plugin unloaded");
  }

  onTaskDelete(task: Task): void {
    this.unlinkTask(task.id);
  }

  private createViewComponent = (): React.ReactElement =>
    React.createElement(TimeblockingViewWrapper, { plugin: this });

  private unlinkTask(taskId: string): void {
    const linked = this.store.listBlocks().filter((b) => b.taskId === taskId);
    for (const block of linked) {
      this.store.updateBlock(block.id, { taskId: undefined });
    }
  }
}
