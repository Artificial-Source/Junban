//! Task list queries with typed filters and keyset pagination.

use jiff::{Timestamp, civil::Date};
use junban_app::{RepositoryError, TaskListAsOf, TaskListPage};
use junban_domain::{
    MAX_QUERY_PAGE_LIMIT, MAX_TASK_TITLE_CHARS, Priority, ProjectId, TaskCursor, TaskId, TaskQuery,
    TaskSort, TaskViewPreset, ValidationError,
};
use rusqlite::{Connection, OptionalExtension};

use crate::helpers::validation;
use crate::ops_types::status_name;
use crate::rows::{load_task, parse_sql, resolve_tag_names, storage_error};
use crate::tx::global_revision;

fn escape_like(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

fn resolve_query_names(
    tx: &rusqlite::Transaction<'_>,
    query: &mut TaskQuery,
) -> Result<(), RepositoryError> {
    if let Some(name) = query.filter.project_name.take() {
        let id: Option<String> = tx
            .query_row(
                "SELECT id FROM projects WHERE lower(name) = lower(?1) LIMIT 1",
                [name.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        query.filter.project_id = Some(match id {
            Some(id) => Some(ProjectId::parse(&id).map_err(storage_error)?),
            None => Some(ProjectId::new()),
        });
    }
    if !query.filter.tag_names.is_empty() {
        let mut ids = resolve_tag_names(tx, &query.filter.tag_names)?;
        ids.extend(query.filter.tag_ids.iter().copied());
        ids.sort_by_key(|id| id.as_uuid());
        ids.dedup();
        query.filter.tag_ids = ids;
        query.filter.tag_names.clear();
    }
    Ok(())
}

fn validate_cursor(sort: TaskSort, cursor: &TaskCursor) -> Result<(), ValidationError> {
    match sort {
        TaskSort::SortOrderAsc => {
            if cursor.sort_value.parse::<i64>().is_err() {
                return Err(ValidationError::InvalidFormat {
                    field: "cursor",
                    expected: "integer sort_order",
                });
            }
        }
        TaskSort::CreatedAsc | TaskSort::CreatedDesc | TaskSort::UpdatedDesc => {
            if cursor.sort_value.parse::<Timestamp>().is_err() {
                return Err(ValidationError::InvalidFormat {
                    field: "cursor",
                    expected: "RFC3339 timestamp",
                });
            }
        }
        TaskSort::DueAsc => {
            // Null due dates use the documented high sentinel.
            if cursor.sort_value != "9999-99-99" && cursor.sort_value.parse::<Date>().is_err() {
                return Err(ValidationError::InvalidFormat {
                    field: "cursor",
                    expected: "YYYY-MM-DD or 9999-99-99",
                });
            }
        }
        TaskSort::DueDesc => {
            // Null due dates use the empty-string sentinel.
            if !cursor.sort_value.is_empty() && cursor.sort_value.parse::<Date>().is_err() {
                return Err(ValidationError::InvalidFormat {
                    field: "cursor",
                    expected: "YYYY-MM-DD or empty null sentinel",
                });
            }
        }
        TaskSort::PriorityAsc => {
            if cursor.sort_value == "99" {
                // Documented null-priority sentinel.
            } else {
                let value = cursor.sort_value.parse::<u8>().map_err(|_| {
                    ValidationError::InvalidFormat {
                        field: "cursor",
                        expected: "priority 1-4 or 99",
                    }
                })?;
                Priority::new(value).map_err(|_| ValidationError::InvalidFormat {
                    field: "cursor",
                    expected: "priority 1-4 or 99",
                })?;
            }
        }
        TaskSort::TitleAsc => {
            if cursor.sort_value.is_empty()
                || cursor.sort_value.chars().count() > MAX_TASK_TITLE_CHARS
            {
                return Err(ValidationError::InvalidFormat {
                    field: "cursor",
                    expected: "non-empty title within task title limits",
                });
            }
        }
    }
    Ok(())
}

pub(crate) fn list_tasks(
    connection: &Connection,
    mut query: TaskQuery,
    as_of: TaskListAsOf,
) -> Result<TaskListPage, RepositoryError> {
    query.validate().map_err(validation)?;
    if let Some(cursor) = &query.cursor {
        validate_cursor(query.sort, cursor).map_err(validation)?;
    }
    let limit = query
        .limit
        .unwrap_or(MAX_QUERY_PAGE_LIMIT)
        .min(MAX_QUERY_PAGE_LIMIT);
    let revision = global_revision(connection)?;
    let tx = connection.unchecked_transaction().map_err(storage_error)?;
    resolve_query_names(&tx, &mut query)?;

    let mut sql = String::from("SELECT t.id FROM tasks t WHERE 1=1");
    let mut binds: Vec<rusqlite::types::Value> = Vec::new();

    macro_rules! bind_text {
        ($v:expr) => {{
            binds.push(rusqlite::types::Value::Text($v));
            sql.push('?');
        }};
    }
    macro_rules! bind_i64 {
        ($v:expr) => {{
            binds.push(rusqlite::types::Value::Integer($v));
            sql.push('?');
        }};
    }

    match query.view {
        Some(TaskViewPreset::Inbox) => {
            // Compare UTC instants via unixepoch so mixed fractional-second text forms stay ordered.
            sql.push_str(" AND t.project_id IS NULL AND t.someday = 0 AND (t.status = 'pending' OR (t.status = 'completed' AND t.completed_at IS NOT NULL AND unixepoch(t.completed_at) >= ");
            bind_i64!(as_of.recent_completed_from.as_second());
            sql.push_str(" AND unixepoch(t.completed_at) < ");
            bind_i64!(as_of.recent_completed_until.as_second());
            sql.push_str("))");
        }
        Some(TaskViewPreset::Today) => {
            sql.push_str(" AND t.status = 'pending' AND t.due_date IS NOT NULL AND t.due_date <= ");
            bind_text!(as_of.as_of_date.to_string());
        }
        Some(TaskViewPreset::Upcoming) => {
            sql.push_str(" AND t.status = 'pending' AND t.due_date IS NOT NULL AND t.due_date <> ");
            bind_text!(as_of.as_of_date.to_string());
        }
        Some(TaskViewPreset::Someday) => {
            sql.push_str(" AND t.status = 'pending' AND t.someday = 1");
        }
        // Completed matches the approved history presentation: completed + cancelled.
        // Cancelled remains the cancelled-only preset.
        Some(TaskViewPreset::Completed) => {
            sql.push_str(" AND (t.status = 'completed' OR t.status = 'cancelled')");
        }
        Some(TaskViewPreset::Cancelled) => sql.push_str(" AND t.status = 'cancelled'"),
        Some(TaskViewPreset::Project) | None => {}
    }

    if !query.filter.statuses.is_empty() {
        sql.push_str(" AND t.status IN (");
        for (i, status) in query.filter.statuses.iter().enumerate() {
            if i > 0 {
                sql.push(',');
            }
            bind_text!(status_name(*status).to_owned());
        }
        sql.push(')');
    }
    if let Some(project) = query.filter.project_id {
        match project {
            Some(id) => {
                sql.push_str(" AND t.project_id = ");
                bind_text!(id.to_string());
            }
            None => sql.push_str(" AND t.project_id IS NULL"),
        }
    }
    if let Some(section) = query.filter.section_id {
        match section {
            Some(id) => {
                sql.push_str(" AND t.section_id = ");
                bind_text!(id.to_string());
            }
            None => sql.push_str(" AND t.section_id IS NULL"),
        }
    }
    if let Some(parent) = query.filter.parent_id {
        match parent {
            Some(id) => {
                sql.push_str(" AND t.parent_id = ");
                bind_text!(id.to_string());
            }
            None => sql.push_str(" AND t.parent_id IS NULL"),
        }
    }
    if let Some(priority) = query.filter.priority {
        sql.push_str(" AND t.priority = ");
        bind_i64!(i64::from(priority.get()));
    }
    if let Some(due_on) = query.filter.due_on {
        sql.push_str(" AND t.due_date = ");
        bind_text!(due_on.to_string());
    }
    if let Some(due_before) = query.filter.due_before {
        sql.push_str(" AND t.due_date IS NOT NULL AND t.due_date <= ");
        bind_text!(due_before.to_string());
    }
    if let Some(due_after) = query.filter.due_after {
        sql.push_str(" AND t.due_date IS NOT NULL AND t.due_date >= ");
        bind_text!(due_after.to_string());
    }
    if let Some(someday) = query.filter.someday {
        sql.push_str(" AND t.someday = ");
        bind_i64!(i64::from(someday));
    }
    if query.filter.overdue == Some(true) {
        sql.push_str(" AND t.status = 'pending' AND t.due_date IS NOT NULL AND t.due_date < ");
        bind_text!(as_of.as_of_date.to_string());
    }
    for tag_id in &query.filter.tag_ids {
        sql.push_str(
            " AND EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag_id = ",
        );
        bind_text!(tag_id.to_string());
        sql.push(')');
    }
    if let Some(search) = &query.filter.search {
        let pattern = format!("%{}%", escape_like(search));
        sql.push_str(" AND (t.title LIKE ");
        bind_text!(pattern.clone());
        sql.push_str(" ESCAPE '\\' OR t.description LIKE ");
        bind_text!(pattern);
        sql.push_str(" ESCAPE '\\')");
    }

    if let Some(cursor) = &query.cursor {
        match query.sort {
            TaskSort::SortOrderAsc => {
                let order: i64 = cursor
                    .sort_value
                    .parse()
                    .expect("cursor validated as integer sort_order");
                sql.push_str(" AND (t.sort_order > ");
                bind_i64!(order);
                sql.push_str(" OR (t.sort_order = ");
                bind_i64!(order);
                sql.push_str(" AND t.id > ");
                bind_text!(cursor.task_id.to_string());
                sql.push_str("))");
            }
            TaskSort::CreatedAsc => {
                sql.push_str(" AND (t.created_at > ");
                bind_text!(cursor.sort_value.clone());
                sql.push_str(" OR (t.created_at = ");
                bind_text!(cursor.sort_value.clone());
                sql.push_str(" AND t.id > ");
                bind_text!(cursor.task_id.to_string());
                sql.push_str("))");
            }
            TaskSort::CreatedDesc => {
                sql.push_str(" AND (t.created_at < ");
                bind_text!(cursor.sort_value.clone());
                sql.push_str(" OR (t.created_at = ");
                bind_text!(cursor.sort_value.clone());
                sql.push_str(" AND t.id > ");
                bind_text!(cursor.task_id.to_string());
                sql.push_str("))");
            }
            TaskSort::UpdatedDesc => {
                sql.push_str(" AND (t.updated_at < ");
                bind_text!(cursor.sort_value.clone());
                sql.push_str(" OR (t.updated_at = ");
                bind_text!(cursor.sort_value.clone());
                sql.push_str(" AND t.id > ");
                bind_text!(cursor.task_id.to_string());
                sql.push_str("))");
            }
            TaskSort::DueAsc => {
                sql.push_str(" AND (ifnull(t.due_date, '9999-99-99') > ");
                bind_text!(cursor.sort_value.clone());
                sql.push_str(" OR (ifnull(t.due_date, '9999-99-99') = ");
                bind_text!(cursor.sort_value.clone());
                sql.push_str(" AND t.id > ");
                bind_text!(cursor.task_id.to_string());
                sql.push_str("))");
            }
            TaskSort::DueDesc => {
                sql.push_str(" AND (ifnull(t.due_date, '') < ");
                bind_text!(cursor.sort_value.clone());
                sql.push_str(" OR (ifnull(t.due_date, '') = ");
                bind_text!(cursor.sort_value.clone());
                sql.push_str(" AND t.id > ");
                bind_text!(cursor.task_id.to_string());
                sql.push_str("))");
            }
            TaskSort::PriorityAsc => {
                let p: i64 = cursor
                    .sort_value
                    .parse()
                    .expect("cursor validated as priority integer");
                sql.push_str(" AND (ifnull(t.priority, 99) > ");
                bind_i64!(p);
                sql.push_str(" OR (ifnull(t.priority, 99) = ");
                bind_i64!(p);
                sql.push_str(" AND t.id > ");
                bind_text!(cursor.task_id.to_string());
                sql.push_str("))");
            }
            TaskSort::TitleAsc => {
                sql.push_str(" AND (t.title > ");
                bind_text!(cursor.sort_value.clone());
                sql.push_str(" OR (t.title = ");
                bind_text!(cursor.sort_value.clone());
                sql.push_str(" AND t.id > ");
                bind_text!(cursor.task_id.to_string());
                sql.push_str("))");
            }
        }
    }

    sql.push_str(match query.sort {
        TaskSort::SortOrderAsc => " ORDER BY t.sort_order ASC, t.id ASC",
        TaskSort::CreatedAsc => " ORDER BY t.created_at ASC, t.id ASC",
        TaskSort::CreatedDesc => " ORDER BY t.created_at DESC, t.id ASC",
        TaskSort::UpdatedDesc => " ORDER BY t.updated_at DESC, t.id ASC",
        TaskSort::DueAsc => " ORDER BY ifnull(t.due_date, '9999-99-99') ASC, t.id ASC",
        TaskSort::DueDesc => " ORDER BY ifnull(t.due_date, '') DESC, t.id ASC",
        TaskSort::PriorityAsc => " ORDER BY ifnull(t.priority, 99) ASC, t.id ASC",
        TaskSort::TitleAsc => " ORDER BY t.title ASC, t.id ASC",
    });
    sql.push_str(" LIMIT ");
    bind_i64!(i64::from(limit) + 1);

    let mut statement = tx.prepare(&sql).map_err(storage_error)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(binds.iter()), |row| {
            let id: String = row.get(0)?;
            parse_sql(id, TaskId::parse)
        })
        .map_err(storage_error)?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(storage_error)?);
    }
    let has_more = ids.len() as u32 > limit;
    if has_more {
        ids.truncate(limit as usize);
    }
    let mut tasks = Vec::with_capacity(ids.len());
    for id in ids {
        tasks.push(load_task(&tx, id)?);
    }
    let next_cursor = if has_more {
        tasks.last().map(|task| {
            let sort_value = match query.sort {
                TaskSort::SortOrderAsc => task.sort_order.get().to_string(),
                TaskSort::CreatedAsc | TaskSort::CreatedDesc => task.created_at.to_string(),
                TaskSort::UpdatedDesc => task.updated_at.to_string(),
                TaskSort::DueAsc => task
                    .due_date
                    .map(|d| d.to_string())
                    .unwrap_or_else(|| "9999-99-99".into()),
                TaskSort::DueDesc => task.due_date.map(|d| d.to_string()).unwrap_or_default(),
                TaskSort::PriorityAsc => task
                    .priority
                    .map(|p| i64::from(p.get()).to_string())
                    .unwrap_or_else(|| "99".into()),
                TaskSort::TitleAsc => task.title.as_str().to_owned(),
            };
            TaskCursor {
                sort_value,
                task_id: task.id,
            }
        })
    } else {
        None
    };
    Ok(TaskListPage {
        tasks,
        revision,
        as_of_date: as_of.as_of_date,
        next_cursor,
    })
}
