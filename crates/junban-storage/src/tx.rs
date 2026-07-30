//! Atomic mutation transactions: receipt, effect, activity, event, revision.

use jiff::{Timestamp, ToSpan};
use junban_app::{
    AffectedIds, CommittedEvent, CommittedMutation, EVENT_RETAIN_MAX_BYTES, EVENT_RETAIN_MAX_COUNT,
    EventType, RepositoryError, ResourceRef, ResourceSnapshot, ResyncScope,
};
use junban_domain::{OperationId, TaskActivity};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::rows::{activity_action_str, revision_to_i64, storage_error};

pub(crate) const EVENT_JSON_MAX_BYTES: usize = 512 * 1024;
pub(crate) const RECEIPT_MATERIAL_MAX_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const RECEIPT_TTL_DAYS: i64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UndoRecord {
    pub inverse_json: String,
    pub post_image_json: String,
}

#[derive(Debug)]
pub(crate) struct MutationEffect {
    pub event_type: EventType,
    pub primary: Option<ResourceRef>,
    pub snapshot: Option<ResourceSnapshot>,
    pub affected: AffectedIds,
    pub resync: ResyncScope,
    pub task_activity: Vec<TaskActivity>,
    pub summary_subject: Option<(String, String)>,
    pub undo: Option<UndoRecord>,
    /// Mark this source operation as undone after the new receipt row exists.
    pub mark_undone: Option<OperationId>,
}

pub(crate) fn mutate(
    connection: &mut Connection,
    operation_id: OperationId,
    request_json: String,
    now: Timestamp,
    apply: impl FnOnce(&Transaction<'_>, u64) -> Result<MutationEffect, RepositoryError>,
) -> Result<CommittedMutation, RepositoryError> {
    // Expiry is an authority boundary, not best-effort housekeeping. Commit cleanup
    // before receipt/undo lookup so stale operations cannot replay after 30 days,
    // even when the requested mutation later fails.
    cleanup_expired_receipts(connection, now)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;

    if let Some(replay) = read_receipt(&transaction, operation_id, &request_json)? {
        // Drop the open transaction without writing; replay is never newly committed.
        drop(transaction);
        return Ok(replay);
    }

    let current_revision: i64 = transaction
        .query_row(
            "SELECT global_revision FROM app_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let revision = u64::try_from(current_revision)
        .ok()
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| RepositoryError::Storage("global revision overflow".to_owned()))?;

    let effect = apply(&transaction, revision)?;
    let event = CommittedEvent {
        revision,
        operation_id,
        event_type: effect.event_type.clone(),
        occurred_at: now,
        primary: effect.primary.clone(),
        snapshot: effect.snapshot.clone(),
        affected: effect.affected.clone(),
        resync: effect.resync,
    };
    let response = CommittedMutation {
        event: event.clone(),
        newly_committed: true,
    };
    let event_json = serde_json::to_string(&event).map_err(storage_error)?;
    if event_json.len() > EVENT_JSON_MAX_BYTES {
        return Err(RepositoryError::OperationTooLarge);
    }
    let response_json = serde_json::to_string(&response).map_err(storage_error)?;
    let inverse_json = effect
        .undo
        .as_ref()
        .map(|undo| undo.inverse_json.as_str())
        .unwrap_or("");
    let post_image_json = effect
        .undo
        .as_ref()
        .map(|undo| undo.post_image_json.as_str())
        .unwrap_or("");
    let material_len = request_json
        .len()
        .saturating_add(response_json.len())
        .saturating_add(inverse_json.len())
        .saturating_add(post_image_json.len());
    if material_len > RECEIPT_MATERIAL_MAX_BYTES {
        return Err(RepositoryError::OperationTooLarge);
    }

    transaction
        .execute(
            "UPDATE app_state SET global_revision = ?1 WHERE singleton = 1",
            [revision_to_i64(revision)?],
        )
        .map_err(storage_error)?;

    for activity in &effect.task_activity {
        transaction
            .execute(
                "INSERT INTO task_activity(
                    revision, sequence, operation_id, task_id, action, field,
                    old_value, new_value, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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

    let (subject_type, subject_id) = match &effect.summary_subject {
        Some((kind, id)) => (Some(kind.as_str()), Some(id.as_str())),
        None => (None, None),
    };
    transaction
        .execute(
            "INSERT INTO activity(
                revision, operation_id, kind, subject_type, subject_id, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                revision_to_i64(revision)?,
                operation_id.to_string(),
                effect.event_type.as_str(),
                subject_type,
                subject_id,
                now.to_string(),
            ],
        )
        .map_err(storage_error)?;

    transaction
        .execute(
            "INSERT INTO events(revision, event_type, operation_id, event_json, occurred_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                revision_to_i64(revision)?,
                effect.event_type.as_str(),
                operation_id.to_string(),
                event_json,
                now.to_string(),
            ],
        )
        .map_err(storage_error)?;

    // Timestamp arithmetic rejects calendar units; approximate 30 days as hours.
    let expires_at = now
        .checked_add((RECEIPT_TTL_DAYS * 24).hours())
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    transaction
        .execute(
            "INSERT INTO operation_receipts(
                operation_id, request_json, response_json, created_at, expires_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                operation_id.to_string(),
                request_json,
                response_json,
                now.to_string(),
                expires_at.to_string(),
            ],
        )
        .map_err(storage_error)?;

    if let Some(undo) = effect.undo {
        transaction
            .execute(
                "INSERT INTO operation_undo(
                    source_operation_id, source_revision, inverse_json, post_image_json
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    operation_id.to_string(),
                    revision_to_i64(revision)?,
                    undo.inverse_json,
                    undo.post_image_json,
                ],
            )
            .map_err(storage_error)?;
    }

    if let Some(source_operation_id) = effect.mark_undone {
        transaction
            .execute(
                "UPDATE operation_undo
                 SET undone_by_operation_id = ?1, undone_at = ?2
                 WHERE source_operation_id = ?3
                   AND undone_by_operation_id IS NULL",
                params![
                    operation_id.to_string(),
                    now.to_string(),
                    source_operation_id.to_string()
                ],
            )
            .map_err(storage_error)?;
    }

    transaction.commit().map_err(storage_error)?;

    // Event pruning is housekeeping after the mutation is durable; failure cannot
    // roll back the committed user operation.
    let _ = prune_retained_events(connection);

    Ok(response)
}

fn read_receipt(
    transaction: &Transaction<'_>,
    operation_id: OperationId,
    request_json: &str,
) -> Result<Option<CommittedMutation>, RepositoryError> {
    let receipt = transaction
        .query_row(
            "SELECT request_json, response_json FROM operation_receipts WHERE operation_id = ?1",
            [operation_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(storage_error)?;
    let Some((stored_request, stored_response)) = receipt else {
        return Ok(None);
    };
    if stored_request != request_json {
        return Err(RepositoryError::IdempotencyMismatch);
    }
    let response = serde_json::from_str(&stored_response).map_err(storage_error)?;
    Ok(Some(response))
}

fn cleanup_expired_receipts(
    connection: &mut Connection,
    now: Timestamp,
) -> Result<(), RepositoryError> {
    let now = now.to_string();
    let has_expired: bool = connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM operation_receipts
                WHERE expires_at IS NOT NULL AND expires_at <= ?1
            )",
            [&now],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if !has_expired {
        return Ok(());
    }

    let transaction = connection.transaction().map_err(storage_error)?;
    // Remove expired undo rows first (by source or undone_by link) so FK RESTRICT cannot
    // pin open, undone, or undo-of-undo receipts past the retention window.
    transaction
        .execute(
            "DELETE FROM operation_undo
             WHERE source_operation_id IN (
                SELECT operation_id FROM operation_receipts
                WHERE expires_at IS NOT NULL AND expires_at <= ?1
             )
             OR undone_by_operation_id IN (
                SELECT operation_id FROM operation_receipts
                WHERE expires_at IS NOT NULL AND expires_at <= ?1
             )",
            [&now],
        )
        .map_err(storage_error)?;
    transaction
        .execute(
            "DELETE FROM operation_receipts
             WHERE expires_at IS NOT NULL AND expires_at <= ?1",
            [&now],
        )
        .map_err(storage_error)?;
    transaction.commit().map_err(storage_error)?;
    Ok(())
}

pub(crate) fn retained_event_bytes(connection: &Connection) -> Result<i64, RepositoryError> {
    connection
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(CAST(event_json AS BLOB))), 0) FROM events",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn prune_retained_events(connection: &Connection) -> Result<(), RepositoryError> {
    loop {
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
            .map_err(storage_error)?;
        let bytes = retained_event_bytes(connection)?;
        if count <= EVENT_RETAIN_MAX_COUNT as i64 && bytes <= EVENT_RETAIN_MAX_BYTES as i64 {
            break;
        }
        let deleted = connection
            .execute(
                "DELETE FROM events WHERE revision = (SELECT MIN(revision) FROM events)",
                [],
            )
            .map_err(storage_error)?;
        if deleted == 0 {
            break;
        }
    }
    Ok(())
}

pub(crate) fn canonical_json(value: &impl Serialize) -> Result<String, RepositoryError> {
    serde_json::to_string(value).map_err(storage_error)
}

pub(crate) fn global_revision(connection: &Connection) -> Result<u64, RepositoryError> {
    let revision: i64 = connection
        .query_row(
            "SELECT global_revision FROM app_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    u64::try_from(revision).map_err(|error| RepositoryError::Storage(error.to_string()))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::retained_event_bytes;

    #[test]
    fn retained_event_budget_counts_utf8_bytes_not_characters() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE events(event_json TEXT NOT NULL);")
            .unwrap();
        let json = r#"{"title":"予定📅"}"#;
        connection
            .execute("INSERT INTO events(event_json) VALUES (?1)", [json])
            .unwrap();

        assert_eq!(
            retained_event_bytes(&connection).unwrap(),
            i64::try_from(json.len()).unwrap()
        );
        assert!(json.len() > json.chars().count());
    }
}
