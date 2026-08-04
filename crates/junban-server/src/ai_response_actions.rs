//! Private durable preparation for daily and typed response actions.

use junban_app::{ReserveDailyAiResponseRequest, RewriteAiResponseRequest};
use junban_domain::{
    AiMessage, AiMessageId, AiMessageRole, AiMessageStatus, AiResponseRewriteKind, AiRunPhase,
    AiSessionId, OperationId, TaskId,
};

use crate::{
    RequestId, ServerState,
    ai_chat::{
        AiSse, PreparedPrompt, RUN_GENERATION, preflight_prepared_response,
        resume_prepared_response, start_prepared_response,
    },
    ai_context::load_recent_messages,
    ai_identity::AiResponseIdentity,
    error::{ApiError, validation_error},
    sse::SseConnectionPermit,
};

pub(crate) struct EditInput {
    pub message: String,
    pub focused_task_id: Option<TaskId>,
}

pub(crate) async fn daily_briefing(
    state: ServerState,
    request_id: RequestId,
    session_id: AiSessionId,
    operation_id: OperationId,
    permit: SseConnectionPermit,
    serial: tokio::sync::OwnedMutexGuard<()>,
) -> Result<AiSse, ApiError> {
    let identity = AiResponseIdentity::derive(operation_id);
    state
        .service
        .ensure_ai_response_current(identity.run_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    if let Some(run) = match state.service.get_ai_run_state(identity.run_id).await {
        Ok(run) => Some(run),
        Err(junban_app::AppError::NotFound) => None,
        Err(error) => return Err(ApiError::from_app(error, &request_id)),
    } {
        let assistant = state
            .service
            .get_ai_message(identity.assistant_message_id)
            .await
            .map_err(|error| ApiError::from_app(error, &request_id))?;
        let briefing_date = assistant
            .content
            .briefing_date
            .clone()
            .ok_or_else(|| ApiError::from_app(junban_app::AppError::Conflict, &request_id))?;
        let prepared = state
            .service
            .reserve_daily_ai_response(
                operation_id,
                daily_request(identity, session_id, briefing_date),
            )
            .await
            .map_err(|error| ApiError::from_app(error, &request_id))?;
        if prepared.run != run || prepared.run.session_id != session_id {
            return Err(ApiError::from_app(
                junban_app::AppError::Conflict,
                &request_id,
            ));
        }
        return resume_prepared_response(
            &state,
            identity,
            prepared.run,
            permit,
            serial,
            &request_id,
        )
        .await;
    }

    let briefing_date = jiff::Zoned::now().date().to_string();
    let history = load_recent_messages(&state.service, session_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let provider = preflight_prepared_response(
        &state,
        &request_id,
        session_id,
        &history,
        PreparedPrompt::DailyBriefing {
            briefing_date: &briefing_date,
        },
    )
    .await?;
    let service = state.service.clone();
    let request = daily_request(identity, session_id, briefing_date);
    start_prepared_response(
        state,
        request_id,
        identity,
        permit,
        serial,
        provider,
        async move {
            service
                .reserve_daily_ai_response(operation_id, request)
                .await
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn rewrite_response(
    state: ServerState,
    request_id: RequestId,
    session_id: AiSessionId,
    target_message_id: AiMessageId,
    operation_id: OperationId,
    kind: AiResponseRewriteKind,
    edit: Option<EditInput>,
    permit: SseConnectionPermit,
    serial: tokio::sync::OwnedMutexGuard<()>,
) -> Result<AiSse, ApiError> {
    let identity = AiResponseIdentity::derive(operation_id);
    state
        .service
        .ensure_ai_response_current(identity.run_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;

    if let Some(run) = match state.service.get_ai_run_state(identity.run_id).await {
        Ok(run) => Some(run),
        Err(junban_app::AppError::NotFound) => None,
        Err(error) => return Err(ApiError::from_app(error, &request_id)),
    } {
        let user = state
            .service
            .get_ai_message(identity.user_message_id)
            .await
            .map_err(|error| ApiError::from_app(error, &request_id))?;
        let (message, focused_task_id) = replay_input(kind, edit, &user, &request_id)?;
        let prepared = state
            .service
            .rewrite_ai_response(
                operation_id,
                rewrite_request(
                    identity,
                    session_id,
                    target_message_id,
                    kind,
                    message,
                    focused_task_id,
                ),
            )
            .await
            .map_err(|error| ApiError::from_app(error, &request_id))?;
        if prepared.run != run || prepared.run.session_id != session_id {
            return Err(ApiError::from_app(
                junban_app::AppError::Conflict,
                &request_id,
            ));
        }
        return resume_prepared_response(
            &state,
            identity,
            prepared.run,
            permit,
            serial,
            &request_id,
        )
        .await;
    }

    let history = load_recent_messages(&state.service, session_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let target = history
        .iter()
        .find(|message| message.id == target_message_id)
        .ok_or_else(|| ApiError::from_app(junban_app::AppError::NotFound, &request_id))?;
    let (message, focused_task_id, suffix_start) =
        new_action_input(&state, kind, edit, target, &history, &request_id).await?;
    let retained_history: Vec<_> = history
        .iter()
        .filter(|entry| entry.sequence < suffix_start)
        .cloned()
        .collect();
    let provider = preflight_prepared_response(
        &state,
        &request_id,
        session_id,
        &retained_history,
        PreparedPrompt::User {
            message: &message,
            focused_task_id,
        },
    )
    .await?;
    let service = state.service.clone();
    let request = rewrite_request(
        identity,
        session_id,
        target_message_id,
        kind,
        message,
        focused_task_id,
    );
    start_prepared_response(
        state,
        request_id,
        identity,
        permit,
        serial,
        provider,
        async move { service.rewrite_ai_response(operation_id, request).await },
    )
    .await
}

fn daily_request(
    identity: AiResponseIdentity,
    session_id: AiSessionId,
    briefing_date: String,
) -> ReserveDailyAiResponseRequest {
    ReserveDailyAiResponseRequest {
        session_id,
        briefing_date,
        turn_id: identity.turn_id,
        assistant_message_id: identity.assistant_message_id,
        run_id: identity.run_id,
        generation: RUN_GENERATION,
    }
}

fn rewrite_request(
    identity: AiResponseIdentity,
    session_id: AiSessionId,
    target_message_id: AiMessageId,
    kind: AiResponseRewriteKind,
    message: String,
    focused_task_id: Option<TaskId>,
) -> RewriteAiResponseRequest {
    RewriteAiResponseRequest {
        kind,
        session_id,
        target_message_id,
        message,
        focused_task_id,
        turn_id: identity.turn_id,
        user_message_id: identity.user_message_id,
        assistant_message_id: identity.assistant_message_id,
        run_id: identity.run_id,
        generation: RUN_GENERATION,
    }
}

fn replay_input(
    kind: AiResponseRewriteKind,
    edit: Option<EditInput>,
    user: &AiMessage,
    request_id: &RequestId,
) -> Result<(String, Option<TaskId>), ApiError> {
    if kind == AiResponseRewriteKind::Edit {
        let edit =
            edit.ok_or_else(|| ApiError::from_app(junban_app::AppError::Conflict, request_id))?;
        return Ok((edit.message, edit.focused_task_id));
    }
    if edit.is_some()
        || user.role != AiMessageRole::User
        || user.status != AiMessageStatus::Completed
    {
        return Err(ApiError::from_app(
            junban_app::AppError::Conflict,
            request_id,
        ));
    }
    Ok((user.content.text.clone(), user.content.focused_task_id))
}

async fn new_action_input(
    state: &ServerState,
    kind: AiResponseRewriteKind,
    edit: Option<EditInput>,
    target: &AiMessage,
    history: &[AiMessage],
    request_id: &RequestId,
) -> Result<(String, Option<TaskId>, u32), ApiError> {
    match kind {
        AiResponseRewriteKind::Edit => {
            if target.role != AiMessageRole::User || target.status != AiMessageStatus::Completed {
                return Err(ApiError::from_app(
                    junban_app::AppError::Conflict,
                    request_id,
                ));
            }
            let edit =
                edit.ok_or_else(|| ApiError::from_app(junban_app::AppError::Conflict, request_id))?;
            Ok((edit.message, edit.focused_task_id, target.sequence))
        }
        AiResponseRewriteKind::Retry | AiResponseRewriteKind::Regenerate => {
            if edit.is_some()
                || target.role != AiMessageRole::Assistant
                || (kind == AiResponseRewriteKind::Retry
                    && !matches!(
                        target.status,
                        AiMessageStatus::Failed | AiMessageStatus::Cancelled
                    ))
                || (kind == AiResponseRewriteKind::Regenerate
                    && target.status != AiMessageStatus::Completed)
                || target.content.briefing_date.is_some()
            {
                return Err(ApiError::from_app(
                    junban_app::AppError::Conflict,
                    request_id,
                ));
            }
            let run = state
                .service
                .get_ai_run_for_assistant(target.id)
                .await
                .map_err(|error| ApiError::from_app(error, request_id))?;
            state
                .service
                .ensure_ai_response_current(run.run_id)
                .await
                .map_err(|error| ApiError::from_app(error, request_id))?;
            let expected = match target.status {
                AiMessageStatus::Completed => AiRunPhase::Completed,
                AiMessageStatus::Failed => AiRunPhase::Failed,
                AiMessageStatus::Cancelled => AiRunPhase::Cancelled,
                _ => {
                    return Err(ApiError::from_app(
                        junban_app::AppError::Conflict,
                        request_id,
                    ));
                }
            };
            if run.state != expected
                || run.session_id != target.session_id
                || run.turn_id != target.turn_id
            {
                return Err(ApiError::from_app(
                    junban_app::AppError::Conflict,
                    request_id,
                ));
            }
            let source: Vec<_> = history
                .iter()
                .filter(|message| {
                    message.turn_id == target.turn_id
                        && message.role == AiMessageRole::User
                        && message.status == AiMessageStatus::Completed
                })
                .collect();
            let [source] = source.as_slice() else {
                return Err(ApiError::from_app(
                    junban_app::AppError::Conflict,
                    request_id,
                ));
            };
            Ok((
                source.content.text.clone(),
                source.content.focused_task_id,
                source.sequence,
            ))
        }
    }
}

pub(crate) fn parse_focused_task_id(
    raw: Option<&str>,
    request_id: &RequestId,
) -> Result<Option<TaskId>, ApiError> {
    raw.map(TaskId::parse)
        .transpose()
        .map_err(|error| validation_error(error, request_id))
}
