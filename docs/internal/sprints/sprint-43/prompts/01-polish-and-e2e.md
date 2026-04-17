# Sprint S43: Polish, Settings, Keyboard Shortcuts + E2E Testing

## Context

ASF Junban is a local-first task manager with an Obsidian-style plugin system. Read `CLAUDE.md` for full project context, conventions, and tech stack.

This is the **final sprint** of the timeblocking plugin epic. It adds polish features (recurring block UI, replan, conflict indicators, settings, focus mode, keyboard shortcuts) and then uses **Playwright MCP** to test the entire app end-to-end and fix any bugs found.

### What already exists:

**Timeblocking plugin (S40–S42):**

- `src/plugins/builtin/timeblocking/` — full plugin with types, store, recurrence, slot-helpers, task-linking
- `src/plugins/builtin/timeblocking/components/` — TimeblockingView, DayTimeline, WeekTimeline, TimelineColumn, TimeBlockCard, TimeSlotCard, TaskSidebar, DragPreview
- Day view with drag-and-drop, block creation, repositioning, resizing
- Week view with N-day columns, TimeSlot containers with task lists
- Split layout with collapsible/resizable sidebar
- 2108 tests passing (1 pre-existing failure in daily-planning)

**Plugin settings (manifest.json):**

- `defaultDurationMinutes`, `workDayStart`, `workDayEnd`, `gridIntervalMinutes`, `weekStartDay`
- Plugin settings API: `this.settings.get<T>(key)`, `this.settings.set(key, value)`

**Existing keyboard shortcut system:**

- `src/ui/shortcuts.ts` — ShortcutManager with chord support (e.g., G+I for Go to Inbox)
- `src/ui/shortcutManagerInstance.ts` — singleton instance

**Existing focus mode:**

- `src/ui/components/FocusMode.tsx` — full-screen overlay, Space to complete, N/P to navigate

**Existing E2E test infrastructure:**

- `playwright.config.ts` — webServer runs `pnpm dev`, chromium browser, localhost:5173
- `tests/e2e/helpers.ts` — `setupPage()`, `createTask()`, `createTaskViaApi()`, `navigateTo()`, `dismissOnboarding()`, `resetFeatureFlags()`, `localDateKey()`
- `tests/e2e/global-setup.ts` — no-op (cleanup per-test via API)
- 32 existing E2E spec files for reference patterns

**Playwright MCP:** You have access to the Playwright MCP server for browser automation. Use it to visually test the app by navigating, clicking, dragging, and verifying the UI.

---

## Phase 1: Recurring Block Management UI (TB-20)

Add UI for creating and editing recurrence rules on time blocks and slots.

**Requirements:**

- When creating or editing a block, show a "Repeat" option (dropdown or popover)
- Recurrence options: None, Daily, Weekly (pick days), Monthly, Custom (every N days/weeks)
- For weekly: checkboxes for each day of the week (Mon–Sun)
- For custom: interval input + unit selector (days/weeks)
- Optional end date picker
- **Recurring block indicator** — small repeat icon (lucide `Repeat`) on recurring blocks
- **Edit instance vs. series**: when editing a recurring block instance, prompt: "Edit this occurrence" or "Edit all future occurrences"
  - "This occurrence": detach from recurrence (set `recurrenceParentId` but clear `recurrenceRule` on a persisted copy)
  - "All future": update the parent's recurrence rule, regenerate instances
- **Delete instance vs. series**: same pattern — "Delete this occurrence" or "Delete all"

Create `src/plugins/builtin/timeblocking/components/RecurrenceEditor.tsx`:

- Small popover/dropdown UI for setting recurrence rules
- Props: `rule: RecurrenceRule | undefined`, `onChange: (rule: RecurrenceRule | undefined) => void`
- Clean design matching the rest of the UI (Tailwind, semantic tokens)

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 2: Replan Undone Tasks (TB-21)

**Requirements:**

- At the end of the work day (after `workDayEnd`), or when the user navigates to today and has incomplete blocks from yesterday/past:
- Show a **Replan banner** at the top of the timeline: "You have N incomplete blocks from [date]. Replan?"
- Clicking "Replan" opens a modal/popover listing the incomplete blocks:
  - Each block shows: title, original time, linked task status
  - Options per block: "Move to today" (reschedule to same time today), "Move to tomorrow", "Skip" (delete the block)
  - "Replan All to Today" bulk action button
- After replanning: blocks get new dates, store is updated, timeline refreshes
- Detection logic: on mount, check `store.listBlocks(yesterdayDate)` for blocks whose linked tasks are still pending

Create `src/plugins/builtin/timeblocking/components/ReplanBanner.tsx`:

- Banner component shown at top of TimeblockingView when stale blocks exist
- `ReplanModal.tsx` for the detailed replan flow

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 3: Conflict Detection & Indicators (TB-22)

**Requirements:**

- Use `findConflicts()` from `slot-helpers.ts` to detect overlapping blocks/slots
- Visual indicators on conflicting blocks:
  - Red left border (`border-l-red-500`)
  - Small warning badge (lucide `AlertTriangle`) in top-right corner
  - Tooltip on hover: "Overlaps with [block title] (9:00–10:00)"
- During drag: show conflict preview — if dropping in the current position would create an overlap, tint the DragOverlay red
- Conflicts are advisory, not blocking — users can intentionally overlap blocks

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 4: Plugin Settings Panel (TB-23)

The plugin manifest already declares 5 settings. The plugin system renders settings automatically in the Plugins tab of Settings. However, verify this works and add any missing UX.

**Requirements:**

- Verify: open Settings → Plugins → Timeblocking — settings should render from the manifest
- If settings don't render correctly, fix the plugin settings renderer
- Add a **dedicated settings section** inside the TimeblockingView header:
  - Gear icon button that opens a popover with quick-access settings
  - Work hours (start/end), grid interval, default duration
  - These write to plugin settings via `this.settings.set()`
- Settings changes should immediately reflect in the timeline (re-render with new work hours, grid interval, etc.)

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 5: Focus Mode Integration (TB-24)

**Requirements:**

- When a time block is active (current time falls within a block's time range):
  - Show a "Focus" button on the block card
  - Clicking it enters a **focused state** — the block is highlighted, a countdown timer shows remaining time
  - The timer shows: "1h 23m remaining" and counts down in real-time
- If the block has a linked task, the task title is prominently displayed
- When the timer reaches 0: show a notification "Time block complete!" and auto-advance to the next block (if any)
- **Status bar integration:** Show the current focused block in the plugin status bar item (already registered in index.ts via `addStatusBarItem`)
  - Format: "📅 Focus: [title] (45m left)"

This does NOT need to integrate with the existing FocusMode.tsx component — it's a plugin-specific focus feature that lives within the timeblocking view.

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 6: Keyboard Shortcuts (TB-25)

Register keyboard shortcuts via the plugin's command registry.

**Requirements:**

- `D` — switch to Day view (1 column)
- `W` — switch to Week view (7 columns)
- `1` through `7` — switch to N-day view
- `T` — go to today
- `←` / `→` — navigate previous/next (by dayCount)
- `N` — create new block at the next available time slot
- `Delete` or `Backspace` — delete selected block
- `F` — focus on current/selected block
- `S` — toggle sidebar visibility

**Implementation:**

- Register via `this.app.commands?.register()` in onLoad()
- Commands should only fire when the timeblocking view is active (check current route/view)
- Don't conflict with existing app shortcuts — check `src/ui/shortcuts.ts` for conflicts

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 7: Unit Tests for New Features

Add tests for the new Phase 1–6 features:

### `tests/plugins/timeblocking/components/RecurrenceEditor.test.tsx`

- Renders recurrence options (None, Daily, Weekly, Monthly, Custom)
- Weekly mode shows day-of-week checkboxes
- Custom mode shows interval input
- Calls onChange with correct RecurrenceRule

### `tests/plugins/timeblocking/components/ReplanBanner.test.tsx`

- Shows when stale blocks exist
- Hidden when no stale blocks
- "Replan All to Today" moves blocks

### `tests/plugins/timeblocking/components/FocusTimer.test.tsx`

- Countdown displays correct remaining time
- Timer updates (mock setInterval)
- Shows notification when time expires

Run `pnpm test` to verify all tests pass.

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 8: E2E Testing with Playwright MCP (TB-26)

**This is the most important phase.** Use the Playwright MCP tools to run the actual app and test everything visually.

### Setup

1. Run `pnpm dev` in the background (or it may already be running)
2. Use Playwright MCP to navigate to `http://localhost:5173`
3. Dismiss onboarding if it appears
4. The app should be running with all features enabled

### Test Flows — Execute Each One

**Flow 1: Navigate to Timeblocking View**

1. Look for "Timeblocking" in the sidebar navigation
2. Click it — the timeblocking view should load
3. Verify: day timeline visible with hour grid, current time indicator, task sidebar on left
4. If the view doesn't appear in the sidebar, check if the plugin is loaded in Settings → Plugins

**Flow 2: Create Tasks and Drag to Timeline**

1. Navigate to Inbox, create 3 test tasks: "Write report ~1h", "Team standup ~30m", "Code review ~45m"
2. Navigate back to Timeblocking view
3. Verify tasks appear in the task sidebar
4. Drag "Write report" onto the 9:00 AM slot — a block should appear
5. Drag "Team standup" onto the 10:00 AM slot
6. Verify blocks show correct titles and durations

**Flow 3: Block Operations**

1. Click a block — verify it's selectable
2. Try dragging a block to a new time — verify it repositions
3. Try resizing a block's bottom edge — verify duration changes
4. Alt+Click on an empty slot — verify a new standalone block is created
5. Double-click on the new block's title to edit it — type "Focus time" and press Enter

**Flow 4: Week View**

1. Click the "Week" button in the view mode selector (or press W)
2. Verify 7 day columns appear with shared hour labels
3. Today's column should be highlighted
4. Blocks from the day view should appear in today's column
5. Navigate forward (→) — dates should advance by 7 days

**Flow 5: N-Day Views**

1. Click "3D" button — verify 3 columns
2. Click "5D" — verify 5 columns (work week)
3. Click "Day" — back to single column
4. Press "Today" button — verify it returns to today

**Flow 6: Time Slots**

1. Shift+Alt+Click on the timeline to create a time slot
2. Verify the slot appears with a different visual style than blocks
3. Drag a task from the sidebar into the slot
4. Verify the task count badge shows "0/1"

**Flow 7: Recurring Blocks**

1. Create a new block
2. Open its recurrence editor (look for a Repeat option)
3. Set it to "Weekly" on Mon/Wed/Fri
4. Navigate through the week — verify the block appears on those days

**Flow 8: Settings**

1. Find the settings gear icon in the timeblocking header
2. Open it — verify work hours, grid interval, default duration options
3. Change work day start to 08:00 — verify the timeline updates
4. Change grid interval to 15 min — verify more grid lines appear

**Flow 9: Keyboard Shortcuts**

1. Press `D` — verify day view
2. Press `W` — verify week view
3. Press `T` — verify jumps to today
4. Press `←` and `→` — verify date navigation
5. Press `S` — verify sidebar toggles

**Flow 10: Replan Banner**

1. Create a block for yesterday with a linked task
2. Navigate to today — verify a replan banner appears
3. Click "Replan" — verify the modal shows yesterday's incomplete blocks

### Bug Fixing

For each test flow:

- If something doesn't work, **diagnose the issue** by reading the relevant source code
- **Fix the bug** directly in the source files
- Re-test the flow to confirm the fix
- Document what was broken and how you fixed it in a comment or commit message

**Common issues to watch for:**

- Plugin not loading (check bootstrap.ts plugin discovery path)
- Plugin view not rendering (check contentType: "react", component registration)
- Drag-and-drop not working (check DndContext sensor config, droppable IDs)
- Blocks not persisting (check store.ts persistence calls)
- Keyboard shortcuts conflicting with app shortcuts
- CSS not applying (check Tailwind token names exist in theme files)
- Mobile layout broken (check responsive classes)

### After Fixing All Issues

1. Run `pnpm test` — all unit tests must still pass
2. Run `pnpm check` — lint + typecheck + test must be clean
3. Write an E2E spec file: `tests/e2e/timeblocking.spec.ts` using the existing helpers pattern

Create `tests/e2e/timeblocking.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, navigateTo, localDateKey } from "./helpers";

test.describe("Timeblocking Plugin", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("navigates to timeblocking view", async ({ page }) => {
    // Click Timeblocking in sidebar
    // Verify timeline grid visible
  });

  test("creates a block by alt-clicking timeline", async ({ page }) => {
    // Navigate to timeblocking
    // Alt+click on a time slot
    // Verify block created
  });

  test("switches between day and week views", async ({ page }) => {
    // Navigate to timeblocking
    // Click Week button
    // Verify 7 columns
    // Click Day button
    // Verify single column
  });

  test("navigates dates with arrows", async ({ page }) => {
    // Click next arrow
    // Verify date changes
    // Click Today
    // Verify back to today
  });

  // Add more tests based on what you verified with Playwright MCP
});
```

**Final step: Invoke the Code Reviewer sub-agent for a complete pass over ALL files created/modified in this sprint. Verify naming consistency, type correctness, test coverage, and adherence to project conventions. Fix any issues found.**

---

## Rules

- Read existing code before modifying — extend, don't duplicate
- TypeScript strict mode, no `any` types
- Tailwind for all styling — use semantic tokens
- React function components, named exports
- NO new dependencies unless absolutely necessary
- Run `pnpm test` after each phase
- Run `pnpm check` at the end
- Fix the pre-existing daysOverdue test failure in `tests/ai/daily-planning.test.ts` while you're at it (off by one: expects 2, gets 1)
- Commit: `feat(plugin): add timeblocking polish, keyboard shortcuts, and E2E tests`

## Definition of Done

- [ ] Recurring block UI: create/edit recurrence, edit single vs. all, visual indicators
- [ ] Replan banner shows for stale blocks, modal to reschedule
- [ ] Conflict indicators on overlapping blocks (red border, warning badge, tooltip)
- [ ] Plugin settings accessible from timeblocking header gear icon
- [ ] Focus timer on active blocks with countdown and status bar update
- [ ] Keyboard shortcuts (D, W, 1-7, T, ←, →, N, Delete, F, S) all working
- [ ] E2E tests written in `tests/e2e/timeblocking.spec.ts`
- [ ] All 10 Playwright MCP test flows verified and passing
- [ ] All bugs found during E2E testing fixed
- [ ] Pre-existing daysOverdue test failure fixed
- [ ] `pnpm check` passes clean (0 failures)
- [ ] No regressions in existing tests
