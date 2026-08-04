//! HTTP surface for AI tool-approval inspection and operator decisions.
//!
//! Owns Axum extractors, request/response DTOs, body/auth/idempotency/error mapping,
//! GET/approve/reject handlers, and DTO conversion from domain snapshots. Durable
//! decision authority lives in [`crate::ai_approval_dispatch`].

use axum::{
    Json,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
};
use junban_domain::AiApprovalId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::{
    RequestId, ServerState,
    ai_approval_dispatch::{
        ApprovalDecision, ApprovalDecisionError, ApprovalDecisionOutcome,
        dispatch_approval_decision,
    },
    ai_identity::AiHttpDecisionIdentity,
    error::{ApiError, extract_json_with_limit, operation_id},
};

const AI_APPROVAL_BODY_BYTES: usize = 4 * 1024;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AiApprovalDecisionRequest {
    pub action_hash: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AiApprovalDto {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    pub run_id: String,
    pub generation: u64,
    pub tool_name: String,
    pub arguments: Value,
    pub action_hash: String,
    pub status: String,
    pub expires_at: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AiApprovalMessageDto {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    pub role: String,
    pub status: String,
    pub content: Value,
    pub sequence: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AiApprovalRunDto {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    pub assistant_message_id: String,
    pub generation: u64,
    pub state: String,
    pub approval_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AiApprovalResponse {
    pub approval: AiApprovalDto,
    pub message: AiApprovalMessageDto,
    pub run: AiApprovalRunDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
}

#[utoipa::path(
    get,
    path = "/api/v1/ai/approvals/{approval_id}",
    operation_id = "get_ai_approval",
    params(("approval_id" = String, Path, format = Uuid)),
    responses(
        (status = 200, body = AiApprovalResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn get_ai_approval(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    Path(approval_id): Path<String>,
) -> Result<Json<AiApprovalResponse>, ApiError> {
    let approval_id = AiApprovalId::parse(&approval_id)
        .map_err(|error| crate::error::validation_error(error, &request_id))?;
    Ok(Json(
        load_approval_response(&state, approval_id)
            .await
            .map_err(|error| ApiError::from_app(error, &request_id))?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/v1/ai/approvals/{approval_id}/approve",
    operation_id = "approve_ai_approval",
    request_body = AiApprovalDecisionRequest,
    params(
        ("approval_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = AiApprovalResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn approve_ai_approval(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    Path(approval_id): Path<String>,
    headers: HeaderMap,
    payload: Result<Json<AiApprovalDecisionRequest>, JsonRejection>,
) -> Result<Json<AiApprovalResponse>, ApiError> {
    decide(
        state,
        request_id,
        approval_id,
        headers,
        payload,
        ApprovalDecision::Approve,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/v1/ai/approvals/{approval_id}/reject",
    operation_id = "reject_ai_approval",
    request_body = AiApprovalDecisionRequest,
    params(
        ("approval_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = AiApprovalResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn reject_ai_approval(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    Path(approval_id): Path<String>,
    headers: HeaderMap,
    payload: Result<Json<AiApprovalDecisionRequest>, JsonRejection>,
) -> Result<Json<AiApprovalResponse>, ApiError> {
    decide(
        state,
        request_id,
        approval_id,
        headers,
        payload,
        ApprovalDecision::Reject,
    )
    .await
}

async fn decide(
    state: ServerState,
    request_id: RequestId,
    approval_id: String,
    headers: HeaderMap,
    payload: Result<Json<AiApprovalDecisionRequest>, JsonRejection>,
    decision: ApprovalDecision,
) -> Result<Json<AiApprovalResponse>, ApiError> {
    let caller_operation_id = operation_id(&headers, &request_id)?;
    let decision_receipt = AiHttpDecisionIdentity::derive(caller_operation_id).receipt_operation_id;
    let payload = extract_json_with_limit(payload, &request_id, AI_APPROVAL_BODY_BYTES)?;
    let approval_id = AiApprovalId::parse(&approval_id)
        .map_err(|error| crate::error::validation_error(error, &request_id))?;
    let outcome = dispatch_approval_decision(
        state,
        approval_id,
        &payload.action_hash,
        decision,
        decision_receipt,
    )
    .await
    .map_err(|error| map_decision_error(error, &request_id))?;
    to_response(outcome)
        .map(Json)
        .map_err(|error| ApiError::from_app(error, &request_id))
}

async fn load_approval_response(
    state: &ServerState,
    approval_id: AiApprovalId,
) -> Result<AiApprovalResponse, junban_app::AppError> {
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
    to_response(ApprovalDecisionOutcome {
        approval,
        message,
        run,
        result: persisted_result,
    })
}

fn to_response(
    outcome: ApprovalDecisionOutcome,
) -> Result<AiApprovalResponse, junban_app::AppError> {
    let arguments = serde_json::from_str(&outcome.approval.arguments_json)
        .map_err(|_| junban_app::AppError::Storage)?;
    let content = serde_json::to_value(&outcome.message.content)
        .map_err(|_| junban_app::AppError::Storage)?;
    Ok(AiApprovalResponse {
        approval: AiApprovalDto {
            id: outcome.approval.id.to_string(),
            session_id: outcome.approval.session_id.to_string(),
            turn_id: outcome.approval.turn_id.to_string(),
            run_id: outcome.approval.run_id.to_string(),
            generation: outcome.approval.generation,
            tool_name: outcome.approval.tool_name,
            arguments,
            action_hash: outcome.approval.action_hash,
            status: outcome.approval.status.as_str().to_owned(),
            expires_at: outcome.approval.expires_at.to_string(),
            created_at: outcome.approval.created_at.to_string(),
            updated_at: outcome.approval.updated_at.to_string(),
        },
        message: AiApprovalMessageDto {
            id: outcome.message.id.to_string(),
            session_id: outcome.message.session_id.to_string(),
            turn_id: outcome.message.turn_id.to_string(),
            role: outcome.message.role.as_str().to_owned(),
            status: outcome.message.status.as_str().to_owned(),
            content,
            sequence: outcome.message.sequence,
            created_at: outcome.message.created_at.to_string(),
            updated_at: outcome.message.updated_at.to_string(),
        },
        run: AiApprovalRunDto {
            id: outcome.run.run_id.to_string(),
            session_id: outcome.run.session_id.to_string(),
            turn_id: outcome.run.turn_id.to_string(),
            assistant_message_id: outcome.run.assistant_message_id.to_string(),
            generation: outcome.run.generation,
            state: outcome.run.state.as_str().to_owned(),
            approval_id: outcome.run.approval_id.map(|id| id.to_string()),
            created_at: outcome.run.created_at.to_string(),
            updated_at: outcome.run.updated_at.to_string(),
        },
        result: outcome.result,
    })
}

fn map_decision_error(error: ApprovalDecisionError, request_id: &RequestId) -> ApiError {
    match error {
        ApprovalDecisionError::App(error) => ApiError::from_app(error, request_id),
        ApprovalDecisionError::ActionMismatch => conflict(
            "ai_approval_action_mismatch",
            "approval action hash does not match durable authority",
            request_id,
        ),
        ApprovalDecisionError::InvalidAuthority => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "ai_approval_invalid",
            "durable approval authority is invalid",
            false,
            request_id,
        ),
        ApprovalDecisionError::Expired => conflict(
            "ai_approval_expired",
            "approval has reached its durable expiry",
            request_id,
        ),
        ApprovalDecisionError::Unavailable => conflict(
            "ai_approval_unavailable",
            "approval decision conflicts with current durable state",
            request_id,
        ),
        ApprovalDecisionError::IdentityMismatch => conflict(
            "ai_approval_identity_mismatch",
            "approval decision is not currently available",
            request_id,
        ),
        ApprovalDecisionError::DecisionUnavailable => conflict(
            "ai_decision_unavailable",
            "approval decision is not currently available",
            request_id,
        ),
        ApprovalDecisionError::WorkerStopped => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "ai_decision_unavailable",
            "approval worker stopped before publishing a result",
            true,
            request_id,
        ),
    }
}

fn conflict(code: &'static str, message: &'static str, request_id: &RequestId) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, code, message, false, request_id)
}
