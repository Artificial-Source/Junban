# Sprint 46 — Housekeeping (HK-01, HK-02)

> Historical note: this prompt predates the later split between `docs/product/roadmap.md`, `docs/product/status.md`, and `docs/internal/planning/sprint-history.md`. Where it mentions a roadmap status table or sprint-history updates in the roadmap, route those updates to the newer canonical docs instead.

## Context

ASF Junban is a local-first, AI-native task manager with an Obsidian-style plugin system.

**Tech stack:** Node.js 22+ / TypeScript strict, React + Tailwind CSS, SQLite via Drizzle ORM, Vitest (unit/integration), Playwright (E2E), Vite, pnpm.

**Conventions:**

- TypeScript strict mode, ESLint + Prettier enforced
- Conventional Commits: `docs(roadmap): ...`, `test(e2e): ...`
- Named exports preferred, no `any` types
- E2E tests live in `tests/e2e/*.spec.ts` with shared helpers in `tests/e2e/helpers.ts`
- E2E helper API: `setupPage(page)`, `localDateKey()`, `createTaskViaApi(page, title, opts?)`, `navigateTo(page, viewName)`
- Currently: 2159 tests across 181 test files (unit + integration + E2E), 31 E2E test files with ~12 specs

**Key references:**

- `docs/product/roadmap.md` — canonical product roadmap with milestone checklists
- `tests/e2e/helpers.ts` — E2E test utilities
- `tests/e2e/*.spec.ts` — existing E2E test files (use as style reference)
- `src/ui/views/` — React view components (Inbox, Project, Settings, Stats, etc.)
- `src/ui/components/CommandPalette.tsx` — command palette component

**Timeblocking plugin status:** COMPLETE across sprints S38-S44. All features implemented — plugin React rendering, core data model, day/week views, DnD, recurrence, focus timer, keyboard shortcuts, E2E tests.

---

## Phase 1: Roadmap Cleanup (HK-01)

### 1a. Tick v1.1 Roadmap Checkboxes

Open `docs/product/roadmap.md`. Find the **"v1.1 — Timeblocking Plugin"** section. Every item in that section is currently `- [ ]` (unchecked). Change all of them to `- [x]` (checked). The timeblocking plugin is fully complete — do not leave any unchecked.

### 1b. Update Current Status Table

At the time this prompt was written, the roadmap also carried the product status table. In the current docs structure, route product snapshot updates to `docs/product/status.md` and sprint-history updates to `docs/internal/planning/sprint-history.md`. Make these updates:

- **Test counts:** Update to **2159 tests, 181 test files**
- **Sprint history table:** Add entries for sprints S38 through S45:
  - S38: Module Decomposition (DX-01 through DX-07)
  - S39: Plugin React Rendering + Network API
  - S40: Timeblocking Core Data Model
  - S41: Timeblocking Day View + DnD
  - S42: Timeblocking Week View
  - S43: Timeblocking Polish + E2E Tests
  - S44: Module Decomposition II (DX-08 through DX-14)
  - S45: Lint Fixes + CI Cleanup

Use the existing table format and style for consistency.

### Commit

```
docs(roadmap): mark v1.1 timeblocking complete, update status table
```

### Review Gate

Before proceeding, invoke the Code Reviewer sub-agent to verify changes:

- All v1.1 items are checked
- No other sections were accidentally modified
- Sprint history entries are accurate and consistently formatted
- Test counts match (2159 tests, 181 test files)

---

## Phase 2: Expand E2E Test Coverage (HK-02)

Add E2E tests for views that currently lack coverage. Read `tests/e2e/helpers.ts` and at least two existing `tests/e2e/*.spec.ts` files first to match the established patterns exactly.

### 2a. Inbox E2E Tests — `tests/e2e/inbox.spec.ts`

Test the Inbox view (`src/ui/views/Inbox.tsx`):

1. **Task creation** — type a task in the input field, submit, verify it appears in the Inbox task list
2. **Task completion** — create a task, click the completion checkbox, verify the task is marked complete (visual indicator or removed from list)
3. **Task deletion** — create a task, delete it (via context menu or keyboard), verify it disappears
4. **Priority display** — create tasks with different priorities (e.g., `"Buy milk p1"`, `"Read book p3"`), verify priority indicators render correctly

### 2b. Project E2E Tests — `tests/e2e/project.spec.ts`

Test the Project view (`src/ui/views/Project.tsx`):

1. **View project tasks** — create a project, add tasks to it, navigate to the project view, verify tasks are visible
2. **Section display** — if sections exist, verify they render within the project view
3. **Empty project state** — navigate to a project with no tasks, verify empty state UI

Use the API helpers to set up project and task data before navigating.

### 2c. Settings E2E Tests — `tests/e2e/settings.spec.ts`

Test the Settings view (`src/ui/views/Settings.tsx`):

1. **Navigation between tabs** — open Settings, click through at least 3 tabs (General, Appearance, AI), verify each tab's content renders
2. **Theme switching** — navigate to Appearance tab, switch theme (e.g., light to dark), verify the theme CSS class changes on the document

### 2d. Stats E2E Tests — `tests/e2e/stats.spec.ts`

Test the Stats view (`src/ui/views/Stats.tsx`):

1. **Page loads** — navigate to Stats, verify the page renders without error
2. **Shows data** — create and complete some tasks first, navigate to Stats, verify stat values or charts are present

### 2e. Command Palette E2E Tests — `tests/e2e/command-palette.spec.ts`

Test the Command Palette (`src/ui/components/CommandPalette.tsx`):

1. **Opens with Ctrl+K** — press `Ctrl+K` (or `Meta+K` on Mac), verify the palette overlay appears
2. **Search works** — open palette, type a search query, verify filtered results appear
3. **Navigation** — open palette, select a navigation command (e.g., "Go to Inbox"), verify the view changes
4. **Closes on Escape** — open palette, press Escape, verify it closes

### General E2E Guidelines

- Use `test.beforeEach` with `setupPage(page)` in every describe block
- Use `createTaskViaApi()` for test data setup — avoid creating tasks through the UI unless that IS the thing being tested
- Use reasonable timeouts: `{ timeout: 5000 }` for visibility checks
- Use accessible selectors: `getByText`, `getByRole`, `getByTestId`, `getByPlaceholder`
- Keep tests independent — each test should set up its own data
- If a view requires navigation, use `navigateTo(page, "ViewName")`

### Commit

```
test(e2e): add coverage for inbox, project, settings, stats, command palette
```

### Review Gate

Before proceeding, invoke the Code Reviewer sub-agent to verify changes:

- All test files follow existing E2E patterns (imports, setup, selectors)
- Tests are independent and don't rely on shared mutable state
- No hardcoded waits — use Playwright's built-in waiting (`toBeVisible`, `waitForSelector`)
- Helper functions are used consistently (`setupPage`, `createTaskViaApi`, `navigateTo`)
- TypeScript compiles cleanly (`pnpm exec tsc --noEmit`)

---

## Definition of Done

- [ ] **HK-01:** All v1.1 roadmap items are `- [x]` checked
- [ ] **HK-01:** Product status / sprint history updated with 2159 tests / 181 files and S38-S45 sprint entries
- [ ] **HK-02:** `tests/e2e/inbox.spec.ts` — 4 specs (create, complete, delete, priority)
- [ ] **HK-02:** `tests/e2e/project.spec.ts` — 2-3 specs (view tasks, sections, empty state)
- [ ] **HK-02:** `tests/e2e/settings.spec.ts` — 2 specs (tab navigation, theme switching)
- [ ] **HK-02:** `tests/e2e/stats.spec.ts` — 2 specs (page loads, shows data)
- [ ] **HK-02:** `tests/e2e/command-palette.spec.ts` — 4 specs (open, search, navigate, close)
- [ ] All E2E tests pass: `pnpm exec playwright test`
- [ ] TypeScript compiles: `pnpm exec tsc --noEmit`
- [ ] Lint passes: `pnpm lint`
- [ ] Two commits with conventional commit messages

---

## Final Review Gate

After all phases are complete, invoke the Code Reviewer sub-agent for a final pass:

- Verify both commits are clean and properly scoped
- Confirm no unintended file changes
- Run `pnpm exec playwright test` to confirm all E2E tests pass
- Run `pnpm check` for full lint + typecheck + test validation
