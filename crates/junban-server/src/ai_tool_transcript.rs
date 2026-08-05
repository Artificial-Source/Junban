//! Shared local chat tool-result and durable transcript boundary.
//!
//! Owns the 30 KiB chat-bound ceiling used by streaming reads, approval dispatch,
//! and startup recovery. Post-effect authority retains a complete `created`
//! manifest or fails closed; ordinary read results may fall back to a safe
//! summary envelope.

use junban_app::AppError;
use junban_domain::{AiMessageContent, AiToolEvent, AiToolEventType};
use serde_json::{Value, json};

use crate::ai_tool_registry::ToolResultEnvelope;

/// Leave room for the dispatch identity and terminal metadata in `AiDecisionPayload`.
pub(crate) const AI_CHAT_TOOL_RESULT_BYTES: usize = 30 * 1024;

/// Authoritative chat bound for post-effect results.
///
/// Never truncates a complete `created` authority manifest. When the finalized
/// envelope still exceeds the chat ceiling and retains `created`, the caller
/// receives [`AppError::ResultLimitExceeded`] so the run stays non-terminal
/// rather than recording a lossy result.
pub(crate) fn bound_chat_result(
    result: ToolResultEnvelope,
) -> Result<ToolResultEnvelope, AppError> {
    let created_manifest = result.data.get("created").cloned();
    let mut result = result.finalize_bounded();
    if created_manifest.is_some()
        && (result.truncated || result.data.get("created") != created_manifest.as_ref())
    {
        return Err(AppError::ResultLimitExceeded);
    }
    if serde_json::to_vec(&result).is_ok_and(|bytes| bytes.len() <= AI_CHAT_TOOL_RESULT_BYTES) {
        return Ok(result);
    }
    if result.data.get("created").is_some_and(Value::is_array) {
        // An effect-bearing composite must retain its complete authority manifest.
        return Err(AppError::ResultLimitExceeded);
    }
    apply_chat_size_fallback(&mut result);
    Ok(result)
}

/// Ordinary read-result chat bound used by streaming tool rounds.
///
/// Always returns a chat-safe envelope. Oversized non-authority detail is replaced
/// with the stable fallback summary rather than failing the round.
pub(crate) fn bound_chat_read_result(result: ToolResultEnvelope) -> ToolResultEnvelope {
    let mut result = result.finalize_bounded();
    if serde_json::to_vec(&result).is_ok_and(|bytes| bytes.len() <= AI_CHAT_TOOL_RESULT_BYTES) {
        return result;
    }
    apply_chat_size_fallback(&mut result);
    result
}

/// Append one validated durable tool event and re-validate the message content.
pub(crate) fn push_tool_event(
    content: &mut AiMessageContent,
    event_type: AiToolEventType,
    payload: Value,
) -> Result<(), AppError> {
    let event =
        AiToolEvent::new(content.text.len(), event_type, payload).map_err(AppError::Validation)?;
    content.tool_events.push(event);
    content.validate().map_err(AppError::Validation)
}

/// Stable rejection envelope returned on approval HTTP snapshots.
pub(crate) fn stable_rejection_result(tool: &str) -> Value {
    let result = bound_chat_result(ToolResultEnvelope::error(
        tool,
        "tool_rejected",
        "the operator rejected this tool action",
    ))
    .expect("static rejection result is bounded");
    serde_json::to_value(result).unwrap_or_else(|_| json!({"outcome":"error"}))
}

fn apply_chat_size_fallback(result: &mut ToolResultEnvelope) {
    let code = result.data.get("code").cloned().unwrap_or(Value::Null);
    let count = result.data.get("count").cloned().unwrap_or_else(|| {
        result
            .data
            .get("created")
            .and_then(Value::as_array)
            .map_or(Value::Null, |rows| json!(rows.len()))
    });
    let partial = result.data.get("partial").cloned().unwrap_or(Value::Null);
    result.data = json!({
        "code": code,
        "message": "tool result details exceed the 32 KiB chat bound",
        "count": count,
        "partial": partial,
    });
    result.truncated = true;
}

#[cfg(test)]
mod tests {
    use super::*;
    use junban_domain::AiApprovalId;

    #[test]
    fn ordinary_oversized_result_falls_back_without_created() {
        let oversized = ToolResultEnvelope::success(
            "list_projects",
            json!({"text": "x".repeat(AI_CHAT_TOOL_RESULT_BYTES)}),
        );

        let authoritative = bound_chat_result(oversized.clone()).expect("no created authority");
        assert!(authoritative.truncated);
        assert_eq!(
            authoritative.data.get("message").and_then(Value::as_str),
            Some("tool result details exceed the 32 KiB chat bound")
        );
        assert!(
            serde_json::to_vec(&authoritative).expect("serialize").len()
                <= AI_CHAT_TOOL_RESULT_BYTES
        );

        let read = bound_chat_read_result(oversized);
        assert!(read.truncated);
        assert_eq!(
            read.data.get("message").and_then(Value::as_str),
            Some("tool result details exceed the 32 KiB chat bound")
        );
        assert!(serde_json::to_vec(&read).expect("serialize").len() <= AI_CHAT_TOOL_RESULT_BYTES);
    }

    #[test]
    fn oversized_created_manifest_fails_closed() {
        let oversized_manifest = ToolResultEnvelope::success(
            "bulk_create_tasks",
            json!({
                "created": [{
                    "task_id": "x".repeat(AI_CHAT_TOOL_RESULT_BYTES),
                    "operation_id": "child",
                    "revision": 1,
                    "event_type": "task.created",
                }],
            }),
        );
        assert_eq!(
            bound_chat_result(oversized_manifest).unwrap_err(),
            AppError::ResultLimitExceeded
        );
    }

    #[test]
    fn push_tool_event_rejects_private_result_keys() {
        let mut content = AiMessageContent::text("").expect("empty content");
        let err = push_tool_event(
            &mut content,
            AiToolEventType::ToolResult,
            json!({
                "tool": "list_projects",
                "outcome": "success",
                "data": { "secret": "must-not-persist" },
                "truncated": false,
            }),
        )
        .expect_err("private keys must fail closed");
        assert!(matches!(err, AppError::Validation(_)));
        assert!(content.tool_events.is_empty());
    }

    #[test]
    fn max_valid_result_is_accepted() {
        // Binary-search the largest payload that still fits the chat ceiling after
        // finalize so the boundary itself is exercised rather than a guessed size.
        let mut lo = 0_usize;
        let mut hi = AI_CHAT_TOOL_RESULT_BYTES;
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            let candidate =
                ToolResultEnvelope::success("list_projects", json!({ "blob": "x".repeat(mid) }));
            let finalized = candidate.clone().finalize_bounded();
            let bytes = serde_json::to_vec(&finalized).expect("serialize");
            if bytes.len() <= AI_CHAT_TOOL_RESULT_BYTES {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        let max_fit =
            ToolResultEnvelope::success("list_projects", json!({ "blob": "x".repeat(lo) }));
        let authoritative = bound_chat_result(max_fit.clone()).expect("max valid result");
        assert!(!authoritative.truncated);
        assert!(
            serde_json::to_vec(&authoritative).expect("serialize").len()
                <= AI_CHAT_TOOL_RESULT_BYTES
        );
        let read = bound_chat_read_result(max_fit);
        assert!(!read.truncated);
        assert_eq!(read, authoritative);

        let approval_id = AiApprovalId::new();
        let mut content = AiMessageContent::text("ok").expect("content");
        push_tool_event(
            &mut content,
            AiToolEventType::ToolApproved,
            json!({"approval_id": approval_id.to_string()}),
        )
        .expect("public approval card is valid");
        assert_eq!(content.tool_events.len(), 1);
    }
}
