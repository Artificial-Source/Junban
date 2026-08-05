//! Non-HTTP approval decision dispatch authority.
//!
//! Owns decision classification, canonical action validation, detached approve/reject
//! workers, rejection checkpoint reconstruction, live tool execution, startup dispatch
//! recovery validation/execution/transcript/terminalization, durable
//! Approved/Consumed/Rejected/finish transitions, and runtime permit completion.
//! HTTP routes retain extractors, DTOs, body/idempotency mapping, and response shaping.
//! Lifecycle callers keep only a thin `ServerState::recover_ai_dispatches` delegate.

use std::io;

use junban_app::{FinishAiResponseRequest, SetAiApprovalStatusRequest};
use junban_domain::{
    AiApprovalId, AiApprovalStatus, AiMessage, AiMessageId, AiMessageStatus, AiRunPhase,
    AiRunState, AiToolApproval, AiToolEventType, OperationId,
};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::{
    AiDecisionCompletion, AiDecisionPayload, AiRuntimeError, AiTerminalOutcome, ServerState,
    ai_identity::AiApprovalDecisionIdentity,
    ai_tool_executor::{ToolExecContext, execute_tool, execute_tool_recovery},
    ai_tool_registry::{ToolEffect, ToolOutcome, ToolResultEnvelope, validate_tool_call},
    ai_tool_transcript::{bound_chat_result, push_tool_event, stable_rejection_result},
};

/// Operator decision accepted by the approval dispatch entrypoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApprovalDecision {
    Approve,
    Reject,
}

/// Fail-closed decision errors mapped to HTTP by the approval route layer.
#[derive(Debug)]
pub(crate) enum ApprovalDecisionError {
    App(junban_app::AppError),
    ActionMismatch,
    InvalidAuthority,
    Expired,
    Unavailable,
    IdentityMismatch,
    DecisionUnavailable,
    WorkerStopped,
}

impl From<junban_app::AppError> for ApprovalDecisionError {
    fn from(error: junban_app::AppError) -> Self {
        Self::App(error)
    }
}

/// Domain-level decision outcome after durable transitions complete.
#[derive(Debug)]
pub(crate) struct ApprovalDecisionOutcome {
    pub approval: AiToolApproval,
    pub message: AiMessage,
    pub run: AiRunState,
    pub result: Option<Value>,
}

/// Recover every exact consumed mutation approval before any normal service starts.
///
/// Validates canonical authority, executes recovered tools, appends the terminal
/// transcript card, and finishes the bound response. Never constructs a provider
/// runtime, credentials, or decision permit. Unreconstructable rows fail listener
/// admission closed.
pub(crate) async fn recover_ai_dispatches(state: &ServerState) -> io::Result<()> {
    let approvals = state
        .service
        .list_dispatching_ai_approvals()
        .await
        .map_err(ai_recovery_error)?;
    for approval in approvals {
        recover_one_dispatch(state, approval).await?;
    }
    Ok(())
}

/// Classify, authorize, and complete one approval decision.
///
/// Fast-path exact retries resolve inline. Live decisions spawn a detached worker that
/// owns the runtime permit so handler drop cannot cancel durable authority.
pub(crate) async fn dispatch_approval_decision(
    state: ServerState,
    approval_id: AiApprovalId,
    action_hash: &str,
    decision: ApprovalDecision,
    decision_receipt: OperationId,
) -> Result<ApprovalDecisionOutcome, ApprovalDecisionError> {
    let approval = state.service.get_ai_approval(approval_id).await?;
    if action_hash != approval.action_hash {
        return Err(ApprovalDecisionError::ActionMismatch);
    }
    let (action, canonical_arguments) =
        validate_tool_call(&approval.tool_name, &approval.arguments_json)
            .map_err(|_| ApprovalDecisionError::InvalidAuthority)?;
    if action.effect() != ToolEffect::ApprovalRequired
        || canonical_arguments != approval.arguments_json
    {
        return Err(ApprovalDecisionError::InvalidAuthority);
    }

    let run = state.service.get_ai_run_state(approval.run_id).await?;
    if decision == ApprovalDecision::Approve
        && approval.status == AiApprovalStatus::Consumed
        && run.state.is_terminal()
    {
        state
            .service
            .set_ai_approval_status(
                decision_receipt,
                SetAiApprovalStatusRequest {
                    approval_id,
                    status: AiApprovalStatus::Approved,
                    dispatch_operation_id: None,
                    assistant_content: None,
                },
            )
            .await?;
        return load_outcome(&state, approval_id, None)
            .await
            .map_err(ApprovalDecisionError::from);
    }
    if decision == ApprovalDecision::Reject && approval.status == AiApprovalStatus::Rejected {
        let assistant_content = rejection_checkpoint_content(
            state
                .service
                .get_ai_message(run.assistant_message_id)
                .await?
                .content,
            &approval,
        )
        .ok_or(ApprovalDecisionError::App(junban_app::AppError::Conflict))?;
        state
            .service
            .set_ai_approval_status(
                decision_receipt,
                SetAiApprovalStatusRequest {
                    approval_id,
                    status: AiApprovalStatus::Rejected,
                    dispatch_operation_id: None,
                    assistant_content: Some(assistant_content),
                },
            )
            .await?;
        let result = stable_rejection_result(&approval.tool_name);
        return load_outcome(&state, approval_id, Some(result))
            .await
            .map_err(ApprovalDecisionError::from);
    }
    if jiff::Timestamp::now() >= approval.expires_at {
        return Err(ApprovalDecisionError::Expired);
    }
    let status_allowed = match decision {
        ApprovalDecision::Approve => matches!(
            approval.status,
            AiApprovalStatus::Pending | AiApprovalStatus::Approved | AiApprovalStatus::Consumed
        ),
        ApprovalDecision::Reject => approval.status == AiApprovalStatus::Pending,
    };
    if !status_allowed || run.state.is_terminal() {
        return Err(ApprovalDecisionError::Unavailable);
    }

    let permit = state
        .ai_runtime()
        .begin_decision(approval.run_id, approval.generation, approval.id)
        .map_err(map_runtime_error)?;
    let (result_tx, result_rx) = oneshot::channel();
    let worker_state = state.clone();
    tokio::spawn(async move {
        let result = match decision {
            ApprovalDecision::Approve => {
                approve_worker(worker_state, approval, action, decision_receipt, permit).await
            }
            ApprovalDecision::Reject => {
                reject_worker(worker_state, approval, decision_receipt, permit).await
            }
        };
        let _ = result_tx.send(result);
    });
    result_rx
        .await
        .map_err(|_| ApprovalDecisionError::WorkerStopped)?
        .map_err(ApprovalDecisionError::from)
}

fn rejection_checkpoint_content(
    mut content: junban_domain::AiMessageContent,
    approval: &AiToolApproval,
) -> Option<junban_domain::AiMessageContent> {
    let approval_id = approval.id.to_string();
    let rejected_index = content.tool_events.iter().position(|event| {
        event.event_type == AiToolEventType::ToolRejected
            && event.payload.get("approval_id").and_then(Value::as_str)
                == Some(approval_id.as_str())
    })?;
    let result_index = content
        .tool_events
        .iter()
        .enumerate()
        .skip(rejected_index + 1)
        .find_map(|(index, event)| {
            (event.event_type == AiToolEventType::ToolResult).then_some(index)
        })?;
    let text_len = usize::try_from(content.tool_events[result_index].assistant_utf8_offset).ok()?;
    if text_len > content.text.len() || !content.text.is_char_boundary(text_len) {
        return None;
    }
    content.text.truncate(text_len);
    content.tool_events.truncate(result_index + 1);
    content.tool_name = Some(approval.tool_name.clone());
    content.tool_arguments_json = Some(approval.arguments_json.clone());
    content.tool_result_json =
        Some(serde_json::to_string(&stable_rejection_result(&approval.tool_name)).ok()?);
    content.validate().ok()?;
    Some(content)
}

async fn approve_worker(
    state: ServerState,
    approval: AiToolApproval,
    action: crate::ai_tool_registry::ValidatedToolAction,
    decision_receipt: OperationId,
    permit: crate::AiDecisionPermit,
) -> Result<ApprovalDecisionOutcome, junban_app::AppError> {
    let identities = AiApprovalDecisionIdentity::derive(approval.id);
    let assistant = state
        .service
        .get_ai_message(
            state
                .service
                .get_ai_run_state(approval.run_id)
                .await?
                .assistant_message_id,
        )
        .await?;
    let recovering_dispatch = approval.status == AiApprovalStatus::Consumed;
    let expected_checkpoint = if recovering_dispatch {
        AiToolEventType::ToolApproved
    } else {
        AiToolEventType::ToolProposed
    };
    if assistant.content.tool_name.as_deref() != Some(approval.tool_name.as_str())
        || assistant.content.tool_arguments_json.as_deref()
            != Some(approval.arguments_json.as_str())
        || assistant.content.tool_result_json.is_some()
        || assistant.content.tool_events.last().is_none_or(|event| {
            event.event_type != expected_checkpoint
                || (expected_checkpoint == AiToolEventType::ToolApproved
                    && event.payload != json!({"approval_id": approval.id.to_string()}))
        })
    {
        return Err(junban_app::AppError::Conflict);
    }
    let settings = state.service.get_settings().await?;
    let context = ToolExecContext::with_confirmed_settings(jiff::Zoned::now(), &settings);

    let mut approved_content = assistant.content;
    let dispatch_operation_id = if recovering_dispatch {
        let raw = approval
            .operation_id
            .as_deref()
            .ok_or(junban_app::AppError::Conflict)?;
        let parsed = OperationId::parse(raw).map_err(junban_app::AppError::Validation)?;
        if parsed.to_string() != raw {
            return Err(junban_app::AppError::Conflict);
        }
        parsed
    } else {
        state
            .service
            .set_ai_approval_status(
                decision_receipt,
                SetAiApprovalStatusRequest {
                    approval_id: approval.id,
                    status: AiApprovalStatus::Approved,
                    dispatch_operation_id: None,
                    assistant_content: None,
                },
            )
            .await?;
        // Build the trusted transcript checkpoint before the consume transaction.
        // The storage compare-and-swap verifies this is exactly the durable proposal
        // plus one local approval card and persists it with the dispatch authority.
        push_tool_event(
            &mut approved_content,
            AiToolEventType::ToolApproved,
            json!({"approval_id": approval.id.to_string()}),
        )?;
        // This cryptographically random, non-public root is created only by the trusted
        // approval worker, immediately before the approval/run pair durably consumes it.
        let dispatch_operation_id = OperationId::new();
        state
            .service
            .set_ai_approval_status(
                identities.consume_operation_id,
                SetAiApprovalStatusRequest {
                    approval_id: approval.id,
                    status: AiApprovalStatus::Consumed,
                    dispatch_operation_id: Some(dispatch_operation_id),
                    assistant_content: Some(approved_content.clone()),
                },
            )
            .await?;
        approved_content = state.service.get_ai_message(assistant.id).await?.content;
        dispatch_operation_id
    };

    let executed = if recovering_dispatch {
        execute_tool_recovery(&state.service, &action, &context, dispatch_operation_id).await?
    } else {
        execute_tool(
            &state.service,
            &action,
            &context,
            Some(dispatch_operation_id),
        )
        .await
    };
    let result = bound_chat_result(executed)?;
    let terminal = finish_dispatched_tool_result(
        &state,
        &approval,
        assistant.id,
        approved_content,
        dispatch_operation_id,
        &result,
    )
    .await?;
    // Live approve alone builds the process decision payload and completes the runtime permit.
    let payload = AiDecisionPayload::from_tool_result(dispatch_operation_id, terminal, &result)
        .map_err(|_| junban_app::AppError::Conflict)?;
    permit
        .complete(AiDecisionCompletion::Dispatched(payload))
        .map_err(|_| junban_app::AppError::Conflict)?;
    load_outcome(&state, approval.id, None).await
}

async fn reject_worker(
    state: ServerState,
    approval: AiToolApproval,
    decision_receipt: OperationId,
    permit: crate::AiDecisionPermit,
) -> Result<ApprovalDecisionOutcome, junban_app::AppError> {
    let run = state.service.get_ai_run_state(approval.run_id).await?;
    let mut content = state
        .service
        .get_ai_message(run.assistant_message_id)
        .await?
        .content;
    if content.tool_name.as_deref() != Some(approval.tool_name.as_str())
        || content.tool_arguments_json.as_deref() != Some(approval.arguments_json.as_str())
        || content.tool_result_json.is_some()
        || content
            .tool_events
            .last()
            .is_none_or(|event| event.event_type != AiToolEventType::ToolProposed)
    {
        return Err(junban_app::AppError::Conflict);
    }
    let rejection_value = stable_rejection_result(&approval.tool_name);
    push_tool_event(
        &mut content,
        AiToolEventType::ToolRejected,
        json!({"approval_id": approval.id.to_string()}),
    )?;
    push_tool_event(
        &mut content,
        AiToolEventType::ToolResult,
        rejection_value.clone(),
    )?;
    content.tool_result_json =
        Some(serde_json::to_string(&rejection_value).map_err(|_| junban_app::AppError::Storage)?);
    state
        .service
        .set_ai_approval_status(
            decision_receipt,
            SetAiApprovalStatusRequest {
                approval_id: approval.id,
                status: AiApprovalStatus::Rejected,
                dispatch_operation_id: None,
                assistant_content: Some(content),
            },
        )
        .await?;
    permit
        .complete(AiDecisionCompletion::Rejected)
        .map_err(|_| junban_app::AppError::Conflict)?;
    load_outcome(&state, approval.id, Some(rejection_value)).await
}

async fn load_outcome(
    state: &ServerState,
    approval_id: AiApprovalId,
    result_override: Option<Value>,
) -> Result<ApprovalDecisionOutcome, junban_app::AppError> {
    let approval = state.service.get_ai_approval(approval_id).await?;
    let run = state.service.get_ai_run_state(approval.run_id).await?;
    let message = state
        .service
        .get_ai_message(run.assistant_message_id)
        .await?;
    let persisted_result = message
        .content
        .tool_result_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| junban_app::AppError::Storage)?;
    Ok(ApprovalDecisionOutcome {
        approval,
        message,
        run,
        result: result_override.or(persisted_result),
    })
}

fn map_runtime_error(error: AiRuntimeError) -> ApprovalDecisionError {
    match error {
        AiRuntimeError::DecisionIdentityMismatch => ApprovalDecisionError::IdentityMismatch,
        AiRuntimeError::DecisionUnavailable | AiRuntimeError::NotFound => {
            ApprovalDecisionError::Unavailable
        }
        _ => ApprovalDecisionError::DecisionUnavailable,
    }
}

async fn recover_one_dispatch(state: &ServerState, approval: AiToolApproval) -> io::Result<()> {
    let (action, canonical_arguments) =
        validate_tool_call(&approval.tool_name, &approval.arguments_json)
            .map_err(|_| ai_recovery_invalid())?;
    if action.effect() != ToolEffect::ApprovalRequired
        || canonical_arguments != approval.arguments_json
    {
        return Err(ai_recovery_invalid());
    }
    let dispatch_raw = approval
        .operation_id
        .as_deref()
        .ok_or_else(ai_recovery_invalid)?;
    let dispatch_operation_id =
        OperationId::parse(dispatch_raw).map_err(|_| ai_recovery_invalid())?;
    if dispatch_operation_id.to_string() != dispatch_raw {
        return Err(ai_recovery_invalid());
    }
    let run = state
        .service
        .get_ai_run_state(approval.run_id)
        .await
        .map_err(ai_recovery_error)?;
    if run.state != AiRunPhase::Dispatching
        || run.generation != approval.generation
        || run.session_id != approval.session_id
        || run.turn_id != approval.turn_id
        || run.approval_id != Some(approval.id)
    {
        return Err(ai_recovery_invalid());
    }
    let assistant = state
        .service
        .get_ai_message(run.assistant_message_id)
        .await
        .map_err(ai_recovery_error)?;
    if assistant.status != AiMessageStatus::Streaming
        || assistant.content.tool_name.as_deref() != Some(approval.tool_name.as_str())
        || assistant.content.tool_arguments_json.as_deref()
            != Some(approval.arguments_json.as_str())
        || assistant.content.tool_result_json.is_some()
        || assistant.content.tool_events.last().is_none_or(|event| {
            event.event_type != AiToolEventType::ToolApproved
                || event.payload != json!({"approval_id": approval.id.to_string()})
        })
    {
        return Err(ai_recovery_invalid());
    }
    let settings = state
        .service
        .get_settings()
        .await
        .map_err(ai_recovery_error)?;
    let context = ToolExecContext::with_confirmed_settings(jiff::Zoned::now(), &settings);
    let result = bound_chat_result(
        execute_tool_recovery(&state.service, &action, &context, dispatch_operation_id)
            .await
            .map_err(ai_recovery_error)?,
    )
    .map_err(ai_recovery_error)?;
    finish_dispatched_tool_result(
        state,
        &approval,
        assistant.id,
        assistant.content,
        dispatch_operation_id,
        &result,
    )
    .await
    .map_err(ai_recovery_error)?;
    Ok(())
}

/// Shared terminal tool_result transcript + `finish_ai_response` persistence.
///
/// Used by live approve and startup recovery. Runtime permit completion and decision
/// payload construction remain live-only; result/transcript policy stays in
/// `ai_tool_transcript`.
async fn finish_dispatched_tool_result(
    state: &ServerState,
    approval: &AiToolApproval,
    assistant_message_id: AiMessageId,
    mut content: junban_domain::AiMessageContent,
    dispatch_operation_id: OperationId,
    result: &ToolResultEnvelope,
) -> Result<AiTerminalOutcome, junban_app::AppError> {
    let terminal = if result.outcome == ToolOutcome::Success {
        AiTerminalOutcome::Completed
    } else {
        AiTerminalOutcome::Failed
    };
    let run_phase = if terminal == AiTerminalOutcome::Completed {
        AiRunPhase::Completed
    } else {
        AiRunPhase::Failed
    };
    let result_value = serde_json::to_value(result).map_err(|_| junban_app::AppError::Storage)?;
    push_tool_event(&mut content, AiToolEventType::ToolResult, result_value)?;
    content.tool_result_json =
        Some(serde_json::to_string(result).map_err(|_| junban_app::AppError::Storage)?);
    state
        .service
        .finish_ai_response(
            AiApprovalDecisionIdentity::derive(approval.id).finish_operation_id,
            FinishAiResponseRequest {
                assistant_message_id,
                session_id: approval.session_id,
                turn_id: approval.turn_id,
                run_id: approval.run_id,
                generation: approval.generation,
                message_status: if run_phase == AiRunPhase::Completed {
                    AiMessageStatus::Completed
                } else {
                    AiMessageStatus::Failed
                },
                content,
                run_phase,
                dispatch_operation_id: Some(dispatch_operation_id),
            },
        )
        .await?;
    Ok(terminal)
}

fn ai_recovery_invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "AI dispatch recovery authority is invalid or unrecoverable",
    )
}

fn ai_recovery_error(_: junban_app::AppError) -> io::Error {
    io::Error::other("AI dispatch recovery could not access durable authority")
}
