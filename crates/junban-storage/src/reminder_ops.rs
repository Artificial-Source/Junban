//! Reminder occurrence sync, fenced delivery lease, claim, and settlement.
//!
//! User schedule mutations reuse `Task.remind_at` and produce normal
//! revision/event/receipt commits. Lease/claim/settle are control-plane only:
//! short SQLite transactions with no global revision, activity, SSE event, or
//! undo receipt.
//!
//! Durable ack is idempotent for `(task_id, remind_at, channel)`. External
//! browser/OS presentation remains at-least-once across the accept-before-ack
//! window. Expired claims are never auto-retried; an explicit owner-lost sweep
//! returns them to pending with bounded backoff under the new fence term.

use jiff::{Timestamp, ToSpan};
use junban_app::{
    AffectedIds, CommittedMutation, EventType, RepositoryError, ResourceRef, ResourceSnapshot,
    ResyncScope, TaskPatch,
};
use junban_domain::{
    ClaimedReminder, OperationId, ReminderChannel, ReminderDeliveryLease, ReminderFailureCode,
    ReminderFenceTerm, ReminderOccurrence, ReminderOccurrenceState, Task, TaskActivityAction,
    TaskId, TaskStatus, reminder_failure_backoff, validate_owner_lost_mark_limit,
    validate_reminder_claim_limit, validate_reminder_lease_secs,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Serialize;

use crate::helpers::{apply_patch, diff_task_fields, validation};
use crate::ops_types::{Inverse, PostImage, post_from_tasks, undo_pair};
use crate::rows::{
    field_activity, load_task, parse_sql, storage_error, task_exists, update_task_row,
};
use crate::tx::{MutationEffect, canonical_json, mutate};

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum ReminderUserReq {
    RescheduleReminder { task_id: String, remind_at: String },
    DismissReminder { task_id: String },
}

// ---------------------------------------------------------------------------
// Occurrence row helpers (shared with task lifecycle mutations)
// ---------------------------------------------------------------------------

pub(crate) fn load_reminder_occurrence(
    tx: &Transaction<'_>,
    task_id: TaskId,
    remind_at: Timestamp,
) -> Result<Option<ReminderOccurrence>, RepositoryError> {
    tx.query_row(
        "SELECT task_id, remind_at, state, claim_term, claim_expires_at, attempts,
                next_attempt_at, terminal_channel, terminal_error_code, created_at, updated_at
         FROM reminder_occurrences
         WHERE task_id = ?1 AND remind_at = ?2",
        params![task_id.to_string(), remind_at.to_string()],
        map_occurrence_row,
    )
    .optional()
    .map_err(storage_error)
}

fn map_occurrence_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReminderOccurrence> {
    let task_id = parse_sql(row.get::<_, String>(0)?, TaskId::parse)?;
    let remind_at = parse_sql(row.get::<_, String>(1)?, |value| {
        value
            .parse::<Timestamp>()
            .map_err(|_| junban_domain::ValidationError::InvalidFormat {
                field: "remind_at",
                expected: "RFC3339 timestamp",
            })
    })?;
    let state = parse_sql(row.get::<_, String>(2)?, ReminderOccurrenceState::parse)?;
    let claim_term = match row.get::<_, Option<String>>(3)? {
        Some(value) => Some(parse_sql(value, ReminderFenceTerm::parse)?),
        None => None,
    };
    let claim_expires_at = parse_optional_timestamp(row.get(4)?)?;
    let attempts = u32::try_from(row.get::<_, i64>(5)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            5,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })?;
    let next_attempt_at = parse_optional_timestamp(row.get(6)?)?;
    let terminal_channel = match row.get::<_, Option<String>>(7)? {
        Some(value) => Some(parse_sql(value, ReminderChannel::parse)?),
        None => None,
    };
    let terminal_error_code = match row.get::<_, Option<String>>(8)? {
        Some(value) => Some(parse_sql(value, ReminderFailureCode::parse)?),
        None => None,
    };
    let created_at = parse_sql(row.get::<_, String>(9)?, |value| {
        value
            .parse::<Timestamp>()
            .map_err(|_| junban_domain::ValidationError::InvalidFormat {
                field: "created_at",
                expected: "RFC3339 timestamp",
            })
    })?;
    let updated_at = parse_sql(row.get::<_, String>(10)?, |value| {
        value
            .parse::<Timestamp>()
            .map_err(|_| junban_domain::ValidationError::InvalidFormat {
                field: "updated_at",
                expected: "RFC3339 timestamp",
            })
    })?;
    Ok(ReminderOccurrence {
        task_id,
        remind_at,
        state,
        claim_term,
        claim_expires_at,
        attempts,
        next_attempt_at,
        terminal_channel,
        terminal_error_code,
        created_at,
        updated_at,
    })
}

fn parse_optional_timestamp(value: Option<String>) -> rusqlite::Result<Option<Timestamp>> {
    match value {
        Some(raw) => Ok(Some(parse_sql(raw, |value| {
            value
                .parse::<Timestamp>()
                .map_err(|_| junban_domain::ValidationError::InvalidFormat {
                    field: "timestamp",
                    expected: "RFC3339 timestamp",
                })
        })?)),
        None => Ok(None),
    }
}

pub(crate) fn load_reminders_for_tasks(
    tx: &Transaction<'_>,
    task_ids: &[TaskId],
) -> Result<Vec<ReminderOccurrence>, RepositoryError> {
    if task_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for task_id in task_ids {
        let mut statement = tx
            .prepare(
                "SELECT task_id, remind_at, state, claim_term, claim_expires_at, attempts,
                        next_attempt_at, terminal_channel, terminal_error_code, created_at, updated_at
                 FROM reminder_occurrences
                 WHERE task_id = ?1
                 ORDER BY remind_at, task_id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map(params![task_id.to_string()], map_occurrence_row)
            .map_err(storage_error)?;
        for row in rows {
            out.push(row.map_err(storage_error)?);
        }
    }
    out.sort_by(|left, right| {
        left.remind_at
            .cmp(&right.remind_at)
            .then_with(|| left.task_id.as_uuid().cmp(&right.task_id.as_uuid()))
    });
    Ok(out)
}

pub(crate) fn upsert_reminder_occurrence(
    tx: &Transaction<'_>,
    occurrence: &ReminderOccurrence,
) -> Result<(), RepositoryError> {
    tx.execute(
        "INSERT INTO reminder_occurrences(
            task_id, remind_at, state, claim_term, claim_expires_at, attempts,
            next_attempt_at, terminal_channel, terminal_error_code, created_at, updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(task_id, remind_at) DO UPDATE SET
            state = excluded.state,
            claim_term = excluded.claim_term,
            claim_expires_at = excluded.claim_expires_at,
            attempts = excluded.attempts,
            next_attempt_at = excluded.next_attempt_at,
            terminal_channel = excluded.terminal_channel,
            terminal_error_code = excluded.terminal_error_code,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at",
        params![
            occurrence.task_id.to_string(),
            occurrence.remind_at.to_string(),
            occurrence.state.as_str(),
            occurrence
                .claim_term
                .as_ref()
                .map(ReminderFenceTerm::as_str),
            occurrence.claim_expires_at.map(|value| value.to_string()),
            i64::from(occurrence.attempts),
            occurrence.next_attempt_at.map(|value| value.to_string()),
            occurrence.terminal_channel.map(ReminderChannel::as_str),
            occurrence
                .terminal_error_code
                .map(ReminderFailureCode::as_str),
            occurrence.created_at.to_string(),
            occurrence.updated_at.to_string(),
        ],
    )
    .map_err(storage_error)?;
    Ok(())
}

pub(crate) fn delete_reminders_for_tasks(
    tx: &Transaction<'_>,
    task_ids: &[TaskId],
) -> Result<(), RepositoryError> {
    for task_id in task_ids {
        tx.execute(
            "DELETE FROM reminder_occurrences WHERE task_id = ?1",
            params![task_id.to_string()],
        )
        .map_err(storage_error)?;
    }
    Ok(())
}

/// Replace all occurrence rows for the given tasks with the provided snapshot.
pub(crate) fn replace_reminders_for_tasks(
    tx: &Transaction<'_>,
    task_ids: &[TaskId],
    reminders: &[ReminderOccurrence],
) -> Result<(), RepositoryError> {
    delete_reminders_for_tasks(tx, task_ids)?;
    for occurrence in reminders {
        if !task_ids.contains(&occurrence.task_id) {
            return Err(RepositoryError::Storage(
                "reminder snapshot task_id outside restore set".into(),
            ));
        }
        upsert_reminder_occurrence(tx, occurrence)?;
    }
    Ok(())
}

/// Cancel still-pending occurrences so they cannot be claimed for delivery.
pub(crate) fn cancel_pending_occurrences(
    tx: &Transaction<'_>,
    task_id: TaskId,
    now: Timestamp,
) -> Result<(), RepositoryError> {
    tx.execute(
        "UPDATE reminder_occurrences
         SET state = 'cancelled',
             claim_term = NULL,
             claim_expires_at = NULL,
             next_attempt_at = NULL,
             updated_at = ?1
         WHERE task_id = ?2 AND state = 'pending'",
        params![now.to_string(), task_id.to_string()],
    )
    .map_err(storage_error)?;
    Ok(())
}

/// Insert or revive a pending occurrence for the current schedule intent.
///
/// Claimed/delivered/failed rows for the same instant are left alone so terminal
/// ownership cannot be overwritten by an ordinary schedule write.
pub(crate) fn ensure_pending_occurrence(
    tx: &Transaction<'_>,
    task_id: TaskId,
    remind_at: Timestamp,
    now: Timestamp,
) -> Result<(), RepositoryError> {
    match load_reminder_occurrence(tx, task_id, remind_at)? {
        Some(existing) => match existing.state {
            ReminderOccurrenceState::Pending => Ok(()),
            ReminderOccurrenceState::Cancelled => {
                let mut revived = existing;
                revived.state = ReminderOccurrenceState::Pending;
                revived.claim_term = None;
                revived.claim_expires_at = None;
                revived.next_attempt_at = None;
                revived.terminal_channel = None;
                revived.terminal_error_code = None;
                revived.updated_at = now;
                upsert_reminder_occurrence(tx, &revived)
            }
            ReminderOccurrenceState::Claimed
            | ReminderOccurrenceState::Delivered
            | ReminderOccurrenceState::Failed => Ok(()),
        },
        None => upsert_reminder_occurrence(
            tx,
            &ReminderOccurrence {
                task_id,
                remind_at,
                state: ReminderOccurrenceState::Pending,
                claim_term: None,
                claim_expires_at: None,
                attempts: 0,
                next_attempt_at: None,
                terminal_channel: None,
                terminal_error_code: None,
                created_at: now,
                updated_at: now,
            },
        ),
    }
}

/// Reconcile occurrence rows with the task's current user-facing schedule.
///
/// Terminal tasks cancel pending delivery. Pending tasks keep at most one
/// pending intent for the active `remind_at`, without clobbering claimed or
/// terminal ownership of the same instant.
pub(crate) fn sync_task_reminder_intent(
    tx: &Transaction<'_>,
    task: &Task,
    now: Timestamp,
) -> Result<(), RepositoryError> {
    match task.status {
        TaskStatus::Completed | TaskStatus::Cancelled => {
            cancel_pending_occurrences(tx, task.id, now)
        }
        TaskStatus::Pending => {
            // Drop other pending instants first so a reschedule cannot leave two live intents.
            if let Some(remind_at) = task.remind_at {
                tx.execute(
                    "UPDATE reminder_occurrences
                     SET state = 'cancelled',
                         claim_term = NULL,
                         claim_expires_at = NULL,
                         next_attempt_at = NULL,
                         updated_at = ?1
                     WHERE task_id = ?2
                       AND state = 'pending'
                       AND remind_at != ?3",
                    params![now.to_string(), task.id.to_string(), remind_at.to_string()],
                )
                .map_err(storage_error)?;
                ensure_pending_occurrence(tx, task.id, remind_at, now)
            } else {
                cancel_pending_occurrences(tx, task.id, now)
            }
        }
    }
}

pub(crate) fn reminders_into_post(
    post: &mut PostImage,
    reminders: impl IntoIterator<Item = ReminderOccurrence>,
) {
    for occurrence in reminders {
        post.reminders.insert(occurrence.map_key(), occurrence);
    }
}

pub(crate) fn post_with_reminders(
    tasks: impl IntoIterator<Item = Task>,
    reminders: impl IntoIterator<Item = ReminderOccurrence>,
) -> PostImage {
    let mut post = post_from_tasks(tasks);
    reminders_into_post(&mut post, reminders);
    post
}

// ---------------------------------------------------------------------------
// User-facing schedule mutations
// ---------------------------------------------------------------------------

pub(crate) fn reschedule_reminder(
    connection: &mut Connection,
    operation_id: OperationId,
    task_id: TaskId,
    remind_at: Timestamp,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&ReminderUserReq::RescheduleReminder {
        task_id: task_id.to_string(),
        remind_at: remind_at.to_string(),
    })?;
    mutate(
        connection,
        operation_id,
        request,
        now,
        move |tx, revision| {
            let before = load_task(tx, task_id)?;
            if before.status != TaskStatus::Pending {
                return Err(RepositoryError::Conflict);
            }
            let before_reminders = load_reminders_for_tasks(tx, &[task_id])?;
            let patch = TaskPatch {
                remind_at: Some(Some(remind_at)),
                ..TaskPatch::default()
            };
            let mut after = before.clone();
            apply_patch(&mut after, &patch)?;
            after.updated_at = now;
            after.revision = revision;
            update_task_row(tx, &after)?;
            sync_task_reminder_intent(tx, &after, now)?;
            let after_reminders = load_reminders_for_tasks(tx, &[task_id])?;
            let activity = diff_task_fields(&before, &after, revision, operation_id, now, 0);
            let undo = undo_pair(
                &Inverse::RestoreTasks {
                    tasks: vec![before],
                    reminders: before_reminders,
                },
                &post_with_reminders([after.clone()], after_reminders),
            )?;
            Ok(MutationEffect {
                event_type: EventType::new(EventType::TASK_UPDATED),
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

pub(crate) fn dismiss_reminder(
    connection: &mut Connection,
    operation_id: OperationId,
    task_id: TaskId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&ReminderUserReq::DismissReminder {
        task_id: task_id.to_string(),
    })?;
    mutate(
        connection,
        operation_id,
        request,
        now,
        move |tx, revision| {
            let before = load_task(tx, task_id)?;
            if before.status != TaskStatus::Pending {
                return Err(RepositoryError::Conflict);
            }
            let before_reminders = load_reminders_for_tasks(tx, &[task_id])?;
            let patch = TaskPatch {
                remind_at: Some(None),
                ..TaskPatch::default()
            };
            let mut after = before.clone();
            apply_patch(&mut after, &patch)?;
            after.updated_at = now;
            after.revision = revision;
            update_task_row(tx, &after)?;
            sync_task_reminder_intent(tx, &after, now)?;
            let after_reminders = load_reminders_for_tasks(tx, &[task_id])?;
            let activity = if before.remind_at.is_none() && after.remind_at.is_none() {
                // Exact no-op still records a stable activity row for receipt identity.
                vec![field_activity(
                    revision,
                    0,
                    operation_id,
                    task_id,
                    TaskActivityAction::Updated,
                    Some("remind_at"),
                    None,
                    None,
                    now,
                )]
            } else {
                diff_task_fields(&before, &after, revision, operation_id, now, 0)
            };
            let undo = undo_pair(
                &Inverse::RestoreTasks {
                    tasks: vec![before],
                    reminders: before_reminders,
                },
                &post_with_reminders([after.clone()], after_reminders),
            )?;
            Ok(MutationEffect {
                event_type: EventType::new(EventType::TASK_UPDATED),
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

pub(crate) fn list_task_reminders(
    connection: &Connection,
    task_id: TaskId,
) -> Result<Vec<ReminderOccurrence>, RepositoryError> {
    let tx = connection.unchecked_transaction().map_err(storage_error)?;
    if !task_exists(&tx, task_id)? {
        return Err(RepositoryError::NotFound);
    }
    load_reminders_for_tasks(&tx, &[task_id])
}

// ---------------------------------------------------------------------------
// Control-plane lease / claim / settle (no user revision)
// ---------------------------------------------------------------------------

fn add_secs(now: Timestamp, secs: u64) -> Result<Timestamp, RepositoryError> {
    let secs = i64::try_from(secs)
        .map_err(|_| RepositoryError::Storage("lease duration overflow".into()))?;
    now.checked_add(secs.seconds())
        .map_err(|error| RepositoryError::Storage(error.to_string()))
}

fn new_fence_term() -> Result<ReminderFenceTerm, RepositoryError> {
    // Reuse domain UUID-v7 generation without taking a direct uuid dependency here.
    ReminderFenceTerm::parse(&TaskId::new().to_string()).map_err(validation)
}

fn read_lease(tx: &Transaction<'_>) -> Result<Option<ReminderDeliveryLease>, RepositoryError> {
    tx.query_row(
        "SELECT fence_term, expires_at, updated_at
         FROM reminder_delivery_lease
         WHERE singleton = 1",
        [],
        |row| {
            let fence_term = parse_sql(row.get::<_, String>(0)?, ReminderFenceTerm::parse)?;
            let expires_at = parse_sql(row.get::<_, String>(1)?, |value| {
                value.parse::<Timestamp>().map_err(|_| {
                    junban_domain::ValidationError::InvalidFormat {
                        field: "expires_at",
                        expected: "RFC3339 timestamp",
                    }
                })
            })?;
            let updated_at = parse_sql(row.get::<_, String>(2)?, |value| {
                value.parse::<Timestamp>().map_err(|_| {
                    junban_domain::ValidationError::InvalidFormat {
                        field: "updated_at",
                        expected: "RFC3339 timestamp",
                    }
                })
            })?;
            Ok(ReminderDeliveryLease {
                fence_term,
                expires_at,
                updated_at,
            })
        },
    )
    .optional()
    .map_err(storage_error)
}

fn write_lease(tx: &Transaction<'_>, lease: &ReminderDeliveryLease) -> Result<(), RepositoryError> {
    tx.execute(
        "INSERT INTO reminder_delivery_lease(singleton, fence_term, expires_at, updated_at)
         VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(singleton) DO UPDATE SET
            fence_term = excluded.fence_term,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at",
        params![
            lease.fence_term.as_str(),
            lease.expires_at.to_string(),
            lease.updated_at.to_string(),
        ],
    )
    .map_err(storage_error)?;
    Ok(())
}

/// Require the caller's term to still be the durable lease owner.
///
/// Expiry alone does not fence out settlement of in-flight claims; only a term
/// change does. Claim acquisition still requires an unexpired lease.
fn require_current_term(
    tx: &Transaction<'_>,
    fence_term: &ReminderFenceTerm,
) -> Result<ReminderDeliveryLease, RepositoryError> {
    let Some(lease) = read_lease(tx)? else {
        return Err(RepositoryError::Conflict);
    };
    if lease.fence_term.as_str() != fence_term.as_str() {
        return Err(RepositoryError::Conflict);
    }
    Ok(lease)
}

fn require_unexpired_owner(
    tx: &Transaction<'_>,
    fence_term: &ReminderFenceTerm,
    now: Timestamp,
) -> Result<ReminderDeliveryLease, RepositoryError> {
    let lease = require_current_term(tx, fence_term)?;
    if lease.expires_at <= now {
        return Err(RepositoryError::Conflict);
    }
    Ok(lease)
}

pub(crate) fn acquire_reminder_lease(
    connection: &mut Connection,
    now: Timestamp,
    lease_secs: u64,
) -> Result<ReminderDeliveryLease, RepositoryError> {
    let lease_secs = validate_reminder_lease_secs(lease_secs).map_err(validation)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let current = read_lease(&tx)?;
    if let Some(lease) = current
        && lease.expires_at > now
    {
        return Err(RepositoryError::Conflict);
    }
    let lease = ReminderDeliveryLease {
        fence_term: new_fence_term()?,
        expires_at: add_secs(now, lease_secs)?,
        updated_at: now,
    };
    write_lease(&tx, &lease)?;
    tx.commit().map_err(storage_error)?;
    Ok(lease)
}

pub(crate) fn renew_reminder_lease(
    connection: &mut Connection,
    fence_term: ReminderFenceTerm,
    now: Timestamp,
    lease_secs: u64,
) -> Result<ReminderDeliveryLease, RepositoryError> {
    let lease_secs = validate_reminder_lease_secs(lease_secs).map_err(validation)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    // Renew requires the exact unexpired owner term so a stale owner cannot extend.
    let _ = require_unexpired_owner(&tx, &fence_term, now)?;
    let lease = ReminderDeliveryLease {
        fence_term,
        expires_at: add_secs(now, lease_secs)?,
        updated_at: now,
    };
    write_lease(&tx, &lease)?;
    tx.commit().map_err(storage_error)?;
    Ok(lease)
}

pub(crate) fn release_reminder_lease(
    connection: &mut Connection,
    fence_term: ReminderFenceTerm,
    now: Timestamp,
) -> Result<(), RepositoryError> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let _ = require_current_term(&tx, &fence_term)?;
    // Expire immediately while keeping the term so in-flight settles with this
    // term can still finish until another owner acquires a fresh term.
    let lease = ReminderDeliveryLease {
        fence_term,
        expires_at: now,
        updated_at: now,
    };
    write_lease(&tx, &lease)?;
    tx.commit().map_err(storage_error)?;
    Ok(())
}

fn read_claimed_row(
    tx: &Transaction<'_>,
    task_id: TaskId,
    remind_at: Timestamp,
    fence_term: &ReminderFenceTerm,
) -> Result<ClaimedReminder, RepositoryError> {
    let occurrence =
        load_reminder_occurrence(tx, task_id, remind_at)?.ok_or(RepositoryError::NotFound)?;
    let claim_expires_at = occurrence
        .claim_expires_at
        .ok_or(RepositoryError::Conflict)?;
    Ok(ClaimedReminder {
        task_id,
        remind_at,
        claim_term: fence_term.clone(),
        claim_expires_at,
        attempts: occurrence.attempts,
    })
}

pub(crate) fn claim_due_reminders(
    connection: &mut Connection,
    fence_term: ReminderFenceTerm,
    now: Timestamp,
    limit: u32,
    claim_secs: u64,
) -> Result<Vec<ClaimedReminder>, RepositoryError> {
    let limit = validate_reminder_claim_limit(limit).map_err(validation)?;
    let claim_secs = validate_reminder_lease_secs(claim_secs).map_err(validation)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let _ = require_unexpired_owner(&tx, &fence_term, now)?;
    let claim_expires_at = add_secs(now, claim_secs)?;
    let now_s = now.to_string();

    // Same current owner recovers its still-unexpired claimed batch first so a
    // coordinator restart can finish in-flight work before taking new pending rows.
    let mut statement = tx
        .prepare(
            "SELECT task_id, remind_at
             FROM reminder_occurrences
             WHERE state = 'claimed'
               AND claim_term = ?1
               AND claim_expires_at IS NOT NULL
               AND claim_expires_at > ?2
             ORDER BY remind_at ASC, task_id ASC
             LIMIT ?3",
        )
        .map_err(storage_error)?;
    let recovered = statement
        .query_map(
            params![fence_term.as_str(), now_s.as_str(), i64::from(limit)],
            |row| {
                let task_id = parse_sql(row.get::<_, String>(0)?, TaskId::parse)?;
                let remind_at = parse_sql(row.get::<_, String>(1)?, |value| {
                    value.parse::<Timestamp>().map_err(|_| {
                        junban_domain::ValidationError::InvalidFormat {
                            field: "remind_at",
                            expected: "RFC3339 timestamp",
                        }
                    })
                })?;
                Ok((task_id, remind_at))
            },
        )
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    drop(statement);

    let mut claimed = Vec::with_capacity(limit as usize);
    for (task_id, remind_at) in recovered {
        claimed.push(read_claimed_row(&tx, task_id, remind_at, &fence_term)?);
    }

    let remaining = limit.saturating_sub(u32::try_from(claimed.len()).unwrap_or(u32::MAX));
    if remaining == 0 {
        tx.commit().map_err(storage_error)?;
        return Ok(claimed);
    }

    let mut statement = tx
        .prepare(
            "SELECT task_id, remind_at
             FROM reminder_occurrences
             WHERE state = 'pending'
               AND remind_at <= ?1
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
             ORDER BY remind_at ASC, task_id ASC
             LIMIT ?2",
        )
        .map_err(storage_error)?;
    let candidates = statement
        .query_map(params![now_s.as_str(), i64::from(remaining)], |row| {
            let task_id = parse_sql(row.get::<_, String>(0)?, TaskId::parse)?;
            let remind_at = parse_sql(row.get::<_, String>(1)?, |value| {
                value.parse::<Timestamp>().map_err(|_| {
                    junban_domain::ValidationError::InvalidFormat {
                        field: "remind_at",
                        expected: "RFC3339 timestamp",
                    }
                })
            })?;
            Ok((task_id, remind_at))
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    drop(statement);

    for (task_id, remind_at) in candidates {
        // Durable predicate keeps a row claimable by only one successful UPDATE.
        let updated = tx
            .execute(
                "UPDATE reminder_occurrences
                 SET state = 'claimed',
                     claim_term = ?1,
                     claim_expires_at = ?2,
                     attempts = attempts + 1,
                     next_attempt_at = NULL,
                     terminal_channel = NULL,
                     terminal_error_code = NULL,
                     updated_at = ?3
                 WHERE task_id = ?4
                   AND remind_at = ?5
                   AND state = 'pending'
                   AND remind_at <= ?3
                   AND (next_attempt_at IS NULL OR next_attempt_at <= ?3)",
                params![
                    fence_term.as_str(),
                    claim_expires_at.to_string(),
                    now_s.as_str(),
                    task_id.to_string(),
                    remind_at.to_string(),
                ],
            )
            .map_err(storage_error)?;
        if updated != 1 {
            continue;
        }
        claimed.push(read_claimed_row(&tx, task_id, remind_at, &fence_term)?);
    }

    // Deterministic order for the combined recovered + newly claimed batch.
    claimed.sort_by(|left, right| {
        left.remind_at
            .cmp(&right.remind_at)
            .then_with(|| left.task_id.as_uuid().cmp(&right.task_id.as_uuid()))
    });

    tx.commit().map_err(storage_error)?;
    Ok(claimed)
}

#[allow(clippy::too_many_arguments)]
fn settle_claimed(
    connection: &mut Connection,
    fence_term: &ReminderFenceTerm,
    task_id: TaskId,
    remind_at: Timestamp,
    now: Timestamp,
    state: ReminderOccurrenceState,
    channel: Option<ReminderChannel>,
    error: Option<ReminderFailureCode>,
) -> Result<(), RepositoryError> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    // Stale owners are rejected once the lease term changes.
    let _ = require_current_term(&tx, fence_term)?;
    let Some(existing) = load_reminder_occurrence(&tx, task_id, remind_at)? else {
        return Err(RepositoryError::NotFound);
    };
    match existing.state {
        ReminderOccurrenceState::Delivered => {
            // Durable ack is idempotent for task+instant+channel.
            if state == ReminderOccurrenceState::Delivered
                && existing.terminal_channel == channel
                && error.is_none()
            {
                tx.commit().map_err(storage_error)?;
                return Ok(());
            }
            return Err(RepositoryError::Conflict);
        }
        ReminderOccurrenceState::Failed => {
            if state == ReminderOccurrenceState::Failed
                && existing.terminal_error_code == error
                && channel.is_none()
            {
                tx.commit().map_err(storage_error)?;
                return Ok(());
            }
            return Err(RepositoryError::Conflict);
        }
        ReminderOccurrenceState::Claimed => {}
        ReminderOccurrenceState::Pending | ReminderOccurrenceState::Cancelled => {
            return Err(RepositoryError::Conflict);
        }
    }
    let Some(claim_term) = existing.claim_term.as_ref() else {
        return Err(RepositoryError::Conflict);
    };
    if claim_term.as_str() != fence_term.as_str() {
        return Err(RepositoryError::Conflict);
    }
    let mut settled = existing;
    settled.state = state;
    settled.terminal_channel = channel;
    settled.terminal_error_code = error;
    settled.claim_term = Some(fence_term.clone());
    settled.claim_expires_at = None;
    settled.next_attempt_at = None;
    settled.updated_at = now;
    upsert_reminder_occurrence(&tx, &settled)?;
    tx.commit().map_err(storage_error)?;
    Ok(())
}

pub(crate) fn settle_reminder_delivered(
    connection: &mut Connection,
    fence_term: ReminderFenceTerm,
    task_id: TaskId,
    remind_at: Timestamp,
    channel: ReminderChannel,
    now: Timestamp,
) -> Result<(), RepositoryError> {
    settle_claimed(
        connection,
        &fence_term,
        task_id,
        remind_at,
        now,
        ReminderOccurrenceState::Delivered,
        Some(channel),
        None,
    )
}

pub(crate) fn settle_reminder_failed(
    connection: &mut Connection,
    fence_term: ReminderFenceTerm,
    task_id: TaskId,
    remind_at: Timestamp,
    error: ReminderFailureCode,
    now: Timestamp,
) -> Result<(), RepositoryError> {
    // Owner-lost is reserved for the explicit sweep; ordinary fail path rejects it.
    if matches!(error, ReminderFailureCode::OwnerLost) {
        return Err(validation(junban_domain::ValidationError::Invalid {
            field: "reminder_failure_code",
            reason: "owner_lost requires mark_owner_lost_reminders",
        }));
    }
    settle_claimed(
        connection,
        &fence_term,
        task_id,
        remind_at,
        now,
        ReminderOccurrenceState::Failed,
        None,
        Some(error),
    )
}

pub(crate) fn mark_owner_lost_reminders(
    connection: &mut Connection,
    fence_term: ReminderFenceTerm,
    now: Timestamp,
    limit: u32,
) -> Result<u32, RepositoryError> {
    let limit = validate_owner_lost_mark_limit(limit).map_err(validation)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    // Only the current unexpired owner may recover abandoned claims. This is an
    // explicit sweep — expired claims are never auto-retried in the background.
    let _ = require_unexpired_owner(&tx, &fence_term, now)?;
    let now_s = now.to_string();
    let mut statement = tx
        .prepare(
            "SELECT task_id, remind_at, attempts
             FROM reminder_occurrences
             WHERE state = 'claimed'
               AND claim_expires_at IS NOT NULL
               AND claim_expires_at <= ?1
             ORDER BY claim_expires_at ASC, remind_at ASC, task_id ASC
             LIMIT ?2",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map(params![now_s.as_str(), i64::from(limit)], |row| {
            let task_id = parse_sql(row.get::<_, String>(0)?, TaskId::parse)?;
            let remind_at = parse_sql(row.get::<_, String>(1)?, |value| {
                value.parse::<Timestamp>().map_err(|_| {
                    junban_domain::ValidationError::InvalidFormat {
                        field: "remind_at",
                        expected: "RFC3339 timestamp",
                    }
                })
            })?;
            let attempts = row.get::<_, i64>(2)?;
            Ok((task_id, remind_at, attempts))
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    drop(statement);

    let mut marked = 0u32;
    for (task_id, remind_at, attempts) in rows {
        let attempt_u32 = u32::try_from(attempts).unwrap_or(u32::MAX);
        // Return to pending with bounded backoff so the new owner can reclaim later.
        // terminal_error_code records owner_lost until the next successful claim clears it.
        let backoff = reminder_failure_backoff(attempt_u32.max(1));
        let next_attempt_at = add_secs(now, backoff.as_secs())?;
        let updated = tx
            .execute(
                "UPDATE reminder_occurrences
                 SET state = 'pending',
                     claim_term = NULL,
                     claim_expires_at = NULL,
                     next_attempt_at = ?1,
                     terminal_channel = NULL,
                     terminal_error_code = 'owner_lost',
                     updated_at = ?2
                 WHERE task_id = ?3
                   AND remind_at = ?4
                   AND state = 'claimed'
                   AND claim_expires_at IS NOT NULL
                   AND claim_expires_at <= ?2",
                params![
                    next_attempt_at.to_string(),
                    now_s.as_str(),
                    task_id.to_string(),
                    remind_at.to_string()
                ],
            )
            .map_err(storage_error)?;
        if updated == 1 {
            marked = marked.saturating_add(1);
        }
    }
    tx.commit().map_err(storage_error)?;
    Ok(marked)
}
