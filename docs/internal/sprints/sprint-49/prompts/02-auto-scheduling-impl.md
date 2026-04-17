# Sprint 49 — Prompt 02: Auto-Scheduling Implementation

## Role

You are a senior TypeScript engineer implementing the auto-scheduling feature for ASF Junban's timeblocking plugin. The design doc from Prompt 01 has been written to `docs/internal/sprints/sprint-49/results/auto-scheduling-design.md`. Read it first — it is your specification.

## Context

ASF Junban is a local-first, AI-native task manager. Tech: Node 22+, TypeScript strict, React + Tailwind, SQLite (Drizzle ORM), Vitest, pnpm.

**Key existing files you will need to read:**

- `docs/internal/sprints/sprint-49/results/auto-scheduling-design.md` — your spec
- `src/plugins/builtin/timeblocking/types.ts` — TimeBlock, TimeSlot types
- `src/plugins/builtin/timeblocking/store.ts` — block/slot CRUD
- `src/plugins/builtin/timeblocking/task-linking.ts` — task-to-block linking
- `src/plugins/builtin/timeblocking/slot-helpers.ts` — slot computation
- `src/plugins/builtin/timeblocking/index.ts` — plugin entry point
- `src/ai/tools/types.ts` — tool type definitions
- `src/ai/tools/registry.ts` — ToolRegistry
- `src/ai/tools/builtin/` — existing tools for pattern reference
- `src/core/types.ts` — Task type (priority, dueDate, estimatedMinutes, dreadLevel)
- `src/plugins/builtin/timeblocking/components/` — existing UI components

**Conventions:**

- TypeScript strict mode, no `any`
- Named exports preferred
- All public functions get JSDoc for complex logic
- Tailwind for styling, no inline styles
- Tests in `tests/` mirror `src/` structure
- Conventional Commits: `feat(timeblocking): ...`
- Run `pnpm check` (lint + typecheck + test) after each phase

## Phase 1: Scheduling Engine

Read the design doc first, then implement.

### Create `src/plugins/builtin/timeblocking/auto-scheduler.ts`

This file contains the pure scheduling algorithm. No side effects, no store mutations, no UI code.

**Types to define (or import from design doc):**

```typescript
interface SchedulerSettings {
  workDayStart: string; // "HH:mm"
  workDayEnd: string; // "HH:mm"
  defaultDurationMinutes: number;
  gridIntervalMinutes: number;
  bufferMinutes?: number; // gap between blocks, default 0
}

interface ScoredTask {
  task: TaskRow;
  priorityScore: number; // from priority field
  urgencyScore: number; // from deadline proximity
  energyFitScore: number; // from dreadLevel + time-of-day
  compositeScore: number; // weighted combination
}

interface TimeGap {
  start: Date;
  end: Date;
  durationMinutes: number;
}

interface ProposedBlock {
  taskId: string;
  taskTitle: string;
  start: Date;
  end: Date;
  durationMinutes: number;
  isProposed: true;
  score: number; // the composite score that placed it here
}

interface ScheduleWarning {
  type: "needs-splitting" | "overdue" | "no-estimate" | "past-date";
  taskId: string;
  message: string;
}

interface ProposedSchedule {
  date: string; // ISO date
  blocks: ProposedBlock[];
  unschedulable: TaskRow[]; // tasks that didn't fit
  warnings: ScheduleWarning[];
  totalScheduledMinutes: number;
  totalAvailableMinutes: number;
}

interface ScheduleRequest {
  tasks: TaskRow[];
  existingBlocks: TimeBlock[];
  settings: SchedulerSettings;
  date: string; // ISO date "YYYY-MM-DD"
  respectLocked?: boolean; // default true
}
```

**Functions to implement:**

1. **`scoreTasks(tasks: TaskRow[], referenceDate: Date): ScoredTask[]`**
   - Priority: p1=4.0, p2=3.0, p3=2.0, p4=1.0 (default to p3 if missing)
   - Urgency: if no dueDate → 0.5 (neutral). If overdue → 1.0. Otherwise: `1.0 - (daysUntilDue / 14)` clamped to [0, 1]. Exponential curve: square the result for sharper urgency near deadline.
   - Energy fit: dreadLevel 4–5 → prefer morning (score 1.0 for AM placement). dreadLevel 1–2 → prefer afternoon (score 1.0 for PM). dreadLevel 3 or missing → neutral (0.5).
   - Composite: `(priorityScore * 0.4) + (urgencyScore * 0.35) + (energyFitScore * 0.25)`
   - Sort descending by composite score, stable sort by task creation date for ties

2. **`findAvailableGaps(existingBlocks: TimeBlock[], workDayStart: string, workDayEnd: string, date: string): TimeGap[]`**
   - Parse workDayStart/workDayEnd as times on the given date
   - Filter existingBlocks to those overlapping the given date
   - Sort blocks by start time
   - Compute gaps between blocks (and before first / after last)
   - Return gaps with duration > 0

3. **`autoSchedule(request: ScheduleRequest): ProposedSchedule`**
   - Score all tasks
   - Find available gaps
   - Greedy packing: for each scored task (highest first):
     - Determine task duration (estimatedMinutes or defaultDurationMinutes)
     - Find the best gap: for high-dread tasks, prefer earlier gaps; for low-dread, prefer later gaps; for neutral, pick first fit
     - Snap start time to gridIntervalMinutes
     - If task fits in a gap, place it; split the remaining gap
     - If task doesn't fit in any gap, add to unschedulable
     - Apply bufferMinutes between consecutive blocks
   - Generate warnings for edge cases
   - Return ProposedSchedule

4. **`applySchedule(proposed: ProposedSchedule, store: TimeblockingStore): TimeBlock[]`**
   - Convert each ProposedBlock to a TimeBlock
   - Create via store.createBlock()
   - Link tasks via task-linking
   - Return created blocks

**Important:**

- All functions must be pure (except applySchedule which writes to store)
- Use existing types from `types.ts` — don't duplicate TimeBlock definition
- Snap to grid: `Math.ceil(minutes / gridInterval) * gridInterval`
- Handle edge cases from the design doc

### Code Reviewer Checkpoint

After implementing, review:

- [ ] All functions have JSDoc
- [ ] No `any` types
- [ ] Types align with existing TimeBlock from `types.ts`
- [ ] Grid snapping is correct
- [ ] Edge cases handled: empty tasks, no gaps, oversized tasks
- [ ] `pnpm check` passes (lint + typecheck + test — tests may be 0 for new file, that's ok)

Fix any issues before proceeding.

---

## Phase 2: AI Tools

### Create `src/ai/tools/builtin/auto-schedule.ts`

Register two tools with the ToolRegistry, following the exact pattern used by existing tools in the same directory.

**Tool 1: `auto_schedule_day`**

```
Name: auto_schedule_day
Description: Automatically schedule unscheduled tasks into available time blocks for a given day. Uses task priority, deadline urgency, and energy levels to find optimal placement.
Parameters:
  - date: string (ISO date, required) — the day to schedule
  - mode: "suggest" | "auto" (required) — preview or immediately apply
  - respectLocked: boolean (optional, default true) — whether to keep locked blocks
```

Implementation:

1. Fetch pending tasks that are either due on the date, due before (overdue), or have no due date
2. Fetch existing blocks for the date from timeblocking store
3. Get scheduler settings from plugin settings
4. Call `autoSchedule()` with the inputs
5. If mode is "suggest": return a formatted text summary of the proposed schedule
6. If mode is "auto": call `applySchedule()`, then return confirmation text
7. Include warnings and unschedulable tasks in the response

**Tool 2: `reschedule_day`**

```
Name: reschedule_day
Description: Reschedule a day's time blocks after changes (new task, completed task, moved block). Removes non-locked proposed blocks and re-runs scheduling.
Parameters:
  - date: string (ISO date, required) — the day to reschedule
  - keepManual: boolean (optional, default true) — preserve manually-placed (non-auto) blocks
```

Implementation:

1. Fetch all blocks for the date
2. Separate locked/manual blocks from auto-scheduled blocks
3. Delete auto-scheduled blocks (those with an `isAutoScheduled` flag or similar marker)
4. Fetch current pending tasks
5. Run `autoSchedule()` with remaining blocks as existing
6. Apply the new schedule
7. Return summary of changes

**Pattern reference:** Read 2–3 existing tool files to match:

- How tools get registered (default export or named registration function)
- How ToolContext is used to access services
- How Zod schemas define parameters
- How results are formatted for the LLM

### Code Reviewer Checkpoint

After implementing, review:

- [ ] Tool names are snake_case
- [ ] Zod schemas match the parameter descriptions exactly
- [ ] Tools are registered in the same pattern as existing tools
- [ ] Error handling: invalid date format, missing plugin, no tasks found
- [ ] Tools return human-readable text (the LLM will relay this to the user)
- [ ] `pnpm check` passes

Fix any issues before proceeding.

---

## Phase 3: UI Integration

### Modify `src/plugins/builtin/timeblocking/components/DayTimeline.tsx`

Add an "Auto-schedule" button to the day view header area.

**Button behavior:**

1. Click "Auto-schedule" button (calendar + sparkle icon, Tailwind styled)
2. Fetch unscheduled tasks and run `autoSchedule()` in suggest mode
3. Show proposed blocks as **ghost overlays** on the timeline:
   - Dashed border (`border-dashed`)
   - Reduced opacity (`opacity-60`)
   - Distinct background color (e.g., `bg-indigo-100 dark:bg-indigo-900/30`)
   - Label showing task title + duration
4. Show a floating action bar at the bottom: "Apply Schedule" (primary) | "Cancel" (secondary)
5. "Apply" → call `applySchedule()`, convert ghosts to real blocks, dismiss bar
6. "Cancel" → remove ghost overlays, dismiss bar

**Implementation approach:**

- Add state: `proposedSchedule: ProposedSchedule | null`
- When non-null, render ProposedBlock items on the timeline alongside real blocks
- ProposedBlock rendering reuses TimeBlockCard with a `isProposed` variant prop (or a new `ProposedBlockCard` component if TimeBlockCard modification is too invasive)
- The floating action bar is a fixed-position div at the bottom of the timeline container

**New component (if needed): `ProposedBlockOverlay.tsx`**

- Renders a single proposed block on the timeline
- Shows: task title, time range, duration badge
- Dashed border + translucent background
- Click to remove individual proposed block from the preview

**New component: `SchedulePreviewBar.tsx`**

- Fixed bar at bottom of timeline when preview is active
- Shows: "N tasks scheduled, M couldn't fit" summary
- Buttons: "Apply All" (primary), "Cancel" (ghost/secondary)
- If there are unschedulable tasks, show a warning icon + tooltip listing them

### Code Reviewer Checkpoint

After implementing, review:

- [ ] Button placement is consistent with existing header actions
- [ ] Ghost blocks don't interfere with drag-and-drop of real blocks
- [ ] Ghost blocks respect the same grid snapping as real blocks
- [ ] Preview bar doesn't overlap content (proper bottom padding)
- [ ] Accessible: buttons have aria-labels, preview has proper semantics
- [ ] Responsive: works on both desktop and mobile layouts
- [ ] `pnpm check` passes

Fix any issues before proceeding.

---

## Phase 4: Tests

### Unit Tests: `tests/plugins/timeblocking/auto-scheduler.test.ts`

Test the pure scheduling functions thoroughly.

**`scoreTasks` tests:**

- Scores p1 task higher than p4 task
- Overdue task gets maximum urgency
- Task due tomorrow scores higher urgency than task due in 2 weeks
- Task with no due date gets neutral urgency (0.5)
- High dread level (5) gets high energy fit score
- Missing dreadLevel defaults to neutral
- Composite score formula is correct (verify weights)
- Tasks with equal scores maintain stable sort order (by creation date)

**`findAvailableGaps` tests:**

- Empty day (no blocks) → one gap spanning full work hours
- Single block in middle → two gaps (before and after)
- Block at start of day → one gap after
- Block at end of day → one gap before
- Multiple blocks → gaps between each pair
- Overlapping blocks → handled correctly (merged)
- Block outside work hours → ignored
- Work hours validation: start >= end → error or empty

**`autoSchedule` tests:**

- Empty task list → empty schedule, no warnings
- Single task, empty day → placed at work day start (or morning for high-dread)
- Multiple tasks → placed in priority order
- Overbooked day → highest priority tasks scheduled, rest in unschedulable
- Tasks without estimates → use defaultDurationMinutes
- Grid snapping → block start times align to gridIntervalMinutes
- Locked blocks respected → no overlap with existing blocks
- Buffer minutes → gaps between consecutive proposed blocks
- High-dread task placed earlier than low-dread task of same priority
- Task too long for any gap → added to unschedulable with "needs-splitting" warning

**`applySchedule` tests:**

- Proposed blocks are converted to real TimeBlocks via store
- Tasks are linked to created blocks
- Returns created blocks with correct IDs

### Unit Tests: `tests/ai/tools/auto-schedule.test.ts`

Test the AI tool integration.

**`auto_schedule_day` tests:**

- Suggest mode returns formatted text without creating blocks
- Auto mode creates blocks and returns confirmation
- Invalid date format returns error message
- No pending tasks returns appropriate message
- Respects locked blocks when respectLocked is true

**`reschedule_day` tests:**

- Removes auto-scheduled blocks and re-creates schedule
- Preserves manually-placed blocks when keepManual is true
- Returns summary of changes

### E2E Test: `tests/e2e/auto-schedule.spec.ts`

Playwright E2E test for the UI flow.

**Test cases:**

1. **Auto-schedule button visible** — navigate to timeblocking day view, verify button exists
2. **Preview shows ghost blocks** — create 3 tasks with estimates, click auto-schedule, verify ghost blocks appear on timeline with dashed borders
3. **Apply creates real blocks** — click "Apply All" in preview bar, verify ghost blocks become real blocks
4. **Cancel removes preview** — click auto-schedule, then cancel, verify no ghost blocks remain
5. **Overbooked warning** — create tasks totaling more than work hours, auto-schedule, verify warning about unschedulable tasks
6. **Locked blocks respected** — create a locked block, add tasks, auto-schedule, verify no overlap with locked block

### Code Reviewer Checkpoint

After implementing, review:

- [ ] All test files follow existing test patterns (imports, describe blocks, beforeEach setup)
- [ ] Unit tests use `createTestServices()` helper from `tests/integration/helpers.ts` where applicable
- [ ] E2E tests follow patterns from `tests/e2e/timeblocking.spec.ts`
- [ ] No flaky tests (deterministic inputs, no timing dependencies)
- [ ] Edge cases covered comprehensively
- [ ] `pnpm test` passes — all new tests green
- [ ] `pnpm check` passes — full lint + typecheck + test suite

Fix any failing tests before finalizing.

---

## Definition of Done

- [ ] `src/plugins/builtin/timeblocking/auto-scheduler.ts` — pure scheduling engine
- [ ] `src/ai/tools/builtin/auto-schedule.ts` — two AI tools registered
- [ ] UI changes in DayTimeline + new components (ProposedBlockOverlay, SchedulePreviewBar)
- [ ] `tests/plugins/timeblocking/auto-scheduler.test.ts` — comprehensive unit tests
- [ ] `tests/ai/tools/auto-schedule.test.ts` — AI tool unit tests
- [ ] `tests/e2e/auto-schedule.spec.ts` — E2E tests
- [ ] `pnpm check` passes with zero errors
- [ ] No new lint warnings introduced
- [ ] All existing tests still pass (regression check)
- [ ] Commit: `feat(timeblocking): add auto-scheduling engine, AI tools, and preview UI (S49)`

## Final Code Reviewer

After all phases are complete, do a final review across ALL files:

- [ ] Types are consistent between auto-scheduler.ts, AI tools, and UI components
- [ ] No circular imports introduced
- [ ] No duplicate type definitions (reuse from types.ts and auto-scheduler.ts)
- [ ] All imports use named exports
- [ ] No hardcoded values — all constants come from settings or are defined at module top
- [ ] The feature works end-to-end: AI can say "schedule my day" → tool runs → blocks appear
- [ ] Memory: suggest updating MEMORY.md with S49 notes (auto-scheduling, new files, test counts)
