//! Forward SQLite schema migrations for a single profile connection.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use jiff::Timestamp;
use junban_domain::{Task, TaskStatus, format_reminder_timestamp};
use rusqlite::{
    Connection, MAIN_DB, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};

use crate::ops_types::{Inverse, PostImage};

/// Highest schema version applied by this crate.
pub(crate) const CURRENT_SCHEMA_VERSION: i64 = 6;

/// Live database file name under a profile directory.
const DATABASE_FILE: &str = "junban.sqlite3";
/// Directory (under the profile) holding verified pre-migration snapshots.
const PRE_MIGRATION_BACKUP_DIR: &str = "backups/pre-migration";
/// Filename prefix for backups taken before leaving schema v2.
const PRE_V2_BACKUP_PREFIX: &str = "pre-v2-";
const PRE_V2_BACKUP_SUFFIX: &str = ".sqlite3";
/// Keep only the newest verified pre-migration backups after a successful v2→v3 migrate.
const PRE_MIGRATION_BACKUP_RETAIN: usize = 3;

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

/// Apply all pending forward migrations.
///
/// `profile_dir` is the owned profile directory that contains `junban.sqlite3`.
/// Existing schema-v2 profiles receive a verified private backup under
/// `backups/pre-migration/` before the v3 transaction runs. Fresh profiles
/// advance v1→v2→v3 in-process and do not create a pre-migration backup.
///
/// Callers must hold the profile owner lock before invoking this function.
pub(crate) fn migrate(connection: &mut Connection, profile_dir: &Path) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );",
    )?;

    let starting_version = current_version(connection)?;
    let mut pre_migration_backup = None;
    if starting_version > CURRENT_SCHEMA_VERSION {
        return Err(unsupported_schema(starting_version));
    }
    if starting_version < 1 {
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

    let current = current_version(connection)?;
    if current < 3 {
        // Only profiles that opened already at v2 need a recoverable pre-v3 snapshot.
        // Fresh installs that just applied v1/v2 above skip backup creation.
        pre_migration_backup = if starting_version == 2 {
            Some(create_verified_pre_v2_backup(connection, profile_dir)?)
        } else {
            None
        };

        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        apply_v3(&transaction)?;
        assert_foreign_keys_clean(&transaction)?;
        record_version(&transaction, 3)?;
        transaction.commit()?;
    }

    let current = current_version(connection)?;
    if current < 4 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        apply_v4(&transaction)?;
        assert_foreign_keys_clean(&transaction)?;
        record_version(&transaction, 4)?;
        transaction.commit()?;
    }

    let current = current_version(connection)?;
    if current < 5 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        apply_v5(&transaction)?;
        assert_foreign_keys_clean(&transaction)?;
        record_version(&transaction, 5)?;
        transaction.commit()?;
    }

    let current = current_version(connection)?;
    if current < 6 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        apply_v6(&transaction)?;
        assert_foreign_keys_clean(&transaction)?;
        record_version(&transaction, 6)?;
        transaction.commit()?;
    }

    if let Some(backup_path) = pre_migration_backup {
        // Prune only after the new backup and the fully migrated DB both reopen cleanly.
        finalize_successful_v2_to_v3(profile_dir, &backup_path)?;
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

    // Schema v3 is active but unreleased. Coherently rewrite any variable-width
    // reminder comparison text written by the immediately preceding v3 build so
    // SQL ordering matches instant order. Idempotent on already-canonical rows.
    if applied == CURRENT_SCHEMA_VERSION {
        normalize_reminder_timestamp_text(connection)?;
        ensure_v6_ai_runtime_indexes(connection)?;
        repair_current_v6_ai_response_authority(connection)?;
    }

    Ok(())
}

fn ensure_v6_ai_runtime_indexes(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_ai_run_state_state
         ON ai_run_state(state, run_id);",
    )
}

/// Apply the idempotent current-v6 AI response-authority correction.
///
/// This is deliberately limited to the known indexes and invalidation table added
/// in-place during schema v6. Conflicting objects fail here or during canonical
/// schema validation rather than being replaced.
pub(crate) fn repair_current_v6_ai_response_authority(
    connection: &Connection,
) -> rusqlite::Result<()> {
    if current_version(connection)? != CURRENT_SCHEMA_VERSION {
        return Ok(());
    }
    let transaction = connection.unchecked_transaction()?;
    transaction.execute_batch(
        r#"
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_messages_daily_briefing_active
    ON ai_messages(json_extract(content_json, '$.briefing_date'))
    WHERE role = 'assistant'
      AND status IN ('streaming', 'completed')
      AND json_type(content_json, '$.briefing_date') = 'text';
CREATE INDEX IF NOT EXISTS idx_ai_messages_briefing_date
    ON ai_messages(json_extract(content_json, '$.briefing_date'), status, id)
    WHERE role = 'assistant'
      AND json_type(content_json, '$.briefing_date') = 'text';
CREATE TABLE IF NOT EXISTS ai_response_invalidations (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    invalidating_operation_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_response_invalidations_session
    ON ai_response_invalidations(session_id, run_id);
CREATE INDEX IF NOT EXISTS idx_ai_response_invalidations_expiry
    ON ai_response_invalidations(expires_at, run_id);
"#,
    )?;
    transaction.commit()
}

/// Rewrite reminder comparison columns to fixed nine-fractional-digit UTC text.
fn normalize_reminder_timestamp_text(connection: &mut Connection) -> rusqlite::Result<()> {
    let exists: bool = connection.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master
         WHERE type = 'table' AND name = 'reminder_occurrences'",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(());
    }

    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

    // tasks.remind_at is a reminder comparison column (intent / protect-from-compact key).
    let mut task_rows = Vec::new();
    {
        let mut statement =
            tx.prepare("SELECT id, remind_at FROM tasks WHERE remind_at IS NOT NULL")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            task_rows.push(row?);
        }
    }
    for (id, raw) in task_rows {
        if let Some(canonical) = canonicalize_reminder_ts(&raw) {
            tx.execute(
                "UPDATE tasks SET remind_at = ?1 WHERE id = ?2 AND remind_at = ?3",
                rusqlite::params![canonical, id, raw],
            )?;
        }
    }

    // Occurrence rows: PK remind_at may change string form for the same instant.
    let mut occurrence_rows = Vec::new();
    {
        let mut statement = tx.prepare(
            "SELECT task_id, remind_at, claim_expires_at, next_attempt_at, created_at, updated_at
             FROM reminder_occurrences",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        for row in rows {
            occurrence_rows.push(row?);
        }
    }
    for (task_id, remind_at, claim_expires_at, next_attempt_at, created_at, updated_at) in
        occurrence_rows
    {
        let new_remind_at =
            canonicalize_reminder_ts(&remind_at).unwrap_or_else(|| remind_at.clone());
        let new_claim_expires = claim_expires_at
            .as_deref()
            .and_then(canonicalize_reminder_ts)
            .or(claim_expires_at.clone());
        let new_next_attempt = next_attempt_at
            .as_deref()
            .and_then(canonicalize_reminder_ts)
            .or(next_attempt_at.clone());
        let new_created =
            canonicalize_reminder_ts(&created_at).unwrap_or_else(|| created_at.clone());
        let new_updated =
            canonicalize_reminder_ts(&updated_at).unwrap_or_else(|| updated_at.clone());
        if new_remind_at == remind_at
            && new_claim_expires == claim_expires_at
            && new_next_attempt == next_attempt_at
            && new_created == created_at
            && new_updated == updated_at
        {
            continue;
        }
        // UPDATE may change the composite PK string; no-op when already canonical.
        tx.execute(
            "UPDATE reminder_occurrences
             SET remind_at = ?1,
                 claim_expires_at = ?2,
                 next_attempt_at = ?3,
                 created_at = ?4,
                 updated_at = ?5
             WHERE task_id = ?6 AND remind_at = ?7",
            rusqlite::params![
                new_remind_at,
                new_claim_expires,
                new_next_attempt,
                new_created,
                new_updated,
                task_id,
                remind_at,
            ],
        )?;
    }

    let mut lease_rows = Vec::new();
    {
        let mut statement =
            tx.prepare("SELECT singleton, expires_at, updated_at FROM reminder_delivery_lease")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            lease_rows.push(row?);
        }
    }
    for (singleton, expires_at, updated_at) in lease_rows {
        let new_expires =
            canonicalize_reminder_ts(&expires_at).unwrap_or_else(|| expires_at.clone());
        let new_updated =
            canonicalize_reminder_ts(&updated_at).unwrap_or_else(|| updated_at.clone());
        if new_expires == expires_at && new_updated == updated_at {
            continue;
        }
        tx.execute(
            "UPDATE reminder_delivery_lease
             SET expires_at = ?1, updated_at = ?2
             WHERE singleton = ?3",
            rusqlite::params![new_expires, new_updated, singleton],
        )?;
    }

    tx.commit()?;
    Ok(())
}

fn canonicalize_reminder_ts(raw: &str) -> Option<String> {
    let parsed = raw.parse::<Timestamp>().ok()?;
    let canonical = format_reminder_timestamp(parsed);
    if canonical == raw {
        None
    } else {
        Some(canonical)
    }
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

/// Additive Phase 3 temporal/planning tables and task columns.
fn apply_v3(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    // Extend tasks in place. New columns are nullable so existing rows stay valid.
    transaction.execute_batch(
        "
ALTER TABLE tasks ADD COLUMN remind_at TEXT;
ALTER TABLE tasks ADD COLUMN recurrence_anchor_day INTEGER
    CHECK (
        recurrence_anchor_day IS NULL
        OR (recurrence_anchor_day BETWEEN 1 AND 31)
    );
ALTER TABLE tasks ADD COLUMN recurrence_source_id TEXT
    REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN completion_operation_id TEXT;

-- One generated child per completed source occurrence (unique lineage ownership).
CREATE UNIQUE INDEX idx_tasks_recurrence_lineage
    ON tasks(recurrence_source_id)
    WHERE recurrence_source_id IS NOT NULL;
CREATE INDEX idx_tasks_remind_at
    ON tasks(remind_at)
    WHERE remind_at IS NOT NULL;
CREATE INDEX idx_tasks_completion_operation
    ON tasks(completion_operation_id)
    WHERE completion_operation_id IS NOT NULL;
",
    )?;

    transaction.execute_batch(
        "
-- Allowlisted Phase 3 temporal settings only. Full settings UI lands in Phase 4.
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (key IN (
        'notification_channels',
        'reminder_defaults',
        'capacity',
        'work_hours',
        'week_start',
        'nudge_rules'
    ))
);

CREATE TABLE reminder_occurrences (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    remind_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'pending', 'claimed', 'delivered', 'failed', 'cancelled'
    )),
    claim_term TEXT,
    claim_expires_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TEXT,
    terminal_channel TEXT CHECK (
        terminal_channel IS NULL OR terminal_channel IN (
            'in_app', 'web_notification', 'sound', 'native'
        )
    ),
    terminal_error_code TEXT CHECK (
        terminal_error_code IS NULL OR terminal_error_code IN (
            'permission_denied',
            'temporarily_unavailable',
            'channel_failed',
            'owner_lost'
        )
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, remind_at)
);
CREATE INDEX idx_reminder_occurrences_due
    ON reminder_occurrences(state, remind_at);
CREATE INDEX idx_reminder_occurrences_claim
    ON reminder_occurrences(state, claim_expires_at);

-- At most one global delivery-owner row; application upserts on acquire.
CREATE TABLE reminder_delivery_lease (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    fence_term TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE time_slots (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    civil_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    timezone TEXT NOT NULL,
    color TEXT,
    recurrence_rule TEXT,
    recurrence_parent_id TEXT REFERENCES time_slots(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    CHECK (start_time < end_time),
    CHECK (recurrence_parent_id IS NULL OR recurrence_parent_id != id)
);
CREATE INDEX idx_time_slots_date ON time_slots(civil_date, start_time, id);
CREATE INDEX idx_time_slots_project ON time_slots(project_id);
CREATE INDEX idx_time_slots_parent ON time_slots(recurrence_parent_id);

CREATE TABLE time_blocks (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    slot_id TEXT REFERENCES time_slots(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    civil_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    timezone TEXT NOT NULL,
    color TEXT,
    locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    recurrence_rule TEXT,
    recurrence_parent_id TEXT REFERENCES time_blocks(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    CHECK (start_time < end_time),
    CHECK (recurrence_parent_id IS NULL OR recurrence_parent_id != id)
);
CREATE INDEX idx_time_blocks_date ON time_blocks(civil_date, start_time, id);
CREATE INDEX idx_time_blocks_task ON time_blocks(task_id);
CREATE INDEX idx_time_blocks_slot ON time_blocks(slot_id);
CREATE INDEX idx_time_blocks_parent ON time_blocks(recurrence_parent_id);

-- Ordered slot membership. Max 100 tasks/slot is enforced by application later.
CREATE TABLE time_slot_tasks (
    slot_id TEXT NOT NULL REFERENCES time_slots(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (slot_id, task_id),
    UNIQUE (slot_id, position)
);
CREATE INDEX idx_time_slot_tasks_task ON time_slot_tasks(task_id);
",
    )?;

    Ok(())
}

/// Add schema-v6 AI chat/memory/approval tables and expand settings with AI/voice defaults.
fn apply_v6(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    use junban_domain::AppSettings;

    transaction.execute_batch(
        r#"
CREATE TABLE ai_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL CHECK (length(title) > 0 AND length(title) <= 200),
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    message_count INTEGER NOT NULL CHECK (message_count >= 0 AND message_count <= 500),
    content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0 AND content_bytes <= 33554432),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_message_at TEXT
);
CREATE INDEX idx_ai_sessions_updated ON ai_sessions(updated_at DESC, id);

CREATE TABLE ai_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'streaming', 'completed', 'failed', 'cancelled')
    ),
    content_json TEXT NOT NULL,
    content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, sequence)
);
CREATE INDEX idx_ai_messages_session_sequence ON ai_messages(session_id, sequence);
CREATE INDEX idx_ai_messages_turn ON ai_messages(session_id, turn_id);

CREATE TABLE ai_memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL CHECK (length(content) > 0 AND length(content) <= 10000),
    content_bytes INTEGER NOT NULL CHECK (content_bytes > 0 AND content_bytes <= 10000),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_ai_memories_updated ON ai_memories(updated_at DESC, id);

CREATE TABLE ai_session_memories (
    session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
    memory_id TEXT NOT NULL REFERENCES ai_memories(id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, memory_id)
);
CREATE INDEX idx_ai_session_memories_memory ON ai_session_memories(memory_id);

CREATE TABLE ai_tool_approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    tool_name TEXT NOT NULL CHECK (length(tool_name) > 0 AND length(tool_name) <= 64),
    arguments_json TEXT NOT NULL,
    arguments_bytes INTEGER NOT NULL CHECK (arguments_bytes >= 0 AND arguments_bytes <= 131072),
    action_hash TEXT NOT NULL CHECK (length(action_hash) = 64),
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'approved', 'rejected', 'expired', 'consumed')
    ),
    expires_at TEXT NOT NULL,
    operation_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_ai_tool_approvals_session ON ai_tool_approvals(session_id, status);
CREATE INDEX idx_ai_tool_approvals_run ON ai_tool_approvals(run_id, generation);

CREATE TABLE ai_run_state (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    assistant_message_id TEXT NOT NULL UNIQUE REFERENCES ai_messages(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    state TEXT NOT NULL CHECK (
        state IN (
            'running', 'awaiting_approval', 'dispatching',
            'completed', 'failed', 'cancelled'
        )
    ),
    approval_id TEXT REFERENCES ai_tool_approvals(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_ai_run_state_session ON ai_run_state(session_id, state);
-- Bounded startup dispatch recovery probes by state and stable run identity.
CREATE INDEX idx_ai_run_state_state ON ai_run_state(state, run_id);
-- Restore validation probes terminal approvals by approval_id; keep that path indexed.
CREATE INDEX idx_ai_run_state_approval
    ON ai_run_state(approval_id)
    WHERE approval_id IS NOT NULL;

CREATE UNIQUE INDEX idx_ai_messages_daily_briefing_active
    ON ai_messages(json_extract(content_json, '$.briefing_date'))
    WHERE role = 'assistant'
      AND status IN ('streaming', 'completed')
      AND json_type(content_json, '$.briefing_date') = 'text';
CREATE INDEX idx_ai_messages_briefing_date
    ON ai_messages(json_extract(content_json, '$.briefing_date'), status, id)
    WHERE role = 'assistant'
      AND json_type(content_json, '$.briefing_date') = 'text';

CREATE TABLE IF NOT EXISTS ai_response_invalidations (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    invalidating_operation_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_response_invalidations_session
    ON ai_response_invalidations(session_id, run_id);
CREATE INDEX IF NOT EXISTS idx_ai_response_invalidations_expiry
    ON ai_response_invalidations(expires_at, run_id);

CREATE TABLE ai_quota (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    session_count INTEGER NOT NULL CHECK (session_count >= 0 AND session_count <= 500),
    total_content_bytes INTEGER NOT NULL CHECK (
        total_content_bytes >= 0 AND total_content_bytes <= 134217728
    ),
    memory_count INTEGER NOT NULL CHECK (memory_count >= 0 AND memory_count <= 500),
    memory_content_bytes INTEGER NOT NULL CHECK (
        memory_content_bytes >= 0 AND memory_content_bytes <= 5242880
    ),
    pending_approval_count INTEGER NOT NULL CHECK (
        pending_approval_count >= 0 AND pending_approval_count <= 128
    ),
    pending_approval_content_bytes INTEGER NOT NULL CHECK (
        pending_approval_content_bytes >= 0 AND pending_approval_content_bytes <= 1048576
    )
);
INSERT INTO ai_quota(
    singleton, session_count, total_content_bytes, memory_count, memory_content_bytes,
    pending_approval_count, pending_approval_content_bytes
) VALUES (1, 0, 0, 0, 0, 0, 0);
"#,
    )?;

    // Expand the typed settings aggregate with AI/voice defaults while preserving
    // every existing non-AI preference from the v5 settings_json row.
    let existing_json: Option<String> = transaction
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = 'settings_json'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let mut settings = if let Some(json) = existing_json {
        serde_json::from_str::<AppSettings>(&json).map_err(|error| {
            migration_err(format!("invalid settings_json before v6 migrate: {error}"))
        })?
    } else {
        AppSettings::default_settings()
    };
    // Force disabled cloud AI/speech defaults when sections were absent (serde default)
    // or when an older snapshot somehow enabled them without Wave-1 authority.
    if settings.ai.credential_id.is_some() || settings.ai.enabled {
        settings.ai = settings.ai.cleared_for_restore();
    }
    if settings.voice.cloud_speech_enabled
        || settings.voice.stt_credential_id.is_some()
        || settings.voice.tts_credential_id.is_some()
    {
        settings.voice = settings.voice.cleared_for_restore();
    }
    settings
        .validate()
        .map_err(|error| migration_err(format!("settings invalid after v6 migrate: {error}")))?;
    let settings_json =
        serde_json::to_string(&settings).map_err(|error| migration_err(error.to_string()))?;
    let updated_at = Timestamp::now().to_string();
    let updated = transaction.execute(
        "UPDATE app_settings SET value_json = ?1, updated_at = ?2 WHERE key = 'settings_json'",
        rusqlite::params![settings_json, updated_at],
    )?;
    if updated != 1 {
        transaction.execute(
            "INSERT INTO app_settings(key, value_json, updated_at) VALUES ('settings_json', ?1, ?2)",
            rusqlite::params![settings_json, updated_at],
        )?;
    }

    Ok(())
}

/// Expand settings into a typed aggregate and stamp a durable event-history epoch.
fn apply_v5(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    use junban_domain::{AppSettings, NudgeRuleKind, NudgeRuleSettings, TaskId, WorkHours};

    // Capture any Phase 3 allowlisted temporal keys before rebuilding the table.
    let mut legacy: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(mut statement) = transaction.prepare("SELECT key, value_json FROM app_settings") {
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (key, value) = row?;
            legacy.insert(key, value);
        }
    }

    transaction.execute_batch(
        "
DROP TABLE IF EXISTS app_settings;
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
",
    )?;

    // Existing profiles always receive one generated epoch during migration.
    // TaskId::new() is a random UUID string without adding a storage uuid dep.
    let event_epoch = TaskId::new().as_uuid().to_string();
    let has_event_epoch: bool = {
        let mut statement = transaction.prepare("PRAGMA table_info(app_state)")?;
        let mut rows = statement.query_map([], |row| row.get::<_, String>(1))?;
        let mut found = false;
        for name in rows.by_ref() {
            if name? == "event_epoch" {
                found = true;
                break;
            }
        }
        found
    };
    if !has_event_epoch {
        transaction.execute_batch(
            "ALTER TABLE app_state ADD COLUMN event_epoch TEXT NOT NULL DEFAULT '';",
        )?;
    }
    transaction.execute(
        "UPDATE app_state SET event_epoch = ?1 WHERE singleton = 1",
        [&event_epoch],
    )?;

    let mut settings = AppSettings::default_settings();

    if let Some(raw) = legacy.get("week_start")
        && let Ok(week_start) = parse_legacy_week_start(raw)
    {
        settings.date_time.week_start = week_start;
    }
    if let Some(raw) = legacy.get("capacity")
        && let Ok(capacity) = parse_legacy_capacity(raw)
    {
        settings.planning.capacity_minutes = capacity;
    }
    if let Some(raw) = legacy.get("work_hours")
        && let Ok(hours) = serde_json::from_str::<WorkHours>(raw)
        && WorkHours::new(hours.start_minute, hours.end_minute).is_ok()
    {
        settings.planning.work_hours = Some(hours);
    }
    if let Some(raw) = legacy.get("nudge_rules")
        && let Ok(rules) = serde_json::from_str::<Vec<NudgeRuleSettings>>(raw)
    {
        let mut seen = Vec::new();
        let mut clean = Vec::new();
        for rule in rules {
            if !seen.contains(&rule.kind) && NudgeRuleKind::ALL.contains(&rule.kind) {
                seen.push(rule.kind);
                // Only stale_task evaluation consumes a threshold; drop inert values.
                let threshold = if rule.kind == NudgeRuleKind::StaleTask {
                    rule.threshold
                } else {
                    None
                };
                clean.push(NudgeRuleSettings::new(rule.kind, rule.enabled, threshold));
            }
        }
        if !clean.is_empty() {
            settings.planning.nudge_rules = clean;
        }
    }
    if let Some(raw) = legacy.get("notification_channels")
        && let Ok(channels) = parse_legacy_channels(raw)
    {
        settings.notifications.channels = channels;
    }

    settings.validate().map_err(|error| {
        migration_err(format!(
            "default settings invalid after v5 migrate: {error}"
        ))
    })?;

    let settings_json =
        serde_json::to_string(&settings).map_err(|error| migration_err(error.to_string()))?;
    let updated_at = Timestamp::now().to_string();
    transaction.execute(
        "INSERT INTO app_settings(key, value_json, updated_at) VALUES (?1, ?2, ?3)",
        rusqlite::params!["settings_json", settings_json, updated_at],
    )?;

    Ok(())
}

fn parse_legacy_week_start(raw: &str) -> Result<junban_domain::WeekStart, ()> {
    if let Ok(value) = serde_json::from_str::<junban_domain::WeekStart>(raw) {
        return Ok(value);
    }
    if let Ok(wrapper) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(day) = wrapper.get("day").and_then(|v| v.as_str()) {
            return junban_domain::WeekStart::parse(day).map_err(|_| ());
        }
        if let Some(day) = wrapper.as_str() {
            return junban_domain::WeekStart::parse(day).map_err(|_| ());
        }
    }
    junban_domain::WeekStart::parse(raw.trim_matches('"')).map_err(|_| ())
}

fn parse_legacy_capacity(raw: &str) -> Result<u32, ()> {
    if let Ok(value) = serde_json::from_str::<u32>(raw) {
        return Ok(value);
    }
    if let Ok(wrapper) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(value) = wrapper.as_u64() {
            return u32::try_from(value).map_err(|_| ());
        }
        if let Some(value) = wrapper
            .get("daily_capacity")
            .and_then(|v| v.as_u64())
            .or_else(|| wrapper.get("capacity_minutes").and_then(|v| v.as_u64()))
        {
            return u32::try_from(value).map_err(|_| ());
        }
    }
    raw.parse().map_err(|_| ())
}

fn parse_legacy_channels(raw: &str) -> Result<junban_domain::ReminderChannelSet, ()> {
    if let Ok(set) = serde_json::from_str::<junban_domain::ReminderChannelSet>(raw)
        && !set.as_slice().is_empty()
    {
        return Ok(set);
    }
    if let Ok(channels) = serde_json::from_str::<Vec<junban_domain::ReminderChannel>>(raw) {
        return junban_domain::ReminderChannelSet::new(channels).map_err(|_| ());
    }
    Err(())
}

/// Persist the transition into the current cancelled state independently of mutable edits.
fn apply_v4(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    transaction.execute_batch(
        "
ALTER TABLE tasks ADD COLUMN cancelled_at TEXT;

-- Existing v3 task activity records status changes. Backfill only current
-- cancellations from their latest transition; the fallback covers externally
-- modified profiles that lack that durable activity record.
UPDATE tasks
SET cancelled_at = COALESCE(
    (
        SELECT created_at
        FROM task_activity
        WHERE task_id = tasks.id
          AND field = 'status'
          AND new_value = 'cancelled'
        ORDER BY revision DESC, sequence DESC
        LIMIT 1
    ),
    updated_at
)
WHERE status = 'cancelled';
",
    )?;

    reconcile_v3_undo_task_snapshots(transaction)
}

/// Add the v4 cancellation transition to retained v3 task snapshots.
///
/// Undo snapshots use the task revision they captured, so the latest durable
/// cancellation no newer than that revision is the exact transition represented
/// by the snapshot. Rewriting the undo row in the v4 transaction keeps live rows
/// and their conflict-validation material atomic across migration retries.
fn reconcile_v3_undo_task_snapshots(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    let mut last_source_operation_id: Option<String> = None;
    loop {
        let read_payload = |row: &rusqlite::Row<'_>| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        };
        let row = if let Some(last_source_operation_id) = last_source_operation_id.as_deref() {
            transaction
                .query_row(
                    "SELECT source_operation_id, inverse_json, post_image_json
                     FROM operation_undo
                     WHERE source_operation_id > ?1
                     ORDER BY source_operation_id
                     LIMIT 1",
                    [last_source_operation_id],
                    read_payload,
                )
                .optional()?
        } else {
            transaction
                .query_row(
                    "SELECT source_operation_id, inverse_json, post_image_json
                     FROM operation_undo
                     ORDER BY source_operation_id
                     LIMIT 1",
                    [],
                    read_payload,
                )
                .optional()?
        };
        let Some((source_operation_id, inverse_json, post_image_json)) = row else {
            break;
        };

        let mut inverse: Inverse = serde_json::from_str(&inverse_json).map_err(|error| {
            migration_err(format!(
                "invalid inverse_json for operation {source_operation_id}: {error}"
            ))
        })?;
        let mut post: PostImage = serde_json::from_str(&post_image_json).map_err(|error| {
            migration_err(format!(
                "invalid post_image_json for operation {source_operation_id}: {error}"
            ))
        })?;

        let mut changed = reconcile_inverse_tasks(transaction, &mut inverse)?;
        for task in post.tasks.values_mut() {
            changed |= reconcile_task_snapshot(transaction, task)?;
        }
        if !changed {
            last_source_operation_id = Some(source_operation_id);
            continue;
        }

        let inverse_json = serde_json::to_string(&inverse).map_err(|error| {
            migration_err(format!(
                "could not rewrite inverse_json for operation {source_operation_id}: {error}"
            ))
        })?;
        let post_image_json = serde_json::to_string(&post).map_err(|error| {
            migration_err(format!(
                "could not rewrite post_image_json for operation {source_operation_id}: {error}"
            ))
        })?;
        transaction.execute(
            "UPDATE operation_undo SET inverse_json = ?1, post_image_json = ?2
             WHERE source_operation_id = ?3",
            rusqlite::params![inverse_json, post_image_json, source_operation_id],
        )?;
        last_source_operation_id = Some(source_operation_id);
    }

    Ok(())
}

fn reconcile_inverse_tasks(
    transaction: &Transaction<'_>,
    inverse: &mut Inverse,
) -> rusqlite::Result<bool> {
    let tasks = match inverse {
        Inverse::RestoreClosure { closure } => &mut closure.tasks,
        Inverse::RestoreTasks { tasks, .. } | Inverse::RestoreImport { tasks, .. } => tasks,
        Inverse::ReverseCompletion { sources, .. } => sources,
        Inverse::DeleteTasks { .. }
        | Inverse::DeleteImport { .. }
        | Inverse::RestoreOrders { .. }
        | Inverse::RestoreComment { .. }
        | Inverse::RestoreRelation { .. } => return Ok(false),
    };

    let mut changed = false;
    for task in tasks {
        changed |= reconcile_task_snapshot(transaction, task)?;
    }
    Ok(changed)
}

fn reconcile_task_snapshot(
    transaction: &Transaction<'_>,
    task: &mut Task,
) -> rusqlite::Result<bool> {
    if task.status != TaskStatus::Cancelled || task.cancelled_at.is_some() {
        return Ok(false);
    }

    let revision = i64::try_from(task.revision)
        .map_err(|error| migration_err(format!("invalid task snapshot revision: {error}")))?;
    let cancelled_at: Option<String> = transaction
        .query_row(
            "SELECT created_at
             FROM task_activity
             WHERE task_id = ?1
               AND field = 'status'
               AND new_value = 'cancelled'
               AND revision <= ?2
             ORDER BY revision DESC, sequence DESC
             LIMIT 1",
            rusqlite::params![task.id.to_string(), revision],
            |row| row.get(0),
        )
        .optional()?;
    task.cancelled_at = Some(match cancelled_at {
        Some(value) => value.parse().map_err(|error| {
            migration_err(format!(
                "invalid cancellation activity timestamp for task {}: {error}",
                task.id
            ))
        })?,
        None => task.updated_at,
    });
    Ok(true)
}

/// WAL-safe online backup of an existing v2 profile, verified before migration.
fn create_verified_pre_v2_backup(
    connection: &Connection,
    profile_dir: &Path,
) -> rusqlite::Result<PathBuf> {
    let backup_dir = profile_dir.join(PRE_MIGRATION_BACKUP_DIR);
    ensure_backup_dirs(profile_dir)?;

    // Collapse WAL into the main DB so the backup API copies a consistent snapshot.
    checkpoint_wal(connection)?;

    let stamp = backup_timestamp_label(Timestamp::now());
    let backup_path = backup_dir.join(format!(
        "{PRE_V2_BACKUP_PREFIX}{stamp}{PRE_V2_BACKUP_SUFFIX}"
    ));

    // Remove a same-timestamp leftover so retry after a partial failure is clean.
    if backup_path.exists() {
        fs::remove_file(&backup_path).map_err(io_to_sqlite)?;
    }

    let backup_result = connection.backup(MAIN_DB, &backup_path, None);
    if let Err(error) = backup_result {
        let _ = fs::remove_file(&backup_path);
        return Err(error);
    }
    if let Err(error) = crate::set_private_file_permissions(&backup_path) {
        let _ = fs::remove_file(&backup_path);
        return Err(io_to_sqlite(error));
    }

    if let Err(error) = verify_pre_v2_backup(&backup_path) {
        let _ = fs::remove_file(&backup_path);
        return Err(error);
    }

    Ok(backup_path)
}

fn finalize_successful_v2_to_v3(profile_dir: &Path, backup_path: &Path) -> rusqlite::Result<()> {
    // Re-verify the snapshot we just took and reopen the migrated live DB.
    verify_pre_v2_backup(backup_path)?;
    verify_migrated_database(profile_dir)?;
    prune_pre_migration_backups(profile_dir)?;
    Ok(())
}

fn ensure_backup_dirs(profile_dir: &Path) -> rusqlite::Result<()> {
    // Set private perms on each created level (create_dir_all alone would not).
    crate::ensure_private_dir(&profile_dir.join("backups")).map_err(io_to_sqlite)?;
    crate::ensure_private_dir(&profile_dir.join(PRE_MIGRATION_BACKUP_DIR)).map_err(io_to_sqlite)?;
    Ok(())
}

fn checkpoint_wal(connection: &Connection) -> rusqlite::Result<()> {
    let (blocked, _log, _checkpointed): (i64, i64, i64) =
        connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
    if blocked != 0 {
        return Err(migration_err(
            "wal_checkpoint(TRUNCATE) blocked; cannot create pre-migration backup",
        ));
    }
    Ok(())
}

fn verify_pre_v2_backup(path: &Path) -> rusqlite::Result<()> {
    let connection = open_readonly(path)?;
    let version = current_version(&connection)?;
    if version != 2 {
        return Err(migration_err(format!(
            "pre-migration backup schema version {version} is not 2"
        )));
    }
    if !integrity_check_ok(&connection)? {
        return Err(migration_err(
            "pre-migration backup failed PRAGMA integrity_check",
        ));
    }
    Ok(())
}

fn verify_migrated_database(profile_dir: &Path) -> rusqlite::Result<()> {
    let path = profile_dir.join(DATABASE_FILE);
    let connection = open_readonly(&path)?;
    let version = current_version(&connection)?;
    if version != CURRENT_SCHEMA_VERSION {
        return Err(migration_err(format!(
            "migrated database schema version {version} is not {CURRENT_SCHEMA_VERSION}"
        )));
    }
    if !integrity_check_ok(&connection)? {
        return Err(migration_err(
            "migrated database failed PRAGMA integrity_check",
        ));
    }
    Ok(())
}

fn open_readonly(path: &Path) -> rusqlite::Result<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection = Connection::open_with_flags(path, flags)?;
    // Foreign keys are not required for integrity_check/schema_version reads,
    // but enable them so any accidental write attempt would still enforce FKs.
    connection.pragma_update(None, "foreign_keys", true)?;
    Ok(connection)
}

fn integrity_check_ok(connection: &Connection) -> rusqlite::Result<bool> {
    let mut statement = connection.prepare("PRAGMA integrity_check")?;
    let mut rows = statement.query([])?;
    let mut messages = Vec::new();
    while let Some(row) = rows.next()? {
        messages.push(row.get::<_, String>(0)?);
    }
    Ok(messages.len() == 1 && messages[0] == "ok")
}

fn prune_pre_migration_backups(profile_dir: &Path) -> rusqlite::Result<()> {
    let backup_dir = profile_dir.join(PRE_MIGRATION_BACKUP_DIR);
    if !backup_dir.exists() {
        return Ok(());
    }

    let mut backups = list_pre_v2_backups(&backup_dir)?;
    // Newest first by filename (UTC stamp is sortable after ':' → '-').
    backups.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    for stale in backups.into_iter().skip(PRE_MIGRATION_BACKUP_RETAIN) {
        fs::remove_file(&stale).map_err(io_to_sqlite)?;
    }
    Ok(())
}

fn list_pre_v2_backups(backup_dir: &Path) -> rusqlite::Result<Vec<PathBuf>> {
    let mut backups = Vec::new();
    let entries = fs::read_dir(backup_dir).map_err(io_to_sqlite)?;
    for entry in entries {
        let entry = entry.map_err(io_to_sqlite)?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with(PRE_V2_BACKUP_PREFIX) && name.ends_with(PRE_V2_BACKUP_SUFFIX) {
            backups.push(path);
        }
    }
    Ok(backups)
}

fn backup_timestamp_label(now: Timestamp) -> String {
    // Filesystem-safe UTC stamp; lexicographic order matches chronological order.
    now.to_string().replace(':', "-")
}

fn io_to_sqlite(error: io::Error) -> rusqlite::Error {
    migration_err(format!("pre-migration backup I/O error: {error}"))
}

fn migration_err(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error {
            code: rusqlite::ErrorCode::Unknown,
            extended_code: 1,
        },
        Some(message.into()),
    )
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
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use jiff::tz::TimeZone;
    use junban_domain::{OperationId, TaskId, TaskTitle, WeekStart, weekly_review_summary};

    use crate::ops_types::{post_from_tasks, restore_tasks_inverse};

    static TEST_DB_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDb {
        path: PathBuf,
        _dir: PathBuf,
    }

    impl TestDb {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "junban-migration-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                TEST_DB_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&dir).unwrap();
            let path = dir.join("junban.sqlite3");
            Self { path, _dir: dir }
        }

        fn profile_dir(&self) -> &std::path::Path {
            &self._dir
        }

        fn open(&self) -> Connection {
            let connection = Connection::open(&self.path).unwrap();
            connection
                .pragma_update(None, "foreign_keys", true)
                .unwrap();
            connection
                .pragma_update(None, "journal_mode", "WAL")
                .unwrap();
            connection
        }

        fn migrate(&self, connection: &mut Connection) -> rusqlite::Result<()> {
            migrate(connection, self.profile_dir())
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

    fn seed_v2_with_sample_rows(connection: &mut Connection) {
        seed_v1_with_sample_rows(connection);
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        apply_v2(&transaction).unwrap();
        assert_foreign_keys_clean(&transaction).unwrap();
        record_version(&transaction, 2).unwrap();
        transaction.commit().unwrap();
    }

    fn seed_v3_with_sample_rows(connection: &mut Connection) {
        seed_v2_with_sample_rows(connection);
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        apply_v3(&transaction).unwrap();
        assert_foreign_keys_clean(&transaction).unwrap();
        record_version(&transaction, 3).unwrap();
        transaction.commit().unwrap();
    }

    fn v3_task_snapshot(
        id: &str,
        title: &str,
        status: TaskStatus,
        updated_at: &str,
        revision: u64,
    ) -> Task {
        let created_at = "2026-03-01T12:00:00Z".parse().unwrap();
        let mut task = Task::new(
            TaskId::parse(id).unwrap(),
            TaskTitle::new(title).unwrap(),
            None,
            created_at,
            revision,
        );
        task.status = status;
        task.updated_at = updated_at.parse().unwrap();
        task
    }

    fn insert_v3_task(connection: &Connection, task: &Task) {
        let status = match task.status {
            TaskStatus::Pending => "pending",
            TaskStatus::Completed => "completed",
            TaskStatus::Cancelled => "cancelled",
        };
        connection
            .execute(
                "INSERT INTO tasks(id, title, status, completed_at, created_at, updated_at, revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    task.id.to_string(),
                    task.title.as_str(),
                    status,
                    task.completed_at.map(|value| value.to_string()),
                    task.created_at.to_string(),
                    task.updated_at.to_string(),
                    i64::try_from(task.revision).unwrap(),
                ],
            )
            .unwrap();
    }

    fn insert_v3_undo(
        connection: &Connection,
        source_operation_id: OperationId,
        source_revision: u64,
        inverse: &Inverse,
        post: &PostImage,
    ) -> (String, String) {
        let inverse_json = serde_json::to_string(inverse).unwrap();
        let post_image_json = serde_json::to_string(post).unwrap();
        connection
            .execute(
                "INSERT INTO operation_receipts(
                    operation_id, request_json, response_json, created_at, expires_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    source_operation_id.to_string(),
                    "{\"op\":\"legacy\"}",
                    "{\"legacy\":true}",
                    "2026-03-01T12:00:00Z",
                    "2026-04-15T12:00:00Z",
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO operation_undo(
                    source_operation_id, source_revision, inverse_json, post_image_json
                 ) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    source_operation_id.to_string(),
                    i64::try_from(source_revision).unwrap(),
                    inverse_json,
                    post_image_json,
                ],
            )
            .unwrap();
        (inverse_json, post_image_json)
    }

    fn load_task(connection: &mut Connection, task_id: TaskId) -> Task {
        let transaction = connection.transaction().unwrap();
        let task = crate::rows::load_task(&transaction, task_id).unwrap();
        transaction.rollback().unwrap();
        task
    }

    fn pre_migration_backups(profile_dir: &std::path::Path) -> Vec<PathBuf> {
        let dir = profile_dir.join(PRE_MIGRATION_BACKUP_DIR);
        if !dir.exists() {
            return Vec::new();
        }
        list_pre_v2_backups(&dir).unwrap()
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

        let error = db.migrate(&mut connection).unwrap_err().to_string();
        assert!(error.contains("newer than supported"));
        assert_eq!(current_version(&connection).unwrap(), 99);
        let sentinel: String = connection
            .query_row("SELECT value FROM future_sentinel", [], |row| row.get(0))
            .unwrap();
        assert_eq!(sentinel, "untouched");
        assert!(pre_migration_backups(db.profile_dir()).is_empty());
    }

    #[test]
    fn fresh_migrate_reaches_schema_v5_with_expected_tables() {
        let db = TestDb::new();
        let mut connection = db.open();
        db.migrate(&mut connection).unwrap();

        assert_eq!(current_version(&connection).unwrap(), 6);
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
            "app_settings",
            "reminder_occurrences",
            "reminder_delivery_lease",
            "time_blocks",
            "time_slots",
            "time_slot_tasks",
            "ai_sessions",
            "ai_messages",
            "ai_memories",
            "ai_session_memories",
            "ai_tool_approvals",
            "ai_run_state",
            "ai_response_invalidations",
            "ai_quota",
        ] {
            assert!(tables.contains(name), "missing table {name}");
        }

        // Fresh profiles must not create a pre-migration backup.
        assert!(pre_migration_backups(db.profile_dir()).is_empty());

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
            "cancelled_at",
            "created_at",
            "updated_at",
            "revision",
            "remind_at",
            "recurrence_anchor_day",
            "recurrence_source_id",
            "completion_operation_id",
        ] {
            assert!(columns.contains(required), "missing column {required}");
        }

        let settings_columns: HashSet<_> = table_columns(&connection, "app_settings")
            .into_iter()
            .collect();
        for required in ["key", "value_json", "updated_at"] {
            assert!(
                settings_columns.contains(required),
                "missing app_settings column {required}"
            );
        }

        let app_state_columns: HashSet<_> = table_columns(&connection, "app_state")
            .into_iter()
            .collect();
        assert!(
            app_state_columns.contains("event_epoch"),
            "missing app_state.event_epoch"
        );
        let event_epoch: String = connection
            .query_row(
                "SELECT event_epoch FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!event_epoch.is_empty(), "event_epoch must be generated");
        let settings_json: String = connection
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = 'settings_json'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let settings: junban_domain::AppSettings = serde_json::from_str(&settings_json).unwrap();
        settings.validate().unwrap();
        assert!(!settings.date_time.week_start.as_str().is_empty());
        assert_eq!(settings.planning.capacity_minutes, 480);
        assert_eq!(settings.notifications.volume_percent.get(), 70);
        assert!(
            settings
                .planning
                .nudge_rules
                .iter()
                .find(|rule| rule.kind == junban_domain::NudgeRuleKind::ApproachingDeadline)
                .expect("approaching_deadline")
                .threshold
                .is_none()
        );

        let occurrence_columns: HashSet<_> = table_columns(&connection, "reminder_occurrences")
            .into_iter()
            .collect();
        for required in [
            "task_id",
            "remind_at",
            "state",
            "claim_term",
            "claim_expires_at",
            "attempts",
            "next_attempt_at",
            "terminal_channel",
            "terminal_error_code",
            "created_at",
            "updated_at",
        ] {
            assert!(
                occurrence_columns.contains(required),
                "missing reminder_occurrences column {required}"
            );
        }

        let lease_columns: HashSet<_> = table_columns(&connection, "reminder_delivery_lease")
            .into_iter()
            .collect();
        for required in ["singleton", "fence_term", "expires_at", "updated_at"] {
            assert!(
                lease_columns.contains(required),
                "missing lease column {required}"
            );
        }

        let block_columns: HashSet<_> = table_columns(&connection, "time_blocks")
            .into_iter()
            .collect();
        for required in [
            "id",
            "task_id",
            "slot_id",
            "title",
            "civil_date",
            "start_time",
            "end_time",
            "timezone",
            "color",
            "locked",
            "recurrence_rule",
            "recurrence_parent_id",
            "created_at",
            "updated_at",
            "revision",
        ] {
            assert!(
                block_columns.contains(required),
                "missing time_blocks column {required}"
            );
        }

        let slot_columns: HashSet<_> = table_columns(&connection, "time_slots")
            .into_iter()
            .collect();
        for required in [
            "id",
            "title",
            "project_id",
            "civil_date",
            "start_time",
            "end_time",
            "timezone",
            "color",
            "recurrence_rule",
            "recurrence_parent_id",
            "created_at",
            "updated_at",
            "revision",
        ] {
            assert!(
                slot_columns.contains(required),
                "missing time_slots column {required}"
            );
        }

        let membership_columns: HashSet<_> = table_columns(&connection, "time_slot_tasks")
            .into_iter()
            .collect();
        for required in ["slot_id", "task_id", "position"] {
            assert!(
                membership_columns.contains(required),
                "missing time_slot_tasks column {required}"
            );
        }

        for table in ["time_blocks", "time_slots"] {
            let sql: String = connection
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(
                sql.contains("CHECK (start_time < end_time)"),
                "{table} missing start_time < end_time check: {sql}"
            );
        }

        // Defense-in-depth: inverted civil times cannot land even via raw SQL.
        let err = connection
            .execute(
                "INSERT INTO time_blocks(
                    id, title, civil_date, start_time, end_time, timezone, locked,
                    created_at, updated_at, revision
                 ) VALUES (
                    'bad-block', 'x', '2026-03-08', '10:00:00', '10:00:00', 'UTC', 0,
                    '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z', 1
                 )",
                [],
            )
            .unwrap_err();
        assert!(
            matches!(
                err,
                rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error {
                        code: rusqlite::ErrorCode::ConstraintViolation,
                        ..
                    },
                    _
                )
            ),
            "expected time_blocks range check, got {err:?}"
        );
        let err = connection
            .execute(
                "INSERT INTO time_slots(
                    id, title, civil_date, start_time, end_time, timezone,
                    created_at, updated_at, revision
                 ) VALUES (
                    'bad-slot', 'x', '2026-03-08', '11:00:00', '09:00:00', 'UTC',
                    '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z', 1
                 )",
                [],
            )
            .unwrap_err();
        assert!(
            matches!(
                err,
                rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error {
                        code: rusqlite::ErrorCode::ConstraintViolation,
                        ..
                    },
                    _
                )
            ),
            "expected time_slots range check, got {err:?}"
        );

        let approval_index_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_ai_run_state_approval'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            approval_index_sql.contains("approval_id")
                && approval_index_sql.contains("WHERE")
                && approval_index_sql.contains("approval_id IS NOT NULL"),
            "fresh schema v6 must include partial ai_run_state.approval_id index: {approval_index_sql}"
        );
    }

    #[test]
    fn v1_fixture_migrates_and_preserves_task_receipt_activity_event() {
        let db = TestDb::new();
        {
            let mut connection = db.open();
            seed_v1_with_sample_rows(&mut connection);
            assert_eq!(current_version(&connection).unwrap(), 1);
            db.migrate(&mut connection).unwrap();
            assert_eq!(current_version(&connection).unwrap(), 6);
            // Fresh migrations do not create a pre-v2 backup.
            assert!(pre_migration_backups(db.profile_dir()).is_empty());

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

        let err = db.migrate(&mut connection).unwrap_err();
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
        db.migrate(&mut connection).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 6);
        assert!(table_names(&connection).contains("projects"));
        assert!(table_names(&connection).contains("operation_undo"));
        assert!(table_names(&connection).contains("app_settings"));
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
    fn v2_fixture_migrates_to_v4_with_verified_private_backup() {
        let db = TestDb::new();
        let mut connection = db.open();
        seed_v2_with_sample_rows(&mut connection);
        assert_eq!(current_version(&connection).unwrap(), 2);

        db.migrate(&mut connection).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 6);

        let title: String = connection
            .query_row(
                "SELECT title FROM tasks WHERE id = ?1",
                ["11111111-1111-7111-8111-111111111111"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Legacy task");

        let (remind_at, anchor, source, completion_op): (
            Option<String>,
            Option<i64>,
            Option<String>,
            Option<String>,
        ) = connection
            .query_row(
                "SELECT remind_at, recurrence_anchor_day, recurrence_source_id,
                        completion_operation_id
                 FROM tasks WHERE id = ?1",
                ["11111111-1111-7111-8111-111111111111"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(remind_at, None);
        assert_eq!(anchor, None);
        assert_eq!(source, None);
        assert_eq!(completion_op, None);

        let backups = pre_migration_backups(db.profile_dir());
        assert_eq!(backups.len(), 1);
        let backup_path = &backups[0];
        let name = backup_path.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with(PRE_V2_BACKUP_PREFIX));
        assert!(name.ends_with(PRE_V2_BACKUP_SUFFIX));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_mode = fs::metadata(backup_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(file_mode, 0o600);
            let dir_mode = fs::metadata(backup_path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(dir_mode, 0o700);
        }

        // Backup reopens read-only as schema v2 with a clean integrity check.
        verify_pre_v2_backup(backup_path).unwrap();
        let backup = open_readonly(backup_path).unwrap();
        let backup_title: String = backup
            .query_row(
                "SELECT title FROM tasks WHERE id = ?1",
                ["11111111-1111-7111-8111-111111111111"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(backup_title, "Legacy task");
        assert!(!table_names(&backup).contains("app_settings"));
        assert!(!task_columns(&backup).contains(&"remind_at".to_owned()));
    }

    #[test]
    fn v3_cancellation_transition_backfills_and_migration_retries_safely() {
        let db = TestDb::new();
        let mut connection = db.open();
        seed_v3_with_sample_rows(&mut connection);
        connection
            .execute_batch(
                "
INSERT INTO tasks(id, title, status, created_at, updated_at, revision)
VALUES (
    '33333333-3333-7333-8333-333333333333',
    'Cancelled task',
    'cancelled',
    '2026-03-01T12:00:00Z',
    '2026-03-08T12:00:00Z',
    3
);
INSERT INTO task_activity(
    revision, sequence, operation_id, task_id, action, field, old_value, new_value, created_at
) VALUES
    (2, 0, '22222222-2222-7222-8222-222222222222',
     '33333333-3333-7333-8333-333333333333', 'cancelled', 'status', 'pending', 'cancelled',
     '2026-03-07T23:59:59Z'),
    (3, 0, '44444444-4444-7444-8444-444444444444',
     '33333333-3333-7333-8333-333333333333', 'updated', 'title', 'Cancelled task', 'Edited',
     '2026-03-08T12:00:00Z');
",
            )
            .unwrap();

        db.migrate(&mut connection).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 6);
        let cancelled_at: Option<String> = connection
            .query_row(
                "SELECT cancelled_at FROM tasks WHERE id = '33333333-3333-7333-8333-333333333333'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cancelled_at.as_deref(), Some("2026-03-07T23:59:59Z"));

        // An exact open/retry must leave the already-backfilled value intact.
        db.migrate(&mut connection).unwrap();
        let retried: Option<String> = connection
            .query_row(
                "SELECT cancelled_at FROM tasks WHERE id = '33333333-3333-7333-8333-333333333333'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retried, cancelled_at);
    }

    #[test]
    fn v3_cancellation_undo_snapshot_reconciles_with_live_backfill() {
        let db = TestDb::new();
        let mut connection = db.open();
        seed_v3_with_sample_rows(&mut connection);
        let task_id = TaskId::parse("55555555-5555-7555-8555-555555555555").unwrap();
        let source_operation_id =
            OperationId::parse("33333333-3333-7333-8333-333333333333").unwrap();
        let undo_operation_id = OperationId::parse("44444444-4444-7444-8444-444444444444").unwrap();
        let redo_operation_id = OperationId::parse("66666666-6666-7666-8666-666666666666").unwrap();
        let before = v3_task_snapshot(
            &task_id.to_string(),
            "Cancelled task",
            TaskStatus::Pending,
            "2026-03-01T12:00:00Z",
            2,
        );
        let after = v3_task_snapshot(
            &task_id.to_string(),
            "Cancelled task",
            TaskStatus::Cancelled,
            "2026-03-07T23:59:59Z",
            3,
        );
        insert_v3_task(&connection, &after);
        connection
            .execute(
                "INSERT INTO task_activity(
                    revision, sequence, operation_id, task_id, action, field,
                    old_value, new_value, created_at
                 ) VALUES (3, 0, ?1, ?2, 'cancelled', 'status', 'pending', 'cancelled', ?3)",
                rusqlite::params![
                    source_operation_id.to_string(),
                    task_id.to_string(),
                    "2026-03-07T23:59:59Z",
                ],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE app_state SET global_revision = 3 WHERE singleton = 1",
                [],
            )
            .unwrap();
        let inverse = restore_tasks_inverse(vec![before], Vec::new());
        let post = post_from_tasks([after]);
        insert_v3_undo(&connection, source_operation_id, 3, &inverse, &post);

        db.migrate(&mut connection).unwrap();

        let (request_json, response_json, post_image_json): (String, String, String) = connection
            .query_row(
                "SELECT r.request_json, r.response_json, u.post_image_json
                 FROM operation_receipts r
                 JOIN operation_undo u ON u.source_operation_id = r.operation_id
                 WHERE r.operation_id = ?1",
                [source_operation_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(request_json, "{\"op\":\"legacy\"}");
        assert_eq!(response_json, "{\"legacy\":true}");
        let migrated_post: PostImage = serde_json::from_str(&post_image_json).unwrap();
        assert_eq!(
            migrated_post.tasks[&task_id.to_string()]
                .cancelled_at
                .unwrap()
                .to_string(),
            "2026-03-07T23:59:59Z"
        );

        let undone = crate::undo_ops::undo(
            &mut connection,
            source_operation_id,
            undo_operation_id,
            "2026-03-12T12:00:00Z".parse().unwrap(),
        )
        .unwrap();
        assert_eq!(
            load_task(&mut connection, task_id).status,
            TaskStatus::Pending
        );
        let replay = crate::undo_ops::undo(
            &mut connection,
            source_operation_id,
            undo_operation_id,
            "2026-03-13T12:00:00Z".parse().unwrap(),
        )
        .unwrap();
        assert_eq!(replay, undone);

        crate::undo_ops::undo(
            &mut connection,
            undo_operation_id,
            redo_operation_id,
            "2026-03-14T12:00:00Z".parse().unwrap(),
        )
        .unwrap();
        let redone = load_task(&mut connection, task_id);
        assert_eq!(redone.status, TaskStatus::Cancelled);
        assert_eq!(
            redone.cancelled_at.unwrap().to_string(),
            "2026-03-07T23:59:59Z"
        );
    }

    #[test]
    fn v3_reopen_undo_restores_cancellation_to_its_original_week() {
        let db = TestDb::new();
        let mut connection = db.open();
        seed_v3_with_sample_rows(&mut connection);
        let task_id = TaskId::parse("55555555-5555-7555-8555-555555555555").unwrap();
        let source_operation_id =
            OperationId::parse("33333333-3333-7333-8333-333333333333").unwrap();
        let undo_operation_id = OperationId::parse("44444444-4444-7444-8444-444444444444").unwrap();
        let cancelled = v3_task_snapshot(
            &task_id.to_string(),
            "Edited while cancelled",
            TaskStatus::Cancelled,
            "2026-03-10T12:00:00Z",
            3,
        );
        let reopened = v3_task_snapshot(
            &task_id.to_string(),
            "Edited while cancelled",
            TaskStatus::Pending,
            "2026-03-16T12:00:00Z",
            4,
        );
        insert_v3_task(&connection, &reopened);
        connection
            .execute_batch(&format!(
                "INSERT INTO task_activity(
                    revision, sequence, operation_id, task_id, action, field,
                    old_value, new_value, created_at
                 ) VALUES
                    (2, 0, '77777777-7777-7777-8777-777777777777', '{task_id}',
                     'cancelled', 'status', 'pending', 'cancelled', '2026-03-09T12:00:00Z'),
                    (3, 0, '88888888-8888-7888-8888-888888888888', '{task_id}',
                     'updated', 'title', 'Cancelled task', 'Edited while cancelled',
                     '2026-03-10T12:00:00Z'),
                    (4, 0, '{source_operation_id}', '{task_id}',
                     'reopened', 'status', 'cancelled', 'pending', '2026-03-16T12:00:00Z');
                 UPDATE app_state SET global_revision = 4 WHERE singleton = 1;"
            ))
            .unwrap();
        let inverse = restore_tasks_inverse(vec![cancelled], Vec::new());
        let post = post_from_tasks([reopened]);
        insert_v3_undo(&connection, source_operation_id, 4, &inverse, &post);

        db.migrate(&mut connection).unwrap();
        crate::undo_ops::undo(
            &mut connection,
            source_operation_id,
            undo_operation_id,
            "2026-03-17T12:00:00Z".parse().unwrap(),
        )
        .unwrap();

        let restored = load_task(&mut connection, task_id);
        assert_eq!(restored.status, TaskStatus::Cancelled);
        assert_eq!(
            restored.cancelled_at.unwrap().to_string(),
            "2026-03-09T12:00:00Z"
        );
        let correct_week = weekly_review_summary(
            std::slice::from_ref(&restored),
            &[],
            "2026-03-18".parse().unwrap(),
            WeekStart::Sunday,
            &TimeZone::UTC,
        )
        .unwrap();
        assert_eq!(correct_week.cancelled_count, 1);
        let following_week = weekly_review_summary(
            &[restored],
            &[],
            "2026-03-25".parse().unwrap(),
            WeekStart::Sunday,
            &TimeZone::UTC,
        )
        .unwrap();
        assert_eq!(following_week.cancelled_count, 0);
    }

    #[test]
    fn multiple_v3_undo_rows_reconcile_across_rollback_retry_and_rerun() {
        let db = TestDb::new();
        let mut connection = db.open();
        seed_v3_with_sample_rows(&mut connection);
        let task_id = TaskId::parse("55555555-5555-7555-8555-555555555555").unwrap();
        let source_operation_ids = [
            OperationId::parse("20000000-0000-7000-8000-000000000001").unwrap(),
            OperationId::parse("30000000-0000-7000-8000-000000000002").unwrap(),
            OperationId::parse("40000000-0000-7000-8000-000000000003").unwrap(),
        ];
        let cancelled = v3_task_snapshot(
            &task_id.to_string(),
            "Cancelled task",
            TaskStatus::Cancelled,
            "2026-03-08T12:00:00Z",
            2,
        );
        insert_v3_task(&connection, &cancelled);
        connection
            .execute_batch(&format!(
                "INSERT INTO task_activity(
                    revision, sequence, operation_id, task_id, action, field,
                    old_value, new_value, created_at
                 ) VALUES (2, 0, '{}', '{task_id}',
                           'cancelled', 'status', 'pending', 'cancelled',
                           '2026-03-08T12:00:00Z');
                 UPDATE app_state SET global_revision = 4 WHERE singleton = 1;",
                source_operation_ids[0]
            ))
            .unwrap();

        let mut original_payloads = Vec::new();
        for (index, source_operation_id) in source_operation_ids.iter().copied().enumerate() {
            let revision = u64::try_from(index).unwrap() + 2;
            let inverse = restore_tasks_inverse(
                vec![v3_task_snapshot(
                    &task_id.to_string(),
                    "Cancelled task",
                    TaskStatus::Pending,
                    "2026-03-01T12:00:00Z",
                    revision - 1,
                )],
                Vec::new(),
            );
            let mut post_task = cancelled.clone();
            post_task.revision = revision;
            let post = post_from_tasks([post_task]);
            let payloads =
                insert_v3_undo(&connection, source_operation_id, revision, &inverse, &post);
            original_payloads.push((source_operation_id.to_string(), payloads));
        }
        connection
            .execute_batch(&format!(
                "CREATE TRIGGER fail_last_undo_reconciliation
                 BEFORE UPDATE ON operation_undo
                 WHEN OLD.source_operation_id = '{}'
                 BEGIN
                     SELECT RAISE(ABORT, 'injected final undo reconciliation failure');
                 END;",
                source_operation_ids[2]
            ))
            .unwrap();

        let error = db.migrate(&mut connection).unwrap_err().to_string();
        assert!(error.contains("injected final undo reconciliation failure"));
        assert_eq!(current_version(&connection).unwrap(), 3);
        assert!(!task_columns(&connection).contains(&"cancelled_at".to_owned()));
        for (source_operation_id, original) in &original_payloads {
            let rolled_back: (String, String) = connection
                .query_row(
                    "SELECT inverse_json, post_image_json FROM operation_undo
                     WHERE source_operation_id = ?1",
                    [source_operation_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(&rolled_back, original);
        }

        connection
            .execute_batch("DROP TRIGGER fail_last_undo_reconciliation;")
            .unwrap();
        db.migrate(&mut connection).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 6);

        let mut migrated_rows = Vec::new();
        for (source_operation_id, original) in &original_payloads {
            let migrated: (String, String, String, String) = connection
                .query_row(
                    "SELECT r.request_json, r.response_json, u.inverse_json, u.post_image_json
                     FROM operation_receipts r
                     JOIN operation_undo u ON u.source_operation_id = r.operation_id
                     WHERE r.operation_id = ?1",
                    [source_operation_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap();
            assert_eq!(migrated.0, "{\"op\":\"legacy\"}");
            assert_eq!(migrated.1, "{\"legacy\":true}");
            assert_ne!(migrated.3, original.1);
            let post: PostImage = serde_json::from_str(&migrated.3).unwrap();
            assert_eq!(
                post.tasks[&task_id.to_string()]
                    .cancelled_at
                    .unwrap()
                    .to_string(),
                "2026-03-08T12:00:00Z"
            );
            migrated_rows.push(migrated);
        }

        db.migrate(&mut connection).unwrap();
        for ((source_operation_id, _), migrated) in original_payloads.iter().zip(migrated_rows) {
            let rerun: (String, String, String, String) = connection
                .query_row(
                    "SELECT r.request_json, r.response_json, u.inverse_json, u.post_image_json
                     FROM operation_receipts r
                     JOIN operation_undo u ON u.source_operation_id = r.operation_id
                     WHERE r.operation_id = ?1",
                    [source_operation_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap();
            assert_eq!(rerun, migrated);
        }
    }

    #[test]
    fn failed_v4_rolls_back_and_retry_succeeds() {
        let db = TestDb::new();
        let mut connection = db.open();
        seed_v3_with_sample_rows(&mut connection);
        connection
            .execute_batch(
                "
UPDATE tasks
SET status = 'cancelled', updated_at = '2026-03-08T12:00:00Z'
WHERE id = '11111111-1111-7111-8111-111111111111';
CREATE TRIGGER fail_cancel_backfill BEFORE UPDATE ON tasks
BEGIN
    SELECT RAISE(ABORT, 'injected cancellation backfill failure');
END;
",
            )
            .unwrap();

        let error = db.migrate(&mut connection).unwrap_err().to_string();
        assert!(error.contains("injected cancellation backfill failure"));
        assert_eq!(current_version(&connection).unwrap(), 3);
        assert!(!task_columns(&connection).contains(&"cancelled_at".to_owned()));

        connection
            .execute_batch("DROP TRIGGER fail_cancel_backfill;")
            .unwrap();
        db.migrate(&mut connection).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 6);
        let cancelled_at: Option<String> = connection
            .query_row(
                "SELECT cancelled_at FROM tasks WHERE id = '11111111-1111-7111-8111-111111111111'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cancelled_at.as_deref(), Some("2026-03-08T12:00:00Z"));
    }

    #[test]
    fn failed_v3_rolls_back_keeps_backup_and_retry_succeeds() {
        let db = TestDb::new();
        let mut connection = db.open();
        seed_v2_with_sample_rows(&mut connection);

        // Collision with a v3 table created after the tasks ALTER statements.
        connection
            .execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY);")
            .unwrap();

        let err = db.migrate(&mut connection).unwrap_err();
        assert!(
            err.to_string().contains("app_settings")
                || matches!(err, rusqlite::Error::SqliteFailure(..)),
            "unexpected error: {err}"
        );

        // v2 remains authoritative.
        assert_eq!(current_version(&connection).unwrap(), 2);
        assert!(!task_columns(&connection).contains(&"remind_at".to_owned()));
        assert!(!table_names(&connection).contains("reminder_occurrences"));

        // Verified backup is retained for recovery; prune does not run on failure.
        let backups = pre_migration_backups(db.profile_dir());
        assert_eq!(backups.len(), 1);
        verify_pre_v2_backup(&backups[0]).unwrap();

        let title: String = connection
            .query_row(
                "SELECT title FROM tasks WHERE id = ?1",
                ["11111111-1111-7111-8111-111111111111"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Legacy task");

        connection
            .execute_batch("DROP TABLE app_settings;")
            .unwrap();
        db.migrate(&mut connection).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 6);
        assert!(table_names(&connection).contains("app_settings"));
        assert!(table_names(&connection).contains("time_slot_tasks"));
        assert!(task_columns(&connection).contains(&"completion_operation_id".to_owned()));

        // Exact retry leaves usable backups (at least the successful attempt's snapshot).
        let backups_after = pre_migration_backups(db.profile_dir());
        assert!(!backups_after.is_empty());
        assert!(backups_after.len() <= PRE_MIGRATION_BACKUP_RETAIN);
        for path in &backups_after {
            verify_pre_v2_backup(path).unwrap();
        }
    }

    #[test]
    fn pre_migration_backup_retention_keeps_newest_three() {
        let db = TestDb::new();
        let mut connection = db.open();
        seed_v2_with_sample_rows(&mut connection);

        let backup_dir = db.profile_dir().join(PRE_MIGRATION_BACKUP_DIR);
        crate::ensure_private_dir(&db.profile_dir().join("backups")).unwrap();
        crate::ensure_private_dir(&backup_dir).unwrap();

        // Four older verified-looking names; contents need not be valid — only the
        // migration-created backup is re-verified before prune runs.
        for stamp in [
            "2020-01-01T00-00-00Z",
            "2020-01-02T00-00-00Z",
            "2020-01-03T00-00-00Z",
            "2020-01-04T00-00-00Z",
        ] {
            let path = backup_dir.join(format!(
                "{PRE_V2_BACKUP_PREFIX}{stamp}{PRE_V2_BACKUP_SUFFIX}"
            ));
            fs::write(&path, b"stale-pre-migration-placeholder").unwrap();
            crate::set_private_file_permissions(&path).unwrap();
        }
        assert_eq!(pre_migration_backups(db.profile_dir()).len(), 4);

        db.migrate(&mut connection).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 6);

        let mut remaining = pre_migration_backups(db.profile_dir());
        remaining.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        assert_eq!(remaining.len(), PRE_MIGRATION_BACKUP_RETAIN);

        // Newest three by filename: the fresh backup plus Jan 4 and Jan 3.
        let names: Vec<_> = remaining
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names[0].starts_with(PRE_V2_BACKUP_PREFIX));
        assert!(!names.iter().any(|n| n.contains("2020-01-01")));
        assert!(!names.iter().any(|n| n.contains("2020-01-02")));
        assert!(names.iter().any(|n| n.contains("2020-01-03")));
        assert!(names.iter().any(|n| n.contains("2020-01-04")));

        // The migration-created backup is still a true verified v2 snapshot.
        let fresh = remaining
            .iter()
            .find(|p| {
                !p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains("2020-01-")
            })
            .expect("fresh pre-v2 backup");
        verify_pre_v2_backup(fresh).unwrap();
    }

    #[test]
    fn migrate_v4_to_v5_preserves_legacy_temporal_settings_and_stamps_epoch() {
        let db = TestDb::new();
        let mut connection = db.open();
        db.migrate(&mut connection).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 6);

        // Rewrite the profile back to a Phase 3/v4 settings shape, then re-run migrate.
        connection
            .execute_batch(
                r#"
DELETE FROM schema_migrations WHERE version >= 5;
DROP TABLE IF EXISTS ai_run_state;
DROP TABLE IF EXISTS ai_tool_approvals;
DROP TABLE IF EXISTS ai_session_memories;
DROP TABLE IF EXISTS ai_messages;
DROP TABLE IF EXISTS ai_memories;
DROP TABLE IF EXISTS ai_sessions;
DROP TABLE IF EXISTS ai_quota;
DELETE FROM app_settings;
DROP TABLE app_settings;
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (key IN (
        'notification_channels',
        'reminder_defaults',
        'capacity',
        'work_hours',
        'week_start',
        'nudge_rules'
    ))
);
ALTER TABLE app_state DROP COLUMN event_epoch;
INSERT INTO app_settings(key, value_json, updated_at) VALUES
    ('week_start', '"monday"', '2026-07-28T12:00:00Z'),
    ('capacity', '240', '2026-07-28T12:00:00Z');
"#,
            )
            .unwrap();
        assert_eq!(current_version(&connection).unwrap(), 4);

        db.migrate(&mut connection).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 6);

        let epoch: String = connection
            .query_row(
                "SELECT event_epoch FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!epoch.is_empty());

        let settings_json: String = connection
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = 'settings_json'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let settings: junban_domain::AppSettings = serde_json::from_str(&settings_json).unwrap();
        assert_eq!(
            settings.date_time.week_start,
            junban_domain::WeekStart::Monday
        );
        assert_eq!(settings.planning.capacity_minutes, 240);
        assert_eq!(settings.notifications.volume_percent.get(), 70);
        assert_eq!(settings.appearance.theme, junban_domain::Theme::Light);
        assert_eq!(settings.appearance.accent.as_str(), "#3b82f6");
        assert_eq!(
            settings.appearance.density,
            junban_domain::Density::Comfortable
        );
        assert_eq!(
            settings.appearance.font_family,
            junban_domain::FontFamily::Outfit
        );
        assert_eq!(
            settings.date_time.date_format,
            junban_domain::DateFormat::Short
        );
        assert_eq!(
            settings.date_time.time_format,
            junban_domain::TimeFormat::H24
        );
        assert_eq!(
            settings.task_defaults.default_view,
            junban_domain::TaskViewPreset::Today
        );
        assert!(settings.task_defaults.confirm_before_delete);
        assert_eq!(
            settings.keyboard_shortcuts.len(),
            junban_domain::KEYBOARD_SHORTCUT_ACTIONS.len()
        );
        assert!(!settings.ai.enabled);
        assert!(!settings.voice.cloud_speech_enabled);
        assert!(settings.ai.credential_id.is_none());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM app_settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let ai_tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'ai_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(ai_tables >= 7);
    }

    #[test]
    fn migrate_v5_to_v6_is_idempotent_and_preserves_settings() {
        let db = TestDb::new();
        let mut connection = db.open();
        db.migrate(&mut connection).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 6);

        // Roll back only the v6 marker and AI tables, keep v5 settings blob.
        let settings_json: String = connection
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = 'settings_json'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let mut settings: junban_domain::AppSettings =
            serde_json::from_str(&settings_json).unwrap();
        settings.planning.capacity_minutes = 300;
        // Simulate a hostile pre-v6 snapshot that somehow carried bindings.
        settings.ai.enabled = true;
        settings.ai.provider = Some(junban_domain::AiProviderPreset::OpenAi);
        settings.ai.credential_id = Some(junban_domain::AiCredentialId::new());
        let hostile = serde_json::to_string(&settings).unwrap();
        connection
            .execute_batch(
                r#"
DELETE FROM schema_migrations WHERE version = 6;
DROP TABLE IF EXISTS ai_run_state;
DROP TABLE IF EXISTS ai_tool_approvals;
DROP TABLE IF EXISTS ai_session_memories;
DROP TABLE IF EXISTS ai_messages;
DROP TABLE IF EXISTS ai_memories;
DROP TABLE IF EXISTS ai_sessions;
DROP TABLE IF EXISTS ai_quota;
"#,
            )
            .unwrap();
        connection
            .execute(
                "UPDATE app_settings SET value_json = ?1 WHERE key = 'settings_json'",
                [&hostile],
            )
            .unwrap();
        assert_eq!(current_version(&connection).unwrap(), 5);

        db.migrate(&mut connection).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 6);
        // Failed migration rollback: force a mid-migration failure path by retrying.
        db.migrate(&mut connection).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 6);

        let settings_json: String = connection
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = 'settings_json'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let settings: junban_domain::AppSettings = serde_json::from_str(&settings_json).unwrap();
        assert_eq!(settings.planning.capacity_minutes, 300);
        assert!(!settings.ai.enabled);
        assert!(settings.ai.credential_id.is_none());
        assert_eq!(
            settings.ai.provider,
            Some(junban_domain::AiProviderPreset::OpenAi)
        );

        let approval_index_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_ai_run_state_approval'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            approval_index_sql.contains("approval_id")
                && approval_index_sql.contains("WHERE")
                && approval_index_sql.contains("approval_id IS NOT NULL"),
            "v5→v6 must create partial ai_run_state.approval_id index: {approval_index_sql}"
        );
        let assistant_not_null: i64 = connection
            .query_row(
                "SELECT \"notnull\" FROM pragma_table_info('ai_run_state')
                 WHERE name = 'assistant_message_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(assistant_not_null, 1);
        let run_schema: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_run_state'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(run_schema.contains("assistant_message_id TEXT NOT NULL UNIQUE"));
    }

    #[test]
    fn schema_v5_enforces_lineage_settings_and_membership_uniqueness() {
        let db = TestDb::new();
        let mut connection = db.open();
        db.migrate(&mut connection).unwrap();

        connection
            .execute(
                "INSERT INTO tasks(
                    id, title, status, completed_at, created_at, updated_at, revision
                ) VALUES (
                    'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
                    'Source',
                    'completed',
                    '2026-07-28T12:00:00Z',
                    '2026-07-28T12:00:00Z',
                    '2026-07-28T12:00:00Z',
                    1
                )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO tasks(
                    id, title, status, recurrence_source_id, recurrence_anchor_day,
                    created_at, updated_at, revision
                ) VALUES (
                    'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
                    'Child',
                    'pending',
                    'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
                    31,
                    '2026-07-28T12:00:00Z',
                    '2026-07-28T12:00:00Z',
                    1
                )",
                [],
            )
            .unwrap();

        let duplicate_lineage = connection.execute(
            "INSERT INTO tasks(
                id, title, status, recurrence_source_id,
                created_at, updated_at, revision
            ) VALUES (
                'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
                'Twin',
                'pending',
                'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
                '2026-07-28T12:00:00Z',
                '2026-07-28T12:00:00Z',
                1
            )",
            [],
        );
        assert!(duplicate_lineage.is_err());

        let bad_anchor = connection.execute(
            "UPDATE tasks SET recurrence_anchor_day = 32
             WHERE id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb'",
            [],
        );
        assert!(bad_anchor.is_err());

        // v5 drops the Phase 3 key allowlist; arbitrary keys are storage-legal.
        connection
            .execute(
                "INSERT INTO app_settings(key, value_json, updated_at)
                 VALUES ('theme', '{}', '2026-07-28T12:00:00Z')",
                [],
            )
            .unwrap();

        connection
            .execute(
                "INSERT INTO app_settings(key, value_json, updated_at)
                 VALUES ('week_start', '{\"day\":\"monday\"}', '2026-07-28T12:00:00Z')",
                [],
            )
            .unwrap();

        let settings_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = 'settings_json'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(settings_count, 1);

        connection
            .execute(
                "INSERT INTO time_slots(
                    id, title, civil_date, start_time, end_time, timezone,
                    created_at, updated_at, revision
                ) VALUES (
                    'slot-1', 'Morning', '2026-07-28', '09:00:00', '11:00:00', 'UTC',
                    '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z', 1
                )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO time_slot_tasks(slot_id, task_id, position)
                 VALUES ('slot-1', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 0)",
                [],
            )
            .unwrap();
        let duplicate_membership = connection.execute(
            "INSERT INTO time_slot_tasks(slot_id, task_id, position)
             VALUES ('slot-1', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 1)",
            [],
        );
        assert!(duplicate_membership.is_err());
        let duplicate_position = connection.execute(
            "INSERT INTO time_slot_tasks(slot_id, task_id, position)
             VALUES ('slot-1', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 0)",
            [],
        );
        assert!(duplicate_position.is_err());

        let bad_channel = connection.execute(
            "INSERT INTO reminder_occurrences(
                task_id, remind_at, state, terminal_channel, created_at, updated_at
             ) VALUES (
                'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
                '2026-07-28T13:00:00Z',
                'delivered',
                'email',
                '2026-07-28T12:00:00Z',
                '2026-07-28T12:00:00Z'
             )",
            [],
        );
        assert!(bad_channel.is_err());

        connection
            .execute(
                "INSERT INTO reminder_delivery_lease(
                    singleton, fence_term, expires_at, updated_at
                 ) VALUES (
                    1, 'fence-1', '2026-07-28T12:01:30Z', '2026-07-28T12:00:00Z'
                 )",
                [],
            )
            .unwrap();
        let second_lease = connection.execute(
            "INSERT INTO reminder_delivery_lease(
                singleton, fence_term, expires_at, updated_at
             ) VALUES (
                2, 'fence-2', '2026-07-28T12:01:30Z', '2026-07-28T12:00:00Z'
             )",
            [],
        );
        assert!(second_lease.is_err());
    }

    #[test]
    fn schema_rejects_self_parent_self_relation_bounds_and_due_pair() {
        let db = TestDb::new();
        let mut connection = db.open();
        db.migrate(&mut connection).unwrap();

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
        db.migrate(&mut connection).unwrap();

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
        db.migrate(&mut connection).unwrap();

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
