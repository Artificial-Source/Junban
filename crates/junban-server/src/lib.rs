//! Axum router, HTTP contract, authentication, static serving, and SSE delivery.

use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    convert::Infallible,
    fs, io,
    net::SocketAddr,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{
        DefaultBodyLimit, Extension, Path as AxumPath, Query, Request, State,
        rejection::JsonRejection,
    },
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response, Sse, sse::Event as SseEvent, sse::KeepAlive},
    routing::{get, post, put},
};
use futures_core::Stream;
use jiff::{Timestamp, civil::Date};
use junban_app::{AppError, CommittedMutation, EventSink, TaskEvent, TaskService};
use junban_domain::{OperationId, Task, TaskId, TaskStatus, ValidationError};
use junban_storage::{SqliteRepository, write_private_file};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc};
use tower_http::services::{ServeDir, ServeFile};
use utoipa::{
    Modify, OpenApi, ToSchema,
    openapi::security::{Http, HttpAuthScheme, SecurityScheme},
};
use uuid::Uuid;

const MAX_BODY_BYTES: usize = 64 * 1024;
const AUTH_ATTEMPTS: usize = 8;
const AUTH_WINDOW: Duration = Duration::from_secs(30);
pub const TOKEN_FILE: &str = "access-token";
pub const RUNTIME_FILE: &str = "runtime.json";

#[derive(Clone)]
pub struct BroadcastEventSink {
    sender: broadcast::Sender<TaskEvent>,
}

impl BroadcastEventSink {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    fn subscribe(&self) -> broadcast::Receiver<TaskEvent> {
        self.sender.subscribe()
    }
}

impl EventSink for BroadcastEventSink {
    fn publish(&self, event: TaskEvent) {
        // No active SSE client is a normal state; durability lives in SQLite.
        let _ = self.sender.send(event);
    }
}

type AppService = TaskService<SqliteRepository, BroadcastEventSink>;

#[derive(Clone)]
pub struct ServerState {
    service: AppService,
    events: Arc<BroadcastEventSink>,
    bearer_token: Arc<str>,
    allowed_hosts: Arc<HashSet<String>>,
    auth_limiter: Arc<AuthLimiter>,
}

impl ServerState {
    #[must_use]
    pub fn new(
        repository: SqliteRepository,
        bearer_token: String,
        allowed_hosts: impl IntoIterator<Item = String>,
    ) -> Self {
        let events = Arc::new(BroadcastEventSink::new(128));
        let service = TaskService::new(Arc::new(repository), Arc::clone(&events));
        Self {
            service,
            events,
            bearer_token: Arc::from(bearer_token),
            allowed_hosts: Arc::new(allowed_hosts.into_iter().collect()),
            auth_limiter: Arc::new(AuthLimiter::new()),
        }
    }
}

struct AuthLimiter {
    attempts: Mutex<VecDeque<Instant>>,
}

impl AuthLimiter {
    fn new() -> Self {
        Self {
            attempts: Mutex::new(VecDeque::with_capacity(AUTH_ATTEMPTS)),
        }
    }

    fn rejected_status(&self) -> StatusCode {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().expect("auth limiter poisoned");
        while attempts
            .front()
            .is_some_and(|attempt| now.duration_since(*attempt) >= AUTH_WINDOW)
        {
            attempts.pop_front();
        }
        if attempts.len() >= AUTH_ATTEMPTS {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            attempts.push_back(now);
            StatusCode::UNAUTHORIZED
        }
    }
}

/// Builds the reusable API + static UI router.
pub fn router(state: ServerState, web_dir: impl Into<PathBuf>) -> Router {
    let web_dir = web_dir.into();
    let index = web_dir.join("index.html");
    let static_files = ServeDir::new(web_dir).fallback(ServeFile::new(index));

    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/tasks", post(create_task).get(list_tasks))
        .route(
            "/api/v1/tasks/{task_id}",
            put(replace_task).delete(delete_task),
        )
        .route("/api/v1/tasks/{task_id}/complete", post(complete_task))
        .route("/api/v1/tasks/{task_id}/uncomplete", post(uncomplete_task))
        .route("/api/v1/events", get(events))
        .route("/api", get(api_not_found))
        .route("/api/{*path}", get(api_not_found).fallback(api_not_found))
        .fallback_service(static_files)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_guard,
        ))
        .with_state(state)
}

async fn security_guard(
    State(state): State<ServerState>,
    mut request: Request,
    next: Next,
) -> Response {
    let request_id = RequestId(Uuid::now_v7().to_string());
    request.extensions_mut().insert(request_id.clone());

    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    if !host.is_some_and(|host| state.allowed_hosts.contains(host)) {
        return secure_response(
            ApiError::new(
                StatusCode::MISDIRECTED_REQUEST,
                "host_not_allowed",
                "request Host is not allowed",
                false,
                &request_id,
            )
            .into_response(),
            &request_id,
        );
    }

    if is_unsafe(request.method())
        && let Some(origin) = request.headers().get(header::ORIGIN)
    {
        let origin_matches = origin
            .to_str()
            .ok()
            .and_then(|value| value.parse::<Uri>().ok())
            .is_some_and(|origin| {
                matches!(origin.scheme_str(), Some("http" | "https"))
                    && origin.authority().map(|value| value.as_str()) == host
            });
        if !origin_matches {
            return secure_response(
                ApiError::new(
                    StatusCode::FORBIDDEN,
                    "origin_mismatch",
                    "request Origin does not match Host",
                    false,
                    &request_id,
                )
                .into_response(),
                &request_id,
            );
        }
    }

    let path = request.uri().path();
    if path.starts_with("/api/v1") && path != "/api/v1/health" {
        let expected = format!("Bearer {}", state.bearer_token);
        let authenticated = request
            .headers()
            .get(header::AUTHORIZATION)
            .is_some_and(|actual| actual.as_bytes() == expected.as_bytes());
        if !authenticated {
            let status = state.auth_limiter.rejected_status();
            let (code, message, retryable) = if status == StatusCode::TOO_MANY_REQUESTS {
                (
                    "auth_rate_limited",
                    "too many invalid authentication attempts",
                    true,
                )
            } else {
                (
                    "authentication_required",
                    "a valid bearer token is required",
                    false,
                )
            };
            return secure_response(
                ApiError::new(status, code, message, retryable, &request_id).into_response(),
                &request_id,
            );
        }
    }

    let api_request = request.uri().path().starts_with("/api");
    let (parts, body) = request.into_parts();
    let body = match to_bytes(body, MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(_) => {
            return secure_response(
                ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "body_too_large",
                    format!("request body must not exceed {MAX_BODY_BYTES} bytes"),
                    false,
                    &request_id,
                )
                .into_response(),
                &request_id,
            );
        }
    };
    let request = Request::from_parts(parts, Body::from(body));
    let response = next.run(request).await;
    let response = if api_request {
        normalize_api_error(response, &request_id)
    } else {
        response
    };
    secure_response(response, &request_id)
}

fn normalize_api_error(response: Response, request_id: &RequestId) -> Response {
    if !response.status().is_client_error() && !response.status().is_server_error() {
        return response;
    }
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return response;
    }

    let status = response.status();
    let (code, message, retryable) = match status {
        StatusCode::BAD_REQUEST => ("invalid_request", "request could not be parsed", false),
        StatusCode::NOT_FOUND => ("api_not_found", "API route was not found", false),
        StatusCode::METHOD_NOT_ALLOWED => (
            "method_not_allowed",
            "HTTP method is not allowed for this API route",
            false,
        ),
        StatusCode::PAYLOAD_TOO_LARGE => (
            "body_too_large",
            "request body exceeds the configured limit",
            false,
        ),
        StatusCode::UNSUPPORTED_MEDIA_TYPE => (
            "unsupported_media_type",
            "request Content-Type is not supported",
            false,
        ),
        _ if status.is_server_error() => (
            "internal_error",
            "the server could not complete the request",
            true,
        ),
        _ => ("request_failed", "request was rejected", false),
    };
    ApiError::new(status, code, message, retryable, request_id).into_response()
}

fn is_unsafe(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

fn secure_response(mut response: Response, request_id: &RequestId) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; connect-src 'self'",
        ),
    );
    if let Ok(value) = HeaderValue::from_str(&request_id.0) {
        headers.insert(HeaderName::from_static("x-request-id"), value);
    }
    response
}

#[derive(Debug, Clone)]
struct RequestId(String);

#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorEnvelope {
    error: ErrorBody,
    request_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorBody {
    code: &'static str,
    message: String,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    fields: Option<BTreeMap<String, String>>,
}

struct ApiError {
    status: StatusCode,
    envelope: ErrorEnvelope,
}

impl ApiError {
    fn new(
        status: StatusCode,
        code: &'static str,
        message: impl Into<String>,
        retryable: bool,
        request_id: &RequestId,
    ) -> Self {
        Self {
            status,
            envelope: ErrorEnvelope {
                error: ErrorBody {
                    code,
                    message: message.into(),
                    retryable,
                    fields: None,
                },
                request_id: request_id.0.clone(),
            },
        }
    }

    fn with_field(mut self, field: impl Into<String>, message: impl Into<String>) -> Self {
        self.envelope
            .error
            .fields
            .get_or_insert_with(BTreeMap::new)
            .insert(field.into(), message.into());
        self
    }

    fn from_app(error: AppError, request_id: &RequestId) -> Self {
        match error {
            AppError::Validation(error) => validation_error(error, request_id),
            AppError::NotFound => Self::new(
                StatusCode::NOT_FOUND,
                "task_not_found",
                "task was not found",
                false,
                request_id,
            ),
            AppError::IdempotencyMismatch => Self::new(
                StatusCode::CONFLICT,
                "idempotency_mismatch",
                "Idempotency-Key was already used for a different request",
                false,
                request_id,
            ),
            AppError::Storage => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "storage_unavailable",
                "storage is temporarily unavailable",
                true,
                request_id,
            ),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.envelope)).into_response()
    }
}

fn validation_error(error: ValidationError, request_id: &RequestId) -> ApiError {
    let field = match error {
        ValidationError::InvalidId { field } => field,
        ValidationError::EmptyTitle | ValidationError::TitleTooLong { .. } => "title",
    };
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation_error",
        "request validation failed",
        false,
        request_id,
    )
    .with_field(field, error.to_string())
}

fn parse_task_id(raw: &str, request_id: &RequestId) -> Result<TaskId, ApiError> {
    TaskId::parse(raw).map_err(|error| validation_error(error, request_id))
}

fn operation_id(headers: &HeaderMap, request_id: &RequestId) -> Result<OperationId, ApiError> {
    let raw = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                "request validation failed",
                false,
                request_id,
            )
            .with_field(
                "idempotency_key",
                "a UUID Idempotency-Key header is required",
            )
        })?;
    OperationId::parse(raw).map_err(|error| validation_error(error, request_id))
}

fn extract_json<T>(
    payload: Result<Json<T>, JsonRejection>,
    request_id: &RequestId,
) -> Result<T, ApiError> {
    payload.map(|Json(value)| value).map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                format!("request body must not exceed {MAX_BODY_BYTES} bytes"),
                false,
                request_id,
            )
        } else {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_json",
                "request body must be valid JSON",
                false,
                request_id,
            )
        }
    })
}

#[derive(Debug, Serialize, ToSchema)]
pub struct HealthResponse {
    status: &'static str,
}

#[utoipa::path(
    get,
    path = "/api/v1/health",
    responses((status = 200, body = HealthResponse))
)]
async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateTaskRequest {
    title: String,
    #[schema(value_type = Option<String>, format = Date, nullable = true)]
    due_date: Option<Date>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ReplaceTaskRequest {
    title: String,
    #[schema(value_type = Option<String>, format = Date, nullable = true)]
    due_date: Option<Date>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatusDto {
    Pending,
    Completed,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TaskDto {
    #[schema(value_type = String, format = Uuid)]
    id: String,
    title: String,
    #[schema(value_type = Option<String>, format = Date, nullable = true)]
    due_date: Option<Date>,
    status: TaskStatusDto,
    #[schema(value_type = Option<String>, format = DateTime, nullable = true)]
    completed_at: Option<Timestamp>,
    #[schema(value_type = String, format = DateTime)]
    created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    updated_at: Timestamp,
    revision: u64,
}

impl From<Task> for TaskDto {
    fn from(task: Task) -> Self {
        Self {
            id: task.id.to_string(),
            title: task.title.to_string(),
            due_date: task.due_date,
            status: match task.status {
                TaskStatus::Pending => TaskStatusDto::Pending,
                TaskStatus::Completed => TaskStatusDto::Completed,
            },
            completed_at: task.completed_at,
            created_at: task.created_at,
            updated_at: task.updated_at,
            revision: task.revision,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TaskListResponse {
    tasks: Vec<TaskDto>,
    revision: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MutationResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    task: Option<TaskDto>,
    event: TaskEventDto,
}

impl From<CommittedMutation> for MutationResponse {
    fn from(mutation: CommittedMutation) -> Self {
        Self {
            task: mutation.task.map(Into::into),
            event: mutation.event.into(),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TaskEventDto {
    revision: u64,
    #[schema(value_type = String, format = Uuid)]
    operation_id: String,
    event_type: &'static str,
    #[schema(value_type = String, format = Uuid)]
    task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    task: Option<TaskDto>,
    #[schema(value_type = String, format = DateTime)]
    occurred_at: Timestamp,
}

impl From<TaskEvent> for TaskEventDto {
    fn from(event: TaskEvent) -> Self {
        Self {
            revision: event.revision,
            operation_id: event.operation_id.to_string(),
            event_type: event.kind.as_str(),
            task_id: event.task_id.to_string(),
            task: event.task.map(Into::into),
            occurred_at: event.occurred_at,
        }
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/tasks",
    request_body = CreateTaskRequest,
    params(("Idempotency-Key" = String, Header, format = Uuid)),
    responses(
        (status = 201, body = MutationResponse),
        (status = 400, body = ErrorEnvelope),
        (status = 401, body = ErrorEnvelope),
        (status = 409, body = ErrorEnvelope),
        (status = 413, body = ErrorEnvelope),
        (status = 422, body = ErrorEnvelope),
        (status = 503, body = ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
async fn create_task(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
    payload: Result<Json<CreateTaskRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<MutationResponse>), ApiError> {
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let mutation = state
        .service
        .create_task(operation_id, payload.title, payload.due_date)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok((StatusCode::CREATED, Json(mutation.into())))
}

#[utoipa::path(
    get,
    path = "/api/v1/tasks",
    responses(
        (status = 200, body = TaskListResponse),
        (status = 401, body = ErrorEnvelope),
        (status = 503, body = ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
async fn list_tasks(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
) -> Result<Json<TaskListResponse>, ApiError> {
    let tasks = state
        .service
        .list_tasks()
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(TaskListResponse {
        tasks: tasks.tasks.into_iter().map(Into::into).collect(),
        revision: tasks.revision,
    }))
}

#[utoipa::path(
    put,
    path = "/api/v1/tasks/{task_id}",
    request_body = ReplaceTaskRequest,
    params(
        ("task_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
        (status = 400, body = ErrorEnvelope),
        (status = 401, body = ErrorEnvelope),
        (status = 404, body = ErrorEnvelope),
        (status = 409, body = ErrorEnvelope),
        (status = 413, body = ErrorEnvelope),
        (status = 422, body = ErrorEnvelope),
        (status = 503, body = ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
async fn replace_task(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<ReplaceTaskRequest>, JsonRejection>,
) -> Result<Json<MutationResponse>, ApiError> {
    let task_id = parse_task_id(&task_id, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let mutation = state
        .service
        .replace_task(operation_id, task_id, payload.title, payload.due_date)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

macro_rules! state_mutation {
    ($handler:ident, $method:ident, $path:literal) => {
        #[utoipa::path(
                                            post,
                                            path = $path,
                                            params(
                                                ("task_id" = String, Path, format = Uuid),
                                                ("Idempotency-Key" = String, Header, format = Uuid)
                                            ),
                                            responses(
                                                (status = 200, body = MutationResponse),
                                                (status = 401, body = ErrorEnvelope),
                                                (status = 404, body = ErrorEnvelope),
                                                (status = 409, body = ErrorEnvelope),
                                                (status = 422, body = ErrorEnvelope),
                                                (status = 503, body = ErrorEnvelope)
                                            ),
                                            security(("bearer_auth" = []))
                                        )]
        async fn $handler(
            State(state): State<ServerState>,
            Extension(request_id): Extension<RequestId>,
            AxumPath(task_id): AxumPath<String>,
            headers: HeaderMap,
        ) -> Result<Json<MutationResponse>, ApiError> {
            let task_id = parse_task_id(&task_id, &request_id)?;
            let operation_id = operation_id(&headers, &request_id)?;
            let mutation = state
                .service
                .$method(operation_id, task_id)
                .await
                .map_err(|error| ApiError::from_app(error, &request_id))?;
            Ok(Json(mutation.into()))
        }
    };
}

state_mutation!(
    complete_task,
    complete_task,
    "/api/v1/tasks/{task_id}/complete"
);
state_mutation!(
    uncomplete_task,
    uncomplete_task,
    "/api/v1/tasks/{task_id}/uncomplete"
);

#[utoipa::path(
    delete,
    path = "/api/v1/tasks/{task_id}",
    params(
        ("task_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
        (status = 401, body = ErrorEnvelope),
        (status = 404, body = ErrorEnvelope),
        (status = 409, body = ErrorEnvelope),
        (status = 422, body = ErrorEnvelope),
        (status = 503, body = ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
async fn delete_task(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<MutationResponse>, ApiError> {
    let task_id = parse_task_id(&task_id, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let mutation = state
        .service
        .delete_task(operation_id, task_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[derive(Debug, Default, Deserialize)]
struct EventQuery {
    since: Option<u64>,
}

#[utoipa::path(
    get,
    path = "/api/v1/events",
    params(
        ("since" = Option<u64>, Query),
        ("Last-Event-ID" = Option<u64>, Header)
    ),
    responses(
        (status = 200, description = "Revisioned task event stream", content_type = "text/event-stream"),
        (status = 400, body = ErrorEnvelope),
        (status = 401, body = ErrorEnvelope),
        (status = 503, body = ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
async fn events(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<EventQuery>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    let since = if let Some(since) = query.since {
        since
    } else if let Some(value) = headers.get("last-event-id") {
        value
            .to_str()
            .ok()
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_event_cursor",
                    "Last-Event-ID must be an unsigned revision",
                    false,
                    &request_id,
                )
            })?
    } else {
        0
    };

    // Subscribe first so commits racing with durable catch-up remain queued.
    let receiver = state.events.subscribe();
    let catch_up = state
        .service
        .list_events(since)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let (sender, stream_receiver) = mpsc::channel(32);
    let service = state.service.clone();
    tokio::spawn(forward_events(service, receiver, catch_up, since, sender));

    Ok(Sse::new(ChannelStream(stream_receiver)).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}

async fn forward_events(
    service: AppService,
    mut live: broadcast::Receiver<TaskEvent>,
    catch_up: Vec<TaskEvent>,
    since: u64,
    sender: mpsc::Sender<Result<SseEvent, Infallible>>,
) {
    let mut last_sent = since;
    for event in catch_up {
        if !send_event(&sender, &event, &mut last_sent).await {
            return;
        }
    }
    loop {
        match live.recv().await {
            Ok(event) => {
                if !send_event(&sender, &event, &mut last_sent).await {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let Ok(events) = service.list_events(last_sent).await else {
                    return;
                };
                for event in events {
                    if !send_event(&sender, &event, &mut last_sent).await {
                        return;
                    }
                }
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

async fn send_event(
    sender: &mpsc::Sender<Result<SseEvent, Infallible>>,
    event: &TaskEvent,
    last_sent: &mut u64,
) -> bool {
    if event.revision <= *last_sent {
        return true;
    }
    let Ok(data) = serde_json::to_string(&TaskEventDto::from(event.clone())) else {
        return false;
    };
    if sender
        .send(Ok(SseEvent::default()
            .id(event.revision.to_string())
            .event(event.kind.as_str())
            .data(data)))
        .await
        .is_err()
    {
        return false;
    }
    *last_sent = event.revision;
    true
}

pub struct ChannelStream(mpsc::Receiver<Result<SseEvent, Infallible>>);

impl Stream for ChannelStream {
    type Item = Result<SseEvent, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.0.poll_recv(context)
    }
}

async fn api_not_found(Extension(request_id): Extension<RequestId>) -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "api_not_found",
        "API route was not found",
        false,
        &request_id,
    )
}

struct SecurityAddon;

impl Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        if let Some(components) = openapi.components.as_mut() {
            components.add_security_scheme(
                "bearer_auth",
                SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
            );
        }
    }
}

#[derive(OpenApi)]
#[openapi(
    info(title = "Junban API", version = "1.0.0"),
    paths(
        health,
        create_task,
        list_tasks,
        replace_task,
        complete_task,
        uncomplete_task,
        delete_task,
        events
    ),
    components(schemas(
        HealthResponse,
        CreateTaskRequest,
        ReplaceTaskRequest,
        TaskStatusDto,
        TaskDto,
        TaskListResponse,
        TaskEventDto,
        MutationResponse,
        ErrorEnvelope,
        ErrorBody
    )),
    modifiers(&SecurityAddon)
)]
struct ApiDoc;

#[must_use]
pub fn openapi_json() -> String {
    let mut json = ApiDoc::openapi()
        .to_pretty_json()
        .expect("OpenAPI document is serializable");
    json.push('\n');
    json
}

pub fn load_or_create_token(profile_dir: &Path) -> io::Result<String> {
    let path = profile_dir.join(TOKEN_FILE);
    let token = match fs::read_to_string(&path) {
        Ok(value) if value.trim().len() >= 64 => value.trim().to_owned(),
        Ok(_) => format!("{}{}", Uuid::new_v4(), Uuid::new_v4()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            format!("{}{}", Uuid::new_v4(), Uuid::new_v4())
        }
        Err(error) => return Err(error),
    };
    write_private_file(&path, format!("{token}\n").as_bytes())?;
    Ok(token)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RuntimeMetadata {
    pub address: SocketAddr,
    pub pid: u32,
}

pub struct RuntimeMetadataFile {
    path: PathBuf,
}

impl RuntimeMetadataFile {
    pub fn create(profile_dir: &Path, address: SocketAddr) -> io::Result<Self> {
        let path = profile_dir.join(RUNTIME_FILE);
        let metadata = RuntimeMetadata {
            address,
            pid: std::process::id(),
        };
        let mut json = serde_json::to_vec_pretty(&metadata).map_err(io::Error::other)?;
        json.push(b'\n');
        write_private_file(&path, &json)?;
        Ok(Self { path })
    }
}

impl Drop for RuntimeMetadataFile {
    fn drop(&mut self) {
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(path = %self.path.display(), %error, "could not remove runtime metadata")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{env, time::SystemTime};

    use http_body_util::BodyExt;
    use junban_storage::ProfileOwner;
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;

    const HOST: &str = "127.0.0.1:4219";
    const TOKEN: &str = "test-token-that-is-never-written-to-runtime-metadata";

    struct TestContext {
        directory: PathBuf,
        _owner: ProfileOwner,
        app: Router,
    }

    impl TestContext {
        fn new() -> Self {
            let directory = env::temp_dir().join(format!(
                "junban-server-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let web_dir = directory.join("web");
            fs::create_dir_all(web_dir.join("assets")).unwrap();
            fs::write(web_dir.join("index.html"), "<main>Junban shell</main>").unwrap();
            fs::write(web_dir.join("assets/app.js"), "console.log('ui')").unwrap();
            let owner = ProfileOwner::open(directory.join("profile")).unwrap();
            let state = ServerState::new(owner.repository(), TOKEN.to_owned(), [HOST.to_owned()]);
            let app = router(state, web_dir);
            Self {
                directory,
                _owner: owner,
                app,
            }
        }

        async fn request(&self, request: axum::http::Request<Body>) -> Response {
            self.app.clone().oneshot(request).await.unwrap()
        }
    }

    impl Drop for TestContext {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    fn request(method: Method, uri: &str) -> axum::http::request::Builder {
        axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, HOST)
    }

    fn authenticated(method: Method, uri: &str) -> axum::http::request::Builder {
        request(method, uri).header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
    }

    fn operation_header(builder: axum::http::request::Builder) -> axum::http::request::Builder {
        builder.header("idempotency-key", Uuid::new_v4().to_string())
    }

    async fn json(response: Response) -> Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn create(context: &TestContext, title: &str) -> Value {
        let response = context
            .request(
                operation_header(authenticated(Method::POST, "/api/v1/tasks"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(
                        r#"{{"title":"{title}","due_date":null}}"#
                    )))
                    .unwrap(),
            )
            .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        json(response).await
    }

    #[tokio::test]
    async fn health_is_unauthenticated_and_security_headers_are_global() {
        let context = TestContext::new();
        let response = context
            .request(
                request(Method::GET, "/api/v1/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert!(response.headers().contains_key("x-request-id"));
    }

    #[tokio::test]
    async fn exact_raw_host_is_required_and_forwarded_host_is_ignored() {
        let context = TestContext::new();
        let denied = context
            .request(
                axum::http::Request::builder()
                    .uri("/api/v1/health")
                    .header(header::HOST, "evil.example")
                    .header("x-forwarded-host", HOST)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(denied.status(), StatusCode::MISDIRECTED_REQUEST);

        let allowed = context
            .request(
                request(Method::GET, "/api/v1/health")
                    .header("forwarded", "host=evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(allowed.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn bearer_authentication_and_bounded_limiter_fail_closed() {
        let context = TestContext::new();
        for _ in 0..AUTH_ATTEMPTS {
            let response = context
                .request(
                    request(Method::GET, "/api/v1/tasks")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        let limited = context
            .request(
                request(Method::GET, "/api/v1/tasks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(json(limited).await["error"]["retryable"], true);

        let valid = context
            .request(
                authenticated(Method::GET, "/api/v1/tasks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(valid.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn browser_mutations_require_matching_origin_but_cli_requests_do_not() {
        let context = TestContext::new();
        let mismatch = context
            .request(
                operation_header(authenticated(Method::POST, "/api/v1/tasks"))
                    .header(header::ORIGIN, "http://evil.example")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"title":"Task","due_date":null}"#))
                    .unwrap(),
            )
            .await;
        assert_eq!(mismatch.status(), StatusCode::FORBIDDEN);

        assert_eq!(
            create(&context, "CLI task").await["task"]["title"],
            "CLI task"
        );
    }

    #[tokio::test]
    async fn body_limit_and_validation_errors_have_matching_request_ids() {
        let context = TestContext::new();
        let too_large = context
            .request(
                operation_header(authenticated(Method::POST, "/api/v1/tasks"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(
                        r#"{{"title":"{}"}}"#,
                        "x".repeat(MAX_BODY_BYTES)
                    )))
                    .unwrap(),
            )
            .await;
        assert_eq!(too_large.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let header_id = too_large.headers()["x-request-id"]
            .to_str()
            .unwrap()
            .to_owned();
        assert_eq!(json(too_large).await["request_id"], header_id);

        let invalid = context
            .request(
                operation_header(authenticated(Method::POST, "/api/v1/tasks"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"title":" ","due_date":null}"#))
                    .unwrap(),
            )
            .await;
        assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(json(invalid).await["error"]["code"], "validation_error");
    }

    #[tokio::test]
    async fn complete_crud_loop_updates_global_revision() {
        let context = TestContext::new();
        let created = create(&context, "Original").await;
        let id = created["task"]["id"].as_str().unwrap();

        let replaced = context
            .request(
                operation_header(authenticated(Method::PUT, &format!("/api/v1/tasks/{id}")))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"title":"Changed","due_date":"2026-07-28"}"#))
                    .unwrap(),
            )
            .await;
        assert_eq!(json(replaced).await["event"]["revision"], 2);

        for (path, status) in [("complete", "completed"), ("uncomplete", "pending")] {
            let response = context
                .request(
                    operation_header(authenticated(
                        Method::POST,
                        &format!("/api/v1/tasks/{id}/{path}"),
                    ))
                    .body(Body::empty())
                    .unwrap(),
                )
                .await;
            assert_eq!(json(response).await["task"]["status"], status);
        }

        let list = context
            .request(
                authenticated(Method::GET, "/api/v1/tasks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        let list = json(list).await;
        assert_eq!(list["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(list["revision"], 4);

        let deleted = context
            .request(
                operation_header(authenticated(
                    Method::DELETE,
                    &format!("/api/v1/tasks/{id}"),
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await;
        assert_eq!(json(deleted).await["event"]["event_type"], "task.deleted");
    }

    #[tokio::test]
    async fn api_fallback_never_returns_spa_html_and_static_bootstrap_is_public() {
        let context = TestContext::new();
        let api = context
            .request(
                request(Method::GET, "/api/unknown")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(api.status(), StatusCode::NOT_FOUND);
        assert_eq!(api.headers()[header::CONTENT_TYPE], "application/json");

        let wrong_method = context
            .request(
                request(Method::POST, "/api/v1/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(wrong_method.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            json(wrong_method).await["error"]["code"],
            "method_not_allowed"
        );

        let invalid_query = context
            .request(
                authenticated(Method::GET, "/api/v1/events?since=bad")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(invalid_query.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            json(invalid_query).await["error"]["code"],
            "invalid_request"
        );

        for path in ["/", "/inbox", "/assets/app.js"] {
            let response = context
                .request(request(Method::GET, path).body(Body::empty()).unwrap())
                .await;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
        }
    }

    #[tokio::test]
    async fn sse_catches_up_and_resumes_after_last_event_id() {
        let context = TestContext::new();
        create(&context, "First").await;
        create(&context, "Second").await;

        let response = context
            .request(
                authenticated(Method::GET, "/api/v1/events")
                    .header("last-event-id", "1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body();
        let frame = tokio::time::timeout(Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let data = frame.into_data().unwrap();
        let text = String::from_utf8(data.to_vec()).unwrap();
        assert!(text.contains("id: 2"), "{text}");
        assert!(!text.contains("id: 1"), "{text}");
    }

    #[test]
    fn runtime_metadata_is_private_contains_no_token_and_is_removed() {
        let context = TestContext::new();
        let profile = context.directory.join("profile");
        let address: SocketAddr = "127.0.0.1:4123".parse().unwrap();
        let runtime = RuntimeMetadataFile::create(&profile, address).unwrap();
        let text = fs::read_to_string(profile.join(RUNTIME_FILE)).unwrap();
        assert!(!text.contains(TOKEN));
        assert_eq!(
            serde_json::from_str::<RuntimeMetadata>(&text)
                .unwrap()
                .address,
            address
        );
        drop(runtime);
        assert!(!profile.join(RUNTIME_FILE).exists());
    }

    #[test]
    fn openapi_artifact_does_not_drift() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../openapi/junban-v1.json");
        let checked = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        let checked: Value = serde_json::from_str(&checked).unwrap();
        let generated: Value = serde_json::from_str(&openapi_json()).unwrap();
        assert_eq!(checked, generated, "run `pnpm contract:generate`");
    }
}
