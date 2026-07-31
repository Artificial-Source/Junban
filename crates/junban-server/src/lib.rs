//! Axum router, HTTP contract, authentication, static serving, and SSE delivery.

mod cursor;
mod dto;
mod error;
mod reminder_wake;
mod routes;
mod sse;

use std::{
    collections::HashSet,
    fs, io,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::AtomicUsize},
    time::{Duration, Instant},
};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
};
use junban_app::{CommittedEvent, EventSink, TaskService};
use junban_storage::{SqliteRepository, write_private_file};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tower_http::services::{ServeDir, ServeFile};
use utoipa::{
    Modify, OpenApi,
    openapi::security::{Http, HttpAuthScheme, SecurityScheme},
};
use uuid::Uuid;

use crate::error::{ApiError, ErrorBody, ErrorEnvelope};
use crate::reminder_wake::{ReminderWakeEventDto, ReminderWakeHub, start_reminder_coordinator};
use crate::routes::{
    acquire_reminder_lease, add_relation, api_not_found, append_time_slot_task, apply_template,
    bulk_tasks, cancel_task, claim_due_reminders, complete_task, create_comment, create_project,
    create_saved_filter, create_section, create_tag, create_task, create_template,
    create_time_block, create_time_slot, delete_comment, delete_project, delete_saved_filter,
    delete_section, delete_tag, delete_task, delete_template, delete_time_block, delete_time_slot,
    dismiss_reminder, events, get_catalog, get_profile, get_task, health, list_comments,
    list_relations, list_task_activity, list_task_reminders, list_tasks, list_time_blocks,
    list_time_slots, mark_owner_lost_reminders, move_task, move_time_block, parse_filter_route,
    parse_quick_entry_route, parse_text_import_route, patch_comment, patch_project,
    patch_saved_filter, patch_section, patch_tag, patch_task, patch_template, patch_time_block,
    patch_time_slot, release_reminder_lease, reminder_events, remove_relation,
    remove_time_slot_task, renew_reminder_lease, reopen_task, reorder_tasks,
    replace_time_slot_tasks, reschedule_reminder, resize_time_block, settle_reminder_delivered,
    settle_reminder_failed, uncomplete_task, undo_operation,
};
use crate::sse::{AppService, SseConnectionPermit};

pub use crate::reminder_wake::{REMINDER_OVERDUE_WAKE_THROTTLE, REMINDER_WAKE_EVENT_TYPE};

/// Phase 2 HTTP body ceiling (matches frozen transport plan).
pub const MAX_BODY_BYTES: usize = 512 * 1024;
const AUTH_ATTEMPTS: usize = 8;
const AUTH_WINDOW: Duration = Duration::from_secs(30);
pub const TOKEN_FILE: &str = "access-token";
pub const RUNTIME_FILE: &str = "runtime.json";

#[derive(Clone)]
pub struct BroadcastEventSink {
    sender: broadcast::Sender<CommittedEvent>,
    reminder_wakes: Arc<ReminderWakeHub>,
}

impl BroadcastEventSink {
    #[must_use]
    pub fn new(capacity: usize, reminder_wakes: Arc<ReminderWakeHub>) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self {
            sender,
            reminder_wakes,
        }
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<CommittedEvent> {
        self.sender.subscribe()
    }
}

impl EventSink for BroadcastEventSink {
    fn publish(&self, event: CommittedEvent) {
        // No active SSE client is a normal state; durability lives in SQLite.
        let _ = self.sender.send(event);
        // Every committed user mutation may affect reminder eligibility.
        self.reminder_wakes.notify_recompute();
    }
}

#[derive(Clone)]
pub struct ServerState {
    pub(crate) service: AppService,
    pub(crate) events: Arc<BroadcastEventSink>,
    pub(crate) reminder_wakes: Arc<ReminderWakeHub>,
    bearer_token: Arc<str>,
    allowed_hosts: Arc<HashSet<String>>,
    auth_limiter: Arc<AuthLimiter>,
    shutdown: CancellationToken,
    sse_connections: Arc<AtomicUsize>,
    /// Live SSE forwarder tasks (revisioned events + reminder wakes); test-observable.
    pub(crate) active_forwarders: Arc<AtomicUsize>,
}

impl ServerState {
    /// Build server state without starting the reminder coordinator.
    ///
    /// Router/unit tests use this path so they never accidentally spawn the
    /// process-global wake loop. Production `main` must call
    /// [`ServerState::start_reminder_coordinator`] exactly once after construction.
    #[must_use]
    pub fn new(
        repository: SqliteRepository,
        bearer_token: String,
        allowed_hosts: impl IntoIterator<Item = String>,
    ) -> Self {
        let reminder_wakes = Arc::new(ReminderWakeHub::new());
        let events = Arc::new(BroadcastEventSink::new(128, Arc::clone(&reminder_wakes)));
        let service = TaskService::new(Arc::new(repository), Arc::clone(&events));
        Self {
            service,
            events,
            reminder_wakes,
            bearer_token: Arc::from(bearer_token),
            allowed_hosts: Arc::new(allowed_hosts.into_iter().collect()),
            auth_limiter: Arc::new(AuthLimiter::new()),
            shutdown: CancellationToken::new(),
            sse_connections: Arc::new(AtomicUsize::new(0)),
            active_forwarders: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Cancelled when the process begins graceful shutdown.
    #[must_use]
    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    /// Start the single process-global reminder wake coordinator.
    ///
    /// Cancelled by [`Self::shutdown_token`]. Await the join handle after Axum
    /// returns so the task cannot outlive storage/profile teardown.
    #[must_use]
    pub fn start_reminder_coordinator(&self) -> tokio::task::JoinHandle<()> {
        start_reminder_coordinator(
            self.service.clone(),
            Arc::clone(&self.reminder_wakes),
            self.shutdown_token(),
        )
    }

    pub(crate) fn try_acquire_sse(&self) -> Option<SseConnectionPermit> {
        SseConnectionPermit::try_acquire(&self.sse_connections)
    }

    pub(crate) fn notify_reminder_wake(&self) {
        self.reminder_wakes.notify_recompute();
    }
}

struct AuthLimiter {
    attempts: Mutex<std::collections::VecDeque<Instant>>,
}

impl AuthLimiter {
    fn new() -> Self {
        Self {
            attempts: Mutex::new(std::collections::VecDeque::with_capacity(AUTH_ATTEMPTS)),
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
        .route("/api/v1/profile", get(get_profile))
        .route("/api/v1/tasks", get(list_tasks).post(create_task))
        .route("/api/v1/tasks/actions", post(bulk_tasks))
        .route("/api/v1/tasks/reorder", post(reorder_tasks))
        .route(
            "/api/v1/tasks/{task_id}",
            get(get_task).patch(patch_task).delete(delete_task),
        )
        .route("/api/v1/tasks/{task_id}/complete", post(complete_task))
        .route("/api/v1/tasks/{task_id}/uncomplete", post(uncomplete_task))
        .route("/api/v1/tasks/{task_id}/cancel", post(cancel_task))
        .route("/api/v1/tasks/{task_id}/reopen", post(reopen_task))
        .route("/api/v1/tasks/{task_id}/move", post(move_task))
        .route(
            "/api/v1/tasks/{task_id}/comments",
            get(list_comments).post(create_comment),
        )
        .route(
            "/api/v1/tasks/{task_id}/relations",
            get(list_relations).post(add_relation),
        )
        .route(
            "/api/v1/tasks/{task_id}/relations/{to_task_id}",
            delete(remove_relation),
        )
        .route("/api/v1/tasks/{task_id}/activity", get(list_task_activity))
        .route(
            "/api/v1/tasks/{task_id}/reminders",
            get(list_task_reminders),
        )
        .route(
            "/api/v1/tasks/{task_id}/reminders/reschedule",
            post(reschedule_reminder),
        )
        .route(
            "/api/v1/tasks/{task_id}/reminders/dismiss",
            post(dismiss_reminder),
        )
        .route("/api/v1/reminders/lease", post(acquire_reminder_lease))
        .route("/api/v1/reminders/lease/renew", post(renew_reminder_lease))
        .route(
            "/api/v1/reminders/lease/release",
            post(release_reminder_lease),
        )
        .route("/api/v1/reminders/claim", post(claim_due_reminders))
        .route(
            "/api/v1/reminders/settle/delivered",
            post(settle_reminder_delivered),
        )
        .route(
            "/api/v1/reminders/settle/failed",
            post(settle_reminder_failed),
        )
        .route(
            "/api/v1/reminders/owner-lost",
            post(mark_owner_lost_reminders),
        )
        .route("/api/v1/reminders/events", get(reminder_events))
        .route("/api/v1/catalog", get(get_catalog))
        .route("/api/v1/projects", post(create_project))
        .route(
            "/api/v1/projects/{project_id}",
            patch(patch_project).delete(delete_project),
        )
        .route("/api/v1/sections", post(create_section))
        .route(
            "/api/v1/sections/{section_id}",
            patch(patch_section).delete(delete_section),
        )
        .route("/api/v1/tags", post(create_tag))
        .route("/api/v1/tags/{tag_id}", patch(patch_tag).delete(delete_tag))
        .route("/api/v1/templates", post(create_template))
        .route("/api/v1/templates/apply", post(apply_template))
        .route(
            "/api/v1/templates/{template_id}",
            patch(patch_template).delete(delete_template),
        )
        .route("/api/v1/saved_filters", post(create_saved_filter))
        .route(
            "/api/v1/saved_filters/{filter_id}",
            patch(patch_saved_filter).delete(delete_saved_filter),
        )
        .route(
            "/api/v1/comments/{comment_id}",
            patch(patch_comment).delete(delete_comment),
        )
        .route(
            "/api/v1/operations/{source_operation_id}/undo",
            post(undo_operation),
        )
        .route("/api/v1/parse/quick-entry", post(parse_quick_entry_route))
        .route("/api/v1/parse/filter", post(parse_filter_route))
        .route("/api/v1/parse/text-import", post(parse_text_import_route))
        .route(
            "/api/v1/time-blocks",
            get(list_time_blocks).post(create_time_block),
        )
        .route(
            "/api/v1/time-blocks/{time_block_id}",
            patch(patch_time_block).delete(delete_time_block),
        )
        .route(
            "/api/v1/time-blocks/{time_block_id}/move",
            post(move_time_block),
        )
        .route(
            "/api/v1/time-blocks/{time_block_id}/resize",
            post(resize_time_block),
        )
        .route(
            "/api/v1/time-slots",
            get(list_time_slots).post(create_time_slot),
        )
        .route(
            "/api/v1/time-slots/{time_slot_id}",
            patch(patch_time_slot).delete(delete_time_slot),
        )
        .route(
            "/api/v1/time-slots/{time_slot_id}/tasks",
            post(append_time_slot_task).put(replace_time_slot_tasks),
        )
        .route(
            "/api/v1/time-slots/{time_slot_id}/tasks/{task_id}",
            delete(remove_time_slot_task),
        )
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
pub struct RequestId(pub(crate) String);

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
        routes::health,
        routes::get_profile,
        routes::list_tasks,
        routes::create_task,
        routes::get_task,
        routes::patch_task,
        routes::complete_task,
        routes::uncomplete_task,
        routes::cancel_task,
        routes::reopen_task,
        routes::delete_task,
        routes::move_task,
        routes::reorder_tasks,
        routes::bulk_tasks,
        routes::get_catalog,
        routes::create_project,
        routes::patch_project,
        routes::delete_project,
        routes::create_section,
        routes::patch_section,
        routes::delete_section,
        routes::create_tag,
        routes::patch_tag,
        routes::delete_tag,
        routes::create_template,
        routes::patch_template,
        routes::delete_template,
        routes::apply_template,
        routes::create_saved_filter,
        routes::patch_saved_filter,
        routes::delete_saved_filter,
        routes::list_comments,
        routes::create_comment,
        routes::patch_comment,
        routes::delete_comment,
        routes::list_relations,
        routes::add_relation,
        routes::remove_relation,
        routes::list_task_activity,
        routes::undo_operation,
        routes::parse_quick_entry_route,
        routes::parse_filter_route,
        routes::parse_text_import_route,
        routes::events,
        routes::list_task_reminders,
        routes::reschedule_reminder,
        routes::dismiss_reminder,
        routes::acquire_reminder_lease,
        routes::renew_reminder_lease,
        routes::release_reminder_lease,
        routes::claim_due_reminders,
        routes::settle_reminder_delivered,
        routes::settle_reminder_failed,
        routes::mark_owner_lost_reminders,
        routes::reminder_events,
        routes::list_time_blocks,
        routes::create_time_block,
        routes::patch_time_block,
        routes::delete_time_block,
        routes::move_time_block,
        routes::resize_time_block,
        routes::list_time_slots,
        routes::create_time_slot,
        routes::patch_time_slot,
        routes::delete_time_slot,
        routes::append_time_slot_task,
        routes::replace_time_slot_tasks,
        routes::remove_time_slot_task
    ),
    components(schemas(
        ErrorEnvelope,
        ErrorBody,
        dto::HealthResponse,
        dto::ProfileResponse,
        dto::TaskStatusDto,
        dto::TaskSortDto,
        dto::TaskViewPresetDto,
        dto::ProjectViewDto,
        dto::LocalDueTimeDto,
        dto::TaskDto,
        dto::CreateTaskRequest,
        dto::PatchTaskRequest,
        dto::TaskListResponse,
        dto::OrderAnchorDto,
        dto::MoveTaskRequest,
        dto::ReorderTasksRequest,
        dto::BulkScheduleDto,
        dto::BulkTagChangeDto,
        dto::BulkActionDto,
        dto::BulkTasksRequest,
        dto::ProjectDto,
        dto::SectionDto,
        dto::TagDto,
        dto::TemplateDto,
        dto::SavedFilterDto,
        dto::CatalogResponse,
        dto::CreateProjectRequest,
        dto::PatchProjectRequest,
        dto::CreateSectionRequest,
        dto::PatchSectionRequest,
        dto::CreateTagRequest,
        dto::PatchTagRequest,
        dto::CreateTemplateRequest,
        dto::PatchTemplateRequest,
        dto::ApplyTemplateRequest,
        dto::TemplateVariableDto,
        dto::CreateSavedFilterRequest,
        dto::PatchSavedFilterRequest,
        dto::CommentDto,
        dto::CreateCommentRequest,
        dto::PatchCommentRequest,
        dto::CommentListResponse,
        dto::RelationDto,
        dto::AddRelationRequest,
        dto::RelationListResponse,
        dto::TaskActivityDto,
        dto::TaskActivityResponse,
        dto::ResourceTypeDto,
        dto::ResourceRefDto,
        dto::ResourceSnapshotDto,
        dto::TimeBlockDto,
        dto::TimeSlotDto,
        dto::TimeBlockListResponse,
        dto::TimeSlotListResponse,
        dto::CreateTimeBlockRequest,
        dto::PatchTimeBlockRequest,
        dto::MoveTimeBlockRequest,
        dto::ResizeTimeBlockRequest,
        dto::CreateTimeSlotRequest,
        dto::PatchTimeSlotRequest,
        dto::AppendTimeSlotTaskRequest,
        dto::ReplaceTimeSlotTasksRequest,
        dto::AffectedIdsDto,
        dto::ResyncScopeDto,
        dto::CommittedEventDto,
        dto::MutationResponse,
        dto::ParseQuickEntryRequest,
        dto::QuickEntryDto,
        dto::ParseFilterRequest,
        dto::ParsedFilterResponse,
        dto::TaskFilterDto,
        dto::ParseTextImportRequest,
        dto::TextImportDraftDto,
        dto::TextImportResponse,
        dto::ReminderChannelDto,
        dto::ReminderOccurrenceStateDto,
        dto::ReminderFailureCodeDto,
        dto::ReminderOccurrenceDto,
        dto::ReminderListResponse,
        dto::RescheduleReminderRequest,
        dto::AcquireReminderLeaseRequest,
        dto::RenewReminderLeaseRequest,
        dto::ReleaseReminderLeaseRequest,
        dto::ClaimRemindersRequest,
        dto::SettleReminderDeliveredRequest,
        dto::SettleReminderFailedRequest,
        dto::MarkOwnerLostRemindersRequest,
        dto::ReminderDeliveryLeaseDto,
        dto::ClaimedReminderDto,
        dto::ClaimRemindersResponse,
        dto::MarkOwnerLostRemindersResponse,
        ReminderWakeEventDto
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

// Keep HeaderMap available for security_guard signature stability across refactors.
#[allow(dead_code)]
fn _touch_headers(_: &HeaderMap) {}

#[cfg(test)]
#[path = "tests_api.rs"]
mod tests;
