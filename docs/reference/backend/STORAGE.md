# Storage Abstraction

The `src/storage/` directory implements Junban's dual-backend storage architecture. Both SQLite and Markdown backends implement the same `IStorage` interface, allowing the app to swap backends without changing any business logic.

## Files

| File                    | Purpose                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `interface.ts`          | `IStorage` interface + row types (`TaskRow`, `ProjectRow`, `TagRow`, etc.)  |
| `sqlite-backend.ts`     | SQLite implementation wrapping Drizzle ORM queries                          |
| `markdown-backend.ts`   | Markdown backend orchestrator with in-memory indexes                        |
| `markdown/*.ts`         | Markdown backend task/project/metadata/persistence modules                  |
| `markdown-utils.ts`     | YAML parsing/formatting helpers for the Markdown backend                    |
| `encrypted-settings.ts` | Encrypted settings wrapper for sensitive values such as API keys and tokens |

## IStorage Interface

Defined in `interface.ts`. All methods are synchronous (both backends return values directly, no promises).

### Row Types

| Type                | Key Fields                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TaskRow`           | id, title, description, status (`"pending"` / `"completed"` / `"cancelled"`), priority, dueDate, dueTime, completedAt, projectId, parentId, sectionId, recurrence, remindAt, deadline, isSomeday, estimatedMinutes, actualMinutes, dreadLevel, sortOrder, createdAt, updatedAt |
| `ProjectRow`        | id, name, color, icon, parentId, isFavorite, viewStyle (`"list"` / `"board"` / `"calendar"`), sortOrder, archived                                                                                                                                                              |
| `TagRow`            | id, name, color                                                                                                                                                                                                                                                                |
| `SectionRow`        | id, projectId, name, sortOrder, isCollapsed                                                                                                                                                                                                                                    |
| `TaskCommentRow`    | id, taskId, content                                                                                                                                                                                                                                                            |
| `TaskActivityRow`   | id, taskId, action, field, oldValue, newValue                                                                                                                                                                                                                                  |
| `TaskRelationRow`   | taskId, relatedTaskId, type (`"blocks"`)                                                                                                                                                                                                                                       |
| `DailyStatRow`      | id, date, tasksCompleted, tasksCreated, minutesTracked, streak                                                                                                                                                                                                                 |
| `TemplateRow`       | id, name, title, description, priority, tags, projectId, recurrence                                                                                                                                                                                                            |
| `ChatMessageRow`    | sessionId, role, content, toolCallId, toolCalls                                                                                                                                                                                                                                |
| `ChatSessionInfo`   | sessionId, title, createdAt, messageCount                                                                                                                                                                                                                                      |
| `PluginSettingsRow` | pluginId, settings (JSON string)                                                                                                                                                                                                                                               |
| `AppSettingRow`     | key, value                                                                                                                                                                                                                                                                     |
| `AiMemoryRow`       | id, content, category (`"preference" \| "habit" \| "context" \| "instruction" \| "pattern"`)                                                                                                                                                                                   |
| `MutationResult`    | changes (affected row count)                                                                                                                                                                                                                                                   |

### Method Groups

| Group              | Methods                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks              | `listTasks`, `listTasksByParent`, `getTask`, `insertTask`, `insertTaskWithId`, `updateTask`, `deleteTask`, `deleteManyTasks`, `updateManyTasks`, `listTasksDueForReminder` |
| Task-Tag Relations | `getTaskTags`, `getTaskTagsByTaskIds`, `listAllTaskTags`, `insertTaskTag`, `deleteTaskTags`, `deleteManyTaskTags`                                                          |
| Projects           | `listProjects`, `getProject`, `getProjectByName`, `insertProject`, `updateProject`, `deleteProject`                                                                        |
| Tags               | `listTags`, `getTagByName`, `insertTag`, `deleteTag`                                                                                                                       |
| Sections           | `listSections`, `getSection`, `insertSection`, `updateSection`, `deleteSection`                                                                                            |
| Task Comments      | `listTaskComments`, `insertTaskComment`, `updateTaskComment`, `deleteTaskComment`                                                                                          |
| Task Activity      | `listTaskActivity`, `insertTaskActivity`                                                                                                                                   |
| Task Relations     | `listTaskRelations`, `getTaskRelations`, `insertTaskRelation`, `deleteTaskRelation`, `deleteAllTaskRelations`                                                              |
| Daily Stats        | `getDailyStat`, `upsertDailyStat`, `listDailyStats`                                                                                                                        |
| Templates          | `listTemplates`, `getTemplate`, `insertTemplate`, `updateTemplate`, `deleteTemplate`                                                                                       |
| Chat               | `listChatMessages`, `insertChatMessage`, `deleteChatSession`, `getLatestSessionId`, `listChatSessions`, `renameChatSession`                                                |
| Plugin Settings    | `loadPluginSettings`, `savePluginSettings`                                                                                                                                 |
| Plugin Permissions | `getPluginPermissions`, `setPluginPermissions`, `deletePluginPermissions`                                                                                                  |
| App Settings       | `getAppSetting`, `listAllAppSettings`, `setAppSetting`, `deleteAppSetting`                                                                                                 |
| AI Memories        | `listAiMemories`, `insertAiMemory`, `updateAiMemory`, `deleteAiMemory`                                                                                                     |

## SQLite Backend

`sqlite-backend.ts` wraps the `createQueries()` function from `src/db/queries.ts`. Each IStorage method maps directly to a Drizzle query. This is the default backend and handles all complex filtering via SQL.

Recent performance-oriented additions:

- `listTasksByParent(parentId)` supports targeted child-task lookup without full task scans.
- `getTaskTagsByTaskIds(taskIds)` supports batched tag hydration for reminder and child-task flows.

## Markdown Backend

`markdown-backend.ts` stores data as `.md` files with YAML frontmatter in a directory tree:

```
<basePath>/
├── inbox/
│   └── <slug>-<idSuffix>.md
├── projects/
│   └── <project-slug>/
│       ├── _project.yaml
│       └── <slug>-<idSuffix>.md
├── _tags.yaml
├── _settings.yaml
├── _templates.yaml
├── _sections.yaml
├── _daily_stats.yaml
├── _task_relations.yaml
├── _ai_memories.json
├── _task_meta/
│   └── <taskId>.yaml
├── _plugins/
│   ├── <pluginId>.yaml
│   └── permissions.yaml
└── _chat/
    └── <sessionId>.yaml
```

Key design decisions:

- In-memory indexes for reads, disk writes on mutations
- YAML frontmatter keys sorted alphabetically for git-friendly diffs
- Uses the `yaml` package (not `js-yaml`) for parsing
- `markdown-utils.ts` handles YAML ↔ object conversion
- Task move/rename writes are fail-safe: the new file is written first, and the old file is removed only after a successful write
- Task/tag lookup helpers mirror the SQLite targeted-query surface so core services can keep the same optimized code paths across both backends

## Backend Selection

`src/bootstrap.ts` selects the backend based on the `STORAGE_MODE` environment variable:

| Value                | Backend         | Notes                                  |
| -------------------- | --------------- | -------------------------------------- |
| `"sqlite"` (default) | SQLiteBackend   | Faster queries, structured data        |
| `"markdown"`         | MarkdownBackend | Human-readable, git-friendly, portable |

`src/bootstrap-web.ts` always uses SQLite (no filesystem access in browser via sql.js WASM).

## Related

- [DATABASE.md](DATABASE.md) — Drizzle schema, tables, migrations
- [CORE.md](CORE.md) — Services that consume IStorage (TaskService, ProjectService, TagService)
