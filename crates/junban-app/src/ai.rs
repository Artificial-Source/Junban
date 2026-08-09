//! App-owned AI request, cursor, and secret-input types for Wave 3 service wiring.
//!
//! Raw provider/speech secret bytes stay in [`AiSecretBytes`] only. They never enter
//! domain settings, event payloads, receipts, Debug output, or error strings.

use std::fmt;

use jiff::Timestamp;
use junban_domain::{
    AI_CONTEXT_MEMORIES_MAX, AI_MEMORY_PAGE_MAX, AI_MESSAGE_PAGE_MAX, AI_SECRET_BYTES_MAX,
    AI_SESSION_PAGE_MAX, AiApprovalId, AiApprovalStatus, AiCredentialId, AiMemory, AiMemoryId,
    AiMessage, AiMessageContent, AiMessageId, AiMessageRole, AiMessageStatus,
    AiResponseRewriteKind, AiRunId, AiRunState, AiSecretKind, AiSession, AiSessionId, AiTurnId,
    OperationId, TaskId, ValidationError,
};
use serde::{Deserialize, Serialize};

use crate::CommittedMutation;

/// Opaque secret material admitted at the application boundary.
///
/// Never implements Serialize. Debug is always redacted.
#[derive(Clone)]
pub struct AiSecretBytes(String);

impl AiSecretBytes {
    /// Validate non-empty, ≤8 KiB, control-character-free secret material.
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.is_empty() {
            return Err(ValidationError::Empty { field: "ai_secret" });
        }
        if value.len() > AI_SECRET_BYTES_MAX {
            return Err(ValidationError::TooLong {
                field: "ai_secret",
                max: AI_SECRET_BYTES_MAX,
            });
        }
        if value.chars().any(|ch| ch.is_control()) {
            return Err(ValidationError::Invalid {
                field: "ai_secret",
                reason: "secret must not contain control characters",
            });
        }
        Ok(Self(value))
    }

    /// Borrow raw bytes for an in-memory provider request or private store write only.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AiSecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AiSecretBytes([redacted])")
    }
}

/// Which confirmed settings field holds an AI credential binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiCredentialBindingTarget {
    AiProvider,
    VoiceStt,
    VoiceTts,
}

/// Keyset cursor for recent-first AI session pages (`updated_at DESC, id ASC`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiSessionCursor {
    pub updated_at: Timestamp,
    pub session_id: AiSessionId,
}

/// Keyset cursor for recent-first AI memory pages (`updated_at DESC, id ASC`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiMemoryCursor {
    pub updated_at: Timestamp,
    pub memory_id: AiMemoryId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiSessionListPage {
    pub sessions: Vec<AiSession>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<AiSessionCursor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiMemoryListPage {
    pub memories: Vec<AiMemory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<AiMemoryCursor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiMessageListPage {
    pub messages: Vec<AiMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateAiSessionRequest {
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameAiSessionRequest {
    pub session_id: AiSessionId,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteAiSessionRequest {
    pub session_id: AiSessionId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClearAiSessionRequest {
    pub session_id: AiSessionId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListAiSessionsRequest {
    pub cursor: Option<AiSessionCursor>,
    pub limit: Option<u32>,
}

impl ListAiSessionsRequest {
    pub fn validated_limit(&self) -> Result<u32, ValidationError> {
        validate_ai_page_limit(self.limit, AI_SESSION_PAGE_MAX, "ai_sessions.limit")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpsertAiMessageRequest {
    pub message_id: AiMessageId,
    pub session_id: AiSessionId,
    pub turn_id: AiTurnId,
    pub role: AiMessageRole,
    pub status: AiMessageStatus,
    pub content: AiMessageContent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListAiMessagesRequest {
    pub session_id: AiSessionId,
    pub after_sequence: Option<u32>,
    pub limit: Option<u32>,
}

impl ListAiMessagesRequest {
    pub fn validated_limit(&self) -> Result<u32, ValidationError> {
        validate_ai_page_limit(self.limit, AI_MESSAGE_PAGE_MAX, "ai_messages.limit")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateAiMemoryRequest {
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateAiMemoryRequest {
    pub memory_id: AiMemoryId,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteAiMemoryRequest {
    pub memory_id: AiMemoryId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkAiSessionMemoryRequest {
    pub session_id: AiSessionId,
    pub memory_id: AiMemoryId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListAiMemoriesRequest {
    pub cursor: Option<AiMemoryCursor>,
    pub limit: Option<u32>,
}

impl ListAiMemoriesRequest {
    pub fn validated_limit(&self) -> Result<u32, ValidationError> {
        validate_ai_page_limit(self.limit, AI_MEMORY_PAGE_MAX, "ai_memories.limit")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectAiMemoriesRequest {
    pub session_id: Option<AiSessionId>,
    pub limit: Option<u32>,
}

impl SelectAiMemoriesRequest {
    pub fn validated_limit(&self) -> Result<u32, ValidationError> {
        validate_ai_page_limit(
            self.limit,
            AI_CONTEXT_MEMORIES_MAX,
            "ai_memories.context_limit",
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposeAiApprovalRequest {
    pub approval_id: AiApprovalId,
    pub session_id: AiSessionId,
    pub turn_id: AiTurnId,
    pub run_id: AiRunId,
    pub generation: u64,
    pub tool_name: String,
    pub arguments_json: String,
    /// Assistant text and prior durable tool events checkpointed with the proposal.
    pub assistant_content: AiMessageContent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetAiApprovalStatusRequest {
    pub approval_id: AiApprovalId,
    pub status: AiApprovalStatus,
    /// Required only when consuming an approved tool call.
    pub dispatch_operation_id: Option<OperationId>,
    /// Exact assistant checkpoint required for rejection or consumption atomics.
    pub assistant_content: Option<AiMessageContent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpsertAiRunStateRequest {
    pub state: AiRunState,
}

/// Deterministic identities and caller input for one assistant-only daily reservation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReserveDailyAiResponseRequest {
    pub session_id: AiSessionId,
    pub briefing_date: String,
    pub turn_id: AiTurnId,
    pub assistant_message_id: AiMessageId,
    pub run_id: AiRunId,
    pub generation: u64,
}

/// Deterministic identities and replacement input for one exact history rewrite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewriteAiResponseRequest {
    pub kind: AiResponseRewriteKind,
    pub session_id: AiSessionId,
    pub target_message_id: AiMessageId,
    pub message: String,
    pub focused_task_id: Option<TaskId>,
    pub turn_id: AiTurnId,
    pub user_message_id: AiMessageId,
    pub assistant_message_id: AiMessageId,
    pub run_id: AiRunId,
    pub generation: u64,
}

/// Durable response seed returned by daily reservation and suffix rewrite transactions.
#[derive(Debug, Clone)]
pub struct PreparedAiResponse {
    pub mutation: CommittedMutation,
    pub user_message: Option<AiMessage>,
    pub assistant_message: AiMessage,
    pub run: AiRunState,
}

/// Atomically cancel one reserved assistant response and its exact durable run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelAiResponseRequest {
    pub assistant_message_id: AiMessageId,
    pub session_id: AiSessionId,
    pub turn_id: AiTurnId,
    pub run_id: AiRunId,
    pub generation: u64,
    pub content: AiMessageContent,
}

/// Atomically finalize one reserved assistant response and its exact durable run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishAiResponseRequest {
    pub assistant_message_id: AiMessageId,
    pub session_id: AiSessionId,
    pub turn_id: AiTurnId,
    pub run_id: AiRunId,
    pub generation: u64,
    pub message_status: AiMessageStatus,
    pub content: AiMessageContent,
    pub run_phase: junban_domain::AiRunPhase,
    /// Required only for a consumed approval's exact dispatch operation.
    pub dispatch_operation_id: Option<OperationId>,
}

/// Bind or replace a settings credential reference after optional secret publication.
pub struct BindAiCredentialRequest {
    pub target: AiCredentialBindingTarget,
    pub kind: AiSecretKind,
    pub secret: Option<AiSecretBytes>,
}

impl fmt::Debug for BindAiCredentialRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BindAiCredentialRequest")
            .field("target", &self.target)
            .field("kind", &self.kind)
            .field("secret", &self.secret.as_ref().map(|_| "[redacted]"))
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClearAiCredentialRequest {
    pub target: AiCredentialBindingTarget,
}

/// Result of a credential bind/clear mutation through the repository port.
#[derive(Debug, Clone)]
pub struct AiCredentialBindResult {
    pub mutation: CommittedMutation,
    pub credential_id: Option<AiCredentialId>,
}

fn validate_ai_page_limit(
    limit: Option<u32>,
    max: u32,
    field: &'static str,
) -> Result<u32, ValidationError> {
    let limit = limit.unwrap_or(max);
    if limit == 0 || limit > max {
        return Err(ValidationError::OutOfRange {
            field,
            min: 1,
            max: i64::from(max),
        });
    }
    Ok(limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_bytes_reject_empty_oversize_and_controls() {
        assert!(AiSecretBytes::new("").is_err());
        assert!(AiSecretBytes::new("x".repeat(AI_SECRET_BYTES_MAX + 1)).is_err());
        assert!(AiSecretBytes::new("has\nnewline").is_err());
        let secret = AiSecretBytes::new("fixture-secret-material").unwrap();
        assert_eq!(format!("{secret:?}"), "AiSecretBytes([redacted])");
        assert!(!format!("{secret:?}").contains("fixture"));
    }

    #[test]
    fn bind_request_debug_redacts_secret() {
        let request = BindAiCredentialRequest {
            target: AiCredentialBindingTarget::AiProvider,
            kind: AiSecretKind::ApiKey,
            secret: Some(AiSecretBytes::new("super-secret-marker-value").unwrap()),
        };
        let debug = format!("{request:?}");
        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains("super-secret-marker-value"));
    }
}
