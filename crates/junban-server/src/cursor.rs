//! Opaque URL-safe task list cursors bound to the active sort key.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use junban_domain::{TaskCursor, TaskId, TaskSort, ValidationError};
use serde::{Deserialize, Serialize};

use crate::RequestId;
use crate::error::{ApiError, validation_error};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CursorEnvelope {
    sort: TaskSort,
    sort_value: String,
    task_id: TaskId,
}

/// Encode a domain cursor together with the sort that produced it.
pub fn encode_task_cursor(sort: TaskSort, cursor: &TaskCursor) -> Result<String, ValidationError> {
    let envelope = CursorEnvelope {
        sort,
        sort_value: cursor.sort_value.clone(),
        task_id: cursor.task_id,
    };
    let json = serde_json::to_vec(&envelope).map_err(|_| ValidationError::Invalid {
        field: "cursor",
        reason: "cursor could not be encoded",
    })?;
    Ok(URL_SAFE_NO_PAD.encode(json))
}

/// Decode an opaque cursor and reject sort mismatches before mutation/query.
pub fn decode_task_cursor(
    raw: &str,
    expected_sort: TaskSort,
    request_id: &RequestId,
) -> Result<TaskCursor, ApiError> {
    let bytes = URL_SAFE_NO_PAD.decode(raw.as_bytes()).map_err(|_| {
        validation_error(
            ValidationError::InvalidFormat {
                field: "cursor",
                expected: "opaque URL-safe cursor",
            },
            request_id,
        )
    })?;
    let envelope: CursorEnvelope = serde_json::from_slice(&bytes).map_err(|_| {
        validation_error(
            ValidationError::InvalidFormat {
                field: "cursor",
                expected: "opaque URL-safe cursor",
            },
            request_id,
        )
    })?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RequestId;

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
}
