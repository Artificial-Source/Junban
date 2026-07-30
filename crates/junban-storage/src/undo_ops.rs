//! Conflict-safe undo with post-image validation and redo receipts.

use std::collections::HashMap;

use jiff::Timestamp;
use junban_app::{
    AffectedIds, CommittedMutation, EventType, RepositoryError, ResourceRef, ResourceSnapshot,
    ResyncScope,
};
use junban_domain::{CommentId, OperationId, SortOrder, TaskActivityAction, TaskId};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::helpers::{diff_task_fields, validate_task_refs};
use crate::ops_types::{Inverse, PostImage, TaskClosure, undo_pair};
use crate::reminder_ops::{
    load_reminder_occurrence, load_reminders_for_tasks, reminders_into_post,
    replace_reminders_for_tasks, upsert_reminder_occurrence,
};
use crate::rows::{
    activity_action_str, delete_task_row, field_activity, insert_task, load_blocks_edges,
    load_comment, load_task, revision_to_i64, storage_error, task_exists, update_task_row,
};
use crate::tx::{MutationEffect, canonical_json, mutate};

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
struct UndoReq {
    source_operation_id: String,
}

fn missing_as_conflict(error: RepositoryError) -> RepositoryError {
    match error {
        RepositoryError::NotFound => RepositoryError::Conflict,
        other => other,
    }
}

pub(crate) fn validate_post_image(
    tx: &rusqlite::Transaction<'_>,
    post: &PostImage,
) -> Result<(), RepositoryError> {
    for id in &post.absent_task_ids {
        if task_exists(tx, *id)? {
            return Err(RepositoryError::Conflict);
        }
    }
    for (id, expected) in &post.tasks {
        let task_id = TaskId::parse(id).map_err(storage_error)?;
        let actual = load_task(tx, task_id).map_err(missing_as_conflict)?;
        if &actual != expected {
            return Err(RepositoryError::Conflict);
        }
    }
    for id in &post.absent_comment_ids {
        match load_comment(tx, *id) {
            Ok(_) => return Err(RepositoryError::Conflict),
            Err(RepositoryError::NotFound) => {}
            Err(error) => return Err(error),
        }
    }
    for (id, expected) in &post.comments {
        let comment_id = CommentId::parse(id).map_err(storage_error)?;
        let actual = load_comment(tx, comment_id).map_err(missing_as_conflict)?;
        if &actual != expected {
            return Err(RepositoryError::Conflict);
        }
    }
    let edges = load_blocks_edges(tx)?;
    for relation in &post.relations_present {
        if !edges
            .iter()
            .any(|(f, t)| *f == relation.from_task_id && *t == relation.to_task_id)
        {
            return Err(RepositoryError::Conflict);
        }
    }
    for relation in &post.relations_absent {
        if edges
            .iter()
            .any(|(f, t)| *f == relation.from_task_id && *t == relation.to_task_id)
        {
            return Err(RepositoryError::Conflict);
        }
    }
    for (id, order) in &post.orders {
        let task_id = TaskId::parse(id).map_err(storage_error)?;
        let actual = load_task(tx, task_id).map_err(missing_as_conflict)?;
        if actual.sort_order.get() != *order {
            return Err(RepositoryError::Conflict);
        }
    }
    for expected in post.reminders.values() {
        let actual = load_reminder_occurrence(tx, expected.task_id, expected.remind_at)?
            .ok_or(RepositoryError::Conflict)?;
        if &actual != expected {
            return Err(RepositoryError::Conflict);
        }
    }
    Ok(())
}

fn restore_closure(
    tx: &rusqlite::Transaction<'_>,
    closure: &TaskClosure,
) -> Result<(), RepositoryError> {
    let mut remaining: HashMap<_, _> = closure
        .tasks
        .iter()
        .map(|task| (task.id, task.clone()))
        .collect();
    while !remaining.is_empty() {
        let ready: Vec<TaskId> = remaining
            .values()
            .filter(|task| {
                task.parent_id
                    .map(|parent| !remaining.contains_key(&parent))
                    .unwrap_or(true)
            })
            .map(|task| task.id)
            .collect();
        if ready.is_empty() {
            return Err(RepositoryError::Conflict);
        }
        for id in ready {
            let task = remaining.remove(&id).expect("ready");
            if let Some(parent) = task.parent_id
                && !task_exists(tx, parent)?
            {
                return Err(RepositoryError::Conflict);
            }
            if let Err(error) = validate_task_refs(tx, &task) {
                return Err(match error {
                    RepositoryError::NotFound => RepositoryError::Conflict,
                    other => other,
                });
            }
            if task_exists(tx, task.id)? {
                return Err(RepositoryError::Conflict);
            }
            insert_task(tx, &task)?;
        }
    }
    for comment in &closure.comments {
        tx.execute(
            "INSERT INTO comments(id, task_id, content, created_at, updated_at) VALUES (?1,?2,?3,?4,?5)",
            params![
                comment.id.to_string(),
                comment.task_id.to_string(),
                comment.content.as_str(),
                comment.created_at.to_string(),
                comment.updated_at.to_string(),
            ],
        )
        .map_err(|_| RepositoryError::Conflict)?;
    }
    for relation in &closure.relations {
        if !task_exists(tx, relation.from_task_id)? || !task_exists(tx, relation.to_task_id)? {
            return Err(RepositoryError::Conflict);
        }
        tx.execute(
            "INSERT OR IGNORE INTO task_relations(from_task_id, to_task_id, kind) VALUES (?1,?2,'blocks')",
            params![
                relation.from_task_id.to_string(),
                relation.to_task_id.to_string()
            ],
        )
        .map_err(storage_error)?;
    }
    for activity in &closure.activity {
        tx.execute(
            "INSERT OR IGNORE INTO task_activity(
                revision, sequence, operation_id, task_id, action, field, old_value, new_value, created_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                revision_to_i64(activity.revision)?,
                i64::from(activity.sequence),
                activity.operation_id.to_string(),
                activity.task_id.to_string(),
                activity_action_str(activity.action),
                activity.field,
                activity.old_value,
                activity.new_value,
                activity.created_at.to_string(),
            ],
        )
        .map_err(storage_error)?;
    }
    for reminder in &closure.reminders {
        upsert_reminder_occurrence(tx, reminder)?;
    }
    Ok(())
}

pub(crate) fn apply_inverse(
    tx: &rusqlite::Transaction<'_>,
    inverse: &Inverse,
    now: Timestamp,
    revision: u64,
    operation_id: OperationId,
) -> Result<
    (
        AffectedIds,
        Vec<junban_domain::TaskActivity>,
        Option<ResourceSnapshot>,
        ResyncScope,
    ),
    RepositoryError,
> {
    match inverse {
        Inverse::DeleteTasks { task_ids } => {
            let mut affected = Vec::new();
            let mut activity = Vec::new();
            for (index, id) in task_ids.iter().enumerate() {
                if task_exists(tx, *id)? {
                    delete_task_row(tx, *id)?;
                    affected.push(*id);
                    activity.push(field_activity(
                        revision,
                        u32::try_from(index).unwrap_or(u32::MAX),
                        operation_id,
                        *id,
                        TaskActivityAction::Deleted,
                        None,
                        None,
                        None,
                        now,
                    ));
                }
            }
            Ok((
                AffectedIds {
                    task_ids: affected,
                    ..AffectedIds::default()
                },
                activity,
                None,
                ResyncScope::TASKS,
            ))
        }
        Inverse::RestoreClosure { closure } => {
            restore_closure(tx, closure)?;
            let ids: Vec<_> = closure.tasks.iter().map(|t| t.id).collect();
            let activity = ids
                .iter()
                .enumerate()
                .map(|(index, id)| {
                    field_activity(
                        revision,
                        u32::try_from(index).unwrap_or(u32::MAX),
                        operation_id,
                        *id,
                        TaskActivityAction::Restored,
                        None,
                        None,
                        None,
                        now,
                    )
                })
                .collect();
            Ok((
                AffectedIds {
                    task_ids: ids,
                    ..AffectedIds::default()
                },
                activity,
                None,
                ResyncScope::TASKS,
            ))
        }
        Inverse::ReverseCompletion {
            sources,
            generated_ids,
            source_reminders,
        } => {
            // Drop receipt-owned generated children first, then restore sources.
            let mut affected = Vec::new();
            let mut activity = Vec::new();
            let mut seq = 0u32;
            for id in generated_ids {
                if task_exists(tx, *id)? {
                    delete_task_row(tx, *id)?;
                    affected.push(*id);
                    activity.push(field_activity(
                        revision,
                        seq,
                        operation_id,
                        *id,
                        TaskActivityAction::Deleted,
                        None,
                        None,
                        None,
                        now,
                    ));
                    seq = seq.saturating_add(1);
                }
            }
            let mut source_ids = Vec::with_capacity(sources.len());
            for task in sources {
                let before = load_task(tx, task.id).map_err(missing_as_conflict)?;
                let mut restored = task.clone();
                if let Err(error) = validate_task_refs(tx, &restored) {
                    return Err(missing_as_conflict(error));
                }
                restored.revision = revision;
                restored.updated_at = now;
                update_task_row(tx, &restored)?;
                let diffs = diff_task_fields(&before, &restored, revision, operation_id, now, seq);
                seq = seq.saturating_add(u32::try_from(diffs.len()).unwrap_or(0));
                activity.extend(diffs);
                affected.push(restored.id);
                source_ids.push(restored.id);
            }
            replace_reminders_for_tasks(tx, &source_ids, source_reminders)?;
            Ok((
                AffectedIds {
                    task_ids: affected,
                    ..AffectedIds::default()
                },
                activity,
                None,
                ResyncScope::TASKS,
            ))
        }
        Inverse::RestoreTasks { tasks, reminders } => {
            let mut affected = Vec::new();
            let mut activity = Vec::new();
            let mut seq = 0u32;
            let mut snapshot = None;
            for task in tasks {
                let before = match load_task(tx, task.id) {
                    Ok(task) => Some(task),
                    Err(RepositoryError::NotFound) => None,
                    Err(error) => return Err(error),
                };
                let mut restored = task.clone();
                // Validate external references before any insert/update write.
                if let Err(error) = validate_task_refs(tx, &restored) {
                    return Err(missing_as_conflict(error));
                }
                restored.revision = revision;
                restored.updated_at = now;
                if before.is_some() {
                    update_task_row(tx, &restored)?;
                } else {
                    insert_task(tx, &restored)?;
                }
                if let Some(before) = before {
                    let diffs =
                        diff_task_fields(&before, &restored, revision, operation_id, now, seq);
                    seq = seq.saturating_add(u32::try_from(diffs.len()).unwrap_or(0));
                    activity.extend(diffs);
                } else {
                    activity.push(field_activity(
                        revision,
                        seq,
                        operation_id,
                        restored.id,
                        TaskActivityAction::Restored,
                        None,
                        None,
                        None,
                        now,
                    ));
                    seq += 1;
                }
                affected.push(restored.id);
                if tasks.len() == 1 {
                    snapshot = Some(ResourceSnapshot::task(restored));
                }
            }
            let task_ids: Vec<_> = tasks.iter().map(|task| task.id).collect();
            replace_reminders_for_tasks(tx, &task_ids, reminders)?;
            Ok((
                AffectedIds {
                    task_ids: affected,
                    ..AffectedIds::default()
                },
                activity,
                snapshot,
                if tasks.len() > 1 {
                    ResyncScope::TASKS
                } else {
                    ResyncScope::NONE
                },
            ))
        }
        Inverse::RestoreOrders { orders } => {
            let mut affected = Vec::new();
            let mut activity = Vec::new();
            for (index, (id, order)) in orders.iter().enumerate() {
                let mut task = load_task(tx, *id).map_err(missing_as_conflict)?;
                task.sort_order = *order;
                task.updated_at = now;
                task.revision = revision;
                update_task_row(tx, &task)?;
                affected.push(*id);
                activity.push(field_activity(
                    revision,
                    u32::try_from(index).unwrap_or(u32::MAX),
                    operation_id,
                    *id,
                    TaskActivityAction::Updated,
                    Some("sort_order"),
                    None,
                    Some(order.get().to_string()),
                    now,
                ));
            }
            Ok((
                AffectedIds {
                    task_ids: affected,
                    ..AffectedIds::default()
                },
                activity,
                None,
                ResyncScope::TASKS,
            ))
        }
        Inverse::RestoreComment { before, after_id } => match before {
            None => {
                let current = load_comment(tx, *after_id).map_err(missing_as_conflict)?;
                tx.execute("DELETE FROM comments WHERE id=?1", [after_id.to_string()])
                    .map_err(storage_error)?;
                Ok((
                    AffectedIds {
                        comment_ids: vec![*after_id],
                        task_ids: vec![current.task_id],
                        ..AffectedIds::default()
                    },
                    vec![field_activity(
                        revision,
                        0,
                        operation_id,
                        current.task_id,
                        TaskActivityAction::Updated,
                        Some("comment"),
                        Some(after_id.to_string()),
                        None,
                        now,
                    )],
                    None,
                    ResyncScope::NONE,
                ))
            }
            Some(comment) => {
                if !task_exists(tx, comment.task_id)? {
                    return Err(RepositoryError::Conflict);
                }
                if load_comment(tx, comment.id).is_ok() {
                    tx.execute(
                        "UPDATE comments SET content=?1, updated_at=?2 WHERE id=?3",
                        params![
                            comment.content.as_str(),
                            now.to_string(),
                            comment.id.to_string()
                        ],
                    )
                    .map_err(storage_error)?;
                } else {
                    tx.execute(
                        "INSERT INTO comments(id, task_id, content, created_at, updated_at) VALUES (?1,?2,?3,?4,?5)",
                        params![
                            comment.id.to_string(),
                            comment.task_id.to_string(),
                            comment.content.as_str(),
                            comment.created_at.to_string(),
                            now.to_string(),
                        ],
                    )
                    .map_err(|_| RepositoryError::Conflict)?;
                }
                let restored = load_comment(tx, comment.id).map_err(missing_as_conflict)?;
                Ok((
                    AffectedIds {
                        comment_ids: vec![comment.id],
                        task_ids: vec![comment.task_id],
                        ..AffectedIds::default()
                    },
                    vec![field_activity(
                        revision,
                        0,
                        operation_id,
                        comment.task_id,
                        TaskActivityAction::Updated,
                        Some("comment"),
                        None,
                        Some(comment.id.to_string()),
                        now,
                    )],
                    Some(ResourceSnapshot::Comment { comment: restored }),
                    ResyncScope::NONE,
                ))
            }
        },
        Inverse::RestoreRelation { relation, present } => {
            if *present {
                if !task_exists(tx, relation.from_task_id)?
                    || !task_exists(tx, relation.to_task_id)?
                {
                    return Err(RepositoryError::Conflict);
                }
                tx.execute(
                    "INSERT OR IGNORE INTO task_relations(from_task_id, to_task_id, kind) VALUES (?1,?2,'blocks')",
                    params![
                        relation.from_task_id.to_string(),
                        relation.to_task_id.to_string()
                    ],
                )
                .map_err(storage_error)?;
            } else {
                tx.execute(
                    "DELETE FROM task_relations WHERE from_task_id=?1 AND to_task_id=?2 AND kind='blocks'",
                    params![
                        relation.from_task_id.to_string(),
                        relation.to_task_id.to_string()
                    ],
                )
                .map_err(storage_error)?;
            }
            Ok((
                AffectedIds {
                    task_ids: vec![relation.from_task_id, relation.to_task_id],
                    ..AffectedIds::default()
                },
                vec![field_activity(
                    revision,
                    0,
                    operation_id,
                    relation.from_task_id,
                    TaskActivityAction::Updated,
                    Some("blocks"),
                    None,
                    Some(relation.to_task_id.to_string()),
                    now,
                )],
                None,
                ResyncScope::TASKS,
            ))
        }
    }
}

fn capture_redo_post(
    tx: &rusqlite::Transaction<'_>,
    affected: &AffectedIds,
) -> Result<PostImage, RepositoryError> {
    let mut redo_post = PostImage::default();
    for id in &affected.task_ids {
        if let Ok(task) = load_task(tx, *id) {
            redo_post
                .orders
                .insert(task.id.to_string(), task.sort_order.get());
            redo_post.tasks.insert(task.id.to_string(), task);
        } else {
            redo_post.absent_task_ids.push(*id);
        }
    }
    for id in &affected.comment_ids {
        if let Ok(comment) = load_comment(tx, *id) {
            redo_post.comments.insert(comment.id.to_string(), comment);
        } else {
            redo_post.absent_comment_ids.push(*id);
        }
    }
    let reminders = load_reminders_for_tasks(tx, &affected.task_ids)?;
    reminders_into_post(&mut redo_post, reminders);
    Ok(redo_post)
}

fn redo_inverse_for(inverse: &Inverse, post: &PostImage, affected: &AffectedIds) -> Inverse {
    match inverse {
        Inverse::DeleteTasks { .. } => Inverse::RestoreTasks {
            tasks: post.tasks.values().cloned().collect(),
            reminders: post.reminders.values().cloned().collect(),
        },
        Inverse::RestoreClosure { .. } => Inverse::DeleteTasks {
            task_ids: affected.task_ids.clone(),
        },
        Inverse::RestoreTasks { .. } => Inverse::RestoreTasks {
            tasks: post.tasks.values().cloned().collect(),
            reminders: post.reminders.values().cloned().collect(),
        },
        Inverse::ReverseCompletion { generated_ids, .. } => {
            // Undo of reverse-completion re-applies the completed post-image (sources +
            // generated children). Generated IDs that are absent are reinserted from post.
            let _ = generated_ids;
            Inverse::RestoreTasks {
                tasks: post.tasks.values().cloned().collect(),
                reminders: post.reminders.values().cloned().collect(),
            }
        }
        Inverse::RestoreOrders { .. } => Inverse::RestoreOrders {
            orders: post
                .orders
                .iter()
                .filter_map(|(id, order)| {
                    TaskId::parse(id)
                        .ok()
                        .map(|id| (id, SortOrder::new(*order)))
                })
                .collect(),
        },
        Inverse::RestoreComment { before, after_id } => Inverse::RestoreComment {
            before: post
                .comments
                .get(&after_id.to_string())
                .cloned()
                .or_else(|| before.clone()),
            after_id: *after_id,
        },
        Inverse::RestoreRelation { relation, present } => Inverse::RestoreRelation {
            relation: relation.clone(),
            present: !*present,
        },
    }
}

pub(crate) fn undo(
    connection: &mut Connection,
    source_operation_id: OperationId,
    new_operation_id: OperationId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&UndoReq {
        source_operation_id: source_operation_id.to_string(),
    })?;
    mutate(
        connection,
        new_operation_id,
        request,
        now,
        move |tx, revision| {
            let row = tx
                .query_row(
                    "SELECT inverse_json, post_image_json, undone_by_operation_id
                     FROM operation_undo WHERE source_operation_id = ?1",
                    [source_operation_id.to_string()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(storage_error)?;
            let Some((inverse_json, post_image_json, undone_by)) = row else {
                return Err(RepositoryError::NotFound);
            };
            if undone_by.is_some() {
                return Err(RepositoryError::Conflict);
            }
            let inverse: Inverse = serde_json::from_str(&inverse_json).map_err(storage_error)?;
            let post: PostImage = serde_json::from_str(&post_image_json).map_err(storage_error)?;
            validate_post_image(tx, &post)?;
            let (affected, activity, snapshot, resync) =
                apply_inverse(tx, &inverse, now, revision, new_operation_id)?;
            let redo_post = capture_redo_post(tx, &affected)?;
            // For undo of create/delete, use original post image as redo target when tasks vanished.
            let redo_source_post = if redo_post.tasks.is_empty() && !post.tasks.is_empty() {
                // We deleted tasks; redo should restore post.
                post.clone()
            } else {
                redo_post
            };
            let redo_inverse = redo_inverse_for(&inverse, &post, &affected);
            // Prefer using original post as the expected state after redo of this undo when
            // inverse restored prior state from post.
            let undo = undo_pair(&redo_inverse, &{
                // After applying inverse, current state is redo_source_post for conflict checks
                // on a subsequent undo (redo).
                let mut current = capture_redo_post(tx, &affected)?;
                if current.tasks.is_empty() && current.absent_task_ids.is_empty() {
                    current = redo_source_post;
                }
                current
            })?;

            Ok(MutationEffect {
                event_type: EventType::new(EventType::OPERATION_UNDONE),
                primary: Some(ResourceRef::operation(source_operation_id)),
                snapshot,
                affected,
                resync,
                task_activity: activity,
                summary_subject: Some(("operation".into(), source_operation_id.to_string())),
                undo: Some(undo),
                mark_undone: Some(source_operation_id),
                uncomplete_outcome: None,
            })
        },
    )
}
