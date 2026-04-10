# Core Module Documentation

The `src/core/` directory contains the heart of the Junban application: task management logic, service classes, event infrastructure, and data types. All files in this directory are framework-agnostic and shared by both the UI and CLI.

---

## Services

### `tasks.ts`

**Path:** `src/core/tasks.ts`
**Lines:** 434
**Purpose:** The central task service -- handles all task CRUD operations, subtask hierarchy, batch operations, recurring task creation, and reminder queries. Both the UI and CLI use this module.
**Key Exports:**

- `TaskService` -- class with methods: `create`, `list`, `get`, `update`, `complete`, `delete`, `completeMany`, `deleteMany`, `updateMany`, `restoreTask`, `reorder`, `getDueReminders`, `getChildren`, `listTree`, `indent`, `outdent`
  **Key Dependencies:**
- `IStorage` (storage interface), `TagService`, `EventBus`, `TaskFilter`, `filterTasks`, `sortByPriority`, `generateId`, `NotFoundError`, `getNextOccurrence`, `createLogger`
  **Used By:**
- `src/bootstrap.ts`, `src/bootstrap-web.ts`, `src/cli/commands/*.ts`, `src/plugins/api.ts`, `src/ai/tools/builtin/*.ts`, `src/ai/chat.ts`

---

### `projects.ts`

**Path:** `src/core/projects.ts`
**Lines:** 68
**Purpose:** Manages project entities (task groupings). Provides CRUD operations plus a `getOrCreate` convenience method and project archiving.
**Key Exports:**

- `ProjectService` -- class with methods: `create`, `list`, `get`, `getByName`, `getOrCreate`, `update`, `archive`, `delete`
  **Key Dependencies:**
- `IStorage`, `generateId`, `createLogger`
  **Used By:**
- `src/bootstrap.ts`, `src/bootstrap-web.ts`, `src/cli/commands/add.ts`, `src/cli/commands/list.ts`, `src/ai/tools/builtin/project-crud.ts`, `src/ai/chat.ts`

---

### `tags.ts`

**Path:** `src/core/tags.ts`
**Lines:** 43
**Purpose:** Manages tag/label entities. Tags are automatically lowercased and trimmed. Provides `getOrCreate` for idempotent tag resolution.
**Key Exports:**

- `TagService` -- class with methods: `create`, `list`, `getByName`, `getOrCreate`, `delete`
  **Key Dependencies:**
- `IStorage`, `generateId`, `createLogger`
  **Used By:**
- `src/core/tasks.ts`, `src/bootstrap.ts`, `src/bootstrap-web.ts`, `src/ai/tools/builtin/tag-crud.ts`

---

### `templates.ts`

**Path:** `src/core/templates.ts`
**Lines:** 132
**Purpose:** Manages reusable task templates with `{{variable}}` substitution. Templates can be instantiated to create tasks with pre-filled fields.
**Key Exports:**

- `TemplateService` -- class with methods: `create`, `list`, `get`, `update`, `delete`, `instantiate`
  **Key Dependencies:**
- `IStorage`, `TemplateRow`, `TaskService`, `generateId`, `NotFoundError`, `createLogger`
  **Used By:**
- `src/bootstrap.ts`, `src/bootstrap-web.ts`

---

### `sections.ts`

**Path:** `src/core/sections.ts`
**Lines:** 105
**Purpose:** Manages project sections (groups of tasks within a project). Sections allow users to organize tasks into logical groups (e.g., "To Do", "In Progress", "Done" for board view).
**Key Exports:**

- `SectionService` -- class with methods: `create`, `list`, `get`, `update`, `delete`, `reorder`
  **Key Dependencies:**
- `IStorage`, `EventBus`, `generateId`, `NotFoundError`, `createLogger`
  **Used By:**
- `src/bootstrap.ts`, `src/bootstrap-web.ts`

---

### `stats.ts`

**Path:** `src/core/stats.ts`
**Lines:** 167
**Purpose:** Tracks daily productivity metrics and streaks. Records task creation/completion counts per day, tracks minutes worked, and calculates consecutive-day completion streaks.
**Key Exports:**

- `StatsService` -- class with methods: `recordTaskCreated`, `recordTaskCompleted`, `getToday`, `getStats`, `getCurrentStreak`, `getBestStreak`
  **Key Dependencies:**
- `IStorage`, `DailyStatRow`, `generateId`, `createLogger`
  **Used By:**
- `src/bootstrap.ts`, `src/bootstrap-web.ts`, `src/ai/tools/builtin/productivity-stats.ts`

---

## Logic

### `priorities.ts`

**Path:** `src/core/priorities.ts`
**Lines:** 22
**Purpose:** Priority metadata lookup and task sorting by priority. P1 (urgent) sorts first, null priority sorts last, with sortOrder as tiebreaker.
**Key Exports:**

- `getPriority(value: number)` -- returns priority metadata (label, color) for a numeric value
- `sortByPriority<T>(tasks: T[]): T[]` -- sorts tasks by priority then sortOrder
  **Key Dependencies:**
- `PRIORITIES` from `src/config/defaults.ts`
  **Used By:**
- `src/core/tasks.ts`

---

### `recurrence.ts`

**Path:** `src/core/recurrence.ts`
**Lines:** 45
**Purpose:** Calculates the next occurrence date for recurring tasks. Supports `daily`, `weekly`, `monthly`, `weekdays`, and `every N days/weeks` patterns.
**Key Exports:**

- `getNextOccurrence(recurrence: string, fromDate: Date): Date | null`
  **Key Dependencies:** None (pure function)
  **Used By:**
- `src/core/tasks.ts` (called when completing a recurring task)

---

### `filters.ts`

**Path:** `src/core/filters.ts`
**Lines:** 30
**Purpose:** Defines the `TaskFilter` interface and provides in-memory task filtering by status, project, tag, priority, date range, and text search.
**Key Exports:**

- `TaskFilter` -- interface with optional fields: `status`, `projectId`, `tag`, `priority`, `dueBefore`, `dueAfter`, `search`
- `filterTasks(tasks: Task[], filter: TaskFilter): Task[]`
  **Key Dependencies:**
- `Task` type from `src/core/types.ts`
  **Used By:**
- `src/core/tasks.ts`, `src/core/query-parser.ts`, `src/ai/tools/builtin/query-tasks.ts`, `src/cli/commands/list.ts`

---

### `query-parser.ts`

**Path:** `src/core/query-parser.ts`
**Lines:** 170
**Purpose:** Parses natural language query strings into `TaskFilter` objects. Recognizes priority, status, tags, projects, date ranges (overdue, due today/tomorrow/this week/next week), and arbitrary date expressions via chrono-node.
**Key Exports:**

- `ParsedQuery` -- interface: `{ filter: TaskFilter; remainingText: string }`
- `parseQuery(input: string, referenceDate?: Date): ParsedQuery`
  **Key Dependencies:**
- `chrono-node`, `TaskFilter`
  **Used By:**
- UI components (search/filter functionality)

---

## Operations

### `actions.ts`

**Path:** `src/core/actions.ts`
**Lines:** 148
**Purpose:** Factory functions that create `UndoableAction` objects for task mutations. Wraps complete, delete, update, and their bulk variants with undo/redo logic.
**Key Exports:**

- `createCompleteAction(api, task)` -- undo restores to pending
- `createDeleteAction(api, task)` -- undo re-creates the task
- `createUpdateAction(api, id, oldFields, newFields)` -- undo reverts fields
- `createBulkCompleteAction(api, tasks)` -- batch complete with undo
- `createBulkDeleteAction(api, tasks)` -- batch delete with undo
- `createBulkUpdateAction(api, tasks, newFields)` -- batch update with undo
  **Key Dependencies:**
- `UndoableAction`, `Task`, `UpdateTaskInput`
  **Used By:**
- UI components that perform undoable mutations

---

### `export.ts`

**Path:** `src/core/export.ts`
**Lines:** 74
**Purpose:** Exports task data in three formats: structured JSON (full backup), CSV (spreadsheet-compatible), and Markdown (checkbox list).
**Key Exports:**

- `ExportData` -- interface: `{ tasks, projects, tags, exportedAt, version }`
- `exportJSON(data: ExportData): string`
- `exportCSV(tasks: Task[]): string`
- `exportMarkdown(tasks: Task[]): string`
  **Key Dependencies:**
- `Task`, `Project`, `Tag` types
  **Used By:**
- UI settings/export views

---

### `import.ts`

**Path:** `src/core/import.ts`
**Lines:** 316
**Purpose:** Imports task data from multiple formats: Junban JSON exports, Todoist JSON exports, and Markdown/plain text. Provides format auto-detection and a preview step before committing imports.
**Key Exports:**

- `ImportedTask`, `ImportPreview`, `ImportResult`, `ImportFormat` -- types
- `detectFormat(content: string): ImportFormat`
- `parseJunbanJSON(json: string): ImportPreview`
- `parseTodoistJSON(json: string): ImportPreview`
- `parseTextImport(text: string): ImportPreview`
- `parseImport(content: string, format?: ImportFormat): ImportPreview`
  **Key Dependencies:**
- `zod` (schema validation), `parseTask` from `src/parser/task-parser.ts`
  **Used By:**
- UI import views

---

### `import-execution.ts`

**Path:** `src/core/import-execution.ts`
**Purpose:** Executes task imports with rollback safety. Creates needed projects/tasks for the import batch and, on the first failure, rolls back tasks/projects created during that run before returning an error result.
**Key Exports:**

- `importTasksWithRollback(services, importedTasks): Promise<ImportResult>`
  **Key Dependencies:**
- `ImportedTask` / `ImportResult` types from `import.ts`
  **Used By:**
- `src/api/tasks.ts`
- `src/ui/api/tasks.ts`

---

## Infrastructure

### `event-bus.ts`

**Path:** `src/core/event-bus.ts`
**Lines:** 66
**Purpose:** Typed publish/subscribe event bus for task lifecycle events. Listeners are called synchronously; errors in listeners are caught and logged without crashing the app.
**Key Exports:**

- `EventMap` -- maps event names to payload types: `task:create`, `task:complete`, `task:update`, `task:delete`, `task:reorder`
- `EventName`, `EventCallback<E>` -- type helpers
- `EventBus` -- class with methods: `on`, `off`, `emit`, `clear`, `listenerCount`
  **Key Dependencies:**
- `Task` type, `createLogger`
  **Used By:**
- `src/core/tasks.ts` (emits events), `src/bootstrap.ts`, `src/bootstrap-web.ts`, `src/plugins/api.ts` (plugins subscribe), plugin lifecycle

---

### `undo.ts`

**Path:** `src/core/undo.ts`
**Lines:** 67
**Purpose:** Undo/redo manager implementing the command pattern. Each mutation is wrapped as an `UndoableAction` with execute and undo methods. Stack depth is capped at 50.
**Key Exports:**

- `UndoableAction` -- interface: `{ description: string; execute(): Promise<void>; undo(): Promise<void> }`
- `UndoManager` -- class with methods: `perform`, `undo`, `redo`, `canUndo`, `canRedo`, `subscribe`
  **Key Dependencies:** None
  **Used By:**
- `src/core/actions.ts` (creates undoable actions), UI components

---

### `nudges.ts`

**Path:** `src/core/nudges.ts`
**Purpose:** Pure-logic nudge evaluation. Defines nudge types (overdue_alert, deadline_approaching, stale_tasks, empty_today, overloaded_day) and evaluates them against current task state. No I/O — takes tasks and returns applicable nudges.
**Key Exports:**

- `NudgeType` -- union type of nudge categories
- `Nudge` -- `{ id, type, title, description, priority }`
- `evaluateNudges(tasks, today)` -- returns active nudges based on task state
  **Key Dependencies:** `types.ts`
  **Used By:**
- `src/ui/hooks/useNudges.ts`

---

### `errors.ts`

**Path:** `src/core/errors.ts`
**Lines:** 21
**Purpose:** Custom error classes for domain-specific error handling: not found, validation, and storage errors.
**Key Exports:**

- `NotFoundError` -- thrown when an entity (task, project, template) is not found
- `ValidationError` -- thrown for invalid input
- `StorageError` -- thrown for storage operation failures, wraps the cause
  **Key Dependencies:** None
  **Used By:**
- `src/core/tasks.ts`, `src/core/templates.ts`, `src/storage/markdown-backend.ts`, `src/cli/commands/done.ts`, `src/cli/commands/edit.ts`

---

### `types.ts`

**Path:** `src/core/types.ts`
**Lines:** 88
**Purpose:** Central type definitions and Zod validation schemas for all core entities: tasks, projects, tags, and templates.
**Key Exports:**

- `TaskStatus` -- Zod enum: `"pending" | "completed" | "cancelled"`
- `Priority` -- Zod number 1-4, nullable
- `CreateTaskInput` / `UpdateTaskInput` -- Zod schemas for task creation/update
- `Task` -- interface (id, title, description, status, priority, dueDate, dueTime, completedAt, projectId, recurrence, parentId, remindAt, tags, children, sortOrder, createdAt, updatedAt)
- `Project` -- interface (id, name, color, icon, sortOrder, archived, createdAt)
- `Tag` -- interface (id, name, color)
- `CreateTemplateInput` / `UpdateTemplateInput` -- Zod schemas
- `TaskTemplate` -- interface (id, name, title, description, priority, tags, projectId, recurrence, sortOrder, createdAt, updatedAt)
  **Key Dependencies:**
- `zod`
  **Used By:**
- Nearly every file in the project
