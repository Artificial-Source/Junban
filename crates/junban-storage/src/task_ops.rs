//! Task create/patch/status/delete/move/reorder/bulk operations.

use std::collections::HashSet;

use jiff::Timestamp;
use junban_app::{
    AffectedIds, BulkAction, CommittedMutation, EventType, MoveTarget, OrderAnchor, ReorderScope,
    RepositoryError, ResourceRef, ResourceSnapshot, ResyncScope, TaskPatch,
};
use junban_domain::{
    MAX_BULK_IDS, OperationId, SortOrder, Task, TaskActivityAction, TaskDraft, TaskId, TaskStatus,
    ValidationError, validate_reorder_permutation, validate_task_tags, validate_unique_bulk_ids,
};
use rusqlite::{Connection, Transaction, params};
use serde::Serialize;

use crate::helpers::{
    apply_patch, diff_task_fields, map_transition, validate_task_refs, validation,
};
use crate::ops_types::{Inverse, PostImage, TaskClosure, post_from_tasks, status_name, undo_pair};
use crate::rows::{
    collect_descendants, delete_task_row, ensure_tags_exist, field_activity, insert_task,
    load_comments_for_tasks, load_relations_touching, load_task, load_task_activity_for_tasks,
    parse_sql, storage_error, task_exists, update_task_row,
};
use crate::tx::{MutationEffect, canonical_json, mutate};

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Req<'a> {
    CreateTask {
        draft: &'a TaskDraft,
    },
    PatchTask {
        task_id: String,
        patch: &'a TaskPatch,
    },
    CompleteTask {
        task_id: String,
    },
    UncompleteTask {
        task_id: String,
    },
    CancelTask {
        task_id: String,
    },
    ReopenTask {
        task_id: String,
    },
    DeleteTask {
        task_id: String,
    },
    MoveTask {
        task_id: String,
        target: &'a MoveTarget,
    },
    ReorderTasks {
        scope: &'a ReorderScope,
        ordered_ids: &'a [TaskId],
    },
    BulkTasks {
        task_ids: &'a [TaskId],
        action: &'a BulkAction,
    },
}

fn single(
    event_type: &'static str,
    task: Task,
    activity: Vec<junban_domain::TaskActivity>,
    undo: crate::tx::UndoRecord,
) -> MutationEffect {
    let id = task.id;
    MutationEffect {
        event_type: EventType::new(event_type),
        primary: Some(ResourceRef::task(id)),
        snapshot: Some(ResourceSnapshot::task(task)),
        affected: AffectedIds {
            task_ids: vec![id],
            ..AffectedIds::default()
        },
        resync: ResyncScope::NONE,
        task_activity: activity,
        summary_subject: Some(("task".into(), id.to_string())),
        undo: Some(undo),
        mark_undone: None,
    }
}

pub(crate) fn create_task(
    connection: &mut Connection,
    operation_id: OperationId,
    task_id: TaskId,
    draft: TaskDraft,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::CreateTask { draft: &draft })?;
    mutate(
        connection,
        operation_id,
        request,
        now,
        move |tx, revision| {
            let task = Task::from_draft(task_id, draft, now, revision).map_err(validation)?;
            validate_task_refs(tx, &task)?;
            insert_task(tx, &task)?;
            let activity = vec![field_activity(
                revision,
                0,
                operation_id,
                task.id,
                TaskActivityAction::Created,
                None,
                None,
                None,
                now,
            )];
            let undo = undo_pair(
                &Inverse::DeleteTasks {
                    task_ids: vec![task.id],
                },
                &post_from_tasks([task.clone()]),
            )?;
            Ok(single(EventType::TASK_CREATED, task, activity, undo))
        },
    )
}

pub(crate) fn get_task(connection: &Connection, task_id: TaskId) -> Result<Task, RepositoryError> {
    let tx = connection.unchecked_transaction().map_err(storage_error)?;
    load_task(&tx, task_id)
}

pub(crate) fn patch_task(
    connection: &mut Connection,
    operation_id: OperationId,
    task_id: TaskId,
    patch: TaskPatch,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::PatchTask {
        task_id: task_id.to_string(),
        patch: &patch,
    })?;
    mutate(
        connection,
        operation_id,
        request,
        now,
        move |tx, revision| {
            let before = load_task(tx, task_id)?;
            let mut after = before.clone();
            apply_patch(&mut after, &patch)?;
            after.updated_at = now;
            after.revision = revision;
            validate_task_refs(tx, &after)?;
            update_task_row(tx, &after)?;
            let activity = diff_task_fields(&before, &after, revision, operation_id, now, 0);
            let undo = undo_pair(
                &Inverse::RestoreTasks {
                    tasks: vec![before],
                },
                &post_from_tasks([after.clone()]),
            )?;
            Ok(single(EventType::TASK_UPDATED, after, activity, undo))
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn change_status(
    connection: &mut Connection,
    operation_id: OperationId,
    task_id: TaskId,
    now: Timestamp,
    request: Req<'_>,
    event_type: &'static str,
    action: TaskActivityAction,
    cascade_complete: bool,
    transition: fn(&mut Task, Timestamp) -> Result<(), ValidationError>,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&request)?;
    mutate(
        connection,
        operation_id,
        request,
        now,
        move |tx, revision| {
            let mut restored = Vec::new();
            let mut activity = Vec::new();
            let mut affected = Vec::new();
            let mut seq = 0u32;

            let before = load_task(tx, task_id)?;
            restored.push(before.clone());
            let mut after = before.clone();
            transition(&mut after, now).map_err(map_transition)?;
            after.revision = revision;
            after.updated_at = now;
            update_task_row(tx, &after)?;
            affected.push(after.id);
            activity.push(field_activity(
                revision,
                seq,
                operation_id,
                after.id,
                action,
                Some("status"),
                Some(status_name(before.status).to_owned()),
                Some(status_name(after.status).to_owned()),
                now,
            ));
            seq += 1;

            if cascade_complete {
                for child_id in collect_descendants(tx, task_id)?.into_iter().skip(1) {
                    let child_before = load_task(tx, child_id)?;
                    if child_before.status != TaskStatus::Pending {
                        continue;
                    }
                    restored.push(child_before.clone());
                    let mut child = child_before;
                    child.try_complete(now).map_err(map_transition)?;
                    child.revision = revision;
                    child.updated_at = now;
                    update_task_row(tx, &child)?;
                    affected.push(child.id);
                    activity.push(field_activity(
                        revision,
                        seq,
                        operation_id,
                        child.id,
                        TaskActivityAction::Completed,
                        Some("status"),
                        Some("pending".into()),
                        Some("completed".into()),
                        now,
                    ));
                    seq = seq.saturating_add(1);
                }
            }

            let mut post_tasks = Vec::new();
            for id in &affected {
                post_tasks.push(load_task(tx, *id)?);
            }
            let primary = load_task(tx, task_id)?;
            let undo = undo_pair(
                &Inverse::RestoreTasks { tasks: restored },
                &post_from_tasks(post_tasks),
            )?;
            let multi = affected.len() > 1;
            Ok(MutationEffect {
                event_type: EventType::new(event_type),
                primary: Some(ResourceRef::task(task_id)),
                snapshot: if multi {
                    None
                } else {
                    Some(ResourceSnapshot::task(primary))
                },
                affected: AffectedIds {
                    task_ids: affected,
                    ..AffectedIds::default()
                },
                resync: if multi {
                    ResyncScope::TASKS
                } else {
                    ResyncScope::NONE
                },
                task_activity: activity,
                summary_subject: Some(("task".into(), task_id.to_string())),
                undo: Some(undo),
                mark_undone: None,
            })
        },
    )
}

pub(crate) fn complete_task(
    c: &mut Connection,
    op: OperationId,
    id: TaskId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    change_status(
        c,
        op,
        id,
        now,
        Req::CompleteTask {
            task_id: id.to_string(),
        },
        EventType::TASK_COMPLETED,
        TaskActivityAction::Completed,
        true,
        Task::try_complete,
    )
}
pub(crate) fn uncomplete_task(
    c: &mut Connection,
    op: OperationId,
    id: TaskId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    change_status(
        c,
        op,
        id,
        now,
        Req::UncompleteTask {
            task_id: id.to_string(),
        },
        EventType::TASK_UNCOMPLETED,
        TaskActivityAction::Uncompleted,
        false,
        Task::try_uncomplete,
    )
}
pub(crate) fn cancel_task(
    c: &mut Connection,
    op: OperationId,
    id: TaskId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    change_status(
        c,
        op,
        id,
        now,
        Req::CancelTask {
            task_id: id.to_string(),
        },
        EventType::TASK_CANCELLED,
        TaskActivityAction::Cancelled,
        false,
        Task::try_cancel,
    )
}
pub(crate) fn reopen_task(
    c: &mut Connection,
    op: OperationId,
    id: TaskId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    change_status(
        c,
        op,
        id,
        now,
        Req::ReopenTask {
            task_id: id.to_string(),
        },
        EventType::TASK_REOPENED,
        TaskActivityAction::Reopened,
        false,
        Task::try_reopen,
    )
}

pub(crate) fn capture_closure(
    tx: &Transaction<'_>,
    root: TaskId,
) -> Result<(Vec<TaskId>, TaskClosure), RepositoryError> {
    let ids = collect_descendants(tx, root)?;
    let mut tasks = Vec::with_capacity(ids.len());
    for id in &ids {
        tasks.push(load_task(tx, *id)?);
    }
    Ok((
        ids.clone(),
        TaskClosure {
            tasks,
            comments: load_comments_for_tasks(tx, &ids)?,
            relations: load_relations_touching(tx, &ids)?,
            activity: load_task_activity_for_tasks(tx, &ids)?,
        },
    ))
}

pub(crate) fn delete_task(
    c: &mut Connection,
    op: OperationId,
    task_id: TaskId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::DeleteTask {
        task_id: task_id.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        if !task_exists(tx, task_id)? {
            return Err(RepositoryError::NotFound);
        }
        let (ids, closure) = capture_closure(tx, task_id)?;
        for id in ids.iter().rev() {
            delete_task_row(tx, *id)?;
        }
        let activity = ids
            .iter()
            .enumerate()
            .map(|(i, id)| {
                field_activity(
                    revision,
                    u32::try_from(i).unwrap_or(u32::MAX),
                    op,
                    *id,
                    TaskActivityAction::Deleted,
                    None,
                    None,
                    None,
                    now,
                )
            })
            .collect();
        let post = PostImage {
            absent_task_ids: ids.clone(),
            ..PostImage::default()
        };
        let undo = undo_pair(&Inverse::RestoreClosure { closure }, &post)?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::TASK_DELETED),
            primary: Some(ResourceRef::task(task_id)),
            snapshot: None,
            affected: AffectedIds {
                task_ids: ids,
                ..AffectedIds::default()
            },
            resync: ResyncScope::TASKS,
            task_activity: activity,
            summary_subject: Some(("task".into(), task_id.to_string())),
            undo: Some(undo),
            mark_undone: None,
        })
    })
}

pub(crate) fn scope_siblings(
    tx: &Transaction<'_>,
    parent_id: Option<TaskId>,
    project_id: Option<junban_domain::ProjectId>,
    section_id: Option<junban_domain::SectionId>,
) -> Result<Vec<TaskId>, RepositoryError> {
    let mut statement = tx.prepare(
        "SELECT id FROM tasks WHERE parent_id IS ?1 AND project_id IS ?2 AND section_id IS ?3 ORDER BY sort_order, id"
    ).map_err(storage_error)?;
    let rows = statement
        .query_map(
            params![
                parent_id.map(|id| id.to_string()),
                project_id.map(|id| id.to_string()),
                section_id.map(|id| id.to_string()),
            ],
            |row| {
                let id: String = row.get(0)?;
                parse_sql(id, TaskId::parse)
            },
        )
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

/// Rewrite target-sibling order. Returns pre-images of every sibling whose order changes.
#[allow(clippy::too_many_arguments)]
fn apply_order_anchor(
    tx: &Transaction<'_>,
    task_id: TaskId,
    parent_id: Option<TaskId>,
    project_id: Option<junban_domain::ProjectId>,
    section_id: Option<junban_domain::SectionId>,
    order: &OrderAnchor,
    now: Timestamp,
    revision: u64,
) -> Result<Vec<Task>, RepositoryError> {
    if matches!(order, OrderAnchor::Keep) {
        return Ok(Vec::new());
    }
    let siblings = scope_siblings(tx, parent_id, project_id, section_id)?;
    // Include the moved task once it is already in the target scope.
    let mut affected_before = Vec::with_capacity(siblings.len().saturating_add(1));
    let mut seen = HashSet::new();
    for id in siblings.iter().copied().chain(std::iter::once(task_id)) {
        if seen.insert(id) {
            affected_before.push(load_task(tx, id)?);
        }
    }
    if affected_before.len() > MAX_BULK_IDS {
        return Err(RepositoryError::OperationTooLarge);
    }
    let mut ordered: Vec<TaskId> = siblings.into_iter().filter(|id| *id != task_id).collect();
    match order {
        OrderAnchor::Keep => {}
        OrderAnchor::First => ordered.insert(0, task_id),
        OrderAnchor::Last => ordered.push(task_id),
        OrderAnchor::Before { task_id: anchor } => {
            let Some(index) = ordered.iter().position(|id| id == anchor) else {
                return Err(RepositoryError::Conflict);
            };
            ordered.insert(index, task_id);
        }
        OrderAnchor::After { task_id: anchor } => {
            let Some(index) = ordered.iter().position(|id| id == anchor) else {
                return Err(RepositoryError::Conflict);
            };
            ordered.insert(index + 1, task_id);
        }
    }
    for (index, id) in ordered.iter().enumerate() {
        let mut task = load_task(tx, *id)?;
        task.sort_order = SortOrder::new(index as i64);
        task.updated_at = now;
        task.revision = revision;
        update_task_row(tx, &task)?;
    }
    Ok(affected_before)
}

pub(crate) fn move_task(
    c: &mut Connection,
    op: OperationId,
    task_id: TaskId,
    target: MoveTarget,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::MoveTask {
        task_id: task_id.to_string(),
        target: &target,
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let before = load_task(tx, task_id)?;
        let mut after = before.clone();
        if let Some(parent_id) = target.parent_id {
            after.parent_id = parent_id;
        }
        if let Some(project_id) = target.project_id {
            after.project_id = project_id;
            if after.project_id.is_none() {
                after.section_id = None;
            }
        }
        if let Some(section_id) = target.section_id {
            after.section_id = section_id;
        }
        after.updated_at = now;
        after.revision = revision;
        validate_task_refs(tx, &after)?;
        update_task_row(tx, &after)?;
        let mut restored = vec![before.clone()];
        let sibling_before = apply_order_anchor(
            tx,
            task_id,
            after.parent_id,
            after.project_id,
            after.section_id,
            &target.order,
            now,
            revision,
        )?;
        for sibling in sibling_before {
            if sibling.id != before.id {
                restored.push(sibling);
            }
        }
        if restored.len() > MAX_BULK_IDS {
            return Err(RepositoryError::OperationTooLarge);
        }

        let after = load_task(tx, task_id)?;
        let mut activity = diff_task_fields(&before, &after, revision, op, now, 0);
        let mut seq = u32::try_from(activity.len()).unwrap_or(u32::MAX);
        let mut post_tasks = Vec::with_capacity(restored.len());
        let mut affected_ids = Vec::with_capacity(restored.len());
        // Only anchored moves rewrite siblings. `Keep` touches the moved task alone.
        for prior in &restored {
            let current = load_task(tx, prior.id)?;
            if prior.id != task_id {
                let diffs = diff_task_fields(prior, &current, revision, op, now, seq);
                seq = seq.saturating_add(u32::try_from(diffs.len()).unwrap_or(0));
                activity.extend(diffs);
            }
            affected_ids.push(prior.id);
            post_tasks.push(current);
        }
        let undo = undo_pair(
            &Inverse::RestoreTasks { tasks: restored },
            &post_from_tasks(post_tasks),
        )?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::TASK_MOVED),
            primary: Some(ResourceRef::task(task_id)),
            snapshot: None,
            affected: AffectedIds {
                task_ids: affected_ids,
                ..AffectedIds::default()
            },
            resync: ResyncScope::TASKS,
            task_activity: activity,
            summary_subject: Some(("task".into(), task_id.to_string())),
            undo: Some(undo),
            mark_undone: None,
        })
    })
}

pub(crate) fn reorder_tasks(
    c: &mut Connection,
    op: OperationId,
    scope: ReorderScope,
    ordered_ids: Vec<TaskId>,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::ReorderTasks {
        scope: &scope,
        ordered_ids: &ordered_ids,
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let parent_id = scope.parent_id.unwrap_or(None);
        let project_id = scope.project_id.unwrap_or(None);
        let section_id = scope.section_id.unwrap_or(None);
        let scope_ids = scope_siblings(tx, parent_id, project_id, section_id)?;
        validate_reorder_permutation(&scope_ids, &ordered_ids).map_err(|error| {
            if matches!(
                error,
                ValidationError::IncompletePermutation { .. } | ValidationError::Duplicate { .. }
            ) {
                RepositoryError::Conflict
            } else {
                validation(error)
            }
        })?;
        let mut before_tasks = Vec::new();
        for id in &scope_ids {
            before_tasks.push(load_task(tx, *id)?);
        }
        for (index, id) in ordered_ids.iter().enumerate() {
            let mut task = load_task(tx, *id)?;
            task.sort_order = SortOrder::new(index as i64);
            task.updated_at = now;
            task.revision = revision;
            update_task_row(tx, &task)?;
        }
        let mut after_tasks = Vec::new();
        for id in &ordered_ids {
            after_tasks.push(load_task(tx, *id)?);
        }
        let activity = ordered_ids
            .iter()
            .enumerate()
            .map(|(index, id)| {
                field_activity(
                    revision,
                    u32::try_from(index).unwrap_or(u32::MAX),
                    op,
                    *id,
                    TaskActivityAction::Updated,
                    Some("sort_order"),
                    None,
                    Some((index as i64).to_string()),
                    now,
                )
            })
            .collect();
        let undo = undo_pair(
            &Inverse::RestoreTasks {
                tasks: before_tasks,
            },
            &post_from_tasks(after_tasks),
        )?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::TASK_REORDERED),
            primary: None,
            snapshot: None,
            affected: AffectedIds {
                task_ids: ordered_ids,
                ..AffectedIds::default()
            },
            resync: ResyncScope::TASKS,
            task_activity: activity,
            summary_subject: None,
            undo: Some(undo),
            mark_undone: None,
        })
    })
}

pub(crate) fn bulk_tasks(
    c: &mut Connection,
    op: OperationId,
    task_ids: Vec<TaskId>,
    action: BulkAction,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    validate_unique_bulk_ids(&task_ids).map_err(validation)?;
    if let BulkAction::Move { target } = &action
        && !matches!(target.order, OrderAnchor::Keep)
    {
        return Err(validation(ValidationError::Invalid {
            field: "order",
            reason: "bulk move supports order keep only",
        }));
    }
    let request = canonical_json(&Req::BulkTasks {
        task_ids: &task_ids,
        action: &action,
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        if matches!(action, BulkAction::Delete) {
            let mut all_ids = Vec::new();
            let mut seen = HashSet::new();
            let mut merged = TaskClosure {
                tasks: vec![],
                comments: vec![],
                relations: vec![],
                activity: vec![],
            };
            let mut task_seen = HashSet::new();
            let mut comment_seen = HashSet::new();
            let mut relation_seen = HashSet::new();
            let mut activity_seen = HashSet::new();
            for task_id in &task_ids {
                if !task_exists(tx, *task_id)? {
                    return Err(RepositoryError::NotFound);
                }
                let (ids, closure) = capture_closure(tx, *task_id)?;
                for id in ids {
                    if seen.insert(id) {
                        all_ids.push(id);
                    }
                }
                if all_ids.len() > MAX_BULK_IDS {
                    return Err(RepositoryError::OperationTooLarge);
                }
                for task in closure.tasks {
                    if task_seen.insert(task.id) {
                        merged.tasks.push(task);
                    }
                }
                for comment in closure.comments {
                    if comment_seen.insert(comment.id) {
                        merged.comments.push(comment);
                    }
                }
                for relation in closure.relations {
                    let key = (
                        relation.from_task_id,
                        relation.to_task_id,
                        format!("{:?}", relation.kind),
                    );
                    if relation_seen.insert(key) {
                        merged.relations.push(relation);
                    }
                }
                for entry in closure.activity {
                    let key = (entry.revision, entry.sequence, entry.task_id);
                    if activity_seen.insert(key) {
                        merged.activity.push(entry);
                    }
                }
            }
            for id in all_ids.iter().rev() {
                if task_exists(tx, *id)? {
                    delete_task_row(tx, *id)?;
                }
            }
            let activity = all_ids
                .iter()
                .enumerate()
                .map(|(i, id)| {
                    field_activity(
                        revision,
                        u32::try_from(i).unwrap_or(u32::MAX),
                        op,
                        *id,
                        TaskActivityAction::Deleted,
                        None,
                        None,
                        None,
                        now,
                    )
                })
                .collect();
            let post = PostImage {
                absent_task_ids: all_ids.clone(),
                ..PostImage::default()
            };
            let undo = undo_pair(&Inverse::RestoreClosure { closure: merged }, &post)?;
            return Ok(MutationEffect {
                event_type: EventType::new(EventType::TASK_BULK),
                primary: None,
                snapshot: None,
                affected: AffectedIds {
                    task_ids: all_ids,
                    ..AffectedIds::default()
                },
                resync: ResyncScope::TASKS,
                task_activity: activity,
                summary_subject: None,
                undo: Some(undo),
                mark_undone: None,
            });
        }

        // Bulk complete expands pending descendants of each selected pending parent.
        let effective_ids = if matches!(action, BulkAction::Complete) {
            let mut expanded = Vec::new();
            let mut seen = HashSet::new();
            for task_id in &task_ids {
                let selected = load_task(tx, *task_id)?;
                // Selected non-pending tasks remain hard conflicts.
                if selected.status != TaskStatus::Pending {
                    return Err(RepositoryError::Conflict);
                }
                if seen.insert(selected.id) {
                    expanded.push(selected.id);
                }
                for descendant_id in collect_descendants(tx, selected.id)?.into_iter().skip(1) {
                    let descendant = load_task(tx, descendant_id)?;
                    if descendant.status != TaskStatus::Pending {
                        continue;
                    }
                    if seen.insert(descendant.id) {
                        expanded.push(descendant.id);
                    }
                    if expanded.len() > MAX_BULK_IDS {
                        return Err(RepositoryError::OperationTooLarge);
                    }
                }
                if expanded.len() > MAX_BULK_IDS {
                    return Err(RepositoryError::OperationTooLarge);
                }
            }
            expanded
        } else {
            task_ids.clone()
        };

        let mut before_tasks = Vec::new();
        let mut after_tasks = Vec::new();
        let mut activity = Vec::new();
        let mut seq = 0u32;
        for task_id in &effective_ids {
            let before = load_task(tx, *task_id)?;
            let mut after = before.clone();
            match &action {
                BulkAction::Complete => after.try_complete(now).map_err(map_transition)?,
                BulkAction::Uncomplete => after.try_uncomplete(now).map_err(map_transition)?,
                BulkAction::Cancel => after.try_cancel(now).map_err(map_transition)?,
                BulkAction::Reopen => after.try_reopen(now).map_err(map_transition)?,
                BulkAction::Delete => unreachable!(),
                BulkAction::Move { target } => {
                    if !matches!(target.order, OrderAnchor::Keep) {
                        return Err(validation(ValidationError::Invalid {
                            field: "order",
                            reason: "bulk move supports order keep only",
                        }));
                    }
                    if let Some(parent_id) = target.parent_id {
                        after.parent_id = parent_id;
                    }
                    if let Some(project_id) = target.project_id {
                        after.project_id = project_id;
                        if after.project_id.is_none() {
                            after.section_id = None;
                        }
                    }
                    if let Some(section_id) = target.section_id {
                        after.section_id = section_id;
                    }
                    validate_task_refs(tx, &after)?;
                }
                BulkAction::Tag { change } => {
                    let mut tags: HashSet<_> = after.tag_ids.iter().copied().collect();
                    for id in &change.remove {
                        tags.remove(id);
                    }
                    for id in &change.add {
                        tags.insert(*id);
                    }
                    let mut tag_ids: Vec<_> = tags.into_iter().collect();
                    tag_ids.sort_by_key(|id| id.as_uuid());
                    validate_task_tags(&tag_ids).map_err(validation)?;
                    ensure_tags_exist(tx, &tag_ids)?;
                    after.tag_ids = tag_ids;
                }
                BulkAction::Schedule { schedule } => {
                    if let Some(due_date) = &schedule.due_date {
                        after.due_date = *due_date;
                    }
                    if let Some(due_time) = &schedule.due_time {
                        after.due_time = due_time.clone();
                    }
                    if let Some(deadline) = &schedule.deadline {
                        after.deadline = *deadline;
                    }
                    if let Some(someday) = schedule.someday {
                        after.someday = someday;
                    }
                    if after.due_time.is_some() && after.due_date.is_none() {
                        return Err(validation(ValidationError::Invalid {
                            field: "due_time",
                            reason: "due_time requires due_date",
                        }));
                    }
                }
                BulkAction::Priority { priority } => after.priority = *priority,
            }
            after.updated_at = now;
            after.revision = revision;
            update_task_row(tx, &after)?;
            let diffs = diff_task_fields(&before, &after, revision, op, now, seq);
            seq = seq.saturating_add(u32::try_from(diffs.len()).unwrap_or(0));
            activity.extend(diffs);
            before_tasks.push(before);
            after_tasks.push(after);
        }
        let undo = undo_pair(
            &Inverse::RestoreTasks {
                tasks: before_tasks,
            },
            &post_from_tasks(after_tasks),
        )?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::TASK_BULK),
            primary: None,
            snapshot: None,
            affected: AffectedIds {
                task_ids: effective_ids,
                ..AffectedIds::default()
            },
            resync: ResyncScope::TASKS,
            task_activity: activity,
            summary_subject: None,
            undo: Some(undo),
            mark_undone: None,
        })
    })
}
