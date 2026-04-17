# A-37: Weekly Review & Analytics

## Context

You are working on **ASF Junban**, a local-first, AI-native task manager. The codebase uses Node 22+, TypeScript strict mode, React + Tailwind CSS, SQLite via Drizzle ORM, Vitest for testing, and pnpm as the package manager.

### Relevant Existing Code

- **Productivity stats tool** at `src/ai/tools/builtin/productivity-stats.ts` — provides streak tracking, completion counts, and daily breakdowns over a date range. It uses `StatsService` when available, otherwise computes directly from tasks. Use this as a reference for data access patterns.

- **AI tool registration pattern:**

  ```typescript
  export function registerXxxTool(registry: ToolRegistry): void {
    registry.register(
      { name: "...", description: "...", parameters: {...} },
      async (args, ctx) => { ... }
    );
  }
  ```

- **Tool registry** at `src/ai/tools/registry.ts` — all tools are imported and registered here.

- **Core types** at `src/core/types.ts` — Task, Project, Tag Zod schemas and TS types.

- **Storage interface** at `src/storage/interface.ts` — `IStorage` abstracts all data operations (tasks, projects, tags).

- **Tool context** provides access to `ctx.storage` (IStorage), `ctx.taskService` (TaskService), and other services.

- **Existing modals** — see `src/ui/components/DailyPlanningModal.tsx` for modal patterns (portal-based, Tailwind, keyboard dismiss).

- **Today view** at `src/ui/views/Today.tsx` — where the manual trigger button will be added.

---

## Phase 1: AI Tool — `weekly_review`

Create `src/ai/tools/builtin/weekly-review.ts`.

### Requirements

1. **Register a `weekly_review` tool** following the standard pattern (see `productivity-stats.ts` for reference).

2. **Parameters:**

   ```typescript
   {
     weekStartDate?: string  // ISO date string, defaults to last Monday
   }
   ```

3. **Compute the following metrics for the 7-day window** (weekStartDate to weekStartDate + 6 days):
   - **Completion rate**: tasks completed / (tasks that were due in the window + tasks created in the window). Express as a percentage.
   - **Task flow**: counts of tasks created, completed, and cancelled within the window.
   - **Busiest day**: the day with the most task completions. Return the date and count.
   - **Most productive time of day**: bucket `completedAt` timestamps into morning (6-12), afternoon (12-17), evening (17-21), night (21-6). Return the bucket with the most completions. If `completedAt` is not available or all are null, omit this field.
   - **Neglected projects**: projects that have at least one overdue task and zero completions in the window. Return project id, name, and overdue count.
   - **Overdue tasks**: count and list (id, title, dueDate, projectName) of tasks overdue as of the end of the window.
   - **Streak**: consecutive days (ending at or near the window end) with at least one completion.
   - **Top accomplishments**: up to 5 highest-priority completed tasks (priority 1 first, then 2, etc.). Return id, title, priority, completedAt.
   - **Suggestions**: an array of 2-4 actionable string suggestions for next week, derived from the data (e.g., "You have 3 overdue tasks in Project X — consider reviewing them Monday", "Your most productive time is morning — try scheduling deep work before noon").

4. **Return structured JSON** matching this shape:

   ```typescript
   interface WeeklyReviewResult {
     weekStartDate: string; // ISO date
     weekEndDate: string; // ISO date
     completionRate: number; // 0-100
     taskFlow: { created: number; completed: number; cancelled: number };
     busiestDay: { date: string; completions: number } | null;
     mostProductiveTime: { bucket: string; completions: number } | null;
     neglectedProjects: Array<{ id: string; name: string; overdueCount: number }>;
     overdueTasks: {
       count: number;
       tasks: Array<{ id: string; title: string; dueDate: string; projectName?: string }>;
     };
     streak: number;
     topAccomplishments: Array<{
       id: string;
       title: string;
       priority: number;
       completedAt: string;
     }>;
     suggestions: string[];
   }
   ```

5. **Edge cases:**
   - If no tasks exist in the window, return zeroed metrics with a suggestion like "No task activity this week — start by adding a few tasks."
   - If `weekStartDate` is not provided, compute last Monday (most recent Monday on or before today).
   - Validate that `weekStartDate` is a valid date string; throw a clear error if not.

6. **Register the tool** in `src/ai/tools/registry.ts` — import `registerWeeklyReviewTool` and call it alongside the other registrations.

### Code Review Checkpoint

Before proceeding to Phase 2, review Phase 1:

- Does the tool follow the same patterns as `productivity-stats.ts`?
- Are all metrics computed correctly with proper null/empty handling?
- Is the return type well-structured for both chat rendering and UI consumption?
- No `any` types?
- Are date calculations correct (timezone-aware where needed, using the user's local dates)?

Fix any issues found before continuing.

---

## Phase 2: Weekly Review Modal

Create `src/ui/components/WeeklyReviewModal.tsx`.

### Requirements

1. **Component signature:**

   ```typescript
   export function WeeklyReviewModal(props: {
     data: WeeklyReviewResult;
     onClose: () => void;
   }): React.ReactElement;
   ```

2. **Rendering via portal** — render into `document.body` using `createPortal` (same pattern as `DailyPlanningModal.tsx`).

3. **Layout — card-based, Tailwind only, no chart libraries:**

   a. **Header**: "Weekly Review" title + date range (e.g., "Mar 3 - Mar 9, 2026") + close button (X).

   b. **Summary stats row**: 4 stat cards in a horizontal row (grid on desktop, stack on mobile):
   - Tasks Completed (with count)
   - Tasks Created (with count)
   - Overdue (with count, red if > 0)
   - Streak (days, with fire icon using emoji or text)

   c. **Completion chart**: simple horizontal or vertical bar chart for 7 days.
   - 7 bars, one per day (Mon-Sun or based on weekStartDate).
   - Bar height/width proportional to completions that day.
   - Use `div` elements with dynamic Tailwind width/height via inline `style={{ height: ... }}` (this is the one acceptable use of inline style — for dynamic data-driven dimensions).
   - Label each bar with the day abbreviation (Mon, Tue, ...) and count.
   - Use `bg-blue-500` or the theme's primary color variable.

   d. **Top accomplishments**: list of up to 5 items showing title and priority badge (P1/P2/P3/P4 with color coding).

   e. **Neglected projects**: list with project name and overdue count badge. If empty, show "All projects active" message.

   f. **Suggestions**: bulleted list of AI suggestions, styled as a callout/tip box.

4. **Interactions:**
   - Close on Escape key press.
   - Close on backdrop click.
   - Trap focus within the modal (use `useFocusTrap` hook from `src/ui/hooks/useFocusTrap.ts`).

5. **Responsive**: grid layout collapses to single column on mobile (use Tailwind responsive prefixes).

6. **Integration points:**

   a. **Chat rendering**: In `src/ui/components/chat/ChatToolResultCard.tsx` (or its sub-modules in `src/ui/components/chat/`), add a case for the `weekly_review` tool that renders a summary card with a "View Full Report" button. Clicking the button opens `WeeklyReviewModal` with the tool result data.

   b. **Today view button**: In `src/ui/views/Today.tsx`, add a small "Weekly Review" button (icon + text) near the top of the view. Clicking it:
   - Calls the `weekly_review` tool via the AI API (or computes the data directly via a helper extracted from the tool).
   - Opens `WeeklyReviewModal` with the result.
   - Show a loading state while computing.

### Code Review Checkpoint

Before proceeding to Phase 3, review Phase 2:

- Is the modal accessible (focus trap, Escape to close, aria labels)?
- Does the bar chart handle edge cases (all zeros, one massive day)?
- Is the layout responsive?
- No CSS modules or inline styles (except the dynamic bar dimensions)?
- Does the chat integration follow existing patterns in `ChatToolResultCard`?
- Is the Today view button unobtrusive and consistent with the existing UI?

Fix any issues found before continuing.

---

## Phase 3: Tests

### Unit Tests — `tests/ai/tools/weekly-review.test.ts`

Test the weekly review computation logic:

1. **Basic computation**: Create a set of tasks with known dates and statuses. Run the tool. Assert all metrics match expected values.
2. **Empty week**: No tasks in the window. Assert zeroed metrics and appropriate suggestion.
3. **Default weekStartDate**: When no date is provided, assert it defaults to last Monday.
4. **Busiest day**: Multiple days with completions, assert correct day selected.
5. **Neglected projects**: Project with overdue tasks and no completions in window is flagged. Project with recent activity is not.
6. **Streak calculation**: Test consecutive days with completions, including streaks that extend before the window.
7. **Top accomplishments sorting**: Assert priority ordering (P1 first), limited to 5.
8. **Productive time bucketing**: Tasks completed at various hours, assert correct bucket wins.
9. **Overdue tasks**: Tasks past due at window end are listed; completed tasks are not.
10. **Invalid weekStartDate**: Assert error thrown for non-date string.

### Component Tests — `tests/ui/components/WeeklyReviewModal.test.tsx`

1. **Renders all sections**: Pass complete data, assert summary stats, chart bars, accomplishments, suggestions all render.
2. **Handles empty data**: Pass zeroed data, assert no crashes, shows appropriate empty states.
3. **Close on Escape**: Simulate Escape key, assert `onClose` called.
4. **Close on backdrop click**: Click backdrop, assert `onClose` called.
5. **Bar chart proportions**: Pass known daily counts, assert bars have correct relative heights.
6. **Responsive layout**: (Optional) Test that grid classes are applied correctly.

Use `vitest` and `@testing-library/react`. Follow patterns from existing tests in `tests/`.

### Code Review Checkpoint

After writing tests, review:

- Do tests cover the core computation logic thoroughly?
- Are tests isolated (no shared mutable state)?
- Do component tests use proper testing-library queries (getByText, getByRole)?
- Are test helpers/fixtures reusable?

Fix any issues found.

---

## Definition of Done

- [ ] `src/ai/tools/builtin/weekly-review.ts` — tool registered and functional
- [ ] `src/ai/tools/registry.ts` — updated to include `registerWeeklyReviewTool`
- [ ] `src/ui/components/WeeklyReviewModal.tsx` — modal component complete
- [ ] Chat integration — `weekly_review` tool result renders in chat with "View Full Report" button
- [ ] Today view — "Weekly Review" button added, opens modal with computed data
- [ ] `tests/ai/tools/weekly-review.test.ts` — 10+ unit tests passing
- [ ] `tests/ui/components/WeeklyReviewModal.test.tsx` — 5+ component tests passing
- [ ] All existing tests still pass: `pnpm test`
- [ ] No TypeScript errors: `pnpm typecheck`
- [ ] No new ESLint errors: `pnpm lint`
- [ ] Types exported/shared properly between tool and UI (consider a shared types file or re-export from the tool)

## Final Code Review

After all phases are complete, do a final review of the entire changeset:

1. **Consistency**: Do all new files follow project conventions (named exports, JSDoc on complex functions, no `any`)?
2. **Integration**: Does the data flow cleanly from tool -> chat -> modal, and from Today view -> tool -> modal?
3. **Performance**: Are there any unnecessary re-renders or expensive computations on every render?
4. **Accessibility**: Modal focus management, keyboard navigation, screen reader labels.
5. **Edge cases**: Empty states, single-task weeks, all tasks overdue, no projects.

Create a single commit:

```
feat(ai): add weekly review tool and analytics modal (A-37)
```
