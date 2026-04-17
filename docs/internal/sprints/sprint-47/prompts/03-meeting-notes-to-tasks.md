# Sprint 47 — A-39: Meeting Notes to Tasks

## Context

You are working on **ASF Junban**, a local-first, AI-native task manager. The codebase uses Node.js 22+, TypeScript (strict mode), React + Tailwind CSS, SQLite via Drizzle ORM, and Vitest for testing. Package manager is pnpm.

### Relevant Architecture

- **AI tool registry**: Tools are registered in `src/ai/tools/builtin/` using `registry.register({ name, description, parameters }, async (args, ctx) => {...})`. Each tool file exports a `register(registry, ctx)` function. See existing tools like `task-crud.ts`, `query-tasks.ts`, or `bulk-operations.ts` for patterns.
- **AI chat system**: `src/ai/chat.ts` orchestrates LLM conversations with tool execution. The LLM pipeline is accessible via `ctx.pipeline` or similar context objects.
- **Task creation**: `ctx.taskService.create(input)` where `CreateTaskInput` requires `title` (string) and optionally accepts `description`, `priority` (1–4, where 1 is highest), `dueDate` (ISO 8601 string), `dueTime` (boolean — true if a specific time is set, false for date-only), `projectId`, and `tags` (string array).
- **Tool parameters** are defined as Zod schemas.
- **Tool registry**: `src/ai/tools/registry.ts` — the `ToolRegistry` class.
- **Tool type definitions**: `src/ai/tools/types.ts`.
- **Existing similar tools**: `daily-planning.ts`, `task-breakdown.ts`, `bulk-operations.ts` — reference these for patterns on multi-task creation and structured LLM output parsing.

### Conventions

- TypeScript strict mode — no `any` types
- Named exports preferred
- Tailwind CSS for all styling — no inline styles, no CSS modules
- Conventional Commits: `feat(ai): add extract-tasks-from-text tool`
- React function components only
- All public functions have JSDoc for complex logic
- Errors are handled, not swallowed
- Tests in `tests/` mirror `src/` structure

---

## Phase 1: AI Tool — `extract_tasks_from_text`

### Goal

Create a new AI tool that accepts freeform text (meeting notes, emails, brain dumps, bullet lists) and extracts structured action items as tasks.

### Instructions

1. **Create** `src/ai/tools/builtin/extract-tasks-from-text.ts`

2. **Register the tool** with these specifications:
   - **Name**: `extract_tasks_from_text`
   - **Description**: Clear description explaining it extracts action items from freeform text like meeting notes, emails, or brain dumps.
   - **Parameters** (Zod schema):
     - `text` — `z.string()`, required. The raw text to extract tasks from.
     - `projectId` — `z.string().optional()`. If provided, assign all extracted tasks to this project.
     - `dryRun` — `z.boolean().optional().default(true)`. When true (default), return the extracted tasks as a preview without creating them. When false, actually create the tasks via `taskService`.

3. **Implementation**:
   - Use the LLM (via the tool's context — follow the pattern other tools use to call the pipeline) to analyze the input text.
   - Craft a system prompt that instructs the LLM to:
     - Identify all action items, to-dos, decisions requiring follow-up, and commitments from the text
     - For each item, extract:
       - `title` — concise, actionable task title (start with a verb)
       - `priority` — 1 (urgent) to 4 (low), inferred from language cues ("ASAP" → 1, "when you get a chance" → 4, default 3)
       - `dueDate` — ISO 8601 string if a date/deadline is mentioned, otherwise omit
       - `dueTime` — boolean, true only if a specific time is mentioned
       - `description` — any additional context from the surrounding text
       - `assigneeHint` — person's name if the action is assigned to someone (informational only, stored in description)
     - Return a JSON array of extracted tasks
   - Parse the LLM's response as JSON. Handle malformed responses gracefully (retry once or return an error).
   - If `dryRun` is true: return the extracted tasks as a structured preview (array of objects with the fields above).
   - If `dryRun` is false: iterate through extracted tasks and call `ctx.taskService.create()` for each, applying `projectId` if provided. Return the created tasks with their IDs.
   - Return a clear result object: `{ tasks: [...], created: boolean, count: number }`.

4. **Register the tool** in the tool registry. Follow the pattern used by other builtin tools — check how they're imported and registered in `src/ai/tools/builtin/` and any index/barrel file that aggregates them.

5. **Error handling**:
   - If the text is empty or too short, return an error message without calling the LLM.
   - If LLM response parsing fails, return a clear error rather than crashing.
   - If task creation fails (dryRun=false), report which tasks succeeded and which failed.

### Reference Files

- `src/ai/tools/builtin/task-crud.ts` — pattern for task creation
- `src/ai/tools/builtin/bulk-operations.ts` — pattern for multi-task operations
- `src/ai/tools/builtin/task-breakdown.ts` — pattern for LLM-powered analysis that produces tasks
- `src/ai/tools/builtin/daily-planning.ts` — pattern for structured LLM output
- `src/ai/tools/registry.ts` — tool registration
- `src/ai/tools/types.ts` — tool type definitions
- `src/core/types.ts` — `CreateTaskInput` and related types

---

## Code Review Checkpoint 1

Before proceeding to Phase 2, review your Phase 1 work:

- [ ] Tool file created at `src/ai/tools/builtin/extract-tasks-from-text.ts`
- [ ] Tool registered with name `extract_tasks_from_text`
- [ ] Zod parameter schema with `text`, `projectId`, `dryRun`
- [ ] LLM prompt clearly instructs extraction of action items with all fields
- [ ] JSON parsing of LLM response with error handling
- [ ] Dry run mode returns preview without creating tasks
- [ ] Live mode creates tasks via `taskService.create()` and reports results
- [ ] Tool registered in the aggregation/index file (if one exists)
- [ ] No `any` types
- [ ] Named exports used
- [ ] Follows existing tool patterns exactly

---

## Phase 2: Quick Capture UI — Extract Tasks Modal

### Goal

Add a UI component that lets users paste freeform text, extract tasks via the AI tool, preview them, and optionally create them all.

### Instructions

1. **Create** `src/ui/components/ExtractTasksModal.tsx`

2. **Modal design** (Tailwind, responsive):
   - Title/header: "Extract Tasks from Text" with a close button
   - A `<textarea>` for pasting text (placeholder: "Paste meeting notes, email, or any text with action items...")
   - Optional project selector dropdown (reuse existing project selector components if available)
   - "Extract" button — calls the AI tool with `dryRun: true`
   - Loading state while the LLM processes
   - **Preview section** (shown after extraction):
     - List of extracted tasks with checkboxes (all checked by default)
     - Each task shows: title, priority badge, due date (if any), assignee hint (if any)
     - User can uncheck tasks they don't want to create
     - User can click a task to edit its title inline
   - "Create Selected Tasks" button — calls the AI tool with `dryRun: false` (or creates them directly via the API) for checked tasks only
   - Success state: "Created N tasks" with a dismiss button
   - Error state: show error message with retry option

3. **Integration points**:
   - Add a command to the command palette: "Extract tasks from text" — opens this modal
   - The modal should be accessible from `App.tsx` or a suitable parent component
   - Use existing UI patterns (look at `DailyPlanningModal.tsx` or `SearchModal.tsx` for modal patterns)
   - Use the AI API layer (`src/ui/api/ai.ts` or `src/ui/api/ai/`) to call the tool, or invoke it through the chat context

4. **State management**:
   - Local state via `useState` for: input text, extracted tasks, loading, error, selected task indices
   - No global state needed

5. **Accessibility**:
   - Focus trap within the modal
   - Escape key closes the modal
   - Proper ARIA labels on the textarea and buttons

### Reference Files

- `src/ui/components/DailyPlanningModal.tsx` — modal pattern
- `src/ui/components/SearchModal.tsx` — modal pattern, command palette integration
- `src/ui/components/CommandPalette.tsx` — adding commands
- `src/ui/App.tsx` — modal mounting
- `src/ui/hooks/useFocusTrap.ts` — focus trap hook
- `src/ui/api/ai.ts` (or `src/ui/api/ai/`) — AI API calls

---

## Code Review Checkpoint 2

Before proceeding to Phase 3, review your Phase 2 work:

- [ ] `ExtractTasksModal.tsx` created with textarea, extract button, preview list, create button
- [ ] Modal follows existing patterns (overlay, focus trap, Escape to close)
- [ ] Loading and error states handled
- [ ] Preview shows extracted tasks with checkboxes, priority badges, due dates
- [ ] Users can deselect tasks they don't want
- [ ] "Create Selected Tasks" creates only checked tasks
- [ ] Command palette entry added: "Extract tasks from text"
- [ ] Modal integrated into the component tree (App.tsx or appropriate parent)
- [ ] All Tailwind — no inline styles or CSS modules
- [ ] Responsive design (works on mobile)
- [ ] No `any` types

---

## Phase 3: Tests

### Goal

Add comprehensive tests for the AI tool and the UI component.

### Instructions

1. **Unit tests for the tool**: `tests/ai/tools/extract-tasks-from-text.test.ts`
   - **Test: extracts tasks from meeting notes (dry run)**
     - Mock the LLM to return a structured JSON response with 3 tasks
     - Call the tool with sample meeting notes text and `dryRun: true`
     - Assert: returns 3 tasks with correct titles, priorities, due dates
     - Assert: no tasks created in taskService

   - **Test: creates tasks when dryRun is false**
     - Mock the LLM response
     - Call with `dryRun: false`
     - Assert: `taskService.create()` called for each task
     - Assert: returned tasks have IDs

   - **Test: assigns projectId to all tasks**
     - Call with `projectId: "proj-123"` and `dryRun: false`
     - Assert: each `taskService.create()` call includes `projectId: "proj-123"`

   - **Test: handles empty text input**
     - Call with `text: ""`
     - Assert: returns error, does not call LLM

   - **Test: handles malformed LLM response**
     - Mock LLM to return non-JSON text
     - Assert: returns meaningful error, does not crash

   - **Test: handles various input formats**
     - Test with bullet-list format
     - Test with email-style format
     - Test with narrative paragraph format
     - Assert: tool processes each without errors (mock LLM accordingly)

   - **Test: partial failure in creation mode**
     - Mock `taskService.create()` to throw on the 2nd task
     - Assert: 1st task created successfully, error reported for 2nd, 3rd still attempted

2. **Component tests for the modal**: `tests/ui/components/ExtractTasksModal.test.tsx`
   - **Test: renders textarea and extract button**
   - **Test: extract button disabled when textarea is empty**
   - **Test: shows loading state during extraction**
   - **Test: displays extracted tasks after successful extraction**
   - **Test: checkboxes toggle task selection**
   - **Test: "Create Selected Tasks" only creates checked tasks**
   - **Test: Escape key closes the modal**
   - **Test: shows error state on failure**

3. **Follow existing test patterns**: look at `tests/ai/tools/` for how other tool tests mock the LLM and task services. Look at `tests/ui/components/` for component test patterns.

### Reference Files

- `tests/ai/tools/` — existing tool test patterns
- `tests/ui/components/` — existing component test patterns
- `tests/integration/helpers.ts` — `createTestServices()` helper

---

## Code Review Checkpoint 3

Review all tests:

- [ ] Tool tests cover: dry run, live creation, projectId assignment, empty input, malformed LLM, various formats, partial failure
- [ ] Component tests cover: render, disabled states, loading, preview, selection, creation, escape, errors
- [ ] Tests follow existing patterns (same imports, same mocking approach)
- [ ] All tests pass: `pnpm vitest run tests/ai/tools/extract-tasks-from-text.test.ts tests/ui/components/ExtractTasksModal.test.tsx`
- [ ] No `any` types in tests

---

## Definition of Done

- [ ] `src/ai/tools/builtin/extract-tasks-from-text.ts` — AI tool registered and functional
- [ ] `src/ui/components/ExtractTasksModal.tsx` — modal with paste, extract, preview, create flow
- [ ] Command palette entry: "Extract tasks from text"
- [ ] `tests/ai/tools/extract-tasks-from-text.test.ts` — all tool tests passing
- [ ] `tests/ui/components/ExtractTasksModal.test.tsx` — all component tests passing
- [ ] `pnpm check` passes (lint + typecheck + test)
- [ ] No `any` types anywhere in new code
- [ ] All files use named exports
- [ ] Conventional Commits used: `feat(ai): add extract-tasks-from-text tool`

---

## Final Code Review

Run through the complete checklist one last time:

1. **Functionality**: Paste text → extract tasks → preview → create. Works end to end.
2. **Code quality**: TypeScript strict, no `any`, named exports, Tailwind only, follows existing patterns.
3. **Tests**: All pass, cover happy paths and error cases.
4. **Integration**: Tool registered in registry, modal accessible from command palette, no regressions.
5. **Lint/Type check**: `pnpm check` is clean.
6. **Commit**: Use `feat(ai): add extract-tasks-from-text tool` for the AI tool and `feat(ui): add extract tasks modal for quick capture` for the UI, or a single combined commit if preferred.
