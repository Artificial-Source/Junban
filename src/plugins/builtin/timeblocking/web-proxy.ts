/**
 * Client-side proxy for the Timeblocking plugin.
 * Used in Vite dev mode where the plugin runs server-side and
 * React components need a plugin-like interface via REST.
 */
import type {
  TimeBlock,
  TimeSlot,
  CreateTimeBlockInput,
  CreateTimeSlotInput,
  UpdateTimeBlockInput,
} from "./types.js";
import type { Task } from "../../../core/types.js";

const RPC_URL = "/api/plugins/timeblocking/rpc";

async function rpc<T>(method: string, ...args: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "RPC failed" }));
    throw new Error(err.error ?? `RPC ${method} failed`);
  }
  const data = await res.json();
  return data.result as T;
}

/**
 * Proxy store that mirrors TimeBlockStore API via REST RPC.
 * Caches blocks/slots in memory so synchronous calls work.
 * Must call `refresh()` to populate from server.
 */
export class TimeBlockStoreProxy {
  private blocks: TimeBlock[] = [];
  private slots: TimeSlot[] = [];

  /** Refresh all data from the server. */
  async refresh(): Promise<void> {
    this.blocks = await rpc<TimeBlock[]>("listBlocks");
    this.slots = await rpc<TimeSlot[]>("listSlots");
  }

  listBlocks(date?: string): TimeBlock[] {
    if (date) return this.blocks.filter((b) => b.date === date);
    return [...this.blocks];
  }

  listBlocksInRange(startDate: string, endDate: string): TimeBlock[] {
    return this.blocks.filter((b) => b.date >= startDate && b.date <= endDate);
  }

  listSlots(date?: string): TimeSlot[] {
    if (date) return this.slots.filter((s) => s.date === date);
    return [...this.slots];
  }

  listSlotsInRange(startDate: string, endDate: string): TimeSlot[] {
    return this.slots.filter((s) => s.date >= startDate && s.date <= endDate);
  }

  async createBlock(input: CreateTimeBlockInput): Promise<TimeBlock> {
    const block = await rpc<TimeBlock>("createBlock", input);
    this.blocks.push(block);
    return block;
  }

  async updateBlock(id: string, changes: UpdateTimeBlockInput): Promise<TimeBlock> {
    const updated = await rpc<TimeBlock>("updateBlock", id, changes);
    const idx = this.blocks.findIndex((b) => b.id === id);
    if (idx !== -1) this.blocks[idx] = updated;
    return updated;
  }

  async deleteBlock(id: string): Promise<void> {
    await rpc<void>("deleteBlock", id);
    this.blocks = this.blocks.filter((b) => b.id !== id);
  }

  async createSlot(input: CreateTimeSlotInput): Promise<TimeSlot> {
    const slot = await rpc<TimeSlot>("createSlot", input);
    this.slots.push(slot);
    return slot;
  }

  async addTaskToSlot(slotId: string, taskId: string): Promise<TimeSlot> {
    const updated = await rpc<TimeSlot>("addTaskToSlot", slotId, taskId);
    const idx = this.slots.findIndex((s) => s.id === slotId);
    if (idx !== -1) this.slots[idx] = updated;
    return updated;
  }

  async reorderSlotTasks(slotId: string, taskIds: string[]): Promise<TimeSlot> {
    const updated = await rpc<TimeSlot>("reorderSlotTasks", slotId, taskIds);
    const idx = this.slots.findIndex((s) => s.id === slotId);
    if (idx !== -1) this.slots[idx] = updated;
    return updated;
  }
}

/** Proxy settings that mirrors PluginSettingsManager via REST RPC. */
export class SettingsProxy {
  private cache = new Map<string, string>();

  get<T = string>(key: string): T | undefined {
    return this.cache.get(key) as T | undefined;
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
    // Fire-and-forget — log on failure so silent data loss is visible
    rpc("setSettings", key, value).catch((err: unknown) => {
      console.warn("[timeblocking] Failed to save setting:", key, err);
    });
  }

  async loadAll(): Promise<void> {
    const keys = ["workDayStart", "workDayEnd", "gridIntervalMinutes", "defaultDurationMinutes"];
    for (const key of keys) {
      const val = await rpc<string | null>("getSettings", key);
      if (val !== null && val !== undefined) {
        this.cache.set(key, String(val));
      }
    }
  }
}

/** Proxy for the app API that the timeblocking view uses. */
export class AppProxy {
  tasks = {
    list: async (): Promise<Task[]> => rpc<Task[]>("listTasks"),
  };

  ui = {
    statusBarItems: [] as Array<{ id: string; setText?: (text: string) => void }>,
  };
}

export interface TimeblockingPluginProxy {
  store: TimeBlockStoreProxy;
  settings: SettingsProxy;
  app: AppProxy;
}

/** Create a full proxy instance for the timeblocking plugin. */
export async function createTimeblockingProxy(): Promise<TimeblockingPluginProxy> {
  const store = new TimeBlockStoreProxy();
  const settings = new SettingsProxy();
  const app = new AppProxy();
  await Promise.all([store.refresh(), settings.loadAll()]);
  return { store, settings, app };
}
