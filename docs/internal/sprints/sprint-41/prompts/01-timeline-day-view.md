# Sprint S41: Timeline UI — Day View

## Context

ASF Junban is a local-first task manager with an Obsidian-style plugin system. Read `CLAUDE.md` for full project context, conventions, and tech stack.

We're building an **Akiflow-inspired timeblocking plugin**. Sprint S40 built the data layer (types, store, recurrence, helpers). This sprint builds the **Day View UI** — a vertical timeline with drag-and-drop time blocks.

### What already exists:

**Timeblocking core (S40):**

- `src/plugins/builtin/timeblocking/types.ts` — TimeBlock, TimeSlot, RecurrenceRule, Create/Update input types
- `src/plugins/builtin/timeblocking/store.ts` — TimeBlockStore with full CRUD, validation, recurrence expansion
- `src/plugins/builtin/timeblocking/slot-helpers.ts` — isOverlapping, findConflicts, getSlotProgress, getSlotColor
- `src/plugins/builtin/timeblocking/recurrence.ts` — expandRecurrence for daily/weekly/monthly
- `src/plugins/builtin/timeblocking/task-linking.ts` — getBlocksForTask, isTaskScheduled
- `src/plugins/builtin/timeblocking/index.ts` — Plugin class with onLoad/onUnload, event listeners

**Plugin React rendering (S39):**

- Plugin views support `contentType: "react"` — pass a React component to `this.app.ui.addView()`
- PluginView.tsx renders React plugin components inside an ErrorBoundary

**Existing drag-and-drop patterns:**

- `@dnd-kit/core` + `@dnd-kit/sortable` already installed
- `src/ui/views/Board.tsx` — DndContext, useDraggable, useDroppable, DragOverlay, PointerSensor pattern
- `src/ui/components/TaskList.tsx` — SortableContext for task reordering

**Existing calendar views (for style reference only — don't modify these):**

- `src/ui/views/Calendar.tsx` — existing month/week/day calendar (task-only, no time blocks)
- `src/ui/views/calendar/CalendarDayView.tsx` — list-based day view

**Design tokens / styling:**

- Tailwind 4 with semantic CSS variables: `bg-surface`, `text-on-surface`, `border-border`, `bg-accent`, etc.
- Design tokens in `src/ui/themes/light.css` and `dark.css`
- Responsive: mobile-first Tailwind, `md:` for desktop (768px breakpoint)

---

## Architecture Decision: Plugin React View

The timeblocking view is a **plugin-registered React component**. The plugin's `index.ts` will register the view like this:

```typescript
// In TimeblockingPlugin.onLoad():
this.app.ui.addView?.({
  id: "timeblocking",
  name: "Timeblocking",
  icon: "📅",
  slot: "navigation",
  contentType: "react",
  component: TimeblockingView,
});
```

The `TimeblockingView` component receives no props from the plugin system — it needs to get data from the plugin's store. **Use a React context** created by the plugin to share the store instance:

```typescript
// src/plugins/builtin/timeblocking/context.tsx
const TimeblockingContext = React.createContext<TimeblockingPlugin | null>(null);
export function useTimeblocking() { ... }
```

The plugin sets itself as the context value when rendering the view. This way all child components can access the store, settings, and task data.

**However**, the plugin doesn't have direct access to the TaskContext (task list, projects, etc.). The view component will need to call `this.app.tasks.list()` to get task data. Read the plugin API at `src/plugins/api.ts` to understand what's available.

---

## Phase 1: Timeline Grid Component (TB-09)

Create `src/plugins/builtin/timeblocking/components/DayTimeline.tsx`:

A vertical timeline grid for a single day.

**Requirements:**

- Renders hours from `workDayStart` to `workDayEnd` (from plugin settings, default 09:00–17:00)
- Each hour row shows the hour label on the left (e.g., "9 AM", "10 AM")
- Grid lines at the configured interval (15, 30, or 60 min)
- **Current time indicator** — a red horizontal line at the current time, with a small red dot on the left edge. Only visible if viewing today.
- The grid should be scrollable vertically (if more hours than viewport)
- Each grid cell is a **drop target** for drag-and-drop (one per grid interval)
- Total grid height = `(workDayEnd - workDayStart) * pixelsPerHour`. Use 80px per hour as default.
- Date header at top showing the current day ("Monday, March 9, 2026")

**Skeleton:**

```tsx
interface DayTimelineProps {
  date: Date;
  blocks: TimeBlock[];
  slots: TimeSlot[];
  workDayStart: string; // "09:00"
  workDayEnd: string; // "17:00"
  gridInterval: number; // 15, 30, or 60 minutes
  pixelsPerHour?: number; // default 80
  onBlockCreate: (date: string, startTime: string, endTime: string) => void;
  onBlockMove: (blockId: string, newDate: string, newStartTime: string) => void;
  onBlockResize: (blockId: string, newStartTime: string, newEndTime: string) => void;
  onBlockClick: (blockId: string) => void;
  onSlotClick: (slotId: string) => void;
  children?: React.ReactNode; // For DragOverlay
}
```

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 2: TimeBlock Visual Component (TB-10)

Create `src/plugins/builtin/timeblocking/components/TimeBlockCard.tsx`:

A card that sits on the timeline grid representing a single time block.

**Requirements:**

- Absolutely positioned within the timeline grid based on `startTime`/`endTime`
- Shows: title, time range ("9:00 – 10:30"), duration ("1h 30m")
- If linked to a task (`taskId`): show task completion state (checkbox circle)
- Color: uses `block.color`, or inherits from the linked task's project color, or uses accent color as fallback
- **Drag handle** — the entire card is draggable (grab cursor), but only via the body (not resize handles)
- **Resize handles** — thin bars at top and bottom edges (4px tall). Cursor changes to `ns-resize` on hover.
- Locked indicator: small lock icon if `block.locked === true`
- Recurring indicator: small repeat icon if `block.recurrenceRule` is set
- Visual states: normal, dragging (opacity 30%), hovered (slight shadow lift), conflict (red left border)
- Compact mode: if block is shorter than 45 min, show only title (no time range or duration)
- Click to select/edit

**Skeleton:**

```tsx
interface TimeBlockCardProps {
  block: TimeBlock;
  pixelsPerHour: number;
  workDayStart: string;
  color?: string; // resolved color
  isConflicting?: boolean;
  taskStatus?: "pending" | "completed" | "cancelled";
  onResizeStart: (blockId: string, edge: "top" | "bottom") => void;
  onClick: (blockId: string) => void;
}
```

**Position calculation:**

```typescript
function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

const top = ((timeToMinutes(block.startTime) - timeToMinutes(workDayStart)) / 60) * pixelsPerHour;
const height =
  ((timeToMinutes(block.endTime) - timeToMinutes(block.startTime)) / 60) * pixelsPerHour;
```

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 3: Drag Task → Timeline (TB-11)

Wire up the DndContext so tasks from a sidebar task list can be dragged onto the timeline to create blocks.

**Create `src/plugins/builtin/timeblocking/components/TaskSidebar.tsx`:**

A condensed task list shown alongside the timeline (left side). This is the source for drag operations.

- Lists pending tasks (fetched via `this.app.tasks.list()`)
- Each task is a draggable item (using `useDraggable` from @dnd-kit/core)
- Shows: title, priority color dot, due date (if set), estimated duration
- Tasks already scheduled for today get a subtle "scheduled" badge
- Compact design — just enough info to identify the task

**Create `src/plugins/builtin/timeblocking/components/TimeblockingView.tsx`:**

The root component that wraps everything in DndContext.

```tsx
export function TimeblockingView() {
  // Get plugin instance from context
  // Load blocks and tasks
  // Set up DndContext with sensors

  return (
    <DndContext sensors={sensors} onDragStart={...} onDragEnd={...}>
      <div className="flex h-full">
        {/* Left: Task sidebar (drag source) */}
        <TaskSidebar tasks={tasks} />

        {/* Right: Day timeline (drop target) */}
        <DayTimeline date={selectedDate} blocks={blocks} ... />
      </div>

      {/* Ghost preview while dragging */}
      <DragOverlay>
        {activeTask ? <DragPreview task={activeTask} /> : null}
        {activeBlock ? <TimeBlockCard block={activeBlock} ... /> : null}
      </DragOverlay>
    </DndContext>
  );
}
```

**Drop behavior:**

- When a task is dropped on a timeline slot:
  1. Calculate `startTime` from the drop Y position (snap to grid interval)
  2. Calculate `endTime` = `startTime` + task's `estimatedMinutes` (or default duration from settings)
  3. Call `store.createBlock({ taskId: task.id, title: task.title, date, startTime, endTime, locked: false })`
  4. Refresh the block list

**Drag data transfer:**

- Draggable tasks use `id: task.id` and `data: { type: "task", task }`
- Draggable blocks use `id: block.id` and `data: { type: "block", block }`
- Drop targets use `id: `slot-${time}``and`data: { type: "timeline-slot", time }`

**PointerSensor config:** Use `activationConstraint: { distance: 5 }` to avoid accidental drags on click.

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 4: Drag to Reposition Blocks (TB-12)

Extend the DndContext `onDragEnd` handler to support moving existing blocks.

**Requirements:**

- Blocks on the timeline are also draggable (via `useDraggable`)
- When a block is dragged to a new position on the same day, update `startTime` and `endTime` (preserve duration)
- Snap to grid interval (if grid is 30 min, blocks snap to :00 and :30)
- Show a ghost preview (DragOverlay) of the block at the cursor position during drag
- Conflict indicator: if the new position overlaps with another block, show the ghost with a red tint
- After drop: call `store.updateBlock(blockId, { startTime: newStart, endTime: newEnd })`

**Snap-to-grid helper:**

```typescript
function snapToGrid(minutes: number, gridInterval: number): number {
  return Math.round(minutes / gridInterval) * gridInterval;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
```

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 5: Resize Blocks (TB-13)

Implement block resizing by dragging the top or bottom edge.

**This is NOT a dnd-kit operation** — use native pointer events for resize since dnd-kit doesn't natively support resize handles well alongside drag.

**Approach:**

- TimeBlockCard renders thin resize handles at top (4px) and bottom (4px)
- On `pointerdown` on a resize handle:
  1. Set `resizing` state: `{ blockId, edge: "top" | "bottom", startY, originalStart, originalEnd }`
  2. Add `pointermove` and `pointerup` listeners to `window`
- On `pointermove`:
  1. Calculate delta Y in pixels
  2. Convert to minutes: `deltaMinutes = (deltaY / pixelsPerHour) * 60`
  3. Snap to grid
  4. If `edge === "top"`: adjust `startTime` (minimum: startTime - duration must leave >= 15 min)
  5. If `edge === "bottom"`: adjust `endTime` (minimum: endTime - startTime must be >= 15 min)
  6. Update a local preview state (don't save to store yet)
- On `pointerup`:
  1. Call `store.updateBlock(blockId, { startTime, endTime })` with final values
  2. Clear resizing state

**Visual feedback during resize:**

- The block height changes in real-time as the user drags
- Time label updates in real-time ("9:00 – 10:30" → "9:00 – 11:00")
- Snap indicator: show a faint line at the snap point

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 6: Click to Create Block (TB-14)

**Requirements:**

- `Alt+Click` (or `Option+Click` on Mac) on an empty timeline slot creates a new standalone block
- The block gets:
  - `title`: "New Block" (editable inline immediately)
  - `startTime`: snapped to the clicked grid slot
  - `endTime`: startTime + default duration (from plugin settings)
  - `locked`: false
  - No `taskId` (standalone)
- After creation, the block title enters **inline edit mode** — a text input replaces the title
- Press Enter or blur to confirm; press Escape to cancel (and delete the block)
- Also support: **double-click** on the timeline as an alternative to Alt+Click

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 7: Wire Plugin + Navigation + Date Controls

Update `src/plugins/builtin/timeblocking/index.ts` to register the React view:

```typescript
import { TimeblockingView } from "./components/TimeblockingView.js";

// In onLoad():
this.app.ui.addView?.({
  id: "timeblocking",
  name: "Timeblocking",
  icon: "📅",
  slot: "navigation",
  contentType: "react",
  component: TimeblockingView,
});
```

**Add date navigation controls** to the top of the TimeblockingView:

- Left/right arrows to navigate days (`←` / `→`)
- "Today" button to jump back to today
- Date display: "Monday, March 9, 2026"
- Keyboard shortcuts: `←` previous day, `→` next day, `T` go to today

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 8: Tests

Create tests in `tests/plugins/timeblocking/`:

### `tests/plugins/timeblocking/components/DayTimeline.test.tsx`

- Renders correct number of hour rows based on workDayStart/workDayEnd
- Shows current time indicator only on today
- Grid lines at correct intervals (15, 30, 60 min)
- Date header displays correct date

### `tests/plugins/timeblocking/components/TimeBlockCard.test.tsx`

- Renders title, time range, duration
- Position calculation (top, height) correct for various times
- Compact mode when duration < 45 min
- Shows lock icon when locked
- Shows repeat icon when recurring
- Conflict state (red border)

### `tests/plugins/timeblocking/components/TimeblockingView.test.tsx`

- Renders task sidebar and timeline
- Date navigation: previous/next day buttons work
- Today button resets to today

### `tests/plugins/timeblocking/components/TaskSidebar.test.tsx`

- Renders task list
- Shows "scheduled" badge for already-scheduled tasks

Use `@testing-library/react` and `vitest` (already configured). Mock the plugin context/store.

**Final step: Invoke the Code Reviewer sub-agent for a complete pass over ALL files created in this sprint. Verify naming consistency, type correctness, test coverage, and adherence to project conventions. Fix any issues found.**

---

## Rules

- Follow existing code patterns — read Board.tsx for DnD patterns, CalendarDayView for styling
- TypeScript strict mode, no `any` types
- Tailwind for all styling — use semantic tokens (`bg-surface`, `text-on-surface`, `border-border`, `bg-accent`)
- React function components, named exports
- Use `@dnd-kit/core` (already installed) — DO NOT install new dependencies unless absolutely necessary
- Responsive: functional on desktop first, mobile can be basic (scrollable timeline)
- Run `pnpm test` after each phase
- Run `pnpm check` (lint + typecheck + test) at the end
- Commit: `feat(plugin): add timeblocking day view with drag-and-drop`

## File Structure (expected output)

```
src/plugins/builtin/timeblocking/
├── (existing files from S40)
├── context.tsx                  # TimeblockingContext + useTimeblocking hook
└── components/
    ├── TimeblockingView.tsx     # Root view — DndContext, layout, date nav
    ├── DayTimeline.tsx          # Vertical timeline grid with drop targets
    ├── TimeBlockCard.tsx        # Individual block (draggable, resizable)
    ├── TaskSidebar.tsx          # Draggable task list (drag source)
    └── DragPreview.tsx          # Ghost overlay during drag

tests/plugins/timeblocking/components/
    ├── DayTimeline.test.tsx
    ├── TimeBlockCard.test.tsx
    ├── TimeblockingView.test.tsx
    └── TaskSidebar.test.tsx
```

## Definition of Done

- [ ] Vertical day timeline renders hours with grid lines at correct intervals
- [ ] Current time indicator (red line) visible on today only
- [ ] TimeBlockCard positioned correctly, shows title/time/duration
- [ ] Drag task from sidebar → drop on timeline → creates block
- [ ] Drag existing block to new time slot → repositions with snap-to-grid
- [ ] Resize block edges → adjusts start/end time with 15 min minimum
- [ ] Alt+Click or double-click on timeline → creates standalone block with inline title edit
- [ ] Date navigation (arrows, Today button, keyboard shortcuts)
- [ ] DragOverlay ghost preview during drag operations
- [ ] Conflict indicator (red tint) when block overlaps another
- [ ] All new tests pass
- [ ] `pnpm check` passes clean
- [ ] No regressions in existing tests
