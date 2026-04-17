# V2-22: Eat the Frog — Dread Level Rating

## Context

You are working on **ASF Junban**, a local-first, AI-native task manager. The codebase uses TypeScript strict mode, React + Tailwind CSS, SQLite via Drizzle ORM, and Vitest for testing. Package manager is pnpm.

**Key files you'll touch:**

| File                                    | Purpose                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `src/db/schema.ts`                      | Drizzle SQLite schema (all tables)                                        |
| `src/core/types.ts`                     | Zod schemas + TypeScript types for Task, CreateTaskInput, UpdateTaskInput |
| `src/storage/interface.ts`              | IStorage interface (storage abstraction)                                  |
| `src/storage/sqlite-backend.ts`         | SQLite implementation of IStorage                                         |
| `src/storage/markdown/task-ops.ts`      | Markdown backend task operations                                          |
| `src/storage/markdown-backend.ts`       | Markdown backend (re-exports from markdown/)                              |
| `src/db/queries.ts`                     | Query helpers (CRUD for tasks)                                            |
| `src/ui/components/TaskDetailPanel.tsx` | Task detail side panel                                                    |
| `src/ui/components/task-detail/`        | Task detail sub-components                                                |
| `src/ui/components/TaskItem.tsx`        | Individual task row in lists                                              |
| `src/ui/views/Today.tsx`                | Today view with WorkloadCapacityBar                                       |
| `src/parser/task-parser.ts`             | Natural language task input parser                                        |
| `src/parser/grammar.ts`                 | Grammar rules for task input syntax                                       |

**Schema pattern** (in `src/db/schema.ts`):

```typescript
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  priority: integer("priority"),
  // ... other columns
});
```

**Type pattern** (in `src/core/types.ts`):

- Zod schemas define validation: `CreateTaskInputSchema`, `UpdateTaskInputSchema`, `TaskSchema`
- TypeScript types derived via `z.infer<typeof Schema>`
- Fields are added to all three schemas (create uses the field, update makes it optional, task includes it)

**Storage pattern:**

- `IStorage` in `src/storage/interface.ts` defines the contract
- `TaskRow` type in `interface.ts` maps DB columns to TypeScript
- Both SQLite and Markdown backends implement `IStorage`

**Parser pattern** (in `src/parser/task-parser.ts`):

- Regex-based extraction of special syntax from task title strings
- Extracted fields are removed from the title, returned in a structured result

**Conventions:**

- TypeScript strict mode — no `any` types
- Tailwind CSS for all styling — no inline styles, no CSS modules
- Conventional Commits: `feat(core):`, `feat(ui):`, `test(core):`, etc.
- Use Lucide React icons (`lucide-react` package) for icon components, not emoji in code
- Emoji is acceptable in user-facing strings where it enhances UX
- Named exports preferred
- All public functions have JSDoc for complex logic
- React function components only

---

## Phase 1: Schema + Types + Storage

### 1.1 Add `dreadLevel` column to the tasks table

In `src/db/schema.ts`, add a `dreadLevel` column to the `tasks` table:

```typescript
dreadLevel: integer("dread_level"),  // 1-5, nullable
```

### 1.2 Generate migration

Run:

```bash
pnpm db:generate
```

This creates a new SQL migration file in `src/db/migrations/`. Verify it contains an `ALTER TABLE tasks ADD COLUMN dread_level INTEGER` statement.

### 1.3 Update core types

In `src/core/types.ts`:

- Add `dreadLevel` to `CreateTaskInputSchema`: `dreadLevel: z.number().int().min(1).max(5).nullable().optional()`
- Add `dreadLevel` to `UpdateTaskInputSchema`: same as above
- Add `dreadLevel` to `TaskSchema` / `Task` type: `dreadLevel: z.number().int().min(1).max(5).nullable()`
- Ensure `TaskRow` in `src/storage/interface.ts` includes `dreadLevel: number | null`

### 1.4 Update storage backends

- **IStorage interface** (`src/storage/interface.ts`): Update `TaskRow` to include `dreadLevel: number | null`
- **SQLite backend** (`src/storage/sqlite-backend.ts`): The column should flow through automatically via Drizzle if `TaskRow` is updated. Verify that `createTask` and `updateTask` pass `dreadLevel` through.
- **Markdown backend** (`src/storage/markdown/task-ops.ts`): Add `dread_level` to YAML frontmatter serialization/deserialization. Map `dreadLevel` (camelCase) to `dread_level` (snake_case in YAML).
- **Queries** (`src/db/queries.ts`): Ensure `dreadLevel` is included in task insert/update/select operations.

### 1.5 Commit

```
feat(core): add dreadLevel field to tasks schema (1-5 scale)
```

---

## Code Review Checkpoint 1

Before proceeding, verify:

- [ ] Migration generated cleanly — run `pnpm db:generate` and inspect the migration SQL
- [ ] `pnpm check` passes (lint + typecheck + test)
- [ ] `TaskRow` includes `dreadLevel: number | null`
- [ ] Both storage backends handle `dreadLevel` in reads and writes
- [ ] Creating a task with `dreadLevel: 3` persists and reads back correctly (verify in existing tests or add a quick smoke test)
- [ ] Creating a task without `dreadLevel` results in `null` (not `undefined`)

Fix any issues before proceeding to Phase 2.

---

## Phase 2: UI — Dread Level Input + Display

### 2.1 Create a DreadLevelSelector component

Create a new component for selecting dread level. Location: `src/ui/components/DreadLevelSelector.tsx`

**Spec:**

- Display 5 frog icons in a row (use a custom frog SVG icon or a Lucide icon — if no suitable Lucide icon exists, create a small `FrogIcon` component using inline SVG)
- Click on a frog to set dread level (1-5). Clicking the same level again clears it (sets to null).
- Visual states:
  - Level 1: green (`text-green-500`)
  - Level 2: yellow (`text-yellow-500`)
  - Level 3: orange (`text-orange-500`)
  - Level 4: red (`text-red-500`)
  - Level 5: dark red (`text-red-700`)
- All frogs up to the selected level are filled/colored; frogs above are gray
- Include a tooltip or aria-label: "Dread level: {n}/5"
- Props: `value: number | null`, `onChange: (level: number | null) => void`, `size?: "sm" | "md"` (default "md")

### 2.2 Add DreadLevelSelector to TaskDetailPanel

In `src/ui/components/TaskDetailPanel.tsx` (or the appropriate sub-component in `src/ui/components/task-detail/`):

- Add the `DreadLevelSelector` in the task metadata section (near priority, labels, due date)
- Label it "Dread level" or "How much do you dread this?"
- Wire it to update the task via `taskService.update(taskId, { dreadLevel })`

### 2.3 Show dread indicator on TaskItem

In `src/ui/components/TaskItem.tsx`:

- If the task has a `dreadLevel`, show a small frog icon next to the task title
- Color intensity matches the level (same color scale as the selector)
- Size: small (`w-4 h-4`), positioned after priority indicator and before tags
- Tooltip: "Dread level: {n}"
- No indicator shown if `dreadLevel` is null

### 2.4 Add parser syntax for dread level

In `src/parser/task-parser.ts` and/or `src/parser/grammar.ts`:

- Add syntax: `~d3` sets dread level to 3 (pattern: `~d[1-5]`)
- Alternative syntax: `!frog3` sets dread level to 3 (pattern: `!frog[1-5]`)
- Extract the dread level from the title string and include it in the parsed result
- Remove the syntax token from the cleaned title

Update `ParsedTask` type to include `dreadLevel?: number`.

### 2.5 Commit

```
feat(ui): add dread level selector, task indicator, and parser syntax
```

---

## Code Review Checkpoint 2

Before proceeding, verify:

- [ ] `pnpm check` passes
- [ ] `DreadLevelSelector` renders 5 icons with correct colors for each level
- [ ] Clicking a frog sets the level; clicking the same frog clears it
- [ ] `TaskDetailPanel` shows the selector and persists changes
- [ ] `TaskItem` shows the dread indicator with correct color
- [ ] Parser correctly extracts `~d3` and `!frog3` syntax
- [ ] Parser removes the dread token from the cleaned title
- [ ] No emoji characters used in component code (only icon components)
- [ ] All Tailwind classes — no inline styles

Fix any issues before proceeding to Phase 3.

---

## Phase 3: Eat the Frog Section in Today View

### 3.1 Create the EatTheFrog component

Create `src/ui/components/EatTheFrog.tsx`:

**Spec:**

- Accepts props: `tasks: Task[]` (today's pending tasks)
- Logic: Find the task with the highest `dreadLevel` among uncompleted tasks. If tied, pick the one with the earliest due time, then alphabetically.
- If no tasks have a dread level set, don't render anything
- **Visual design:**
  - Prominent card with a subtle gradient background (green-to-yellow tones)
  - Large frog icon on the left, scaled to the dread level
  - Task title in bold
  - Subtitle: "Eat this frog first!" or similar encouraging text
  - A "Complete" button to mark the task done directly from the card
- **After completion:**
  - Show a brief "Frog eaten!" celebration message with a checkmark
  - Auto-dismiss after 3 seconds, or immediately show the next highest-dread task
  - Use a subtle animation (Tailwind `animate-` classes or transition)

### 3.2 Integrate into Today view

In `src/ui/views/Today.tsx`:

- Add the `EatTheFrog` component at the top of the view, above the task list
- Only show it during "morning hours" (configurable, default: before 12:00 PM) OR always show it (based on setting)
- Pass today's pending tasks to the component

### 3.3 Add setting to enable/disable

In the settings system:

- Add a setting `eatTheFrogEnabled` (boolean, default `true`)
- Add a setting `eatTheFrogMorningOnly` (boolean, default `true`) — if true, only show before noon
- Add these settings to the appropriate settings tab in `src/ui/views/settings/`
- Read the settings in `Today.tsx` and conditionally render `EatTheFrog`

### 3.4 Commit

```
feat(ui): add Eat the Frog section to Today view with completion feedback
```

---

## Code Review Checkpoint 3

Before proceeding, verify:

- [ ] `pnpm check` passes
- [ ] `EatTheFrog` component correctly identifies the highest-dread task
- [ ] Tiebreaking logic works (earliest due time, then alphabetical)
- [ ] Completing the frog task shows "Frog eaten!" feedback
- [ ] The section hides when no tasks have dread levels
- [ ] Settings toggle works — disabling hides the section
- [ ] Morning-only setting is respected
- [ ] The component handles edge cases: no tasks, all tasks completed, only one task with dread level
- [ ] No regressions in Today view layout or WorkloadCapacityBar

Fix any issues before proceeding to Phase 4.

---

## Phase 4: Tests

### 4.1 Unit tests for dread level CRUD

Create/update test file: `tests/core/dread-level.test.ts`

Test cases:

- Create a task with `dreadLevel: 3` — verify it persists and reads back as 3
- Create a task without dreadLevel — verify it reads back as `null`
- Update a task to set dreadLevel from null to 4
- Update a task to clear dreadLevel (set to null)
- Reject invalid dread levels: 0, 6, -1, 2.5 (validation error from Zod)
- Verify dreadLevel survives round-trip through both storage backends

### 4.2 Unit tests for frog selection logic

Create test file: `tests/ui/eat-the-frog.test.ts`

Extract the frog selection logic into a pure function (e.g., `selectFrogTask(tasks: Task[]): Task | null`) so it can be unit tested without rendering.

Test cases:

- Returns the task with the highest dread level
- Returns null when no tasks have dread levels
- Returns null when task list is empty
- Tiebreaking: earlier due time wins
- Tiebreaking: alphabetical title when due times are equal
- Ignores completed tasks
- Ignores cancelled tasks

### 4.3 Unit tests for parser

Add test cases to existing parser tests (likely `tests/parser/task-parser.test.ts`):

- `"Buy groceries ~d3"` → `{ title: "Buy groceries", dreadLevel: 3 }`
- `"File taxes !frog5"` → `{ title: "File taxes", dreadLevel: 5 }`
- `"Normal task"` → `{ dreadLevel: undefined }`
- `"Task ~d0"` → dread level not extracted (invalid, 0 is out of range)
- `"Task ~d6"` → dread level not extracted (invalid, 6 is out of range)

### 4.4 Component tests for EatTheFrog

Create test file: `tests/ui/components/EatTheFrog.test.tsx`

Test cases:

- Renders the frog card when a task has a dread level
- Does not render when no tasks have dread levels
- Shows the correct task (highest dread level)
- Complete button triggers task completion callback
- Shows "Frog eaten!" message after completion

### 4.5 Commit

```
test(core): add tests for dread level CRUD, frog selection, and parser
```

---

## Definition of Done

- [ ] `dreadLevel` column exists in DB schema with migration
- [ ] `dreadLevel` field flows through types, storage interface, both backends, and queries
- [ ] `DreadLevelSelector` component with 5 frog icons and color scale
- [ ] Dread indicator visible on `TaskItem` for tasks with dread levels
- [ ] `~d3` and `!frog3` parser syntax works
- [ ] `EatTheFrog` section appears in Today view showing highest-dread task
- [ ] Completion feedback ("Frog eaten!") with auto-dismiss
- [ ] Settings to enable/disable and morning-only mode
- [ ] All new tests pass
- [ ] `pnpm check` passes (lint + typecheck + all tests)
- [ ] No `any` types introduced
- [ ] All styling uses Tailwind classes
- [ ] Conventional Commits for each phase

---

## Final Code Review

Review the complete changeset across all phases:

- [ ] **Schema consistency**: `dread_level` in DB, `dreadLevel` in TypeScript, `dread_level` in YAML frontmatter
- [ ] **Type safety**: No `any` types, all dread level values validated by Zod (1-5 or null)
- [ ] **UI consistency**: Frog colors match between DreadLevelSelector, TaskItem indicator, and EatTheFrog card
- [ ] **Edge cases**: null dread levels handled everywhere, no crashes on missing data
- [ ] **Performance**: EatTheFrog selection logic is O(n) — no unnecessary re-renders
- [ ] **Accessibility**: Frog icons have aria-labels, color is not the only indicator (icon shape provides meaning)
- [ ] **Mobile**: Components work on mobile viewport (check responsive Tailwind classes)
- [ ] **No regressions**: Existing tests still pass, Today view layout unchanged for users who don't use dread levels
- [ ] **Bundle size**: No new dependencies added (using existing Lucide icons or inline SVG)
