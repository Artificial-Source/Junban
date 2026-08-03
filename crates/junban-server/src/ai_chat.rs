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
    ModelId, NormalizedStreamEvent, ProviderChatRequest, ProviderEndpoint, ProviderError,
    SecretString, descriptor,
};
use junban_app::{
    AppError, CancelAiResponseRequest, FinishAiResponseRequest, UpsertAiMessageRequest,
    UpsertAiRunStateRequest,
};
use junban_domain::{
    AI_ASSISTANT_TEXT_BYTES_MAX, AiMessage, AiMessageContent, AiMessageRole, AiMessageStatus,
    AiRunId, AiRunPhase, AiRunState, AiSessionId, AiSessionStatus, OperationId, TaskId,
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
    error::{ApiError, validation_error},
    routes_ai::CreateAiResponseRequest,
    sse::SseConnectionPermit,
};

pub const AI_RESPONSE_CHANNEL_CAPACITY: usize = 64;
const RUN_GENERATION: u64 = 1;
const STATIC_FAILED_CODE: &str = "ai_run_failed";

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
        tools: Vec::new(),
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
                &running,
                AiRunPhase::Failed,
                String::new(),
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
        running,
        AiRunPhase::Cancelled,
        assistant.content.text,
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
        if !assistant.content.text.is_empty() {
            sequence += 1;
            if !send_envelope(
                &sender,
                envelope(
                    identity.run_id,
                    sequence,
                    AiRunEventType::TextDelta,
                    json!({"text": assistant.content.text}),
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

async fn orchestrate(
    durable: DurableRun,
    guard: AiRunGuard,
    endpoint: ProviderEndpoint,
    request: ProviderChatRequest,
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
                                let event = encode_envelope(envelope)
                                    .ok_or_else(|| ProviderError::stream("AI output encoding failed"))?;
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
    let (completed, assistant, mut sequence) = {
        let accumulator = accumulator.lock().expect("AI stream accumulator poisoned");
        (
            accumulator.completed,
            accumulator.assistant.clone(),
            accumulator.sequence,
        )
    };
    let proposed = match result {
        Ok(()) if completed => AiTerminalOutcome::Completed,
        Err(ProviderError::Cancelled) => AiTerminalOutcome::Cancelled,
        Ok(()) | Err(_) => AiTerminalOutcome::Failed,
    };
    let Some(outcome) = guard.linearize_terminal(proposed) else {
        return;
    };
    let (_, proposed_phase) = outcome_states(outcome);
    let persisted_phase = finish_response(
        &durable.service,
        durable.identity,
        &durable.running,
        proposed_phase,
        assistant,
    )
    .await;

    // Durable terminal work no longer needs process-local runtime authority. Drop
    // it before a terminal event can wait indefinitely for a full client channel.
    drop(guard);

    match persisted_phase {
        Ok(run_phase) => {
            sequence += 1;
            let (event_type, payload) =
                terminal_event(run_phase, durable.identity.assistant_message_id);
            let _ = send_envelope(
                &sender,
                envelope(durable.identity.run_id, sequence, event_type, payload),
            )
            .await;
        }
        Err(_) => {
            send_static_failed(&sender, durable.identity.run_id, &mut sequence, None).await;
        }
    }
}

async fn finish_response(
    service: &crate::sse::AppService,
    identity: AiResponseIdentity,
    running: &AiRunState,
    run_phase: AiRunPhase,
    assistant: String,
) -> Result<AiRunPhase, AppError> {
    if run_phase == AiRunPhase::Cancelled {
        service
            .cancel_ai_response(
                identity.finish_operation_id,
                CancelAiResponseRequest {
                    assistant_message_id: identity.assistant_message_id,
                    session_id: running.session_id,
                    turn_id: running.turn_id,
                    run_id: running.run_id,
                    generation: running.generation,
                    content: AiMessageContent::text(assistant)?,
                },
            )
            .await?;
        return Ok(AiRunPhase::Cancelled);
    }
    let message_status = message_status_for_phase(run_phase).ok_or(AppError::Conflict)?;
    let content = AiMessageContent::text(assistant.clone())?;
    let result = service
        .finish_ai_response(
            identity.finish_operation_id,
            FinishAiResponseRequest {
                assistant_message_id: identity.assistant_message_id,
                session_id: running.session_id,
                turn_id: running.turn_id,
                run_id: running.run_id,
                generation: running.generation,
                message_status,
                content,
                run_phase,
                dispatch_operation_id: None,
            },
        )
        .await;
    match result {
        Ok(_) => Ok(run_phase),
        Err(AppError::Validation(_))
            if run_phase != AiRunPhase::Failed || !assistant.is_empty() =>
        {
            service
                .finish_ai_response(
                    identity.finish_operation_id,
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
    completed: bool,
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
            completed: false,
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
            NormalizedStreamEvent::Cancelled => return Err(ProviderError::Cancelled),
            NormalizedStreamEvent::Failed { .. }
            | NormalizedStreamEvent::ToolProposed { .. }
            | NormalizedStreamEvent::ToolResultMeta { .. } => {
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
    fn unexpected_tools_and_assistant_bound_fail_statically() {
        let endpoint = ProviderEndpoint::resolve(
            descriptor(ProviderPreset::Ollama),
            Some("http://127.0.0.1:11434/v1"),
            None,
        )
        .unwrap();
        let mut accumulator = StreamAccumulator::new(AiRunId::new(), &endpoint);
        let error = accumulator
            .accept(NormalizedStreamEvent::ToolProposed {
                call_id: "vendor".into(),
                name: "unsafe".into(),
                arguments: "{}".into(),
            })
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "provider stream error: provider stream rejected"
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
