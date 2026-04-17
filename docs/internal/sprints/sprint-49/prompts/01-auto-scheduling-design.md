# Sprint 49 — Prompt 01: Auto-Scheduling Design Doc

## Role

You are a senior systems architect designing the auto-scheduling feature for ASF Junban's timeblocking plugin. You will research the existing codebase, then produce a detailed design document.

## Context

ASF Junban is a local-first, AI-native task manager. The timeblocking plugin (`src/plugins/builtin/timeblocking/`) provides a visual day/week timeline where users manually drag tasks into time blocks. Sprint 49 adds **auto-scheduling** — the system proposes an optimal daily schedule based on task metadata.

**Relevant task fields:**

- `id`, `title`, `status` ("pending" | "completed" | "cancelled")
- `priority` (1–4, where 1 is highest)
- `dueDate` (optional ISO date)
- `estimatedMinutes` (optional, added in S47)
- `dreadLevel` (optional 1–5, added in S48 — higher means the user dreads the task more)

**Timeblocking plugin structure:**

- `types.ts` — `TimeBlock`, `TimeSlot` types
- `store.ts` — CRUD for blocks/slots (persisted via plugin settings in SQLite)
- `task-linking.ts` — links tasks to time blocks
- `slot-helpers.ts` — slot computation helpers
- `recurrence.ts` — recurring block patterns
- Components: `DayTimeline`, `WeekTimeline`, `TimeBlockCard`, `TimeSlotCard`

**Plugin settings (from manifest):**

- `defaultDurationMinutes` (fallback for tasks without estimates)
- `workDayStart` (e.g., "09:00")
- `workDayEnd` (e.g., "17:00")
- `gridIntervalMinutes` (e.g., 15)
- `weekStartDay`

**AI tool system:**

- Tools register via `ToolRegistry` in `src/ai/tools/builtin/`
- Existing timeblocking AI tools handle basic block CRUD
- Tools define a Zod schema for parameters and receive a `ToolContext` with access to services

**Tech stack:** Node 22+, TypeScript strict, React + Tailwind, SQLite (Drizzle), Vitest, pnpm.

## Instructions

### Phase 1: Research

Read and understand these files thoroughly:

1. **Timeblocking types and data model:**
   - `src/plugins/builtin/timeblocking/types.ts`
   - `src/plugins/builtin/timeblocking/store.ts`
   - `src/plugins/builtin/timeblocking/task-linking.ts`
   - `src/plugins/builtin/timeblocking/slot-helpers.ts`
   - `src/plugins/builtin/timeblocking/recurrence.ts`

2. **Existing AI tools (for pattern reference):**
   - `src/ai/tools/registry.ts` — how tools are registered
   - `src/ai/tools/types.ts` — tool type definitions
   - All files in `src/ai/tools/builtin/` — especially any timeblocking-related tools

3. **Task types and services:**
   - `src/core/types.ts` — Task type definition, including `estimatedMinutes` and `dreadLevel`
   - `src/core/tasks.ts` — TaskService API

4. **Plugin API surface:**
   - `src/plugins/api.ts` — what plugins can access
   - `src/plugins/settings.ts` — how plugin settings are stored/retrieved

### Phase 2: Design

After research, write the design document to:
**`docs/internal/sprints/sprint-49/results/auto-scheduling-design.md`**

The design doc MUST include these sections:

#### 1. Overview

One-paragraph summary of what auto-scheduling does and why it matters.

#### 2. Architecture Diagram (ASCII)

Show data flow from task list + settings through the scheduling engine to proposed schedule output. Include:

- Input sources (tasks, existing blocks, settings)
- Scheduling engine (heuristic scorer + slot packer)
- Output (ProposedSchedule)
- UI preview layer
- AI tool integration point

#### 3. Algorithm Design

**Heuristic Scoring Function:**

- Priority weight (p1=4, p2=3, p3=2, p4=1)
- Deadline urgency (days until due → exponential curve, overdue tasks get maximum urgency)
- Energy/time-of-day fit using dreadLevel:
  - High-dread tasks scheduled in morning (when willpower is highest)
  - Low-dread tasks fill afternoon slots
  - Configurable energy curve (morning peak, post-lunch dip, afternoon recovery)
- Combined score formula with tunable weights

**Slot Packing Algorithm:**

- Sort tasks by composite score (descending)
- Collect available time slots (workDayStart to workDayEnd minus locked blocks)
- Greedy bin-packing: assign highest-scored task to the best-fit available slot
- Respect grid interval snapping (round to gridIntervalMinutes)
- Handle tasks without estimatedMinutes using defaultDurationMinutes

**LLM Refinement (optional second pass):**

- Only invoked when conflicts or ambiguities exist
- LLM receives: proposed schedule + task descriptions + user context
- LLM can: reorder within same-priority tier, suggest splitting long tasks, flag unrealistic schedules
- This is enhancement, not required path — heuristic alone must produce a valid schedule

#### 4. Data Types

Define these new types (TypeScript interfaces):

- `ScheduleRequest` — input to the scheduler
- `ScoredTask` — task with computed priority score
- `TimeGap` — available slot between locked blocks
- `ProposedBlock` — a proposed TimeBlock placement (with `isProposed: true` flag)
- `ProposedSchedule` — the full output: array of ProposedBlocks + metadata (unschedulable tasks, warnings)
- `SchedulerSettings` — extracted from plugin settings

#### 5. API Surface

Functions to expose from `auto-scheduler.ts`:

- `scoreTasks(tasks, referenceDate) → ScoredTask[]` — pure scoring, useful independently
- `findAvailableGaps(existingBlocks, workDayStart, workDayEnd) → TimeGap[]`
- `autoSchedule(request: ScheduleRequest) → ProposedSchedule` — main entry point
- `applySchedule(proposed: ProposedSchedule, store) → TimeBlock[]` — commit proposed blocks

AI tools to register:

- `auto_schedule_day` — schedule unscheduled tasks for a date
- `reschedule_day` — re-run scheduling after changes

#### 6. Modes of Operation

**"suggest" mode:**

- Returns ProposedSchedule without persisting
- UI shows ghost blocks on timeline
- User can accept all, accept individual, or cancel

**"auto" mode:**

- Runs scheduling and immediately persists via store
- Used by AI assistant for hands-free scheduling
- Still returns the schedule for confirmation message

#### 7. Conflict Resolution Rules

- Locked blocks are immutable — never moved or overlapped
- If total task time exceeds available hours: schedule what fits by priority, return overflow in `unschedulable`
- Overdue tasks get highest urgency but don't bypass locked blocks
- Recurring blocks are treated as locked
- Buffer time: optional N-minute gap between blocks (default 0, configurable)

#### 8. Edge Cases

- Empty task list → return empty schedule, no error
- No available gaps (fully booked day) → return all tasks as unschedulable
- Task longer than any single gap → flag as "needs splitting" in warnings
- All tasks lack estimates → use defaultDurationMinutes for all
- Tasks with same score → stable sort by creation date (FIFO)
- workDayStart >= workDayEnd → validation error
- Date in the past → allow but warn

#### 9. Open Questions

List 3–5 design decisions that need user/team input before implementation. Examples:

- Should auto-schedule respect task order within a project (sequential dependencies)?
- Should there be a "focus time" concept (blocks of uninterrupted deep work)?
- Should the energy curve be user-configurable or fixed?
- Should completed tasks' blocks be reclaimed for rescheduling?

### Phase 3: Code Reviewer Validation

After writing the design doc, review it for:

- Consistency with existing timeblocking types (do ProposedBlock fields align with TimeBlock?)
- Consistency with existing AI tool patterns (does the tool API match registry conventions?)
- No introduction of external dependencies (algorithm must be pure TypeScript)
- All settings referenced actually exist in plugin manifest
- Edge cases are comprehensive

Fix any inconsistencies found before finalizing.

## Output

The design document at `docs/internal/sprints/sprint-49/results/auto-scheduling-design.md`.
