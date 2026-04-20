# CLI Module Documentation

The `src/cli/` directory implements the Junban CLI companion tool. It uses Commander.js for command registration and shares the same core services as the UI through the `bootstrap()` function.

## Start Here

- Task-focused usage guide: [`../../how-to/use-cli.md`](../../how-to/use-cli.md)
- Runtime/bootstrap context: [`../../guides/ARCHITECTURE.md`](../../guides/ARCHITECTURE.md)
- Canonical docs map: [`../../README.md`](../../README.md)

---

## Architecture

The CLI bootstraps the shared application services (database, storage, task/project/tag services) through the Node compatibility facade in `src/bootstrap.ts` and then dispatches to command handlers via Commander.js. Each command handler is lazily imported for fast startup.

```
CLI Entry (index.ts)
  |-> bootstrap() -- initializes storage + services
  |-> Commander.js parses argv
  |-> Dispatches to command handler
  |-> Handler uses services (taskService, projectService, etc.)
```

The long-lived Node runtime owner in `src/backend/node-runtime.ts` is primarily for app/server/MCP plugin lifecycle coordination; the CLI keeps using `bootstrap()` directly because its commands are short-lived and do not currently own shared plugin startup/shutdown.

---

## Files

Invocation note: the examples below use the repository script form (`pnpm cli -- ...`) because that is the default contributor workflow in this repo. If you installed the CLI as `junban`, the same commands work without the `pnpm cli --` prefix.

### `index.ts`

**Path:** `src/cli/index.ts`
**Purpose:** CLI entry point. Registers all commands with Commander.js and bootstraps the application services. Each command handler is dynamically imported to minimize startup time.

**Key Exports:** None (side-effect: parses process.argv and executes commands)

**Key Dependencies:** `commander`, `bootstrap()` from `src/bootstrap.ts`

**Used By:** Invoked in-repo via `pnpm cli -- <command>` or as `junban <command>` when installed as a binary

**Registered Commands:**

- `junban add <description>` -- add a new task
- `junban list` -- list tasks with filters
- `junban done <id>` -- complete a task
- `junban edit <id>` -- edit a task
- `junban delete <id>` -- delete a task

---

### `commands/add.ts`

**Path:** `src/cli/commands/add.ts`
**Purpose:** Handles the `add` command. Parses the natural language description through `parseTask()`, resolves the project (getOrCreate), creates the task, and prints a confirmation.

**Key Exports:** `addTask(description: string, services: AppServices, options?: AddOptions)`

**Key Dependencies:** `parseTask` from `src/parser/task-parser.ts`, `AppServices` from `src/bootstrap.ts`

**Usage:**

```bash
pnpm cli -- add "buy milk tomorrow p1 #groceries"
# Output: Created: buy milk P1 #groceries due 2/21/2026 [abc12345]

pnpm cli -- add "deploy to production" --json
# Output: { "id": "...", "title": "deploy to production", ... }
```

**Options:**

- `--json` -- output the created task as JSON

---

### `commands/list.ts`

**Path:** `src/cli/commands/list.ts`
**Purpose:** Handles the `list` command. Builds a `TaskFilter` from CLI options (today, project, tag, search) and displays matching pending tasks.

**Key Exports:** `listTasks(options: ListOptions, services: AppServices)`

**Key Dependencies:** `TaskFilter`, `Task` types, `AppServices`

**Usage:**

```bash
pnpm cli -- list
# Lists all pending tasks

pnpm cli -- list --today
# Lists tasks due today

pnpm cli -- list --project work
# Lists tasks in the "work" project

pnpm cli -- list --tag urgent
# Lists tasks tagged "urgent"

pnpm cli -- list --search "deploy"
# Searches tasks by title/description

pnpm cli -- list --json
# Output as JSON array
```

**Options:**

- `--today` -- filter to tasks due today
- `--project <name>` -- filter by project name
- `--tag <name>` -- filter by tag name
- `--search <query>` -- full-text search in title/description
- `--json` -- output as JSON

---

### `commands/done.ts`

**Path:** `src/cli/commands/done.ts`
**Purpose:** Handles the `done` command. Marks a task as completed by ID. Handles `NotFoundError` gracefully.

**Key Exports:** `doneTask(id: string, services: AppServices, options?: DoneOptions)`

**Key Dependencies:** `AppServices`, `NotFoundError`

**Usage:**

```bash
pnpm cli -- done abc12345
# Output: Completed: buy milk [abc12345]

pnpm cli -- done abc12345 --json
# Output: { "id": "...", "status": "completed", ... }
```

**Options:**

- `--json` -- output the completed task as JSON

---

### `commands/edit.ts`

**Path:** `src/cli/commands/edit.ts`
**Purpose:** Handles the `edit` command. Updates task fields by ID. Due dates are parsed through the NLP module. Requires at least one update option.

**Key Exports:** `editTask(id: string, options: EditOptions, services: AppServices)`

**Key Dependencies:** `UpdateTaskInput`, `NotFoundError`, `parseDate` from `src/parser/nlp.ts`

**Usage:**

```bash
pnpm cli -- edit abc12345 --title "buy organic milk"
# Output: Updated: buy organic milk [abc12345]

pnpm cli -- edit abc12345 --priority 2
# Sets priority to P2

pnpm cli -- edit abc12345 --due "next friday"
# NLP-parsed due date

pnpm cli -- edit abc12345 --description "From the farmer's market"
```

**Options:**

- `--title <title>` -- new title
- `--priority <p>` -- new priority (1-4)
- `--due <date>` -- new due date (natural language supported)
- `--description <desc>` -- new description
- `--json` -- output as JSON

---

### `commands/delete.ts`

**Path:** `src/cli/commands/delete.ts`
**Purpose:** Handles the `delete` command. Permanently removes a task by ID.

**Key Exports:** `deleteTask(id: string, services: AppServices, options?: DeleteOptions)`

**Key Dependencies:** `AppServices`

**Usage:**

```bash
pnpm cli -- delete abc12345
# Output: Deleted: buy milk [abc12345]

pnpm cli -- delete abc12345 --json
# Output: { "deleted": true, "id": "...", "title": "buy milk" }
```

**Options:**

- `--json` -- output as JSON

---

### `formatter.ts`

**Path:** `src/cli/formatter.ts`
**Purpose:** Terminal output formatting for parsed tasks. Formats a `ParsedTask` into a human-readable summary with due date, priority, tags, and project.

**Key Exports:** `formatTaskSummary(task: ParsedTask): string`

**Key Dependencies:** `ParsedTask` from `src/parser/task-parser.ts`

**Used By:** Currently available but not directly referenced by command handlers (they format inline).
