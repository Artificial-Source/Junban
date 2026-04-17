# Sprint 47 — A-36: Time Estimation & Tracking

## Context

You are working on **ASF Junban**, a local-first, AI-native task manager. The codebase is TypeScript strict mode, React + Tailwind CSS frontend, SQLite via Drizzle ORM, Vitest for testing, pnpm as package manager.

**Key conventions:**

- Named exports preferred
- No `any` types
- Conventional Commits (`feat(core): ...`, `fix(parser): ...`)
- All public functions have JSDoc for complex logic
- React function components, Tailwind for styling
- Zod for runtime validation, Drizzle for DB schema
- Tests in `tests/` mirror `src/` structure

**Key files you will touch:**

- `src/db/schema.ts` — Drizzle SQLite schema (14 tables)
- `src/core/types.ts` — Zod schemas + TypeScript types
- `src/core/tasks.ts` — Task CRUD operations
- `src/storage/interface.ts` — IStorage abstraction
- `src/storage/sqlite-backend.ts` — SQLite implementation
- `src/storage/markdown-backend.ts` — Markdown + YAML frontmatter implementation
- `src/ai/tools/builtin/` — AI tool definitions
- `src/ai/tools/registry.ts` — Tool registration
- `src/parser/task-parser.ts` — Natural language task input parser
- `src/ui/components/TaskDetailPanel.tsx` — Task detail sidebar
- `src/ui/components/TaskItem.tsx` — Task row in lists
- `src/ui/components/TaskInput.tsx` — Main task input field

**Architecture patterns:**

- Database schema uses Drizzle's `sqliteTable()` with `text()`, `integer()`, etc.
- Types use Zod schemas (`z.object({...})`) that derive TypeScript types via `z.infer<>`
- `CreateTaskInput` and `UpdateTaskInput` are Zod schemas in `src/core/types.ts`
- `IStorage` interface in `src/storage/interface.ts` abstracts all data operations
- `SQLiteBackend` wraps `createQueries()` from `src/db/queries.ts`
- `MarkdownBackend` stores tasks as `.md` files with YAML frontmatter
- AI tools follow the pattern: `export function registerXxxTool(registry: ToolRegistry): void { registry.register({...}, async (args, ctx) => {...}); }`
- Tools are wired in `src/ai/tools/registry.ts`
- Migrations are generated with `pnpm db:generate`

---

## Goal

Add time estimation and actual time tracking to tasks. Users can set an estimated duration, start/stop a timer to track actual time, and an AI tool can suggest estimates based on historical data from completed tasks.

---

## Phase 1: Schema + Types

### 1a. Database Schema

Open `src/db/schema.ts`. Add two new nullable integer columns to the `tasks` table:

```typescript
estimatedMinutes: integer("estimated_minutes"),
actualMinutes: integer("actual_minutes"),
```

These are nullable — most tasks won't have estimates initially.

### 1b. Generate Migration

Run:

```bash
pnpm db:generate
```

This creates a new SQL migration file in `src/db/migrations/`. Verify the generated migration adds the two columns with `ALTER TABLE tasks ADD COLUMN`.

### 1c. Update Core Types

Open `src/core/types.ts`.

Update `CreateTaskInput` Zod schema — add:

```typescript
estimatedMinutes: z.number().int().positive().max(14400).nullable().optional(),
```

(14400 minutes = 10 days — reasonable upper bound)

Update `UpdateTaskInput` similarly — add both:

```typescript
estimatedMinutes: z.number().int().positive().max(14400).nullable().optional(),
actualMinutes: z.number().int().nonnegative().max(14400).nullable().optional(),
```

Update the `Task` type / `TaskRow` type to include both fields. Check how existing fields are typed — follow the same pattern. Both should be `number | null`.

### 1d. Update IStorage Interface

Open `src/storage/interface.ts`. Find the `TaskRow` type (or equivalent row type used by storage). Add `estimatedMinutes` and `actualMinutes` as `number | null` fields.

### 1e. Update SQLite Backend

Open `src/storage/sqlite-backend.ts`. The new columns should flow through automatically via Drizzle if the schema is updated, but verify that:

- `createTask()` passes `estimatedMinutes` through
- `updateTask()` passes both fields through
- Query results include the new fields

### 1f. Update Markdown Backend

Open `src/storage/markdown-backend.ts` (and files in `src/storage/markdown/` if task operations were decomposed there). Update:

- YAML frontmatter serialization to include `estimated_minutes` and `actual_minutes` keys
- YAML frontmatter parsing to read these keys back into `estimatedMinutes` / `actualMinutes`
- Follow existing YAML key naming conventions (check if the backend uses camelCase or snake_case in frontmatter — use whichever is established)

### Phase 1 Checkpoint

Run:

```bash
pnpm db:generate
pnpm build
pnpm test
```

All existing tests must still pass. The new fields are nullable so they should not break anything. Fix any type errors.

---

## Code Review 1

Before proceeding, review your Phase 1 changes:

- Are the Zod schemas correct? (`positive()` means > 0, `nonnegative()` means >= 0 — estimated should be positive, actual can be 0)
- Does the migration look correct? (Should be two `ALTER TABLE` statements)
- Are both storage backends updated consistently?
- Are there any type mismatches between schema, Zod, IStorage, and backends?
- Did you follow the existing naming conventions for the new fields?

Fix any issues found.

---

## Phase 2: Core Logic

### 2a. Task CRUD Updates

Open `src/core/tasks.ts`. Update:

- `create()` — accept and pass through `estimatedMinutes`
- `update()` — accept and pass through `estimatedMinutes` and `actualMinutes`
- Verify the fields flow from input → validation → storage

### 2b. Timer State

Add timer tracking. The timer state (which task is currently being timed, and when it started) should be **in-memory** — it does not need to persist across app restarts. Create a simple module or add to tasks.ts:

```typescript
// Timer state — in-memory only
const activeTimers = new Map<string, { startedAt: Date }>();

export function startTimer(taskId: string): void { ... }
export function stopTimer(taskId: string, storage: IStorage): Promise<number> { ... }
export function getActiveTimer(taskId: string): { startedAt: Date } | null { ... }
export function isTimerRunning(taskId: string): boolean { ... }
```

`stopTimer` should:

1. Calculate elapsed minutes from `startedAt` to now
2. Read the task's current `actualMinutes` (may already have accumulated time)
3. Add the elapsed time to `actualMinutes`
4. Update the task in storage
5. Remove the timer from the map
6. Return the elapsed minutes

Consider creating a dedicated `src/core/timer.ts` file to keep concerns separated.

### 2c. Time Formatting Utilities

Add helper functions (in `src/utils/` or `src/core/`) for formatting durations:

- `formatMinutes(minutes: number): string` — e.g., `90` → `"1h 30m"`, `45` → `"45m"`, `180` → `"3h"`
- `parseEstimateString(input: string): number | null` — e.g., `"30m"` → `30`, `"2h"` → `120`, `"1h30m"` → `90`

### Phase 2 Checkpoint

Run:

```bash
pnpm build
pnpm test
```

All tests pass. Fix any issues.

---

## Code Review 2

Review Phase 2 changes:

- Does `stopTimer` handle the case where no timer is running for the given taskId? (Should throw or return 0)
- Does `stopTimer` properly accumulate time? (If actualMinutes was already 30 and 15 more minutes elapsed, result should be 45)
- Is `parseEstimateString` robust? Does it handle edge cases like `"0m"`, `"999h"`, empty string, invalid input?
- Are timer functions properly exported?

Fix any issues found.

---

## Phase 3: AI Tool

### 3a. Create Time Estimation Tool

Create `src/ai/tools/builtin/time-estimation.ts`. Register two tools:

**Tool 1: `estimate_task_duration`**

- Parameters: `{ title: string, description?: string, projectId?: string }`
- Logic:
  1. Query completed tasks that have both `estimatedMinutes` and `actualMinutes` set
  2. Find tasks with similar titles/descriptions (simple keyword matching is fine — no need for embeddings)
  3. Calculate the average `actualMinutes` for similar tasks
  4. If no similar tasks found, use general heuristics based on all completed tasks with time data
  5. Return a suggested estimate with confidence level and reasoning
- Output: `{ estimatedMinutes: number, confidence: "low" | "medium" | "high", reasoning: string, similarTasks: Array<{ title: string, actualMinutes: number }> }`

**Tool 2: `time_tracking_summary`**

- Parameters: `{ days?: number }` (default: 30)
- Logic:
  1. Query completed tasks from the last N days that have both estimated and actual minutes
  2. Calculate: total estimated vs total actual, average accuracy ratio, most over/underestimated tasks
  3. Return a summary
- Output: `{ totalEstimated: number, totalActual: number, accuracyRatio: number, taskCount: number, mostOverestimated: {...}, mostUnderestimated: {...} }`

### 3b. Register Tools

Open `src/ai/tools/registry.ts`. Import and call your registration function following the existing pattern for other builtin tools.

### Phase 3 Checkpoint

Run:

```bash
pnpm build
pnpm test
```

---

## Code Review 3

Review Phase 3 changes:

- Are tool parameter schemas using Zod correctly?
- Does `estimate_task_duration` handle the case where there are zero completed tasks with time data? (Should return a default estimate with "low" confidence)
- Does `time_tracking_summary` handle division by zero for accuracy ratio?
- Are the tools registered in the registry correctly?
- Do the tools access storage through `ctx` (ToolContext) properly?

Fix any issues found.

---

## Phase 4: UI

### 4a. Parser — Duration Syntax

Open `src/parser/task-parser.ts`. Add support for the `~` prefix duration syntax:

- `~30m` → `estimatedMinutes: 30`
- `~2h` → `estimatedMinutes: 120`
- `~1h30m` → `estimatedMinutes: 90`
- `~1.5h` → `estimatedMinutes: 90`

The `~` prefix should be consumed (removed from the title). Add this to the parser's extraction pipeline alongside existing extractors for priority (`p1`-`p4`), tags (`#tag`), etc. Use the `parseEstimateString` helper from Phase 2.

Update `ParsedTask` type to include `estimatedMinutes?: number`.

### 4b. TaskDetailPanel — Estimated Duration

Open `src/ui/components/TaskDetailPanel.tsx` (and any decomposed sub-files in `src/ui/components/task-detail/`).

Add an "Estimated time" field to the detail panel:

- Show a small clock icon with an input field
- Allow the user to type a duration (e.g., "30m", "2h", "1h30m") or a plain number (interpreted as minutes)
- Display the current estimate formatted as "1h 30m"
- If the task has both estimated and actual, show a comparison (e.g., "Est: 1h 30m / Actual: 2h 15m")

### 4c. TaskItem — Timer Button

Open `src/ui/components/TaskItem.tsx`.

Add a small timer toggle button (clock icon) that appears on hover:

- Click to start timer → icon turns active (colored), shows elapsed time
- Click again to stop → actualMinutes is updated
- If estimatedMinutes is set, show it as a small badge (e.g., "~30m")
- Use a lightweight interval (every second) to update the displayed elapsed time while timer is running

### 4d. TaskInput — Duration Display

Open `src/ui/components/TaskInput.tsx`.

When the user types `~30m` in the input, show a small duration chip/badge in the input preview (similar to how priority or tag chips are shown). Use the parser from 4a.

### Phase 4 Checkpoint

Run:

```bash
pnpm build
pnpm test
```

Verify the UI renders correctly — check that:

- Duration input in TaskDetailPanel accepts and displays durations
- Timer button appears on TaskItem hover
- `~30m` syntax works in TaskInput and creates tasks with estimatedMinutes

---

## Code Review 4

Review Phase 4 changes:

- Is the parser extraction order correct? (Duration should not conflict with other extractors)
- Does the timer UI properly clean up intervals on unmount? (Use `useEffect` cleanup)
- Is the timer state managed correctly? (Consider: what happens if the user navigates away while a timer is running — the in-memory state should persist)
- Are the Tailwind classes consistent with the rest of the UI?
- Is the duration input accessible? (Proper labels, keyboard navigation)

Fix any issues found.

---

## Phase 5: Tests

### 5a. Schema + Types Tests

Create or update tests to verify:

- `CreateTaskInput` validates `estimatedMinutes` correctly (rejects negative, rejects non-integer, accepts null, accepts valid positive integers)
- `UpdateTaskInput` validates both fields correctly
- The new fields round-trip through SQLite (create → read → verify fields present)

### 5b. Timer Tests

Create `tests/unit/core/timer.test.ts`:

- `startTimer` sets a timer for a task
- `startTimer` on already-running timer throws or resets
- `stopTimer` calculates elapsed time correctly
- `stopTimer` accumulates with existing actualMinutes
- `stopTimer` on non-running timer throws or returns 0
- `isTimerRunning` returns correct state
- `getActiveTimer` returns timer data or null

Use `vi.useFakeTimers()` to control time in tests.

### 5c. AI Tool Tests

Create `tests/unit/ai/tools/time-estimation.test.ts`:

- `estimate_task_duration` returns low confidence when no historical data
- `estimate_task_duration` returns estimate based on similar completed tasks
- `time_tracking_summary` returns correct accuracy stats
- `time_tracking_summary` handles zero tasks gracefully

### 5d. Parser Tests

Update parser tests (likely in `tests/unit/parser/`):

- `~30m` extracts `estimatedMinutes: 30` and removes from title
- `~2h` extracts `estimatedMinutes: 120`
- `~1h30m` extracts `estimatedMinutes: 90`
- `~1.5h` extracts `estimatedMinutes: 90`
- Duration syntax combined with other syntax: `Buy groceries ~30m #errands p2`
- Invalid duration `~abc` is not extracted (left in title)

### 5e. Update Existing Tests

Search for existing task CRUD tests and ensure they still pass with the new nullable fields. If any test creates tasks and then checks all fields, update them to include `estimatedMinutes: null` and `actualMinutes: null` in expected output.

### Phase 5 Checkpoint

Run:

```bash
pnpm test
pnpm test:coverage
```

All tests pass. No regressions.

---

## Code Review 5 (Final)

Review ALL changes across all phases:

- Run `pnpm check` (lint + typecheck + test) — everything must pass
- Verify no `any` types were introduced
- Verify Conventional Commit messages are used for each commit
- Verify no console.log statements left in production code
- Verify the migration is correct and reversible
- Verify both storage backends handle the new fields identically
- Verify the AI tools handle edge cases (no data, division by zero, etc.)
- Verify the parser doesn't break existing syntax
- Verify timer cleanup on component unmount
- Check for any TODO comments that should be resolved

---

## Definition of Done

- [ ] Two new columns (`estimated_minutes`, `actual_minutes`) in tasks table with migration
- [ ] Zod schemas updated for both Create and Update inputs
- [ ] IStorage, SQLiteBackend, and MarkdownBackend all handle new fields
- [ ] Timer module (`startTimer`, `stopTimer`, `getActiveTimer`, `isTimerRunning`) working
- [ ] Duration formatting/parsing utilities working
- [ ] AI tool `estimate_task_duration` suggests estimates from historical data
- [ ] AI tool `time_tracking_summary` shows estimation accuracy stats
- [ ] Both AI tools registered in the tool registry
- [ ] Parser supports `~30m` / `~2h` / `~1h30m` duration syntax
- [ ] TaskDetailPanel shows estimated/actual time fields
- [ ] TaskItem shows timer start/stop button and duration badge
- [ ] TaskInput shows duration chip when `~` syntax is used
- [ ] Unit tests for timer logic with fake timers
- [ ] Unit tests for AI tools with edge cases
- [ ] Unit tests for parser duration extraction
- [ ] All existing tests pass (no regressions)
- [ ] `pnpm check` passes (lint + typecheck + test)
- [ ] No `any` types introduced
- [ ] Conventional Commits used throughout

## Commit Plan

```
feat(db): add estimated_minutes and actual_minutes columns to tasks
feat(core): add time estimation fields to task types and CRUD
feat(core): add timer module for tracking actual task duration
feat(ai): add estimate_task_duration and time_tracking_summary tools
feat(parser): support ~30m duration syntax in task input
feat(ui): add time estimation and timer UI to task components
test(core): add timer and time estimation tests
```
