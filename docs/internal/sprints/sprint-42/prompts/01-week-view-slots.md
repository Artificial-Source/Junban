# Sprint S42: Week View, TimeSlots, N-Day Views, Split Layout

## Context

ASF Junban is a local-first task manager with an Obsidian-style plugin system. Read `CLAUDE.md` for full project context, conventions, and tech stack.

We're building an **Akiflow-inspired timeblocking plugin**. This sprint extends the Day View (S41) with a week view, TimeSlot containers, flexible N-day views, and a polished split layout.

### What already exists (read these files first):

**Timeblocking components (S41):**

- `src/plugins/builtin/timeblocking/components/TimeblockingView.tsx` — Root view with DndContext, date navigation, layout
- `src/plugins/builtin/timeblocking/components/DayTimeline.tsx` — Vertical hour grid with drop targets, block rendering
- `src/plugins/builtin/timeblocking/components/TimeBlockCard.tsx` — Draggable/resizable block card
- `src/plugins/builtin/timeblocking/components/TaskSidebar.tsx` — Draggable task list
- `src/plugins/builtin/timeblocking/components/DragPreview.tsx` — Ghost overlay during drag
- `src/plugins/builtin/timeblocking/context.tsx` — TimeblockingContext + useTimeblocking hook

**Timeblocking core (S40):**

- `src/plugins/builtin/timeblocking/types.ts` — TimeBlock, TimeSlot, RecurrenceRule
- `src/plugins/builtin/timeblocking/store.ts` — TimeBlockStore with CRUD + recurrence expansion
- `src/plugins/builtin/timeblocking/slot-helpers.ts` — isOverlapping, findConflicts, getSlotProgress, getSlotColor, getSlotEstimatedMinutes
- `src/plugins/builtin/timeblocking/recurrence.ts` — expandRecurrence
- `src/plugins/builtin/timeblocking/task-linking.ts` — getBlocksForTask, isTaskScheduled

**Existing DnD patterns:**

- `@dnd-kit/core` + `@dnd-kit/sortable` already installed
- `src/ui/views/Board.tsx` — DndContext + useDraggable + useDroppable reference

**Key convention:** Tailwind 4 with semantic tokens (`bg-surface`, `text-on-surface`, `border-border`, `bg-accent`, etc.)

---

## Phase 1: Week Timeline Grid (TB-15)

Create `src/plugins/builtin/timeblocking/components/WeekTimeline.tsx`:

A 7-column (or N-column) timeline — each column is a compressed day with its own hour grid.

**Requirements:**

- Renders N columns side-by-side, each representing one day
- Each column is a mini DayTimeline (same hour grid, same drop targets)
- Column header: day name + date ("Mon 9", "Tue 10", etc.)
- Today's column gets a highlighted header (accent color background)
- Weekend columns can be visually dimmer (opacity-60) but still functional
- Hours label column on the far left (shared across all day columns)
- Horizontal scroll if columns overflow viewport width (especially on mobile)
- Current time indicator spans across today's column only
- Blocks from the store are distributed to the correct day column by date
- Each column's drop targets include the date in their droppable data

**Props:**

```tsx
interface WeekTimelineProps {
  startDate: Date; // First day of the visible range
  dayCount: number; // Number of columns (1-7)
  blocks: TimeBlock[]; // All blocks in the date range
  slots: TimeSlot[]; // All slots in the date range
  workDayStart: string;
  workDayEnd: string;
  gridInterval: number;
  pixelsPerHour?: number; // default 64 (smaller than day view's 80 to fit more)
  onBlockCreate: (date: string, startTime: string, endTime: string) => void;
  onBlockMove: (blockId: string, newDate: string, newStartTime: string) => void;
  onBlockResize: (blockId: string, newStartTime: string, newEndTime: string) => void;
  onBlockClick: (blockId: string) => void;
  onSlotClick: (slotId: string) => void;
}
```

**Implementation approach:**

- Don't duplicate DayTimeline — extract the shared grid rendering into a reusable `TimelineColumn` component
- Refactor DayTimeline to use `TimelineColumn` internally (single column mode)
- WeekTimeline renders N `TimelineColumn` components in a flex row

Create `src/plugins/builtin/timeblocking/components/TimelineColumn.tsx`:

- Single column of the hour grid with blocks and drop targets
- Used by both DayTimeline (1 column, wide) and WeekTimeline (N columns, compressed)
- Column width: `flex-1 min-w-[120px]` in week mode, `flex-1` in day mode

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 2: TimeSlot Container UI (TB-16)

Create `src/plugins/builtin/timeblocking/components/TimeSlotCard.tsx`:

A visual container block on the timeline that holds multiple tasks inside it. This is the Akiflow "Time Slot" concept.

**Requirements:**

- Renders like a TimeBlockCard but taller and with a task list inside
- Shows: slot title, time range, project color stripe on left edge
- **Task list inside the slot** — each task shown as a compact row (checkbox + title)
- **Task countdown badge** — "3/5" in top-right corner showing completed/total
- **Progress bar** at the bottom of the slot — thin bar showing completion percentage
- Expand/collapse: if slot has many tasks, show first 3 and a "+ N more" button to expand
- Drop target: tasks can be dragged INTO a slot (slot is also a droppable)
- Same drag/resize behavior as TimeBlockCard (move the whole slot, resize edges)
- Visual distinction from regular blocks: slightly different background (e.g., `bg-surface-secondary` or a subtle pattern), thicker left border

**Slot progress** — use the existing `getSlotProgress()` from `slot-helpers.ts`:

```typescript
const progress = getSlotProgress(slot, (taskId) => tasks.find((t) => t.id === taskId));
// progress = { completed: 3, total: 5, percent: 60 }
```

**Slot color** — use `getSlotColor()` from `slot-helpers.ts`:

```typescript
const color = getSlotColor(slot, (projectId) => projects.find((p) => p.id === projectId));
```

**Props:**

```tsx
interface TimeSlotCardProps {
  slot: TimeSlot;
  tasks: Task[]; // all tasks (for lookup)
  projects: Project[]; // all projects (for color)
  pixelsPerHour: number;
  workDayStart: string;
  isConflicting?: boolean;
  onSlotClick: (slotId: string) => void;
  onTaskClick: (taskId: string) => void;
  onTaskToggle: (taskId: string) => void;
  onResizeStart: (slotId: string, edge: "top" | "bottom") => void;
}
```

**Render alongside blocks** in the timeline columns — slots and blocks share the same grid space.

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 3: Drag Tasks Into Slots (TB-17)

Extend the DndContext drop handling in TimeblockingView to support dragging tasks into slots.

**Requirements:**

- A slot is both a droppable target AND contains draggable/droppable task items inside
- When a task from TaskSidebar is dropped ON a TimeSlotCard:
  1. Add the task to the slot: `store.addTaskToSlot(slotId, taskId)`
  2. If the slot has a projectId, the task inherits it (call `this.app.tasks.update?.(taskId, { projectId })` if available — check the plugin API)
  3. Refresh the slot
- When a task already inside a slot is dragged OUT to the timeline (not on a slot), remove it from the slot and create a standalone block
- **Reorder within slot:** Tasks inside a slot can be drag-reordered. Use `@dnd-kit/sortable` for the task list within a slot.
  - On reorder: `store.reorderSlotTasks(slotId, newTaskIds)`

**Droppable data discrimination:**

- Slot droppable: `id: `slot-${slot.id}`, data: { type: "slot", slotId: slot.id }`
- Timeline grid droppable: `id: `grid-${date}-${time}`, data: { type: "timeline-slot", date, time }`
- In `onDragEnd`, check `over.data.current.type` to determine where the task was dropped

**Creating a slot from UI:**

- Add a context menu option or button: "Create Time Slot" (similar to Alt+Click for blocks)
- `Shift+Alt+Click` on timeline creates a slot instead of a block
- Default slot: 2 hours duration, title "Focus Block", empty taskIds

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 4: N-Day Views (TB-18)

Extend TimeblockingView with configurable day count.

**Requirements:**

- Support 1-7 day views: 1 (day), 2, 3, 4, 5 (work week), 6, 7 (full week)
- Keyboard shortcuts: press `1` through `7` to switch day count, `D` for day (1), `W` for week (7)
- View mode selector in the header (segmented control or buttons): "Day | 3-Day | Work Week | Week"
- Default: Day view (1 column)
- When switching from day to multi-day: center the range on the current date
- Date range navigation: `←`/`→` advances by `dayCount` days (e.g., in week view, advance by 7)
- URL hash or local state: remember the last selected day count

**Adapt existing components:**

- `dayCount === 1`: render DayTimeline (wide, more detail)
- `dayCount > 1`: render WeekTimeline with `dayCount` columns
- `pixelsPerHour` auto-adjusts: 80px for 1 day, 64px for 2-3 days, 48px for 4-5 days, 40px for 6-7 days

**Header layout:**

```
[←] [Today] [→]    Monday, March 9 – Sunday, March 15, 2026    [Day] [3D] [5D] [Week]
```

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 5: Split View Layout (TB-19)

Polish the side-by-side layout: task list on the left, timeline on the right.

**Requirements:**

- **Left panel: TaskSidebar** (~280px wide, resizable via drag handle, collapsible)
  - Toggle button at top of sidebar: collapse/expand (chevron icon)
  - When collapsed: only the toggle button visible, timeline gets full width
  - Keyboard shortcut: `\`` (backtick) to toggle sidebar
  - Remember collapsed state in plugin storage
- **Right panel: Timeline** (fills remaining width)
- **Divider:** 4px draggable divider between panels. Cursor `col-resize`. Drag to resize sidebar width. Min 200px, max 400px.
- **Mobile layout** (below 768px): sidebar hidden by default, FAB button to show as bottom sheet overlay

**Task grouping in sidebar:**

- Group tasks by: "Unscheduled" (no blocks today), "Overdue", "Today" (has due date today)
- Each group collapsible with count badge
- Only show pending tasks (not completed/cancelled)

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 6: Tests

### `tests/plugins/timeblocking/components/WeekTimeline.test.tsx`

- Renders correct number of day columns (1, 3, 5, 7)
- Today's column is highlighted
- Blocks distributed to correct day columns
- Hours labels shown on left

### `tests/plugins/timeblocking/components/TimeSlotCard.test.tsx`

- Renders slot title and time range
- Shows task list inside slot
- Task countdown badge (completed/total)
- Progress bar at correct percentage
- Expand/collapse for many tasks

### `tests/plugins/timeblocking/components/TimelineColumn.test.tsx`

- Renders hour grid with correct intervals
- Drop target zones exist for each grid slot
- Current time indicator only on today

### `tests/plugins/timeblocking/components/TimeblockingView-extended.test.tsx`

- N-day view switching (keyboard shortcuts 1-7, D, W)
- Date range navigation advances by dayCount
- Split view: sidebar toggle, resize divider
- Today button works in all view modes

Use `@testing-library/react` and `vitest`. Mock the plugin context/store.

**Final step: Invoke the Code Reviewer sub-agent for a complete pass over ALL files created/modified in this sprint. Verify naming consistency, type correctness, test coverage, and adherence to project conventions. Fix any issues found.**

---

## Rules

- Read existing S41 components before writing — extend, don't duplicate
- Refactor DayTimeline → TimelineColumn extraction is required (don't copy-paste grid logic)
- TypeScript strict mode, no `any` types
- Tailwind for all styling — use semantic tokens
- React function components, named exports
- Use existing @dnd-kit/core + @dnd-kit/sortable — NO new dependencies
- Run `pnpm test` after each phase
- Run `pnpm check` (lint + typecheck + test) at the end
- Commit: `feat(plugin): add timeblocking week view, time slots, and split layout`

## File Structure (expected output)

```
src/plugins/builtin/timeblocking/components/
├── (existing from S41)
├── TimelineColumn.tsx       # Extracted single-column grid (used by Day + Week)
├── WeekTimeline.tsx         # N-column week view
└── TimeSlotCard.tsx         # Slot container with task list + progress

tests/plugins/timeblocking/components/
├── (existing from S41)
├── WeekTimeline.test.tsx
├── TimeSlotCard.test.tsx
├── TimelineColumn.test.tsx
└── TimeblockingView-extended.test.tsx
```

## Definition of Done

- [ ] WeekTimeline renders N day columns (1-7) with shared hour labels
- [ ] TimelineColumn extracted — DayTimeline refactored to use it
- [ ] Today's column highlighted in week view
- [ ] TimeSlotCard renders with task list, countdown, progress bar, expand/collapse
- [ ] Drag task into slot adds it, inherits project
- [ ] Reorder tasks within slot via drag
- [ ] Shift+Alt+Click creates a slot (vs. Alt+Click for block)
- [ ] N-day views switchable via keyboard (1-7, D, W) and header buttons
- [ ] Date navigation advances by dayCount
- [ ] Split view with collapsible/resizable sidebar
- [ ] Task grouping in sidebar (Unscheduled, Overdue, Today)
- [ ] Mobile: sidebar as overlay, timeline full-width
- [ ] All new tests pass
- [ ] `pnpm check` passes clean
- [ ] No regressions in existing tests (2064+ should still pass)
