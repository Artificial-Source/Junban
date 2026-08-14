//! Opaque URL-safe list cursors bound to resource kind and active sort key.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jiff::Timestamp;
use junban_app::{AiMemoryCursor, AiSessionCursor};
use junban_domain::{AiMemoryId, AiSessionId, TaskCursor, TaskId, TaskSort, ValidationError};
use serde::{Deserialize, Serialize};

use crate::RequestId;
use crate::error::{ApiError, validation_error};

/// Reject absurd cursor transport sizes before decode/parse work.
const MAX_CURSOR_BYTES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct TaskCursorEnvelope {
    sort: TaskSort,
    sort_value: String,
    task_id: TaskId,
}

/// Kind-bound AI list cursors so session and memory pages cannot cross-decode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum AiListCursorEnvelope {
    Session {
        updated_at: Timestamp,
        session_id: AiSessionId,
    },
    Memory {
        updated_at: Timestamp,
        memory_id: AiMemoryId,
    },
}

/// Encode a domain cursor together with the sort that produced it.
pub fn encode_task_cursor(sort: TaskSort, cursor: &TaskCursor) -> Result<String, ValidationError> {
    let envelope = TaskCursorEnvelope {
        sort,
        sort_value: cursor.sort_value.clone(),
        task_id: cursor.task_id,
    };
    encode_json_cursor(&envelope)
}

/// Decode an opaque cursor and reject sort mismatches before mutation/query.
pub fn decode_task_cursor(
    raw: &str,
    expected_sort: TaskSort,
    request_id: &RequestId,
) -> Result<TaskCursor, ApiError> {
    let envelope: TaskCursorEnvelope = decode_json_cursor(raw, request_id)?;
    if envelope.sort != expected_sort {
        return Err(validation_error(
            ValidationError::Invalid {
                field: "cursor",
                reason: "cursor sort does not match the requested sort",
            },
            request_id,
        ));
    }
    // task_id is validated by typed deserialization; sort_value is checked by storage.
    Ok(TaskCursor {
        sort_value: envelope.sort_value,
        task_id: envelope.task_id,
    })
}

/// Encode a recent-first AI session list cursor.
pub fn encode_ai_session_cursor(cursor: &AiSessionCursor) -> Result<String, ValidationError> {
    encode_json_cursor(&AiListCursorEnvelope::Session {
        updated_at: cursor.updated_at,
        session_id: cursor.session_id,
    })
}

/// Decode an opaque AI session list cursor; foreign kinds fail closed.
pub fn decode_ai_session_cursor(
    raw: &str,
    request_id: &RequestId,
) -> Result<AiSessionCursor, ApiError> {
    match decode_json_cursor(raw, request_id)? {
        AiListCursorEnvelope::Session {
            updated_at,
            session_id,
        } => Ok(AiSessionCursor {
            updated_at,
            session_id,
        }),
        AiListCursorEnvelope::Memory { .. } => Err(validation_error(
            ValidationError::Invalid {
                field: "cursor",
                reason: "cursor kind does not match the AI session list",
            },
            request_id,
        )),
    }
}

/// Encode a recent-first AI memory list cursor.
pub fn encode_ai_memory_cursor(cursor: &AiMemoryCursor) -> Result<String, ValidationError> {
    encode_json_cursor(&AiListCursorEnvelope::Memory {
        updated_at: cursor.updated_at,
        memory_id: cursor.memory_id,
    })
}

/// Decode an opaque AI memory list cursor; foreign kinds fail closed.
pub fn decode_ai_memory_cursor(
    raw: &str,
    request_id: &RequestId,
) -> Result<AiMemoryCursor, ApiError> {
    match decode_json_cursor(raw, request_id)? {
        AiListCursorEnvelope::Memory {
            updated_at,
            memory_id,
        } => Ok(AiMemoryCursor {
            updated_at,
            memory_id,
        }),
        AiListCursorEnvelope::Session { .. } => Err(validation_error(
            ValidationError::Invalid {
                field: "cursor",
                reason: "cursor kind does not match the AI memory list",
            },
            request_id,
        )),
    }
}

fn encode_json_cursor<T: Serialize>(value: &T) -> Result<String, ValidationError> {
    let json = serde_json::to_vec(value).map_err(|_| ValidationError::Invalid {
        field: "cursor",
        reason: "cursor could not be encoded",
    })?;
    if json.len() > MAX_CURSOR_BYTES {
        return Err(ValidationError::TooLong {
            field: "cursor",
            max: MAX_CURSOR_BYTES,
        });
    }
    Ok(URL_SAFE_NO_PAD.encode(json))
}

fn decode_json_cursor<T: for<'de> Deserialize<'de>>(
    raw: &str,
    request_id: &RequestId,
) -> Result<T, ApiError> {
    if raw.len() > MAX_CURSOR_BYTES {
        return Err(validation_error(
            ValidationError::TooLong {
                field: "cursor",
                max: MAX_CURSOR_BYTES,
            },
            request_id,
        ));
    }
    let bytes = URL_SAFE_NO_PAD.decode(raw.as_bytes()).map_err(|_| {
        validation_error(
            ValidationError::InvalidFormat {
                field: "cursor",
                expected: "opaque URL-safe cursor",
            },
            request_id,
        )
    })?;
    if bytes.len() > MAX_CURSOR_BYTES {
        return Err(validation_error(
            ValidationError::TooLong {
                field: "cursor",
                max: MAX_CURSOR_BYTES,
            },
            request_id,
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        validation_error(
            ValidationError::InvalidFormat {
                field: "cursor",
                expected: "opaque URL-safe cursor",
            },
            request_id,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RequestId;
    use jiff::Timestamp;

    #[test]
    fn cursor_round_trips_and_rejects_sort_mismatch() {
        let request_id = RequestId("req".into());
        let cursor = TaskCursor {
            sort_value: "10".into(),
            task_id: TaskId::new(),
        };
        let encoded = encode_task_cursor(TaskSort::SortOrderAsc, &cursor).unwrap();
        let decoded = decode_task_cursor(&encoded, TaskSort::SortOrderAsc, &request_id).unwrap();
        assert_eq!(decoded, cursor);
        let err = decode_task_cursor(&encoded, TaskSort::CreatedDesc, &request_id).unwrap_err();
        assert_eq!(err.envelope.error.code, "validation_error");
    }

    #[test]
    fn malformed_cursor_is_rejected() {
        let request_id = RequestId("req".into());
        let err =
            decode_task_cursor("%%%not-base64", TaskSort::SortOrderAsc, &request_id).unwrap_err();
        assert_eq!(err.envelope.error.code, "validation_error");
    }

    #[test]
    fn ai_cursors_round_trip_and_reject_cross_kind() {
        let request_id = RequestId("ai-cursor".into());
        let now = Timestamp::now();
        let session = AiSessionCursor {
            updated_at: now,
            session_id: AiSessionId::new(),
        };
        let memory = AiMemoryCursor {
            updated_at: now,
            memory_id: AiMemoryId::new(),
        };
        let session_encoded = encode_ai_session_cursor(&session).unwrap();
        let memory_encoded = encode_ai_memory_cursor(&memory).unwrap();
        assert_eq!(
            decode_ai_session_cursor(&session_encoded, &request_id).unwrap(),
            session
        );
        assert_eq!(
            decode_ai_memory_cursor(&memory_encoded, &request_id).unwrap(),
            memory
        );
        assert_eq!(
            decode_ai_session_cursor(&memory_encoded, &request_id)
                .unwrap_err()
                .envelope
                .error
                .code,
            "validation_error"
        );
        assert_eq!(
            decode_ai_memory_cursor(&session_encoded, &request_id)
                .unwrap_err()
                .envelope
                .error
                .code,
            "validation_error"
        );
    }

    #[test]
    fn ai_cursors_reject_unknown_fields_and_oversize() {
        let request_id = RequestId("ai-cursor-bad".into());
        let bad = URL_SAFE_NO_PAD.encode(
            br#"{"kind":"session","updated_at":"2026-01-01T00:00:00Z","session_id":"00000000-0000-4000-8000-000000000001","extra":1}"#,
        );
        assert_eq!(
            decode_ai_session_cursor(&bad, &request_id)
                .unwrap_err()
                .envelope
                .error
                .code,
            "validation_error"
        );
        let oversized = "x".repeat(MAX_CURSOR_BYTES + 1);
        assert_eq!(
            decode_ai_session_cursor(&oversized, &request_id)
                .unwrap_err()
                .envelope
                .error
                .code,
            "validation_error"
        );
    }
}
