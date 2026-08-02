//! Bounded AI session, message, memory, approval, and run-state persistence.
//!
//! Mutations use the existing one-transaction/one-event/one-receipt path and are
//! deliberately non-undoable (`undo: None`).

#![allow(dead_code)]
#![allow(clippy::too_many_arguments)]

use jiff::{Timestamp, ToSpan};
use junban_app::{
    AffectedIds, CommittedMutation, EventType, RepositoryError, ResourceRef, ResyncScope,
};
use junban_domain::{
    AI_APPROVAL_LIFETIME_SECS, AI_MEMORIES_PER_PROFILE_MAX, AI_MEMORY_CONTENT_BYTES_MAX,
    AI_MESSAGES_PER_SESSION_MAX, AI_PENDING_APPROVAL_CONTENT_BYTES_MAX, AI_PENDING_APPROVALS_MAX,
    AI_PROFILE_CONTENT_BYTES_MAX, AI_SESSION_CONTENT_BYTES_MAX, AI_SESSIONS_PER_PROFILE_MAX,
    AiApprovalId, AiApprovalStatus, AiMemory, AiMemoryId, AiMessage, AiMessageContent, AiMessageId,
    AiMessageRole, AiMessageStatus, AiRunId, AiRunPhase, AiRunState, AiSession, AiSessionId,
    AiSessionStatus, AiToolApproval, AiTurnId, OperationId, sha256_hex,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::helpers::validation;
use crate::rows::storage_error;
use crate::tx::{MutationEffect, canonical_json, mutate};

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Req<'a> {
    CreateAiSession {
        session_id: String,
        title: &'a str,
    },
    RenameAiSession {
        session_id: String,
        title: &'a str,
    },
    DeleteAiSession {
        session_id: String,
    },
    ClearAiSession {
        session_id: String,
    },
    UpsertAiMessage {
        message_id: String,
        session_id: String,
        turn_id: String,
        role: &'a str,
        status: &'a str,
        content_json: &'a str,
    },
    CreateAiMemory {
        memory_id: String,
        content: &'a str,
    },
    UpdateAiMemory {
        memory_id: String,
        content: &'a str,
    },
    DeleteAiMemory {
        memory_id: String,
    },
    LinkAiSessionMemory {
        session_id: String,
        memory_id: String,
    },
    ProposeAiApproval {
        approval_id: String,
        session_id: String,
        turn_id: String,
        run_id: String,
        generation: u64,
        tool_name: &'a str,
        arguments_json: &'a str,
    },
    SetAiApprovalStatus {
        approval_id: String,
        status: &'a str,
        operation_id: Option<&'a str>,
    },
    UpsertAiRunState {
        run_id: String,
        session_id: String,
        turn_id: String,
        generation: u64,
        state: &'a str,
        approval_id: Option<&'a str>,
    },
}

fn ai_effect(
    event_type: &'static str,
    primary: ResourceRef,
    subject: (&str, String),
) -> MutationEffect {
    MutationEffect {
        event_type: EventType::new(event_type),
        primary: Some(primary),
        snapshot: None,
        affected: AffectedIds::default(),
        resync: ResyncScope::NONE,
        task_activity: Vec::new(),
        summary_subject: Some((subject.0.into(), subject.1)),
        undo: None,
        mark_undone: None,
        uncomplete_outcome: None,
    }
}

fn ensure_quota_row(tx: &rusqlite::Transaction<'_>) -> Result<(), RepositoryError> {
    tx.execute(
        "INSERT OR IGNORE INTO ai_quota(
            singleton, session_count, total_content_bytes, memory_count, memory_content_bytes,
            pending_approval_count, pending_approval_content_bytes
         ) VALUES (1, 0, 0, 0, 0, 0, 0)",
        [],
    )
    .map_err(storage_error)?;
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct AiQuota {
    session_count: u32,
    total_content_bytes: u64,
    memory_count: u32,
    memory_content_bytes: u64,
    pending_approval_count: u32,
    pending_approval_content_bytes: u64,
}

fn load_quota(tx: &rusqlite::Transaction<'_>) -> Result<AiQuota, RepositoryError> {
    ensure_quota_row(tx)?;
    tx.query_row(
        "SELECT session_count, total_content_bytes, memory_count, memory_content_bytes,
                pending_approval_count, pending_approval_content_bytes
         FROM ai_quota WHERE singleton = 1",
        [],
        |row| {
            Ok(AiQuota {
                session_count: row.get::<_, i64>(0)? as u32,
                total_content_bytes: row.get::<_, i64>(1)? as u64,
                memory_count: row.get::<_, i64>(2)? as u32,
                memory_content_bytes: row.get::<_, i64>(3)? as u64,
                pending_approval_count: row.get::<_, i64>(4)? as u32,
                pending_approval_content_bytes: row.get::<_, i64>(5)? as u64,
            })
        },
    )
    .map_err(storage_error)
}

fn save_quota(tx: &rusqlite::Transaction<'_>, quota: &AiQuota) -> Result<(), RepositoryError> {
    tx.execute(
        "UPDATE ai_quota SET
            session_count = ?1,
            total_content_bytes = ?2,
            memory_count = ?3,
            memory_content_bytes = ?4,
            pending_approval_count = ?5,
            pending_approval_content_bytes = ?6
         WHERE singleton = 1",
        params![
            i64::from(quota.session_count),
            quota.total_content_bytes as i64,
            i64::from(quota.memory_count),
            quota.memory_content_bytes as i64,
            i64::from(quota.pending_approval_count),
            quota.pending_approval_content_bytes as i64,
        ],
    )
    .map_err(storage_error)?;
    Ok(())
}

fn quota_err(field: &'static str) -> RepositoryError {
    RepositoryError::Validation(junban_domain::ValidationError::Invalid {
        field,
        reason: "aggregate AI quota exceeded",
    })
}

pub(crate) fn create_ai_session(
    connection: &mut Connection,
    operation_id: OperationId,
    session_id: AiSessionId,
    title: String,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let session = AiSession::new(session_id, title, now).map_err(validation)?;
    let request = canonical_json(&Req::CreateAiSession {
        session_id: session.id.to_string(),
        title: &session.title,
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let mut quota = load_quota(tx)?;
        if quota.session_count >= AI_SESSIONS_PER_PROFILE_MAX {
            return Err(quota_err("ai_sessions"));
        }
        let inserted = tx
            .execute(
                "INSERT INTO ai_sessions(
                    id, title, status, message_count, content_bytes,
                    created_at, updated_at, last_message_at
                 ) VALUES (?1, ?2, ?3, 0, 0, ?4, ?5, NULL)",
                params![
                    session.id.to_string(),
                    session.title,
                    session.status.as_str(),
                    session.created_at.to_string(),
                    session.updated_at.to_string(),
                ],
            )
            .map_err(storage_error)?;
        if inserted != 1 {
            return Err(RepositoryError::Conflict);
        }
        quota.session_count += 1;
        save_quota(tx, &quota)?;
        Ok(ai_effect(
            EventType::AI_SESSION_CHANGED,
            ResourceRef::ai_session(session.id),
            ("ai_session", session.id.to_string()),
        ))
    })
}

pub(crate) fn rename_ai_session(
    connection: &mut Connection,
    operation_id: OperationId,
    session_id: AiSessionId,
    title: String,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let mut probe = AiSession::new(session_id, "x", now).map_err(validation)?;
    probe.rename(title, now).map_err(validation)?;
    let request = canonical_json(&Req::RenameAiSession {
        session_id: session_id.to_string(),
        title: &probe.title,
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let updated = tx
            .execute(
                "UPDATE ai_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
                params![probe.title, now.to_string(), session_id.to_string()],
            )
            .map_err(storage_error)?;
        if updated == 0 {
            return Err(RepositoryError::NotFound);
        }
        Ok(ai_effect(
            EventType::AI_SESSION_CHANGED,
            ResourceRef::ai_session(session_id),
            ("ai_session", session_id.to_string()),
        ))
    })
}

pub(crate) fn delete_ai_session(
    connection: &mut Connection,
    operation_id: OperationId,
    session_id: AiSessionId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::DeleteAiSession {
        session_id: session_id.to_string(),
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let row = tx
            .query_row(
                "SELECT content_bytes FROM ai_sessions WHERE id = ?1",
                [session_id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage_error)?;
        let Some(content_bytes) = row else {
            return Err(RepositoryError::NotFound);
        };
        // Expire pending approvals for this session before cascade delete.
        expire_pending_approvals_for_session(tx, session_id, now)?;
        tx.execute(
            "DELETE FROM ai_run_state WHERE session_id = ?1",
            [session_id.to_string()],
        )
        .map_err(storage_error)?;
        let deleted = tx
            .execute(
                "DELETE FROM ai_sessions WHERE id = ?1",
                [session_id.to_string()],
            )
            .map_err(storage_error)?;
        if deleted != 1 {
            return Err(RepositoryError::NotFound);
        }
        let mut quota = load_quota(tx)?;
        quota.session_count = quota.session_count.saturating_sub(1);
        quota.total_content_bytes = quota
            .total_content_bytes
            .saturating_sub(content_bytes as u64);
        // Recompute pending approval counters after cascade.
        recompute_pending_approval_quota(tx, &mut quota)?;
        save_quota(tx, &quota)?;
        Ok(ai_effect(
            EventType::AI_SESSION_DELETED,
            ResourceRef::ai_session(session_id),
            ("ai_session", session_id.to_string()),
        ))
    })
}

pub(crate) fn clear_ai_session(
    connection: &mut Connection,
    operation_id: OperationId,
    session_id: AiSessionId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::ClearAiSession {
        session_id: session_id.to_string(),
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let content_bytes: i64 = tx
            .query_row(
                "SELECT content_bytes FROM ai_sessions WHERE id = ?1",
                [session_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::NotFound)?;
        expire_pending_approvals_for_session(tx, session_id, now)?;
        tx.execute(
            "DELETE FROM ai_run_state WHERE session_id = ?1",
            [session_id.to_string()],
        )
        .map_err(storage_error)?;
        tx.execute(
            "DELETE FROM ai_messages WHERE session_id = ?1",
            [session_id.to_string()],
        )
        .map_err(storage_error)?;
        tx.execute(
            "UPDATE ai_sessions SET message_count = 0, content_bytes = 0,
                updated_at = ?1, last_message_at = NULL
             WHERE id = ?2",
            params![now.to_string(), session_id.to_string()],
        )
        .map_err(storage_error)?;
        let mut quota = load_quota(tx)?;
        quota.total_content_bytes = quota
            .total_content_bytes
            .saturating_sub(content_bytes as u64);
        recompute_pending_approval_quota(tx, &mut quota)?;
        save_quota(tx, &quota)?;
        Ok(ai_effect(
            EventType::AI_SESSION_CHANGED,
            ResourceRef::ai_session(session_id),
            ("ai_session", session_id.to_string()),
        ))
    })
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn get_ai_session(
    connection: &Connection,
    session_id: AiSessionId,
) -> Result<AiSession, RepositoryError> {
    connection
        .query_row(
            "SELECT id, title, status, message_count, content_bytes,
                    created_at, updated_at, last_message_at
             FROM ai_sessions WHERE id = ?1",
            [session_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .map(
            |(id, title, status, message_count, content_bytes, created_at, updated_at, last)| {
                Ok(AiSession {
                    id: AiSessionId::parse(&id).map_err(storage_error)?,
                    title,
                    status: AiSessionStatus::parse(&status).map_err(storage_error)?,
                    message_count: u32::try_from(message_count).map_err(storage_error)?,
                    content_bytes: u64::try_from(content_bytes).map_err(storage_error)?,
                    created_at: created_at.parse().map_err(storage_error)?,
                    updated_at: updated_at.parse().map_err(storage_error)?,
                    last_message_at: last
                        .map(|value| value.parse().map_err(storage_error))
                        .transpose()?,
                })
            },
        )
        .transpose()?
        .ok_or(RepositoryError::NotFound)
}

/// Append or complete a durable message. Sequence is assigned monotonically.
pub(crate) fn upsert_ai_message(
    connection: &mut Connection,
    operation_id: OperationId,
    message_id: AiMessageId,
    session_id: AiSessionId,
    turn_id: AiTurnId,
    role: AiMessageRole,
    status: AiMessageStatus,
    content: AiMessageContent,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let content_json = content.canonical_json().map_err(validation)?;
    let content_bytes = AiMessageContent::byte_len(&content_json);
    if role == AiMessageRole::User && content.text.len() > junban_domain::AI_USER_INPUT_BYTES_MAX {
        return Err(validation(junban_domain::ValidationError::TooLong {
            field: "ai_message.content.text",
            max: junban_domain::AI_USER_INPUT_BYTES_MAX,
        }));
    }
    let request = canonical_json(&Req::UpsertAiMessage {
        message_id: message_id.to_string(),
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        role: role.as_str(),
        status: status.as_str(),
        content_json: &content_json,
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let existing = tx
            .query_row(
                "SELECT content_bytes, sequence FROM ai_messages WHERE id = ?1",
                [message_id.to_string()],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(storage_error)?;

        let (session_messages, session_bytes): (i64, i64) = tx
            .query_row(
                "SELECT message_count, content_bytes FROM ai_sessions WHERE id = ?1",
                [session_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::NotFound)?;

        let mut quota = load_quota(tx)?;
        let (sequence, delta_bytes, new_message) = if let Some((old_bytes, sequence)) = existing {
            let delta = content_bytes as i64 - old_bytes;
            (sequence as u32, delta, false)
        } else {
            if session_messages as u32 >= AI_MESSAGES_PER_SESSION_MAX {
                return Err(quota_err("ai_messages"));
            }
            let next_sequence = u32::try_from(session_messages + 1).map_err(storage_error)?;
            (next_sequence, content_bytes as i64, true)
        };

        let next_session_bytes = (session_bytes + delta_bytes) as u64;
        if next_session_bytes > AI_SESSION_CONTENT_BYTES_MAX {
            return Err(quota_err("ai_session.content_bytes"));
        }
        let next_profile_bytes = if delta_bytes >= 0 {
            quota
                .total_content_bytes
                .checked_add(delta_bytes as u64)
                .ok_or_else(|| quota_err("ai_profile.content_bytes"))?
        } else {
            quota
                .total_content_bytes
                .saturating_sub((-delta_bytes) as u64)
        };
        if next_profile_bytes > AI_PROFILE_CONTENT_BYTES_MAX {
            return Err(quota_err("ai_profile.content_bytes"));
        }

        if new_message {
            tx.execute(
                "INSERT INTO ai_messages(
                    id, session_id, turn_id, sequence, role, status,
                    content_json, content_bytes, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    message_id.to_string(),
                    session_id.to_string(),
                    turn_id.to_string(),
                    i64::from(sequence),
                    role.as_str(),
                    status.as_str(),
                    content_json,
                    content_bytes as i64,
                    now.to_string(),
                    now.to_string(),
                ],
            )
            .map_err(storage_error)?;
        } else {
            tx.execute(
                "UPDATE ai_messages SET turn_id = ?1, role = ?2, status = ?3,
                    content_json = ?4, content_bytes = ?5, updated_at = ?6
                 WHERE id = ?7 AND session_id = ?8",
                params![
                    turn_id.to_string(),
                    role.as_str(),
                    status.as_str(),
                    content_json,
                    content_bytes as i64,
                    now.to_string(),
                    message_id.to_string(),
                    session_id.to_string(),
                ],
            )
            .map_err(storage_error)?;
        }

        tx.execute(
            "UPDATE ai_sessions SET
                message_count = ?1,
                content_bytes = ?2,
                updated_at = ?3,
                last_message_at = ?4
             WHERE id = ?5",
            params![
                if new_message {
                    session_messages + 1
                } else {
                    session_messages
                },
                next_session_bytes as i64,
                now.to_string(),
                now.to_string(),
                session_id.to_string(),
            ],
        )
        .map_err(storage_error)?;

        quota.total_content_bytes = next_profile_bytes;
        save_quota(tx, &quota)?;

        Ok(ai_effect(
            EventType::AI_SESSION_CHANGED,
            ResourceRef::ai_session(session_id),
            ("ai_message", message_id.to_string()),
        ))
    })
}

#[allow(dead_code)]
pub(crate) fn list_ai_messages(
    connection: &Connection,
    session_id: AiSessionId,
    after_sequence: Option<u32>,
    limit: u32,
) -> Result<Vec<AiMessage>, RepositoryError> {
    let limit = limit.clamp(1, junban_domain::AI_MESSAGE_PAGE_MAX);
    let after = i64::from(after_sequence.unwrap_or(0));
    let mut statement = connection
        .prepare(
            "SELECT id, session_id, turn_id, sequence, role, status,
                    content_json, content_bytes, created_at, updated_at
             FROM ai_messages
             WHERE session_id = ?1 AND sequence > ?2
             ORDER BY sequence ASC
             LIMIT ?3",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map(
            params![session_id.to_string(), after, i64::from(limit)],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            },
        )
        .map_err(storage_error)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, sid, turn, sequence, role, status, content_json, bytes, created, updated) =
            row.map_err(storage_error)?;
        let content: AiMessageContent =
            serde_json::from_str(&content_json).map_err(storage_error)?;
        content.validate().map_err(validation)?;
        out.push(AiMessage {
            id: AiMessageId::parse(&id).map_err(storage_error)?,
            session_id: AiSessionId::parse(&sid).map_err(storage_error)?,
            turn_id: AiTurnId::parse(&turn).map_err(storage_error)?,
            sequence: u32::try_from(sequence).map_err(storage_error)?,
            role: AiMessageRole::parse(&role).map_err(storage_error)?,
            status: AiMessageStatus::parse(&status).map_err(storage_error)?,
            content,
            content_bytes: u64::try_from(bytes).map_err(storage_error)?,
            created_at: created.parse().map_err(storage_error)?,
            updated_at: updated.parse().map_err(storage_error)?,
        });
    }
    Ok(out)
}

pub(crate) fn create_ai_memory(
    connection: &mut Connection,
    operation_id: OperationId,
    memory_id: AiMemoryId,
    content: String,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let memory = AiMemory::new(memory_id, content, now).map_err(validation)?;
    let request = canonical_json(&Req::CreateAiMemory {
        memory_id: memory.id.to_string(),
        content: &memory.content,
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let mut quota = load_quota(tx)?;
        if quota.memory_count >= AI_MEMORIES_PER_PROFILE_MAX {
            return Err(quota_err("ai_memories"));
        }
        let next_bytes = quota
            .memory_content_bytes
            .checked_add(memory.content_bytes)
            .ok_or_else(|| quota_err("ai_memories.content"))?;
        if next_bytes > AI_MEMORY_CONTENT_BYTES_MAX {
            return Err(quota_err("ai_memories.content"));
        }
        tx.execute(
            "INSERT INTO ai_memories(id, content, content_bytes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                memory.id.to_string(),
                memory.content,
                memory.content_bytes as i64,
                memory.created_at.to_string(),
                memory.updated_at.to_string(),
            ],
        )
        .map_err(storage_error)?;
        quota.memory_count += 1;
        quota.memory_content_bytes = next_bytes;
        save_quota(tx, &quota)?;
        Ok(ai_effect(
            EventType::AI_MEMORY_CHANGED,
            ResourceRef::ai_memory(memory.id),
            ("ai_memory", memory.id.to_string()),
        ))
    })
}

#[allow(dead_code)]
pub(crate) fn update_ai_memory(
    connection: &mut Connection,
    operation_id: OperationId,
    memory_id: AiMemoryId,
    content: String,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let mut probe = AiMemory::new(memory_id, "x", now).map_err(validation)?;
    probe.update_content(content, now).map_err(validation)?;
    let request = canonical_json(&Req::UpdateAiMemory {
        memory_id: memory_id.to_string(),
        content: &probe.content,
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let old_bytes: i64 = tx
            .query_row(
                "SELECT content_bytes FROM ai_memories WHERE id = ?1",
                [memory_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::NotFound)?;
        let mut quota = load_quota(tx)?;
        let next_bytes =
            (quota.memory_content_bytes as i64 - old_bytes + probe.content_bytes as i64) as u64;
        if next_bytes > AI_MEMORY_CONTENT_BYTES_MAX {
            return Err(quota_err("ai_memories.content"));
        }
        tx.execute(
            "UPDATE ai_memories SET content = ?1, content_bytes = ?2, updated_at = ?3
             WHERE id = ?4",
            params![
                probe.content,
                probe.content_bytes as i64,
                now.to_string(),
                memory_id.to_string()
            ],
        )
        .map_err(storage_error)?;
        quota.memory_content_bytes = next_bytes;
        save_quota(tx, &quota)?;
        Ok(ai_effect(
            EventType::AI_MEMORY_CHANGED,
            ResourceRef::ai_memory(memory_id),
            ("ai_memory", memory_id.to_string()),
        ))
    })
}

#[allow(dead_code)]
pub(crate) fn delete_ai_memory(
    connection: &mut Connection,
    operation_id: OperationId,
    memory_id: AiMemoryId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::DeleteAiMemory {
        memory_id: memory_id.to_string(),
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let old_bytes: i64 = tx
            .query_row(
                "SELECT content_bytes FROM ai_memories WHERE id = ?1",
                [memory_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::NotFound)?;
        tx.execute(
            "DELETE FROM ai_memories WHERE id = ?1",
            [memory_id.to_string()],
        )
        .map_err(storage_error)?;
        let mut quota = load_quota(tx)?;
        quota.memory_count = quota.memory_count.saturating_sub(1);
        quota.memory_content_bytes = quota.memory_content_bytes.saturating_sub(old_bytes as u64);
        save_quota(tx, &quota)?;
        Ok(ai_effect(
            EventType::AI_MEMORY_DELETED,
            ResourceRef::ai_memory(memory_id),
            ("ai_memory", memory_id.to_string()),
        ))
    })
}

#[allow(dead_code)]
pub(crate) fn link_ai_session_memory(
    connection: &mut Connection,
    operation_id: OperationId,
    session_id: AiSessionId,
    memory_id: AiMemoryId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::LinkAiSessionMemory {
        session_id: session_id.to_string(),
        memory_id: memory_id.to_string(),
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let session_exists: bool = tx
            .query_row(
                "SELECT COUNT(*) > 0 FROM ai_sessions WHERE id = ?1",
                [session_id.to_string()],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let memory_exists: bool = tx
            .query_row(
                "SELECT COUNT(*) > 0 FROM ai_memories WHERE id = ?1",
                [memory_id.to_string()],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if !session_exists || !memory_exists {
            return Err(RepositoryError::NotFound);
        }
        tx.execute(
            "INSERT OR IGNORE INTO ai_session_memories(session_id, memory_id) VALUES (?1, ?2)",
            params![session_id.to_string(), memory_id.to_string()],
        )
        .map_err(storage_error)?;
        Ok(ai_effect(
            EventType::AI_MEMORY_CHANGED,
            ResourceRef::ai_memory(memory_id),
            ("ai_session_memory", format!("{session_id}:{memory_id}")),
        ))
    })
}

pub(crate) fn propose_ai_approval(
    connection: &mut Connection,
    operation_id: OperationId,
    approval_id: AiApprovalId,
    session_id: AiSessionId,
    turn_id: AiTurnId,
    run_id: AiRunId,
    generation: u64,
    tool_name: String,
    arguments_json: String,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    if tool_name.is_empty() || tool_name.len() > junban_domain::AI_PROVIDER_ID_BYTES_MAX {
        return Err(validation(junban_domain::ValidationError::Invalid {
            field: "ai_approval.tool_name",
            reason: "tool name is empty or too long",
        }));
    }
    if arguments_json.len() > junban_domain::AI_TOOL_ARGUMENTS_BYTES_MAX {
        return Err(validation(junban_domain::ValidationError::TooLong {
            field: "ai_approval.arguments_json",
            max: junban_domain::AI_TOOL_ARGUMENTS_BYTES_MAX,
        }));
    }
    let arguments_bytes = arguments_json.len() as u64;
    let action_hash = sha256_hex(
        format!("{tool_name}\n{arguments_json}\n{session_id}\n{turn_id}\n{generation}").as_bytes(),
    );
    let expires_at = now + AI_APPROVAL_LIFETIME_SECS.seconds();
    let request = canonical_json(&Req::ProposeAiApproval {
        approval_id: approval_id.to_string(),
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        run_id: run_id.to_string(),
        generation,
        tool_name: &tool_name,
        arguments_json: &arguments_json,
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let session_exists: bool = tx
            .query_row(
                "SELECT COUNT(*) > 0 FROM ai_sessions WHERE id = ?1",
                [session_id.to_string()],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if !session_exists {
            return Err(RepositoryError::NotFound);
        }
        let mut quota = load_quota(tx)?;
        if quota.pending_approval_count >= AI_PENDING_APPROVALS_MAX {
            return Err(quota_err("ai_tool_approvals"));
        }
        let next_bytes = quota
            .pending_approval_content_bytes
            .checked_add(arguments_bytes)
            .ok_or_else(|| quota_err("ai_tool_approvals.content"))?;
        if next_bytes > AI_PENDING_APPROVAL_CONTENT_BYTES_MAX {
            return Err(quota_err("ai_tool_approvals.content"));
        }
        tx.execute(
            "INSERT INTO ai_tool_approvals(
                id, session_id, turn_id, run_id, generation, tool_name, arguments_json,
                arguments_bytes, action_hash, status, expires_at, operation_id,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, NULL, ?11, ?12)",
            params![
                approval_id.to_string(),
                session_id.to_string(),
                turn_id.to_string(),
                run_id.to_string(),
                generation as i64,
                tool_name,
                arguments_json,
                arguments_bytes as i64,
                action_hash,
                expires_at.to_string(),
                now.to_string(),
                now.to_string(),
            ],
        )
        .map_err(storage_error)?;
        quota.pending_approval_count += 1;
        quota.pending_approval_content_bytes = next_bytes;
        save_quota(tx, &quota)?;
        Ok(ai_effect(
            EventType::AI_APPROVAL_CHANGED,
            ResourceRef::ai_approval(approval_id),
            ("ai_approval", approval_id.to_string()),
        ))
    })
}

#[allow(dead_code)]
pub(crate) fn set_ai_approval_status(
    connection: &mut Connection,
    operation_id: OperationId,
    approval_id: AiApprovalId,
    status: AiApprovalStatus,
    dispatch_operation_id: Option<String>,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::SetAiApprovalStatus {
        approval_id: approval_id.to_string(),
        status: status.as_str(),
        operation_id: dispatch_operation_id.as_deref(),
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let row = tx
            .query_row(
                "SELECT status, arguments_bytes FROM ai_tool_approvals WHERE id = ?1",
                [approval_id.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::NotFound)?;
        let previous = AiApprovalStatus::parse(&row.0).map_err(storage_error)?;
        if previous == status {
            // Idempotent exact status replay still emits no second mutation if receipt matches.
        }
        tx.execute(
            "UPDATE ai_tool_approvals SET status = ?1, operation_id = COALESCE(?2, operation_id),
                updated_at = ?3
             WHERE id = ?4",
            params![
                status.as_str(),
                dispatch_operation_id,
                now.to_string(),
                approval_id.to_string()
            ],
        )
        .map_err(storage_error)?;
        if previous.is_pending() && !status.is_pending() {
            let mut quota = load_quota(tx)?;
            quota.pending_approval_count = quota.pending_approval_count.saturating_sub(1);
            quota.pending_approval_content_bytes = quota
                .pending_approval_content_bytes
                .saturating_sub(row.1 as u64);
            save_quota(tx, &quota)?;
        }
        Ok(ai_effect(
            EventType::AI_APPROVAL_CHANGED,
            ResourceRef::ai_approval(approval_id),
            ("ai_approval", approval_id.to_string()),
        ))
    })
}

pub(crate) fn upsert_ai_run_state(
    connection: &mut Connection,
    operation_id: OperationId,
    state: AiRunState,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::UpsertAiRunState {
        run_id: state.run_id.to_string(),
        session_id: state.session_id.to_string(),
        turn_id: state.turn_id.to_string(),
        generation: state.generation,
        state: state.state.as_str(),
        approval_id: state.approval_id.map(|id| id.to_string()).as_deref(),
    })?;
    let approval_id = state.approval_id.map(|id| id.to_string());
    mutate(connection, operation_id, request, now, move |tx, _| {
        tx.execute(
            "INSERT INTO ai_run_state(
                run_id, session_id, turn_id, generation, state, approval_id, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(run_id) DO UPDATE SET
                generation = excluded.generation,
                state = excluded.state,
                approval_id = excluded.approval_id,
                updated_at = excluded.updated_at",
            params![
                state.run_id.to_string(),
                state.session_id.to_string(),
                state.turn_id.to_string(),
                state.generation as i64,
                state.state.as_str(),
                approval_id,
                state.created_at.to_string(),
                now.to_string(),
            ],
        )
        .map_err(storage_error)?;
        Ok(ai_effect(
            EventType::AI_SESSION_CHANGED,
            ResourceRef::ai_session(state.session_id),
            ("ai_run", state.run_id.to_string()),
        ))
    })
}

#[allow(dead_code)]
pub(crate) fn get_ai_run_state(
    connection: &Connection,
    run_id: AiRunId,
) -> Result<AiRunState, RepositoryError> {
    connection
        .query_row(
            "SELECT run_id, session_id, turn_id, generation, state, approval_id, created_at, updated_at
             FROM ai_run_state WHERE run_id = ?1",
            [run_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .map(
            |(run, session, turn, generation, phase, approval, created, updated)| {
                Ok(AiRunState {
                    run_id: AiRunId::parse(&run).map_err(storage_error)?,
                    session_id: AiSessionId::parse(&session).map_err(storage_error)?,
                    turn_id: AiTurnId::parse(&turn).map_err(storage_error)?,
                    generation: u64::try_from(generation).map_err(storage_error)?,
                    state: AiRunPhase::parse(&phase).map_err(storage_error)?,
                    approval_id: approval
                        .map(|value| AiApprovalId::parse(&value).map_err(storage_error))
                        .transpose()?,
                    created_at: created.parse().map_err(storage_error)?,
                    updated_at: updated.parse().map_err(storage_error)?,
                })
            },
        )
        .transpose()?
        .ok_or(RepositoryError::NotFound)
}

/// Expire all pending approvals and mark non-terminal runs cancelled (restore/startup).
pub(crate) fn expire_ai_runtime_state(
    connection: &Connection,
    now: Timestamp,
) -> Result<(), RepositoryError> {
    let tx = connection.unchecked_transaction().map_err(storage_error)?;
    tx.execute(
        "UPDATE ai_tool_approvals SET status = 'expired', updated_at = ?1
         WHERE status = 'pending'",
        [now.to_string()],
    )
    .map_err(storage_error)?;
    tx.execute(
        "UPDATE ai_run_state SET state = 'cancelled', updated_at = ?1
         WHERE state IN ('running', 'awaiting_approval', 'dispatching')",
        [now.to_string()],
    )
    .map_err(storage_error)?;
    let mut quota = load_quota(&tx)?;
    recompute_pending_approval_quota(&tx, &mut quota)?;
    save_quota(&tx, &quota)?;
    tx.commit().map_err(storage_error)?;
    Ok(())
}

/// Recompute session/profile AI byte counters from durable rows.
pub(crate) fn recompute_ai_quotas(connection: &Connection) -> Result<(), RepositoryError> {
    let tx = connection.unchecked_transaction().map_err(storage_error)?;
    ensure_quota_row(&tx)?;

    // Per-session counters.
    let mut statement = tx
        .prepare(
            "SELECT session_id, COUNT(*), COALESCE(SUM(content_bytes), 0)
             FROM ai_messages GROUP BY session_id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(storage_error)?;
    let mut session_stats = std::collections::HashMap::new();
    for row in rows {
        let (session_id, count, bytes) = row.map_err(storage_error)?;
        session_stats.insert(session_id, (count, bytes));
    }
    drop(statement);

    let mut sessions = tx
        .prepare("SELECT id FROM ai_sessions")
        .map_err(storage_error)?;
    let session_ids = sessions
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    drop(sessions);
    for session_id in session_ids {
        let (count, bytes) = session_stats.get(&session_id).copied().unwrap_or((0, 0));
        tx.execute(
            "UPDATE ai_sessions SET message_count = ?1, content_bytes = ?2 WHERE id = ?3",
            params![count, bytes, session_id],
        )
        .map_err(storage_error)?;
    }

    let session_count: i64 = tx
        .query_row("SELECT COUNT(*) FROM ai_sessions", [], |row| row.get(0))
        .map_err(storage_error)?;
    let total_content: i64 = tx
        .query_row(
            "SELECT COALESCE(SUM(content_bytes), 0) FROM ai_sessions",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let memory_count: i64 = tx
        .query_row("SELECT COUNT(*) FROM ai_memories", [], |row| row.get(0))
        .map_err(storage_error)?;
    let memory_bytes: i64 = tx
        .query_row(
            "SELECT COALESCE(SUM(content_bytes), 0) FROM ai_memories",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let pending_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM ai_tool_approvals WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let pending_bytes: i64 = tx
        .query_row(
            "SELECT COALESCE(SUM(arguments_bytes), 0) FROM ai_tool_approvals WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;

    tx.execute(
        "UPDATE ai_quota SET
            session_count = ?1,
            total_content_bytes = ?2,
            memory_count = ?3,
            memory_content_bytes = ?4,
            pending_approval_count = ?5,
            pending_approval_content_bytes = ?6
         WHERE singleton = 1",
        params![
            session_count,
            total_content,
            memory_count,
            memory_bytes,
            pending_count,
            pending_bytes
        ],
    )
    .map_err(storage_error)?;
    tx.commit().map_err(storage_error)?;
    Ok(())
}

/// True when an operation_undo row exists for this source (AI ops must never create one).
pub(crate) fn has_undo_record(
    connection: &Connection,
    operation_id: OperationId,
) -> Result<bool, RepositoryError> {
    let found: bool = connection
        .query_row(
            "SELECT COUNT(*) > 0 FROM operation_undo WHERE source_operation_id = ?1",
            [operation_id.to_string()],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    Ok(found)
}

fn expire_pending_approvals_for_session(
    tx: &rusqlite::Transaction<'_>,
    session_id: AiSessionId,
    now: Timestamp,
) -> Result<(), RepositoryError> {
    tx.execute(
        "UPDATE ai_tool_approvals SET status = 'expired', updated_at = ?1
         WHERE session_id = ?2 AND status = 'pending'",
        params![now.to_string(), session_id.to_string()],
    )
    .map_err(storage_error)?;
    Ok(())
}

fn recompute_pending_approval_quota(
    tx: &rusqlite::Transaction<'_>,
    quota: &mut AiQuota,
) -> Result<(), RepositoryError> {
    let (count, bytes): (i64, i64) = tx
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(arguments_bytes), 0)
             FROM ai_tool_approvals WHERE status = 'pending'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    quota.pending_approval_count = u32::try_from(count).map_err(storage_error)?;
    quota.pending_approval_content_bytes = u64::try_from(bytes).map_err(storage_error)?;
    Ok(())
}

/// Load a tool approval by id.
#[allow(dead_code)]
pub(crate) fn get_ai_approval(
    connection: &Connection,
    approval_id: AiApprovalId,
) -> Result<AiToolApproval, RepositoryError> {
    connection
        .query_row(
            "SELECT id, session_id, turn_id, run_id, generation, tool_name, arguments_json,
                    arguments_bytes, action_hash, status, expires_at, operation_id,
                    created_at, updated_at
             FROM ai_tool_approvals WHERE id = ?1",
            [approval_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .map(
            |(
                id,
                session,
                turn,
                run,
                generation,
                tool,
                args,
                bytes,
                hash,
                status,
                expires,
                op,
                created,
                updated,
            )| {
                Ok(AiToolApproval {
                    id: AiApprovalId::parse(&id).map_err(storage_error)?,
                    session_id: AiSessionId::parse(&session).map_err(storage_error)?,
                    turn_id: AiTurnId::parse(&turn).map_err(storage_error)?,
                    run_id: AiRunId::parse(&run).map_err(storage_error)?,
                    generation: u64::try_from(generation).map_err(storage_error)?,
                    tool_name: tool,
                    arguments_json: args,
                    arguments_bytes: u64::try_from(bytes).map_err(storage_error)?,
                    action_hash: hash,
                    status: AiApprovalStatus::parse(&status).map_err(storage_error)?,
                    expires_at: expires.parse().map_err(storage_error)?,
                    operation_id: op,
                    created_at: created.parse().map_err(storage_error)?,
                    updated_at: updated.parse().map_err(storage_error)?,
                })
            },
        )
        .transpose()?
        .ok_or(RepositoryError::NotFound)
}
