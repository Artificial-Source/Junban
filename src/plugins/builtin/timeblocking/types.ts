/** Recurrence rule for repeating time blocks/slots. */
export interface RecurrenceRule {
  frequency: "daily" | "weekly" | "monthly";
  interval: number;
  daysOfWeek?: number[];
  endDate?: string;
}

/** A single time block on the calendar. */
export interface TimeBlock {
  id: string;
  taskId?: string;
  slotId?: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  color?: string;
  locked: boolean;
  recurrenceRule?: RecurrenceRule;
  recurrenceParentId?: string;
  createdAt: string;
  updatedAt: string;
}

/** A container slot that holds multiple tasks/blocks. */
export interface TimeSlot {
  id: string;
  title: string;
  projectId?: string;
  date: string;
  startTime: string;
  endTime: string;
  color?: string;
  taskIds: string[];
  recurrenceRule?: RecurrenceRule;
  recurrenceParentId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating a time block. */
export type CreateTimeBlockInput = Omit<TimeBlock, "id" | "createdAt" | "updatedAt">;

/** Input for creating a time slot. */
export type CreateTimeSlotInput = Omit<TimeSlot, "id" | "createdAt" | "updatedAt">;

/** Input for updating a time block. */
export type UpdateTimeBlockInput = Partial<Omit<TimeBlock, "id" | "createdAt" | "updatedAt">>;

/** Input for updating a time slot. */
export type UpdateTimeSlotInput = Partial<Omit<TimeSlot, "id" | "createdAt" | "updatedAt">>;

/** Plugin key-value storage API. */
export interface PluginStorageAPI {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}
