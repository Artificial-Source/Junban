//! Transport-only daily briefing and typed response history routes.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Extension, Path, State, rejection::JsonRejection},
    http::HeaderMap,
};
use junban_domain::{AiMessageId, AiResponseRewriteKind, AiSessionId};
use serde::Deserialize;
use utoipa::ToSchema;

use crate::{
    MAX_AI_RESPONSE_BODY_BYTES, RequestId, ServerState,
    ai_chat::AiSse,
    ai_response_actions::{EditInput, parse_focused_task_id},
    error::{ApiError, extract_json_with_limit, operation_id, parse_path_id},
};

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct EmptyAiResponseActionRequest {}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct EditAiResponseRequest {
    pub message: String,
    #[schema(value_type = Option<String>, format = Uuid)]
    pub focused_task_id: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/v1/ai/sessions/{session_id}/daily-briefing",
    operation_id = "create_ai_daily_briefing",
    request_body = EmptyAiResponseActionRequest,
    params(
        ("session_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")
    ),
    responses(
        (status = 200, content_type = "text/event-stream", body = crate::ai_chat::AiRunSseEnvelope),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn create_ai_daily_briefing(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    payload: Result<Json<EmptyAiResponseActionRequest>, JsonRejection>,
) -> Result<AiSse, ApiError> {
    let session_id = parse_path_id(&session_id, AiSessionId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let _ = extract_json_with_limit(payload, &request_id, MAX_AI_RESPONSE_BODY_BYTES)?;
    let permit = acquire_sse(&state, &request_id)?;
    let serial = Arc::clone(&state.ai_reconfigure).lock_owned().await;
    crate::ai_response_actions::daily_briefing(
        state,
        request_id,
        session_id,
        operation_id,
        permit,
        serial,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/v1/ai/sessions/{session_id}/messages/{message_id}/edit",
    operation_id = "edit_ai_response",
    request_body = EditAiResponseRequest,
    params(
        ("session_id" = String, Path, format = Uuid),
        ("message_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")
    ),
    responses(
        (status = 200, content_type = "text/event-stream", body = crate::ai_chat::AiRunSseEnvelope),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn edit_ai_response(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path((session_id, message_id)): Path<(String, String)>,
    headers: HeaderMap,
    payload: Result<Json<EditAiResponseRequest>, JsonRejection>,
) -> Result<AiSse, ApiError> {
    let session_id = parse_path_id(&session_id, AiSessionId::parse, &request_id)?;
    let message_id = parse_path_id(&message_id, AiMessageId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let body = extract_json_with_limit(payload, &request_id, MAX_AI_RESPONSE_BODY_BYTES)?;
    let focused_task_id = parse_focused_task_id(body.focused_task_id.as_deref(), &request_id)?;
    let permit = acquire_sse(&state, &request_id)?;
    let serial = Arc::clone(&state.ai_reconfigure).lock_owned().await;
    crate::ai_response_actions::rewrite_response(
        state,
        request_id,
        session_id,
        message_id,
        operation_id,
        AiResponseRewriteKind::Edit,
        Some(EditInput {
            message: body.message,
            focused_task_id,
        }),
        permit,
        serial,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/v1/ai/sessions/{session_id}/messages/{message_id}/retry",
    operation_id = "retry_ai_response",
    request_body = EmptyAiResponseActionRequest,
    params(
        ("session_id" = String, Path, format = Uuid),
        ("message_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")
    ),
    responses(
        (status = 200, content_type = "text/event-stream", body = crate::ai_chat::AiRunSseEnvelope),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn retry_ai_response(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path((session_id, message_id)): Path<(String, String)>,
    headers: HeaderMap,
    payload: Result<Json<EmptyAiResponseActionRequest>, JsonRejection>,
) -> Result<AiSse, ApiError> {
    empty_rewrite(
        state,
        request_id,
        session_id,
        message_id,
        headers,
        payload,
        AiResponseRewriteKind::Retry,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/v1/ai/sessions/{session_id}/messages/{message_id}/regenerate",
    operation_id = "regenerate_ai_response",
    request_body = EmptyAiResponseActionRequest,
    params(
        ("session_id" = String, Path, format = Uuid),
        ("message_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")
    ),
    responses(
        (status = 200, content_type = "text/event-stream", body = crate::ai_chat::AiRunSseEnvelope),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn regenerate_ai_response(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path((session_id, message_id)): Path<(String, String)>,
    headers: HeaderMap,
    payload: Result<Json<EmptyAiResponseActionRequest>, JsonRejection>,
) -> Result<AiSse, ApiError> {
    empty_rewrite(
        state,
        request_id,
        session_id,
        message_id,
        headers,
        payload,
        AiResponseRewriteKind::Regenerate,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn empty_rewrite(
    state: ServerState,
    request_id: RequestId,
    session_id: String,
    message_id: String,
    headers: HeaderMap,
    payload: Result<Json<EmptyAiResponseActionRequest>, JsonRejection>,
    kind: AiResponseRewriteKind,
) -> Result<AiSse, ApiError> {
    let session_id = parse_path_id(&session_id, AiSessionId::parse, &request_id)?;
    let message_id = parse_path_id(&message_id, AiMessageId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let _ = extract_json_with_limit(payload, &request_id, MAX_AI_RESPONSE_BODY_BYTES)?;
    let permit = acquire_sse(&state, &request_id)?;
    let serial = Arc::clone(&state.ai_reconfigure).lock_owned().await;
    crate::ai_response_actions::rewrite_response(
        state,
        request_id,
        session_id,
        message_id,
        operation_id,
        kind,
        None,
        permit,
        serial,
    )
    .await
}

fn acquire_sse(
    state: &ServerState,
    request_id: &RequestId,
) -> Result<crate::sse::SseConnectionPermit, ApiError> {
    state.try_acquire_sse().ok_or_else(|| {
        ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "sse_connection_limit",
            "too many concurrent event streams",
            true,
            request_id,
        )
    })
}
