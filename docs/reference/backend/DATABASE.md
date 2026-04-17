# Database & Storage Documentation

The database layer spans two directories: `src/db/` (SQLite-specific code including Drizzle ORM schema, queries, and migrations) and `src/storage/` (the storage abstraction layer with SQLite and Markdown backends). Together they implement Junban's local-first data architecture.

Boundary note: this page is the canonical reference for schema, DB clients, queries, and migrations. Keep backend abstraction/runtime behavior details in [`STORAGE.md`](STORAGE.md) to avoid duplicated maintenance.

---

## Database Schema

Defined in `src/db/schema.ts` using Drizzle ORM. Fourteen tables:

### `tasks`

| Column              | Type              | Constraints                                                    |
| ------------------- | ----------------- | -------------------------------------------------------------- |
| `id`                | TEXT              | PRIMARY KEY                                                    |
| `title`             | TEXT              | NOT NULL                                                       |
| `description`       | TEXT              | nullable                                                       |
| `status`            | TEXT              | NOT NULL, default "pending", enum: pending/completed/cancelled |
| `priority`          | INTEGER           | nullable, 1-4                                                  |
| `due_date`          | TEXT              | nullable, ISO 8601                                             |
| `due_time`          | INTEGER (boolean) | default false                                                  |
| `completed_at`      | TEXT              | nullable, ISO 8601                                             |
| `project_id`        | TEXT              | FK -> projects.id, ON DELETE SET NULL                          |
| `recurrence`        | TEXT              | nullable                                                       |
| `parent_id`         | TEXT              | FK -> tasks.id (self-ref), ON DELETE CASCADE                   |
| `remind_at`         | TEXT              | nullable, ISO 8601                                             |
| `sort_order`        | INTEGER           | NOT NULL, default 0                                            |
| `estimated_minutes` | INTEGER           | nullable                                                       |
| `deadline`          | TEXT              | nullable, ISO 8601                                             |
| `is_someday`        | INTEGER (boolean) | NOT NULL, default false                                        |
| `section_id`        | TEXT              | FK -> sections.id, ON DELETE SET NULL                          |
| `created_at`        | TEXT              | NOT NULL, ISO 8601                                             |
| `updated_at`        | TEXT              | NOT NULL, ISO 8601                                             |

### `projects`

| Column        | Type              | Constraints                                         |
| ------------- | ----------------- | --------------------------------------------------- |
| `id`          | TEXT              | PRIMARY KEY                                         |
| `name`        | TEXT              | NOT NULL, UNIQUE                                    |
| `color`       | TEXT              | NOT NULL, default "#3b82f6"                         |
| `icon`        | TEXT              | nullable                                            |
| `parent_id`   | TEXT              | FK -> projects.id (self-ref), ON DELETE SET NULL    |
| `is_favorite` | INTEGER (boolean) | NOT NULL, default false                             |
| `view_style`  | TEXT              | NOT NULL, default "list", enum: list/board/calendar |
| `sort_order`  | INTEGER           | NOT NULL, default 0                                 |
| `archived`    | INTEGER (boolean) | NOT NULL, default false                             |
| `created_at`  | TEXT              | NOT NULL                                            |

### `tags`

| Column  | Type | Constraints                 |
| ------- | ---- | --------------------------- |
| `id`    | TEXT | PRIMARY KEY                 |
| `name`  | TEXT | NOT NULL, UNIQUE            |
| `color` | TEXT | NOT NULL, default "#6b7280" |

### `task_tags` (junction table)

| Column    | Type | Constraints                                 |
| --------- | ---- | ------------------------------------------- |
| `task_id` | TEXT | NOT NULL, FK -> tasks.id, ON DELETE CASCADE |
| `tag_id`  | TEXT | NOT NULL, FK -> tags.id, ON DELETE CASCADE  |
|           |      | PRIMARY KEY (task_id, tag_id)               |

### `task_relations` (junction table)

| Column            | Type | Constraints                                 |
| ----------------- | ---- | ------------------------------------------- |
| `task_id`         | TEXT | NOT NULL, FK -> tasks.id, ON DELETE CASCADE |
| `related_task_id` | TEXT | NOT NULL, FK -> tasks.id, ON DELETE CASCADE |
| `type`            | TEXT | NOT NULL, default "blocks", enum: blocks    |
|                   |      | PRIMARY KEY (task_id, related_task_id)      |

### `ai_memories`

| Column       | Type | Constraints                                                                     |
| ------------ | ---- | ------------------------------------------------------------------------------- |
| `id`         | TEXT | PRIMARY KEY                                                                     |
| `content`    | TEXT | NOT NULL                                                                        |
| `category`   | TEXT | NOT NULL, default "context", enum: preference/habit/context/instruction/pattern |
| `created_at` | TEXT | NOT NULL                                                                        |
| `updated_at` | TEXT | NOT NULL                                                                        |

### `plugin_settings`

| Column       | Type | Constraints            |
| ------------ | ---- | ---------------------- |
| `plugin_id`  | TEXT | PRIMARY KEY            |
| `settings`   | TEXT | NOT NULL, default "{}" |
| `updated_at` | TEXT | NOT NULL               |

### `app_settings`

| Column       | Type | Constraints |
| ------------ | ---- | ----------- |
| `key`        | TEXT | PRIMARY KEY |
| `value`      | TEXT | NOT NULL    |
| `updated_at` | TEXT | NOT NULL    |

### `task_templates`

| Column        | Type    | Constraints           |
| ------------- | ------- | --------------------- |
| `id`          | TEXT    | PRIMARY KEY           |
| `name`        | TEXT    | NOT NULL              |
| `title`       | TEXT    | NOT NULL              |
| `description` | TEXT    | nullable              |
| `priority`    | INTEGER | nullable              |
| `tags`        | TEXT    | nullable (JSON array) |
| `project_id`  | TEXT    | FK -> projects.id     |
| `recurrence`  | TEXT    | nullable              |
| `sort_order`  | INTEGER | default 0             |
| `created_at`  | TEXT    | NOT NULL              |
| `updated_at`  | TEXT    | NOT NULL              |

### `chat_messages`

| Column         | Type    | Constraints                                |
| -------------- | ------- | ------------------------------------------ |
| `id`           | INTEGER | PRIMARY KEY, auto-increment                |
| `session_id`   | TEXT    | NOT NULL                                   |
| `role`         | TEXT    | NOT NULL, enum: system/user/assistant/tool |
| `content`      | TEXT    | NOT NULL                                   |
| `tool_call_id` | TEXT    | nullable                                   |
| `tool_calls`   | TEXT    | nullable (JSON)                            |
| `created_at`   | TEXT    | NOT NULL                                   |

### `sections`

| Column         | Type              | Constraints                                    |
| -------------- | ----------------- | ---------------------------------------------- |
| `id`           | TEXT              | PRIMARY KEY                                    |
| `project_id`   | TEXT              | NOT NULL, FK -> projects.id, ON DELETE CASCADE |
| `name`         | TEXT              | NOT NULL                                       |
| `sort_order`   | INTEGER           | NOT NULL, default 0                            |
| `is_collapsed` | INTEGER (boolean) | NOT NULL, default false                        |
| `created_at`   | TEXT              | NOT NULL                                       |

### `task_comments`

| Column       | Type | Constraints                                 |
| ------------ | ---- | ------------------------------------------- |
| `id`         | TEXT | PRIMARY KEY                                 |
| `task_id`    | TEXT | NOT NULL, FK -> tasks.id, ON DELETE CASCADE |
| `content`    | TEXT | NOT NULL                                    |
| `created_at` | TEXT | NOT NULL                                    |
| `updated_at` | TEXT | NOT NULL                                    |

### `task_activity`

| Column       | Type | Constraints                                 |
| ------------ | ---- | ------------------------------------------- |
| `id`         | TEXT | PRIMARY KEY                                 |
| `task_id`    | TEXT | NOT NULL, FK -> tasks.id, ON DELETE CASCADE |
| `action`     | TEXT | NOT NULL                                    |
| `field`      | TEXT | nullable                                    |
| `old_value`  | TEXT | nullable                                    |
| `new_value`  | TEXT | nullable                                    |
| `created_at` | TEXT | NOT NULL                                    |

### `daily_stats`

| Column            | Type    | Constraints         |
| ----------------- | ------- | ------------------- |
| `id`              | TEXT    | PRIMARY KEY         |
| `date`            | TEXT    | NOT NULL, UNIQUE    |
| `tasks_completed` | INTEGER | NOT NULL, default 0 |
| `tasks_created`   | INTEGER | NOT NULL, default 0 |
| `minutes_tracked` | INTEGER | NOT NULL, default 0 |
| `streak`          | INTEGER | NOT NULL, default 0 |
| `created_at`      | TEXT    | NOT NULL            |

---

## Database Files

### `schema.ts`

**Path:** `src/db/schema.ts`
**Purpose:** Drizzle ORM table definitions. Source of truth for the database schema. All fourteen tables are defined here using `sqliteTable`.
**Key Exports:** `tasks`, `projects`, `tags`, `taskTags`, `taskRelations`, `pluginSettings`, `appSettings`, `taskTemplates`, `chatMessages`, `sections`, `taskComments`, `taskActivity`, `aiMemories`, `dailyStats` (Drizzle table objects)
**Key Dependencies:** `drizzle-orm/sqlite-core`
**Used By:** `src/db/client.ts`, `src/db/client-web.ts`, `src/db/queries.ts`, `src/storage/sqlite-backend.ts`

---

### `client.ts`

**Path:** `src/db/client.ts`
**Purpose:** Creates and caches a better-sqlite3 database connection with WAL mode and foreign keys enabled. Used in Node.js/Tauri desktop mode.
**Key Exports:** `getDb(dbPath: string): BetterSQLite3Database<typeof schema>`
**Key Dependencies:** `better-sqlite3`, `drizzle-orm/better-sqlite3`
**Used By:** `src/bootstrap.ts`, `src/db/migrate.ts`

---

### `client-web.ts`

**Path:** `src/db/client-web.ts`
**Purpose:** Creates an in-browser SQLite database using sql.js (WebAssembly). Used in web/Tauri WebView mode where filesystem access is unavailable.
**Key Exports:** `createWebDb(existingData?: Uint8Array): Promise<{ db, sqlite }>`
**Key Dependencies:** `sql.js`, `drizzle-orm/sql-js`
**Used By:** `src/bootstrap-web.ts`

---

### `queries.ts`

**Path:** `src/db/queries.ts`
**Purpose:** Query factory that creates all CRUD operations for every entity type. Returns a plain object of query functions built on top of Drizzle ORM. Covers tasks, task-tags, projects, tags, plugin settings, app settings, chat messages, plugin permissions, and task templates.
**Key Exports:**

- `createQueries(db): Queries` -- creates the full query object
- `Queries` -- the return type of `createQueries`
  **Key Dependencies:** `drizzle-orm` operators (`eq`, `desc`, `inArray`, `and`, `lte`, `isNotNull`), `schema`
  **Used By:** `src/storage/sqlite-backend.ts`

---

### `migrate.ts`

**Path:** `src/db/migrate.ts`
**Purpose:** Runs Drizzle ORM migrations from the `migrations/` directory against a better-sqlite3 database. Can be executed standalone via `pnpm db:migrate`.
**Key Exports:** `runMigrations(db: BetterSQLite3Database)`
**Key Dependencies:** `drizzle-orm/better-sqlite3/migrator`
**Used By:** `src/bootstrap.ts`

---

### `migrate-web.ts`

**Path:** `src/db/migrate-web.ts`
**Purpose:** Runs migrations in the browser by importing raw SQL strings (via Vite `?raw` imports) and executing them statement-by-statement against a sql.js database.
**Key Exports:** `runWebMigrations(sqlite: Database): void`
**Key Dependencies:** Raw SQL migration files
**Used By:** `src/bootstrap-web.ts`

---

### `persistence.ts`

**Path:** `src/db/persistence.ts`
**Purpose:** Tauri-specific file persistence for the sql.js database. Loads and saves the database binary to the Tauri AppData directory (`ASF Junban/junban.db`).
**Key Exports:**

- `loadDbFile(): Promise<Uint8Array | null>`
- `saveDbFile(data: Uint8Array): Promise<void>`
  **Key Dependencies:** `@tauri-apps/plugin-fs`
  **Used By:** `src/bootstrap-web.ts`

---

## Storage Abstraction

This section is intentionally a routing summary for storage touchpoints in database-related flows. The detailed contract and backend behavior live in [`STORAGE.md`](STORAGE.md).

### `interface.ts`

**Path:** `src/storage/interface.ts`
**Purpose:** Defines the `IStorage` interface and all row types. Both SQLite and Markdown backends implement this interface, making the storage engine interchangeable.
Storage architecture details for `src/storage/**` should be maintained in [`STORAGE.md`](STORAGE.md).
**Key Exports:**

- Row types: `TaskRow`, `ProjectRow`, `TagRow`, `TaskTagJoin`, `PluginSettingsRow`, `AppSettingRow`, `ChatMessageRow`, `ChatSessionInfo`, `TemplateRow`, `SectionRow`, `TaskCommentRow`, `TaskActivityRow`, `TaskRelationRow`, `DailyStatRow`, `AiMemoryRow`
- `MutationResult` -- `{ changes: number }`
- `IStorage` -- the complete storage interface with methods for tasks (10 methods), task-tags (6), projects (6), tags (4), plugin settings (2), app settings (4), chat messages (6), plugin permissions (3), task templates (5), sections (5), task comments (4), task activity (2), task relations (5), daily stats (3), ai memories (4)
  **Key Dependencies:** None (pure types)
  **Used By:** Every service class in `src/core/`, `src/plugins/`, `src/ai/chat.ts`, `src/bootstrap.ts`, `src/bootstrap-web.ts`

---

### `sqlite-backend.ts`

**Path:** `src/storage/sqlite-backend.ts`
**Purpose:** SQLite storage backend. Thin adapter that wraps `createQueries()` and satisfies the `IStorage` interface. Delegates all operations to the Drizzle-based query layer.
**Key Exports:** `SQLiteBackend` -- class implementing `IStorage`
**Key Dependencies:** `createQueries` from `src/db/queries.ts`, `IStorage` and row types from `src/storage/interface.ts`
**Used By:** `src/bootstrap.ts`, `src/bootstrap-web.ts`

---

### `markdown-backend.ts`

**Path:** `src/storage/markdown-backend.ts`
**Purpose:** Markdown storage backend. Stores tasks as `.md` files with YAML frontmatter in a directory structure: `inbox/` for unassigned tasks, `projects/<project-slug>/` for project tasks. Reads are served from in-memory indexes; writes update both index and disk. Also stores tags in `_tags.yaml`, settings in `_settings.yaml`, templates in `_templates.yaml`, plugin data in `_plugins/`, and chat history in `_chat/`.
**Key Exports:** `MarkdownBackend` -- class implementing `IStorage`
**Key Dependencies:** `node:fs`, `node:path`, `yaml`, `parseTaskFile`/`serializeTaskFile` from `markdown-utils.ts`, `StorageError`
**Used By:** `src/bootstrap.ts` (when `STORAGE_MODE=markdown`)

### Directory Structure (Markdown Mode)

```
<basePath>/
  inbox/              -- tasks without a project
    <slug>-<id>.md
  projects/
    <project-slug>/
      _project.yaml   -- project metadata
      <slug>-<id>.md  -- project tasks
  _tags.yaml          -- all tags
  _settings.yaml      -- app settings
  _templates.yaml     -- task templates
  _sections.yaml      -- sections metadata
  _daily_stats.yaml   -- daily statistics
  _task_relations.yaml -- task dependency graph
  _ai_memories.json   -- persisted AI memories
  _task_meta/
    <taskId>.yaml     -- task comments and task activity
  _plugins/
    <pluginId>.yaml   -- plugin settings
    permissions.yaml  -- plugin permissions
  _chat/
    <sessionId>.yaml  -- chat history
```

---

### `markdown-utils.ts`

**Path:** `src/storage/markdown-utils.ts`
**Purpose:** Utility functions for the Markdown backend: YAML frontmatter parsing/serialization, string slugification, task filename generation, and bidirectional task file conversion.
**Key Exports:**

- `parseFrontmatter(content: string): { frontmatter, body }`
- `serializeFrontmatter(frontmatter, body): string`
- `slugify(str: string): string`
- `taskFilename(title: string, id: string): string`
- `parseTaskFile(content: string, projectId: string | null): { task, tagNames }`
- `serializeTaskFile(task, title, description, tagNames): string`
  **Key Dependencies:** `yaml`
  **Used By:** `src/storage/markdown-backend.ts`

---

## Migration System

Migrations are stored as SQL files in `src/db/migrations/`. Two migration approaches exist:

1. **Node.js (desktop/CLI):** `migrate.ts` uses Drizzle's built-in migrator to scan the `migrations/` folder.
2. **Browser (web/Tauri):** `migrate-web.ts` imports SQL files as raw strings via Vite and executes them directly against sql.js.

Both approaches apply the same SQL migrations to maintain schema consistency across environments.

---

## See Also

- [STORAGE.md](STORAGE.md) — Concise reference for the IStorage interface and backend selection
