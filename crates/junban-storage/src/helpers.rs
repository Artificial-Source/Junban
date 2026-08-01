//! Shared validation and field-diff helpers for repository operations.

use jiff::Timestamp;
use junban_app::{RepositoryError, TaskPatch};
use junban_domain::{
    OperationId, Task, TaskActivity, TaskActivityAction, ValidationError,
    resolve_recurrence_anchor, validate_parent_chain, validate_task_tags,
};
use rusqlite::Transaction;

use crate::ops_types::status_name;
use crate::rows::{
    ensure_project_exists, ensure_section_in_project, ensure_tags_exist, field_activity, json_opt,
    load_parent_edges, storage_error, task_exists,
};

pub(crate) fn constraint_conflict(error: rusqlite::Error) -> RepositoryError {
    if matches!(
        error,
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::ConstraintViolation,
                ..
            },
            _
        )
    ) {
        RepositoryError::Conflict
    } else {
        storage_error(error)
    }
}

pub(crate) fn validation(error: ValidationError) -> RepositoryError {
    RepositoryError::Validation(error)
}

pub(crate) fn map_transition(error: ValidationError) -> RepositoryError {
    if error.field() == "status" {
        RepositoryError::Conflict
    } else {
        RepositoryError::Validation(error)
    }
}

pub(crate) fn apply_patch(task: &mut Task, patch: &TaskPatch) -> Result<(), RepositoryError> {
    let before_due_date = task.due_date;
    let before_due_time = task.due_time.clone();
    let before_rule = task.recurrence_rule.clone();
    if let Some(title) = &patch.title {
        task.title = title.clone();
    }
    if let Some(description) = &patch.description {
        task.description = description.clone();
    }
    if let Some(priority) = &patch.priority {
        task.priority = *priority;
    }
    if let Some(due_date) = &patch.due_date {
        task.due_date = *due_date;
    }
    if let Some(due_time) = &patch.due_time {
        task.due_time = due_time.clone();
    }
    if let Some(deadline) = &patch.deadline {
        task.deadline = *deadline;
    }
    if let Some(someday) = patch.someday {
        task.someday = someday;
    }
    if let Some(estimated) = &patch.estimated_minutes {
        task.estimated_minutes = *estimated;
    }
    if let Some(actual) = &patch.actual_minutes {
        task.actual_minutes = *actual;
    }
    if let Some(dread) = &patch.dread {
        task.dread = *dread;
    }
    if let Some(project_id) = &patch.project_id {
        task.project_id = *project_id;
    }
    if let Some(section_id) = &patch.section_id {
        task.section_id = *section_id;
    }
    if let Some(parent_id) = &patch.parent_id {
        task.parent_id = *parent_id;
    }
    if let Some(tag_ids) = &patch.tag_ids {
        validate_task_tags(tag_ids).map_err(validation)?;
        task.tag_ids = tag_ids.clone();
    }
    if let Some(sort_order) = patch.sort_order {
        task.sort_order = sort_order;
    }
    if let Some(rule) = &patch.recurrence_rule {
        task.recurrence_rule = rule.clone();
    }
    if let Some(remind_at) = &patch.remind_at {
        task.remind_at = *remind_at;
    }
    let due_changed = task.due_date != before_due_date || task.due_time != before_due_time;
    let rule_changed = task.recurrence_rule != before_rule;
    if due_changed || rule_changed {
        // Manual due/representation/rule changes reset monthly/yearly anchors.
        task.recurrence_anchor_day =
            resolve_recurrence_anchor(task.recurrence_rule.as_ref(), task.due_date, None);
    } else if let Some(anchor) = &patch.recurrence_anchor_day {
        task.recurrence_anchor_day = *anchor;
    }
    if task.section_id.is_some() && task.project_id.is_none() {
        return Err(validation(ValidationError::Invalid {
            field: "section_id",
            reason: "a section requires a project",
        }));
    }
    if task.due_time.is_some() && task.due_date.is_none() {
        return Err(validation(ValidationError::Invalid {
            field: "due_time",
            reason: "due_time requires due_date",
        }));
    }
    if task.parent_id == Some(task.id) {
        return Err(validation(ValidationError::Invalid {
            field: "parent_id",
            reason: "a task cannot be its own parent",
        }));
    }
    Ok(())
}

pub(crate) fn validate_task_refs(tx: &Transaction<'_>, task: &Task) -> Result<(), RepositoryError> {
    if let Some(project_id) = task.project_id {
        ensure_project_exists(tx, project_id)?;
    }
    ensure_section_in_project(tx, task.project_id, task.section_id)?;
    if let Some(parent_id) = task.parent_id
        && !task_exists(tx, parent_id)?
    {
        return Err(RepositoryError::NotFound);
    }
    ensure_tags_exist(tx, &task.tag_ids)?;
    let edges = load_parent_edges(tx)?;
    validate_parent_chain(task.id, task.parent_id, &edges).map_err(|error| {
        if matches!(
            error,
            ValidationError::Cycle { .. } | ValidationError::Invalid { .. }
        ) {
            RepositoryError::Conflict
        } else {
            validation(error)
        }
    })?;
    Ok(())
}

pub(crate) fn diff_task_fields(
    before: &Task,
    after: &Task,
    revision: u64,
    operation_id: OperationId,
    now: Timestamp,
    mut seq: u32,
) -> Vec<TaskActivity> {
    let mut out = Vec::new();
    let mut push = |field: &str, old: Option<String>, new: Option<String>| {
        if old != new {
            out.push(field_activity(
                revision,
                seq,
                operation_id,
                after.id,
                TaskActivityAction::Updated,
                Some(field),
                old,
                new,
                now,
            ));
            seq += 1;
        }
    };
    push(
        "title",
        Some(before.title.as_str().to_owned()),
        Some(after.title.as_str().to_owned()),
    );
    push(
        "description",
        Some(before.description.as_str().to_owned()),
        Some(after.description.as_str().to_owned()),
    );
    push(
        "priority",
        json_opt(&before.priority).ok().flatten(),
        json_opt(&after.priority).ok().flatten(),
    );
    push(
        "due_date",
        before.due_date.map(|date| date.to_string()),
        after.due_date.map(|date| date.to_string()),
    );
    push(
        "due_time",
        json_opt(&before.due_time).ok().flatten(),
        json_opt(&after.due_time).ok().flatten(),
    );
    push(
        "deadline",
        before.deadline.map(|date| date.to_string()),
        after.deadline.map(|date| date.to_string()),
    );
    push(
        "someday",
        Some(before.someday.to_string()),
        Some(after.someday.to_string()),
    );
    push(
        "estimated_minutes",
        before
            .estimated_minutes
            .map(|value| value.get().to_string()),
        after.estimated_minutes.map(|value| value.get().to_string()),
    );
    push(
        "actual_minutes",
        before.actual_minutes.map(|value| value.get().to_string()),
        after.actual_minutes.map(|value| value.get().to_string()),
    );
    push(
        "dread",
        before.dread.map(|value| value.get().to_string()),
        after.dread.map(|value| value.get().to_string()),
    );
    push(
        "project_id",
        before.project_id.map(|id| id.to_string()),
        after.project_id.map(|id| id.to_string()),
    );
    push(
        "section_id",
        before.section_id.map(|id| id.to_string()),
        after.section_id.map(|id| id.to_string()),
    );
    push(
        "parent_id",
        before.parent_id.map(|id| id.to_string()),
        after.parent_id.map(|id| id.to_string()),
    );
    push(
        "tag_ids",
        serde_json::to_string(&before.tag_ids).ok(),
        serde_json::to_string(&after.tag_ids).ok(),
    );
    push(
        "sort_order",
        Some(before.sort_order.get().to_string()),
        Some(after.sort_order.get().to_string()),
    );
    push(
        "recurrence_rule",
        before
            .recurrence_rule
            .as_ref()
            .map(|rule| rule.as_str().to_owned()),
        after
            .recurrence_rule
            .as_ref()
            .map(|rule| rule.as_str().to_owned()),
    );
    push(
        "remind_at",
        before.remind_at.map(|value| value.to_string()),
        after.remind_at.map(|value| value.to_string()),
    );
    push(
        "recurrence_anchor_day",
        before
            .recurrence_anchor_day
            .map(|day| day.get().to_string()),
        after.recurrence_anchor_day.map(|day| day.get().to_string()),
    );
    push(
        "recurrence_source_id",
        before.recurrence_source_id.map(|id| id.to_string()),
        after.recurrence_source_id.map(|id| id.to_string()),
    );
    push(
        "completion_operation_id",
        before.completion_operation_id.map(|id| id.to_string()),
        after.completion_operation_id.map(|id| id.to_string()),
    );
    push(
        "cancelled_at",
        before.cancelled_at.map(|value| value.to_string()),
        after.cancelled_at.map(|value| value.to_string()),
    );
    push(
        "status",
        Some(status_name(before.status).to_owned()),
        Some(status_name(after.status).to_owned()),
    );
    out
}
