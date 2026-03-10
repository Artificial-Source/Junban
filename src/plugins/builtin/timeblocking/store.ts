import { ValidationError } from "../../../core/errors.js";
import { generateId } from "../../../utils/ids.js";
import { createLogger } from "../../../utils/logger.js";
import { expandRecurrence } from "./recurrence.js";
import type {
  CreateTimeBlockInput,
  CreateTimeSlotInput,
  PluginStorageAPI,
  TimeBlock,
  TimeSlot,
  UpdateTimeBlockInput,
  UpdateTimeSlotInput,
} from "./types.js";

const log = createLogger("timeblocking");

const BLOCKS_KEY = "blocks";
const SLOTS_KEY = "slots";

function parseTime(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ValidationError(`Invalid date format: "${date}" (expected YYYY-MM-DD)`);
  }
  const parsed = new Date(date + "T00:00:00");
  if (isNaN(parsed.getTime())) {
    throw new ValidationError(`Invalid date: "${date}"`);
  }
}

function validateTimeRange(startTime: string, endTime: string): void {
  if (!/^\d{2}:\d{2}$/.test(startTime)) {
    throw new ValidationError(`Invalid startTime format: "${startTime}" (expected HH:mm)`);
  }
  if (!/^\d{2}:\d{2}$/.test(endTime)) {
    throw new ValidationError(`Invalid endTime format: "${endTime}" (expected HH:mm)`);
  }
  const start = parseTime(startTime);
  const end = parseTime(endTime);
  if (start >= end) {
    throw new ValidationError(`startTime "${startTime}" must be before endTime "${endTime}"`);
  }
  if (end - start < 15) {
    throw new ValidationError(
      `Duration must be at least 15 minutes (got ${end - start} minutes)`,
    );
  }
}

function validateTitle(title: string): void {
  if (!title || title.trim().length === 0) {
    throw new ValidationError("Title must be non-empty");
  }
}

export class TimeBlockStore {
  private blocks: TimeBlock[] = [];
  private slots: TimeSlot[] = [];
  private initialized = false;

  constructor(private storage: PluginStorageAPI) {}

  async initialize(): Promise<void> {
    this.blocks = (await this.storage.get<TimeBlock[]>(BLOCKS_KEY)) ?? [];
    this.slots = (await this.storage.get<TimeSlot[]>(SLOTS_KEY)) ?? [];
    this.initialized = true;
    log.info("Initialized", { blocks: this.blocks.length, slots: this.slots.length });
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new ValidationError("TimeBlockStore not initialized — call initialize() first");
    }
  }

  private async persistBlocks(): Promise<void> {
    await this.storage.set(BLOCKS_KEY, this.blocks);
  }

  private async persistSlots(): Promise<void> {
    await this.storage.set(SLOTS_KEY, this.slots);
  }

  // --- TimeBlock CRUD ---

  listBlocks(date?: string): TimeBlock[] {
    this.ensureInitialized();
    if (date) {
      return this.blocks.filter((b) => b.date === date);
    }
    return [...this.blocks];
  }

  listBlocksInRange(startDate: string, endDate: string): TimeBlock[] {
    this.ensureInitialized();
    return this.blocks.filter((b) => b.date >= startDate && b.date <= endDate);
  }

  getBlock(id: string): TimeBlock | null {
    this.ensureInitialized();
    return this.blocks.find((b) => b.id === id) ?? null;
  }

  async createBlock(input: CreateTimeBlockInput): Promise<TimeBlock> {
    this.ensureInitialized();
    validateTitle(input.title);
    validateDate(input.date);
    validateTimeRange(input.startTime, input.endTime);

    const now = new Date().toISOString();
    const block: TimeBlock = {
      ...input,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    };
    this.blocks.push(block);
    await this.persistBlocks();
    log.info("Block created", { id: block.id, title: block.title });
    return block;
  }

  async updateBlock(id: string, changes: UpdateTimeBlockInput): Promise<TimeBlock> {
    this.ensureInitialized();
    const idx = this.blocks.findIndex((b) => b.id === id);
    if (idx === -1) {
      throw new ValidationError(`Block not found: "${id}"`);
    }

    const existing = this.blocks[idx];
    const updated = { ...existing, ...changes, updatedAt: new Date().toISOString() };

    if (changes.title !== undefined) validateTitle(updated.title);
    if (changes.date !== undefined) validateDate(updated.date);
    if (changes.startTime !== undefined || changes.endTime !== undefined) {
      validateTimeRange(updated.startTime, updated.endTime);
    }

    this.blocks[idx] = updated;
    await this.persistBlocks();
    log.info("Block updated", { id });
    return updated;
  }

  async deleteBlock(id: string): Promise<void> {
    this.ensureInitialized();
    const idx = this.blocks.findIndex((b) => b.id === id);
    if (idx === -1) {
      throw new ValidationError(`Block not found: "${id}"`);
    }
    this.blocks.splice(idx, 1);
    await this.persistBlocks();
    log.info("Block deleted", { id });
  }

  // --- TimeSlot CRUD ---

  listSlots(date?: string): TimeSlot[] {
    this.ensureInitialized();
    if (date) {
      return this.slots.filter((s) => s.date === date);
    }
    return [...this.slots];
  }

  listSlotsInRange(startDate: string, endDate: string): TimeSlot[] {
    this.ensureInitialized();
    return this.slots.filter((s) => s.date >= startDate && s.date <= endDate);
  }

  getSlot(id: string): TimeSlot | null {
    this.ensureInitialized();
    return this.slots.find((s) => s.id === id) ?? null;
  }

  async createSlot(input: CreateTimeSlotInput): Promise<TimeSlot> {
    this.ensureInitialized();
    validateTitle(input.title);
    validateDate(input.date);
    validateTimeRange(input.startTime, input.endTime);

    const now = new Date().toISOString();
    const slot: TimeSlot = {
      ...input,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    };
    this.slots.push(slot);
    await this.persistSlots();
    log.info("Slot created", { id: slot.id, title: slot.title });
    return slot;
  }

  async updateSlot(id: string, changes: UpdateTimeSlotInput): Promise<TimeSlot> {
    this.ensureInitialized();
    const idx = this.slots.findIndex((s) => s.id === id);
    if (idx === -1) {
      throw new ValidationError(`Slot not found: "${id}"`);
    }

    const existing = this.slots[idx];
    const updated = { ...existing, ...changes, updatedAt: new Date().toISOString() };

    if (changes.title !== undefined) validateTitle(updated.title);
    if (changes.date !== undefined) validateDate(updated.date);
    if (changes.startTime !== undefined || changes.endTime !== undefined) {
      validateTimeRange(updated.startTime, updated.endTime);
    }

    this.slots[idx] = updated;
    await this.persistSlots();
    log.info("Slot updated", { id });
    return updated;
  }

  async deleteSlot(id: string): Promise<void> {
    this.ensureInitialized();
    const idx = this.slots.findIndex((s) => s.id === id);
    if (idx === -1) {
      throw new ValidationError(`Slot not found: "${id}"`);
    }
    this.slots.splice(idx, 1);
    await this.persistSlots();
    log.info("Slot deleted", { id });
  }

  // --- Slot task management ---

  async addTaskToSlot(slotId: string, taskId: string): Promise<TimeSlot> {
    this.ensureInitialized();
    const idx = this.slots.findIndex((s) => s.id === slotId);
    if (idx === -1) {
      throw new ValidationError(`Slot not found: "${slotId}"`);
    }
    const slot = this.slots[idx];
    if (!slot.taskIds.includes(taskId)) {
      slot.taskIds.push(taskId);
      slot.updatedAt = new Date().toISOString();
      await this.persistSlots();
    }
    return slot;
  }

  async removeTaskFromSlot(slotId: string, taskId: string): Promise<TimeSlot> {
    this.ensureInitialized();
    const idx = this.slots.findIndex((s) => s.id === slotId);
    if (idx === -1) {
      throw new ValidationError(`Slot not found: "${slotId}"`);
    }
    const slot = this.slots[idx];
    slot.taskIds = slot.taskIds.filter((id) => id !== taskId);
    slot.updatedAt = new Date().toISOString();
    await this.persistSlots();
    return slot;
  }

  async reorderSlotTasks(slotId: string, taskIds: string[]): Promise<TimeSlot> {
    this.ensureInitialized();
    const idx = this.slots.findIndex((s) => s.id === slotId);
    if (idx === -1) {
      throw new ValidationError(`Slot not found: "${slotId}"`);
    }
    const slot = this.slots[idx];
    slot.taskIds = taskIds;
    slot.updatedAt = new Date().toISOString();
    await this.persistSlots();
    return slot;
  }

  // --- Recurrence expansion ---

  listBlocksWithRecurrence(startDate: string, endDate: string): TimeBlock[] {
    this.ensureInitialized();
    const nonRecurring = this.blocks.filter(
      (b) => !b.recurrenceRule && b.date >= startDate && b.date <= endDate,
    );
    const recurring = this.blocks.filter((b) => b.recurrenceRule);
    const expanded = recurring.flatMap((b) => expandRecurrence(b, startDate, endDate));
    return [...nonRecurring, ...expanded].sort(
      (a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
    );
  }

  listSlotsWithRecurrence(startDate: string, endDate: string): TimeSlot[] {
    this.ensureInitialized();
    const nonRecurring = this.slots.filter(
      (s) => !s.recurrenceRule && s.date >= startDate && s.date <= endDate,
    );
    const recurring = this.slots.filter((s) => s.recurrenceRule);
    const expanded = recurring.flatMap((s) => expandRecurrence(s, startDate, endDate));
    return [...nonRecurring, ...expanded].sort(
      (a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
    );
  }
}
