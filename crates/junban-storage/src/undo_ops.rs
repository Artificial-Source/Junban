//! Conflict-safe undo with post-image validation and redo receipts.

use std::collections::{HashMap, HashSet};

use jiff::Timestamp;
use junban_app::{
    AffectedIds, CommittedMutation, EventType, RepositoryError, ResourceRef, ResourceSnapshot,
    ResyncScope,
};
use junban_domain::{
    CommentId, OperationId, Project, ProjectId, SortOrder, Tag, TagId, TaskActivityAction, TaskId,
    TimeBlockId, TimeSlotId,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::helpers::{diff_task_fields, validate_task_refs};
use crate::ops_types::{
    ClosureBlockLink, ClosureSlotMembership, Inverse, PostImage, TaskClosure,
    restore_tasks_inverse, restore_tasks_with_planning, undo_pair,
};
use crate::reminder_ops::{
    load_reminder_occurrence, load_reminder_snapshot, reminders_into_post,
    replace_reminders_for_tasks, upsert_reminder_occurrence,
};
use crate::rows::{
    activity_action_str, delete_task_row, field_activity, insert_task, load_blocks_edges,
    load_comment, load_project, load_tag, load_task, revision_to_i64, storage_error, task_exists,
    update_task_row,
};
use crate::timeblock_ops::{
    detach_planning_links_for_tasks, load_time_block, load_time_slot, restore_planning_links,
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

fn validate_generated_task_references(
    tx: &rusqlite::Connection,
    generated_ids: &[TaskId],
    post: &PostImage,
) -> Result<(), RepositoryError> {
    if generated_ids.is_empty() {
        return Ok(());
    }

    let placeholders = vec!["?"; generated_ids.len()].join(",");
    let sql = format!(
        "SELECT
            (SELECT COUNT(*) FROM tasks WHERE parent_id IN ({placeholders})),
            (SELECT COUNT(*) FROM tasks WHERE recurrence_source_id IN ({placeholders})),
            (SELECT COUNT(*) FROM comments WHERE task_id IN ({placeholders})),
            (SELECT COUNT(*) FROM task_relations WHERE from_task_id IN ({placeholders})),
            (SELECT COUNT(*) FROM task_relations WHERE to_task_id IN ({placeholders})),
            (SELECT COUNT(*) FROM time_blocks WHERE task_id IN ({placeholders})),
            (SELECT COUNT(*) FROM time_slot_tasks WHERE task_id IN ({placeholders})),
            (SELECT COUNT(*) FROM reminder_occurrences WHERE task_id IN ({placeholders}))"
    );
    let params: Vec<String> = (0..8)
        .flat_map(|_| generated_ids.iter().map(ToString::to_string))
        .collect();
    let actual: [i64; 8] = tx
        .query_row(&sql, rusqlite::params_from_iter(&params), |row| {
            Ok([
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ])
        })
        .map_err(storage_error)?;

    let generated = |id: TaskId| generated_ids.contains(&id);
    let expected = [
        post.tasks
            .values()
            .filter(|task| task.parent_id.is_some_and(generated))
            .count(),
        post.tasks
            .values()
            .filter(|task| task.recurrence_source_id.is_some_and(generated))
            .count(),
        post.comments
            .values()
            .filter(|comment| generated(comment.task_id))
            .count(),
        post.relations_present
            .iter()
            .filter(|relation| generated(relation.from_task_id))
            .count(),
        post.relations_present
            .iter()
            .filter(|relation| generated(relation.to_task_id))
            .count(),
        post.time_blocks
            .values()
            .filter(|block| block.task_id.is_some_and(generated))
            .count(),
        post.time_slots
            .values()
            .map(|slot| {
                slot.task_ids
                    .iter()
                    .filter(|task_id| generated(**task_id))
                    .count()
            })
            .sum(),
        post.reminders
            .values()
            .filter(|reminder| generated(reminder.task_id))
            .count(),
    ]
    .map(|count| i64::try_from(count).unwrap_or(i64::MAX));

    if actual != expected {
        return Err(RepositoryError::Conflict);
    }
    Ok(())
}

pub(crate) fn validate_inverse_post_image(
    tx: &rusqlite::Connection,
    inverse: &Inverse,
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
    for id in &post.absent_project_ids {
        match load_project(tx, *id) {
            Ok(_) => return Err(RepositoryError::Conflict),
            Err(RepositoryError::NotFound) => {}
            Err(error) => return Err(error),
        }
    }
    for (id, expected) in &post.projects {
        let project_id = ProjectId::parse(id).map_err(storage_error)?;
        if load_project(tx, project_id).map_err(missing_as_conflict)? != *expected {
            return Err(RepositoryError::Conflict);
        }
    }
    for id in &post.absent_tag_ids {
        match load_tag(tx, *id) {
            Ok(_) => return Err(RepositoryError::Conflict),
            Err(RepositoryError::NotFound) => {}
            Err(error) => return Err(error),
        }
    }
    for (id, expected) in &post.tags {
        let tag_id = TagId::parse(id).map_err(storage_error)?;
        if load_tag(tx, tag_id).map_err(missing_as_conflict)? != *expected {
            return Err(RepositoryError::Conflict);
        }
    }
    if let Inverse::DeleteImport {
        task_ids,
        projects,
        tags,
    } = inverse
    {
        validate_import_catalog_ownership(tx, task_ids, projects, tags)?;
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
    for (id, expected) in &post.time_slots {
        let slot_id = TimeSlotId::parse(id).map_err(storage_error)?;
        let actual = load_time_slot(tx, slot_id).map_err(missing_as_conflict)?;
        if actual.revision != expected.revision
            || actual.task_ids.as_slice() != expected.task_ids.as_slice()
        {
            return Err(RepositoryError::Conflict);
        }
    }
    for (id, expected) in &post.time_blocks {
        let block_id = TimeBlockId::parse(id).map_err(storage_error)?;
        let actual = load_time_block(tx, block_id).map_err(missing_as_conflict)?;
        if actual.revision != expected.revision || actual.task_id != expected.task_id {
            return Err(RepositoryError::Conflict);
        }
    }
    if let Inverse::ReverseCompletion { generated_ids, .. } = inverse {
        validate_generated_task_references(tx, generated_ids, post)?;
    }
    Ok(())
}

fn restore_closure(
    tx: &rusqlite::Connection,
    closure: &TaskClosure,
    now: Timestamp,
    revision: u64,
) -> Result<(Vec<TimeSlotId>, Vec<TimeBlockId>), RepositoryError> {
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
    restore_planning_links(
        tx,
        &closure.slot_memberships,
        &closure.block_links,
        now,
        revision,
    )
}

/// Planning links captured while applying a delete inverse, owned by the redo restore.
#[derive(Debug, Default, Clone)]
pub(crate) struct DetachedPlanning {
    slot_memberships: Vec<ClosureSlotMembership>,
    block_links: Vec<ClosureBlockLink>,
}

/// Result of applying a stored inverse inside a mutation transaction.
pub(crate) struct InverseApply {
    pub affected: AffectedIds,
    pub activity: Vec<junban_domain::TaskActivity>,
    pub snapshot: Option<ResourceSnapshot>,
    pub resync: ResyncScope,
    pub detached: DetachedPlanning,
}

fn validate_import_catalog_ownership(
    tx: &rusqlite::Connection,
    task_ids: &[TaskId],
    projects: &[Project],
    tags: &[Tag],
) -> Result<(), RepositoryError> {
    let owned_tasks = task_ids.iter().copied().collect::<HashSet<_>>();
    for project in projects {
        let mut statement = tx
            .prepare("SELECT id FROM tasks WHERE project_id = ?1")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([project.id.to_string()], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        for row in rows {
            let id = TaskId::parse(&row.map_err(storage_error)?).map_err(storage_error)?;
            if !owned_tasks.contains(&id) {
                return Err(RepositoryError::Conflict);
            }
        }
        let external_refs: i64 = tx
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM sections WHERE project_id = ?1) +
                    (SELECT COUNT(*) FROM projects WHERE parent_id = ?1) +
                    (SELECT COUNT(*) FROM templates WHERE project_id = ?1) +
                    (SELECT COUNT(*) FROM time_slots WHERE project_id = ?1)",
                [project.id.to_string()],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if external_refs != 0 {
            return Err(RepositoryError::Conflict);
        }
    }
    for tag in tags {
        let mut statement = tx
            .prepare("SELECT task_id FROM task_tags WHERE tag_id = ?1")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([tag.id.to_string()], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        for row in rows {
            let id = TaskId::parse(&row.map_err(storage_error)?).map_err(storage_error)?;
            if !owned_tasks.contains(&id) {
                return Err(RepositoryError::Conflict);
            }
        }
        let template_refs: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM template_tags WHERE tag_id = ?1",
                [tag.id.to_string()],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if template_refs != 0 {
            return Err(RepositoryError::Conflict);
        }
    }
    Ok(())
}

fn insert_import_project(
    tx: &rusqlite::Connection,
    project: &Project,
) -> Result<(), RepositoryError> {
    tx.execute(
        "INSERT INTO projects(id,name,color,icon,parent_id,favorite,archived,view_style,sort_order,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            project.id.to_string(),
            project.name.as_str(),
            project.color.as_str(),
            project.icon.as_ref().map(ToString::to_string),
            project.parent_id.map(|id| id.to_string()),
            i64::from(project.favorite),
            i64::from(project.archived),
            match project.view {
                junban_domain::ProjectView::List => "list",
                junban_domain::ProjectView::Board => "board",
                junban_domain::ProjectView::Calendar => "calendar",
            },
            project.sort_order.get(),
            project.created_at.to_string(),
            project.updated_at.to_string(),
        ],
    )
    .map_err(|_| RepositoryError::Conflict)?;
    Ok(())
}

fn insert_import_tag(tx: &rusqlite::Connection, tag: &Tag) -> Result<(), RepositoryError> {
    tx.execute(
        "INSERT INTO tags(id,name,name_normalized,color,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            tag.id.to_string(),
            tag.name.as_str(),
            crate::rows::normalize_tag_name(tag.name.as_str()),
            tag.color.as_str(),
            tag.created_at.to_string(),
            tag.updated_at.to_string(),
        ],
    )
    .map_err(|_| RepositoryError::Conflict)?;
    Ok(())
}

pub(crate) fn apply_inverse(
    tx: &rusqlite::Connection,
    inverse: &Inverse,
    now: Timestamp,
    revision: u64,
    operation_id: OperationId,
) -> Result<InverseApply, RepositoryError> {
    match inverse {
        Inverse::DeleteTasks { task_ids } => {
            let mut affected = Vec::new();
            let mut activity = Vec::new();
            for id in task_ids {
                if task_exists(tx, *id)? {
                    affected.push(*id);
                }
            }
            // Explicit planning detach on every delete inverse (create-undo and
            // delete-redo) so FK CASCADE/SET NULL cannot drop unrecovered links.
            // Capture exact live memberships/links for the redo RestoreTasks inverse.
            let planning = detach_planning_links_for_tasks(tx, &affected, now, revision)?;
            let detached = DetachedPlanning {
                slot_memberships: planning.slot_memberships,
                block_links: planning.block_links,
            };
            for (index, id) in affected.iter().enumerate() {
                delete_task_row(tx, *id)?;
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
            Ok(InverseApply {
                affected: AffectedIds {
                    task_ids: affected,
                    time_slot_ids: planning.time_slot_ids,
                    time_block_ids: planning.time_block_ids,
                    ..AffectedIds::default()
                },
                activity,
                snapshot: None,
                resync: ResyncScope::TASKS,
                detached,
            })
        }
        Inverse::DeleteImport {
            task_ids,
            projects,
            tags,
        } => {
            let mut affected = Vec::with_capacity(task_ids.len());
            for id in task_ids {
                if task_exists(tx, *id)? {
                    affected.push(*id);
                }
            }
            let planning = detach_planning_links_for_tasks(tx, &affected, now, revision)?;
            let detached = DetachedPlanning {
                slot_memberships: planning.slot_memberships,
                block_links: planning.block_links,
            };
            let mut activity = Vec::with_capacity(affected.len());
            for (index, id) in affected.iter().enumerate() {
                delete_task_row(tx, *id)?;
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
            for tag in tags {
                tx.execute("DELETE FROM tags WHERE id = ?1", [tag.id.to_string()])
                    .map_err(storage_error)?;
            }
            for project in projects {
                tx.execute(
                    "DELETE FROM projects WHERE id = ?1",
                    [project.id.to_string()],
                )
                .map_err(storage_error)?;
            }
            Ok(InverseApply {
                affected: AffectedIds {
                    task_ids: affected,
                    project_ids: projects.iter().map(|item| item.id).collect(),
                    tag_ids: tags.iter().map(|item| item.id).collect(),
                    time_slot_ids: planning.time_slot_ids,
                    time_block_ids: planning.time_block_ids,
                    ..AffectedIds::default()
                },
                activity,
                snapshot: None,
                resync: ResyncScope::BOTH,
                detached,
            })
        }
        Inverse::RestoreImport {
            tasks,
            projects,
            tags,
        } => {
            for project in projects {
                insert_import_project(tx, project)?;
            }
            for tag in tags {
                insert_import_tag(tx, tag)?;
            }
            let mut activity = Vec::with_capacity(tasks.len());
            for (index, task) in tasks.iter().enumerate() {
                let mut restored = task.clone();
                restored.revision = revision;
                restored.updated_at = now;
                validate_task_refs(tx, &restored).map_err(missing_as_conflict)?;
                insert_task(tx, &restored)?;
                activity.push(field_activity(
                    revision,
                    u32::try_from(index).unwrap_or(u32::MAX),
                    operation_id,
                    restored.id,
                    TaskActivityAction::Restored,
                    None,
                    None,
                    None,
                    now,
                ));
            }
            Ok(InverseApply {
                affected: AffectedIds {
                    task_ids: tasks.iter().map(|item| item.id).collect(),
                    project_ids: projects.iter().map(|item| item.id).collect(),
                    tag_ids: tags.iter().map(|item| item.id).collect(),
                    ..AffectedIds::default()
                },
                activity,
                snapshot: None,
                resync: ResyncScope::BOTH,
                detached: DetachedPlanning::default(),
            })
        }
        Inverse::RestoreClosure { closure } => {
            let (time_slot_ids, time_block_ids) = restore_closure(tx, closure, now, revision)?;
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
            Ok(InverseApply {
                affected: AffectedIds {
                    task_ids: ids,
                    time_slot_ids,
                    time_block_ids,
                    ..AffectedIds::default()
                },
                activity,
                snapshot: None,
                resync: ResyncScope::TASKS,
                detached: DetachedPlanning::default(),
            })
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
            Ok(InverseApply {
                affected: AffectedIds {
                    task_ids: affected,
                    ..AffectedIds::default()
                },
                activity,
                snapshot: None,
                resync: ResyncScope::TASKS,
                detached: DetachedPlanning::default(),
            })
        }
        Inverse::RestoreTasks {
            tasks,
            reminders,
            slot_memberships,
            block_links,
        } => {
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
            // Reattach receipt-owned planning links after task rows exist again.
            let (time_slot_ids, time_block_ids) =
                restore_planning_links(tx, slot_memberships, block_links, now, revision)?;
            let resync =
                if tasks.len() > 1 || !time_slot_ids.is_empty() || !time_block_ids.is_empty() {
                    ResyncScope::TASKS
                } else {
                    ResyncScope::NONE
                };
            Ok(InverseApply {
                affected: AffectedIds {
                    task_ids: affected,
                    time_slot_ids,
                    time_block_ids,
                    ..AffectedIds::default()
                },
                activity,
                snapshot,
                resync,
                detached: DetachedPlanning::default(),
            })
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
            Ok(InverseApply {
                affected: AffectedIds {
                    task_ids: affected,
                    ..AffectedIds::default()
                },
                activity,
                snapshot: None,
                resync: ResyncScope::TASKS,
                detached: DetachedPlanning::default(),
            })
        }
        Inverse::RestoreComment { before, after_id } => match before {
            None => {
                let current = load_comment(tx, *after_id).map_err(missing_as_conflict)?;
                tx.execute("DELETE FROM comments WHERE id=?1", [after_id.to_string()])
                    .map_err(storage_error)?;
                Ok(InverseApply {
                    affected: AffectedIds {
                        comment_ids: vec![*after_id],
                        task_ids: vec![current.task_id],
                        ..AffectedIds::default()
                    },
                    activity: vec![field_activity(
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
                    snapshot: None,
                    resync: ResyncScope::NONE,
                    detached: DetachedPlanning::default(),
                })
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
                Ok(InverseApply {
                    affected: AffectedIds {
                        comment_ids: vec![comment.id],
                        task_ids: vec![comment.task_id],
                        ..AffectedIds::default()
                    },
                    activity: vec![field_activity(
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
                    snapshot: Some(ResourceSnapshot::Comment { comment: restored }),
                    resync: ResyncScope::NONE,
                    detached: DetachedPlanning::default(),
                })
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
            Ok(InverseApply {
                affected: AffectedIds {
                    task_ids: vec![relation.from_task_id, relation.to_task_id],
                    ..AffectedIds::default()
                },
                activity: vec![field_activity(
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
                snapshot: None,
                resync: ResyncScope::TASKS,
                detached: DetachedPlanning::default(),
            })
        }
    }
}

fn capture_redo_post(
    tx: &rusqlite::Connection,
    affected: &AffectedIds,
    now: Timestamp,
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
    for id in &affected.project_ids {
        if let Ok(project) = load_project(tx, *id) {
            redo_post.projects.insert(project.id.to_string(), project);
        } else {
            redo_post.absent_project_ids.push(*id);
        }
    }
    for id in &affected.tag_ids {
        if let Ok(tag) = load_tag(tx, *id) {
            redo_post.tags.insert(tag.id.to_string(), tag);
        } else {
            redo_post.absent_tag_ids.push(*id);
        }
    }
    for id in &affected.comment_ids {
        if let Ok(comment) = load_comment(tx, *id) {
            redo_post.comments.insert(comment.id.to_string(), comment);
        } else {
            redo_post.absent_comment_ids.push(*id);
        }
    }
    let reminders = load_reminder_snapshot(tx, &affected.task_ids, now)?;
    reminders_into_post(&mut redo_post, reminders);
    for id in &affected.time_slot_ids {
        if let Ok(slot) = load_time_slot(tx, *id) {
            redo_post.time_slots.insert(
                slot.id.to_string(),
                crate::ops_types::PostTimeSlotState {
                    revision: slot.revision,
                    task_ids: slot.task_ids.as_slice().to_vec(),
                },
            );
        }
    }
    for id in &affected.time_block_ids {
        if let Ok(block) = load_time_block(tx, *id) {
            redo_post.time_blocks.insert(
                block.id.to_string(),
                crate::ops_types::PostTimeBlockState {
                    revision: block.revision,
                    task_id: block.task_id,
                },
            );
        }
    }
    Ok(redo_post)
}

fn redo_inverse_for(
    inverse: &Inverse,
    post: &PostImage,
    affected: &AffectedIds,
    detached: DetachedPlanning,
) -> Inverse {
    match inverse {
        Inverse::DeleteTasks { .. } => restore_tasks_with_planning(
            post.tasks.values().cloned().collect(),
            post.reminders.values().cloned().collect(),
            detached.slot_memberships,
            detached.block_links,
        ),
        Inverse::DeleteImport { projects, tags, .. } => Inverse::RestoreImport {
            tasks: post.tasks.values().cloned().collect(),
            projects: projects.clone(),
            tags: tags.clone(),
        },
        Inverse::RestoreImport {
            tasks,
            projects,
            tags,
        } => Inverse::DeleteImport {
            task_ids: tasks.iter().map(|item| item.id).collect(),
            projects: projects.clone(),
            tags: tags.clone(),
        },
        Inverse::RestoreClosure { .. } => Inverse::DeleteTasks {
            task_ids: affected.task_ids.clone(),
        },
        Inverse::RestoreTasks { .. } => {
            // Undoing a delete-redo restore must re-delete; post holds absent tasks.
            if post.tasks.is_empty() && !post.absent_task_ids.is_empty() {
                Inverse::DeleteTasks {
                    task_ids: post.absent_task_ids.clone(),
                }
            } else {
                restore_tasks_inverse(
                    post.tasks.values().cloned().collect(),
                    post.reminders.values().cloned().collect(),
                )
            }
        }
        Inverse::ReverseCompletion { generated_ids, .. } => {
            // Undo of reverse-completion re-applies the completed post-image (sources +
            // generated children). Generated IDs that are absent are reinserted from post.
            let _ = generated_ids;
            restore_tasks_inverse(
                post.tasks.values().cloned().collect(),
                post.reminders.values().cloned().collect(),
            )
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
            validate_inverse_post_image(tx, &inverse, &post)?;
            let applied = apply_inverse(tx, &inverse, now, revision, new_operation_id)?;
            let redo_post = capture_redo_post(tx, &applied.affected, now)?;
            // For undo of create/delete, use original post image as redo target when tasks vanished.
            let redo_source_post = if redo_post.tasks.is_empty() && !post.tasks.is_empty() {
                // We deleted tasks; redo should restore post.
                post.clone()
            } else {
                redo_post
            };
            let redo_inverse =
                redo_inverse_for(&inverse, &post, &applied.affected, applied.detached);
            // Prefer using original post as the expected state after redo of this undo when
            // inverse restored prior state from post.
            let undo = undo_pair(&redo_inverse, &{
                // After applying inverse, current state is redo_source_post for conflict checks
                // on a subsequent undo (redo).
                let mut current = capture_redo_post(tx, &applied.affected, now)?;
                if current.tasks.is_empty() && current.absent_task_ids.is_empty() {
                    current = redo_source_post;
                }
                current
            })?;

            Ok(MutationEffect {
                event_type: EventType::new(EventType::OPERATION_UNDONE),
                primary: Some(ResourceRef::operation(source_operation_id)),
                snapshot: applied.snapshot,
                affected: applied.affected,
                resync: applied.resync,
                task_activity: applied.activity,
                summary_subject: Some(("operation".into(), source_operation_id.to_string())),
                undo: Some(undo),
                mark_undone: Some(source_operation_id),
                uncomplete_outcome: None,
            })
        },
    )
}
