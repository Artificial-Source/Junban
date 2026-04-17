# Sprint S40: Timeblocking Core — Data Model, CRUD, Recurrence, Task Linking

## Context

ASF Junban is a local-first task manager with an Obsidian-style plugin system. Read `CLAUDE.md` for full project context, conventions, and tech stack.

We're building an **Akiflow-inspired timeblocking plugin** — a real plugin that lives in `src/plugins/builtin/timeblocking/`. This sprint builds the **pure logic layer**: data model, CRUD, recurrence expansion, and task linking. **No UI in this sprint** — that's Sprint S41.

### What already exists (Sprint S39 — done):

- Plugin views support `contentType: "react"` for React component rendering
- Plugin API has sandboxed `network.fetch()` gated by `"network"` permission
- EventBus emits `task:update`, `task:moved`, `task:estimated` from TaskService
- Plugin base class supports lifecycle hooks: `onTaskCreate`, `onTaskComplete`, `onTaskUpdate`, `onTaskDelete`

### Reference implementation:

- **Pomodoro plugin** at `src/plugins/builtin/pomodoro/` — use as the structural template
- **Plugin base class** at `src/plugins/lifecycle.ts` — extend `Plugin`
- **Plugin API** at `src/plugins/api.ts` — `this.app.storage`, `this.app.tasks`, `this.app.events`
- **Plugin storage** — key-value JSON store via `this.app.storage.get/set/delete/keys`
- **Existing recurrence** at `src/core/recurrence.ts` — simple string-based (`"daily"`, `"weekly"`, `"every N days"`)
- **Event bus** at `src/core/event-bus.ts` — typed pub/sub with `EventMap`

---

## Phase 1: Plugin Scaffold + Data Model (TB-04)

### 1a. Create plugin directory and manifest

Create `src/plugins/builtin/timeblocking/manifest.json`:

```json
{
  "id": "timeblocking",
  "icon": "📅",
  "name": "Timeblocking",
  "version": "1.0.0",
  "author": "ASF",
  "description": "Akiflow-inspired time blocking — drag tasks onto a day/week timeline to schedule your day.",
  "main": "index.ts",
  "minJunbanVersion": "1.0.0",
  "permissions": [
    "task:read",
    "task:write",
    "commands",
    "ui:view",
    "ui:status",
    "storage",
    "settings"
  ],
  "settings": [
    {
      "id": "defaultDurationMinutes",
      "name": "Default Block Duration",
      "type": "select",
      "default": "30",
      "options": ["15", "30", "45", "60", "90", "120"]
    },
    {
      "id": "workDayStart",
      "name": "Work Day Start",
      "type": "select",
      "default": "09:00",
      "options": ["06:00", "07:00", "08:00", "09:00", "10:00"]
    },
    {
      "id": "workDayEnd",
      "name": "Work Day End",
      "type": "select",
      "default": "17:00",
      "options": ["16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00"]
    },
    {
      "id": "gridIntervalMinutes",
      "name": "Grid Interval",
      "type": "select",
      "default": "30",
      "options": ["15", "30", "60"]
    },
    {
      "id": "weekStartDay",
      "name": "Week Start Day",
      "type": "select",
      "default": "monday",
      "options": ["sunday", "monday"]
    }
  ]
}
```

### 1b. Define TypeScript types

Create `src/plugins/builtin/timeblocking/types.ts`:

```typescript
/** Recurrence rule for repeating time blocks/slots. */
export interface RecurrenceRule {
  frequency: "daily" | "weekly" | "monthly";
  interval: number; // e.g. 1 = every week, 2 = every other week
  daysOfWeek?: number[]; // 0=Sun..6=Sat (for weekly frequency)
  endDate?: string; // ISO date string, optional end
}

/** A single time block on the calendar. */
export interface TimeBlock {
  id: string;
  taskId?: string; // linked task (optional — standalone blocks allowed)
  slotId?: string; // parent TimeSlot (if grouped inside a container)
  title: string;
  date: string; // "2026-03-08"
  startTime: string; // "09:00" (HH:mm, 24h)
  endTime: string; // "10:30" (HH:mm, 24h)
  color?: string; // hex color override (else inherit from linked task's project)
  locked: boolean; // "locked" = treated as a real calendar event
  recurrenceRule?: RecurrenceRule;
  recurrenceParentId?: string; // points to the original block if this is a recurrence instance
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

/** A container slot that holds multiple tasks/blocks. */
export interface TimeSlot {
  id: string;
  title: string;
  projectId?: string; // linked project — tasks dragged in inherit this
  date: string; // "2026-03-08"
  startTime: string; // "09:00"
  endTime: string; // "11:00"
  color?: string; // hex color override (else inherit from project)
  taskIds: string[]; // ordered list of tasks inside this slot
  recurrenceRule?: RecurrenceRule;
  recurrenceParentId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating a time block (id and timestamps auto-generated). */
export type CreateTimeBlockInput = Omit<TimeBlock, "id" | "createdAt" | "updatedAt">;

/** Input for creating a time slot. */
export type CreateTimeSlotInput = Omit<TimeSlot, "id" | "createdAt" | "updatedAt">;

/** Input for updating a time block (all fields optional except id). */
export type UpdateTimeBlockInput = Partial<Omit<TimeBlock, "id" | "createdAt" | "updatedAt">>;

/** Input for updating a time slot. */
export type UpdateTimeSlotInput = Partial<Omit<TimeSlot, "id" | "createdAt" | "updatedAt">>;
```

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 2: Storage Layer (TB-05)

Create `src/plugins/builtin/timeblocking/store.ts` — a storage abstraction over the plugin key-value API.

The plugin storage API (`this.app.storage`) is a simple key-value store:

- `get<T>(key: string): Promise<T | null>`
- `set(key: string, value: unknown): Promise<void>`
- `delete(key: string): Promise<void>`
- `keys(): Promise<string[]>`

Build a `TimeBlockStore` class that uses this to manage collections of TimeBlocks and TimeSlots.

**Storage key strategy:**

- `blocks` — JSON array of all TimeBlock objects
- `slots` — JSON array of all TimeSlot objects

The store loads the full collection into memory on init, mutates in-memory, and persists back. This mirrors the MarkdownBackend pattern (in-memory indexes, persist on mutation).

**Requirements:**

```typescript
export class TimeBlockStore {
  constructor(private storage: PluginStorageAPI) {}

  // Must be called before any operations
  async initialize(): Promise<void>;

  // TimeBlock CRUD
  listBlocks(date?: string): TimeBlock[];
  listBlocksInRange(startDate: string, endDate: string): TimeBlock[];
  getBlock(id: string): TimeBlock | null;
  async createBlock(input: CreateTimeBlockInput): Promise<TimeBlock>;
  async updateBlock(id: string, changes: UpdateTimeBlockInput): Promise<TimeBlock>;
  async deleteBlock(id: string): Promise<void>;

  // TimeSlot CRUD
  listSlots(date?: string): TimeSlot[];
  listSlotsInRange(startDate: string, endDate: string): TimeSlot[];
  getSlot(id: string): TimeSlot | null;
  async createSlot(input: CreateTimeSlotInput): Promise<TimeSlot>;
  async updateSlot(id: string, changes: UpdateTimeSlotInput): Promise<TimeSlot>;
  async deleteSlot(id: string): Promise<void>;

  // Slot task management
  async addTaskToSlot(slotId: string, taskId: string): Promise<TimeSlot>;
  async removeTaskFromSlot(slotId: string, taskId: string): Promise<TimeSlot>;
  async reorderSlotTasks(slotId: string, taskIds: string[]): Promise<TimeSlot>;
}
```

Where `PluginStorageAPI` is the type of `this.app.storage`:

```typescript
interface PluginStorageAPI {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}
```

**Validation rules:**

- `startTime` must be before `endTime` (compare as "HH:mm" strings)
- `title` must be non-empty
- `date` must be a valid ISO date string ("YYYY-MM-DD")
- `endTime - startTime` must be at least 15 minutes
- Throw `ValidationError` (from `src/core/errors.ts`) on invalid input

**ID generation:** Use `nanoid` from `src/utils/ids.ts` (import `generateId`).

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 3: TimeSlot Container Logic (TB-06)

Extend `TimeBlockStore` or create helpers in a new file `src/plugins/builtin/timeblocking/slot-helpers.ts`:

```typescript
/** Get completion progress for a slot: how many of its tasks are completed. */
export function getSlotProgress(
  slot: TimeSlot,
  taskLookup: (taskId: string) => { status: string } | undefined,
): { completed: number; total: number; percent: number };

/** Get the effective color for a slot (explicit color > project color > default). */
export function getSlotColor(
  slot: TimeSlot,
  projectLookup: (projectId: string) => { color: string } | undefined,
  defaultColor?: string,
): string;

/** Calculate the total estimated minutes for tasks in a slot. */
export function getSlotEstimatedMinutes(
  slot: TimeSlot,
  taskLookup: (taskId: string) => { estimatedMinutes?: number | null } | undefined,
): number;

/** Check if a time range overlaps with a slot. */
export function isOverlapping(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean;

/** Find all conflicts (overlapping blocks/slots) for a given date. */
export function findConflicts(
  blocks: TimeBlock[],
  slots: TimeSlot[],
  date: string,
): Array<{ a: { id: string; type: "block" | "slot" }; b: { id: string; type: "block" | "slot" } }>;
```

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 4: Recurrence Engine (TB-07)

Create `src/plugins/builtin/timeblocking/recurrence.ts`:

This is **different from the existing `src/core/recurrence.ts`** (which handles task recurrence). Timeblock recurrence needs to expand a single recurring block/slot into multiple instances across a date range.

```typescript
/**
 * Expand a recurring time block/slot into concrete instances for a date range.
 *
 * Given a block with recurrenceRule, generate all occurrences between startDate and endDate.
 * Each instance gets a unique ID and a `recurrenceParentId` pointing to the original.
 * Instance dates are calculated but time (startTime/endTime) stays the same.
 */
export function expandRecurrence<
  T extends { id: string; date: string; recurrenceRule?: RecurrenceRule },
>(
  item: T,
  rangeStart: string, // "2026-03-01"
  rangeEnd: string, // "2026-03-31"
): T[];
```

**Recurrence logic:**

- `daily` with `interval: 1` → every day, `interval: 2` → every other day
- `weekly` with `interval: 1, daysOfWeek: [1, 3, 5]` → every Mon/Wed/Fri
- `weekly` with `interval: 2, daysOfWeek: [1]` → every other Monday
- `monthly` with `interval: 1` → same date each month (skip if date doesn't exist, e.g. Feb 31)
- If `endDate` is set, stop generating instances after that date
- Each generated instance should have:
  - A deterministic ID: `${parentId}_${date}` (so the same expansion always produces the same IDs)
  - `recurrenceParentId` set to the original item's `id`
  - `recurrenceRule` set to `undefined` (instances don't recurse)
  - All other fields copied from the parent

**Also add to `TimeBlockStore`:**

```typescript
/** Get all blocks for a date range, including expanded recurring instances. */
listBlocksWithRecurrence(startDate: string, endDate: string): TimeBlock[];

/** Get all slots for a date range, including expanded recurring instances. */
listSlotsWithRecurrence(startDate: string, endDate: string): TimeSlot[];
```

These methods should:

1. Get all blocks/slots in range (non-recurring)
2. Get all blocks/slots with a `recurrenceRule` that could produce instances in range
3. Expand them and merge with the non-recurring list
4. Sort by date + startTime

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 5: Task ↔ TimeBlock Linking (TB-08)

Create `src/plugins/builtin/timeblocking/task-linking.ts`:

Handle the bidirectional relationship between tasks and time blocks.

```typescript
/**
 * When a task is linked to a block, we track it via the block's `taskId` field.
 * This module provides helpers for managing that relationship.
 */

/** Find all blocks linked to a specific task. */
export function getBlocksForTask(blocks: TimeBlock[], taskId: string): TimeBlock[];

/** Find the block linked to a task on a specific date (if any). */
export function getBlockForTaskOnDate(
  blocks: TimeBlock[],
  taskId: string,
  date: string,
): TimeBlock | null;

/** Check if a task is already scheduled (has any linked block in the future). */
export function isTaskScheduled(blocks: TimeBlock[], taskId: string, today: string): boolean;
```

**Now wire it into the plugin class.**

Create `src/plugins/builtin/timeblocking/index.ts`:

```typescript
import { Plugin } from "../../lifecycle.js";
import { TimeBlockStore } from "./store.js";

export default class TimeblockingPlugin extends Plugin {
  store!: TimeBlockStore;

  async onLoad() {
    this.store = new TimeBlockStore(this.app.storage!);
    await this.store.initialize();

    // Listen for task completion — mark linked blocks as done
    this.app.events.on("task:complete", (task) => {
      // Find blocks linked to this task and update them (visual state)
      // The block itself doesn't have a "completed" field — the task's status IS the block's status
      // This is a hook point for future features (e.g., auto-advance to next block)
    });

    // Listen for task deletion — unlink from blocks (don't delete the block)
    this.app.events.on("task:delete", (task) => {
      const linked = this.store.listBlocks().filter((b) => b.taskId === task.id);
      for (const block of linked) {
        this.store.updateBlock(block.id, { taskId: undefined });
      }
    });

    // Register the timeblocking view (React component will come in S41)
    // For now, register a placeholder structured view
    this.app.ui.addView?.({
      id: "timeblocking",
      name: "Timeblocking",
      icon: "📅",
      slot: "navigation",
      contentType: "structured",
      render: () =>
        JSON.stringify({
          type: "list",
          items: [
            { label: "Timeblocking view coming in Sprint S41" },
            { label: `${this.store.listBlocks().length} blocks stored` },
            { label: `${this.store.listSlots().length} slots stored` },
          ],
        }),
    });

    // Register commands
    this.app.commands?.register({
      id: "new-block",
      name: "Timeblocking: New Block",
      callback: () => {
        // Will be wired to UI in S41
      },
    });

    this.app.commands?.register({
      id: "new-slot",
      name: "Timeblocking: New Slot",
      callback: () => {
        // Will be wired to UI in S41
      },
    });
  }

  async onUnload() {
    // Cleanup — event listeners are auto-removed by the plugin system
  }

  onTaskDelete(task: { id: string }) {
    // Also handle via lifecycle hook (backup for event bus)
    const linked = this.store.listBlocks().filter((b) => b.taskId === task.id);
    for (const block of linked) {
      this.store.updateBlock(block.id, { taskId: undefined });
    }
  }
}
```

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 6: Tests

Create comprehensive tests in `tests/plugins/timeblocking/`:

### `tests/plugins/timeblocking/types.test.ts`

- Validate type shapes (compile-time checks are sufficient, but verify imports work)

### `tests/plugins/timeblocking/store.test.ts`

Test `TimeBlockStore` with a mock storage API:

- Create, read, update, delete blocks
- Create, read, update, delete slots
- List blocks by date and date range
- List slots by date and date range
- Add/remove/reorder tasks in slots
- Validation: reject invalid startTime/endTime, empty title, short duration
- Persistence: verify `storage.set()` called after mutations
- Initialize: verify `storage.get()` called on init

### `tests/plugins/timeblocking/slot-helpers.test.ts`

- `getSlotProgress` with various completion states
- `getSlotColor` priority chain (explicit > project > default)
- `getSlotEstimatedMinutes` sum calculation
- `isOverlapping` edge cases (adjacent = not overlapping, partial overlap, contained)
- `findConflicts` with mixed blocks and slots

### `tests/plugins/timeblocking/recurrence.test.ts`

- Daily recurrence (interval 1 and 2)
- Weekly recurrence with specific days
- Weekly recurrence with interval > 1
- Monthly recurrence (including month-end edge cases)
- `endDate` cutoff
- Deterministic instance IDs
- Empty range (start > end)
- `listBlocksWithRecurrence` merges recurring and non-recurring
- `listSlotsWithRecurrence` same

### `tests/plugins/timeblocking/task-linking.test.ts`

- `getBlocksForTask` finds all linked blocks
- `getBlockForTaskOnDate` finds specific date
- `isTaskScheduled` checks future blocks only
- Task deletion unlinks blocks (via plugin event handler)

**Mock the storage API** for all tests:

```typescript
function createMockStorage(): PluginStorageAPI {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => (data.get(key) as T) ?? null,
    set: async (key: string, value: unknown) => {
      data.set(key, value);
    },
    delete: async (key: string) => {
      data.delete(key);
    },
    keys: async () => Array.from(data.keys()),
  };
}
```

**Before proceeding to the final review, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Rules

- Follow existing code patterns — read `CLAUDE.md` and the Pomodoro plugin before writing
- TypeScript strict mode, no `any` types
- Named exports preferred (except the default Plugin export in `index.ts`)
- Use `generateId()` from `src/utils/ids.ts` for IDs
- Use `ValidationError` from `src/core/errors.ts` for validation failures
- Use `createLogger("timeblocking")` from `src/utils/logger.ts` for logging
- No UI code in this sprint — that's S41
- Run `pnpm test` after each phase
- Run `pnpm check` (lint + typecheck + test) at the end
- Follow conventional commits: `feat(plugin): add timeblocking data model and store`

## File Structure (expected output)

```
src/plugins/builtin/timeblocking/
├── manifest.json        # Plugin manifest with settings
├── index.ts             # Plugin entry — extends Plugin, wires lifecycle
├── types.ts             # TimeBlock, TimeSlot, RecurrenceRule, input types
├── store.ts             # TimeBlockStore — CRUD over plugin storage API
├── slot-helpers.ts      # Slot progress, color, estimation, conflict detection
├── recurrence.ts        # Recurrence expansion engine
└── task-linking.ts      # Task ↔ block relationship helpers

tests/plugins/timeblocking/
├── store.test.ts        # Store CRUD + validation + persistence
├── slot-helpers.test.ts # Slot helpers
├── recurrence.test.ts   # Recurrence expansion
└── task-linking.test.ts # Task linking
```

## Definition of Done

- [ ] `manifest.json` with all settings defined
- [ ] `types.ts` with TimeBlock, TimeSlot, RecurrenceRule, and all input types
- [ ] `store.ts` with full CRUD for blocks and slots, validation, persistence
- [ ] `slot-helpers.ts` with progress, color, estimation, overlap, conflict detection
- [ ] `recurrence.ts` expanding daily/weekly/monthly rules into instances
- [ ] `task-linking.ts` with block lookup and schedule detection helpers
- [ ] `index.ts` plugin entry with lifecycle hooks, event listeners, placeholder view, commands
- [ ] All tests pass — target 40+ test cases across 4 test files
- [ ] `pnpm check` passes clean (lint + typecheck + test)
- [ ] No regressions in existing tests (1956 should still pass)

**Final step: Invoke the Code Reviewer sub-agent for a complete pass over ALL files created in this sprint. Verify naming consistency, type correctness, test coverage, and adherence to project conventions. Fix any issues found.**
