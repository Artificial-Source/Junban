//! Bounded AI session, message, memory, approval, and run-state persistence.
//!
//! Mutations use the existing one-transaction/one-event/one-receipt path and are
//! deliberately non-undoable (`undo: None`).

#![allow(dead_code)]
#![allow(clippy::too_many_arguments)]

use std::collections::HashSet;

use jiff::{Timestamp, ToSpan};
use junban_app::{
    AffectedIds, AiMemoryCursor, AiMemoryListPage, AiSessionCursor, AiSessionListPage,
    CommittedMutation, EventType, PreparedAiResponse, RepositoryError,
    ReserveDailyAiResponseRequest, ResourceRef, ResyncScope, RewriteAiResponseRequest,
};
use junban_domain::{
    AI_APPROVAL_LIFETIME_SECS, AI_CONTEXT_MEMORIES_MAX, AI_DISPATCHING_APPROVAL_RECOVERY_MAX,
    AI_MEMORIES_PER_PROFILE_MAX, AI_MEMORY_CONTENT_BYTES_MAX, AI_MEMORY_PAGE_MAX,
    AI_MESSAGE_CONTENT_JSON_BYTES_MAX, AI_MESSAGES_PER_SESSION_MAX,
    AI_PENDING_APPROVAL_CONTENT_BYTES_MAX, AI_PENDING_APPROVALS_MAX, AI_PROFILE_CONTENT_BYTES_MAX,
    AI_SESSION_CONTENT_BYTES_MAX, AI_SESSION_PAGE_MAX, AI_SESSIONS_PER_PROFILE_MAX, AiApprovalId,
    AiApprovalStatus, AiMemory, AiMemoryId, AiMessage, AiMessageContent, AiMessageId,
    AiMessageRole, AiMessageStatus, AiResponseRewriteKind, AiRunId, AiRunPhase, AiRunState,
    AiSession, AiSessionId, AiSessionStatus, AiToolApproval, AiToolEvent, AiToolEventType,
    AiTurnId, OperationId, ai_approval_action_hash, validate_ai_tool_name,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::helpers::validation;
use crate::rows::storage_error;
use crate::tx::{MutationEffect, RECEIPT_TTL_DAYS, canonical_json, mutate};

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Req<'a> {
    // Generated primary IDs are mutation material only and must not appear here:
    // exact retries may pass a fresh throwaway ID while replaying the original row.
    CreateAiSession {
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
        assistant_content_json: &'a str,
    },
    SetAiApprovalStatus {
        approval_id: String,
        status: &'a str,
        operation_id: Option<&'a str>,
        assistant_content_sha256: Option<&'a str>,
    },
    ReserveDailyAiResponse {
        session_id: String,
        briefing_date: &'a str,
    },
    RewriteAiResponse {
        kind: &'a str,
        session_id: String,
        target_message_id: String,
        message_sha256: String,
        focused_task_id: Option<String>,
    },
    UpsertAiRunState {
        run_id: String,
        session_id: String,
        turn_id: String,
        assistant_message_id: String,
        generation: u64,
        state: &'a str,
        approval_id: Option<&'a str>,
    },
    CancelAiResponse {
        assistant_message_id: String,
        session_id: String,
        turn_id: String,
        run_id: String,
        generation: u64,
        content_json: &'a str,
    },
    FinishAiResponse {
        assistant_message_id: String,
        session_id: String,
        turn_id: String,
        run_id: String,
        generation: u64,
        message_status: &'a str,
        content_json: &'a str,
        run_phase: &'a str,
        dispatch_operation_id: Option<&'a str>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum ResponseInvalidationReceipt {
    RewriteAiResponse {
        kind: String,
        session_id: String,
        target_message_id: String,
        message_sha256: String,
        focused_task_id: Option<String>,
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

fn ensure_quota_row(tx: &rusqlite::Connection) -> Result<(), RepositoryError> {
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

fn load_quota(tx: &rusqlite::Connection) -> Result<AiQuota, RepositoryError> {
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

fn save_quota(tx: &rusqlite::Connection, quota: &AiQuota) -> Result<(), RepositoryError> {
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

fn replace_streaming_assistant_content(
    tx: &rusqlite::Connection,
    assistant_message_id: &str,
    session_id: AiSessionId,
    turn_id: AiTurnId,
    content_json: &str,
    content_bytes: u64,
    now: Timestamp,
    quota: &mut AiQuota,
) -> Result<(), RepositoryError> {
    let old_bytes = tx
        .query_row(
            "SELECT content_bytes FROM ai_messages
             WHERE id = ?1 AND session_id = ?2 AND turn_id = ?3
               AND role = 'assistant' AND status = 'streaming'",
            params![
                assistant_message_id,
                session_id.to_string(),
                turn_id.to_string()
            ],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(storage_error)?
        .ok_or(RepositoryError::Conflict)?;
    let session_bytes = tx
        .query_row(
            "SELECT content_bytes FROM ai_sessions WHERE id = ?1",
            [session_id.to_string()],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(storage_error)?
        .ok_or(RepositoryError::NotFound)?;
    let delta_bytes = content_bytes as i64 - old_bytes;
    let next_session_bytes = session_bytes
        .checked_add(delta_bytes)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| RepositoryError::Storage("invalid AI session byte counter".into()))?;
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
    let updated = tx
        .execute(
            "UPDATE ai_messages SET content_json = ?1, content_bytes = ?2, updated_at = ?3
             WHERE id = ?4 AND session_id = ?5 AND turn_id = ?6
               AND role = 'assistant' AND status = 'streaming'",
            params![
                content_json,
                content_bytes as i64,
                now.to_string(),
                assistant_message_id,
                session_id.to_string(),
                turn_id.to_string(),
            ],
        )
        .map_err(storage_error)?;
    if updated != 1 {
        return Err(RepositoryError::Conflict);
    }
    tx.execute(
        "UPDATE ai_sessions SET content_bytes = ?1, updated_at = ?2, last_message_at = ?2
         WHERE id = ?3",
        params![
            next_session_bytes as i64,
            now.to_string(),
            session_id.to_string()
        ],
    )
    .map_err(storage_error)?;
    quota.total_content_bytes = next_profile_bytes;
    Ok(())
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
    mut content: AiMessageContent,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    if role == AiMessageRole::Assistant {
        preserve_briefing_date(connection, message_id, session_id, &mut content)?;
    }
    canonicalize_optional_json(
        &mut content.tool_arguments_json,
        "ai_message.content.tool_arguments_json",
        junban_domain::AI_TOOL_ARGUMENTS_BYTES_MAX,
    )?;
    canonicalize_optional_json(
        &mut content.tool_result_json,
        "ai_message.content.tool_result_json",
        junban_domain::AI_TOOL_RESULT_BYTES_MAX,
    )?;
    if let Some(date) = &content.briefing_date {
        let parsed = date.parse::<jiff::civil::Date>().map_err(|_| {
            validation(junban_domain::ValidationError::InvalidFormat {
                field: "ai_message.content.briefing_date",
                expected: "YYYY-MM-DD",
            })
        })?;
        if parsed.to_string() != *date {
            return Err(validation(junban_domain::ValidationError::InvalidFormat {
                field: "ai_message.content.briefing_date",
                expected: "YYYY-MM-DD",
            }));
        }
    }
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
                "SELECT session_id, content_bytes, sequence FROM ai_messages WHERE id = ?1",
                [message_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?;
        if existing
            .as_ref()
            .is_some_and(|(durable_session, _, _)| durable_session != &session_id.to_string())
        {
            return Err(RepositoryError::Conflict);
        }

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
        let (sequence, delta_bytes, new_message) = if let Some((_, old_bytes, sequence)) = existing
        {
            let delta = content_bytes as i64 - old_bytes;
            (
                u32::try_from(sequence).map_err(storage_error)?,
                delta,
                false,
            )
        } else {
            if session_messages as u32 >= AI_MESSAGES_PER_SESSION_MAX {
                return Err(quota_err("ai_messages"));
            }
            let next_sequence = u32::try_from(session_messages + 1).map_err(storage_error)?;
            (next_sequence, content_bytes as i64, true)
        };

        let next_session_bytes = session_bytes
            .checked_add(delta_bytes)
            .and_then(|value| u64::try_from(value).ok())
            .ok_or_else(|| RepositoryError::Storage("invalid AI session byte counter".into()))?;
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
            let updated = tx
                .execute(
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
            if updated != 1 {
                return Err(RepositoryError::Conflict);
            }
        }

        let updated_session = tx
            .execute(
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
        if updated_session != 1 {
            return Err(RepositoryError::Conflict);
        }

        quota.total_content_bytes = next_profile_bytes;
        save_quota(tx, &quota)?;

        Ok(ai_effect(
            EventType::AI_SESSION_CHANGED,
            ResourceRef::ai_session(session_id),
            ("ai_message", message_id.to_string()),
        ))
    })
}

pub(crate) fn get_ai_message(
    connection: &Connection,
    message_id: AiMessageId,
) -> Result<AiMessage, RepositoryError> {
    let row = connection
        .query_row(
            "SELECT id, session_id, turn_id, sequence, role, status,
                    content_json, content_bytes, created_at, updated_at
             FROM ai_messages WHERE id = ?1",
            [message_id.to_string()],
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
        .optional()
        .map_err(storage_error)?
        .ok_or(RepositoryError::NotFound)?;
    build_message(row)
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
        out.push(build_message(row.map_err(storage_error)?)?);
    }
    Ok(out)
}

type MessageRow = (
    String,
    String,
    String,
    i64,
    String,
    String,
    String,
    i64,
    String,
    String,
);

fn build_message(row: MessageRow) -> Result<AiMessage, RepositoryError> {
    let (id, sid, turn, sequence, role, status, content_json, bytes, created, updated) = row;
    let content: AiMessageContent = serde_json::from_str(&content_json).map_err(storage_error)?;
    content.validate().map_err(validation)?;
    Ok(AiMessage {
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
    })
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

/// Create pending approval authority and bind its exact running generation atomically.
///
/// Callers create the run in `Running` first. A successful proposal already moves it to
/// `AwaitingApproval`; callers must not perform a second run-state bind mutation.
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
    let assistant_message_id = connection
        .query_row(
            "SELECT assistant_message_id FROM ai_run_state WHERE run_id = ?1",
            [run_id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage_error)?;
    let mut assistant_content = match assistant_message_id {
        Some(assistant_message_id) => {
            get_ai_message(
                connection,
                AiMessageId::parse(&assistant_message_id).map_err(storage_error)?,
            )?
            .content
        }
        None => AiMessageContent::text("").map_err(validation)?,
    };
    assistant_content.tool_name = Some(tool_name.clone());
    assistant_content.tool_arguments_json = Some(canonicalize_json_object(
        arguments_json.clone(),
        "ai_approval.arguments_json",
        junban_domain::AI_TOOL_ARGUMENTS_BYTES_MAX,
    )?);
    assistant_content.tool_result_json = None;
    propose_ai_approval_with_content(
        connection,
        operation_id,
        approval_id,
        session_id,
        turn_id,
        run_id,
        generation,
        tool_name,
        arguments_json,
        assistant_content,
        now,
    )
}

pub(crate) fn propose_ai_approval_with_content(
    connection: &mut Connection,
    operation_id: OperationId,
    approval_id: AiApprovalId,
    session_id: AiSessionId,
    turn_id: AiTurnId,
    run_id: AiRunId,
    generation: u64,
    tool_name: String,
    arguments_json: String,
    mut assistant_content: AiMessageContent,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    ensure_ai_response_current(connection, run_id)?;
    let durable_run = get_ai_run_state(connection, run_id).map_err(|error| match error {
        RepositoryError::NotFound => RepositoryError::Conflict,
        other => other,
    })?;
    if durable_run.session_id != session_id
        || durable_run.turn_id != turn_id
        || durable_run.generation != generation
    {
        return Err(RepositoryError::Conflict);
    }
    preserve_briefing_date(
        connection,
        durable_run.assistant_message_id,
        session_id,
        &mut assistant_content,
    )?;
    validate_ai_tool_name(&tool_name).map_err(validation)?;
    let arguments_json = canonicalize_json_object(
        arguments_json,
        "ai_approval.arguments_json",
        junban_domain::AI_TOOL_ARGUMENTS_BYTES_MAX,
    )?;
    let generation = i64::try_from(generation).map_err(|_| {
        validation(junban_domain::ValidationError::Invalid {
            field: "ai_approval.generation",
            reason: "generation is too large",
        })
    })?;
    let arguments_bytes = arguments_json.len() as u64;
    let action_hash = ai_approval_action_hash(&tool_name, &arguments_json).map_err(validation)?;
    let expires_at = now + AI_APPROVAL_LIFETIME_SECS.seconds();
    canonicalize_optional_json(
        &mut assistant_content.tool_arguments_json,
        "ai_message.content.tool_arguments_json",
        junban_domain::AI_TOOL_ARGUMENTS_BYTES_MAX,
    )?;
    canonicalize_optional_json(
        &mut assistant_content.tool_result_json,
        "ai_message.content.tool_result_json",
        junban_domain::AI_TOOL_RESULT_BYTES_MAX,
    )?;
    if assistant_content.tool_name.as_deref() != Some(tool_name.as_str())
        || assistant_content.tool_arguments_json.as_deref() != Some(arguments_json.as_str())
        || assistant_content.tool_result_json.is_some()
    {
        return Err(RepositoryError::Conflict);
    }
    let base_content_json = assistant_content.canonical_json().map_err(validation)?;
    let request = canonical_json(&Req::ProposeAiApproval {
        approval_id: approval_id.to_string(),
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        run_id: run_id.to_string(),
        generation: generation as u64,
        tool_name: &tool_name,
        arguments_json: &arguments_json,
        assistant_content_json: &base_content_json,
    })?;
    let arguments: Value = serde_json::from_str(&arguments_json).map_err(storage_error)?;
    assistant_content.tool_events.push(
        AiToolEvent::new(
            assistant_content.text.len(),
            AiToolEventType::ToolProposed,
            json!({
                "approval_id": approval_id.to_string(),
                "tool": tool_name.clone(),
                "arguments": arguments,
                "action_hash": action_hash.clone(),
                "expires_at": expires_at,
            }),
        )
        .map_err(validation)?,
    );
    let assistant_content_json = assistant_content.canonical_json().map_err(validation)?;
    let assistant_content_bytes = AiMessageContent::byte_len(&assistant_content_json);
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
                generation,
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
        // The insert deliberately precedes the compare-and-swap: transaction rollback
        // removes it if the exact run generation is no longer Running and unbound.
        let run_updated = tx
            .execute(
                "UPDATE ai_run_state
                 SET state = ?1, approval_id = ?2, updated_at = ?3
                 WHERE run_id = ?4 AND session_id = ?5 AND turn_id = ?6
                   AND generation = ?7 AND state = ?8 AND approval_id IS NULL
                   AND EXISTS(SELECT 1 FROM ai_messages
                       WHERE ai_messages.id = ai_run_state.assistant_message_id
                         AND ai_messages.session_id = ai_run_state.session_id
                         AND ai_messages.turn_id = ai_run_state.turn_id
                         AND ai_messages.role = 'assistant'
                         AND ai_messages.status = 'streaming')",
                params![
                    AiRunPhase::AwaitingApproval.as_str(),
                    approval_id.to_string(),
                    now.to_string(),
                    run_id.to_string(),
                    session_id.to_string(),
                    turn_id.to_string(),
                    generation,
                    AiRunPhase::Running.as_str(),
                ],
            )
            .map_err(storage_error)?;
        if run_updated != 1 {
            return Err(RepositoryError::Conflict);
        }
        let assistant_message_id: String = tx
            .query_row(
                "SELECT assistant_message_id FROM ai_run_state WHERE run_id = ?1",
                [run_id.to_string()],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        replace_streaming_assistant_content(
            tx,
            &assistant_message_id,
            session_id,
            turn_id,
            &assistant_content_json,
            assistant_content_bytes,
            now,
            &mut quota,
        )?;
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

fn rejection_tool_result(tool_name: &str) -> Value {
    json!({
        "tool": tool_name,
        "outcome": "error",
        "data": {
            "code": "tool_rejected",
            "message": "the operator rejected this tool action",
        },
        "truncated": false,
    })
}

fn exact_proposal_payload(approval: &AiToolApproval) -> Result<Value, RepositoryError> {
    let arguments: Value = serde_json::from_str(&approval.arguments_json).map_err(storage_error)?;
    Ok(json!({
        "approval_id": approval.id.to_string(),
        "tool": approval.tool_name,
        "arguments": arguments,
        "action_hash": approval.action_hash,
        "expires_at": approval.expires_at,
    }))
}

fn decision_checkpoint_content(
    connection: &Connection,
    approval: &AiToolApproval,
    status: AiApprovalStatus,
) -> Result<AiMessageContent, RepositoryError> {
    let assistant_message_id: String = connection
        .query_row(
            "SELECT assistant_message_id FROM ai_run_state WHERE run_id = ?1",
            [approval.run_id.to_string()],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let mut content = get_ai_message(
        connection,
        AiMessageId::parse(&assistant_message_id).map_err(storage_error)?,
    )?
    .content;
    if content.tool_name.as_deref() != Some(approval.tool_name.as_str())
        || content.tool_arguments_json.as_deref() != Some(approval.arguments_json.as_str())
        || content.tool_result_json.is_some()
        || content.tool_events.last().is_none_or(|event| {
            event.event_type != AiToolEventType::ToolProposed
                || exact_proposal_payload(approval).map_or(true, |payload| event.payload != payload)
        })
    {
        return Err(RepositoryError::Conflict);
    }
    let event_type = match status {
        AiApprovalStatus::Consumed => AiToolEventType::ToolApproved,
        AiApprovalStatus::Rejected => AiToolEventType::ToolRejected,
        _ => return Err(RepositoryError::Conflict),
    };
    content.tool_events.push(
        AiToolEvent::new(
            content.text.len(),
            event_type,
            json!({"approval_id": approval.id.to_string()}),
        )
        .map_err(validation)?,
    );
    if status == AiApprovalStatus::Rejected {
        let result = rejection_tool_result(&approval.tool_name);
        content.tool_events.push(
            AiToolEvent::new(
                content.text.len(),
                AiToolEventType::ToolResult,
                result.clone(),
            )
            .map_err(validation)?,
        );
        content.tool_result_json = Some(serde_json::to_string(&result).map_err(storage_error)?);
    }
    content.canonical_json().map_err(validation)?;
    Ok(content)
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
    let assistant_content = if matches!(
        status,
        AiApprovalStatus::Rejected | AiApprovalStatus::Consumed
    ) {
        let approval = load_validated_ai_approval(connection, approval_id)?;
        Some(decision_checkpoint_content(connection, &approval, status)?)
    } else {
        None
    };
    set_ai_approval_status_with_content(
        connection,
        operation_id,
        approval_id,
        status,
        dispatch_operation_id,
        assistant_content,
        now,
    )
}

pub(crate) fn set_ai_approval_status_with_content(
    connection: &mut Connection,
    operation_id: OperationId,
    approval_id: AiApprovalId,
    status: AiApprovalStatus,
    dispatch_operation_id: Option<String>,
    mut assistant_content: Option<AiMessageContent>,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    if let Some(content) = assistant_content.as_mut() {
        let binding = connection
            .query_row(
                "SELECT run.run_id, run.assistant_message_id, run.session_id
                 FROM ai_tool_approvals approval
                 JOIN ai_run_state run ON run.run_id = approval.run_id
                 WHERE approval.id = ?1",
                [approval_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::NotFound)?;
        let run_id = AiRunId::parse(&binding.0).map_err(storage_error)?;
        ensure_ai_response_current(connection, run_id)?;
        preserve_briefing_date(
            connection,
            AiMessageId::parse(&binding.1).map_err(storage_error)?,
            AiSessionId::parse(&binding.2).map_err(storage_error)?,
            content,
        )?;
    }
    let assistant_content = match (status, assistant_content) {
        (AiApprovalStatus::Rejected | AiApprovalStatus::Consumed, Some(mut content)) => {
            canonicalize_optional_json(
                &mut content.tool_arguments_json,
                "ai_message.content.tool_arguments_json",
                junban_domain::AI_TOOL_ARGUMENTS_BYTES_MAX,
            )?;
            canonicalize_optional_json(
                &mut content.tool_result_json,
                "ai_message.content.tool_result_json",
                junban_domain::AI_TOOL_RESULT_BYTES_MAX,
            )?;
            Some(content)
        }
        (AiApprovalStatus::Rejected | AiApprovalStatus::Consumed, None) => {
            return Err(validation(junban_domain::ValidationError::Invalid {
                field: "ai_approval.assistant_content",
                reason: "rejecting or consuming an approval requires exact durable assistant content",
            }));
        }
        (_, Some(_)) => {
            return Err(validation(junban_domain::ValidationError::Invalid {
                field: "ai_approval.assistant_content",
                reason: "assistant content is only valid when rejecting or consuming an approval",
            }));
        }
        (_, None) => None,
    };
    let assistant_content_json = assistant_content
        .as_ref()
        .map(AiMessageContent::canonical_json)
        .transpose()
        .map_err(validation)?;
    let assistant_content_bytes = assistant_content_json
        .as_deref()
        .map(AiMessageContent::byte_len);
    let assistant_content_sha256 = assistant_content_json
        .as_deref()
        .map(|content| junban_domain::sha256_hex(content.as_bytes()));
    let dispatch_operation_id = match (status, dispatch_operation_id) {
        (AiApprovalStatus::Consumed, Some(raw)) => {
            let parsed = OperationId::parse(&raw).map_err(validation)?;
            if parsed.to_string() != raw {
                return Err(validation(junban_domain::ValidationError::InvalidId {
                    field: "operation_id",
                }));
            }
            Some(raw)
        }
        (AiApprovalStatus::Consumed, None) => {
            return Err(validation(junban_domain::ValidationError::Invalid {
                field: "operation_id",
                reason: "consuming an approval requires a dispatch operation ID",
            }));
        }
        (_, Some(_)) => {
            return Err(validation(junban_domain::ValidationError::Invalid {
                field: "operation_id",
                reason: "dispatch operation ID is only valid when consuming an approval",
            }));
        }
        (_, None) => None,
    };
    let request = canonical_json(&Req::SetAiApprovalStatus {
        approval_id: approval_id.to_string(),
        status: status.as_str(),
        operation_id: dispatch_operation_id.as_deref(),
        assistant_content_sha256: assistant_content_sha256.as_deref(),
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let dispatching_count = validate_ai_approval_authority(tx)?;
        if status == AiApprovalStatus::Consumed
            && dispatching_count >= AI_DISPATCHING_APPROVAL_RECOVERY_MAX as usize
        {
            return Err(quota_err("ai_dispatching_approvals"));
        }
        let validated = load_validated_ai_approval(tx, approval_id)?;
        let row = tx
            .query_row(
                "SELECT session_id, turn_id, run_id, generation, tool_name, arguments_json,
                        arguments_bytes, action_hash, status, expires_at
                 FROM ai_tool_approvals WHERE id = ?1",
                [approval_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::NotFound)?;
        let previous = AiApprovalStatus::parse(&row.8).map_err(storage_error)?;
        let expires_at: Timestamp = row.9.parse().map_err(storage_error)?;
        let session_id = AiSessionId::parse(&row.0).map_err(storage_error)?;
        let turn_id = AiTurnId::parse(&row.1).map_err(storage_error)?;
        let run_id = AiRunId::parse(&row.2).map_err(storage_error)?;
        let generation = u64::try_from(row.3).map_err(storage_error)?;
        if validated.session_id != session_id
            || validated.turn_id != turn_id
            || validated.run_id != run_id
            || validated.generation != generation
            || validated.tool_name != row.4
            || validated.arguments_json != row.5
            || validated.arguments_bytes != u64::try_from(row.6).map_err(storage_error)?
            || validated.action_hash != row.7
            || validated.status != previous
            || validated.expires_at != expires_at
        {
            return Err(RepositoryError::Storage(
                "AI approval binding is inconsistent".into(),
            ));
        }

        let legal = matches!(
            (previous, status),
            (AiApprovalStatus::Pending, AiApprovalStatus::Approved)
                | (AiApprovalStatus::Pending, AiApprovalStatus::Rejected)
                | (AiApprovalStatus::Pending, AiApprovalStatus::Expired)
                | (AiApprovalStatus::Approved, AiApprovalStatus::Consumed)
                | (AiApprovalStatus::Approved, AiApprovalStatus::Expired)
        );
        if !legal {
            return Err(RepositoryError::Conflict);
        }
        if matches!(
            status,
            AiApprovalStatus::Approved | AiApprovalStatus::Rejected | AiApprovalStatus::Consumed
        ) && now >= expires_at
        {
            return Err(RepositoryError::Conflict);
        }
        let run = tx
            .query_row(
                "SELECT session_id, turn_id, assistant_message_id, generation, state, approval_id
                 FROM ai_run_state WHERE run_id = ?1",
                [&row.2],
                |run| {
                    Ok((
                        run.get::<_, String>(0)?,
                        run.get::<_, String>(1)?,
                        run.get::<_, String>(2)?,
                        run.get::<_, i64>(3)?,
                        run.get::<_, String>(4)?,
                        run.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::Conflict)?;
        let phase = AiRunPhase::parse(&run.4).map_err(storage_error)?;
        let approval_key = approval_id.to_string();
        // Every legal approval transition is a compare-and-swap against the exact
        // bound awaiting run. The approval and resulting crash-valid run pair are
        // committed by this one transaction.
        let assistant_bound: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ai_messages WHERE id = ?1
                   AND session_id = ?2 AND turn_id = ?3 AND role = 'assistant'
                   AND status = 'streaming')",
                params![&run.2, &row.0, &row.1],
                |message| message.get(0),
            )
            .map_err(storage_error)?;
        if run.0 != row.0
            || run.1 != row.1
            || run.3 != row.3
            || run.5.as_deref() != Some(approval_key.as_str())
            || phase != AiRunPhase::AwaitingApproval
            || !assistant_bound
        {
            return Err(RepositoryError::Conflict);
        }
        if matches!(
            status,
            AiApprovalStatus::Rejected | AiApprovalStatus::Consumed
        ) {
            let expected = decision_checkpoint_content(tx, &validated, status)?;
            if assistant_content.as_ref() != Some(&expected) {
                return Err(RepositoryError::Conflict);
            }
        }

        let updated = tx
            .execute(
                "UPDATE ai_tool_approvals
                 SET status = ?1, operation_id = ?2, updated_at = ?3
                 WHERE id = ?4 AND status = ?5
                   AND session_id = ?6 AND turn_id = ?7 AND run_id = ?8
                   AND generation = ?9",
                params![
                    status.as_str(),
                    dispatch_operation_id,
                    now.to_string(),
                    approval_id.to_string(),
                    previous.as_str(),
                    session_id.to_string(),
                    turn_id.to_string(),
                    run_id.to_string(),
                    row.3,
                ],
            )
            .map_err(storage_error)?;
        if updated != 1 {
            return Err(RepositoryError::Conflict);
        }
        let next_run_phase = match status {
            AiApprovalStatus::Approved => None,
            AiApprovalStatus::Rejected => Some(AiRunPhase::Running),
            AiApprovalStatus::Expired => Some(AiRunPhase::Cancelled),
            AiApprovalStatus::Consumed => Some(AiRunPhase::Dispatching),
            AiApprovalStatus::Pending => return Err(RepositoryError::Conflict),
        };
        if let Some(next_run_phase) = next_run_phase {
            let retain_binding = status == AiApprovalStatus::Consumed;
            let run_updated = tx
                .execute(
                    "UPDATE ai_run_state
                     SET state = ?1,
                         approval_id = CASE WHEN ?2 THEN approval_id ELSE NULL END,
                         updated_at = ?3
                     WHERE run_id = ?4
                       AND session_id = ?5
                       AND turn_id = ?6
                       AND assistant_message_id = ?7
                       AND generation = ?8
                       AND state = ?9
                       AND approval_id = ?10",
                    params![
                        next_run_phase.as_str(),
                        retain_binding,
                        now.to_string(),
                        run_id.to_string(),
                        session_id.to_string(),
                        turn_id.to_string(),
                        run.2,
                        row.3,
                        AiRunPhase::AwaitingApproval.as_str(),
                        approval_id.to_string(),
                    ],
                )
                .map_err(storage_error)?;
            if run_updated != 1 {
                return Err(RepositoryError::Conflict);
            }
        }
        let mut quota = load_quota(tx)?;
        if let (Some(content_json), Some(content_bytes)) =
            (assistant_content_json.as_deref(), assistant_content_bytes)
        {
            replace_streaming_assistant_content(
                tx,
                &run.2,
                session_id,
                turn_id,
                content_json,
                content_bytes,
                now,
                &mut quota,
            )?;
        }
        if previous.is_pending() {
            quota.pending_approval_count = quota
                .pending_approval_count
                .checked_sub(1)
                .ok_or_else(|| RepositoryError::Storage("invalid pending approval quota".into()))?;
            quota.pending_approval_content_bytes = quota
                .pending_approval_content_bytes
                .checked_sub(u64::try_from(row.6).map_err(storage_error)?)
                .ok_or_else(|| RepositoryError::Storage("invalid pending approval quota".into()))?;
        }
        save_quota(tx, &quota)?;
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
    ensure_ai_response_current(connection, state.run_id)?;
    let generation = i64::try_from(state.generation).map_err(|_| {
        validation(junban_domain::ValidationError::Invalid {
            field: "ai_run.generation",
            reason: "generation is too large",
        })
    })?;
    if state.created_at > now || state.updated_at > now {
        return Err(validation(junban_domain::ValidationError::Invalid {
            field: "ai_run.timestamps",
            reason: "run timestamps cannot be in the future",
        }));
    }
    let approval_id = state.approval_id.map(|id| id.to_string());
    let request = canonical_json(&Req::UpsertAiRunState {
        run_id: state.run_id.to_string(),
        session_id: state.session_id.to_string(),
        turn_id: state.turn_id.to_string(),
        assistant_message_id: state.assistant_message_id.to_string(),
        generation: state.generation,
        state: state.state.as_str(),
        approval_id: approval_id.as_deref(),
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let assistant_bound: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ai_messages
                 WHERE id = ?1 AND session_id = ?2 AND turn_id = ?3 AND role = 'assistant')",
                params![
                    state.assistant_message_id.to_string(),
                    state.session_id.to_string(),
                    state.turn_id.to_string(),
                ],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if !assistant_bound {
            return Err(RepositoryError::Conflict);
        }
        validate_run_approval_binding(
            tx,
            state.run_id,
            state.session_id,
            state.turn_id,
            generation,
            state.state,
            approval_id.as_deref(),
        )?;

        let existing = tx
            .query_row(
                "SELECT session_id, turn_id, assistant_message_id, generation, state, approval_id
                 FROM ai_run_state WHERE run_id = ?1",
                [state.run_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?;

        let durable_session =
            if let Some((session, turn, assistant, old_generation, old_phase, old_approval_id)) =
                existing
            {
                if session != state.session_id.to_string()
                    || turn != state.turn_id.to_string()
                    || assistant != state.assistant_message_id.to_string()
                {
                    return Err(RepositoryError::Conflict);
                }
                let old_phase = AiRunPhase::parse(&old_phase).map_err(storage_error)?;
                if old_phase.is_terminal() || generation < old_generation {
                    return Err(RepositoryError::Conflict);
                }
                let replacing_generation = generation > old_generation;
                let legal = if replacing_generation {
                    state.state == AiRunPhase::Running && approval_id.is_none()
                } else {
                    legal_run_transition(old_phase, state.state)
                };
                if !legal || (replacing_generation && old_phase == AiRunPhase::Dispatching) {
                    return Err(RepositoryError::Conflict);
                }
                if replacing_generation {
                    match old_phase {
                        AiRunPhase::AwaitingApproval => {
                            let prior_approval = old_approval_id
                                .as_deref()
                                .ok_or(RepositoryError::Conflict)?;
                            expire_bound_run_approval(
                                tx,
                                prior_approval,
                                state.run_id,
                                state.session_id,
                                state.turn_id,
                                old_generation,
                                now,
                            )?;
                        }
                        AiRunPhase::Running if old_approval_id.is_none() => {}
                        _ => return Err(RepositoryError::Conflict),
                    }
                } else if old_phase == AiRunPhase::AwaitingApproval
                    && matches!(state.state, AiRunPhase::Failed | AiRunPhase::Cancelled)
                {
                    if approval_id.is_some() {
                        return Err(RepositoryError::Conflict);
                    }
                    let prior_approval = old_approval_id
                        .as_deref()
                        .ok_or(RepositoryError::Conflict)?;
                    // Expire authority first, release pending quota when needed, then CAS
                    // the bound run terminal. Any failure rolls the entire mutation back.
                    expire_bound_run_approval(
                        tx,
                        prior_approval,
                        state.run_id,
                        state.session_id,
                        state.turn_id,
                        old_generation,
                        now,
                    )?;
                }
                let updated = tx
                    .execute(
                        "UPDATE ai_run_state
                     SET generation = ?1, state = ?2, approval_id = ?3, updated_at = ?4
                     WHERE run_id = ?5 AND session_id = ?6 AND turn_id = ?7
                       AND assistant_message_id = ?8 AND generation = ?9
                       AND state = ?10 AND approval_id IS ?11",
                        params![
                            generation,
                            state.state.as_str(),
                            approval_id,
                            now.to_string(),
                            state.run_id.to_string(),
                            session,
                            turn,
                            assistant,
                            old_generation,
                            old_phase.as_str(),
                            old_approval_id,
                        ],
                    )
                    .map_err(storage_error)?;
                if updated != 1 {
                    return Err(RepositoryError::Conflict);
                }
                AiSessionId::parse(&session).map_err(storage_error)?
            } else {
                if state.state != AiRunPhase::Running || approval_id.is_some() {
                    return Err(RepositoryError::Conflict);
                }
                let inserted = tx
                    .execute(
                        "INSERT INTO ai_run_state(
                        run_id, session_id, turn_id, assistant_message_id, generation,
                        state, approval_id, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8)",
                        params![
                            state.run_id.to_string(),
                            state.session_id.to_string(),
                            state.turn_id.to_string(),
                            state.assistant_message_id.to_string(),
                            generation,
                            state.state.as_str(),
                            state.created_at.to_string(),
                            now.to_string(),
                        ],
                    )
                    .map_err(storage_error)?;
                if inserted != 1 {
                    return Err(RepositoryError::Conflict);
                }
                state.session_id
            };
        Ok(ai_effect(
            EventType::AI_SESSION_CHANGED,
            ResourceRef::ai_session(durable_session),
            ("ai_run", state.run_id.to_string()),
        ))
    })
}

fn preserve_briefing_date(
    connection: &Connection,
    assistant_message_id: AiMessageId,
    session_id: AiSessionId,
    content: &mut AiMessageContent,
) -> Result<(), RepositoryError> {
    let persisted_json = connection
        .query_row(
            "SELECT content_json FROM ai_messages
             WHERE id = ?1 AND session_id = ?2 AND role = 'assistant'",
            params![assistant_message_id.to_string(), session_id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage_error)?;
    if let Some(persisted_json) = persisted_json {
        let persisted: AiMessageContent =
            serde_json::from_str(&persisted_json).map_err(storage_error)?;
        if persisted.briefing_date.is_some() {
            content.briefing_date = persisted.briefing_date;
        }
    }
    Ok(())
}

/// Atomically cancel a reserved assistant placeholder and its exact run generation.
pub(crate) fn cancel_ai_response(
    connection: &mut Connection,
    operation_id: OperationId,
    assistant_message_id: AiMessageId,
    session_id: AiSessionId,
    turn_id: AiTurnId,
    run_id: AiRunId,
    generation: u64,
    mut content: AiMessageContent,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    ensure_ai_response_current(connection, run_id)?;
    preserve_briefing_date(connection, assistant_message_id, session_id, &mut content)?;
    canonicalize_optional_json(
        &mut content.tool_arguments_json,
        "ai_message.content.tool_arguments_json",
        junban_domain::AI_TOOL_ARGUMENTS_BYTES_MAX,
    )?;
    canonicalize_optional_json(
        &mut content.tool_result_json,
        "ai_message.content.tool_result_json",
        junban_domain::AI_TOOL_RESULT_BYTES_MAX,
    )?;
    if content.text.len() > junban_domain::AI_ASSISTANT_TEXT_BYTES_MAX {
        return Err(validation(junban_domain::ValidationError::TooLong {
            field: "ai_message.content.text",
            max: junban_domain::AI_ASSISTANT_TEXT_BYTES_MAX,
        }));
    }
    let content_json = content.canonical_json().map_err(validation)?;
    let content_bytes = AiMessageContent::byte_len(&content_json);
    let generation_i64 = i64::try_from(generation).map_err(|_| {
        validation(junban_domain::ValidationError::Invalid {
            field: "ai_response.generation",
            reason: "generation is too large",
        })
    })?;
    let request = canonical_json(&Req::CancelAiResponse {
        assistant_message_id: assistant_message_id.to_string(),
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        run_id: run_id.to_string(),
        generation,
        content_json: &content_json,
    })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let old_bytes = tx
            .query_row(
                "SELECT content_bytes FROM ai_messages
                 WHERE id = ?1 AND session_id = ?2 AND turn_id = ?3
                   AND role = 'assistant' AND status = 'streaming'",
                params![
                    assistant_message_id.to_string(),
                    session_id.to_string(),
                    turn_id.to_string(),
                ],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::Conflict)?;
        let (run_session, run_turn, run_assistant, run_generation, phase, approval_id) = tx
            .query_row(
                "SELECT session_id, turn_id, assistant_message_id, generation, state, approval_id
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
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::Conflict)?;
        let phase = AiRunPhase::parse(&phase).map_err(storage_error)?;
        if run_session != session_id.to_string()
            || run_turn != turn_id.to_string()
            || run_assistant != assistant_message_id.to_string()
            || run_generation != generation_i64
        {
            return Err(RepositoryError::Conflict);
        }
        match phase {
            AiRunPhase::Running if approval_id.is_none() => {}
            AiRunPhase::AwaitingApproval => {
                let approval_id = approval_id.as_deref().ok_or(RepositoryError::Conflict)?;
                expire_bound_run_approval(
                    tx,
                    approval_id,
                    run_id,
                    session_id,
                    turn_id,
                    generation_i64,
                    now,
                )?;
            }
            _ => return Err(RepositoryError::Conflict),
        }
        let session_bytes: i64 = tx
            .query_row(
                "SELECT content_bytes FROM ai_sessions WHERE id = ?1",
                [session_id.to_string()],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let delta_bytes = content_bytes as i64 - old_bytes;
        let next_session_bytes = session_bytes
            .checked_add(delta_bytes)
            .and_then(|value| u64::try_from(value).ok())
            .ok_or_else(|| RepositoryError::Storage("invalid AI session byte counter".into()))?;
        if next_session_bytes > AI_SESSION_CONTENT_BYTES_MAX {
            return Err(quota_err("ai_session.content_bytes"));
        }
        let mut quota = load_quota(tx)?;
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
        let message_updated = tx
            .execute(
                "UPDATE ai_messages
                 SET status = 'cancelled', content_json = ?1, content_bytes = ?2, updated_at = ?3
                 WHERE id = ?4 AND session_id = ?5 AND turn_id = ?6
                   AND role = 'assistant' AND status = 'streaming'",
                params![
                    content_json,
                    content_bytes as i64,
                    now.to_string(),
                    assistant_message_id.to_string(),
                    session_id.to_string(),
                    turn_id.to_string(),
                ],
            )
            .map_err(storage_error)?;
        let run_updated = tx
            .execute(
                "UPDATE ai_run_state
                 SET state = 'cancelled', approval_id = NULL, updated_at = ?1
                 WHERE run_id = ?2 AND session_id = ?3 AND turn_id = ?4
                   AND assistant_message_id = ?5 AND generation = ?6
                   AND state = ?7 AND approval_id IS ?8",
                params![
                    now.to_string(),
                    run_id.to_string(),
                    session_id.to_string(),
                    turn_id.to_string(),
                    assistant_message_id.to_string(),
                    generation_i64,
                    phase.as_str(),
                    approval_id,
                ],
            )
            .map_err(storage_error)?;
        if message_updated != 1 || run_updated != 1 {
            return Err(RepositoryError::Conflict);
        }
        let session_updated = tx
            .execute(
                "UPDATE ai_sessions SET content_bytes = ?1, updated_at = ?2, last_message_at = ?2
                 WHERE id = ?3",
                params![
                    next_session_bytes as i64,
                    now.to_string(),
                    session_id.to_string()
                ],
            )
            .map_err(storage_error)?;
        if session_updated != 1 {
            return Err(RepositoryError::Conflict);
        }
        quota.total_content_bytes = next_profile_bytes;
        save_quota(tx, &quota)?;
        Ok(ai_effect(
            EventType::AI_SESSION_CHANGED,
            ResourceRef::ai_session(session_id),
            ("ai_response", run_id.to_string()),
        ))
    })
}

fn validate_dispatch_finish_content(
    connection: &Connection,
    assistant_message_id: AiMessageId,
    approval: &AiToolApproval,
    dispatch_operation_id: &str,
    content: &AiMessageContent,
) -> Result<(), RepositoryError> {
    let mut expected = get_ai_message(connection, assistant_message_id)?.content;
    if expected.tool_name.as_deref() != Some(approval.tool_name.as_str())
        || expected.tool_arguments_json.as_deref() != Some(approval.arguments_json.as_str())
        || expected.tool_result_json.is_some()
        || expected.tool_events.last().is_none_or(|event| {
            event.event_type != AiToolEventType::ToolApproved
                || event.payload != json!({"approval_id": approval.id.to_string()})
        })
    {
        return Err(RepositoryError::Conflict);
    }
    let result_event = content
        .tool_events
        .last()
        .filter(|event| event.event_type == AiToolEventType::ToolResult)
        .ok_or(RepositoryError::Conflict)?;
    if result_event.payload.get("tool").and_then(Value::as_str) != Some(approval.tool_name.as_str())
        || result_event
            .payload
            .get("operation_id")
            .and_then(Value::as_str)
            == Some(dispatch_operation_id)
    {
        return Err(RepositoryError::Conflict);
    }
    let result_json = serde_json::to_string(&result_event.payload).map_err(storage_error)?;
    expected.tool_events.push(result_event.clone());
    expected.tool_result_json = Some(result_json);
    if content != &expected {
        return Err(RepositoryError::Conflict);
    }
    Ok(())
}

/// Atomically finalize a reserved assistant placeholder and its exact run generation.
pub(crate) fn finish_ai_response(
    connection: &mut Connection,
    operation_id: OperationId,
    assistant_message_id: AiMessageId,
    session_id: AiSessionId,
    turn_id: AiTurnId,
    run_id: AiRunId,
    generation: u64,
    message_status: AiMessageStatus,
    mut content: AiMessageContent,
    run_phase: AiRunPhase,
    dispatch_operation_id: Option<String>,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    ensure_ai_response_current(connection, run_id)?;
    preserve_briefing_date(connection, assistant_message_id, session_id, &mut content)?;
    let matching_terminal = matches!(
        (message_status, run_phase),
        (AiMessageStatus::Completed, AiRunPhase::Completed)
            | (AiMessageStatus::Failed, AiRunPhase::Failed)
    );
    if !matching_terminal {
        return Err(validation(junban_domain::ValidationError::Invalid {
            field: "ai_response.terminal",
            reason: "assistant status and run phase must be matching terminal states",
        }));
    }
    canonicalize_optional_json(
        &mut content.tool_arguments_json,
        "ai_message.content.tool_arguments_json",
        junban_domain::AI_TOOL_ARGUMENTS_BYTES_MAX,
    )?;
    canonicalize_optional_json(
        &mut content.tool_result_json,
        "ai_message.content.tool_result_json",
        junban_domain::AI_TOOL_RESULT_BYTES_MAX,
    )?;
    if content.text.len() > junban_domain::AI_ASSISTANT_TEXT_BYTES_MAX {
        return Err(validation(junban_domain::ValidationError::TooLong {
            field: "ai_message.content.text",
            max: junban_domain::AI_ASSISTANT_TEXT_BYTES_MAX,
        }));
    }
    let dispatch_operation_id = dispatch_operation_id
        .map(|raw| {
            let parsed = OperationId::parse(&raw).map_err(validation)?;
            if parsed.to_string() != raw {
                return Err(validation(junban_domain::ValidationError::InvalidId {
                    field: "dispatch_operation_id",
                }));
            }
            Ok(raw)
        })
        .transpose()?;
    let content_json = content.canonical_json().map_err(validation)?;
    let content_bytes = AiMessageContent::byte_len(&content_json);
    let request = canonical_json(&Req::FinishAiResponse {
        assistant_message_id: assistant_message_id.to_string(),
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        run_id: run_id.to_string(),
        generation,
        message_status: message_status.as_str(),
        content_json: &content_json,
        run_phase: run_phase.as_str(),
        dispatch_operation_id: dispatch_operation_id.as_deref(),
    })?;

    mutate(connection, operation_id, request, now, move |tx, _| {
        let (durable_session, durable_turn, durable_role, durable_status, old_bytes) = tx
            .query_row(
                "SELECT session_id, turn_id, role, status, content_bytes
                 FROM ai_messages WHERE id = ?1",
                [assistant_message_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::NotFound)?;
        if durable_session != session_id.to_string()
            || durable_turn != turn_id.to_string()
            || durable_role != AiMessageRole::Assistant.as_str()
            || durable_status != AiMessageStatus::Streaming.as_str()
        {
            return Err(RepositoryError::Conflict);
        }

        let (run_session, run_turn, run_assistant, run_generation, old_phase, approval_id) = tx
            .query_row(
                "SELECT session_id, turn_id, assistant_message_id, generation, state, approval_id
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
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::NotFound)?;
        let old_phase = AiRunPhase::parse(&old_phase).map_err(storage_error)?;
        if run_session != session_id.to_string()
            || run_turn != turn_id.to_string()
            || run_assistant != assistant_message_id.to_string()
            || u64::try_from(run_generation).map_err(storage_error)? != generation
        {
            return Err(RepositoryError::Conflict);
        }
        match (
            old_phase,
            approval_id.as_deref(),
            dispatch_operation_id.as_deref(),
        ) {
            (AiRunPhase::Running, None, None) => {}
            (AiRunPhase::Dispatching, Some(approval_id), Some(dispatch_operation_id)) => {
                let approval_id = AiApprovalId::parse(approval_id).map_err(storage_error)?;
                let approval = load_validated_ai_approval(tx, approval_id)?;
                if approval.session_id != session_id
                    || approval.turn_id != turn_id
                    || approval.run_id != run_id
                    || approval.generation != generation
                    || approval.status != AiApprovalStatus::Consumed
                    || approval.operation_id.as_deref() != Some(dispatch_operation_id)
                {
                    return Err(RepositoryError::Conflict);
                }
                validate_dispatch_finish_content(
                    tx,
                    assistant_message_id,
                    &approval,
                    dispatch_operation_id,
                    &content,
                )?;
            }
            _ => return Err(RepositoryError::Conflict),
        }

        let session_bytes: i64 = tx
            .query_row(
                "SELECT content_bytes FROM ai_sessions WHERE id = ?1",
                [session_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::NotFound)?;
        let delta_bytes = content_bytes as i64 - old_bytes;
        let next_session_bytes = session_bytes
            .checked_add(delta_bytes)
            .and_then(|value| u64::try_from(value).ok())
            .ok_or_else(|| RepositoryError::Storage("invalid AI session byte counter".into()))?;
        if next_session_bytes > AI_SESSION_CONTENT_BYTES_MAX {
            return Err(quota_err("ai_session.content_bytes"));
        }
        let mut quota = load_quota(tx)?;
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

        let message_updated = tx
            .execute(
                "UPDATE ai_messages
                 SET status = ?1, content_json = ?2, content_bytes = ?3, updated_at = ?4
                 WHERE id = ?5 AND session_id = ?6 AND turn_id = ?7
                   AND role = 'assistant' AND status = 'streaming'",
                params![
                    message_status.as_str(),
                    content_json,
                    content_bytes as i64,
                    now.to_string(),
                    assistant_message_id.to_string(),
                    session_id.to_string(),
                    turn_id.to_string(),
                ],
            )
            .map_err(storage_error)?;
        if message_updated != 1 {
            return Err(RepositoryError::Conflict);
        }
        let run_updated = tx
            .execute(
                "UPDATE ai_run_state
                 SET state = ?1, updated_at = ?2
                 WHERE run_id = ?3 AND session_id = ?4 AND turn_id = ?5
                   AND assistant_message_id = ?6 AND generation = ?7
                   AND state = ?8 AND approval_id IS ?9",
                params![
                    run_phase.as_str(),
                    now.to_string(),
                    run_id.to_string(),
                    session_id.to_string(),
                    turn_id.to_string(),
                    assistant_message_id.to_string(),
                    run_generation,
                    old_phase.as_str(),
                    approval_id,
                ],
            )
            .map_err(storage_error)?;
        if run_updated != 1 {
            return Err(RepositoryError::Conflict);
        }
        let session_updated = tx
            .execute(
                "UPDATE ai_sessions
                 SET content_bytes = ?1, updated_at = ?2, last_message_at = ?2
                 WHERE id = ?3",
                params![
                    next_session_bytes as i64,
                    now.to_string(),
                    session_id.to_string(),
                ],
            )
            .map_err(storage_error)?;
        if session_updated != 1 {
            return Err(RepositoryError::Conflict);
        }
        quota.total_content_bytes = next_profile_bytes;
        save_quota(tx, &quota)?;

        Ok(ai_effect(
            EventType::AI_SESSION_CHANGED,
            ResourceRef::ai_session(session_id),
            ("ai_response", run_id.to_string()),
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
            "SELECT run_id, session_id, turn_id, assistant_message_id, generation, state,
                    approval_id, created_at, updated_at
             FROM ai_run_state WHERE run_id = ?1",
            [run_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .map(
            |(run, session, turn, assistant, generation, phase, approval, created, updated)| {
                Ok(AiRunState {
                    run_id: AiRunId::parse(&run).map_err(storage_error)?,
                    session_id: AiSessionId::parse(&session).map_err(storage_error)?,
                    turn_id: AiTurnId::parse(&turn).map_err(storage_error)?,
                    assistant_message_id: AiMessageId::parse(&assistant).map_err(storage_error)?,
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

pub(crate) fn get_ai_run_for_assistant(
    connection: &Connection,
    assistant_message_id: AiMessageId,
) -> Result<AiRunState, RepositoryError> {
    let run_id = connection
        .query_row(
            "SELECT run_id FROM ai_run_state WHERE assistant_message_id = ?1",
            [assistant_message_id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage_error)?
        .ok_or(RepositoryError::NotFound)?;
    get_ai_run_state(connection, AiRunId::parse(&run_id).map_err(storage_error)?)
}

pub(crate) fn ensure_ai_response_current(
    connection: &Connection,
    run_id: AiRunId,
) -> Result<(), RepositoryError> {
    let invalidated: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ai_response_invalidations WHERE run_id = ?1)",
            [run_id.to_string()],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if invalidated {
        Err(RepositoryError::Conflict)
    } else {
        Ok(())
    }
}

pub(crate) fn reserve_daily_ai_response(
    connection: &mut Connection,
    operation_id: OperationId,
    request: ReserveDailyAiResponseRequest,
    now: Timestamp,
) -> Result<PreparedAiResponse, RepositoryError> {
    ensure_ai_response_current(connection, request.run_id)?;
    let date = request
        .briefing_date
        .parse::<jiff::civil::Date>()
        .map_err(|_| {
            validation(junban_domain::ValidationError::InvalidFormat {
                field: "ai_message.content.briefing_date",
                expected: "YYYY-MM-DD",
            })
        })?;
    if date.to_string() != request.briefing_date || request.generation == 0 {
        return Err(validation(junban_domain::ValidationError::Invalid {
            field: "ai_response.daily",
            reason: "daily response seed is invalid",
        }));
    }
    let mut assistant_content = AiMessageContent::text("").map_err(validation)?;
    assistant_content.briefing_date = Some(request.briefing_date.clone());
    let content_json = assistant_content.canonical_json().map_err(validation)?;
    let content_bytes = AiMessageContent::byte_len(&content_json);
    let receipt_request = canonical_json(&Req::ReserveDailyAiResponse {
        session_id: request.session_id.to_string(),
        briefing_date: &request.briefing_date,
    })?;
    let seed = request.clone();
    let mutation = mutate(
        connection,
        operation_id,
        receipt_request,
        now,
        move |tx, _| {
            let (status, message_count, session_bytes): (String, i64, i64) = tx
                .query_row(
                    "SELECT status, message_count, content_bytes FROM ai_sessions WHERE id = ?1",
                    [seed.session_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(storage_error)?
                .ok_or(RepositoryError::NotFound)?;
            if status != AiSessionStatus::Active.as_str() {
                return Err(RepositoryError::Conflict);
            }
            let already_active: bool = tx
                .query_row(
                    "SELECT EXISTS(
                    SELECT 1 FROM ai_messages
                    WHERE role = 'assistant' AND status IN ('streaming', 'completed')
                      AND json_type(content_json, '$.briefing_date') = 'text'
                      AND json_extract(content_json, '$.briefing_date') = ?1
                 )",
                    [&seed.briefing_date],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if already_active {
                return Err(RepositoryError::Conflict);
            }
            if message_count >= i64::from(AI_MESSAGES_PER_SESSION_MAX) {
                return Err(quota_err("ai_messages"));
            }
            let next_session_bytes = u64::try_from(session_bytes)
                .map_err(storage_error)?
                .checked_add(content_bytes)
                .ok_or_else(|| quota_err("ai_session.content_bytes"))?;
            if next_session_bytes > AI_SESSION_CONTENT_BYTES_MAX {
                return Err(quota_err("ai_session.content_bytes"));
            }
            let mut quota = load_quota(tx)?;
            let next_profile_bytes = quota
                .total_content_bytes
                .checked_add(content_bytes)
                .ok_or_else(|| quota_err("ai_profile.content_bytes"))?;
            if next_profile_bytes > AI_PROFILE_CONTENT_BYTES_MAX {
                return Err(quota_err("ai_profile.content_bytes"));
            }
            let generation = i64::try_from(seed.generation).map_err(storage_error)?;
            tx.execute(
                "INSERT INTO ai_messages(
                id, session_id, turn_id, sequence, role, status, content_json,
                content_bytes, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'assistant', 'streaming', ?5, ?6, ?7, ?7)",
                params![
                    seed.assistant_message_id.to_string(),
                    seed.session_id.to_string(),
                    seed.turn_id.to_string(),
                    message_count + 1,
                    content_json,
                    content_bytes as i64,
                    now.to_string(),
                ],
            )
            .map_err(storage_error)?;
            tx.execute(
                "INSERT INTO ai_run_state(
                run_id, session_id, turn_id, assistant_message_id, generation, state,
                approval_id, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'running', NULL, ?6, ?6)",
                params![
                    seed.run_id.to_string(),
                    seed.session_id.to_string(),
                    seed.turn_id.to_string(),
                    seed.assistant_message_id.to_string(),
                    generation,
                    now.to_string(),
                ],
            )
            .map_err(storage_error)?;
            tx.execute(
                "UPDATE ai_sessions
             SET message_count = ?1, content_bytes = ?2, updated_at = ?3, last_message_at = ?3
             WHERE id = ?4",
                params![
                    message_count + 1,
                    next_session_bytes as i64,
                    now.to_string(),
                    seed.session_id.to_string(),
                ],
            )
            .map_err(storage_error)?;
            quota.total_content_bytes = next_profile_bytes;
            save_quota(tx, &quota)?;
            Ok(ai_effect(
                EventType::AI_SESSION_CHANGED,
                ResourceRef::ai_session(seed.session_id),
                ("ai_daily_briefing", seed.briefing_date.clone()),
            ))
        },
    )?;
    Ok(PreparedAiResponse {
        mutation,
        user_message: None,
        assistant_message: get_ai_message(connection, request.assistant_message_id)?,
        run: get_ai_run_state(connection, request.run_id)?,
    })
}

pub(crate) fn rewrite_ai_response(
    connection: &mut Connection,
    operation_id: OperationId,
    request: RewriteAiResponseRequest,
    now: Timestamp,
) -> Result<PreparedAiResponse, RepositoryError> {
    ensure_ai_response_current(connection, request.run_id)?;
    if request.generation == 0 {
        return Err(validation(junban_domain::ValidationError::Invalid {
            field: "ai_response.generation",
            reason: "generation must be positive",
        }));
    }
    if request.message.trim().is_empty() {
        return Err(validation(junban_domain::ValidationError::Empty {
            field: "ai_message.content.text",
        }));
    }
    if request.message.len() > junban_domain::AI_USER_INPUT_BYTES_MAX {
        return Err(validation(junban_domain::ValidationError::TooLong {
            field: "ai_message.content.text",
            max: junban_domain::AI_USER_INPUT_BYTES_MAX,
        }));
    }
    let mut user_content = AiMessageContent::text(request.message.clone()).map_err(validation)?;
    user_content.focused_task_id = request.focused_task_id;
    let user_json = user_content.canonical_json().map_err(validation)?;
    let assistant_content = AiMessageContent::text("").map_err(validation)?;
    let assistant_json = assistant_content.canonical_json().map_err(validation)?;
    let assistant_bytes = AiMessageContent::byte_len(&assistant_json);
    let receipt_request = canonical_json(&Req::RewriteAiResponse {
        kind: request.kind.as_str(),
        session_id: request.session_id.to_string(),
        target_message_id: request.target_message_id.to_string(),
        message_sha256: junban_domain::sha256_hex(request.message.as_bytes()),
        focused_task_id: request.focused_task_id.map(|id| id.to_string()),
    })?;
    let seed = request.clone();
    let mutation = mutate(
        connection,
        operation_id,
        receipt_request,
        now,
        move |tx, _| {
            let session_status: String = tx
                .query_row(
                    "SELECT status FROM ai_sessions WHERE id = ?1",
                    [seed.session_id.to_string()],
                    |row| row.get(0),
                )
                .optional()
                .map_err(storage_error)?
                .ok_or(RepositoryError::NotFound)?;
            if session_status != AiSessionStatus::Active.as_str() {
                return Err(RepositoryError::Conflict);
            }
            let target: (String, String, i64, String, String, String) = tx
                .query_row(
                    "SELECT turn_id, role, sequence, status, content_json, id
                 FROM ai_messages WHERE id = ?1 AND session_id = ?2",
                    params![
                        seed.target_message_id.to_string(),
                        seed.session_id.to_string()
                    ],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
                .optional()
                .map_err(storage_error)?
                .ok_or(RepositoryError::NotFound)?;
            let (start_sequence, replacement_source_json) = match seed.kind {
                AiResponseRewriteKind::Edit => {
                    if target.1 != AiMessageRole::User.as_str()
                        || target.3 != AiMessageStatus::Completed.as_str()
                    {
                        return Err(RepositoryError::Conflict);
                    }
                    (target.2, None)
                }
                AiResponseRewriteKind::Retry | AiResponseRewriteKind::Regenerate => {
                    if target.1 != AiMessageRole::Assistant.as_str()
                        || (seed.kind == AiResponseRewriteKind::Retry
                            && !matches!(target.3.as_str(), "failed" | "cancelled"))
                        || (seed.kind == AiResponseRewriteKind::Regenerate
                            && target.3 != AiMessageStatus::Completed.as_str())
                    {
                        return Err(RepositoryError::Conflict);
                    }
                    let target_content: AiMessageContent =
                        serde_json::from_str(&target.4).map_err(storage_error)?;
                    if target_content.briefing_date.is_some() {
                        return Err(RepositoryError::Conflict);
                    }
                    let terminal_phase: String = tx
                        .query_row(
                            "SELECT state FROM ai_run_state
                         WHERE assistant_message_id = ?1 AND session_id = ?2 AND turn_id = ?3",
                            params![target.5, seed.session_id.to_string(), target.0],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(storage_error)?
                        .ok_or(RepositoryError::Conflict)?;
                    let expected_phase = match target.3.as_str() {
                        "completed" => "completed",
                        "cancelled" => "cancelled",
                        "failed" => "failed",
                        _ => return Err(RepositoryError::Conflict),
                    };
                    if terminal_phase != expected_phase {
                        return Err(RepositoryError::Conflict);
                    }
                    let mut users = tx
                        .prepare(
                            "SELECT sequence, content_json FROM ai_messages
                         WHERE session_id = ?1 AND turn_id = ?2
                           AND role = 'user' AND status = 'completed'
                         ORDER BY sequence ASC",
                        )
                        .map_err(storage_error)?;
                    let source_rows = users
                        .query_map(params![seed.session_id.to_string(), target.0], |row| {
                            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                        })
                        .map_err(storage_error)?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(storage_error)?;
                    let [(sequence, content)] = source_rows.as_slice() else {
                        return Err(RepositoryError::Conflict);
                    };
                    let source: AiMessageContent =
                        serde_json::from_str(content).map_err(storage_error)?;
                    if source.text != seed.message || source.focused_task_id != seed.focused_task_id
                    {
                        return Err(RepositoryError::Conflict);
                    }
                    (*sequence, Some(content.clone()))
                }
            };
            if start_sequence < 1 {
                return Err(RepositoryError::Conflict);
            }
            let suffix_count: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM ai_messages WHERE session_id = ?1 AND sequence >= ?2",
                    params![seed.session_id.to_string(), start_sequence],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if suffix_count == 0 || suffix_count > i64::from(AI_MESSAGES_PER_SESSION_MAX) {
                return Err(RepositoryError::Conflict);
            }
            let mut statement = tx
                .prepare(
                    "SELECT run_id, state FROM ai_run_state
                 WHERE session_id = ?1 AND assistant_message_id IN (
                     SELECT id FROM ai_messages WHERE session_id = ?1 AND sequence >= ?2
                 ) ORDER BY run_id",
                )
                .map_err(storage_error)?;
            let suffix_runs = statement
                .query_map(
                    params![seed.session_id.to_string(), start_sequence],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .map_err(storage_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage_error)?;
            if suffix_runs.iter().any(|(_, phase)| {
                matches!(
                    phase.as_str(),
                    "running" | "awaiting_approval" | "dispatching"
                )
            }) {
                return Err(RepositoryError::Conflict);
            }
            let expires_at = now
                .checked_add((RECEIPT_TTL_DAYS * 24).hours())
                .map_err(storage_error)?;
            for (run_id, _) in &suffix_runs {
                tx.execute(
                    "INSERT INTO ai_response_invalidations(
                    run_id, session_id, invalidating_operation_id, expires_at
                 ) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        run_id,
                        seed.session_id.to_string(),
                        operation_id.to_string(),
                        expires_at.to_string(),
                    ],
                )
                .map_err(storage_error)?;
                tx.execute("DELETE FROM ai_tool_approvals WHERE run_id = ?1", [run_id])
                    .map_err(storage_error)?;
            }
            tx.execute(
                "DELETE FROM ai_run_state
             WHERE session_id = ?1 AND assistant_message_id IN (
                 SELECT id FROM ai_messages WHERE session_id = ?1 AND sequence >= ?2
             )",
                params![seed.session_id.to_string(), start_sequence],
            )
            .map_err(storage_error)?;
            tx.execute(
                "DELETE FROM ai_messages WHERE session_id = ?1 AND sequence >= ?2",
                params![seed.session_id.to_string(), start_sequence],
            )
            .map_err(storage_error)?;
            let durable_user_json = replacement_source_json.unwrap_or(user_json.clone());
            let durable_user: AiMessageContent =
                serde_json::from_str(&durable_user_json).map_err(storage_error)?;
            if durable_user.text != seed.message
                || durable_user.focused_task_id != seed.focused_task_id
            {
                return Err(RepositoryError::Conflict);
            }
            let durable_user_bytes = AiMessageContent::byte_len(&durable_user_json);
            let generation = i64::try_from(seed.generation).map_err(storage_error)?;
            tx.execute(
                "INSERT INTO ai_messages(
                id, session_id, turn_id, sequence, role, status, content_json,
                content_bytes, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'user', 'completed', ?5, ?6, ?7, ?7)",
                params![
                    seed.user_message_id.to_string(),
                    seed.session_id.to_string(),
                    seed.turn_id.to_string(),
                    start_sequence,
                    durable_user_json,
                    durable_user_bytes as i64,
                    now.to_string(),
                ],
            )
            .map_err(storage_error)?;
            tx.execute(
                "INSERT INTO ai_messages(
                id, session_id, turn_id, sequence, role, status, content_json,
                content_bytes, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'assistant', 'streaming', ?5, ?6, ?7, ?7)",
                params![
                    seed.assistant_message_id.to_string(),
                    seed.session_id.to_string(),
                    seed.turn_id.to_string(),
                    start_sequence + 1,
                    assistant_json,
                    assistant_bytes as i64,
                    now.to_string(),
                ],
            )
            .map_err(storage_error)?;
            tx.execute(
                "INSERT INTO ai_run_state(
                run_id, session_id, turn_id, assistant_message_id, generation, state,
                approval_id, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'running', NULL, ?6, ?6)",
                params![
                    seed.run_id.to_string(),
                    seed.session_id.to_string(),
                    seed.turn_id.to_string(),
                    seed.assistant_message_id.to_string(),
                    generation,
                    now.to_string(),
                ],
            )
            .map_err(storage_error)?;
            let (message_count, content_bytes): (i64, i64) = tx
                .query_row(
                    "SELECT COUNT(*), COALESCE(SUM(content_bytes), 0)
                 FROM ai_messages WHERE session_id = ?1",
                    [seed.session_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(storage_error)?;
            if message_count > i64::from(AI_MESSAGES_PER_SESSION_MAX)
                || u64::try_from(content_bytes).map_err(storage_error)?
                    > AI_SESSION_CONTENT_BYTES_MAX
            {
                return Err(quota_err("ai_session.content_bytes"));
            }
            tx.execute(
                "UPDATE ai_sessions
             SET message_count = ?1, content_bytes = ?2, updated_at = ?3, last_message_at = ?3
             WHERE id = ?4",
                params![
                    message_count,
                    content_bytes,
                    now.to_string(),
                    seed.session_id.to_string()
                ],
            )
            .map_err(storage_error)?;
            let profile_bytes: i64 = tx
                .query_row(
                    "SELECT COALESCE(SUM(content_bytes), 0) FROM ai_messages",
                    [],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if u64::try_from(profile_bytes).map_err(storage_error)? > AI_PROFILE_CONTENT_BYTES_MAX {
                return Err(quota_err("ai_profile.content_bytes"));
            }
            let (pending_count, pending_bytes): (i64, i64) = tx
                .query_row(
                    "SELECT COUNT(*), COALESCE(SUM(arguments_bytes), 0)
                 FROM ai_tool_approvals WHERE status = 'pending'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(storage_error)?;
            let mut quota = load_quota(tx)?;
            quota.total_content_bytes = u64::try_from(profile_bytes).map_err(storage_error)?;
            quota.pending_approval_count = u32::try_from(pending_count).map_err(storage_error)?;
            quota.pending_approval_content_bytes =
                u64::try_from(pending_bytes).map_err(storage_error)?;
            save_quota(tx, &quota)?;
            Ok(ai_effect(
                EventType::AI_SESSION_CHANGED,
                ResourceRef::ai_session(seed.session_id),
                ("ai_response_rewrite", seed.kind.as_str().to_owned()),
            ))
        },
    )?;
    Ok(PreparedAiResponse {
        mutation,
        user_message: Some(get_ai_message(connection, request.user_message_id)?),
        assistant_message: get_ai_message(connection, request.assistant_message_id)?,
        run: get_ai_run_state(connection, request.run_id)?,
    })
}

/// Fail-closed startup/restore recovery for ephemeral AI runtime authority.
///
/// Running and awaiting-approval runs are cancelled together with any streaming
/// assistant placeholder; pending/approved approvals expire in the same transaction.
/// Valid consumed/dispatching pairs survive for bounded startup dispatch recovery.
/// This transaction emits no event or receipt.
pub(crate) fn expire_ai_runtime_state(
    connection: &Connection,
    now: Timestamp,
) -> Result<(), RepositoryError> {
    let tx = connection.unchecked_transaction().map_err(storage_error)?;
    validate_ai_approval_authority(&tx)?;
    tx.execute(
        "UPDATE ai_tool_approvals
         SET status = 'expired', updated_at = MAX(updated_at, ?1)
         WHERE status IN ('pending', 'approved')",
        [now.to_string()],
    )
    .map_err(storage_error)?;
    tx.execute(
        "UPDATE ai_messages
         SET status = 'cancelled', updated_at = MAX(updated_at, ?1)
         WHERE role = 'assistant' AND status = 'streaming'
           AND EXISTS (
               SELECT 1 FROM ai_run_state
               WHERE ai_run_state.assistant_message_id = ai_messages.id
                 AND ai_run_state.session_id = ai_messages.session_id
                 AND ai_run_state.turn_id = ai_messages.turn_id
                 AND ai_run_state.state IN ('running', 'awaiting_approval')
           )",
        [now.to_string()],
    )
    .map_err(storage_error)?;
    tx.execute(
        "UPDATE ai_sessions
         SET last_message_at = (
                 SELECT MAX(updated_at) FROM ai_messages
                 WHERE ai_messages.session_id = ai_sessions.id
             ),
             updated_at = MAX(updated_at, (
                 SELECT MAX(updated_at) FROM ai_messages
                 WHERE ai_messages.session_id = ai_sessions.id
             ))
         WHERE EXISTS (
             SELECT 1 FROM ai_messages
             JOIN ai_run_state
               ON ai_run_state.assistant_message_id = ai_messages.id
              AND ai_run_state.session_id = ai_messages.session_id
              AND ai_run_state.turn_id = ai_messages.turn_id
             WHERE ai_messages.session_id = ai_sessions.id
               AND ai_messages.role = 'assistant'
               AND ai_messages.status = 'cancelled'
               AND ai_run_state.state IN ('running', 'awaiting_approval')
         )",
        [],
    )
    .map_err(storage_error)?;
    tx.execute(
        "UPDATE ai_run_state
         SET state = 'cancelled', approval_id = NULL, updated_at = MAX(updated_at, ?1)
         WHERE state IN ('running', 'awaiting_approval')",
        [now.to_string()],
    )
    .map_err(storage_error)?;
    let mut quota = load_quota(&tx)?;
    recompute_pending_approval_quota(&tx, &mut quota)?;
    save_quota(&tx, &quota)?;
    tx.commit().map_err(storage_error)?;
    Ok(())
}

/// Validate daily metadata and rewrite tombstones before normal or restored use.
pub(crate) fn validate_ai_response_authority(
    connection: &Connection,
) -> Result<(), RepositoryError> {
    let oversized: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ai_response_invalidations WHERE
                 LENGTH(CAST(run_id AS BLOB)) > 64
                 OR LENGTH(CAST(session_id AS BLOB)) > 64
                 OR LENGTH(CAST(invalidating_operation_id AS BLOB)) > 64
                 OR LENGTH(CAST(expires_at AS BLOB)) > 64)
             OR EXISTS(SELECT 1 FROM ai_messages
                 WHERE json_type(content_json, '$.briefing_date') IS NOT NULL
                   AND LENGTH(CAST(content_json AS BLOB)) > ?1)",
            [i64::try_from(AI_MESSAGE_CONTENT_JSON_BYTES_MAX).map_err(storage_error)?],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if oversized {
        return Err(RepositoryError::Storage(
            "AI response invalidation exceeds bounds".to_owned(),
        ));
    }
    let mut messages = connection
        .prepare(
            "SELECT id, session_id, turn_id, role, status, content_json FROM ai_messages
             WHERE json_type(content_json, '$.briefing_date') IS NOT NULL",
        )
        .map_err(storage_error)?;
    let rows = messages
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(storage_error)?;
    for row in rows {
        let (id, session_id, turn_id, role, status, content_json) = row.map_err(storage_error)?;
        let message_id = AiMessageId::parse(&id).map_err(storage_error)?;
        let parsed_session = AiSessionId::parse(&session_id).map_err(storage_error)?;
        let parsed_turn = AiTurnId::parse(&turn_id).map_err(storage_error)?;
        let parsed_status = AiMessageStatus::parse(&status).map_err(storage_error)?;
        let content: AiMessageContent =
            serde_json::from_str(&content_json).map_err(storage_error)?;
        let date = content.briefing_date.ok_or_else(|| {
            RepositoryError::Storage("AI briefing metadata is invalid".to_owned())
        })?;
        let parsed_date = date.parse::<jiff::civil::Date>().map_err(storage_error)?;
        let run = get_ai_run_for_assistant(connection, message_id)?;
        let turn_message_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM ai_messages WHERE session_id = ?1 AND turn_id = ?2",
                params![&session_id, &turn_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let phase_matches = match parsed_status {
            AiMessageStatus::Pending => false,
            AiMessageStatus::Streaming => matches!(
                run.state,
                AiRunPhase::Running | AiRunPhase::AwaitingApproval | AiRunPhase::Dispatching
            ),
            AiMessageStatus::Completed => run.state == AiRunPhase::Completed,
            AiMessageStatus::Failed => run.state == AiRunPhase::Failed,
            AiMessageStatus::Cancelled => run.state == AiRunPhase::Cancelled,
        };
        if role != AiMessageRole::Assistant.as_str()
            || message_id.to_string() != id
            || parsed_session.to_string() != session_id
            || parsed_turn.to_string() != turn_id
            || parsed_date.to_string() != date
            || run.session_id != parsed_session
            || run.turn_id != parsed_turn
            || turn_message_count != 1
            || !phase_matches
        {
            return Err(RepositoryError::Storage(
                "AI briefing metadata is invalid".to_owned(),
            ));
        }
    }

    let mut invalidations = connection
        .prepare(
            "SELECT invalidation.run_id, invalidation.session_id,
                    invalidation.invalidating_operation_id, invalidation.expires_at,
                    receipt.request_json, receipt.expires_at,
                    EXISTS(SELECT 1 FROM ai_run_state run
                           WHERE run.run_id = invalidation.run_id)
             FROM ai_response_invalidations invalidation
             LEFT JOIN operation_receipts receipt
               ON receipt.operation_id = invalidation.invalidating_operation_id
             ORDER BY invalidation.run_id",
        )
        .map_err(storage_error)?;
    let rows = invalidations
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, bool>(6)?,
            ))
        })
        .map_err(storage_error)?;
    for row in rows {
        let (run_id, session_id, operation_id, expires_at, request_json, receipt_expiry, live_run) =
            row.map_err(storage_error)?;
        let parsed_run = AiRunId::parse(&run_id).map_err(storage_error)?;
        let parsed_session = AiSessionId::parse(&session_id).map_err(storage_error)?;
        let parsed_operation = OperationId::parse(&operation_id).map_err(storage_error)?;
        let parsed_expiry = expires_at.parse::<Timestamp>().map_err(storage_error)?;
        let request_json = request_json.ok_or_else(|| {
            RepositoryError::Storage("AI response invalidation receipt is missing".to_owned())
        })?;
        let receipt_expiry = receipt_expiry.ok_or_else(|| {
            RepositoryError::Storage("AI response invalidation receipt is missing".to_owned())
        })?;
        let ResponseInvalidationReceipt::RewriteAiResponse {
            kind: request_kind,
            session_id: request_session_id,
            target_message_id,
            message_sha256,
            focused_task_id,
        } = serde_json::from_str::<ResponseInvalidationReceipt>(&request_json)
            .map_err(storage_error)?;
        let kind = match request_kind.as_str() {
            "edit" => AiResponseRewriteKind::Edit,
            "retry" => AiResponseRewriteKind::Retry,
            "regenerate" => AiResponseRewriteKind::Regenerate,
            _ => {
                return Err(RepositoryError::Storage(
                    "AI response invalidation kind is invalid".to_owned(),
                ));
            }
        };
        let target = AiMessageId::parse(&target_message_id).map_err(storage_error)?;
        let focused = focused_task_id
            .as_deref()
            .map(junban_domain::TaskId::parse)
            .transpose()
            .map_err(storage_error)?;
        let hash_is_canonical = message_sha256.len() == 64
            && message_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        let canonical_request = canonical_json(&Req::RewriteAiResponse {
            kind: kind.as_str(),
            session_id: parsed_session.to_string(),
            target_message_id: target.to_string(),
            message_sha256,
            focused_task_id: focused.map(|id| id.to_string()),
        })?;
        if parsed_run.to_string() != run_id
            || parsed_session.to_string() != session_id
            || parsed_operation.to_string() != operation_id
            || parsed_expiry.to_string() != expires_at
            || receipt_expiry != expires_at
            || request_session_id != session_id
            || !hash_is_canonical
            || canonical_request != request_json
            || live_run
        {
            return Err(RepositoryError::Storage(
                "AI response invalidation is not canonical".to_owned(),
            ));
        }
    }
    Ok(())
}

/// Validate every durable approval row and its exact run/assistant authority edges.
///
/// This is shared by normal open, restore preflight, and dispatch listing so no
/// process-local authority is exposed from partially valid durable material.
pub(crate) fn validate_ai_approval_authority(
    connection: &Connection,
) -> Result<usize, RepositoryError> {
    let oversized: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ai_tool_approvals WHERE
                 LENGTH(CAST(id AS BLOB)) > 64
                 OR LENGTH(CAST(session_id AS BLOB)) > 64
                 OR LENGTH(CAST(turn_id AS BLOB)) > 64
                 OR LENGTH(CAST(run_id AS BLOB)) > 64
                 OR LENGTH(CAST(tool_name AS BLOB)) > ?1
                 OR LENGTH(CAST(arguments_json AS BLOB)) > ?2
                 OR LENGTH(CAST(action_hash AS BLOB)) > 64
                 OR LENGTH(CAST(status AS BLOB)) > 32
                 OR LENGTH(CAST(expires_at AS BLOB)) > 64
                 OR LENGTH(CAST(COALESCE(operation_id, '') AS BLOB)) > 64
                 OR LENGTH(CAST(created_at AS BLOB)) > 64
                 OR LENGTH(CAST(updated_at AS BLOB)) > 64)
             OR EXISTS(SELECT 1 FROM ai_messages WHERE
                 LENGTH(CAST(content_json AS BLOB)) > ?3)
             OR EXISTS(SELECT 1 FROM ai_run_state WHERE
                 LENGTH(CAST(run_id AS BLOB)) > 64
                 OR LENGTH(CAST(session_id AS BLOB)) > 64
                 OR LENGTH(CAST(turn_id AS BLOB)) > 64
                 OR LENGTH(CAST(assistant_message_id AS BLOB)) > 64
                 OR LENGTH(CAST(state AS BLOB)) > 32
                 OR LENGTH(CAST(COALESCE(approval_id, '') AS BLOB)) > 64
                 OR LENGTH(CAST(created_at AS BLOB)) > 64
                 OR LENGTH(CAST(updated_at AS BLOB)) > 64)",
            params![
                i64::try_from(junban_domain::AI_PROVIDER_ID_BYTES_MAX).map_err(storage_error)?,
                i64::try_from(junban_domain::AI_TOOL_ARGUMENTS_BYTES_MAX).map_err(storage_error)?,
                i64::try_from(junban_domain::AI_MESSAGE_CONTENT_JSON_BYTES_MAX)
                    .map_err(storage_error)?,
            ],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if oversized {
        return Err(RepositoryError::Storage(
            "AI approval authority exceeds a material bound".into(),
        ));
    }

    let approval_ids = {
        let mut statement = connection
            .prepare("SELECT id FROM ai_tool_approvals ORDER BY id")
            .map_err(storage_error)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?
    };
    for raw_id in &approval_ids {
        let approval_id = AiApprovalId::parse(raw_id).map_err(storage_error)?;
        if approval_id.to_string() != *raw_id {
            return Err(invalid_approval_authority());
        }
        let approval = load_validated_ai_approval(connection, approval_id)?;
        let approval_key = approval.id.to_string();
        let run = connection
            .query_row(
                "SELECT session_id, turn_id, generation, state, approval_id
                 FROM ai_run_state WHERE run_id = ?1",
                [approval.run_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?;
        let legal = match (approval.status, run) {
            (AiApprovalStatus::Rejected | AiApprovalStatus::Expired, None) => true,
            (AiApprovalStatus::Rejected | AiApprovalStatus::Expired, Some(run)) => {
                run.4.as_deref() != Some(approval_key.as_str())
            }
            (status, Some(run)) => {
                let phase = AiRunPhase::parse(&run.3).map_err(storage_error)?;
                let exact = run.0 == approval.session_id.to_string()
                    && run.1 == approval.turn_id.to_string()
                    && u64::try_from(run.2).ok() == Some(approval.generation);
                match status {
                    AiApprovalStatus::Pending | AiApprovalStatus::Approved => {
                        exact
                            && phase == AiRunPhase::AwaitingApproval
                            && run.4.as_deref() == Some(approval_key.as_str())
                    }
                    AiApprovalStatus::Consumed => {
                        exact
                            && ((phase == AiRunPhase::Dispatching
                                && run.4.as_deref() == Some(approval_key.as_str()))
                                || (phase.is_terminal()
                                    && run.4.as_deref().is_none_or(|bound| bound == approval_key)))
                    }
                    AiApprovalStatus::Rejected | AiApprovalStatus::Expired => unreachable!(),
                }
            }
            (_, None) => false,
        };
        if !legal {
            return Err(invalid_approval_authority());
        }
    }

    let run_ids = {
        let mut statement = connection
            .prepare("SELECT run_id FROM ai_run_state ORDER BY run_id")
            .map_err(storage_error)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?
    };
    let mut dispatching_count = 0usize;
    for raw_run_id in run_ids {
        let run_id = AiRunId::parse(&raw_run_id).map_err(storage_error)?;
        if run_id.to_string() != raw_run_id {
            return Err(invalid_approval_authority());
        }
        let row = connection
            .query_row(
                "SELECT session_id, turn_id, assistant_message_id, generation, state,
                        approval_id, created_at, updated_at
                 FROM ai_run_state WHERE run_id = ?1",
                [&raw_run_id],
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
            .map_err(storage_error)?;
        let session_id = AiSessionId::parse(&row.0).map_err(storage_error)?;
        let turn_id = AiTurnId::parse(&row.1).map_err(storage_error)?;
        let assistant_id = AiMessageId::parse(&row.2).map_err(storage_error)?;
        let generation = u64::try_from(row.3).map_err(storage_error)?;
        let phase = AiRunPhase::parse(&row.4).map_err(storage_error)?;
        let created_at: Timestamp = row.6.parse().map_err(storage_error)?;
        let updated_at: Timestamp = row.7.parse().map_err(storage_error)?;
        let expected_message_status = matches!(
            phase,
            AiRunPhase::Running | AiRunPhase::AwaitingApproval | AiRunPhase::Dispatching
        )
        .then_some(AiMessageStatus::Streaming.as_str());
        let exact_assistant: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ai_messages WHERE id = ?1
                   AND session_id = ?2 AND turn_id = ?3 AND role = 'assistant'
                   AND (?4 IS NULL OR status = ?4))",
                params![&row.2, &row.0, &row.1, expected_message_status],
                |message| message.get(0),
            )
            .map_err(storage_error)?;
        if session_id.to_string() != row.0
            || turn_id.to_string() != row.1
            || assistant_id.to_string() != row.2
            || created_at.to_string() != row.6
            || updated_at.to_string() != row.7
            || created_at > updated_at
            || !exact_assistant
        {
            return Err(invalid_approval_authority());
        }
        match (phase, row.5.as_deref()) {
            (AiRunPhase::Running, None) => {}
            (AiRunPhase::AwaitingApproval, Some(raw_approval)) => {
                let approval_id = AiApprovalId::parse(raw_approval).map_err(storage_error)?;
                let approval = load_validated_ai_approval(connection, approval_id)?;
                if approval.id.to_string() != raw_approval
                    || approval.session_id != session_id
                    || approval.turn_id != turn_id
                    || approval.run_id != run_id
                    || approval.generation != generation
                    || !matches!(
                        approval.status,
                        AiApprovalStatus::Pending | AiApprovalStatus::Approved
                    )
                {
                    return Err(invalid_approval_authority());
                }
            }
            (AiRunPhase::Dispatching, Some(raw_approval)) => {
                let approval_id = AiApprovalId::parse(raw_approval).map_err(storage_error)?;
                let approval = load_validated_ai_approval(connection, approval_id)?;
                if approval.id.to_string() != raw_approval
                    || approval.session_id != session_id
                    || approval.turn_id != turn_id
                    || approval.run_id != run_id
                    || approval.generation != generation
                    || approval.status != AiApprovalStatus::Consumed
                {
                    return Err(invalid_approval_authority());
                }
                dispatching_count += 1;
            }
            (phase, approval) if phase.is_terminal() => {
                if let Some(raw_approval) = approval {
                    let approval_id = AiApprovalId::parse(raw_approval).map_err(storage_error)?;
                    let approval = load_validated_ai_approval(connection, approval_id)?;
                    if approval.id.to_string() != raw_approval
                        || approval.session_id != session_id
                        || approval.turn_id != turn_id
                        || approval.run_id != run_id
                        || approval.generation != generation
                        || approval.status != AiApprovalStatus::Consumed
                    {
                        return Err(invalid_approval_authority());
                    }
                }
            }
            _ => return Err(invalid_approval_authority()),
        }
    }
    if dispatching_count > AI_DISPATCHING_APPROVAL_RECOVERY_MAX as usize {
        return Err(RepositoryError::Storage(
            "dispatching AI approval recovery bound is exceeded".into(),
        ));
    }
    validate_ai_tool_transcripts(connection, &approval_ids)?;
    Ok(dispatching_count)
}

#[derive(Clone, Copy)]
enum TranscriptApprovalState {
    Proposed(AiApprovalId),
    Approved(AiApprovalId),
    Rejected(AiApprovalId),
}

fn event_approval_id(event: &AiToolEvent) -> Result<AiApprovalId, RepositoryError> {
    let raw = event
        .payload
        .get("approval_id")
        .and_then(Value::as_str)
        .ok_or_else(invalid_approval_authority)?;
    let id = AiApprovalId::parse(raw).map_err(storage_error)?;
    if id.to_string() != raw {
        return Err(invalid_approval_authority());
    }
    Ok(id)
}

fn validate_ai_tool_transcripts(
    connection: &Connection,
    approval_ids: &[String],
) -> Result<(), RepositoryError> {
    let rows = {
        let mut statement = connection
            .prepare(
                "SELECT id, session_id, turn_id, content_json
                 FROM ai_messages ORDER BY session_id, sequence",
            )
            .map_err(storage_error)?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?
    };
    let mut seen_approvals = HashSet::new();
    let mut completed_approvals = HashSet::new();
    let mut approved_checkpoints = HashSet::new();
    for (message_id, session_id, turn_id, content_json) in rows {
        let message_id = AiMessageId::parse(&message_id).map_err(storage_error)?;
        let session_id = AiSessionId::parse(&session_id).map_err(storage_error)?;
        let turn_id = AiTurnId::parse(&turn_id).map_err(storage_error)?;
        let content: AiMessageContent =
            serde_json::from_str(&content_json).map_err(storage_error)?;
        content.validate().map_err(storage_error)?;
        let mut state = None;
        for event in &content.tool_events {
            match event.event_type {
                AiToolEventType::ToolProposed => {
                    if state.is_some() {
                        return Err(invalid_approval_authority());
                    }
                    let approval_id = event_approval_id(event)?;
                    let approval = load_validated_ai_approval(connection, approval_id)?;
                    let bound_assistant: bool = connection
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM ai_run_state
                             WHERE run_id = ?1 AND session_id = ?2 AND turn_id = ?3
                               AND assistant_message_id = ?4
                               AND (?6 = 'expired' OR generation = ?5))",
                            params![
                                approval.run_id.to_string(),
                                session_id.to_string(),
                                turn_id.to_string(),
                                message_id.to_string(),
                                i64::try_from(approval.generation).map_err(storage_error)?,
                                approval.status.as_str(),
                            ],
                            |row| row.get(0),
                        )
                        .map_err(storage_error)?;
                    if approval.session_id != session_id
                        || approval.turn_id != turn_id
                        || !bound_assistant
                        || event.payload != exact_proposal_payload(&approval)?
                        || !seen_approvals.insert(approval_id)
                    {
                        return Err(invalid_approval_authority());
                    }
                    state = Some(TranscriptApprovalState::Proposed(approval_id));
                }
                AiToolEventType::ToolApproved | AiToolEventType::ToolRejected => {
                    let approval_id = event_approval_id(event)?;
                    if !matches!(state, Some(TranscriptApprovalState::Proposed(id)) if id == approval_id)
                    {
                        return Err(invalid_approval_authority());
                    }
                    let approval = load_validated_ai_approval(connection, approval_id)?;
                    state = match event.event_type {
                        AiToolEventType::ToolApproved
                            if approval.status == AiApprovalStatus::Consumed =>
                        {
                            Some(TranscriptApprovalState::Approved(approval_id))
                        }
                        AiToolEventType::ToolRejected
                            if approval.status == AiApprovalStatus::Rejected =>
                        {
                            Some(TranscriptApprovalState::Rejected(approval_id))
                        }
                        _ => return Err(invalid_approval_authority()),
                    };
                }
                AiToolEventType::ToolResult => match state {
                    Some(TranscriptApprovalState::Approved(approval_id))
                    | Some(TranscriptApprovalState::Rejected(approval_id)) => {
                        let approval = load_validated_ai_approval(connection, approval_id)?;
                        if event.payload.get("tool").and_then(Value::as_str)
                            != Some(approval.tool_name.as_str())
                            || approval
                                .operation_id
                                .as_deref()
                                .is_some_and(|private_root| {
                                    event.payload.get("operation_id").and_then(Value::as_str)
                                        == Some(private_root)
                                })
                            || !completed_approvals.insert(approval_id)
                        {
                            return Err(invalid_approval_authority());
                        }
                        state = None;
                    }
                    Some(TranscriptApprovalState::Proposed(_)) => {
                        return Err(invalid_approval_authority());
                    }
                    None => {}
                },
            }
        }
        match state {
            Some(TranscriptApprovalState::Proposed(approval_id)) => {
                let approval = load_validated_ai_approval(connection, approval_id)?;
                if !matches!(
                    approval.status,
                    AiApprovalStatus::Pending
                        | AiApprovalStatus::Approved
                        | AiApprovalStatus::Expired
                ) {
                    return Err(invalid_approval_authority());
                }
            }
            Some(TranscriptApprovalState::Approved(approval_id)) => {
                let approval = load_validated_ai_approval(connection, approval_id)?;
                let run = get_ai_run_state(connection, approval.run_id)?;
                if approval.status != AiApprovalStatus::Consumed
                    || run.state != AiRunPhase::Dispatching
                    || run.approval_id != Some(approval_id)
                    || !approved_checkpoints.insert(approval_id)
                {
                    return Err(invalid_approval_authority());
                }
            }
            Some(TranscriptApprovalState::Rejected(_)) => {
                return Err(invalid_approval_authority());
            }
            None => {}
        }
        if let Some(result_json) = content.tool_result_json.as_deref() {
            let result_event = content
                .tool_events
                .last()
                .filter(|event| event.event_type == AiToolEventType::ToolResult)
                .ok_or_else(invalid_approval_authority)?;
            if serde_json::to_string(&result_event.payload).map_err(storage_error)? != result_json {
                return Err(invalid_approval_authority());
            }
        }
    }
    if seen_approvals.len() != approval_ids.len()
        || approval_ids.iter().any(|raw| {
            AiApprovalId::parse(raw).map_or(true, |approval_id| {
                if !seen_approvals.contains(&approval_id) {
                    return true;
                }
                let approval = match load_validated_ai_approval(connection, approval_id) {
                    Ok(approval) => approval,
                    Err(_) => return true,
                };
                match approval.status {
                    AiApprovalStatus::Rejected => !completed_approvals.contains(&approval_id),
                    AiApprovalStatus::Consumed => {
                        let run = match get_ai_run_state(connection, approval.run_id) {
                            Ok(run) => run,
                            Err(_) => return true,
                        };
                        if run.state == AiRunPhase::Dispatching {
                            !approved_checkpoints.contains(&approval_id)
                        } else {
                            !run.state.is_terminal() || !completed_approvals.contains(&approval_id)
                        }
                    }
                    AiApprovalStatus::Pending
                    | AiApprovalStatus::Approved
                    | AiApprovalStatus::Expired => false,
                }
            })
        })
    {
        return Err(invalid_approval_authority());
    }
    Ok(())
}

fn invalid_approval_authority() -> RepositoryError {
    RepositoryError::Storage("AI approval/run authority is inconsistent".into())
}

/// Recompute session/profile AI byte counters from actual durable UTF-8 lengths.
pub(crate) fn recompute_ai_quotas(connection: &Connection) -> Result<(), RepositoryError> {
    let tx = connection.unchecked_transaction().map_err(storage_error)?;
    ensure_quota_row(&tx)?;
    tx.execute(
        "UPDATE ai_messages
         SET content_bytes = LENGTH(CAST(content_json AS BLOB))
         WHERE content_bytes != LENGTH(CAST(content_json AS BLOB))",
        [],
    )
    .map_err(storage_error)?;
    tx.execute(
        "UPDATE ai_memories
         SET content_bytes = LENGTH(CAST(content AS BLOB))
         WHERE content_bytes != LENGTH(CAST(content AS BLOB))",
        [],
    )
    .map_err(storage_error)?;
    tx.execute(
        "UPDATE ai_tool_approvals
         SET arguments_bytes = LENGTH(CAST(arguments_json AS BLOB))
         WHERE arguments_bytes != LENGTH(CAST(arguments_json AS BLOB))",
        [],
    )
    .map_err(storage_error)?;

    // Per-session counters.
    let mut statement = tx
        .prepare(
            "SELECT session_id, COUNT(*),
                    COALESCE(SUM(LENGTH(CAST(content_json AS BLOB))), 0)
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
            "SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) FROM ai_memories",
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
            "SELECT COALESCE(SUM(LENGTH(CAST(arguments_json AS BLOB))), 0)
             FROM ai_tool_approvals WHERE status = 'pending'",
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

fn canonicalize_json(
    value: String,
    field: &'static str,
    max: usize,
) -> Result<String, RepositoryError> {
    let parsed: serde_json::Value = serde_json::from_str(&value).map_err(|_| {
        validation(junban_domain::ValidationError::Invalid {
            field,
            reason: "must be valid JSON",
        })
    })?;
    let canonical = serde_json::to_string(&parsed).map_err(storage_error)?;
    if canonical.len() > max {
        return Err(validation(junban_domain::ValidationError::TooLong {
            field,
            max,
        }));
    }
    Ok(canonical)
}

fn canonicalize_json_object(
    value: String,
    field: &'static str,
    max: usize,
) -> Result<String, RepositoryError> {
    let canonical = canonicalize_json(value, field, max)?;
    let parsed: serde_json::Value = serde_json::from_str(&canonical).map_err(storage_error)?;
    if !parsed.is_object() {
        return Err(validation(junban_domain::ValidationError::Invalid {
            field,
            reason: "must be a JSON object",
        }));
    }
    Ok(canonical)
}

fn canonicalize_optional_json(
    value: &mut Option<String>,
    field: &'static str,
    max: usize,
) -> Result<(), RepositoryError> {
    if let Some(raw) = value.take() {
        *value = Some(canonicalize_json(raw, field, max)?);
    }
    Ok(())
}

fn expire_bound_run_approval(
    tx: &rusqlite::Connection,
    approval_id: &str,
    run_id: AiRunId,
    session_id: AiSessionId,
    turn_id: AiTurnId,
    generation: i64,
    now: Timestamp,
) -> Result<(), RepositoryError> {
    let approval = tx
        .query_row(
            "SELECT status, arguments_bytes
             FROM ai_tool_approvals
             WHERE id = ?1 AND run_id = ?2 AND session_id = ?3
               AND turn_id = ?4 AND generation = ?5",
            params![
                approval_id,
                run_id.to_string(),
                session_id.to_string(),
                turn_id.to_string(),
                generation,
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(storage_error)?
        .ok_or(RepositoryError::Conflict)?;
    let previous = AiApprovalStatus::parse(&approval.0).map_err(storage_error)?;
    if !matches!(
        previous,
        AiApprovalStatus::Pending | AiApprovalStatus::Approved
    ) {
        return Err(RepositoryError::Conflict);
    }
    let updated = tx
        .execute(
            "UPDATE ai_tool_approvals
             SET status = 'expired', updated_at = ?1
             WHERE id = ?2 AND run_id = ?3 AND session_id = ?4
               AND turn_id = ?5 AND generation = ?6 AND status = ?7",
            params![
                now.to_string(),
                approval_id,
                run_id.to_string(),
                session_id.to_string(),
                turn_id.to_string(),
                generation,
                previous.as_str(),
            ],
        )
        .map_err(storage_error)?;
    if updated != 1 {
        return Err(RepositoryError::Conflict);
    }
    if previous.is_pending() {
        let mut quota = load_quota(tx)?;
        quota.pending_approval_count = quota
            .pending_approval_count
            .checked_sub(1)
            .ok_or_else(|| RepositoryError::Storage("invalid pending approval quota".into()))?;
        quota.pending_approval_content_bytes = quota
            .pending_approval_content_bytes
            .checked_sub(u64::try_from(approval.1).map_err(storage_error)?)
            .ok_or_else(|| RepositoryError::Storage("invalid pending approval quota".into()))?;
        save_quota(tx, &quota)?;
    }
    Ok(())
}

fn legal_run_transition(from: AiRunPhase, to: AiRunPhase) -> bool {
    matches!(
        (from, to),
        (AiRunPhase::Running, AiRunPhase::AwaitingApproval)
            | (AiRunPhase::Running, AiRunPhase::Completed)
            | (AiRunPhase::Running, AiRunPhase::Failed)
            | (AiRunPhase::Running, AiRunPhase::Cancelled)
            | (AiRunPhase::AwaitingApproval, AiRunPhase::Dispatching)
            | (AiRunPhase::AwaitingApproval, AiRunPhase::Failed)
            | (AiRunPhase::AwaitingApproval, AiRunPhase::Cancelled)
            | (AiRunPhase::Dispatching, AiRunPhase::Completed)
            | (AiRunPhase::Dispatching, AiRunPhase::Failed)
            | (AiRunPhase::Dispatching, AiRunPhase::Cancelled)
    )
}

fn validate_run_approval_binding(
    tx: &rusqlite::Connection,
    run_id: AiRunId,
    session_id: AiSessionId,
    turn_id: AiTurnId,
    generation: i64,
    phase: AiRunPhase,
    approval_id: Option<&str>,
) -> Result<(), RepositoryError> {
    if phase == AiRunPhase::Running && approval_id.is_some() {
        return Err(RepositoryError::Conflict);
    }
    if matches!(
        phase,
        AiRunPhase::AwaitingApproval | AiRunPhase::Dispatching
    ) && approval_id.is_none()
    {
        return Err(RepositoryError::Conflict);
    }
    let Some(approval_id) = approval_id else {
        return Ok(());
    };
    let approval = tx
        .query_row(
            "SELECT session_id, turn_id, run_id, generation, status, operation_id
             FROM ai_tool_approvals WHERE id = ?1",
            [approval_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .ok_or(RepositoryError::Conflict)?;
    let status = AiApprovalStatus::parse(&approval.4).map_err(storage_error)?;
    if approval.0 != session_id.to_string()
        || approval.1 != turn_id.to_string()
        || approval.2 != run_id.to_string()
        || approval.3 != generation
        || (phase == AiRunPhase::AwaitingApproval
            && !matches!(
                status,
                AiApprovalStatus::Pending | AiApprovalStatus::Approved
            ))
        || (phase == AiRunPhase::Dispatching
            && (status != AiApprovalStatus::Consumed || approval.5.is_none()))
        || (phase.is_terminal() && status != AiApprovalStatus::Consumed)
    {
        return Err(RepositoryError::Conflict);
    }
    if let Some(operation_id) = approval.5 {
        OperationId::parse(&operation_id).map_err(storage_error)?;
    }
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
    tx: &rusqlite::Connection,
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
    tx: &rusqlite::Connection,
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

fn load_validated_ai_approval(
    connection: &Connection,
    approval_id: AiApprovalId,
) -> Result<AiToolApproval, RepositoryError> {
    let row = connection
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
        .ok_or(RepositoryError::NotFound)?;
    let id = AiApprovalId::parse(&row.0).map_err(storage_error)?;
    let session_id = AiSessionId::parse(&row.1).map_err(storage_error)?;
    let turn_id = AiTurnId::parse(&row.2).map_err(storage_error)?;
    let run_id = AiRunId::parse(&row.3).map_err(storage_error)?;
    let generation = u64::try_from(row.4).map_err(storage_error)?;
    let status = AiApprovalStatus::parse(&row.9).map_err(storage_error)?;
    let expires_at: Timestamp = row.10.parse().map_err(storage_error)?;
    let created_at: Timestamp = row.12.parse().map_err(storage_error)?;
    let updated_at: Timestamp = row.13.parse().map_err(storage_error)?;
    validate_ai_tool_name(&row.5).map_err(storage_error)?;
    let expected_hash = ai_approval_action_hash(&row.5, &row.6).map_err(storage_error)?;
    let operation_id = row
        .11
        .as_deref()
        .map(|raw| {
            let parsed = OperationId::parse(raw).map_err(storage_error)?;
            if parsed.to_string() != raw {
                return Err(invalid_approval_authority());
            }
            Ok(raw.to_owned())
        })
        .transpose()?;
    if id != approval_id
        || id.to_string() != row.0
        || session_id.to_string() != row.1
        || turn_id.to_string() != row.2
        || run_id.to_string() != row.3
        || usize::try_from(row.7).ok() != Some(row.6.len())
        || expected_hash != row.8
        || expires_at.to_string() != row.10
        || created_at.to_string() != row.12
        || updated_at.to_string() != row.13
        || created_at > updated_at
        || expires_at != created_at + AI_APPROVAL_LIFETIME_SECS.seconds()
        || (status == AiApprovalStatus::Consumed) != operation_id.is_some()
    {
        return Err(invalid_approval_authority());
    }
    Ok(AiToolApproval {
        id,
        session_id,
        turn_id,
        run_id,
        generation,
        tool_name: row.5,
        arguments_json: row.6,
        arguments_bytes: u64::try_from(row.7).map_err(storage_error)?,
        action_hash: row.8,
        status,
        expires_at,
        operation_id,
        created_at,
        updated_at,
    })
}

/// Load and fully validate a tool approval by id.
#[allow(dead_code)]
pub(crate) fn get_ai_approval(
    connection: &Connection,
    approval_id: AiApprovalId,
) -> Result<AiToolApproval, RepositoryError> {
    load_validated_ai_approval(connection, approval_id)
}

/// Exact consumed approvals whose bound run remains durably dispatching.
pub(crate) fn list_dispatching_ai_approvals(
    connection: &Connection,
) -> Result<Vec<AiToolApproval>, RepositoryError> {
    let validated_count = validate_ai_approval_authority(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT a.id
             FROM ai_run_state AS r INDEXED BY idx_ai_run_state_state
             JOIN ai_tool_approvals AS a ON a.id = r.approval_id
             WHERE r.state = 'dispatching' AND a.status = 'consumed'
               AND a.session_id = r.session_id AND a.turn_id = r.turn_id
               AND a.run_id = r.run_id AND a.generation = r.generation
               AND a.operation_id IS NOT NULL
             ORDER BY r.run_id",
        )
        .map_err(storage_error)?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    assert_eq!(
        ids.len(),
        validated_count,
        "validated dispatch pair count changed"
    );
    ids.into_iter()
        .map(|id| {
            let id = AiApprovalId::parse(&id).map_err(storage_error)?;
            load_validated_ai_approval(connection, id)
        })
        .collect()
}

/// Recent-first session page using keyset pagination on `(updated_at DESC, id ASC)`.
pub(crate) fn list_ai_sessions(
    connection: &Connection,
    cursor: Option<AiSessionCursor>,
    limit: u32,
) -> Result<AiSessionListPage, RepositoryError> {
    let limit = limit.clamp(1, AI_SESSION_PAGE_MAX);
    let fetch = i64::from(limit) + 1;
    let mut sql = String::from(
        "SELECT id, title, status, message_count, content_bytes,
                created_at, updated_at, last_message_at
         FROM ai_sessions",
    );
    let mut binds: Vec<String> = Vec::new();
    if let Some(cursor) = &cursor {
        sql.push_str(" WHERE updated_at < ?1 OR (updated_at = ?2 AND id > ?3)");
        binds.push(cursor.updated_at.to_string());
        binds.push(cursor.updated_at.to_string());
        binds.push(cursor.session_id.to_string());
    }
    sql.push_str(" ORDER BY updated_at DESC, id ASC LIMIT ");
    sql.push_str(&fetch.to_string());

    let mut statement = connection.prepare(&sql).map_err(storage_error)?;
    let rows = if binds.is_empty() {
        statement
            .query_map([], map_session_row)
            .map_err(storage_error)?
    } else {
        statement
            .query_map(rusqlite::params_from_iter(binds.iter()), map_session_row)
            .map_err(storage_error)?
    };

    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row.map_err(storage_error).and_then(build_session)?);
    }
    let next_cursor = if sessions.len() as u32 > limit {
        sessions.truncate(limit as usize);
        sessions.last().map(|session| AiSessionCursor {
            updated_at: session.updated_at,
            session_id: session.id,
        })
    } else {
        None
    };
    Ok(AiSessionListPage {
        sessions,
        next_cursor,
    })
}

/// Load one explicit memory by id.
pub(crate) fn get_ai_memory(
    connection: &Connection,
    memory_id: AiMemoryId,
) -> Result<AiMemory, RepositoryError> {
    connection
        .query_row(
            "SELECT id, content, content_bytes, created_at, updated_at
             FROM ai_memories WHERE id = ?1",
            [memory_id.to_string()],
            map_memory_row,
        )
        .optional()
        .map_err(storage_error)?
        .map(build_memory)
        .transpose()?
        .ok_or(RepositoryError::NotFound)
}

/// Recent-first memory page using keyset pagination on `(updated_at DESC, id ASC)`.
pub(crate) fn list_ai_memories(
    connection: &Connection,
    cursor: Option<AiMemoryCursor>,
    limit: u32,
) -> Result<AiMemoryListPage, RepositoryError> {
    let limit = limit.clamp(1, AI_MEMORY_PAGE_MAX);
    let fetch = i64::from(limit) + 1;
    let mut sql =
        String::from("SELECT id, content, content_bytes, created_at, updated_at FROM ai_memories");
    let mut binds: Vec<String> = Vec::new();
    if let Some(cursor) = &cursor {
        sql.push_str(" WHERE updated_at < ?1 OR (updated_at = ?2 AND id > ?3)");
        binds.push(cursor.updated_at.to_string());
        binds.push(cursor.updated_at.to_string());
        binds.push(cursor.memory_id.to_string());
    }
    sql.push_str(" ORDER BY updated_at DESC, id ASC LIMIT ");
    sql.push_str(&fetch.to_string());

    let mut statement = connection.prepare(&sql).map_err(storage_error)?;
    let rows = if binds.is_empty() {
        statement
            .query_map([], map_memory_row)
            .map_err(storage_error)?
    } else {
        statement
            .query_map(rusqlite::params_from_iter(binds.iter()), map_memory_row)
            .map_err(storage_error)?
    };

    let mut memories = Vec::new();
    for row in rows {
        memories.push(row.map_err(storage_error).and_then(build_memory)?);
    }
    let next_cursor = if memories.len() as u32 > limit {
        memories.truncate(limit as usize);
        memories.last().map(|memory| AiMemoryCursor {
            updated_at: memory.updated_at,
            memory_id: memory.id,
        })
    } else {
        None
    };
    Ok(AiMemoryListPage {
        memories,
        next_cursor,
    })
}

/// Bounded context selection: session-linked memories first, then recent others.
///
/// Order within each group is `updated_at DESC, id ASC`. Duplicates are excluded.
/// The hard ceiling is [`AI_CONTEXT_MEMORIES_MAX`].
pub(crate) fn select_ai_memories_for_context(
    connection: &Connection,
    session_id: Option<AiSessionId>,
    limit: u32,
) -> Result<Vec<AiMemory>, RepositoryError> {
    let limit = limit.clamp(1, AI_CONTEXT_MEMORIES_MAX) as usize;
    let mut out = Vec::with_capacity(limit);
    let mut seen = HashSet::new();

    if let Some(session_id) = session_id {
        let mut statement = connection
            .prepare(
                "SELECT m.id, m.content, m.content_bytes, m.created_at, m.updated_at
                 FROM ai_session_memories link
                 INNER JOIN ai_memories m ON m.id = link.memory_id
                 WHERE link.session_id = ?1
                 ORDER BY m.updated_at DESC, m.id ASC
                 LIMIT ?2",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map(
                params![
                    session_id.to_string(),
                    i64::try_from(limit).map_err(storage_error)?
                ],
                map_memory_row,
            )
            .map_err(storage_error)?;
        for row in rows {
            let memory = row.map_err(storage_error).and_then(build_memory)?;
            if seen.insert(memory.id) {
                out.push(memory);
                if out.len() >= limit {
                    return Ok(out);
                }
            }
        }
    }

    if out.len() >= limit {
        return Ok(out);
    }

    // At most `limit` linked ids are already selected, so a recent page of `limit`
    // rows always yields enough unseen memories to fill the remainder.
    let fetch = i64::try_from(limit).map_err(storage_error)?;
    let mut statement = connection
        .prepare(
            "SELECT id, content, content_bytes, created_at, updated_at
             FROM ai_memories
             ORDER BY updated_at DESC, id ASC
             LIMIT ?1",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([fetch], map_memory_row)
        .map_err(storage_error)?;
    for row in rows {
        let memory = row.map_err(storage_error).and_then(build_memory)?;
        if seen.insert(memory.id) {
            out.push(memory);
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
}

type SessionRow = (
    String,
    String,
    String,
    i64,
    i64,
    String,
    String,
    Option<String>,
);

fn map_session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

fn build_session(row: SessionRow) -> Result<AiSession, RepositoryError> {
    let (id, title, status, message_count, content_bytes, created_at, updated_at, last) = row;
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
}

type MemoryRow = (String, String, i64, String, String);

fn map_memory_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

fn build_memory(row: MemoryRow) -> Result<AiMemory, RepositoryError> {
    let (id, content, content_bytes, created_at, updated_at) = row;
    Ok(AiMemory {
        id: AiMemoryId::parse(&id).map_err(storage_error)?,
        content,
        content_bytes: u64::try_from(content_bytes).map_err(storage_error)?,
        created_at: created_at.parse().map_err(storage_error)?,
        updated_at: updated_at.parse().map_err(storage_error)?,
    })
}
