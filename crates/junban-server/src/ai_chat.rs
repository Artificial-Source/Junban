//! One-round authenticated POST-response SSE chat orchestration.

use std::{
    convert::Infallible,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};

use axum::response::sse::{Event as SseEvent, KeepAlive, KeepAliveStream, Sse};
use futures_core::Stream;
use jiff::Timestamp;
use junban_ai::{
    ChatMessage, ChatRole, ModelId, NormalizedStreamEvent, ProviderChatRequest, ProviderEndpoint,
    ProviderError, ProviderKind, SecretString, ToolCall, descriptor,
};
use junban_app::{
    AppError, CancelAiResponseRequest, FinishAiResponseRequest, ProposeAiApprovalRequest,
    UpsertAiMessageRequest, UpsertAiRunStateRequest,
};
use junban_domain::{
    AI_ASSISTANT_TEXT_BYTES_MAX, AiMessage, AiMessageContent, AiMessageRole, AiMessageStatus,
    AiRunId, AiRunPhase, AiRunState, AiSessionId, AiSessionStatus, AiToolEvent, AiToolEventType,
    OperationId, TaskId,
};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use utoipa::ToSchema;

use crate::{
    AiRunGuard, AiRuntimeSupervisor, AiTerminalOutcome, RequestId, ServerState,
    ai_context::{
        AiContextError, AiContextMetadata, assemble_context, load_context_memories,
        load_recent_messages,
    },
    ai_identity::AiResponseIdentity,
    ai_tool_executor::{ToolExecContext, execute_tool},
    ai_tool_registry::{ToolEffect, tool_specs, validate_tool_call},
    ai_tool_transcript::bound_chat_read_result,
    error::{ApiError, validation_error},
    routes_ai::CreateAiResponseRequest,
    sse::SseConnectionPermit,
};

pub const AI_RESPONSE_CHANNEL_CAPACITY: usize = 64;
const RUN_GENERATION: u64 = 1;
const STATIC_FAILED_CODE: &str = "ai_run_failed";
const MAX_PROVIDER_ROUNDS: u8 = 8;
const MAX_PROVIDER_CALL_ID_BYTES: usize = 256;

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AiRunSseEnvelope {
    pub version: u8,
    #[schema(value_type = String, format = Uuid)]
    pub run_id: String,
    pub generation: u64,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub event_type: AiRunEventType,
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AiRunEventType {
    RunStarted,
    TextDelta,
    ReasoningStatus,
    Usage,
    ToolProposed,
    ToolApproved,
    ToolRejected,
    ToolResult,
    RunCompleted,
    RunCancelled,
    RunFailed,
}

pub struct AiResponseStream {
    receiver: mpsc::Receiver<Result<SseEvent, Infallible>>,
    _permit: SseConnectionPermit,
    cancel: Option<(Arc<AiRuntimeSupervisor>, AiRunId)>,
}

impl Stream for AiResponseStream {
    type Item = Result<SseEvent, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.poll_recv(context)
    }
}

impl Drop for AiResponseStream {
    fn drop(&mut self) {
        if let Some((runtime, run_id)) = self.cancel.take() {
            let _ = runtime.cancel_run(run_id);
        }
    }
}

pub async fn start_response(
    state: ServerState,
    request_id: &RequestId,
    session_id: AiSessionId,
    operation_id: OperationId,
    body: CreateAiResponseRequest,
    permit: SseConnectionPermit,
    serial: tokio::sync::OwnedMutexGuard<()>,
) -> Result<Sse<KeepAliveStream<AiResponseStream>>, ApiError> {
    validate_user_message(&body.message, request_id)?;
    let focused_task_id = body
        .focused_task_id
        .as_deref()
        .map(TaskId::parse)
        .transpose()
        .map_err(|error| validation_error(error, request_id))?;
    let identity = AiResponseIdentity::derive(operation_id);

    match state.service.get_ai_run_state(identity.run_id).await {
        Ok(run) => {
            verify_user_receipt(
                &state,
                identity,
                session_id,
                &body.message,
                focused_task_id,
                request_id,
            )
            .await?;
            validate_run_identity(&run, identity, session_id, request_id)?;
            if !run.state.is_terminal() {
                if state
                    .ai_runtime()
                    .is_active_generation(identity.run_id, RUN_GENERATION)
                {
                    return Err(active_duplicate(request_id));
                }
                let run = reconcile_inactive_response(&state, identity, &run)
                    .await
                    .map_err(|error| ApiError::from_app(error, request_id))?;
                return replay_response(&state, identity, run, permit, serial, request_id).await;
            }
            return replay_response(&state, identity, run, permit, serial, request_id).await;
        }
        Err(AppError::NotFound) => {}
        Err(error) => return Err(ApiError::from_app(error, request_id)),
    }

    // A prior request may have stopped after the user or assistant-start receipt
    // but before creating its run row. Verify the exact user receipt, complete the
    // deterministic preflight, and reconcile without provider admission or egress.
    match state.service.get_ai_message(identity.user_message_id).await {
        Ok(_) => {
            verify_user_receipt(
                &state,
                identity,
                session_id,
                &body.message,
                focused_task_id,
                request_id,
            )
            .await?;
            persist_assistant_placeholder(&state, identity, session_id)
                .await
                .map_err(|error| ApiError::from_app(error, request_id))?;
            let running = persist_running(&state, identity, session_id)
                .await
                .map_err(|error| ApiError::from_app(error, request_id))?;
            let run = reconcile_inactive_response(&state, identity, &running)
                .await
                .map_err(|error| ApiError::from_app(error, request_id))?;
            return replay_response(&state, identity, run, permit, serial, request_id).await;
        }
        Err(AppError::NotFound) => {}
        Err(error) => return Err(ApiError::from_app(error, request_id)),
    }

    let session = state
        .service
        .get_ai_session(session_id)
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?;
    if session.status != AiSessionStatus::Active {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "ai_session_inactive",
            "AI session is not active",
            false,
            request_id,
        ));
    }

    let settings = state
        .service
        .get_settings()
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?;
    let ai = settings.ai;
    if !ai.enabled {
        return Err(config_error(
            "confirmed AI configuration is disabled",
            request_id,
        ));
    }
    let provider = ai
        .provider
        .ok_or_else(|| config_error("confirmed AI provider is unavailable", request_id))?;
    let model = ai
        .model
        .as_ref()
        .ok_or_else(|| config_error("confirmed AI model is unavailable", request_id))?;
    let base_url = ai
        .base_url
        .as_ref()
        .ok_or_else(|| config_error("confirmed AI base URL is unavailable", request_id))?;

    let focused_task = match focused_task_id {
        Some(task_id) => Some(
            state
                .service
                .get_task(task_id)
                .await
                .map_err(|error| ApiError::from_app(error, request_id))?,
        ),
        None => None,
    };
    let history = load_recent_messages(&state.service, session_id)
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?;
    let memories = load_context_memories(&state.service, session_id)
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?;
    let context = assemble_context(
        ai.custom_instructions.as_str(),
        &memories,
        focused_task.as_ref(),
        &history,
        &body.message,
    )
    .map_err(|error| context_error(error, request_id))?;

    let credential = match ai.credential_id {
        Some(id) => Some(state.service.resolve_ai_secret(id).await.map_err(
            |error| match error {
                AppError::NotFound => {
                    config_error("confirmed AI credential is unavailable", request_id)
                }
                other => ApiError::from_app(other, request_id),
            },
        )?),
        None => None,
    };
    let endpoint = ProviderEndpoint::resolve(
        descriptor(provider),
        Some(base_url.as_str()),
        credential
            .as_ref()
            .map(|secret| SecretString::new(secret.expose())),
    )
    .map_err(|_| config_error("confirmed AI endpoint is invalid", request_id))?;
    let request = ProviderChatRequest {
        model: ModelId::new(model.as_str())
            .map_err(|_| config_error("confirmed AI model is invalid", request_id))?,
        messages: context.messages,
        tools: tool_specs().to_vec(),
        max_output_tokens: None,
    };
    request
        .validate_bounds()
        .map_err(|_| config_error("assembled AI request is invalid", request_id))?;

    persist_user(&state, identity, session_id, &body.message, focused_task_id)
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?;
    persist_assistant_placeholder(&state, identity, session_id)
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?;
    let running = persist_running(&state, identity, session_id)
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?;

    let guard = match state
        .ai_runtime()
        .admit_run(identity.run_id, RUN_GENERATION)
    {
        Ok(guard) => guard,
        Err(_) => {
            finish_response(
                &state.service,
                identity,
                identity.finish_operation_id,
                &running,
                AiRunPhase::Failed,
                AiMessageContent::text("").expect("empty assistant content is valid"),
            )
            .await
            .map_err(|error| ApiError::from_app(error, request_id))?;
            let run = state
                .service
                .get_ai_run_state(identity.run_id)
                .await
                .map_err(|error| ApiError::from_app(error, request_id))?;
            return replay_response(&state, identity, run, permit, serial, request_id).await;
        }
    };
    let (sender, receiver) = mpsc::channel(AI_RESPONSE_CHANNEL_CAPACITY);
    let runtime = Arc::clone(state.ai_runtime());
    let cancel = Some((runtime, identity.run_id));
    let durable = DurableRun {
        service: state.service.clone(),
        identity,
        running,
    };
    // Generation cannot start until the full preflight/persistence/admission
    // sequence releases the same permit used by AI reconfiguration.
    drop(serial);
    tokio::spawn(orchestrate(
        durable,
        guard,
        endpoint,
        request,
        context.metadata,
        sender,
    ));

    Ok(sse(AiResponseStream {
        receiver,
        _permit: permit,
        cancel,
    }))
}

async fn verify_user_receipt(
    state: &ServerState,
    identity: AiResponseIdentity,
    session_id: AiSessionId,
    message: &str,
    focused_task_id: Option<TaskId>,
    request_id: &RequestId,
) -> Result<(), ApiError> {
    persist_user(state, identity, session_id, message, focused_task_id)
        .await
        .map(|_| ())
        .map_err(|error| ApiError::from_app(error, request_id))
}

async fn persist_user(
    state: &ServerState,
    identity: AiResponseIdentity,
    session_id: AiSessionId,
    message: &str,
    focused_task_id: Option<TaskId>,
) -> Result<junban_app::CommittedMutation, AppError> {
    let mut content = AiMessageContent::text(message.to_owned())?;
    content.focused_task_id = focused_task_id;
    state
        .service
        .upsert_ai_message(
            identity.user_message_operation_id,
            UpsertAiMessageRequest {
                message_id: identity.user_message_id,
                session_id,
                turn_id: identity.turn_id,
                role: AiMessageRole::User,
                status: AiMessageStatus::Completed,
                content,
            },
        )
        .await
}

async fn persist_assistant_placeholder(
    state: &ServerState,
    identity: AiResponseIdentity,
    session_id: AiSessionId,
) -> Result<junban_app::CommittedMutation, AppError> {
    state
        .service
        .upsert_ai_message(
            identity.assistant_start_operation_id,
            UpsertAiMessageRequest {
                message_id: identity.assistant_message_id,
                session_id,
                turn_id: identity.turn_id,
                role: AiMessageRole::Assistant,
                status: AiMessageStatus::Streaming,
                content: AiMessageContent::text("")?,
            },
        )
        .await
}

async fn persist_running(
    state: &ServerState,
    identity: AiResponseIdentity,
    session_id: AiSessionId,
) -> Result<AiRunState, AppError> {
    let now = Timestamp::now();
    let running = AiRunState {
        run_id: identity.run_id,
        session_id,
        turn_id: identity.turn_id,
        assistant_message_id: identity.assistant_message_id,
        generation: RUN_GENERATION,
        state: AiRunPhase::Running,
        approval_id: None,
        created_at: now,
        updated_at: now,
    };
    state
        .service
        .upsert_ai_run_state(
            identity.running_run_operation_id,
            UpsertAiRunStateRequest {
                state: running.clone(),
            },
        )
        .await?;
    Ok(running)
}

fn validate_run_identity(
    run: &AiRunState,
    identity: AiResponseIdentity,
    session_id: AiSessionId,
    request_id: &RequestId,
) -> Result<(), ApiError> {
    if run.run_id != identity.run_id
        || run.session_id != session_id
        || run.turn_id != identity.turn_id
        || run.assistant_message_id != identity.assistant_message_id
        || run.generation != RUN_GENERATION
    {
        return Err(response_state_conflict(request_id));
    }
    Ok(())
}

async fn reconcile_inactive_response(
    state: &ServerState,
    identity: AiResponseIdentity,
    running: &AiRunState,
) -> Result<AiRunState, AppError> {
    let assistant = state
        .service
        .get_ai_message(identity.assistant_message_id)
        .await
        .map_err(|error| match error {
            AppError::NotFound => AppError::Conflict,
            other => other,
        })?;
    if assistant.id != identity.assistant_message_id
        || assistant.session_id != running.session_id
        || assistant.turn_id != identity.turn_id
        || assistant.role != AiMessageRole::Assistant
        || assistant.status != AiMessageStatus::Streaming
    {
        return Err(AppError::Conflict);
    }
    finish_response(
        &state.service,
        identity,
        identity.finish_operation_id,
        running,
        AiRunPhase::Cancelled,
        assistant.content,
    )
    .await?;
    state.service.get_ai_run_state(identity.run_id).await
}

async fn replay_response(
    state: &ServerState,
    identity: AiResponseIdentity,
    run: AiRunState,
    permit: SseConnectionPermit,
    serial: tokio::sync::OwnedMutexGuard<()>,
    request_id: &RequestId,
) -> Result<Sse<KeepAliveStream<AiResponseStream>>, ApiError> {
    if run.run_id != identity.run_id
        || run.turn_id != identity.turn_id
        || run.assistant_message_id != identity.assistant_message_id
        || run.generation != RUN_GENERATION
    {
        return Err(replay_unavailable(request_id));
    }
    let assistant = state
        .service
        .get_ai_message(identity.assistant_message_id)
        .await
        .map_err(|_| replay_unavailable(request_id))?;
    validate_replay_message(&assistant, &run, identity, request_id)?;
    let (sender, receiver) = mpsc::channel(AI_RESPONSE_CHANNEL_CAPACITY);
    drop(serial);
    tokio::spawn(async move {
        let mut sequence = 1;
        if !send_envelope(
            &sender,
            envelope(
                identity.run_id,
                sequence,
                AiRunEventType::RunStarted,
                json!({"replay": true}),
            ),
        )
        .await
        {
            return;
        }
        let mut text_offset = 0_usize;
        for event in &assistant.content.tool_events {
            let event_offset = event.assistant_utf8_offset as usize;
            if text_offset < event_offset {
                sequence += 1;
                if !send_envelope(
                    &sender,
                    envelope(
                        identity.run_id,
                        sequence,
                        AiRunEventType::TextDelta,
                        json!({"text": &assistant.content.text[text_offset..event_offset]}),
                    ),
                )
                .await
                {
                    return;
                }
            }
            sequence += 1;
            if !send_envelope(
                &sender,
                envelope(
                    identity.run_id,
                    sequence,
                    replay_tool_event_type(event.event_type),
                    event.payload.clone(),
                ),
            )
            .await
            {
                return;
            }
            text_offset = event_offset;
        }
        if text_offset < assistant.content.text.len() {
            sequence += 1;
            if !send_envelope(
                &sender,
                envelope(
                    identity.run_id,
                    sequence,
                    AiRunEventType::TextDelta,
                    json!({"text": &assistant.content.text[text_offset..]}),
                ),
            )
            .await
            {
                return;
            }
        }
        sequence += 1;
        let (event_type, payload) = terminal_event(run.state, identity.assistant_message_id);
        let _ = send_envelope(
            &sender,
            envelope(identity.run_id, sequence, event_type, payload),
        )
        .await;
    });
    Ok(sse(AiResponseStream {
        receiver,
        _permit: permit,
        cancel: None,
    }))
}

fn validate_replay_message(
    message: &AiMessage,
    run: &AiRunState,
    identity: AiResponseIdentity,
    request_id: &RequestId,
) -> Result<(), ApiError> {
    let expected_status = match run.state {
        AiRunPhase::Completed => AiMessageStatus::Completed,
        AiRunPhase::Cancelled => AiMessageStatus::Cancelled,
        AiRunPhase::Failed => AiMessageStatus::Failed,
        AiRunPhase::Running | AiRunPhase::AwaitingApproval | AiRunPhase::Dispatching => {
            return Err(replay_unavailable(request_id));
        }
    };
    if message.id != identity.assistant_message_id
        || run.assistant_message_id != identity.assistant_message_id
        || message.session_id != run.session_id
        || message.turn_id != run.turn_id
        || message.role != AiMessageRole::Assistant
        || message.status != expected_status
    {
        return Err(replay_unavailable(request_id));
    }
    Ok(())
}

struct DurableRun {
    service: crate::sse::AppService,
    identity: AiResponseIdentity,
    running: AiRunState,
}

#[derive(Debug, Clone)]
struct LastTool {
    name: String,
    canonical_arguments: String,
    result_json: Option<String>,
}

#[derive(Debug, Clone)]
struct ProposedTool {
    provider_call_id: String,
    name: String,
    arguments: String,
}

#[derive(Debug)]
struct RoundSnapshot {
    completed: bool,
    text: String,
    proposed: Option<ProposedTool>,
}

async fn orchestrate(
    durable: DurableRun,
    guard: AiRunGuard,
    endpoint: ProviderEndpoint,
    mut request: ProviderChatRequest,
    metadata: AiContextMetadata,
    sender: mpsc::Sender<Result<SseEvent, Infallible>>,
) {
    let started = envelope(
        durable.identity.run_id,
        1,
        AiRunEventType::RunStarted,
        json!({"context": metadata}),
    );
    if !send_envelope(&sender, started).await {
        guard.cancel();
    }

    let accumulator = Mutex::new(StreamAccumulator::new(durable.identity.run_id, &endpoint));
    let mut last_tool: Option<LastTool> = None;
    let mut tool_events = Vec::<AiToolEvent>::new();
    let mut terminal: Option<AiTerminalOutcome> = None;
    let mut terminal_operation_id = durable.identity.finish_operation_id;
    let mut dispatched_terminal: Option<(AiTerminalOutcome, String)> = None;

    for round in 1..=MAX_PROVIDER_ROUNDS {
        {
            accumulator
                .lock()
                .expect("AI stream accumulator poisoned")
                .begin_round();
        }
        request.tools = tool_specs().to_vec();
        if request.validate_bounds().is_err() {
            terminal = Some(AiTerminalOutcome::Failed);
            break;
        }

        let result = guard
            .chat_stream(&endpoint, &request, |event| {
                let sender = sender.clone();
                let guard = &guard;
                let accumulator = &accumulator;
                async move {
                    let permit = tokio::select! {
                        () = guard.wait_cancelled() => return Err(ProviderError::Cancelled),
                        permit = sender.reserve_owned() => permit.map_err(|_| ProviderError::Cancelled)?,
                    };
                    guard
                        .commit_provider_output(|| {
                            let mut accumulator =
                                accumulator.lock().expect("AI stream accumulator poisoned");
                            match accumulator.accept(event)? {
                                Some(envelope) => {
                                    let event = encode_envelope(envelope).ok_or_else(|| {
                                        ProviderError::stream("AI output encoding failed")
                                    })?;
                                    permit.send(Ok(event));
                                }
                                None => drop(permit),
                            }
                            Ok(())
                        })
                        .unwrap_or(Err(ProviderError::Cancelled))
                }
            })
            .await;

        let snapshot = accumulator
            .lock()
            .expect("AI stream accumulator poisoned")
            .round_snapshot();
        match result {
            Err(ProviderError::Cancelled) => {
                terminal = Some(AiTerminalOutcome::Cancelled);
                break;
            }
            Err(_) => {
                terminal = Some(AiTerminalOutcome::Failed);
                break;
            }
            Ok(()) if !snapshot.completed => {
                terminal = Some(AiTerminalOutcome::Failed);
                break;
            }
            Ok(()) => {}
        }

        let Some(proposed) = snapshot.proposed else {
            terminal = Some(AiTerminalOutcome::Completed);
            break;
        };
        let (action, canonical_arguments) =
            match validate_tool_call(&proposed.name, &proposed.arguments) {
                Ok(validated) => validated,
                Err(_) => {
                    terminal = Some(AiTerminalOutcome::Failed);
                    break;
                }
            };

        if action.effect() == ToolEffect::Read {
            let settings = match durable.service.get_settings().await {
                Ok(settings) => settings,
                Err(_) => {
                    terminal = Some(AiTerminalOutcome::Failed);
                    break;
                }
            };
            let context = ToolExecContext::with_confirmed_settings(jiff::Zoned::now(), &settings);
            let tool_result = bound_chat_read_result(
                execute_tool(&durable.service, &action, &context, None).await,
            );
            if tool_result.operation_id.is_some() || tool_result.revision.is_some() {
                terminal = Some(AiTerminalOutcome::Failed);
                break;
            }
            let result_json = match serde_json::to_string(&tool_result) {
                Ok(value) => value,
                Err(_) => {
                    terminal = Some(AiTerminalOutcome::Failed);
                    break;
                }
            };
            let result_value = serde_json::to_value(&tool_result).unwrap_or_else(|_| json!({}));
            let result_event = match durable_tool_event(
                &accumulator,
                AiToolEventType::ToolResult,
                result_value.clone(),
            ) {
                Ok(event) => event,
                Err(_) => {
                    terminal = Some(AiTerminalOutcome::Failed);
                    break;
                }
            };
            tool_events.push(result_event);
            last_tool = Some(LastTool {
                name: action.name().to_owned(),
                canonical_arguments: canonical_arguments.clone(),
                result_json: Some(result_json.clone()),
            });
            let read_content = assistant_content(
                accumulator
                    .lock()
                    .expect("AI stream accumulator poisoned")
                    .assistant
                    .clone(),
                last_tool.clone(),
                tool_events.clone(),
            );
            if durable
                .service
                .upsert_ai_message(
                    durable
                        .identity
                        .round(round)
                        .assistant_tool_update_operation_id,
                    UpsertAiMessageRequest {
                        message_id: durable.identity.assistant_message_id,
                        session_id: durable.running.session_id,
                        turn_id: durable.running.turn_id,
                        role: AiMessageRole::Assistant,
                        status: AiMessageStatus::Streaming,
                        content: read_content,
                    },
                )
                .await
                .is_err()
                || !send_guarded_event(
                    &guard,
                    &sender,
                    &accumulator,
                    AiRunEventType::ToolResult,
                    result_value,
                )
                .await
            {
                terminal = Some(if guard.is_live() {
                    AiTerminalOutcome::Failed
                } else {
                    AiTerminalOutcome::Cancelled
                });
                break;
            }
            append_tool_exchange(
                &mut request,
                snapshot.text,
                proposed.provider_call_id,
                action.name(),
                canonical_arguments,
                result_json,
            );
            if round == MAX_PROVIDER_ROUNDS {
                terminal = Some(AiTerminalOutcome::Failed);
                break;
            }
            continue;
        }

        let round_identity = durable.identity.round(round);
        let proposal_permit = tokio::select! {
            () = guard.wait_cancelled() => {
                terminal = Some(AiTerminalOutcome::Cancelled);
                break;
            }
            permit = sender.clone().reserve_owned() => match permit {
                Ok(permit) => permit,
                Err(_) => {
                    guard.cancel();
                    terminal = Some(AiTerminalOutcome::Cancelled);
                    break;
                }
            }
        };
        let pending_tool = LastTool {
            name: action.name().to_owned(),
            canonical_arguments: canonical_arguments.clone(),
            result_json: None,
        };
        last_tool = Some(pending_tool.clone());
        let proposal_content = assistant_content(
            accumulator
                .lock()
                .expect("AI stream accumulator poisoned")
                .assistant
                .clone(),
            Some(pending_tool),
            tool_events.clone(),
        );
        if guard.await_approval(round_identity.approval_id).is_err() {
            drop(proposal_permit);
            terminal = Some(AiTerminalOutcome::Cancelled);
            break;
        }
        let proposed_durably = durable
            .service
            .propose_ai_approval(
                round_identity.propose_operation_id,
                ProposeAiApprovalRequest {
                    approval_id: round_identity.approval_id,
                    session_id: durable.running.session_id,
                    turn_id: durable.running.turn_id,
                    run_id: durable.running.run_id,
                    generation: durable.running.generation,
                    tool_name: action.name().to_owned(),
                    arguments_json: canonical_arguments.clone(),
                    assistant_content: proposal_content,
                },
            )
            .await;
        if proposed_durably.is_err() {
            let _ = guard.abandon_approval(round_identity.approval_id);
            drop(proposal_permit);
            terminal = Some(if guard.is_live() {
                AiTerminalOutcome::Failed
            } else {
                AiTerminalOutcome::Cancelled
            });
            break;
        }
        let approval = match durable
            .service
            .get_ai_approval(round_identity.approval_id)
            .await
        {
            Ok(approval) => approval,
            Err(_) => {
                drop(proposal_permit);
                guard.cancel();
                terminal = Some(AiTerminalOutcome::Cancelled);
                break;
            }
        };
        let persisted_assistant = match durable
            .service
            .get_ai_message(durable.identity.assistant_message_id)
            .await
        {
            Ok(message) => message,
            Err(_) => {
                drop(proposal_permit);
                guard.cancel();
                terminal = Some(AiTerminalOutcome::Cancelled);
                break;
            }
        };
        let Some(proposal_event) = persisted_assistant
            .content
            .tool_events
            .last()
            .filter(|event| event.event_type == AiToolEventType::ToolProposed)
            .cloned()
        else {
            drop(proposal_permit);
            guard.cancel();
            terminal = Some(AiTerminalOutcome::Cancelled);
            break;
        };
        tool_events = persisted_assistant.content.tool_events;
        let proposal = envelope(
            durable.identity.run_id,
            next_sequence(&accumulator),
            AiRunEventType::ToolProposed,
            proposal_event.payload,
        );
        match encode_envelope(proposal) {
            Some(event) if guard.is_live() => {
                proposal_permit.send(Ok(event));
            }
            _ => {
                drop(proposal_permit);
                guard.cancel();
            }
        }

        let until_expiry = duration_until(approval.expires_at);
        let (notification, expired) = tokio::select! {
            decision = guard.wait_for_decision(approval.id) => (decision.ok(), false),
            () = tokio::time::sleep(until_expiry) => {
                guard.cancel();
                (
                    guard.wait_for_decision(approval.id).await.ok().or(Some(
                        crate::AiDecisionNotification::CancelRequested,
                    )),
                    true,
                )
            }
        };
        if expired {
            terminal_operation_id = round_identity.expire_operation_id;
        }
        match notification {
            Some(crate::AiDecisionNotification::Rejected) => {
                let persisted_assistant = match durable
                    .service
                    .get_ai_message(durable.identity.assistant_message_id)
                    .await
                {
                    Ok(message) => message,
                    Err(_) => {
                        terminal = Some(AiTerminalOutcome::Failed);
                        break;
                    }
                };
                let events = persisted_assistant.content.tool_events.as_slice();
                let [.., rejected_event, result_event] = events else {
                    terminal = Some(AiTerminalOutcome::Failed);
                    break;
                };
                if rejected_event.event_type != AiToolEventType::ToolRejected
                    || result_event.event_type != AiToolEventType::ToolResult
                {
                    terminal = Some(AiTerminalOutcome::Failed);
                    break;
                }
                let Some(result_json) = persisted_assistant.content.tool_result_json.clone() else {
                    terminal = Some(AiTerminalOutcome::Failed);
                    break;
                };
                if !send_guarded_event(
                    &guard,
                    &sender,
                    &accumulator,
                    AiRunEventType::ToolRejected,
                    rejected_event.payload.clone(),
                )
                .await
                    || !send_guarded_event(
                        &guard,
                        &sender,
                        &accumulator,
                        AiRunEventType::ToolResult,
                        result_event.payload.clone(),
                    )
                    .await
                {
                    terminal = Some(AiTerminalOutcome::Cancelled);
                    break;
                }
                tool_events = persisted_assistant.content.tool_events;
                last_tool = Some(LastTool {
                    name: action.name().to_owned(),
                    canonical_arguments: canonical_arguments.clone(),
                    result_json: Some(result_json.clone()),
                });
                append_tool_exchange(
                    &mut request,
                    snapshot.text,
                    proposed.provider_call_id,
                    action.name(),
                    canonical_arguments,
                    result_json,
                );
                if round == MAX_PROVIDER_ROUNDS {
                    terminal = Some(AiTerminalOutcome::Failed);
                    break;
                }
            }
            Some(crate::AiDecisionNotification::Dispatched(payload)) => {
                dispatched_terminal = Some((
                    payload.terminal_outcome(),
                    payload.tool_result_json().to_owned(),
                ));
                break;
            }
            Some(crate::AiDecisionNotification::CancelRequested) | None => {
                terminal = Some(AiTerminalOutcome::Cancelled);
                break;
            }
        }
    }

    if let Some((outcome, tool_result_json)) = dispatched_terminal {
        let persisted_assistant = durable
            .service
            .get_ai_message(durable.identity.assistant_message_id)
            .await
            .ok();
        let persisted_events = persisted_assistant
            .as_ref()
            .map(|message| message.content.tool_events.as_slice())
            .unwrap_or_default();
        let durable_pair = match persisted_events {
            [.., approved_event, result_event]
                if approved_event.event_type == AiToolEventType::ToolApproved
                    && result_event.event_type == AiToolEventType::ToolResult
                    && serde_json::to_string(&result_event.payload)
                        .is_ok_and(|json| json == tool_result_json) =>
            {
                Some((approved_event.payload.clone(), result_event.payload.clone()))
            }
            _ => None,
        };
        let run_phase = match outcome {
            AiTerminalOutcome::Completed => AiRunPhase::Completed,
            AiTerminalOutcome::Failed => AiRunPhase::Failed,
            AiTerminalOutcome::Cancelled => AiRunPhase::Failed,
        };
        drop(guard);
        let Some((approved_payload, result_payload)) = durable_pair else {
            let mut sequence = next_sequence(&accumulator).saturating_sub(1);
            send_static_failed(
                &sender,
                durable.identity.run_id,
                &mut sequence,
                Some(durable.identity.assistant_message_id),
            )
            .await;
            return;
        };
        let _ = send_envelope(
            &sender,
            envelope(
                durable.identity.run_id,
                next_sequence(&accumulator),
                AiRunEventType::ToolApproved,
                approved_payload,
            ),
        )
        .await;
        let _ = send_envelope(
            &sender,
            envelope(
                durable.identity.run_id,
                next_sequence(&accumulator),
                AiRunEventType::ToolResult,
                result_payload,
            ),
        )
        .await;
        let (event_type, payload) =
            terminal_event(run_phase, durable.identity.assistant_message_id);
        let _ = send_envelope(
            &sender,
            envelope(
                durable.identity.run_id,
                next_sequence(&accumulator),
                event_type,
                payload,
            ),
        )
        .await;
        return;
    }

    let proposed = terminal.unwrap_or(AiTerminalOutcome::Failed);
    let Some(outcome) = guard.linearize_terminal(proposed) else {
        return;
    };
    let (_, proposed_phase) = outcome_states(outcome);
    let assistant = accumulator
        .lock()
        .expect("AI stream accumulator poisoned")
        .assistant
        .clone();
    let persisted_phase = finish_response(
        &durable.service,
        durable.identity,
        terminal_operation_id,
        &durable.running,
        proposed_phase,
        assistant_content(assistant, last_tool, tool_events),
    )
    .await;
    drop(guard);

    match persisted_phase {
        Ok(run_phase) => {
            let (event_type, payload) =
                terminal_event(run_phase, durable.identity.assistant_message_id);
            let _ = send_envelope(
                &sender,
                envelope(
                    durable.identity.run_id,
                    next_sequence(&accumulator),
                    event_type,
                    payload,
                ),
            )
            .await;
        }
        Err(_) => {
            let mut sequence = next_sequence(&accumulator).saturating_sub(1);
            send_static_failed(&sender, durable.identity.run_id, &mut sequence, None).await;
        }
    }
}

fn append_tool_exchange(
    request: &mut ProviderChatRequest,
    round_text: String,
    provider_call_id: String,
    tool_name: &str,
    canonical_arguments: String,
    result_json: String,
) {
    request.messages.push(ChatMessage {
        role: ChatRole::Assistant,
        content: round_text,
        tool_call_id: None,
        tool_calls: vec![ToolCall {
            call_id: provider_call_id.clone(),
            name: tool_name.to_owned(),
            arguments: canonical_arguments,
        }],
    });
    request
        .messages
        .push(ChatMessage::tool_result(provider_call_id, result_json));
}

fn assistant_content(
    text: String,
    last_tool: Option<LastTool>,
    tool_events: Vec<AiToolEvent>,
) -> AiMessageContent {
    let mut content = AiMessageContent::text(text).expect("bounded assistant text");
    content.tool_events = tool_events;
    if let Some(last_tool) = last_tool {
        content.tool_name = Some(last_tool.name);
        content.tool_arguments_json = Some(last_tool.canonical_arguments);
        content.tool_result_json = last_tool.result_json;
    }
    content
}

fn durable_tool_event(
    accumulator: &Mutex<StreamAccumulator>,
    event_type: AiToolEventType,
    payload: Value,
) -> Result<AiToolEvent, junban_domain::ValidationError> {
    let offset = accumulator
        .lock()
        .expect("AI stream accumulator poisoned")
        .assistant
        .len();
    AiToolEvent::new(offset, event_type, payload)
}

fn duration_until(expires_at: Timestamp) -> Duration {
    let nanos = expires_at
        .as_nanosecond()
        .saturating_sub(Timestamp::now().as_nanosecond());
    Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX))
}

fn next_sequence(accumulator: &Mutex<StreamAccumulator>) -> u64 {
    let mut accumulator = accumulator.lock().expect("AI stream accumulator poisoned");
    accumulator.sequence += 1;
    accumulator.sequence
}

fn next_envelope(
    accumulator: &Mutex<StreamAccumulator>,
    event_type: AiRunEventType,
    payload: Value,
) -> AiRunSseEnvelope {
    let run_id = accumulator
        .lock()
        .expect("AI stream accumulator poisoned")
        .run_id;
    envelope(run_id, next_sequence(accumulator), event_type, payload)
}

async fn send_guarded_event(
    guard: &AiRunGuard,
    sender: &mpsc::Sender<Result<SseEvent, Infallible>>,
    accumulator: &Mutex<StreamAccumulator>,
    event_type: AiRunEventType,
    payload: Value,
) -> bool {
    let permit = tokio::select! {
        () = guard.wait_cancelled() => return false,
        permit = sender.clone().reserve_owned() => match permit {
            Ok(permit) => permit,
            Err(_) => {
                guard.cancel();
                return false;
            }
        }
    };
    guard
        .commit_provider_output(|| {
            let envelope = next_envelope(accumulator, event_type, payload);
            let Some(event) = encode_envelope(envelope) else {
                return false;
            };
            permit.send(Ok(event));
            true
        })
        .unwrap_or(false)
}

async fn finish_response(
    service: &crate::sse::AppService,
    identity: AiResponseIdentity,
    finish_operation_id: OperationId,
    running: &AiRunState,
    run_phase: AiRunPhase,
    content: AiMessageContent,
) -> Result<AiRunPhase, AppError> {
    if run_phase == AiRunPhase::Cancelled {
        service
            .cancel_ai_response(
                finish_operation_id,
                CancelAiResponseRequest {
                    assistant_message_id: identity.assistant_message_id,
                    session_id: running.session_id,
                    turn_id: running.turn_id,
                    run_id: running.run_id,
                    generation: running.generation,
                    content,
                },
            )
            .await?;
        return Ok(AiRunPhase::Cancelled);
    }
    let message_status = message_status_for_phase(run_phase).ok_or(AppError::Conflict)?;
    let result = service
        .finish_ai_response(
            finish_operation_id,
            FinishAiResponseRequest {
                assistant_message_id: identity.assistant_message_id,
                session_id: running.session_id,
                turn_id: running.turn_id,
                run_id: running.run_id,
                generation: running.generation,
                message_status,
                content: content.clone(),
                run_phase,
                dispatch_operation_id: None,
            },
        )
        .await;
    match result {
        Ok(_) => Ok(run_phase),
        Err(AppError::Validation(_))
            if run_phase != AiRunPhase::Failed || !content.text.is_empty() =>
        {
            service
                .finish_ai_response(
                    finish_operation_id,
                    FinishAiResponseRequest {
                        assistant_message_id: identity.assistant_message_id,
                        session_id: running.session_id,
                        turn_id: running.turn_id,
                        run_id: running.run_id,
                        generation: running.generation,
                        message_status: AiMessageStatus::Failed,
                        content: AiMessageContent::text("")?,
                        run_phase: AiRunPhase::Failed,
                        dispatch_operation_id: None,
                    },
                )
                .await?;
            Ok(AiRunPhase::Failed)
        }
        Err(error) => Err(error),
    }
}

fn message_status_for_phase(phase: AiRunPhase) -> Option<AiMessageStatus> {
    match phase {
        AiRunPhase::Completed => Some(AiMessageStatus::Completed),
        AiRunPhase::Cancelled => Some(AiMessageStatus::Cancelled),
        AiRunPhase::Failed => Some(AiMessageStatus::Failed),
        AiRunPhase::Running | AiRunPhase::AwaitingApproval | AiRunPhase::Dispatching => None,
    }
}

fn outcome_states(outcome: AiTerminalOutcome) -> (AiMessageStatus, AiRunPhase) {
    match outcome {
        AiTerminalOutcome::Completed => (AiMessageStatus::Completed, AiRunPhase::Completed),
        AiTerminalOutcome::Cancelled => (AiMessageStatus::Cancelled, AiRunPhase::Cancelled),
        AiTerminalOutcome::Failed => (AiMessageStatus::Failed, AiRunPhase::Failed),
    }
}

fn replay_tool_event_type(event_type: AiToolEventType) -> AiRunEventType {
    match event_type {
        AiToolEventType::ToolProposed => AiRunEventType::ToolProposed,
        AiToolEventType::ToolApproved => AiRunEventType::ToolApproved,
        AiToolEventType::ToolRejected => AiRunEventType::ToolRejected,
        AiToolEventType::ToolResult => AiRunEventType::ToolResult,
    }
}

fn terminal_event(
    phase: AiRunPhase,
    assistant_message_id: junban_domain::AiMessageId,
) -> (AiRunEventType, Value) {
    let payload = match phase {
        AiRunPhase::Failed => json!({
            "assistant_message_id": assistant_message_id.to_string(),
            "error": STATIC_FAILED_CODE,
        }),
        _ => json!({"assistant_message_id": assistant_message_id.to_string()}),
    };
    let event_type = match phase {
        AiRunPhase::Completed => AiRunEventType::RunCompleted,
        AiRunPhase::Cancelled => AiRunEventType::RunCancelled,
        AiRunPhase::Failed => AiRunEventType::RunFailed,
        AiRunPhase::Running | AiRunPhase::AwaitingApproval | AiRunPhase::Dispatching => {
            AiRunEventType::RunFailed
        }
    };
    (event_type, payload)
}

async fn send_static_failed(
    sender: &mpsc::Sender<Result<SseEvent, Infallible>>,
    run_id: AiRunId,
    sequence: &mut u64,
    assistant_message_id: Option<junban_domain::AiMessageId>,
) {
    *sequence += 1;
    let mut payload = json!({"error": STATIC_FAILED_CODE});
    if let Some(message_id) = assistant_message_id {
        payload["assistant_message_id"] = Value::String(message_id.to_string());
    }
    let _ = send_envelope(
        sender,
        envelope(run_id, *sequence, AiRunEventType::RunFailed, payload),
    )
    .await;
}

struct StreamAccumulator {
    run_id: AiRunId,
    sequence: u64,
    assistant: String,
    reflection: SecretReflectionGuard,
    round_text: String,
    proposed: Option<ProposedTool>,
    completed: bool,
    allow_name_call_id_fallback: bool,
}

impl StreamAccumulator {
    fn new(run_id: AiRunId, endpoint: &ProviderEndpoint) -> Self {
        Self {
            run_id,
            sequence: 1,
            assistant: String::new(),
            reflection: SecretReflectionGuard::new(
                endpoint.credential.as_ref().map(SecretString::expose),
            ),
            round_text: String::new(),
            proposed: None,
            completed: false,
            allow_name_call_id_fallback: endpoint.descriptor.kind
                == ProviderKind::GeminiGenerateContent
                || endpoint.descriptor.preset.as_str() == "ollama",
        }
    }

    fn begin_round(&mut self) {
        self.round_text.clear();
        self.proposed = None;
        self.completed = false;
    }

    fn round_snapshot(&self) -> RoundSnapshot {
        RoundSnapshot {
            completed: self.completed,
            text: self.round_text.clone(),
            proposed: self.proposed.clone(),
        }
    }

    fn accept(
        &mut self,
        event: NormalizedStreamEvent,
    ) -> Result<Option<AiRunSseEnvelope>, ProviderError> {
        let outbound = match event {
            NormalizedStreamEvent::RunStarted => None,
            NormalizedStreamEvent::TextDelta { text } => {
                if !self.reflection.accepts(&text)
                    || self.assistant.len().saturating_add(text.len()) > AI_ASSISTANT_TEXT_BYTES_MAX
                {
                    return Err(ProviderError::stream("provider output rejected"));
                }
                self.assistant.push_str(&text);
                self.round_text.push_str(&text);
                Some((AiRunEventType::TextDelta, json!({"text": text})))
            }
            NormalizedStreamEvent::ReasoningStatus { label } => {
                if !self.reflection.accepts(&label) {
                    return Err(ProviderError::stream("provider output rejected"));
                }
                Some((AiRunEventType::ReasoningStatus, json!({"status": label})))
            }
            NormalizedStreamEvent::Usage {
                input_tokens,
                output_tokens,
            } => Some((
                AiRunEventType::Usage,
                json!({"input_tokens": input_tokens, "output_tokens": output_tokens}),
            )),
            NormalizedStreamEvent::Completed => {
                self.completed = true;
                None
            }
            NormalizedStreamEvent::ToolProposed {
                mut call_id,
                name,
                arguments,
            } => {
                if call_id.is_empty() && self.allow_name_call_id_fallback {
                    call_id.clone_from(&name);
                }
                if self.proposed.is_some()
                    || call_id.is_empty()
                    || call_id.len() > MAX_PROVIDER_CALL_ID_BYTES
                    || call_id.chars().any(char::is_control)
                    || !self.reflection.accepts(&call_id)
                    || !self.reflection.accepts(&name)
                    || !self.reflection.accepts(&arguments)
                {
                    return Err(ProviderError::stream("provider tool call rejected"));
                }
                self.proposed = Some(ProposedTool {
                    provider_call_id: call_id,
                    name,
                    arguments,
                });
                None
            }
            NormalizedStreamEvent::Cancelled => return Err(ProviderError::Cancelled),
            NormalizedStreamEvent::Failed { .. } | NormalizedStreamEvent::ToolResultMeta { .. } => {
                return Err(ProviderError::stream("provider stream rejected"));
            }
        };
        Ok(outbound.map(|(event_type, payload)| {
            self.sequence += 1;
            envelope(self.run_id, self.sequence, event_type, payload)
        }))
    }
}

struct SecretReflectionGuard {
    secret: Option<String>,
    rolling_public: String,
}

impl SecretReflectionGuard {
    fn new(secret: Option<&str>) -> Self {
        Self {
            secret: secret.map(str::to_owned),
            rolling_public: String::new(),
        }
    }

    fn accepts(&mut self, candidate: &str) -> bool {
        let Some(secret) = self.secret.as_deref() else {
            return true;
        };
        let combined = format!("{}{}", self.rolling_public, candidate);
        if combined.contains(secret) {
            return false;
        }
        let keep = secret.len().saturating_sub(1);
        self.rolling_public = utf8_tail(&combined, keep).to_owned();
        true
    }
}

fn utf8_tail(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len() - max_bytes;
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn envelope(
    run_id: AiRunId,
    sequence: u64,
    event_type: AiRunEventType,
    payload: Value,
) -> AiRunSseEnvelope {
    AiRunSseEnvelope {
        version: 1,
        run_id: run_id.to_string(),
        generation: RUN_GENERATION,
        sequence,
        event_type,
        payload,
    }
}

fn encode_envelope(envelope: AiRunSseEnvelope) -> Option<SseEvent> {
    serde_json::to_string(&envelope)
        .ok()
        .map(|data| SseEvent::default().data(data))
}

async fn send_envelope(
    sender: &mpsc::Sender<Result<SseEvent, Infallible>>,
    envelope: AiRunSseEnvelope,
) -> bool {
    let Some(event) = encode_envelope(envelope) else {
        return false;
    };
    sender.send(Ok(event)).await.is_ok()
}

fn chat_keep_alive() -> KeepAlive {
    KeepAlive::new()
        .interval(Duration::from_secs(15))
        .text("keepalive")
}

fn sse(stream: AiResponseStream) -> Sse<KeepAliveStream<AiResponseStream>> {
    Sse::new(stream).keep_alive(chat_keep_alive())
}

fn validate_user_message(message: &str, request_id: &RequestId) -> Result<(), ApiError> {
    if message.trim().is_empty() {
        return Err(validation_error(
            junban_domain::ValidationError::Empty { field: "message" },
            request_id,
        ));
    }
    if message.len() > junban_domain::AI_USER_INPUT_BYTES_MAX {
        return Err(validation_error(
            junban_domain::ValidationError::TooLong {
                field: "message",
                max: junban_domain::AI_USER_INPUT_BYTES_MAX,
            },
            request_id,
        ));
    }
    Ok(())
}

fn context_error(error: AiContextError, request_id: &RequestId) -> ApiError {
    match error {
        AiContextError::EmptyMessage => validation_error(
            junban_domain::ValidationError::Empty { field: "message" },
            request_id,
        ),
        AiContextError::MessageTooLarge => validation_error(
            junban_domain::ValidationError::TooLong {
                field: "message",
                max: junban_domain::AI_USER_INPUT_BYTES_MAX,
            },
            request_id,
        ),
        AiContextError::RequiredContextTooLarge => ApiError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "ai_context_too_large",
            "required AI context exceeds the prompt limit",
            false,
            request_id,
        ),
    }
}

fn config_error(message: &'static str, request_id: &RequestId) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::CONFLICT,
        "ai_not_configured",
        message,
        false,
        request_id,
    )
}

fn active_duplicate(request_id: &RequestId) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::CONFLICT,
        "ai_run_active",
        "AI response is already active",
        false,
        request_id,
    )
}

fn response_state_conflict(request_id: &RequestId) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::CONFLICT,
        "ai_response_state_conflict",
        "durable AI response state does not match this operation",
        false,
        request_id,
    )
}

fn replay_unavailable(request_id: &RequestId) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "ai_replay_unavailable",
        "durable AI response replay is unavailable",
        false,
        request_id,
    )
}

#[cfg(test)]
mod tests {
    use axum::response::IntoResponse;
    use http_body_util::BodyExt;
    use junban_ai::{ProviderPreset, descriptor};

    use super::*;

    struct PendingStream;

    impl Stream for PendingStream {
        type Item = Result<SseEvent, Infallible>;

        fn poll_next(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            Poll::Pending
        }
    }

    #[test]
    fn whole_and_split_credential_reflection_is_rejected_before_completing_fragment() {
        let mut whole = SecretReflectionGuard::new(Some("secret-marker"));
        assert!(!whole.accepts("secret-marker"));
        assert!(whole.rolling_public.is_empty());

        let mut split = SecretReflectionGuard::new(Some("secret-marker"));
        assert!(split.accepts("prefix secret-"));
        assert!(!split.accepts("marker suffix"));
        assert!(!split.rolling_public.contains("secret-marker"));
    }

    #[test]
    fn multiple_tools_and_assistant_bound_fail_statically() {
        let endpoint = ProviderEndpoint::resolve(
            descriptor(ProviderPreset::Ollama),
            Some("http://127.0.0.1:11434/v1"),
            None,
        )
        .unwrap();
        let mut accumulator = StreamAccumulator::new(AiRunId::new(), &endpoint);
        assert!(
            accumulator
                .accept(NormalizedStreamEvent::ToolProposed {
                    call_id: "vendor".into(),
                    name: "unsafe".into(),
                    arguments: "{}".into(),
                })
                .unwrap()
                .is_none()
        );
        let error = accumulator
            .accept(NormalizedStreamEvent::ToolProposed {
                call_id: "vendor-2".into(),
                name: "unsafe".into(),
                arguments: "{}".into(),
            })
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "provider stream error: provider tool call rejected"
        );
        assert!(!error.to_string().contains("vendor"));

        let mut accumulator = StreamAccumulator::new(AiRunId::new(), &endpoint);
        accumulator.assistant = "x".repeat(AI_ASSISTANT_TEXT_BYTES_MAX);
        assert!(
            accumulator
                .accept(NormalizedStreamEvent::TextDelta { text: "x".into() })
                .is_err()
        );
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn chat_keepalive_is_comment_only_every_fifteen_seconds() {
        let response = Sse::new(PendingStream)
            .keep_alive(chat_keep_alive())
            .into_response();
        let body = response.into_body();
        let first = tokio::spawn(async move {
            let mut body = body;
            let frame = body.frame().await.unwrap().unwrap();
            (frame.into_data().unwrap(), body)
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(14)).await;
        tokio::task::yield_now().await;
        assert!(!first.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        let (bytes, body) = first.await.unwrap();
        assert_eq!(bytes.as_ref(), b": keepalive\n\n");

        let second = tokio::spawn(async move {
            let mut body = body;
            body.frame().await.unwrap().unwrap().into_data().unwrap()
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(15)).await;
        assert_eq!(second.await.unwrap().as_ref(), b": keepalive\n\n");
    }

    #[test]
    fn response_channel_is_bounded_to_frozen_capacity() {
        assert_eq!(AI_RESPONSE_CHANNEL_CAPACITY, 64);
        let (sender, _receiver) = mpsc::channel::<()>(AI_RESPONSE_CHANNEL_CAPACITY);
        for _ in 0..AI_RESPONSE_CHANNEL_CAPACITY {
            sender.try_send(()).unwrap();
        }
        assert!(matches!(
            sender.try_send(()),
            Err(mpsc::error::TrySendError::Full(()))
        ));
    }
}
