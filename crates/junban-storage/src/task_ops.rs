//! Task create/patch/status/delete/move/reorder/bulk operations.

use std::collections::HashSet;

use jiff::Timestamp;
use junban_app::{
    AffectedIds, BulkAction, CommittedMutation, EventType, MoveTarget, OrderAnchor, ReorderScope,
    RepositoryError, ResourceRef, ResourceSnapshot, ResyncScope, TaskPatch, TemporalContext,
};
use junban_domain::{
    MAX_BULK_IDS, NextOccurrenceRequest, OperationId, RecurrenceSource, SortOrder, Task,
    TaskActivityAction, TaskDraft, TaskId, TaskStatus, UncompleteOutcome, ValidationError,
    next_occurrence, resolve_recurrence_anchor, shift_occurrence_absolutes,
    validate_reorder_permutation, validate_task_tags, validate_unique_bulk_ids,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;

use crate::helpers::{
    apply_patch, diff_task_fields, map_transition, validate_task_refs, validation,
};
use crate::ops_types::{Inverse, PostImage, TaskClosure, post_from_tasks, status_name, undo_pair};
use crate::reminder_ops::{
    load_reminder_snapshot, post_with_reminders, reminders_into_post, sync_task_reminder_intent,
};
use crate::rows::{
    collect_descendants, delete_task_row, ensure_tags_exist, field_activity, insert_task,
    load_comments_for_tasks, load_relations_touching, load_task, load_task_activity_for_tasks,
    parse_sql, storage_error, task_exists, update_task_row,
};
use crate::timeblock_ops::{detach_planning_links_for_tasks, load_planning_links_for_tasks};
use crate::tx::{MutationEffect, canonical_json, mutate};
use crate::undo_ops::{apply_inverse, validate_post_image};

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
        uncomplete_outcome: None,
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
            sync_task_reminder_intent(tx, &task, now)?;
            let reminders = load_reminder_snapshot(tx, &[task.id], now)?;
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
                &post_with_reminders([task.clone()], reminders),
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
            let before_reminders = load_reminder_snapshot(tx, &[task_id], now)?;
            let mut after = before.clone();
            apply_patch(&mut after, &patch)?;
            after.updated_at = now;
            after.revision = revision;
            validate_task_refs(tx, &after)?;
            update_task_row(tx, &after)?;
            // Reconcile occurrence rows when schedule or terminal status changes.
            sync_task_reminder_intent(tx, &after, now)?;
            let after_reminders = load_reminder_snapshot(tx, &[task_id], now)?;
            let activity = diff_task_fields(&before, &after, revision, operation_id, now, 0);
            let undo = undo_pair(
                &Inverse::RestoreTasks {
                    tasks: vec![before],
                    reminders: before_reminders,
                },
                &post_with_reminders([after.clone()], after_reminders),
            )?;
            Ok(single(EventType::TASK_UPDATED, after, activity, undo))
        },
    )
}

fn build_generated_child(
    source: &Task,
    now: Timestamp,
    revision: u64,
    temporal: &TemporalContext,
) -> Result<Task, RepositoryError> {
    let rule = source
        .recurrence_rule
        .clone()
        .ok_or_else(|| RepositoryError::Storage("recurring source missing rule".into()))?;
    let recurrence_source = RecurrenceSource {
        rule,
        due_date: source.due_date,
        due_time: source.due_time.clone(),
        monthly_anchor: source.recurrence_anchor_day,
    };
    let next = next_occurrence(&NextOccurrenceRequest {
        source: recurrence_source.clone(),
        sampled_completion_date: temporal.sampled_completion_date,
    })
    .map_err(validation)?;
    let offsets = shift_occurrence_absolutes(
        &recurrence_source,
        &next,
        source.remind_at,
        source.deadline,
        &temporal.server_time_zone,
    )
    .map_err(validation)?;
    Ok(Task {
        id: TaskId::new(),
        title: source.title.clone(),
        description: source.description.clone(),
        priority: source.priority,
        due_date: Some(next.due_date),
        due_time: next.due_time,
        deadline: offsets.deadline,
        someday: source.someday,
        estimated_minutes: source.estimated_minutes,
        actual_minutes: None,
        dread: source.dread,
        project_id: source.project_id,
        section_id: source.section_id,
        parent_id: None,
        tag_ids: source.tag_ids.clone(),
        sort_order: SortOrder::default(),
        recurrence_rule: source.recurrence_rule.clone(),
        remind_at: offsets.remind_at,
        recurrence_anchor_day: next.monthly_anchor,
        recurrence_source_id: Some(source.id),
        completion_operation_id: None,
        status: TaskStatus::Pending,
        completed_at: None,
        created_at: now,
        updated_at: now,
        revision,
    })
}

struct CompletePendingResult {
    sources_before: Vec<Task>,
    generated_ids: Vec<TaskId>,
    post_tasks: Vec<Task>,
    activity: Vec<junban_domain::TaskActivity>,
    #[allow(dead_code)]
    seq: u32,
}

fn complete_pending_set(
    tx: &Transaction<'_>,
    operation_id: OperationId,
    pending_ids: &[TaskId],
    now: Timestamp,
    revision: u64,
    temporal: &TemporalContext,
    mut seq: u32,
) -> Result<CompletePendingResult, RepositoryError> {
    let recurring_count = pending_ids
        .iter()
        .map(|id| load_task(tx, *id))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|task| task.recurrence_rule.is_some())
        .count();
    if pending_ids.len().saturating_add(recurring_count) > MAX_BULK_IDS {
        return Err(RepositoryError::OperationTooLarge);
    }

    let mut sources_before = Vec::with_capacity(pending_ids.len());
    let mut generated_ids = Vec::new();
    let mut post_tasks = Vec::new();
    let mut activity = Vec::new();

    for task_id in pending_ids {
        let before = load_task(tx, *task_id)?;
        if before.status != TaskStatus::Pending {
            return Err(RepositoryError::Conflict);
        }
        sources_before.push(before.clone());
        let mut after = before.clone();
        after.try_complete(now).map_err(map_transition)?;
        after.completion_operation_id = Some(operation_id);
        after.revision = revision;
        after.updated_at = now;
        update_task_row(tx, &after)?;
        // Completing suppresses still-pending delivery without touching terminal rows.
        sync_task_reminder_intent(tx, &after, now)?;
        activity.push(field_activity(
            revision,
            seq,
            operation_id,
            after.id,
            TaskActivityAction::Completed,
            Some("status"),
            Some("pending".into()),
            Some("completed".into()),
            now,
        ));
        seq = seq.saturating_add(1);

        if before.recurrence_rule.is_some() {
            let child = build_generated_child(&before, now, revision, temporal)?;
            insert_task(tx, &child)?;
            // Generated child may carry a shifted remind_at — materialize its pending row.
            sync_task_reminder_intent(tx, &child, now)?;
            generated_ids.push(child.id);
            activity.push(field_activity(
                revision,
                seq,
                operation_id,
                child.id,
                TaskActivityAction::Created,
                Some("recurrence_source_id"),
                None,
                Some(before.id.to_string()),
                now,
            ));
            seq = seq.saturating_add(1);
            post_tasks.push(child);
        }
        post_tasks.push(load_task(tx, after.id)?);
    }

    Ok(CompletePendingResult {
        sources_before,
        generated_ids,
        post_tasks,
        activity,
        seq,
    })
}

fn expand_complete_targets(
    tx: &Transaction<'_>,
    roots: &[TaskId],
) -> Result<Vec<TaskId>, RepositoryError> {
    let mut expanded = Vec::new();
    let mut seen = HashSet::new();
    for task_id in roots {
        let selected = load_task(tx, *task_id)?;
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
    Ok(expanded)
}

fn load_completion_material(
    tx: &Transaction<'_>,
    completion_operation_id: OperationId,
) -> Result<Option<(Inverse, PostImage)>, RepositoryError> {
    let row = tx
        .query_row(
            "SELECT u.inverse_json, u.post_image_json
             FROM operation_undo u
             JOIN operation_receipts r ON r.operation_id = u.source_operation_id
             WHERE u.source_operation_id = ?1",
            [completion_operation_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(storage_error)?;
    let Some((inverse_json, post_json)) = row else {
        return Ok(None);
    };
    let inverse: Inverse = serde_json::from_str(&inverse_json).map_err(storage_error)?;
    let post: PostImage = serde_json::from_str(&post_json).map_err(storage_error)?;
    Ok(Some((inverse, post)))
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
    transition: fn(&mut Task, Timestamp) -> Result<(), ValidationError>,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&request)?;
    mutate(
        connection,
        operation_id,
        request,
        now,
        move |tx, revision| {
            let before = load_task(tx, task_id)?;
            let before_reminders = load_reminder_snapshot(tx, &[task_id], now)?;
            let mut after = before.clone();
            transition(&mut after, now).map_err(map_transition)?;
            after.revision = revision;
            after.updated_at = now;
            // Status changes other than completion do not touch recurrence generation.
            if !matches!(action, TaskActivityAction::Completed) {
                after.completion_operation_id = None;
            }
            update_task_row(tx, &after)?;
            // Cancel suppresses pending delivery; reopen restores pending intent when safe.
            sync_task_reminder_intent(tx, &after, now)?;
            let after_reminders = load_reminder_snapshot(tx, &[task_id], now)?;
            let activity = vec![field_activity(
                revision,
                0,
                operation_id,
                after.id,
                action,
                Some("status"),
                Some(status_name(before.status).to_owned()),
                Some(status_name(after.status).to_owned()),
                now,
            )];
            let undo = undo_pair(
                &Inverse::RestoreTasks {
                    tasks: vec![before],
                    reminders: before_reminders,
                },
                &post_with_reminders([after.clone()], after_reminders),
            )?;
            Ok(MutationEffect {
                event_type: EventType::new(event_type),
                primary: Some(ResourceRef::task(task_id)),
                snapshot: Some(ResourceSnapshot::task(after)),
                affected: AffectedIds {
                    task_ids: vec![task_id],
                    ..AffectedIds::default()
                },
                resync: ResyncScope::NONE,
                task_activity: activity,
                summary_subject: Some(("task".into(), task_id.to_string())),
                undo: Some(undo),
                mark_undone: None,
                uncomplete_outcome: None,
            })
        },
    )
}

pub(crate) fn complete_task(
    c: &mut Connection,
    op: OperationId,
    id: TaskId,
    now: Timestamp,
    temporal: TemporalContext,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::CompleteTask {
        task_id: id.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let pending_ids = expand_complete_targets(tx, &[id])?;
        let source_reminders = load_reminder_snapshot(tx, &pending_ids, now)?;
        let completed = complete_pending_set(tx, op, &pending_ids, now, revision, &temporal, 0)?;
        let multi = completed.post_tasks.len() > 1;
        let primary = load_task(tx, id)?;
        let mut affected = pending_ids;
        affected.extend(completed.generated_ids.iter().copied());
        let after_reminders = load_reminder_snapshot(tx, &affected, now)?;
        let undo = undo_pair(
            &Inverse::ReverseCompletion {
                sources: completed.sources_before,
                generated_ids: completed.generated_ids.clone(),
                source_reminders,
            },
            &post_with_reminders(completed.post_tasks, after_reminders),
        )?;
        let activity = completed.activity;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::TASK_COMPLETED),
            primary: Some(ResourceRef::task(id)),
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
            summary_subject: Some(("task".into(), id.to_string())),
            undo: Some(undo),
            mark_undone: None,
            uncomplete_outcome: None,
        })
    })
}

pub(crate) fn uncomplete_task(
    c: &mut Connection,
    op: OperationId,
    id: TaskId,
    now: Timestamp,
    _temporal: TemporalContext,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::UncompleteTask {
        task_id: id.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let source = load_task(tx, id)?;
        if source.status != TaskStatus::Completed {
            return Err(RepositoryError::Conflict);
        }

        // Prefer exact receipt-backed reversal of the owning completion operation.
        if let Some(completion_op) = source.completion_operation_id
            && let Some((inverse, post)) = load_completion_material(tx, completion_op)?
        {
            match validate_post_image(tx, &post) {
                Ok(()) => {
                    let (affected, activity, _, _) =
                        apply_inverse(tx, &inverse, now, revision, op)?;
                    // Capture redo material: completed post-image must be restorable.
                    let redo_tasks: Vec<Task> = post.tasks.values().cloned().collect();
                    let redo_reminders: Vec<_> = post.reminders.values().cloned().collect();
                    let mut uncomplete_post = PostImage {
                        absent_task_ids: match &inverse {
                            Inverse::ReverseCompletion { generated_ids, .. } => {
                                generated_ids.clone()
                            }
                            _ => Vec::new(),
                        },
                        ..PostImage::default()
                    };
                    for task_id in &affected.task_ids {
                        if let Ok(task) = load_task(tx, *task_id) {
                            uncomplete_post
                                .orders
                                .insert(task.id.to_string(), task.sort_order.get());
                            uncomplete_post.tasks.insert(task.id.to_string(), task);
                        }
                    }
                    let current_reminders = load_reminder_snapshot(tx, &affected.task_ids, now)?;
                    reminders_into_post(&mut uncomplete_post, current_reminders);
                    let undo = undo_pair(
                        &Inverse::RestoreTasks {
                            tasks: redo_tasks,
                            reminders: redo_reminders,
                        },
                        &uncomplete_post,
                    )?;
                    // Keep single-task uncomplete snapshots for the existing HTTP surface.
                    let multi =
                        affected.task_ids.len() > 1 || !uncomplete_post.absent_task_ids.is_empty();
                    let primary_task = load_task(tx, id)?;
                    return Ok(MutationEffect {
                        event_type: EventType::new(EventType::TASK_UNCOMPLETED),
                        primary: Some(ResourceRef::task(id)),
                        snapshot: if multi {
                            None
                        } else {
                            Some(ResourceSnapshot::task(primary_task))
                        },
                        affected,
                        resync: if multi {
                            ResyncScope::TASKS
                        } else {
                            ResyncScope::NONE
                        },
                        task_activity: activity,
                        summary_subject: Some(("task".into(), id.to_string())),
                        undo: Some(undo),
                        mark_undone: None,
                        uncomplete_outcome: Some(UncompleteOutcome::Exact),
                    });
                }
                Err(RepositoryError::Conflict) => return Err(RepositoryError::Conflict),
                Err(error) => return Err(error),
            }
        }

        // Source-only fallback: reopen just this task; leave generated children alone.
        // Do not resurrect cancelled/consumed reminder rows without exact receipt authority.
        let before = source;
        let before_reminders = load_reminder_snapshot(tx, &[id], now)?;
        let mut after = before.clone();
        after.try_uncomplete(now).map_err(map_transition)?;
        after.completion_operation_id = None;
        after.revision = revision;
        after.updated_at = now;
        update_task_row(tx, &after)?;
        let after_reminders = load_reminder_snapshot(tx, &[id], now)?;
        let activity = vec![field_activity(
            revision,
            0,
            op,
            after.id,
            TaskActivityAction::Uncompleted,
            Some("status"),
            Some("completed".into()),
            Some("pending".into()),
            now,
        )];
        let undo = undo_pair(
            &Inverse::RestoreTasks {
                tasks: vec![before],
                reminders: before_reminders,
            },
            &post_with_reminders([after.clone()], after_reminders),
        )?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::TASK_UNCOMPLETED),
            primary: Some(ResourceRef::task(id)),
            snapshot: Some(ResourceSnapshot::task(after)),
            affected: AffectedIds {
                task_ids: vec![id],
                ..AffectedIds::default()
            },
            resync: ResyncScope::NONE,
            task_activity: activity,
            summary_subject: Some(("task".into(), id.to_string())),
            undo: Some(undo),
            mark_undone: None,
            uncomplete_outcome: Some(UncompleteOutcome::SourceOnly),
        })
    })
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
        Task::try_reopen,
    )
}

pub(crate) fn capture_closure(
    tx: &Transaction<'_>,
    root: TaskId,
    now: Timestamp,
) -> Result<(Vec<TaskId>, TaskClosure), RepositoryError> {
    let ids = collect_descendants(tx, root)?;
    let mut tasks = Vec::with_capacity(ids.len());
    for id in &ids {
        tasks.push(load_task(tx, *id)?);
    }
    let (slot_memberships, block_links) = load_planning_links_for_tasks(tx, &ids)?;
    Ok((
        ids.clone(),
        TaskClosure {
            tasks,
            comments: load_comments_for_tasks(tx, &ids)?,
            relations: load_relations_touching(tx, &ids)?,
            activity: load_task_activity_for_tasks(tx, &ids)?,
            reminders: load_reminder_snapshot(tx, &ids, now)?,
            slot_memberships,
            block_links,
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
        let (ids, closure) = capture_closure(tx, task_id, now)?;
        // Explicit detach before task rows so membership/order and block links are
        // receipt-owned rather than lost to FK CASCADE / SET NULL.
        let planning = detach_planning_links_for_tasks(tx, &ids, now, revision)?;
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
            time_slots: planning.post_slots,
            time_blocks: planning.post_blocks,
            ..PostImage::default()
        };
        let undo = undo_pair(&Inverse::RestoreClosure { closure }, &post)?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::TASK_DELETED),
            primary: Some(ResourceRef::task(task_id)),
            snapshot: None,
            affected: AffectedIds {
                task_ids: ids,
                time_slot_ids: planning.time_slot_ids,
                time_block_ids: planning.time_block_ids,
                ..AffectedIds::default()
            },
            resync: ResyncScope::TASKS,
            task_activity: activity,
            summary_subject: Some(("task".into(), task_id.to_string())),
            undo: Some(undo),
            mark_undone: None,
            uncomplete_outcome: None,
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
        let before_ids: Vec<_> = restored.iter().map(|task| task.id).collect();
        let before_reminders = load_reminder_snapshot(tx, &before_ids, now)?;
        let after_reminders = load_reminder_snapshot(tx, &affected_ids, now)?;
        let undo = undo_pair(
            &Inverse::RestoreTasks {
                tasks: restored,
                reminders: before_reminders,
            },
            &post_with_reminders(post_tasks, after_reminders),
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
            uncomplete_outcome: None,
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
        let before_ids: Vec<_> = before_tasks.iter().map(|task| task.id).collect();
        let before_reminders = load_reminder_snapshot(tx, &before_ids, now)?;
        let after_reminders = load_reminder_snapshot(tx, &ordered_ids, now)?;
        let undo = undo_pair(
            &Inverse::RestoreTasks {
                tasks: before_tasks,
                reminders: before_reminders,
            },
            &post_with_reminders(after_tasks, after_reminders),
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
            uncomplete_outcome: None,
        })
    })
}

pub(crate) fn bulk_tasks(
    c: &mut Connection,
    op: OperationId,
    task_ids: Vec<TaskId>,
    action: BulkAction,
    now: Timestamp,
    temporal: TemporalContext,
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
                reminders: vec![],
                slot_memberships: vec![],
                block_links: vec![],
            };
            let mut task_seen = HashSet::new();
            let mut comment_seen = HashSet::new();
            let mut relation_seen = HashSet::new();
            let mut activity_seen = HashSet::new();
            let mut membership_seen = HashSet::new();
            let mut block_link_seen = HashSet::new();
            for task_id in &task_ids {
                if !task_exists(tx, *task_id)? {
                    return Err(RepositoryError::NotFound);
                }
                let (ids, closure) = capture_closure(tx, *task_id, now)?;
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
                for reminder in closure.reminders {
                    if !merged.reminders.iter().any(|item| {
                        item.task_id == reminder.task_id && item.remind_at == reminder.remind_at
                    }) {
                        merged.reminders.push(reminder);
                    }
                }
                for membership in closure.slot_memberships {
                    let key = (membership.slot_id, membership.task_id);
                    if membership_seen.insert(key) {
                        merged.slot_memberships.push(membership);
                    }
                }
                for link in closure.block_links {
                    if block_link_seen.insert(link.block_id) {
                        merged.block_links.push(link);
                    }
                }
            }
            let planning = detach_planning_links_for_tasks(tx, &all_ids, now, revision)?;
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
                time_slots: planning.post_slots,
                time_blocks: planning.post_blocks,
                ..PostImage::default()
            };
            let undo = undo_pair(&Inverse::RestoreClosure { closure: merged }, &post)?;
            return Ok(MutationEffect {
                event_type: EventType::new(EventType::TASK_BULK),
                primary: None,
                snapshot: None,
                affected: AffectedIds {
                    task_ids: all_ids,
                    time_slot_ids: planning.time_slot_ids,
                    time_block_ids: planning.time_block_ids,
                    ..AffectedIds::default()
                },
                resync: ResyncScope::TASKS,
                task_activity: activity,
                summary_subject: None,
                undo: Some(undo),
                mark_undone: None,
                uncomplete_outcome: None,
            });
        }

        if matches!(action, BulkAction::Complete) {
            let pending_ids = expand_complete_targets(tx, &task_ids)?;
            let source_reminders = load_reminder_snapshot(tx, &pending_ids, now)?;
            let completed =
                complete_pending_set(tx, op, &pending_ids, now, revision, &temporal, 0)?;
            let mut affected = pending_ids;
            affected.extend(completed.generated_ids.iter().copied());
            let after_reminders = load_reminder_snapshot(tx, &affected, now)?;
            let undo = undo_pair(
                &Inverse::ReverseCompletion {
                    sources: completed.sources_before,
                    generated_ids: completed.generated_ids,
                    source_reminders,
                },
                &post_with_reminders(completed.post_tasks, after_reminders),
            )?;
            return Ok(MutationEffect {
                event_type: EventType::new(EventType::TASK_BULK),
                primary: None,
                snapshot: None,
                affected: AffectedIds {
                    task_ids: affected,
                    ..AffectedIds::default()
                },
                resync: ResyncScope::TASKS,
                task_activity: completed.activity,
                summary_subject: None,
                undo: Some(undo),
                mark_undone: None,
                uncomplete_outcome: None,
            });
        }

        if matches!(action, BulkAction::Uncomplete) {
            // Dedup by completion operation so overlapping cascade roots reverse once.
            let mut seen_ops = HashSet::new();
            let mut source_only_ids = Vec::new();
            let mut exact_ops = Vec::new();
            for task_id in &task_ids {
                let task = load_task(tx, *task_id)?;
                if task.status != TaskStatus::Completed {
                    return Err(RepositoryError::Conflict);
                }
                match task.completion_operation_id {
                    Some(completion_op) if seen_ops.insert(completion_op) => {
                        if load_completion_material(tx, completion_op)?.is_some() {
                            exact_ops.push(completion_op);
                        } else {
                            source_only_ids.push(*task_id);
                        }
                    }
                    Some(_) => {}
                    None => source_only_ids.push(*task_id),
                }
            }

            // Validate every exact completion before mutating any.
            let mut materials = Vec::new();
            for completion_op in &exact_ops {
                let (inverse, post) = load_completion_material(tx, *completion_op)?
                    .ok_or(RepositoryError::Conflict)?;
                validate_post_image(tx, &post)?;
                materials.push((inverse, post));
            }

            let mut before_tasks = Vec::new();
            let mut after_tasks = Vec::new();
            let mut activity = Vec::new();
            let mut affected = Vec::new();
            let mut seq = 0u32;
            let mut redo_tasks = Vec::new();
            let mut redo_reminders = Vec::new();
            let mut absent_generated = Vec::new();

            for (inverse, post) in materials {
                redo_tasks.extend(post.tasks.values().cloned());
                redo_reminders.extend(post.reminders.values().cloned());
                if let Inverse::ReverseCompletion { generated_ids, .. } = &inverse {
                    absent_generated.extend(generated_ids.iter().copied());
                }
                let (part_affected, part_activity, _, _) =
                    apply_inverse(tx, &inverse, now, revision, op)?;
                // Re-sequence activity entries into this bulk operation.
                for mut entry in part_activity {
                    entry.sequence = seq;
                    entry.operation_id = op;
                    entry.revision = revision;
                    seq = seq.saturating_add(1);
                    activity.push(entry);
                }
                affected.extend(part_affected.task_ids);
            }

            for task_id in source_only_ids {
                let before = load_task(tx, task_id)?;
                let mut after = before.clone();
                after.try_uncomplete(now).map_err(map_transition)?;
                after.completion_operation_id = None;
                after.updated_at = now;
                after.revision = revision;
                update_task_row(tx, &after)?;
                let diffs = diff_task_fields(&before, &after, revision, op, now, seq);
                seq = seq.saturating_add(u32::try_from(diffs.len()).unwrap_or(0));
                activity.extend(diffs);
                before_tasks.push(before);
                after_tasks.push(after);
                affected.push(task_id);
            }

            // Undo restores exact completed post-images plus source-only befores.
            redo_tasks.extend(before_tasks.iter().cloned());
            for task in &before_tasks {
                redo_reminders.extend(load_reminder_snapshot(tx, &[task.id], now)?);
            }
            let mut post = post_from_tasks(after_tasks);
            post.absent_task_ids = absent_generated;
            let current_reminders = load_reminder_snapshot(tx, &affected, now)?;
            reminders_into_post(&mut post, current_reminders);
            let undo = undo_pair(
                &Inverse::RestoreTasks {
                    tasks: redo_tasks,
                    reminders: redo_reminders,
                },
                &post,
            )?;
            affected.sort_by_key(|id| id.as_uuid());
            affected.dedup();
            return Ok(MutationEffect {
                event_type: EventType::new(EventType::TASK_BULK),
                primary: None,
                snapshot: None,
                affected: AffectedIds {
                    task_ids: affected,
                    ..AffectedIds::default()
                },
                resync: ResyncScope::TASKS,
                task_activity: activity,
                summary_subject: None,
                undo: Some(undo),
                mark_undone: None,
                uncomplete_outcome: None,
            });
        }

        let mut before_tasks = Vec::new();
        let mut after_tasks = Vec::new();
        let mut before_reminders = Vec::new();
        let mut activity = Vec::new();
        let mut seq = 0u32;
        for task_id in &task_ids {
            let before = load_task(tx, *task_id)?;
            before_reminders.extend(load_reminder_snapshot(tx, &[*task_id], now)?);
            let mut after = before.clone();
            match &action {
                BulkAction::Complete | BulkAction::Uncomplete | BulkAction::Delete => {
                    unreachable!()
                }
                BulkAction::Cancel => after.try_cancel(now).map_err(map_transition)?,
                BulkAction::Reopen => {
                    after.try_reopen(now).map_err(map_transition)?;
                    after.completion_operation_id = None;
                }
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
                    let due_before = after.due_date;
                    let time_before = after.due_time.clone();
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
                    if after.due_date != due_before || after.due_time != time_before {
                        after.recurrence_anchor_day = resolve_recurrence_anchor(
                            after.recurrence_rule.as_ref(),
                            after.due_date,
                            None,
                        );
                    }
                }
                BulkAction::Priority { priority } => after.priority = *priority,
            }
            after.updated_at = now;
            after.revision = revision;
            update_task_row(tx, &after)?;
            sync_task_reminder_intent(tx, &after, now)?;
            let diffs = diff_task_fields(&before, &after, revision, op, now, seq);
            seq = seq.saturating_add(u32::try_from(diffs.len()).unwrap_or(0));
            activity.extend(diffs);
            before_tasks.push(before);
            after_tasks.push(after);
        }
        let after_reminders = load_reminder_snapshot(tx, &task_ids, now)?;
        let undo = undo_pair(
            &Inverse::RestoreTasks {
                tasks: before_tasks,
                reminders: before_reminders,
            },
            &post_with_reminders(after_tasks, after_reminders),
        )?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::TASK_BULK),
            primary: None,
            snapshot: None,
            affected: AffectedIds {
                task_ids: task_ids.clone(),
                ..AffectedIds::default()
            },
            resync: ResyncScope::TASKS,
            task_activity: activity,
            summary_subject: None,
            undo: Some(undo),
            mark_undone: None,
            uncomplete_outcome: None,
        })
    })
}
