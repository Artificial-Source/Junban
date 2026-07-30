//! Comments, relations, activity, and event catch-up.

use jiff::Timestamp;
use junban_app::{
    AffectedIds, CommentPatch, CommittedEvent, CommittedMutation, EVENT_CATCHUP_MAX_BYTES,
    EVENT_CATCHUP_MAX_COUNT, EventCatchUp, EventType, RepositoryError, ResourceRef,
    ResourceSnapshot, ResyncScope,
};
use junban_domain::{
    Comment, CommentBody, CommentId, OperationId, RelationKind, TaskActivity, TaskActivityAction,
    TaskId, TaskRelation, blocks_edge_creates_cycle,
};
use rusqlite::{Connection, params};
use serde::Serialize;

use crate::helpers::{constraint_conflict, validation};
use crate::ops_types::{Inverse, PostImage, undo_pair};
use crate::rows::{
    field_activity, load_blocks_edges, load_comment, load_comments_for_tasks,
    load_relations_touching, parse_sql, revision_to_i64, storage_error, task_exists,
};
use crate::tx::{MutationEffect, canonical_json, global_revision, mutate};

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Req<'a> {
    // comment_id is server-generated and excluded from canonical identity for replay.
    CreateComment {
        task_id: String,
        content: &'a str,
    },
    PatchComment {
        comment_id: String,
        patch: &'a CommentPatch,
    },
    DeleteComment {
        comment_id: String,
    },
    AddRelation {
        from_task_id: String,
        to_task_id: String,
        kind: &'a str,
    },
    RemoveRelation {
        from_task_id: String,
        to_task_id: String,
        kind: &'a str,
    },
}

pub(crate) fn create_comment(
    c: &mut Connection,
    op: OperationId,
    comment_id: CommentId,
    task_id: TaskId,
    content: CommentBody,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::CreateComment {
        task_id: task_id.to_string(),
        content: content.as_str(),
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        if !task_exists(tx, task_id)? {
            return Err(RepositoryError::NotFound);
        }
        let comment = Comment {
            id: comment_id,
            task_id,
            content,
            created_at: now,
            updated_at: now,
        };
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
        .map_err(constraint_conflict)?;
        let activity = vec![field_activity(
            revision,
            0,
            op,
            task_id,
            TaskActivityAction::Updated,
            Some("comment"),
            None,
            Some(comment.id.to_string()),
            now,
        )];
        let mut post = PostImage::default();
        post.comments
            .insert(comment.id.to_string(), comment.clone());
        let undo = undo_pair(
            &Inverse::RestoreComment {
                before: None,
                after_id: comment.id,
            },
            &post,
        )?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::COMMENT_CREATED),
            primary: Some(ResourceRef::comment(comment.id)),
            snapshot: Some(ResourceSnapshot::Comment {
                comment: comment.clone(),
            }),
            affected: AffectedIds {
                comment_ids: vec![comment.id],
                task_ids: vec![task_id],
                ..AffectedIds::default()
            },
            resync: ResyncScope::NONE,
            task_activity: activity,
            summary_subject: Some(("comment".into(), comment.id.to_string())),
            undo: Some(undo),
            mark_undone: None,
        })
    })
}

pub(crate) fn patch_comment(
    c: &mut Connection,
    op: OperationId,
    comment_id: CommentId,
    patch: CommentPatch,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::PatchComment {
        comment_id: comment_id.to_string(),
        patch: &patch,
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let before = load_comment(tx, comment_id)?;
        let mut after = before.clone();
        if let Some(content) = patch.content {
            after.content = content;
        }
        after.updated_at = now;
        tx.execute(
            "UPDATE comments SET content=?1, updated_at=?2 WHERE id=?3",
            params![
                after.content.as_str(),
                after.updated_at.to_string(),
                after.id.to_string()
            ],
        )
        .map_err(storage_error)?;
        let activity = vec![field_activity(
            revision,
            0,
            op,
            after.task_id,
            TaskActivityAction::Updated,
            Some("comment"),
            Some(before.content.as_str().to_owned()),
            Some(after.content.as_str().to_owned()),
            now,
        )];
        let mut post = PostImage::default();
        post.comments.insert(after.id.to_string(), after.clone());
        let undo = undo_pair(
            &Inverse::RestoreComment {
                before: Some(before),
                after_id: after.id,
            },
            &post,
        )?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::COMMENT_UPDATED),
            primary: Some(ResourceRef::comment(after.id)),
            snapshot: Some(ResourceSnapshot::Comment {
                comment: after.clone(),
            }),
            affected: AffectedIds {
                comment_ids: vec![after.id],
                task_ids: vec![after.task_id],
                ..AffectedIds::default()
            },
            resync: ResyncScope::NONE,
            task_activity: activity,
            summary_subject: Some(("comment".into(), after.id.to_string())),
            undo: Some(undo),
            mark_undone: None,
        })
    })
}

pub(crate) fn delete_comment(
    c: &mut Connection,
    op: OperationId,
    comment_id: CommentId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::DeleteComment {
        comment_id: comment_id.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let before = load_comment(tx, comment_id)?;
        tx.execute(
            "DELETE FROM comments WHERE id = ?1",
            [comment_id.to_string()],
        )
        .map_err(storage_error)?;
        let activity = vec![field_activity(
            revision,
            0,
            op,
            before.task_id,
            TaskActivityAction::Updated,
            Some("comment"),
            Some(before.id.to_string()),
            None,
            now,
        )];
        let mut post = PostImage::default();
        post.absent_comment_ids.push(comment_id);
        let undo = undo_pair(
            &Inverse::RestoreComment {
                before: Some(before.clone()),
                after_id: comment_id,
            },
            &post,
        )?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::COMMENT_DELETED),
            primary: Some(ResourceRef::comment(comment_id)),
            snapshot: None,
            affected: AffectedIds {
                comment_ids: vec![comment_id],
                task_ids: vec![before.task_id],
                ..AffectedIds::default()
            },
            resync: ResyncScope::NONE,
            task_activity: activity,
            summary_subject: Some(("comment".into(), comment_id.to_string())),
            undo: Some(undo),
            mark_undone: None,
        })
    })
}

pub(crate) fn list_comments(
    connection: &Connection,
    task_id: TaskId,
) -> Result<Vec<Comment>, RepositoryError> {
    let tx = connection.unchecked_transaction().map_err(storage_error)?;
    if !task_exists(&tx, task_id)? {
        return Err(RepositoryError::NotFound);
    }
    load_comments_for_tasks(&tx, &[task_id])
}

pub(crate) fn add_relation(
    c: &mut Connection,
    op: OperationId,
    from_task_id: TaskId,
    to_task_id: TaskId,
    kind: RelationKind,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let kind_str = match kind {
        RelationKind::Blocks => "blocks",
    };
    let request = canonical_json(&Req::AddRelation {
        from_task_id: from_task_id.to_string(),
        to_task_id: to_task_id.to_string(),
        kind: kind_str,
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let relation = TaskRelation::blocks(from_task_id, to_task_id).map_err(validation)?;
        if !task_exists(tx, from_task_id)? || !task_exists(tx, to_task_id)? {
            return Err(RepositoryError::NotFound);
        }
        let edges = load_blocks_edges(tx)?;
        if edges
            .iter()
            .any(|(from, to)| *from == from_task_id && *to == to_task_id)
        {
            return Err(RepositoryError::Conflict);
        }
        if blocks_edge_creates_cycle(&edges, from_task_id, to_task_id) {
            return Err(RepositoryError::Conflict);
        }
        tx.execute(
            "INSERT INTO task_relations(from_task_id, to_task_id, kind) VALUES (?1,?2,?3)",
            params![from_task_id.to_string(), to_task_id.to_string(), kind_str],
        )
        .map_err(constraint_conflict)?;
        let activity = vec![field_activity(
            revision,
            0,
            op,
            from_task_id,
            TaskActivityAction::Updated,
            Some("blocks"),
            None,
            Some(to_task_id.to_string()),
            now,
        )];
        let mut post = PostImage::default();
        post.relations_present.push(relation.clone());
        let undo = undo_pair(
            &Inverse::RestoreRelation {
                relation: relation.clone(),
                present: false,
            },
            &post,
        )?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::RELATION_ADDED),
            primary: Some(ResourceRef::task(from_task_id)),
            snapshot: None,
            affected: AffectedIds {
                task_ids: vec![from_task_id, to_task_id],
                ..AffectedIds::default()
            },
            resync: ResyncScope::TASKS,
            task_activity: activity,
            summary_subject: Some(("task".into(), from_task_id.to_string())),
            undo: Some(undo),
            mark_undone: None,
        })
    })
}

pub(crate) fn remove_relation(
    c: &mut Connection,
    op: OperationId,
    from_task_id: TaskId,
    to_task_id: TaskId,
    kind: RelationKind,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let kind_str = match kind {
        RelationKind::Blocks => "blocks",
    };
    let request = canonical_json(&Req::RemoveRelation {
        from_task_id: from_task_id.to_string(),
        to_task_id: to_task_id.to_string(),
        kind: kind_str,
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let relation = TaskRelation {
            from_task_id,
            to_task_id,
            kind,
        };
        let changed = tx
            .execute(
                "DELETE FROM task_relations WHERE from_task_id=?1 AND to_task_id=?2 AND kind=?3",
                params![from_task_id.to_string(), to_task_id.to_string(), kind_str],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(RepositoryError::NotFound);
        }
        let activity = vec![field_activity(
            revision,
            0,
            op,
            from_task_id,
            TaskActivityAction::Updated,
            Some("blocks"),
            Some(to_task_id.to_string()),
            None,
            now,
        )];
        let mut post = PostImage::default();
        post.relations_absent.push(relation.clone());
        let undo = undo_pair(
            &Inverse::RestoreRelation {
                relation,
                present: true,
            },
            &post,
        )?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::RELATION_REMOVED),
            primary: Some(ResourceRef::task(from_task_id)),
            snapshot: None,
            affected: AffectedIds {
                task_ids: vec![from_task_id, to_task_id],
                ..AffectedIds::default()
            },
            resync: ResyncScope::TASKS,
            task_activity: activity,
            summary_subject: Some(("task".into(), from_task_id.to_string())),
            undo: Some(undo),
            mark_undone: None,
        })
    })
}

pub(crate) fn list_relations(
    connection: &Connection,
    task_id: TaskId,
) -> Result<Vec<TaskRelation>, RepositoryError> {
    let tx = connection.unchecked_transaction().map_err(storage_error)?;
    if !task_exists(&tx, task_id)? {
        return Err(RepositoryError::NotFound);
    }
    load_relations_touching(&tx, &[task_id])
}

pub(crate) fn list_task_activity(
    connection: &Connection,
    task_id: TaskId,
    after_revision: Option<u64>,
    after_sequence: Option<u32>,
    limit: u32,
) -> Result<Vec<TaskActivity>, RepositoryError> {
    let mut sql = String::from(
        "SELECT revision, sequence, operation_id, task_id, action, field, old_value, new_value, created_at
         FROM task_activity WHERE task_id = ?1",
    );
    let mut binds: Vec<rusqlite::types::Value> =
        vec![rusqlite::types::Value::Text(task_id.to_string())];
    if let Some(revision) = after_revision {
        let sequence = after_sequence.unwrap_or(0);
        sql.push_str(" AND (revision > ? OR (revision = ? AND sequence > ?))");
        binds.push(rusqlite::types::Value::Integer(revision_to_i64(revision)?));
        binds.push(rusqlite::types::Value::Integer(revision_to_i64(revision)?));
        binds.push(rusqlite::types::Value::Integer(i64::from(sequence)));
    }
    sql.push_str(" ORDER BY revision ASC, sequence ASC LIMIT ?");
    binds.push(rusqlite::types::Value::Integer(i64::from(limit)));
    let mut statement = connection.prepare(&sql).map_err(storage_error)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(binds.iter()), |row| {
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
                revision: u64::try_from(revision)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?,
                sequence: u32::try_from(sequence)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?,
                operation_id: parse_sql(operation_id, OperationId::parse)?,
                task_id: parse_sql(task_id, TaskId::parse)?,
                action: crate::rows::parse_activity_action(&action).map_err(|e| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        e.to_string(),
                    )))
                })?,
                field,
                old_value,
                new_value,
                created_at: parse_sql(created_at, |raw| raw.parse::<Timestamp>())?,
            })
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

pub(crate) fn list_events(
    connection: &Connection,
    since: u64,
) -> Result<EventCatchUp, RepositoryError> {
    let latest_revision = global_revision(connection)?;
    if since >= latest_revision {
        return Ok(EventCatchUp::Page {
            events: Vec::new(),
            has_more: false,
            latest_revision,
        });
    }

    let oldest: Option<i64> = connection
        .query_row("SELECT MIN(revision) FROM events", [], |row| row.get(0))
        .map_err(storage_error)?;
    match oldest {
        None => {
            // Revisions advanced but no retained events remain.
            return Ok(EventCatchUp::ResyncRequired { latest_revision });
        }
        Some(oldest) => {
            let oldest = u64::try_from(oldest)
                .map_err(|error| RepositoryError::Storage(error.to_string()))?;
            if oldest > since.saturating_add(1) {
                return Ok(EventCatchUp::ResyncRequired { latest_revision });
            }
        }
    }

    let mut statement = connection
        .prepare("SELECT event_json FROM events WHERE revision > ?1 ORDER BY revision LIMIT ?2")
        .map_err(storage_error)?;
    // Fetch one extra row to detect has_more without an unbounded scan.
    let limit = i64::try_from(EVENT_CATCHUP_MAX_COUNT + 1)
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let rows = statement
        .query_map(params![revision_to_i64(since)?, limit], |row| {
            row.get::<_, String>(0)
        })
        .map_err(storage_error)?;

    let mut events = Vec::new();
    let mut total_bytes = 0usize;
    let mut saw_extra = false;
    for row in rows {
        let json = row.map_err(storage_error)?;
        if events.len() == EVENT_CATCHUP_MAX_COUNT {
            saw_extra = true;
            break;
        }
        let next_bytes = total_bytes.saturating_add(json.len());
        if !events.is_empty() && next_bytes > EVENT_CATCHUP_MAX_BYTES {
            saw_extra = true;
            break;
        }
        if json.len() > EVENT_CATCHUP_MAX_BYTES && events.is_empty() {
            // A single oversized event still cannot blow the page contract.
            return Err(RepositoryError::Storage(
                "retained event exceeds catch-up byte budget".to_owned(),
            ));
        }
        total_bytes = next_bytes;
        events.push(serde_json::from_str::<CommittedEvent>(&json).map_err(storage_error)?);
    }

    Ok(EventCatchUp::Page {
        events,
        has_more: saw_extra,
        latest_revision,
    })
}
