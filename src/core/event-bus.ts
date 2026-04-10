import type { Task, Section } from "./types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("event-bus");

/** Map of event names to their payload types. */
export interface EventMap {
  "task:create": Task;
  "task:complete": Task;
  "task:uncomplete": Task;
  "task:update": { task: Task; changes: Partial<Task> };
  "task:delete": Task;
  "task:moved": { task: Task; fromProjectId: string | null; toProjectId: string | null };
  "task:estimated": { task: Task; previousMinutes: number | null; newMinutes: number | null };
  "task:reorder": string[];
  "section:create": Section;
  "section:update": Section;
  "section:delete": Section;
  "section:reorder": string[];
}

export type EventName = keyof EventMap;
export type EventCallback<E extends EventName> = (data: EventMap[E]) => void;

/**
 * Typed pub/sub event bus.
 * Listeners are called synchronously. Errors in listeners are caught and logged.
 */
export class EventBus {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on<E extends EventName>(event: E, callback: EventCallback<E>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback as (...args: unknown[]) => void);
  }

  off<E extends EventName>(event: E, callback: EventCallback<E>): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback as (...args: unknown[]) => void);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  emit<E extends EventName>(event: E, data: EventMap[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;

    for (const callback of [...set]) {
      try {
        callback(data);
      } catch (err) {
        logger.error(`Listener error for "${event}"`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Remove all listeners (used during shutdown). */
  clear(): void {
    this.listeners.clear();
  }

  /** Get listener count for an event (useful for testing). */
  listenerCount(event: EventName): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
