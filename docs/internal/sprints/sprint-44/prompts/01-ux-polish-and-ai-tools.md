# Sprint S44: Timeblocking UX Polish + AI Tools

## Context

ASF Junban is a local-first task manager with an Obsidian-style plugin system. Read `CLAUDE.md` for full project context, conventions, and tech stack.

This sprint fixes UX gaps found during E2E testing of the timeblocking plugin: sidebar integration, context menus, task interactions, and AI tool registration.

### What already exists:

**Timeblocking plugin (S39–S43):**

- `src/plugins/builtin/timeblocking/` — full plugin with types, store, recurrence, slot-helpers, task-linking
- `src/plugins/builtin/timeblocking/components/` — TimeblockingView, DayTimeline, WeekTimeline, TimelineColumn, TimeBlockCard, TimeSlotCard, TaskSidebar, DragPreview, RecurrenceEditor, ReplanBanner, SettingsPopover, FocusTimer
- Day/week/N-day views with drag-and-drop, block creation, repositioning, resizing
- Split layout with collapsible/resizable sidebar
- 2146 tests passing across 180 test files

**Sidebar system:**

- `src/ui/components/Sidebar.tsx` — main sidebar with DnD sorting, `orderedSidebarItems`, `navItemMap`
- `src/ui/components/sidebar/ViewNavigation.tsx` — renders nav items, sections, plugin views
- `src/ui/components/sidebar/SidebarPrimitives.tsx` — `SortableNavItem`, `renderNavButton`, `NAV_ITEMS`
- `src/ui/components/sidebar/SidebarContextMenu.tsx` — right-click menu with favorites, hide, reorder
- `src/ui/components/sidebar/ProjectTree.tsx` — project items in sidebar

**Context menu system:**

- `src/ui/components/ContextMenu.tsx` — generic context menu component used throughout the app
- Supports groups, icons, keyboard shortcuts, submenus
- Used on tasks (TaskList), sidebar nav items

**AI tools system:**

- `src/ai/tools/registry.ts` — `ToolRegistry` with `register(definition, executor, source)`, `unregisterBySource(pluginId)`
- `src/plugins/api.ts` — plugins with `"ai:tools"` permission get `api.ai.registerTool(definition, executor)`
- `src/ai/tools/types.ts` — `ToolDefinition` (name, description, parameters as Zod schema), `ToolExecutor`
- Timeblocking manifest already declares `"ai:tools"` permission

**Plugin permissions (all 11):**

- `task:read`, `task:write`, `ui:panel`, `ui:view`, `ui:status`, `commands`, `settings`, `storage`, `network`, `ai:provider`, `ai:tools`

**Existing Playwright MCP:** Configured at `~/.claude/mcp.json` for browser automation testing.

---

## Phase 1: Plugin Sidebar Drag + Context Menu (TB-40)

The Timeblocking sidebar item can't be dragged to reorder and doesn't show a context menu on right-click.

### Partially done — complete the fix:

**In `src/ui/components/Sidebar.tsx`:**

- `navItemMap` has been updated to include plugin navigation views with `plugin-view-{id}` keys (type widened to accept string icons)
- `orderedSidebarItems` has been updated to include `plugin-view-{id}` entries for builtin plugin navigation views
- `Inbox` has been added to the lucide-react import
- `viewsBySlot.navigation` has been added to the dependency array

**In `src/ui/components/sidebar/ViewNavigation.tsx`:**

- The expanded view now renders plugin nav items as `SortableNavItem` inside the sortable context (with proper `isPluginView` detection and `navigate` callback)
- The collapsed view also handles plugin view items properly
- The separate `viewsBySlot.navigation.map()` rendering has been removed from both views

**What still needs to be done:**

1. Verify the drag fix works — plugin view should be draggable in the sidebar like other nav items
2. Pass `onNavContextMenu` to the plugin view's `renderNavButton` call so right-click works
3. In `SidebarContextMenu.tsx`, handle plugin view items — they should support: favorites, move to top/bottom, and "Open in new tab" if applicable
4. Test that clicking the Timeblocking item still navigates correctly after the refactor

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 2: Right-Click Empty Sidebar Space (TB-41)

Currently, right-clicking empty space in the sidebar does nothing. Add a context menu.

**Requirements:**

- Add `onContextMenu` handler on the sidebar's root/empty areas (the nav container in `ViewNavigation.tsx` or the sidebar itself in `Sidebar.tsx`)
- Show a context menu with:
  - "New Project" — triggers the new project modal
  - "Add Task" — focuses the task input (Ctrl+N behavior)
  - Separator
  - "Manage Sidebar" — opens Settings (or just the sidebar reorder UI)
  - "Reset Order" — resets sidebar ordering to default
- Use the existing `ContextMenu` component pattern from `src/ui/components/ContextMenu.tsx`
- The menu should only appear when clicking empty space — not when clicking on an existing item (check `e.target`)

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 3: Timeline Grid Context Menu (TB-42)

Add a right-click context menu to the timeline grid in the timeblocking view.

**Requirements:**

- Right-click on an empty area of the timeline grid shows a context menu:
  - "New Block" — creates a block at the clicked time (same as Alt+Click)
  - "New Recurring Block" — creates a block and immediately opens the RecurrenceEditor
  - "New Time Slot" — creates a slot at the clicked time (same as Shift+Alt+Click)
  - Separator
  - "Paste Block" — if a block was previously "copied" (clipboard state)
- Right-click should calculate the time from the click position (reuse the `handleTimelineClick` math from `TimelineColumn.tsx:254-269`)
- The context menu should appear at the mouse position

**Implementation:**

- Add `onContextMenu` handler to the timeline column div in `TimelineColumn.tsx`
- Create a `TimelineContextMenu` component or use inline menu state in `TimeblockingView.tsx`
- Store clipboard state for copy/paste in the `TimeblockingView` component
- Pass the context menu handlers down to `TimelineColumn` via props

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 4: Time Block Context Menu (TB-43)

Add a right-click context menu to time block cards.

**Requirements:**

- Right-click on a `TimeBlockCard` shows:
  - "Edit Title" — enters inline edit mode (same as double-click)
  - "Set Recurrence..." — opens the RecurrenceEditor popover
  - "Duplicate" — creates a copy of the block at the next available slot
  - "Copy" — copies block to clipboard (for paste in Phase 3)
  - Separator
  - "Link Task..." — shows a task picker to link a task to this block
  - "Unlink Task" — removes task linkage (only shown if block has a linked task)
  - Separator
  - "Lock Block" — toggles the block's `locked` flag
  - "Change Color" — small color picker (5-6 preset colors)
  - Separator
  - "Delete" — deletes the block (with confirmation for recurring blocks: "Delete this occurrence" / "Delete all")

**Also add context menu to TimeSlotCard:**

- Right-click shows: "Edit Slot", "Delete Slot", "Clear Tasks" (remove all tasks from slot)

**Implementation:**

- Add `onContextMenu` to `TimeBlockCard.tsx` and `TimeSlotCard.tsx`
- Prevent default browser menu
- Use a local state for menu position + target block/slot ID
- The menu can be rendered in `TimeblockingView.tsx` (single menu instance, positioned absolutely)

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 5: Click Tasks in Plugin TaskSidebar (TB-44)

Tasks in the timeblocking plugin's sidebar are drag-only. Users should be able to click them to view/edit.

**Requirements:**

- Single click on a task in `TaskSidebar.tsx` should open the task detail panel
- The task detail panel is the existing `TaskDetailPanel` component at `src/ui/components/TaskDetailPanel.tsx`
- Since the plugin runs inside `PluginView.tsx` which is inside the main app, the task detail panel can be triggered via the app's existing mechanism
- **Approach**: The plugin needs to communicate "open task X" to the parent app. Options:
  1. Use the plugin's event bus: `plugin.app.events.emit("task:select", taskId)` — if the app listens for this
  2. Use URL hash navigation: change hash to `#/task/{taskId}` — check if this opens the detail panel
  3. Add a new plugin API method: `plugin.app.tasks.openDetail(taskId)` — cleanest approach
- Check `src/ui/hooks/useRouting.ts` for how task detail is triggered (likely via `selectedTaskId` state)
- The click should NOT interfere with drag — use the `distance` activation constraint from dnd-kit (already set to 5px). A click without movement should trigger the detail panel, while a drag (>5px movement) should trigger the drag.

**Implementation:**

- Add `onTaskClick?: (taskId: string) => void` prop to `TaskSidebar`
- In `DraggableTask`, add an `onClick` handler that calls `onTaskClick(task.id)` — but only if the task wasn't just dragged
- Track drag state: set a flag on `dragStart`, clear it on `dragEnd`, skip `onClick` if the flag is set
- In `TimeblockingView.tsx`, pass `onTaskClick` that navigates to the task or opens the detail panel
- **Plugin API addition**: Add `tasks.openDetail?: (taskId: string) => void` to `createPluginAPI()` in `src/plugins/api.ts`. The implementation should dispatch a custom event or call a callback that the app's `PluginView.tsx` or `App.tsx` listens to. Check how the app currently opens task details — likely by setting hash to `#/task/{taskId}` or updating a state variable.

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 6: Plugin AI Tools (TB-45)

Register AI tools from the timeblocking plugin so the AI assistant can create, query, and manage time blocks.

**Requirements — register these tools in `onLoad()` of `src/plugins/builtin/timeblocking/index.ts`:**

1. **`timeblocking_list_blocks`** — List all time blocks for a date or date range
   - Parameters: `date` (string, required) or `startDate` + `endDate` (for range)
   - Returns: Array of blocks with id, title, date, startTime, endTime, taskId, recurrence info

2. **`timeblocking_create_block`** — Create a new time block
   - Parameters: `title` (string), `date` (string, YYYY-MM-DD), `startTime` (string, HH:MM), `endTime` (string, HH:MM), `taskId?` (string, optional — link to existing task)
   - Returns: The created block

3. **`timeblocking_update_block`** — Update an existing time block
   - Parameters: `blockId` (string), partial fields: `title?`, `date?`, `startTime?`, `endTime?`, `locked?`, `color?`
   - Returns: The updated block

4. **`timeblocking_delete_block`** — Delete a time block
   - Parameters: `blockId` (string)
   - Returns: Confirmation

5. **`timeblocking_schedule_task`** — Schedule a task onto the timeline at the best available time
   - Parameters: `taskId` (string), `date` (string, YYYY-MM-DD), `preferredTime?` (string, HH:MM)
   - Logic: Find the first available slot on that date (avoid conflicts), use task's `estimatedMinutes` for duration, fall back to `defaultDurationMinutes` setting
   - Returns: The created block

6. **`timeblocking_get_availability`** — Get free time slots for a given date
   - Parameters: `date` (string, YYYY-MM-DD)
   - Returns: Array of free intervals between work hours (e.g., `[{ start: "09:00", end: "10:00" }, ...]`)

7. **`timeblocking_set_recurrence`** — Set or update recurrence on a block
   - Parameters: `blockId` (string), `rule` object (frequency: daily/weekly/monthly, interval?, daysOfWeek?, endDate?)
   - Returns: Updated block with recurrence

8. **`timeblocking_replan_day`** — Move all incomplete blocks from a past date to a target date
   - Parameters: `fromDate` (string), `toDate` (string, default today)
   - Returns: Array of replanned blocks

**Implementation pattern:**

```typescript
// In onLoad():
if (this.app.ai?.registerTool) {
  this.app.ai.registerTool(
    {
      name: "timeblocking_list_blocks",
      description: "List time blocks for a date. Returns block titles, times, and linked tasks.",
      parameters: z.object({
        date: z.string().describe("Date in YYYY-MM-DD format"),
      }),
    },
    async (args) => {
      const blocks = this.store.listBlocks(args.date);
      return { content: [{ type: "text", text: JSON.stringify(blocks, null, 2) }] };
    },
  );
}
```

- Import `z` from `zod` (already a project dependency)
- Each tool should use the existing `TimeBlockStore` methods from `this.store`
- For `timeblocking_schedule_task`, implement conflict avoidance by checking `findConflicts()` from `slot-helpers.ts`
- For `timeblocking_get_availability`, invert the block list against work hours to find free intervals
- Register all tools in `onLoad()`, they'll auto-unregister on `onUnload()` via `unregisterBySource(pluginId)`

**Also update the AI system prompt** in `src/ai/chat-prompts.ts` or `src/ai/chat.ts` to mention timeblocking tools are available when the plugin is active. Add a brief section like:

```
## Timeblocking
If the user has the timeblocking plugin active, you can manage their schedule:
- List, create, update, delete time blocks
- Schedule tasks into available time slots
- Set recurrence patterns (daily, weekly, monthly)
- Check availability and replan incomplete blocks
```

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 7: Unit Tests

Add tests for the new features:

### `tests/plugins/timeblocking/components/TaskSidebar.test.tsx`

- Click on task triggers `onTaskClick` callback
- Click doesn't fire after drag
- Tasks display correctly with groups

### `tests/plugins/timeblocking/ai-tools.test.ts`

- `timeblocking_list_blocks` returns blocks for a date
- `timeblocking_create_block` creates and returns block
- `timeblocking_schedule_task` avoids conflicts
- `timeblocking_get_availability` returns free intervals
- `timeblocking_replan_day` moves blocks

### `tests/ui/sidebar-plugin-views.test.tsx`

- Plugin view appears in sidebar
- Plugin view is included in sortable items
- Right-click on plugin view shows context menu

Run `pnpm test` to verify all tests pass.

**Before proceeding to the next phase, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 8: E2E Testing with Playwright MCP (TB-46)

Use the Playwright MCP tools to run the actual app and test everything.

### Setup

1. Run `pnpm dev` in the background (or it may already be running)
2. Use Playwright MCP to navigate to `http://localhost:5173`
3. Navigate to the Timeblocking view

### Test Flows

**Flow 1: Sidebar Drag**

1. Verify the Timeblocking item appears in the sidebar
2. Try dragging it up/down — verify it reorders among other nav items
3. Verify navigation still works after reorder

**Flow 2: Sidebar Right-Click**

1. Right-click the Timeblocking sidebar item
2. Verify context menu appears with favorites, move to top/bottom options
3. Try "Add to Favorites" — verify it appears in Favorite Views section
4. Right-click empty space in sidebar — verify "New Project" and "Manage Sidebar" options appear

**Flow 3: Timeline Context Menu**

1. Navigate to Timeblocking view
2. Right-click on an empty area of the timeline
3. Verify "New Block", "New Recurring Block", "New Time Slot" options appear
4. Click "New Block" — verify a block is created at that time
5. Right-click again and try "New Time Slot"

**Flow 4: Block Context Menu**

1. Right-click on an existing block
2. Verify context menu shows: Edit Title, Set Recurrence, Duplicate, Link Task, Lock Block, Change Color, Delete
3. Try "Duplicate" — verify a copy appears
4. Try "Set Recurrence" — verify the RecurrenceEditor opens
5. Try "Delete" — verify the block is removed

**Flow 5: Task Click in Sidebar**

1. Create a few tasks in Inbox
2. Navigate to Timeblocking view
3. Click a task in the sidebar — verify the task detail panel opens
4. Close the detail panel — verify the timeblocking view is still visible
5. Drag a task (not click) — verify it drags normally without opening detail panel

**Flow 6: AI Tools**

1. Navigate to AI Chat
2. Ask: "What time blocks do I have today?"
3. Verify the AI uses `timeblocking_list_blocks` tool
4. Ask: "Schedule my Write Report task for 2pm today"
5. Verify the AI uses `timeblocking_schedule_task` tool
6. Navigate to Timeblocking view and verify the block was created
7. Ask: "What's my availability today?"
8. Verify the AI uses `timeblocking_get_availability`

### Bug Fixing

For each test flow:

- If something doesn't work, **diagnose the issue** by reading the relevant source code
- **Fix the bug** directly in the source files
- Re-test the flow to confirm the fix

### After Fixing All Issues

1. Run `pnpm test` — all tests must still pass
2. Run `pnpm check` — lint + typecheck + test must be clean

**Final step: Invoke the Code Reviewer sub-agent for a complete pass over ALL files created/modified in this sprint. Verify naming consistency, type correctness, test coverage, and adherence to project conventions. Fix any issues found.**

---

## Rules

- Read existing code before modifying — extend, don't duplicate
- TypeScript strict mode, no `any` types
- Tailwind for all styling — use semantic tokens (bg-surface, text-on-surface, border-border, etc.)
- React function components, named exports
- NO new dependencies unless absolutely necessary
- Run `pnpm test` after each phase
- Run `pnpm check` at the end
- Commit: `feat(plugin): add timeblocking context menus, task click, and AI tools`

## Pre-existing Issues to Be Aware Of

- There are 4 pre-existing TypeScript errors in `src/mcp/` files and 1 in `useNudges.ts` — these are NOT from this sprint. Don't try to fix them unless trivially easy. Just ensure no NEW errors are introduced.
- The sidebar drag fix in Phase 1 was partially implemented. The code changes already exist in `Sidebar.tsx` and `ViewNavigation.tsx`. Complete and verify them.

## Definition of Done

- [ ] Plugin sidebar item is draggable to reorder
- [ ] Right-click plugin sidebar item shows context menu (favorites, reorder)
- [ ] Right-click empty sidebar space shows useful options
- [ ] Right-click timeline grid shows "New Block", "New Recurring Block", "New Time Slot"
- [ ] Right-click time block shows full context menu (edit, recurrence, duplicate, delete, etc.)
- [ ] Right-click time slot shows context menu (edit, delete, clear tasks)
- [ ] Clicking task in plugin sidebar opens task detail panel
- [ ] 8 AI tools registered (list, create, update, delete, schedule, availability, recurrence, replan)
- [ ] AI can create and query time blocks via chat
- [ ] All E2E test flows verified via Playwright MCP
- [ ] All bugs found during testing fixed
- [ ] `pnpm check` passes (no new failures)
- [ ] No regressions in existing tests
