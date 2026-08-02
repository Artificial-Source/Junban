//! Load and write helpers for Phase 2 entities.

use jiff::{Timestamp, civil::Date, civil::Time};
use junban_app::RepositoryError;
use junban_domain::{
    ActualMinutes, Comment, CommentBody, CommentId, DreadLevel, EntityName, EstimatedMinutes,
    FilterQuery, HexColor, IconText, LocalDueTime, MarkdownText, MonthlyAnchorDay, OperationId,
    Priority, Project, ProjectId, ProjectView, RecurrenceRule, RelationKind, SavedFilter,
    SavedFilterId, Section, SectionId, SortOrder, Tag, TagId, TagName, Task, TaskActivity,
    TaskActivityAction, TaskId, TaskRelation, TaskStatus, TaskTitle, Template, TemplateId,
    TimeZoneName,
};
use rusqlite::{OptionalExtension, Transaction, params};

use crate::helpers::constraint_conflict;

pub(crate) fn storage_error(error: impl std::fmt::Display) -> RepositoryError {
    RepositoryError::Storage(error.to_string())
}

pub(crate) fn revision_to_i64(revision: u64) -> Result<i64, RepositoryError> {
    i64::try_from(revision).map_err(|error| RepositoryError::Storage(error.to_string()))
}

pub(crate) fn parse_sql<T, E>(
    value: String,
    parse: impl FnOnce(&str) -> Result<T, E>,
) -> rusqlite::Result<T>
where
    E: std::fmt::Display,
{
    parse(&value).map_err(invalid_sql)
}

pub(crate) fn invalid_sql(error: impl std::fmt::Display) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            error.to_string(),
        )),
    )
}

pub(crate) fn load_task(tx: &Transaction<'_>, id: TaskId) -> Result<Task, RepositoryError> {
    let mut task = tx
        .query_row(
            "SELECT id, title, description, due_date, due_time, due_timezone, deadline,
                    status, priority, dread, estimated_minutes, actual_minutes,
                    project_id, section_id, parent_id, sort_order, recurrence_rule, someday,
                    completed_at, cancelled_at, created_at, updated_at, revision,
                    remind_at, recurrence_anchor_day, recurrence_source_id, completion_operation_id
             FROM tasks WHERE id = ?1",
            [id.to_string()],
            task_from_row,
        )
        .map_err(map_not_found)?;
    task.tag_ids = load_task_tag_ids(tx, id)?;
    Ok(task)
}

pub(crate) fn load_task_tag_ids(
    tx: &Transaction<'_>,
    id: TaskId,
) -> Result<Vec<TagId>, RepositoryError> {
    let mut statement = tx
        .prepare_cached("SELECT tag_id FROM task_tags WHERE task_id = ?1 ORDER BY rowid")
        .map_err(storage_error)?;
    let rows = statement
        .query_map([id.to_string()], |row| {
            let raw: String = row.get(0)?;
            parse_sql(raw, TagId::parse)
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

pub(crate) fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    let id: String = row.get(0)?;
    let title: String = row.get(1)?;
    let description: String = row.get(2)?;
    let due_date: Option<String> = row.get(3)?;
    let due_time: Option<String> = row.get(4)?;
    let due_timezone: Option<String> = row.get(5)?;
    let deadline: Option<String> = row.get(6)?;
    let status: String = row.get(7)?;
    let priority: Option<i64> = row.get(8)?;
    let dread: Option<i64> = row.get(9)?;
    let estimated_minutes: Option<i64> = row.get(10)?;
    let actual_minutes: Option<i64> = row.get(11)?;
    let project_id: Option<String> = row.get(12)?;
    let section_id: Option<String> = row.get(13)?;
    let parent_id: Option<String> = row.get(14)?;
    let sort_order: i64 = row.get(15)?;
    let recurrence_rule: Option<String> = row.get(16)?;
    let someday: i64 = row.get(17)?;
    let completed_at: Option<String> = row.get(18)?;
    let cancelled_at: Option<String> = row.get(19)?;
    let created_at: String = row.get(20)?;
    let updated_at: String = row.get(21)?;
    let revision: i64 = row.get(22)?;
    let remind_at: Option<String> = row.get(23)?;
    let recurrence_anchor_day: Option<i64> = row.get(24)?;
    let recurrence_source_id: Option<String> = row.get(25)?;
    let completion_operation_id: Option<String> = row.get(26)?;

    let created_at = parse_sql(created_at, |raw| raw.parse::<Timestamp>())?;
    let mut task = Task::new(
        parse_sql(id, TaskId::parse)?,
        parse_sql(title, |raw| TaskTitle::new(raw.to_owned()))?,
        None,
        created_at,
        u64::try_from(revision).map_err(|error| invalid_sql(error.to_string()))?,
    );
    task.description = parse_sql(description, |raw| MarkdownText::new(raw.to_owned()))?;
    task.due_date = due_date
        .map(|value| parse_sql(value, |raw| raw.parse::<Date>()))
        .transpose()?;
    task.due_time = match (due_time, due_timezone) {
        (Some(time), Some(zone)) => {
            let parsed_time = time
                .parse::<Time>()
                .map_err(|error| invalid_sql(error.to_string()))?;
            Some(LocalDueTime {
                time: parsed_time,
                time_zone: parse_sql(zone, |raw| TimeZoneName::new(raw))?,
            })
        }
        (None, None) => None,
        _ => return Err(invalid_sql("due_time/due_timezone pair incomplete")),
    };
    task.deadline = deadline
        .map(|value| parse_sql(value, |raw| raw.parse::<Timestamp>()))
        .transpose()?;
    task.status = match status.as_str() {
        "pending" => TaskStatus::Pending,
        "completed" => TaskStatus::Completed,
        "cancelled" => TaskStatus::Cancelled,
        _ => return Err(invalid_sql("invalid task status")),
    };
    task.priority = priority
        .map(|value| {
            let value = u8::try_from(value).map_err(|error| invalid_sql(error.to_string()))?;
            Priority::new(value).map_err(invalid_sql)
        })
        .transpose()?;
    task.dread = dread
        .map(|value| {
            let value = u8::try_from(value).map_err(|error| invalid_sql(error.to_string()))?;
            DreadLevel::new(value).map_err(invalid_sql)
        })
        .transpose()?;
    task.estimated_minutes = estimated_minutes
        .map(|value| {
            let value = u32::try_from(value).map_err(|error| invalid_sql(error.to_string()))?;
            EstimatedMinutes::new(value).map_err(invalid_sql)
        })
        .transpose()?;
    task.actual_minutes = actual_minutes
        .map(|value| {
            let value = u32::try_from(value).map_err(|error| invalid_sql(error.to_string()))?;
            ActualMinutes::new(value).map_err(invalid_sql)
        })
        .transpose()?;
    task.project_id = project_id
        .map(|value| parse_sql(value, ProjectId::parse))
        .transpose()?;
    task.section_id = section_id
        .map(|value| parse_sql(value, SectionId::parse))
        .transpose()?;
    task.parent_id = parent_id
        .map(|value| parse_sql(value, TaskId::parse))
        .transpose()?;
    task.sort_order = SortOrder::new(sort_order);
    task.recurrence_rule = recurrence_rule
        .map(|value| parse_sql(value, |raw| RecurrenceRule::new(raw)))
        .transpose()?;
    task.someday = someday != 0;
    task.completed_at = completed_at
        .map(|value| parse_sql(value, |raw| raw.parse::<Timestamp>()))
        .transpose()?;
    task.cancelled_at = cancelled_at
        .map(|value| parse_sql(value, |raw| raw.parse::<Timestamp>()))
        .transpose()?;
    task.updated_at = parse_sql(updated_at, |raw| raw.parse::<Timestamp>())?;
    task.remind_at = remind_at
        .map(|value| parse_sql(value, |raw| raw.parse::<Timestamp>()))
        .transpose()?;
    task.recurrence_anchor_day = recurrence_anchor_day
        .map(|value| {
            let day = u8::try_from(value).map_err(|error| invalid_sql(error.to_string()))?;
            MonthlyAnchorDay::new(day).map_err(invalid_sql)
        })
        .transpose()?;
    task.recurrence_source_id = recurrence_source_id
        .map(|value| parse_sql(value, TaskId::parse))
        .transpose()?;
    task.completion_operation_id = completion_operation_id
        .map(|value| parse_sql(value, OperationId::parse))
        .transpose()?;
    Ok(task)
}

pub(crate) fn insert_task(tx: &Transaction<'_>, task: &Task) -> Result<(), RepositoryError> {
    tx.execute(
        "INSERT INTO tasks(
            id, title, description, due_date, due_time, due_timezone, deadline,
            status, priority, dread, estimated_minutes, actual_minutes,
            project_id, section_id, parent_id, sort_order, recurrence_rule, someday,
            completed_at, cancelled_at, created_at, updated_at, revision,
            remind_at, recurrence_anchor_day, recurrence_source_id, completion_operation_id
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7,
            ?8, ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?16, ?17, ?18,
            ?19, ?20, ?21, ?22, ?23,
            ?24, ?25, ?26, ?27
         )",
        params![
            task.id.to_string(),
            task.title.as_str(),
            task.description.as_str(),
            task.due_date.map(|d| d.to_string()),
            task.due_time.as_ref().map(|t| t.time.to_string()),
            task.due_time
                .as_ref()
                .map(|t| t.time_zone.as_str().to_owned()),
            task.deadline.map(|d| d.to_string()),
            status_str(task.status),
            task.priority.map(Priority::get),
            task.dread.map(DreadLevel::get),
            task.estimated_minutes.map(EstimatedMinutes::get),
            task.actual_minutes.map(ActualMinutes::get),
            task.project_id.map(|id| id.to_string()),
            task.section_id.map(|id| id.to_string()),
            task.parent_id.map(|id| id.to_string()),
            task.sort_order.get(),
            task.recurrence_rule.as_ref().map(RecurrenceRule::as_str),
            i64::from(task.someday),
            task.completed_at.map(|t| t.to_string()),
            task.cancelled_at.map(|t| t.to_string()),
            task.created_at.to_string(),
            task.updated_at.to_string(),
            revision_to_i64(task.revision)?,
            task.remind_at.map(junban_domain::format_reminder_timestamp),
            task.recurrence_anchor_day.map(|day| i64::from(day.get())),
            task.recurrence_source_id.map(|id| id.to_string()),
            task.completion_operation_id.map(|id| id.to_string()),
        ],
    )
    .map_err(constraint_conflict)?;
    replace_task_tags(tx, task.id, &task.tag_ids)?;
    Ok(())
}

pub(crate) fn update_task_row(tx: &Transaction<'_>, task: &Task) -> Result<(), RepositoryError> {
    let changed = tx
        .execute(
            "UPDATE tasks SET
                title = ?1, description = ?2, due_date = ?3, due_time = ?4, due_timezone = ?5,
                deadline = ?6, status = ?7, priority = ?8, dread = ?9,
                estimated_minutes = ?10, actual_minutes = ?11,
                project_id = ?12, section_id = ?13, parent_id = ?14, sort_order = ?15,
                recurrence_rule = ?16, someday = ?17, completed_at = ?18, cancelled_at = ?19,
                updated_at = ?20, revision = ?21,
                remind_at = ?22, recurrence_anchor_day = ?23,
                recurrence_source_id = ?24, completion_operation_id = ?25
             WHERE id = ?26",
            params![
                task.title.as_str(),
                task.description.as_str(),
                task.due_date.map(|d| d.to_string()),
                task.due_time.as_ref().map(|t| t.time.to_string()),
                task.due_time
                    .as_ref()
                    .map(|t| t.time_zone.as_str().to_owned()),
                task.deadline.map(|d| d.to_string()),
                status_str(task.status),
                task.priority.map(Priority::get),
                task.dread.map(DreadLevel::get),
                task.estimated_minutes.map(EstimatedMinutes::get),
                task.actual_minutes.map(ActualMinutes::get),
                task.project_id.map(|id| id.to_string()),
                task.section_id.map(|id| id.to_string()),
                task.parent_id.map(|id| id.to_string()),
                task.sort_order.get(),
                task.recurrence_rule.as_ref().map(RecurrenceRule::as_str),
                i64::from(task.someday),
                task.completed_at.map(|t| t.to_string()),
                task.cancelled_at.map(|t| t.to_string()),
                task.updated_at.to_string(),
                revision_to_i64(task.revision)?,
                task.remind_at.map(junban_domain::format_reminder_timestamp),
                task.recurrence_anchor_day.map(|day| i64::from(day.get())),
                task.recurrence_source_id.map(|id| id.to_string()),
                task.completion_operation_id.map(|id| id.to_string()),
                task.id.to_string(),
            ],
        )
        .map_err(storage_error)?;
    if changed == 0 {
        return Err(RepositoryError::NotFound);
    }
    replace_task_tags(tx, task.id, &task.tag_ids)?;
    Ok(())
}

pub(crate) fn replace_task_tags(
    tx: &Transaction<'_>,
    task_id: TaskId,
    tag_ids: &[TagId],
) -> Result<(), RepositoryError> {
    tx.execute(
        "DELETE FROM task_tags WHERE task_id = ?1",
        [task_id.to_string()],
    )
    .map_err(storage_error)?;
    for tag_id in tag_ids {
        tx.execute(
            "INSERT INTO task_tags(task_id, tag_id) VALUES (?1, ?2)",
            params![task_id.to_string(), tag_id.to_string()],
        )
        .map_err(|error| {
            if is_fk_error(&error) {
                RepositoryError::NotFound
            } else {
                storage_error(error)
            }
        })?;
    }
    Ok(())
}

pub(crate) fn delete_task_row(
    tx: &Transaction<'_>,
    task_id: TaskId,
) -> Result<(), RepositoryError> {
    let changed = tx
        .execute("DELETE FROM tasks WHERE id = ?1", [task_id.to_string()])
        .map_err(storage_error)?;
    if changed == 0 {
        return Err(RepositoryError::NotFound);
    }
    Ok(())
}

pub(crate) const fn status_str(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Pending => "pending",
        TaskStatus::Completed => "completed",
        TaskStatus::Cancelled => "cancelled",
    }
}

pub(crate) fn map_not_found(error: rusqlite::Error) -> RepositoryError {
    match error {
        rusqlite::Error::QueryReturnedNoRows => RepositoryError::NotFound,
        other => storage_error(other),
    }
}

pub(crate) fn is_fk_error(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::ConstraintViolation,
                ..
            },
            _
        )
    )
}

pub(crate) fn task_exists(tx: &Transaction<'_>, id: TaskId) -> Result<bool, RepositoryError> {
    let found: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM tasks WHERE id = ?1",
            [id.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    Ok(found.is_some())
}

pub(crate) fn load_parent_edges(
    tx: &Transaction<'_>,
) -> Result<Vec<(TaskId, TaskId)>, RepositoryError> {
    let mut statement = tx
        .prepare_cached("SELECT id, parent_id FROM tasks WHERE parent_id IS NOT NULL")
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            let child: String = row.get(0)?;
            let parent: String = row.get(1)?;
            Ok((
                parse_sql(child, TaskId::parse)?,
                parse_sql(parent, TaskId::parse)?,
            ))
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

pub(crate) fn collect_descendants(
    tx: &Transaction<'_>,
    root: TaskId,
) -> Result<Vec<TaskId>, RepositoryError> {
    // BFS over parent_id edges. Root is included first.
    let mut result = vec![root];
    let mut index = 0;
    while index < result.len() {
        let parent = result[index];
        index += 1;
        let mut statement = tx
            .prepare_cached("SELECT id FROM tasks WHERE parent_id = ?1 ORDER BY id")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([parent.to_string()], |row| {
                let id: String = row.get(0)?;
                parse_sql(id, TaskId::parse)
            })
            .map_err(storage_error)?;
        for row in rows {
            result.push(row.map_err(storage_error)?);
            if result.len() > junban_domain::MAX_BULK_IDS {
                return Err(RepositoryError::OperationTooLarge);
            }
        }
    }
    Ok(result)
}

pub(crate) fn ensure_section_in_project(
    tx: &Transaction<'_>,
    project_id: Option<ProjectId>,
    section_id: Option<SectionId>,
) -> Result<(), RepositoryError> {
    let Some(section_id) = section_id else {
        return Ok(());
    };
    let Some(project_id) = project_id else {
        return Err(RepositoryError::Validation(
            junban_domain::ValidationError::Invalid {
                field: "section_id",
                reason: "a section requires a project",
            },
        ));
    };
    let section_project: String = tx
        .query_row(
            "SELECT project_id FROM sections WHERE id = ?1",
            [section_id.to_string()],
            |row| row.get(0),
        )
        .map_err(map_not_found)?;
    if section_project != project_id.to_string() {
        return Err(RepositoryError::Validation(
            junban_domain::ValidationError::Invalid {
                field: "section_id",
                reason: "section must belong to the task project",
            },
        ));
    }
    Ok(())
}

pub(crate) fn ensure_project_exists(
    tx: &Transaction<'_>,
    project_id: ProjectId,
) -> Result<(), RepositoryError> {
    let found: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1",
            [project_id.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    if found.is_none() {
        return Err(RepositoryError::NotFound);
    }
    Ok(())
}

pub(crate) fn ensure_tags_exist(
    tx: &Transaction<'_>,
    tag_ids: &[TagId],
) -> Result<(), RepositoryError> {
    for tag_id in tag_ids {
        let found: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM tags WHERE id = ?1",
                [tag_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        if found.is_none() {
            return Err(RepositoryError::NotFound);
        }
    }
    Ok(())
}

pub(crate) fn load_project(
    tx: &Transaction<'_>,
    id: ProjectId,
) -> Result<Project, RepositoryError> {
    tx.query_row(
        "SELECT id, name, color, icon, parent_id, favorite, archived, view_style,
                sort_order, created_at, updated_at
         FROM projects WHERE id = ?1",
        [id.to_string()],
        project_from_row,
    )
    .map_err(map_not_found)
}

fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    let id: String = row.get(0)?;
    let name: String = row.get(1)?;
    let color: String = row.get(2)?;
    let icon: Option<String> = row.get(3)?;
    let parent_id: Option<String> = row.get(4)?;
    let favorite: i64 = row.get(5)?;
    let archived: i64 = row.get(6)?;
    let view: String = row.get(7)?;
    let sort_order: i64 = row.get(8)?;
    let created_at: String = row.get(9)?;
    let updated_at: String = row.get(10)?;
    Ok(Project {
        id: parse_sql(id, ProjectId::parse)?,
        name: parse_sql(name, |raw| EntityName::new(raw))?,
        color: parse_sql(color, |raw| HexColor::new(raw))?,
        icon: icon
            .map(|value| parse_sql(value, |raw| IconText::new(raw)))
            .transpose()?,
        parent_id: parent_id
            .map(|value| parse_sql(value, ProjectId::parse))
            .transpose()?,
        favorite: favorite != 0,
        archived: archived != 0,
        view: match view.as_str() {
            "list" => ProjectView::List,
            "board" => ProjectView::Board,
            "calendar" => ProjectView::Calendar,
            _ => return Err(invalid_sql("invalid project view")),
        },
        sort_order: SortOrder::new(sort_order),
        created_at: parse_sql(created_at, |raw| raw.parse::<Timestamp>())?,
        updated_at: parse_sql(updated_at, |raw| raw.parse::<Timestamp>())?,
    })
}

pub(crate) fn load_section(
    tx: &Transaction<'_>,
    id: SectionId,
) -> Result<Section, RepositoryError> {
    tx.query_row(
        "SELECT id, project_id, name, collapsed, sort_order, created_at, updated_at
         FROM sections WHERE id = ?1",
        [id.to_string()],
        section_from_row,
    )
    .map_err(map_not_found)
}

fn section_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Section> {
    let id: String = row.get(0)?;
    let project_id: String = row.get(1)?;
    let name: String = row.get(2)?;
    let collapsed: i64 = row.get(3)?;
    let sort_order: i64 = row.get(4)?;
    let created_at: String = row.get(5)?;
    let updated_at: String = row.get(6)?;
    Ok(Section {
        id: parse_sql(id, SectionId::parse)?,
        project_id: parse_sql(project_id, ProjectId::parse)?,
        name: parse_sql(name, |raw| EntityName::new(raw))?,
        collapsed: collapsed != 0,
        sort_order: SortOrder::new(sort_order),
        created_at: parse_sql(created_at, |raw| raw.parse::<Timestamp>())?,
        updated_at: parse_sql(updated_at, |raw| raw.parse::<Timestamp>())?,
    })
}

pub(crate) fn load_tag(tx: &Transaction<'_>, id: TagId) -> Result<Tag, RepositoryError> {
    tx.query_row(
        "SELECT id, name, color, created_at, updated_at FROM tags WHERE id = ?1",
        [id.to_string()],
        tag_from_row,
    )
    .map_err(map_not_found)
}

fn tag_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Tag> {
    let id: String = row.get(0)?;
    let name: String = row.get(1)?;
    let color: String = row.get(2)?;
    let created_at: String = row.get(3)?;
    let updated_at: String = row.get(4)?;
    Ok(Tag {
        id: parse_sql(id, TagId::parse)?,
        name: parse_sql(name, |raw| TagName::new(raw))?,
        color: parse_sql(color, |raw| HexColor::new(raw))?,
        created_at: parse_sql(created_at, |raw| raw.parse::<Timestamp>())?,
        updated_at: parse_sql(updated_at, |raw| raw.parse::<Timestamp>())?,
    })
}

pub(crate) fn normalize_tag_name(name: &str) -> String {
    name.to_lowercase()
}

pub(crate) fn load_template(
    tx: &Transaction<'_>,
    id: TemplateId,
) -> Result<Template, RepositoryError> {
    let mut template = tx
        .query_row(
            "SELECT id, name, title, description, priority, project_id, recurrence_rule,
                    sort_order, created_at, updated_at
             FROM templates WHERE id = ?1",
            [id.to_string()],
            template_from_row,
        )
        .map_err(map_not_found)?;
    template.tag_names = load_template_tag_names(tx, id)?;
    Ok(template)
}

fn template_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Template> {
    let id: String = row.get(0)?;
    let name: String = row.get(1)?;
    let title: String = row.get(2)?;
    let description: String = row.get(3)?;
    let priority: Option<i64> = row.get(4)?;
    let project_id: Option<String> = row.get(5)?;
    let recurrence_rule: Option<String> = row.get(6)?;
    let sort_order: i64 = row.get(7)?;
    let created_at: String = row.get(8)?;
    let updated_at: String = row.get(9)?;
    Ok(Template {
        id: parse_sql(id, TemplateId::parse)?,
        name: parse_sql(name, |raw| EntityName::new(raw))?,
        title: parse_sql(title, |raw| TaskTitle::new(raw.to_owned()))?,
        description: parse_sql(description, |raw| MarkdownText::new(raw.to_owned()))?,
        priority: priority
            .map(|value| {
                let value = u8::try_from(value).map_err(|error| invalid_sql(error.to_string()))?;
                Priority::new(value).map_err(invalid_sql)
            })
            .transpose()?,
        tag_names: Vec::new(),
        project_id: project_id
            .map(|value| parse_sql(value, ProjectId::parse))
            .transpose()?,
        recurrence_rule: recurrence_rule
            .map(|value| parse_sql(value, |raw| RecurrenceRule::new(raw)))
            .transpose()?,
        sort_order: SortOrder::new(sort_order),
        created_at: parse_sql(created_at, |raw| raw.parse::<Timestamp>())?,
        updated_at: parse_sql(updated_at, |raw| raw.parse::<Timestamp>())?,
    })
}

fn load_template_tag_names(
    tx: &Transaction<'_>,
    id: TemplateId,
) -> Result<Vec<TagName>, RepositoryError> {
    let mut statement = tx
        .prepare_cached(
            "SELECT tags.name FROM template_tags
             JOIN tags ON tags.id = template_tags.tag_id
             WHERE template_tags.template_id = ?1
             ORDER BY tags.name_normalized",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([id.to_string()], |row| {
            let name: String = row.get(0)?;
            parse_sql(name, |raw| TagName::new(raw))
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

pub(crate) fn resolve_tag_names(
    tx: &Transaction<'_>,
    names: &[TagName],
) -> Result<Vec<TagId>, RepositoryError> {
    let mut ids = Vec::with_capacity(names.len());
    for name in names {
        let id: String = tx
            .query_row(
                "SELECT id FROM tags WHERE name_normalized = ?1",
                [normalize_tag_name(name.as_str())],
                |row| row.get(0),
            )
            .map_err(map_not_found)?;
        ids.push(parse_sql(id, TagId::parse).map_err(storage_error)?);
    }
    Ok(ids)
}

pub(crate) fn load_saved_filter(
    tx: &Transaction<'_>,
    id: SavedFilterId,
) -> Result<SavedFilter, RepositoryError> {
    tx.query_row(
        "SELECT id, name, query, color, sort_order, created_at, updated_at
         FROM saved_filters WHERE id = ?1",
        [id.to_string()],
        saved_filter_from_row,
    )
    .map_err(map_not_found)
}

fn saved_filter_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedFilter> {
    let id: String = row.get(0)?;
    let name: String = row.get(1)?;
    let query: String = row.get(2)?;
    let color: Option<String> = row.get(3)?;
    let sort_order: i64 = row.get(4)?;
    let created_at: String = row.get(5)?;
    let updated_at: String = row.get(6)?;
    Ok(SavedFilter {
        id: parse_sql(id, SavedFilterId::parse)?,
        name: parse_sql(name, |raw| EntityName::new(raw))?,
        query: parse_sql(query, |raw| FilterQuery::new(raw))?,
        color: color
            .map(|value| parse_sql(value, |raw| HexColor::new(raw)))
            .transpose()?,
        sort_order: SortOrder::new(sort_order),
        created_at: parse_sql(created_at, |raw| raw.parse::<Timestamp>())?,
        updated_at: parse_sql(updated_at, |raw| raw.parse::<Timestamp>())?,
    })
}

pub(crate) fn load_comment(
    tx: &Transaction<'_>,
    id: CommentId,
) -> Result<Comment, RepositoryError> {
    tx.query_row(
        "SELECT id, task_id, content, created_at, updated_at FROM comments WHERE id = ?1",
        [id.to_string()],
        comment_from_row,
    )
    .map_err(map_not_found)
}

fn comment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Comment> {
    let id: String = row.get(0)?;
    let task_id: String = row.get(1)?;
    let content: String = row.get(2)?;
    let created_at: String = row.get(3)?;
    let updated_at: String = row.get(4)?;
    Ok(Comment {
        id: parse_sql(id, CommentId::parse)?,
        task_id: parse_sql(task_id, TaskId::parse)?,
        content: parse_sql(content, |raw| CommentBody::new(raw))?,
        created_at: parse_sql(created_at, |raw| raw.parse::<Timestamp>())?,
        updated_at: parse_sql(updated_at, |raw| raw.parse::<Timestamp>())?,
    })
}

pub(crate) fn load_blocks_edges(
    tx: &Transaction<'_>,
) -> Result<Vec<(TaskId, TaskId)>, RepositoryError> {
    let mut statement = tx
        .prepare_cached("SELECT from_task_id, to_task_id FROM task_relations WHERE kind = 'blocks'")
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            let from: String = row.get(0)?;
            let to: String = row.get(1)?;
            Ok((
                parse_sql(from, TaskId::parse)?,
                parse_sql(to, TaskId::parse)?,
            ))
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

pub(crate) fn activity_action_str(action: TaskActivityAction) -> &'static str {
    match action {
        TaskActivityAction::Created => "created",
        TaskActivityAction::Updated => "updated",
        TaskActivityAction::Completed => "completed",
        TaskActivityAction::Uncompleted => "uncompleted",
        TaskActivityAction::Cancelled => "cancelled",
        TaskActivityAction::Reopened => "reopened",
        TaskActivityAction::Deleted => "deleted",
        TaskActivityAction::Restored => "restored",
    }
}

pub(crate) fn parse_activity_action(raw: &str) -> Result<TaskActivityAction, RepositoryError> {
    match raw {
        "created" => Ok(TaskActivityAction::Created),
        "updated" => Ok(TaskActivityAction::Updated),
        "completed" => Ok(TaskActivityAction::Completed),
        "uncompleted" => Ok(TaskActivityAction::Uncompleted),
        "cancelled" => Ok(TaskActivityAction::Cancelled),
        "reopened" => Ok(TaskActivityAction::Reopened),
        "deleted" => Ok(TaskActivityAction::Deleted),
        "restored" => Ok(TaskActivityAction::Restored),
        _ => Err(RepositoryError::Storage(format!(
            "invalid task activity action: {raw}"
        ))),
    }
}

pub(crate) fn load_task_activity_for_tasks(
    tx: &Transaction<'_>,
    task_ids: &[TaskId],
) -> Result<Vec<TaskActivity>, RepositoryError> {
    if task_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for task_id in task_ids {
        let mut statement = tx
            .prepare_cached(
                "SELECT revision, sequence, operation_id, task_id, action, field,
                        old_value, new_value, created_at
                 FROM task_activity WHERE task_id = ?1
                 ORDER BY revision, sequence",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([task_id.to_string()], activity_from_row)
            .map_err(storage_error)?;
        for row in rows {
            out.push(row.map_err(storage_error)?);
        }
    }
    Ok(out)
}

pub(crate) fn activity_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskActivity> {
    let revision: i64 = row.get(0)?;
    let sequence: i64 = row.get(1)?;
    let operation_id: String = row.get(2)?;
    let task_id: String = row.get(3)?;
    let action: String = row.get(4)?;
    let field: Option<String> = row.get(5)?;
    let old_value: Option<String> = row.get(6)?;
    let new_value: Option<String> = row.get(7)?;
    let created_at: String = row.get(8)?;
    Ok(TaskActivity {
        revision: u64::try_from(revision).map_err(|error| invalid_sql(error.to_string()))?,
        sequence: u32::try_from(sequence).map_err(|error| invalid_sql(error.to_string()))?,
        operation_id: parse_sql(operation_id, OperationId::parse)?,
        task_id: parse_sql(task_id, TaskId::parse)?,
        action: parse_activity_action(&action).map_err(invalid_sql)?,
        field,
        old_value,
        new_value,
        created_at: parse_sql(created_at, |raw| raw.parse::<Timestamp>())?,
    })
}

pub(crate) fn load_comments_for_tasks(
    tx: &Transaction<'_>,
    task_ids: &[TaskId],
) -> Result<Vec<Comment>, RepositoryError> {
    let mut out = Vec::new();
    for task_id in task_ids {
        let mut statement = tx
            .prepare_cached(
                "SELECT id, task_id, content, created_at, updated_at
                 FROM comments WHERE task_id = ?1 ORDER BY created_at, id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([task_id.to_string()], comment_from_row)
            .map_err(storage_error)?;
        for row in rows {
            out.push(row.map_err(storage_error)?);
        }
    }
    Ok(out)
}

pub(crate) fn load_relations_touching(
    tx: &Transaction<'_>,
    task_ids: &[TaskId],
) -> Result<Vec<TaskRelation>, RepositoryError> {
    if task_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for task_id in task_ids {
        let mut statement = tx
            .prepare_cached(
                "SELECT from_task_id, to_task_id, kind FROM task_relations
                 WHERE from_task_id = ?1 OR to_task_id = ?1",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([task_id.to_string()], |row| {
                let from: String = row.get(0)?;
                let to: String = row.get(1)?;
                let kind: String = row.get(2)?;
                Ok((from, to, kind))
            })
            .map_err(storage_error)?;
        for row in rows {
            let (from, to, kind) = row.map_err(storage_error)?;
            let key = (from.clone(), to.clone(), kind.clone());
            if !seen.insert(key) {
                continue;
            }
            out.push(TaskRelation {
                from_task_id: TaskId::parse(&from).map_err(storage_error)?,
                to_task_id: TaskId::parse(&to).map_err(storage_error)?,
                kind: match kind.as_str() {
                    "blocks" => RelationKind::Blocks,
                    _ => {
                        return Err(RepositoryError::Storage(format!(
                            "invalid relation kind: {kind}"
                        )));
                    }
                },
            });
        }
    }
    Ok(out)
}

pub(crate) fn view_style_str(view: ProjectView) -> &'static str {
    match view {
        ProjectView::List => "list",
        ProjectView::Board => "board",
        ProjectView::Calendar => "calendar",
    }
}

pub(crate) fn load_project_parent_edges(
    tx: &Transaction<'_>,
) -> Result<Vec<(ProjectId, ProjectId)>, RepositoryError> {
    let mut statement = tx
        .prepare_cached("SELECT id, parent_id FROM projects WHERE parent_id IS NOT NULL")
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            let child: String = row.get(0)?;
            let parent: String = row.get(1)?;
            Ok((
                parse_sql(child, ProjectId::parse)?,
                parse_sql(parent, ProjectId::parse)?,
            ))
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

pub(crate) fn json_opt<T: serde::Serialize>(
    value: &Option<T>,
) -> Result<Option<String>, RepositoryError> {
    value
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(storage_error)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn field_activity(
    revision: u64,
    sequence: u32,
    operation_id: OperationId,
    task_id: TaskId,
    action: TaskActivityAction,
    field: Option<&str>,
    old_value: Option<String>,
    new_value: Option<String>,
    now: Timestamp,
) -> TaskActivity {
    TaskActivity {
        revision,
        sequence,
        operation_id,
        task_id,
        action,
        field: field.map(str::to_owned),
        old_value,
        new_value,
        created_at: now,
    }
}
