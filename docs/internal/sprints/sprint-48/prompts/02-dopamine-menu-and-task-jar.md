# Sprint 48 — Prompt 02: Dopamine Menu (V2-24) + Task Jar (V2-25)

## Context

ASF Junban is a local-first, AI-native task manager. Tech stack: Node 22+, TypeScript strict mode, React + Tailwind CSS, SQLite via Drizzle ORM, Vitest for testing, pnpm package manager.

Relevant existing code:

- **Views** live in `src/ui/views/` (e.g., `Today.tsx`, `Inbox.tsx`, `Matrix.tsx`)
- **Sidebar navigation** is in `src/ui/components/sidebar/` — new views get a sidebar entry here
- **Command palette** is in `src/ui/components/CommandPalette.tsx` — new views get registered as commands
- **Routing** is handled in `src/ui/App.tsx` — add new route entries for new views
- **Sound effects** system is in `src/utils/sounds.ts` — use existing `playSound()` for completion feedback
- **Task fields** include: `id`, `title`, `status`, `priority` (1=urgent, 4=low), `dueDate`, `estimatedMinutes` (added S47), `dreadLevel` (added S48 phase 1, 1-5 scale where 1=no dread, 5=maximum dread)
- **Task types** are defined in `src/core/types.ts`
- **TaskItem component** is in `src/ui/components/TaskItem.tsx`
- **Today view** is in `src/ui/views/Today.tsx` — the Task Jar button goes in its header

Conventions:

- TypeScript strict mode — no `any` types
- Tailwind CSS for all styling — no inline styles, no CSS modules
- Named exports preferred
- Conventional Commits (`feat(ui): ...`)
- React function components only
- All public functions with complex logic get JSDoc

---

## Phase 1: Dopamine Menu (V2-24)

### Goal

Create a fun, encouraging filtered view that shows only "quick win" tasks — short, low-dread, easy tasks that build momentum when motivation is low.

### Tasks

1. **Create `src/ui/views/DopamineMenu.tsx`**
   - Header: fun, colorful — something like "Need a quick win? Pick one!" with a lightning bolt or sparkle icon
   - Filter pending tasks matching ANY of these criteria:
     - `estimatedMinutes <= 15` (short tasks)
     - `priority >= 3` (low priority = easy wins)
     - `dreadLevel <= 2` (low dread)
   - Sort results by `estimatedMinutes` ascending (shortest first), with null/undefined durations last
   - Display tasks using the existing `TaskItem` component for consistency
   - Show an empty state if no quick wins are available — something encouraging like "No quick wins right now. You're tackling the hard stuff!"
   - On task completion:
     - Play a satisfying sound effect using the existing sound system from `src/utils/sounds.ts`
     - Trigger a confetti-like CSS animation (pure CSS keyframes — no external library)
   - The confetti animation should be brief (1-2 seconds), colorful, and not block interaction
   - Keep the UI fun and engaging but clean — no visual clutter

2. **Add route in `src/ui/App.tsx`**
   - Add a route entry for the Dopamine Menu view (path: `dopamine-menu` or similar)

3. **Add sidebar navigation entry**
   - Add "Dopamine Menu" (or "Quick Wins") to the sidebar in `src/ui/components/sidebar/`
   - Use an appropriate icon (lightning bolt, sparkle, or rocket)
   - Place it in a logical position (near Inbox/Today or in its own motivational section)

4. **Add command palette entry**
   - Register "Go to Dopamine Menu" / "Quick Wins" in `src/ui/components/CommandPalette.tsx`

5. **Confetti CSS animation**
   - Create the confetti effect using CSS `@keyframes` — small colored dots/squares that burst upward and fade
   - Add the animation styles either inline in the component or in `src/ui/index.css`
   - The animation triggers on task completion and auto-removes after playing

### Code Review Checkpoint

Pause and review Phase 1 before continuing:

- Does the filter logic correctly identify quick wins?
- Is the sort order correct (shortest first)?
- Does the confetti animation work without external dependencies?
- Is the route, sidebar entry, and command palette entry all wired up?
- Does it follow Tailwind conventions (no inline styles)?
- TypeScript strict — no `any`, proper typing on filter functions?

---

## Phase 2: Task Jar (V2-25)

### Goal

Create a "shake the jar" interaction for when users can't decide what to work on. Randomly selects a task from today's pending list with a fun slot-machine-style animation.

### Tasks

1. **Create `src/ui/components/TaskJar.tsx`**
   - A button component that triggers the jar interaction
   - Icon: jar, dice, or shuffle icon
   - On click, opens a modal/overlay with the randomization animation
   - **Animation sequence (CSS-only, no framer-motion):**
     - Rapidly cycle through 3-5 random task titles (slot machine style, ~100ms intervals)
     - Gradually slow down over ~1.5 seconds
     - Land on the final selected task with a satisfying "lock-in" effect (scale bounce, glow, etc.)
   - Display the selected task prominently: large text, clear visual emphasis
   - Two action buttons:
     - "Shake Again" — re-run the randomization
     - "Start This Task" — navigate to or highlight the selected task
   - **Task pool:** only pending tasks that are due today or overdue (same pool as Today view)
   - Handle edge cases:
     - 0 tasks: show "Nothing due today!" message
     - 1 task: skip animation, show it directly with "This is the one!" message
     - 2+ tasks: run the full animation

2. **Integrate into Today view**
   - Add a jar/dice button to the `Today.tsx` view header (next to existing header actions)
   - The button should be visually distinct but not overwhelming — a fun accent

3. **Randomization logic**
   - Use `Math.random()` for selection (no need for crypto-grade randomness)
   - The cycling animation should show real task titles from the pool (not placeholder text)
   - Final selection should feel random to the user (avoid always picking the first/last)

### Code Review Checkpoint

Pause and review Phase 2 before continuing:

- Does the animation work with CSS only (no framer-motion)?
- Are edge cases handled (0, 1, 2+ tasks)?
- Is the component properly integrated into the Today view header?
- Does "Start This Task" do something meaningful (navigate, highlight, etc.)?
- TypeScript strict compliance?
- Tailwind only for styling?

---

## Phase 3: Tests

### Unit Tests

1. **Dopamine Menu filter logic** (`tests/ui/views/DopamineMenu.test.ts` or similar)
   - Test that tasks with `estimatedMinutes <= 15` are included
   - Test that tasks with `priority >= 3` are included
   - Test that tasks with `dreadLevel <= 2` are included
   - Test that tasks matching NONE of the criteria are excluded
   - Test sort order: shortest `estimatedMinutes` first, nulls last
   - Test that only pending tasks are shown (not completed/cancelled)
   - Test empty state when no tasks match

2. **Task Jar randomization** (`tests/ui/components/TaskJar.test.ts` or similar)
   - Test that selection picks from the correct task pool (pending, due today or overdue)
   - Test edge case: 0 tasks returns appropriate state
   - Test edge case: 1 task always selects that task
   - Test edge case: 2+ tasks — selected task is from the pool
   - Test that "shake again" can select a different task

3. **Extract filter/sort logic into testable pure functions**
   - If the filter/sort logic is inline in the component, extract it into a utility function so it can be unit tested without rendering React components

### E2E Test

4. **Dopamine Menu navigation** (`tests/e2e/dopamine-menu.spec.ts` or add to existing E2E suite)
   - Navigate to Dopamine Menu via sidebar
   - Verify tasks are displayed
   - Verify that displayed tasks meet the quick-win criteria

### Code Review Checkpoint

Pause and review Phase 3:

- Are filter logic tests comprehensive (all three criteria + exclusions)?
- Are Task Jar edge cases covered?
- Is testable logic extracted into pure functions?
- Do tests use Vitest conventions (`describe`, `it`, `expect`)?
- Do tests run with `pnpm test`?

---

## Definition of Done

- [ ] `DopamineMenu.tsx` view created with correct filter/sort logic
- [ ] Confetti CSS animation plays on task completion (no external library)
- [ ] Sound effect plays on task completion via existing sound system
- [ ] Dopamine Menu accessible via sidebar, command palette, and direct route
- [ ] `TaskJar.tsx` component created with slot-machine-style CSS animation
- [ ] Task Jar button integrated into Today view header
- [ ] Edge cases handled (0, 1, 2+ tasks)
- [ ] Unit tests for Dopamine Menu filtering and sorting
- [ ] Unit tests for Task Jar randomization and edge cases
- [ ] E2E test for Dopamine Menu navigation
- [ ] All existing tests still pass (`pnpm test`)
- [ ] No TypeScript errors (`pnpm typecheck`)
- [ ] No new lint errors (`pnpm lint`)
- [ ] Commits follow Conventional Commits format

---

## Final Code Review

After all phases are complete, do a final review:

- Run `pnpm check` (lint + typecheck + test) — everything must pass
- Verify no `any` types were introduced
- Verify no inline styles — Tailwind only
- Verify no external animation libraries were added
- Verify the UI is fun and engaging but still clean and consistent with the rest of the app
- Verify sound effects use the existing system, not new audio files or Web Audio API calls
- Verify confetti is CSS-only (`@keyframes`, no canvas, no library)
- Check that the Dopamine Menu filter criteria match the spec exactly
- Check that Task Jar only pulls from pending + due today/overdue tasks
