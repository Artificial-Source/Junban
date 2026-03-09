import React from "react";
import { Plugin } from "../../lifecycle.js";
import { createLogger } from "../../../utils/logger.js";
import { TimeBlockStore } from "./store.js";
import { TimeblockingContext } from "./context.js";
import { TimeblockingView as TimeblockingViewComponent } from "./components/TimeblockingView.js";

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
    this.store = new TimeBlockStore(this.app.storage!);
    await this.store.initialize();

    this.app.events.on("task:delete", (task) => {
      this.unlinkTask(task.id);
    });

    this.app.ui.addView?.({
      id: "timeblocking",
      name: "Timeblocking",
      icon: "📅",
      slot: "navigation",
      contentType: "react",
      component: this.createViewComponent,
    });

    this.app.commands?.register({
      id: "tb-new-block",
      name: "Timeblocking: New Block",
      callback: () => {
        // Dispatched via keyboard shortcut 'N' in TimeblockingView
      },
    });

    this.app.commands?.register({
      id: "tb-new-slot",
      name: "Timeblocking: New Slot",
      callback: () => {
        // Dispatched via keyboard shortcut in TimeblockingView
      },
    });

    this.app.commands?.register({
      id: "tb-day-view",
      name: "Timeblocking: Day View",
      callback: () => {
        // Dispatched via keyboard shortcut 'D' in TimeblockingView
      },
    });

    this.app.commands?.register({
      id: "tb-week-view",
      name: "Timeblocking: Week View",
      callback: () => {
        // Dispatched via keyboard shortcut 'W' in TimeblockingView
      },
    });

    this.app.commands?.register({
      id: "tb-today",
      name: "Timeblocking: Go to Today",
      callback: () => {
        // Dispatched via keyboard shortcut 'T' in TimeblockingView
      },
    });

    this.app.commands?.register({
      id: "tb-toggle-sidebar",
      name: "Timeblocking: Toggle Sidebar",
      callback: () => {
        // Dispatched via keyboard shortcut 'S' in TimeblockingView
      },
    });

    this.app.commands?.register({
      id: "tb-focus",
      name: "Timeblocking: Focus on Block",
      callback: () => {
        // Dispatched via keyboard shortcut 'F' in TimeblockingView
      },
    });

    log.info("Timeblocking plugin loaded");
  }

  async onUnload(): Promise<void> {
    log.info("Timeblocking plugin unloaded");
  }

  onTaskDelete(task: { id: string }): void {
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
