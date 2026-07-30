//! Forward SQLite schema migrations for a single profile connection.

use jiff::Timestamp;
use rusqlite::{Connection, Transaction, TransactionBehavior};

/// Highest schema version applied by this crate.
pub(crate) const CURRENT_SCHEMA_VERSION: i64 = 2;

const V1_SCHEMA: &str = "
CREATE TABLE app_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    global_revision INTEGER NOT NULL CHECK (global_revision >= 0)
);
INSERT INTO app_state(singleton, global_revision) VALUES (1, 0);
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    due_date TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0)
);
CREATE TABLE operation_receipts (
    operation_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    response_json TEXT NOT NULL
);
CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    revision INTEGER NOT NULL UNIQUE,
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    task_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE events (
    revision INTEGER PRIMARY KEY,
    event_type TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_json TEXT,
    occurred_at TEXT NOT NULL
);
";

/// Apply all pending forward migrations. Fresh profiles receive v1 then v2.
pub(crate) fn migrate(connection: &mut Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );",
    )?;

    let current = current_version(connection)?;
    if current > CURRENT_SCHEMA_VERSION {
        return Err(unsupported_schema(current));
    }
    if current < 1 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        apply_v1(&transaction)?;
        record_version(&transaction, 1)?;
        transaction.commit()?;
    }

    let current = current_version(connection)?;
    if current < 2 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        apply_v2(&transaction)?;
        assert_foreign_keys_clean(&transaction)?;
        record_version(&transaction, 2)?;
        transaction.commit()?;
    }

    let applied = current_version(connection)?;
    if applied < CURRENT_SCHEMA_VERSION {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::Unknown,
                extended_code: 1,
            },
            Some(format!(
                "schema migration incomplete: at version {applied}, expected {CURRENT_SCHEMA_VERSION}"
            )),
        ));
    }

    Ok(())
}

fn unsupported_schema(version: i64) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error {
            code: rusqlite::ErrorCode::Unknown,
            extended_code: 1,
        },
        Some(format!(
            "profile schema version {version} is newer than supported version {CURRENT_SCHEMA_VERSION}"
        )),
    )
}

fn current_version(connection: &Connection) -> rusqlite::Result<i64> {
    connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )
}

fn record_version(transaction: &Transaction<'_>, version: i64) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
        rusqlite::params![version, Timestamp::now().to_string()],
    )?;
    Ok(())
}

fn apply_v1(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    transaction.execute_batch(V1_SCHEMA)
}

/// Rebuild tasks and add the full Phase 2 organization graph inside one transaction.
fn apply_v2(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    // Catalog tables first so rebuilt tasks can reference them with FKs enabled.
    transaction.execute_batch(
        "
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    icon TEXT,
    parent_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    view_style TEXT NOT NULL DEFAULT 'list'
        CHECK (view_style IN ('list', 'board', 'calendar')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (parent_id IS NULL OR parent_id != id)
);
CREATE INDEX idx_projects_parent ON projects(parent_id);
CREATE INDEX idx_projects_sort ON projects(sort_order, id);

CREATE TABLE sections (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_sections_project_sort ON sections(project_id, sort_order, id);

CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_normalized TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
",
    )?;

    // SQLite cannot widen the status CHECK in place; rebuild the table.
    transaction.execute_batch(
        "
CREATE TABLE tasks_new (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    due_time TEXT,
    due_timezone TEXT,
    deadline TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled')),
    priority INTEGER CHECK (priority IS NULL OR (priority BETWEEN 1 AND 4)),
    dread INTEGER CHECK (dread IS NULL OR (dread BETWEEN 0 AND 5)),
    estimated_minutes INTEGER CHECK (
        estimated_minutes IS NULL OR estimated_minutes > 0
    ),
    actual_minutes INTEGER CHECK (
        actual_minutes IS NULL OR actual_minutes >= 0
    ),
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    section_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
    parent_id TEXT REFERENCES tasks_new(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    recurrence_rule TEXT,
    someday INTEGER NOT NULL DEFAULT 0 CHECK (someday IN (0, 1)),
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    CHECK (
        (status = 'completed' AND completed_at IS NOT NULL)
        OR (status != 'completed' AND completed_at IS NULL)
    ),
    CHECK (
        (due_time IS NULL AND due_timezone IS NULL)
        OR (
            due_time IS NOT NULL
            AND due_timezone IS NOT NULL
            AND due_date IS NOT NULL
        )
    ),
    CHECK (parent_id IS NULL OR parent_id != id)
);

INSERT INTO tasks_new (
    id, title, description, due_date, due_time, due_timezone, deadline,
    status, priority, dread, estimated_minutes, actual_minutes,
    project_id, section_id, parent_id, sort_order, recurrence_rule, someday,
    completed_at, created_at, updated_at, revision
)
SELECT
    id, title, '', due_date, NULL, NULL, NULL,
    status, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, 0, NULL, 0,
    completed_at, created_at, updated_at, revision
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX idx_tasks_project_sort ON tasks(project_id, sort_order, id);
CREATE INDEX idx_tasks_section_sort ON tasks(section_id, sort_order, id);
CREATE INDEX idx_tasks_parent_sort ON tasks(parent_id, sort_order, id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);
CREATE INDEX idx_tasks_created ON tasks(created_at, id);
",
    )?;

    transaction.execute_batch(
        "
CREATE TABLE task_tags (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, tag_id)
);
CREATE INDEX idx_task_tags_tag ON task_tags(tag_id);

CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority INTEGER CHECK (priority IS NULL OR (priority BETWEEN 1 AND 4)),
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    recurrence_rule TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_templates_sort ON templates(sort_order, id);

CREATE TABLE template_tags (
    template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (template_id, tag_id)
);
CREATE INDEX idx_template_tags_tag ON template_tags(tag_id);

CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_comments_task ON comments(task_id, created_at, id);

CREATE TABLE task_relations (
    from_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    to_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('blocks')),
    PRIMARY KEY (from_task_id, to_task_id, kind),
    CHECK (from_task_id != to_task_id)
);
CREATE INDEX idx_task_relations_to ON task_relations(to_task_id);

CREATE TABLE saved_filters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_saved_filters_sort ON saved_filters(sort_order, id);

-- Field-level history retains task_id after the task row is deleted (no FK).
CREATE TABLE task_activity (
    revision INTEGER NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    operation_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
        'created', 'updated', 'completed', 'uncompleted', 'cancelled',
        'reopened', 'deleted', 'restored'
    )),
    field TEXT,
    old_value TEXT,
    new_value TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (revision, sequence)
);
CREATE INDEX idx_task_activity_task ON task_activity(task_id, revision, sequence);

INSERT INTO task_activity(
    revision, sequence, operation_id, task_id, action, field,
    old_value, new_value, created_at
)
SELECT
    revision,
    0,
    operation_id,
    task_id,
    CASE kind
        WHEN 'task.created' THEN 'created'
        WHEN 'task.replaced' THEN 'updated'
        WHEN 'task.completed' THEN 'completed'
        WHEN 'task.uncompleted' THEN 'uncompleted'
        WHEN 'task.deleted' THEN 'deleted'
    END,
    NULL,
    NULL,
    NULL,
    created_at
FROM activity;

CREATE TABLE activity_v2 (
    revision INTEGER PRIMARY KEY CHECK (revision > 0),
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject_type TEXT,
    subject_id TEXT,
    created_at TEXT NOT NULL,
    CHECK (
        (subject_type IS NULL AND subject_id IS NULL)
        OR (subject_type IS NOT NULL AND subject_id IS NOT NULL)
    )
);
INSERT INTO activity_v2(
    revision, operation_id, kind, subject_type, subject_id, created_at
)
SELECT revision, operation_id, kind, 'task', task_id, created_at
FROM activity;
DROP TABLE activity;
ALTER TABLE activity_v2 RENAME TO activity;
",
    )?;

    migrate_events_to_envelope(transaction)?;

    // Extend receipts for retention metadata without rewriting request/response bodies.
    // Migrated v1 rows keep NULL timestamps; later writers supply both together.
    transaction.execute_batch(
        "
CREATE TABLE operation_receipts_new (
    operation_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT,
    expires_at TEXT,
    CHECK (
        (created_at IS NULL AND expires_at IS NULL)
        OR (created_at IS NOT NULL AND expires_at IS NOT NULL)
    )
);
INSERT INTO operation_receipts_new(
    operation_id, request_json, response_json, created_at, expires_at
)
SELECT operation_id, request_json, response_json, NULL, NULL
FROM operation_receipts;
DROP TABLE operation_receipts;
ALTER TABLE operation_receipts_new RENAME TO operation_receipts;
CREATE INDEX idx_operation_receipts_expires ON operation_receipts(expires_at);

-- Durable undo authority keyed by the source mutation receipt. Optional:
-- existing v1 receipts have no undo row.
CREATE TABLE operation_undo (
    source_operation_id TEXT PRIMARY KEY
        REFERENCES operation_receipts(operation_id) ON DELETE CASCADE,
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    inverse_json TEXT NOT NULL,
    post_image_json TEXT NOT NULL,
    undone_by_operation_id TEXT UNIQUE
        REFERENCES operation_receipts(operation_id) ON DELETE RESTRICT,
    undone_at TEXT,
    CHECK (
        (undone_by_operation_id IS NULL AND undone_at IS NULL)
        OR (undone_by_operation_id IS NOT NULL AND undone_at IS NOT NULL)
    )
);
CREATE INDEX idx_operation_undo_revision ON operation_undo(source_revision);
",
    )?;

    Ok(())
}

/// Rebuild `events` into one typed JSON envelope per revision.
fn migrate_events_to_envelope(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    transaction.execute_batch(
        "CREATE TABLE events_new (
            revision INTEGER PRIMARY KEY CHECK (revision > 0),
            event_type TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            event_json TEXT NOT NULL,
            occurred_at TEXT NOT NULL
        );",
    )?;

    {
        let mut statement = transaction.prepare(
            "SELECT revision, event_type, operation_id, task_id, task_json, occurred_at
             FROM events ORDER BY revision",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;

        for row in rows {
            let (revision, event_type, operation_id, task_id, task_json, occurred_at) = row?;
            let snapshot = match task_json.as_deref() {
                Some(raw) if !raw.is_empty() => {
                    let task_value: serde_json::Value =
                        serde_json::from_str(raw).map_err(|error| {
                            rusqlite::Error::ToSqlConversionFailure(Box::new(error))
                        })?;
                    Some(serde_json::json!({
                        "resource_type": "task",
                        "task": task_value,
                    }))
                }
                _ => None,
            };
            let envelope = serde_json::json!({
                "revision": revision,
                "operation_id": operation_id.as_str(),
                "event_type": event_type.as_str(),
                "occurred_at": occurred_at.as_str(),
                "primary": {
                    "resource_type": "task",
                    "id": task_id.as_str(),
                },
                "snapshot": snapshot,
                "affected": {
                    "task_ids": [task_id.as_str()],
                },
                "resync": {
                    "tasks": false,
                    "catalog": false,
                },
            });
            let event_json = serde_json::to_string(&envelope)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            transaction.execute(
                "INSERT INTO events_new(
                    revision, event_type, operation_id, event_json, occurred_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    revision,
                    event_type.as_str(),
                    operation_id.as_str(),
                    event_json,
                    occurred_at.as_str()
                ],
            )?;
        }
    }

    transaction.execute_batch(
        "DROP TABLE events;
         ALTER TABLE events_new RENAME TO events;",
    )?;
    Ok(())
}

fn assert_foreign_keys_clean(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA foreign_key_check")?;
    let mut rows = statement.query([])?;
    if let Some(row) = rows.next()? {
        let table: String = row.get(0)?;
        let rowid: i64 = row.get(1)?;
        let parent: String = row.get(2)?;
        let fkid: i64 = row.get(3)?;
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::ConstraintViolation,
                extended_code: 787,
            },
            Some(format!(
                "foreign_key_check failed: table={table} rowid={rowid} parent={parent} fkid={fkid}"
            )),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashSet,
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TestDb {
        path: PathBuf,
        _dir: PathBuf,
    }

    impl TestDb {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "junban-migration-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&dir).unwrap();
            let path = dir.join("junban.sqlite3");
            Self { path, _dir: dir }
        }

        fn open(&self) -> Connection {
            let connection = Connection::open(&self.path).unwrap();
            connection
                .pragma_update(None, "foreign_keys", true)
                .unwrap();
            connection
        }
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self._dir);
        }
    }

    fn seed_v1_with_sample_rows(connection: &mut Connection) {
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at TEXT NOT NULL
                );",
            )
            .unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        apply_v1(&transaction).unwrap();
        record_version(&transaction, 1).unwrap();
        transaction
            .execute(
                "INSERT INTO tasks(
                    id, title, due_date, status, completed_at, created_at, updated_at, revision
                ) VALUES (
                    '11111111-1111-7111-8111-111111111111',
                    'Legacy task',
                    '2026-07-28',
                    'pending',
                    NULL,
                    '2026-07-28T12:00:00Z',
                    '2026-07-28T12:00:00Z',
                    1
                )",
                [],
            )
            .unwrap();
        transaction
            .execute(
                "UPDATE app_state SET global_revision = 1 WHERE singleton = 1",
                [],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO operation_receipts(operation_id, request_json, response_json)
                 VALUES (
                    '22222222-2222-7222-8222-222222222222',
                    '{\"action\":\"create\"}',
                    '{\"ok\":true}'
                 )",
                [],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO activity(revision, operation_id, kind, task_id, created_at)
                 VALUES (
                    1,
                    '22222222-2222-7222-8222-222222222222',
                    'task.created',
                    '11111111-1111-7111-8111-111111111111',
                    '2026-07-28T12:00:00Z'
                 )",
                [],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO events(
                    revision, event_type, operation_id, task_id, task_json, occurred_at
                ) VALUES (
                    1,
                    'task.created',
                    '22222222-2222-7222-8222-222222222222',
                    '11111111-1111-7111-8111-111111111111',
                    '{\"id\":\"11111111-1111-7111-8111-111111111111\"}',
                    '2026-07-28T12:00:00Z'
                 )",
                [],
            )
            .unwrap();
        transaction.commit().unwrap();
    }

    fn table_names(connection: &Connection) -> HashSet<String> {
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    }

    fn task_columns(connection: &Connection) -> Vec<String> {
        let mut statement = connection.prepare("PRAGMA table_info(tasks)").unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    }

    #[test]
    fn future_schema_version_is_rejected_without_mutation() {
        let db = TestDb::new();
        let mut connection = db.open();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at TEXT NOT NULL
                 );
                 INSERT INTO schema_migrations(version, applied_at)
                 VALUES (99, '2026-07-28T12:00:00Z');
                 CREATE TABLE future_sentinel(value TEXT NOT NULL);
                 INSERT INTO future_sentinel(value) VALUES ('untouched');",
            )
            .unwrap();

        let error = migrate(&mut connection).unwrap_err().to_string();
        assert!(error.contains("newer than supported"));
        assert_eq!(current_version(&connection).unwrap(), 99);
        let sentinel: String = connection
            .query_row("SELECT value FROM future_sentinel", [], |row| row.get(0))
            .unwrap();
        assert_eq!(sentinel, "untouched");
    }

    #[test]
    fn fresh_migrate_reaches_schema_v2_with_expected_tables() {
        let db = TestDb::new();
        let mut connection = db.open();
        migrate(&mut connection).unwrap();

        assert_eq!(current_version(&connection).unwrap(), 2);
        let tables = table_names(&connection);
        for name in [
            "app_state",
            "schema_migrations",
            "tasks",
            "operation_receipts",
            "activity",
            "events",
            "projects",
            "sections",
            "tags",
            "task_tags",
            "templates",
            "template_tags",
            "comments",
            "task_relations",
            "saved_filters",
            "task_activity",
            "operation_undo",
        ] {
            assert!(tables.contains(name), "missing table {name}");
        }

        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);

        let receipt_columns: HashSet<_> = table_columns(&connection, "operation_receipts")
            .into_iter()
            .collect();
        for required in [
            "operation_id",
            "request_json",
            "response_json",
            "created_at",
            "expires_at",
        ] {
            assert!(
                receipt_columns.contains(required),
                "missing receipt column {required}"
            );
        }

        let undo_columns: HashSet<_> = table_columns(&connection, "operation_undo")
            .into_iter()
            .collect();
        for required in [
            "source_operation_id",
            "source_revision",
            "inverse_json",
            "post_image_json",
            "undone_by_operation_id",
            "undone_at",
        ] {
            assert!(
                undo_columns.contains(required),
                "missing undo column {required}"
            );
        }

        let project_columns: HashSet<_> =
            table_columns(&connection, "projects").into_iter().collect();
        assert!(!project_columns.contains("description"));
        let tag_columns: HashSet<_> = table_columns(&connection, "tags").into_iter().collect();
        assert!(!tag_columns.contains("sort_order"));

        let columns: HashSet<_> = task_columns(&connection).into_iter().collect();
        for required in [
            "id",
            "title",
            "description",
            "due_date",
            "due_time",
            "due_timezone",
            "deadline",
            "status",
            "priority",
            "dread",
            "estimated_minutes",
            "actual_minutes",
            "project_id",
            "section_id",
            "parent_id",
            "sort_order",
            "recurrence_rule",
            "someday",
            "completed_at",
            "created_at",
            "updated_at",
            "revision",
        ] {
            assert!(columns.contains(required), "missing column {required}");
        }
    }

    #[test]
    fn v1_fixture_migrates_and_preserves_task_receipt_activity_event() {
        let db = TestDb::new();
        {
            let mut connection = db.open();
            seed_v1_with_sample_rows(&mut connection);
            assert_eq!(current_version(&connection).unwrap(), 1);
            migrate(&mut connection).unwrap();
            assert_eq!(current_version(&connection).unwrap(), 2);

            let title: String = connection
                .query_row(
                    "SELECT title FROM tasks WHERE id = ?1",
                    ["11111111-1111-7111-8111-111111111111"],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(title, "Legacy task");

            let description: String = connection
                .query_row(
                    "SELECT description FROM tasks WHERE id = ?1",
                    ["11111111-1111-7111-8111-111111111111"],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(description, "");

            let someday: i64 = connection
                .query_row(
                    "SELECT someday FROM tasks WHERE id = ?1",
                    ["11111111-1111-7111-8111-111111111111"],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(someday, 0);

            let (request, response, created_at, expires_at): (
                String,
                String,
                Option<String>,
                Option<String>,
            ) = connection
                .query_row(
                    "SELECT request_json, response_json, created_at, expires_at
                     FROM operation_receipts WHERE operation_id = ?1",
                    ["22222222-2222-7222-8222-222222222222"],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap();
            assert_eq!(request, "{\"action\":\"create\"}");
            assert_eq!(response, "{\"ok\":true}");
            assert_eq!(created_at, None);
            assert_eq!(expires_at, None);

            let undo_rows: i64 = connection
                .query_row("SELECT COUNT(*) FROM operation_undo", [], |row| row.get(0))
                .unwrap();
            assert_eq!(undo_rows, 0);

            let (summary_kind, summary_subject): (String, String) = connection
                .query_row(
                    "SELECT kind, subject_id FROM activity WHERE revision = 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(summary_kind, "task.created");
            assert_eq!(summary_subject, "11111111-1111-7111-8111-111111111111");

            let (activity_action, activity_operation): (String, String) = connection
                .query_row(
                    "SELECT action, operation_id FROM task_activity WHERE revision = 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(activity_action, "created");
            assert_eq!(activity_operation, "22222222-2222-7222-8222-222222222222");

            let (event_type, event_json): (String, String) = connection
                .query_row(
                    "SELECT event_type, event_json FROM events WHERE revision = 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(event_type, "task.created");
            assert!(event_json.contains("task.created"));
            assert!(event_json.contains("11111111-1111-7111-8111-111111111111"));

            let revision: i64 = connection
                .query_row(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(revision, 1);
        }
    }

    #[test]
    fn failed_v2_rolls_back_to_usable_v1_and_retry_succeeds() {
        let db = TestDb::new();
        let mut connection = db.open();
        seed_v1_with_sample_rows(&mut connection);

        // Collision with a table created after the tasks rebuild.
        connection
            .execute_batch("CREATE TABLE comments (id TEXT PRIMARY KEY);")
            .unwrap();

        let err = migrate(&mut connection).unwrap_err();
        assert!(
            err.to_string().contains("comments")
                || matches!(err, rusqlite::Error::SqliteFailure(..)),
            "unexpected error: {err}"
        );

        assert_eq!(current_version(&connection).unwrap(), 1);
        assert_eq!(
            task_columns(&connection),
            vec![
                "id".to_owned(),
                "title".to_owned(),
                "due_date".to_owned(),
                "status".to_owned(),
                "completed_at".to_owned(),
                "created_at".to_owned(),
                "updated_at".to_owned(),
                "revision".to_owned(),
            ]
        );
        let title: String = connection
            .query_row(
                "SELECT title FROM tasks WHERE id = ?1",
                ["11111111-1111-7111-8111-111111111111"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Legacy task");
        assert!(!table_names(&connection).contains("projects"));
        assert!(!table_names(&connection).contains("operation_undo"));
        // Receipt body survives the failed attempt unchanged.
        let receipt_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM operation_receipts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(receipt_count, 1);

        connection.execute_batch("DROP TABLE comments;").unwrap();
        migrate(&mut connection).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 2);
        assert!(table_names(&connection).contains("projects"));
        assert!(table_names(&connection).contains("operation_undo"));
        let title: String = connection
            .query_row(
                "SELECT title FROM tasks WHERE id = ?1",
                ["11111111-1111-7111-8111-111111111111"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Legacy task");
        let response: String = connection
            .query_row(
                "SELECT response_json FROM operation_receipts WHERE operation_id = ?1",
                ["22222222-2222-7222-8222-222222222222"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(response, "{\"ok\":true}");
    }

    #[test]
    fn schema_rejects_self_parent_self_relation_bounds_and_due_pair() {
        let db = TestDb::new();
        let mut connection = db.open();
        migrate(&mut connection).unwrap();

        connection
            .execute(
                "INSERT INTO tasks(
                    id, title, status, created_at, updated_at, revision
                ) VALUES (
                    'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
                    'Root',
                    'pending',
                    '2026-07-28T12:00:00Z',
                    '2026-07-28T12:00:00Z',
                    1
                )",
                [],
            )
            .unwrap();

        let self_parent = connection.execute(
            "INSERT INTO tasks(
                id, title, status, parent_id, created_at, updated_at, revision
            ) VALUES (
                'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
                'Bad parent',
                'pending',
                'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
                '2026-07-28T12:00:00Z',
                '2026-07-28T12:00:00Z',
                1
            )",
            [],
        );
        assert!(self_parent.is_err());

        let self_relation = connection.execute(
            "INSERT INTO task_relations(from_task_id, to_task_id, kind)
             VALUES (
                'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
                'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
                'blocks'
             )",
            [],
        );
        assert!(self_relation.is_err());

        let bad_priority = connection.execute(
            "UPDATE tasks SET priority = 5 WHERE id = ?1",
            ["aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"],
        );
        assert!(bad_priority.is_err());

        let bad_dread = connection.execute(
            "UPDATE tasks SET dread = 6 WHERE id = ?1",
            ["aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"],
        );
        assert!(bad_dread.is_err());

        let bad_estimated = connection.execute(
            "UPDATE tasks SET estimated_minutes = 0 WHERE id = ?1",
            ["aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"],
        );
        assert!(bad_estimated.is_err());

        let bad_actual = connection.execute(
            "UPDATE tasks SET actual_minutes = -1 WHERE id = ?1",
            ["aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"],
        );
        assert!(bad_actual.is_err());

        let bad_status = connection.execute(
            "UPDATE tasks SET status = 'archived' WHERE id = ?1",
            ["aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"],
        );
        assert!(bad_status.is_err());

        let completed_without_timestamp = connection.execute(
            "UPDATE tasks SET status = 'completed' WHERE id = ?1",
            ["aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"],
        );
        assert!(completed_without_timestamp.is_err());

        let pending_with_timestamp = connection.execute(
            "UPDATE tasks SET completed_at = '2026-07-28T12:00:00Z' WHERE id = ?1",
            ["aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"],
        );
        assert!(pending_with_timestamp.is_err());

        let due_time_without_date = connection.execute(
            "UPDATE tasks SET due_time = '09:00:00', due_timezone = 'UTC' WHERE id = ?1",
            ["aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"],
        );
        assert!(due_time_without_date.is_err());

        let due_time_without_zone = connection.execute(
            "UPDATE tasks SET due_date = '2026-07-28', due_time = '09:00:00' WHERE id = ?1",
            ["aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"],
        );
        assert!(due_time_without_zone.is_err());

        connection
            .execute(
                "UPDATE tasks
                 SET due_date = '2026-07-28', due_time = '09:00:00', due_timezone = 'UTC'
                 WHERE id = ?1",
                ["aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"],
            )
            .unwrap();

        connection
            .execute(
                "INSERT INTO tags(id, name, name_normalized, color, created_at, updated_at)
                 VALUES (
                    'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
                    'Work',
                    'work',
                    '#112233',
                    '2026-07-28T12:00:00Z',
                    '2026-07-28T12:00:00Z'
                 )",
                [],
            )
            .unwrap();
        let duplicate_normalized = connection.execute(
            "INSERT INTO tags(id, name, name_normalized, color, created_at, updated_at)
             VALUES (
                'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
                'WORK',
                'work',
                '#445566',
                '2026-07-28T12:00:00Z',
                '2026-07-28T12:00:00Z'
             )",
            [],
        );
        assert!(duplicate_normalized.is_err());
    }

    #[test]
    fn documented_cascades_and_set_null_hold() {
        let db = TestDb::new();
        let mut connection = db.open();
        migrate(&mut connection).unwrap();

        connection
            .execute_batch(
                "
INSERT INTO projects(id, name, color, created_at, updated_at) VALUES
    ('p1', 'Parent', '#111111', '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z'),
    ('p2', 'Child', '#222222', '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z');
UPDATE projects SET parent_id = 'p1' WHERE id = 'p2';

INSERT INTO sections(id, project_id, name, created_at, updated_at) VALUES
    ('s1', 'p1', 'Section', '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z');

INSERT INTO tags(id, name, name_normalized, color, created_at, updated_at) VALUES
    ('g1', 'Tag', 'tag', '#333333', '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z');

INSERT INTO tasks(
    id, title, status, project_id, section_id, parent_id, created_at, updated_at, revision
) VALUES
    ('t1', 'Parent task', 'pending', 'p1', 's1', NULL,
     '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z', 1),
    ('t2', 'Child task', 'pending', 'p1', 's1', 't1',
     '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z', 1);

INSERT INTO task_tags(task_id, tag_id) VALUES ('t1', 'g1');
INSERT INTO comments(id, task_id, content, created_at, updated_at) VALUES
    ('c1', 't1', 'hello', '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z');
INSERT INTO task_relations(from_task_id, to_task_id, kind) VALUES ('t1', 't2', 'blocks');
INSERT INTO task_activity(
    revision, sequence, operation_id, task_id, action, created_at
) VALUES
    (1, 0, 'op-t1', 't1', 'created', '2026-07-28T12:00:00Z');
",
            )
            .unwrap();

        // Child project self-parent RESTRICT blocks deleting a still-referenced parent.
        let blocked = connection.execute("DELETE FROM projects WHERE id = 'p1'", []);
        assert!(blocked.is_err());

        // Reparent then delete project: sections cascade; task project/section null out.
        connection
            .execute("UPDATE projects SET parent_id = NULL WHERE id = 'p2'", [])
            .unwrap();
        connection
            .execute("DELETE FROM projects WHERE id = 'p1'", [])
            .unwrap();

        let section_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM sections WHERE id = 's1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(section_count, 0);

        let (project_id, section_id): (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT project_id, section_id FROM tasks WHERE id = 't1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(project_id, None);
        assert_eq!(section_id, None);

        // Deleting a parent task nulls child parent_id and cascades owned rows.
        connection
            .execute("DELETE FROM tasks WHERE id = 't1'", [])
            .unwrap();
        let child_parent: Option<String> = connection
            .query_row("SELECT parent_id FROM tasks WHERE id = 't2'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(child_parent, None);

        let tag_links: i64 = connection
            .query_row("SELECT COUNT(*) FROM task_tags", [], |row| row.get(0))
            .unwrap();
        let comments: i64 = connection
            .query_row("SELECT COUNT(*) FROM comments", [], |row| row.get(0))
            .unwrap();
        let relations: i64 = connection
            .query_row("SELECT COUNT(*) FROM task_relations", [], |row| row.get(0))
            .unwrap();
        assert_eq!((tag_links, comments, relations), (0, 0, 0));

        // task_activity retains the deleted task_id.
        let activity_task: String = connection
            .query_row(
                "SELECT task_id FROM task_activity WHERE revision = 1 AND sequence = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(activity_task, "t1");

        // Tag uniqueness already covered; project child remains.
        let child_project: i64 = connection
            .query_row("SELECT COUNT(*) FROM projects WHERE id = 'p2'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(child_project, 1);

        // Section delete nulls task section while leaving project membership.
        connection
            .execute(
                "INSERT INTO projects(id, name, color, created_at, updated_at) VALUES
                 ('p3', 'Keep', '#444444', '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sections(id, project_id, name, created_at, updated_at) VALUES
                 ('s2', 'p3', 'Temp', '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE tasks SET project_id = 'p3', section_id = 's2' WHERE id = 't2'",
                [],
            )
            .unwrap();
        connection
            .execute("DELETE FROM sections WHERE id = 's2'", [])
            .unwrap();
        let (project_id, section_id): (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT project_id, section_id FROM tasks WHERE id = 't2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(project_id.as_deref(), Some("p3"));
        assert_eq!(section_id, None);
    }

    #[test]
    fn receipt_retention_and_operation_undo_constraints() {
        let db = TestDb::new();
        let mut connection = db.open();
        migrate(&mut connection).unwrap();

        connection
            .execute(
                "INSERT INTO operation_receipts(operation_id, request_json, response_json)
                 VALUES ('op-source', '{\"a\":1}', '{\"b\":2}')",
                [],
            )
            .unwrap();

        // Migrated-style NULL pair is allowed; half-filled retention timestamps are not.
        let half_created = connection.execute(
            "UPDATE operation_receipts SET created_at = '2026-07-28T12:00:00Z'
             WHERE operation_id = 'op-source'",
            [],
        );
        assert!(half_created.is_err());

        connection
            .execute(
                "UPDATE operation_receipts
                 SET created_at = '2026-07-28T12:00:00Z',
                     expires_at = '2026-08-27T12:00:00Z'
                 WHERE operation_id = 'op-source'",
                [],
            )
            .unwrap();

        // Undo rows require an existing source receipt.
        let orphan_undo = connection.execute(
            "INSERT INTO operation_undo(
                source_operation_id, source_revision, inverse_json, post_image_json
             ) VALUES ('missing', 1, '{\"inverse\":true}', '{\"post\":true}')",
            [],
        );
        assert!(orphan_undo.is_err());

        connection
            .execute(
                "INSERT INTO operation_undo(
                    source_operation_id, source_revision, inverse_json, post_image_json
                 ) VALUES ('op-source', 1, '{\"inverse\":true}', '{\"post\":true}')",
                [],
            )
            .unwrap();

        let bad_revision = connection.execute(
            "UPDATE operation_undo SET source_revision = 0
             WHERE source_operation_id = 'op-source'",
            [],
        );
        assert!(bad_revision.is_err());

        let half_undone = connection.execute(
            "UPDATE operation_undo SET undone_by_operation_id = 'op-undo'
             WHERE source_operation_id = 'op-source'",
            [],
        );
        assert!(half_undone.is_err());

        connection
            .execute(
                "INSERT INTO operation_receipts(
                    operation_id, request_json, response_json, created_at, expires_at
                 ) VALUES (
                    'op-undo',
                    '{\"undo\":true}',
                    '{\"ok\":true}',
                    '2026-07-28T12:05:00Z',
                    '2026-08-27T12:05:00Z'
                 )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE operation_undo
                 SET undone_by_operation_id = 'op-undo',
                     undone_at = '2026-07-28T12:05:00Z'
                 WHERE source_operation_id = 'op-source'",
                [],
            )
            .unwrap();

        // Unique undone_by_operation_id prevents two sources claiming one undo receipt.
        connection
            .execute(
                "INSERT INTO operation_receipts(operation_id, request_json, response_json)
                 VALUES ('op-other', '{}', '{}')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO operation_undo(
                    source_operation_id, source_revision, inverse_json, post_image_json
                 ) VALUES ('op-other', 2, '{}', '{}')",
                [],
            )
            .unwrap();
        let duplicate_undone_by = connection.execute(
            "UPDATE operation_undo
             SET undone_by_operation_id = 'op-undo',
                 undone_at = '2026-07-28T12:06:00Z'
             WHERE source_operation_id = 'op-other'",
            [],
        );
        assert!(duplicate_undone_by.is_err());

        // Deleting a receipt cascades its undo row; request/response of others stay put.
        connection
            .execute(
                "DELETE FROM operation_receipts WHERE operation_id = 'op-source'",
                [],
            )
            .unwrap();
        let undo_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM operation_undo", [], |row| row.get(0))
            .unwrap();
        assert_eq!(undo_count, 1);
        let remaining: String = connection
            .query_row(
                "SELECT source_operation_id FROM operation_undo",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, "op-other");
    }

    fn table_columns(connection: &Connection, table: &str) -> Vec<String> {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    }
}
