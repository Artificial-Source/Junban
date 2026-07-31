//! Authenticated `/api/v1` route handlers.

use axum::{
    Json,
    extract::{Extension, Path as AxumPath, Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use jiff::{Zoned, civil::Date, tz::TimeZone};
use junban_domain::{
    CommentId, DailyCapacityMinutes, MAX_QUERY_PAGE_LIMIT, MAX_TAGS_PER_TASK, OperationId,
    ProjectId, SavedFilterId, SectionId, TagId, TaskId, TaskQuery, TaskSort, TaskStatus,
    TemplateId, TimeBlockId, TimeSlotId, WeekStart, parse_filter, parse_quick_entry,
    parse_text_import, validate_page_limit,
};
use serde::Deserialize;
use utoipa::IntoParams;

use crate::cursor::decode_task_cursor;
use crate::dto::{
    AcquireReminderLeaseRequest, AddRelationRequest, AppendTimeSlotTaskRequest,
    ApplyTemplateRequest, BulkTasksRequest, CalendarTasksResponse, CatalogResponse,
    ClaimRemindersRequest, ClaimRemindersResponse, CommentDto, CommentListResponse,
    CreateCommentRequest, CreateProjectRequest, CreateSavedFilterRequest, CreateSectionRequest,
    CreateTagRequest, CreateTaskRequest, CreateTemplateRequest, CreateTimeBlockRequest,
    CreateTimeSlotRequest, DailyPlanResponse, DopamineMenuResponse, EatTheFrogResponse,
    EndOfDayResponse, HealthResponse, MarkOwnerLostRemindersRequest,
    MarkOwnerLostRemindersResponse, MoveTaskRequest, MoveTimeBlockRequest, MutationResponse,
    NudgesResponse, ParseFilterRequest, ParseQuickEntryRequest, ParseTextImportRequest,
    ParsedFilterResponse, PatchCommentRequest, PatchProjectRequest, PatchSavedFilterRequest,
    PatchSectionRequest, PatchTagRequest, PatchTaskRequest, PatchTemplateRequest,
    PatchTimeBlockRequest, PatchTimeSlotRequest, ProfileResponse, QuickEntryDto, RelationDto,
    RelationListResponse, ReleaseReminderLeaseRequest, ReminderDeliveryLeaseDto,
    ReminderListResponse, ReminderOccurrenceDto, RenewReminderLeaseRequest, ReorderTasksRequest,
    ReplaceTimeSlotTasksRequest, RescheduleReminderRequest, ResizeTimeBlockRequest,
    SettleReminderDeliveredRequest, SettleReminderFailedRequest, StatsResponse, TaskActivityDto,
    TaskActivityResponse, TaskDto, TaskJarResponse, TaskListResponse, TaskSortDto,
    TaskViewPresetDto, TemporalSettingsResponse, TextImportDraftDto, TextImportResponse,
    TimeBlockListResponse, TimeSlotListResponse, WeeklyReviewResponse,
};
use crate::error::{ApiError, extract_json, operation_id, parse_path_id, validation_error};
use crate::reminder_wake::open_reminder_sse_stream;
use crate::sse::{MAX_SSE_CONNECTIONS, open_sse_stream};
use crate::{RequestId, ServerState};

// Re-export constants used by list activity defaults.
use junban_app::{ACTIVITY_PAGE_DEFAULT, ACTIVITY_PAGE_MAX, TaskListAsOf};

/// Server-authoritative local civil date for due/overdue evaluation.
pub fn server_as_of_date() -> Date {
    Zoned::now().date()
}

/// One local clock sample for task list evaluation (civil due date + recent-completion UTC bounds).
pub fn server_list_as_of() -> Result<TaskListAsOf, junban_domain::ValidationError> {
    TaskListAsOf::from_zoned(&Zoned::now())
}

/// One system-zone sample for planning/analytics reads (civil date + zone).
pub fn server_planning_clock() -> (Date, TimeZone) {
    let now = Zoned::now();
    (now.date(), now.time_zone().clone())
}

// ── health / profile ───────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/v1/health",
    operation_id = "health",
    responses((status = 200, body = HealthResponse))
)]
pub async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

#[utoipa::path(
    get,
    path = "/api/v1/profile",
    operation_id = "get_profile",
    responses(
        (status = 200, body = ProfileResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn get_profile(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
) -> Result<Json<ProfileResponse>, ApiError> {
    let catalog = state
        .service
        .list_catalog()
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(ProfileResponse {
        revision: catalog.revision,
    }))
}

// ── tasks ──────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListTasksQuery {
    /// Exact built-in view preset. Structured filters are applied in addition.
    pub view: Option<TaskViewPresetDto>,
    pub search: Option<String>,
    pub status: Option<String>,
    /// Omitted = any; `-` = null; UUID = exact match.
    pub project_id: Option<String>,
    pub section_id: Option<String>,
    pub parent_id: Option<String>,
    /// Single tag ID filter (AND-combined with `tag_ids` when both are set).
    pub tag_id: Option<String>,
    /// Comma-separated tag IDs. Tasks must include every listed tag (AND).
    pub tag_ids: Option<String>,
    pub priority: Option<u8>,
    pub due_on: Option<String>,
    pub due_before: Option<String>,
    pub due_after: Option<String>,
    pub someday: Option<bool>,
    pub overdue: Option<bool>,
    pub sort: Option<TaskSortDto>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

fn push_unique_tag_id(tag_ids: &mut Vec<TagId>, tag_id: TagId) {
    if !tag_ids.contains(&tag_id) {
        tag_ids.push(tag_id);
    }
}

fn parse_nullable_id_filter<T, F>(
    raw: Option<&str>,
    parse: F,
    request_id: &RequestId,
) -> Result<Option<Option<T>>, ApiError>
where
    F: FnOnce(&str) -> Result<T, junban_domain::ValidationError>,
{
    match raw {
        None => Ok(None),
        Some("-") => Ok(Some(None)),
        Some(value) => Ok(Some(Some(
            parse(value).map_err(|e| validation_error(e, request_id))?,
        ))),
    }
}

fn parse_date_param(
    raw: Option<&str>,
    field: &'static str,
    request_id: &RequestId,
) -> Result<Option<Date>, ApiError> {
    match raw {
        None => Ok(None),
        Some(value) => value.parse::<Date>().map(Some).map_err(|_| {
            validation_error(
                junban_domain::ValidationError::InvalidFormat {
                    field,
                    expected: "YYYY-MM-DD",
                },
                request_id,
            )
        }),
    }
}

fn build_task_query(
    params: &ListTasksQuery,
    request_id: &RequestId,
) -> Result<(TaskQuery, TaskSort), ApiError> {
    let sort = params.sort.map(Into::into).unwrap_or_default();
    let mut query = TaskQuery {
        sort,
        ..TaskQuery::default()
    };

    query.view = params.view.map(Into::into);

    if let Some(search) = &params.search {
        query.filter.search = Some(search.clone());
    }
    if let Some(status) = &params.status {
        for part in status.split(',') {
            let status = match part.trim() {
                "pending" => TaskStatus::Pending,
                "completed" => TaskStatus::Completed,
                "cancelled" => TaskStatus::Cancelled,
                _ => {
                    return Err(validation_error(
                        junban_domain::ValidationError::InvalidFormat {
                            field: "status",
                            expected: "pending|completed|cancelled",
                        },
                        request_id,
                    ));
                }
            };
            if !query.filter.statuses.contains(&status) {
                query.filter.statuses.push(status);
            }
        }
    }
    if let Some(project) =
        parse_nullable_id_filter(params.project_id.as_deref(), ProjectId::parse, request_id)?
    {
        query.filter.project_id = Some(project);
    }
    if let Some(section) =
        parse_nullable_id_filter(params.section_id.as_deref(), SectionId::parse, request_id)?
    {
        query.filter.section_id = Some(section);
    }
    if let Some(parent) =
        parse_nullable_id_filter(params.parent_id.as_deref(), TaskId::parse, request_id)?
    {
        query.filter.parent_id = Some(parent);
    }
    if let Some(tag_id) = &params.tag_id {
        push_unique_tag_id(
            &mut query.filter.tag_ids,
            TagId::parse(tag_id).map_err(|e| validation_error(e, request_id))?,
        );
    }
    if let Some(tag_ids) = &params.tag_ids {
        for part in tag_ids.split(',') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            push_unique_tag_id(
                &mut query.filter.tag_ids,
                TagId::parse(part).map_err(|e| validation_error(e, request_id))?,
            );
        }
    }
    if query.filter.tag_ids.len() > MAX_TAGS_PER_TASK {
        return Err(validation_error(
            junban_domain::ValidationError::TooMany {
                field: "tag_ids",
                count: query.filter.tag_ids.len(),
                max: MAX_TAGS_PER_TASK,
            },
            request_id,
        ));
    }
    if let Some(priority) = params.priority {
        query.filter.priority = Some(
            junban_domain::Priority::new(priority).map_err(|e| validation_error(e, request_id))?,
        );
    }
    if let Some(due_on) = parse_date_param(params.due_on.as_deref(), "due_on", request_id)? {
        query.filter.due_on = Some(due_on);
    }
    if let Some(due_before) =
        parse_date_param(params.due_before.as_deref(), "due_before", request_id)?
    {
        query.filter.due_before = Some(due_before);
    }
    if let Some(due_after) = parse_date_param(params.due_after.as_deref(), "due_after", request_id)?
    {
        query.filter.due_after = Some(due_after);
    }
    if let Some(someday) = params.someday {
        query.filter.someday = Some(someday);
    }
    if let Some(overdue) = params.overdue {
        query.filter.overdue = Some(overdue);
    }
    if let Some(cursor) = &params.cursor {
        query.cursor = Some(decode_task_cursor(cursor, sort, request_id)?);
    }
    let limit = params.limit.unwrap_or(MAX_QUERY_PAGE_LIMIT);
    validate_page_limit(limit).map_err(|e| validation_error(e, request_id))?;
    query.limit = Some(limit);
    query
        .validate()
        .map_err(|e| validation_error(e, request_id))?;
    Ok((query, sort))
}

#[utoipa::path(
    get,
    path = "/api/v1/tasks",
    operation_id = "list_tasks",
    params(ListTasksQuery),
    responses(
        (status = 200, body = TaskListResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn list_tasks(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Query(params): Query<ListTasksQuery>,
) -> Result<Json<TaskListResponse>, ApiError> {
    let as_of = server_list_as_of().map_err(|e| validation_error(e, &request_id))?;
    let (query, sort) = build_task_query(&params, &request_id)?;
    let page = state
        .service
        .list_tasks(query, as_of)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let response =
        TaskListResponse::from_page(page, sort).map_err(|e| validation_error(e, &request_id))?;
    Ok(Json(response))
}

#[utoipa::path(
    post,
    path = "/api/v1/tasks",
    operation_id = "create_task",
    request_body = CreateTaskRequest,
    params(("Idempotency-Key" = String, Header, format = Uuid)),
    responses(
        (status = 201, body = MutationResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn create_task(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
    payload: Result<Json<CreateTaskRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<MutationResponse>), ApiError> {
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let draft = payload.into_draft(&request_id)?;
    let mutation = state
        .service
        .create_task(operation_id, draft)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok((StatusCode::CREATED, Json(mutation.into())))
}

#[utoipa::path(
    get,
    path = "/api/v1/tasks/{task_id}",
    operation_id = "get_task",
    params(("task_id" = String, Path, format = Uuid)),
    responses(
        (status = 200, body = TaskDto),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn get_task(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
) -> Result<Json<TaskDto>, ApiError> {
    let task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let task = state
        .service
        .get_task(task_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(task.into()))
}

#[utoipa::path(
    patch,
    path = "/api/v1/tasks/{task_id}",
    operation_id = "patch_task",
    request_body = PatchTaskRequest,
    params(
        ("task_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
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
pub async fn patch_task(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<PatchTaskRequest>, JsonRejection>,
) -> Result<Json<MutationResponse>, ApiError> {
    let task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let patch = payload.into_patch(&request_id)?;
    let mutation = state
        .service
        .patch_task(operation_id, task_id, patch)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

macro_rules! task_status_route {
    ($handler:ident, $method:ident, $path:literal, $op:literal) => {
        #[utoipa::path(
                                            post,
                                            path = $path,
                                            operation_id = $op,
                                            params(
                                                ("task_id" = String, Path, format = Uuid),
                                                ("Idempotency-Key" = String, Header, format = Uuid)
                                            ),
                                            responses(
                                                (status = 200, body = MutationResponse),
                                                (status = 401, body = crate::error::ErrorEnvelope),
                                                (status = 404, body = crate::error::ErrorEnvelope),
                                                (status = 409, body = crate::error::ErrorEnvelope),
                                                (status = 413, body = crate::error::ErrorEnvelope),
                                                (status = 422, body = crate::error::ErrorEnvelope),
                                                (status = 503, body = crate::error::ErrorEnvelope)
                                            ),
                                            security(("bearer_auth" = []))
                                        )]
        pub async fn $handler(
            State(state): State<ServerState>,
            Extension(request_id): Extension<RequestId>,
            AxumPath(task_id): AxumPath<String>,
            headers: HeaderMap,
        ) -> Result<Json<MutationResponse>, ApiError> {
            let task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
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

task_status_route!(
    complete_task,
    complete_task,
    "/api/v1/tasks/{task_id}/complete",
    "complete_task"
);
task_status_route!(
    uncomplete_task,
    uncomplete_task,
    "/api/v1/tasks/{task_id}/uncomplete",
    "uncomplete_task"
);
task_status_route!(
    cancel_task,
    cancel_task,
    "/api/v1/tasks/{task_id}/cancel",
    "cancel_task"
);
task_status_route!(
    reopen_task,
    reopen_task,
    "/api/v1/tasks/{task_id}/reopen",
    "reopen_task"
);

#[utoipa::path(
    delete,
    path = "/api/v1/tasks/{task_id}",
    operation_id = "delete_task",
    params(
        ("task_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn delete_task(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<MutationResponse>, ApiError> {
    let task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let mutation = state
        .service
        .delete_task(operation_id, task_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    post,
    path = "/api/v1/tasks/{task_id}/move",
    operation_id = "move_task",
    request_body = MoveTaskRequest,
    params(
        ("task_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
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
pub async fn move_task(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<MoveTaskRequest>, JsonRejection>,
) -> Result<Json<MutationResponse>, ApiError> {
    let task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let target = payload.into_target(&request_id)?;
    let mutation = state
        .service
        .move_task(operation_id, task_id, target)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    post,
    path = "/api/v1/tasks/reorder",
    operation_id = "reorder_tasks",
    request_body = ReorderTasksRequest,
    params(("Idempotency-Key" = String, Header, format = Uuid)),
    responses(
        (status = 200, body = MutationResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn reorder_tasks(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
    payload: Result<Json<ReorderTasksRequest>, JsonRejection>,
) -> Result<Json<MutationResponse>, ApiError> {
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let (scope, ordered_ids) = payload.into_parts(&request_id)?;
    let mutation = state
        .service
        .reorder_tasks(operation_id, scope, ordered_ids)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    post,
    path = "/api/v1/tasks/actions",
    operation_id = "bulk_tasks",
    request_body = BulkTasksRequest,
    params(("Idempotency-Key" = String, Header, format = Uuid)),
    responses(
        (status = 200, body = MutationResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn bulk_tasks(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
    payload: Result<Json<BulkTasksRequest>, JsonRejection>,
) -> Result<Json<MutationResponse>, ApiError> {
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let (task_ids, action) = payload.into_parts(&request_id)?;
    let mutation = state
        .service
        .bulk_tasks(operation_id, task_ids, action)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

// ── catalog ────────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/v1/catalog",
    operation_id = "get_catalog",
    responses(
        (status = 200, body = CatalogResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn get_catalog(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
) -> Result<Json<CatalogResponse>, ApiError> {
    let catalog = state
        .service
        .list_catalog()
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(catalog.into()))
}

macro_rules! catalog_create {
    ($handler:ident, $method:ident, $req:ty, $path:literal, $op:literal) => {
        #[utoipa::path(
                                    post,
                                    path = $path,
                                    operation_id = $op,
                                    request_body = $req,
                                    params(("Idempotency-Key" = String, Header, format = Uuid)),
                                    responses(
                                        (status = 201, body = MutationResponse),
                                        (status = 400, body = crate::error::ErrorEnvelope),
                                        (status = 401, body = crate::error::ErrorEnvelope),
                                        (status = 409, body = crate::error::ErrorEnvelope),
                                        (status = 413, body = crate::error::ErrorEnvelope),
                                        (status = 422, body = crate::error::ErrorEnvelope),
                                        (status = 503, body = crate::error::ErrorEnvelope)
                                    ),
                                    security(("bearer_auth" = []))
                                )]
        pub async fn $handler(
            State(state): State<ServerState>,
            Extension(request_id): Extension<RequestId>,
            headers: HeaderMap,
            payload: Result<Json<$req>, JsonRejection>,
        ) -> Result<(StatusCode, Json<MutationResponse>), ApiError> {
            let operation_id = operation_id(&headers, &request_id)?;
            let payload = extract_json(payload, &request_id)?;
            let draft = payload.into_draft(&request_id)?;
            let mutation = state
                .service
                .$method(operation_id, draft)
                .await
                .map_err(|error| ApiError::from_app(error, &request_id))?;
            Ok((StatusCode::CREATED, Json(mutation.into())))
        }
    };
}

catalog_create!(
    create_project,
    create_project,
    CreateProjectRequest,
    "/api/v1/projects",
    "create_project"
);
catalog_create!(
    create_section,
    create_section,
    CreateSectionRequest,
    "/api/v1/sections",
    "create_section"
);
catalog_create!(
    create_tag,
    create_tag,
    CreateTagRequest,
    "/api/v1/tags",
    "create_tag"
);
catalog_create!(
    create_template,
    create_template,
    CreateTemplateRequest,
    "/api/v1/templates",
    "create_template"
);
catalog_create!(
    create_saved_filter,
    create_saved_filter,
    CreateSavedFilterRequest,
    "/api/v1/saved_filters",
    "create_saved_filter"
);

macro_rules! catalog_patch {
    ($handler:ident, $method:ident, $id_ty:ty, $parse:path, $req:ty, $path:literal, $param:literal, $op:literal) => {
        #[utoipa::path(
                                            patch,
                                            path = $path,
                                            operation_id = $op,
                                            request_body = $req,
                                            params(
                                                ($param = String, Path, format = Uuid),
                                                ("Idempotency-Key" = String, Header, format = Uuid)
                                            ),
                                            responses(
                                                (status = 200, body = MutationResponse),
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
        pub async fn $handler(
            State(state): State<ServerState>,
            Extension(request_id): Extension<RequestId>,
            AxumPath(id): AxumPath<String>,
            headers: HeaderMap,
            payload: Result<Json<$req>, JsonRejection>,
        ) -> Result<Json<MutationResponse>, ApiError> {
            let id = parse_path_id(&id, $parse, &request_id)?;
            let operation_id = operation_id(&headers, &request_id)?;
            let payload = extract_json(payload, &request_id)?;
            let patch = payload.into_patch(&request_id)?;
            let mutation = state
                .service
                .$method(operation_id, id, patch)
                .await
                .map_err(|error| ApiError::from_app(error, &request_id))?;
            Ok(Json(mutation.into()))
        }
    };
}

catalog_patch!(
    patch_project,
    patch_project,
    ProjectId,
    ProjectId::parse,
    PatchProjectRequest,
    "/api/v1/projects/{project_id}",
    "project_id",
    "patch_project"
);
catalog_patch!(
    patch_section,
    patch_section,
    SectionId,
    SectionId::parse,
    PatchSectionRequest,
    "/api/v1/sections/{section_id}",
    "section_id",
    "patch_section"
);
catalog_patch!(
    patch_tag,
    patch_tag,
    TagId,
    TagId::parse,
    PatchTagRequest,
    "/api/v1/tags/{tag_id}",
    "tag_id",
    "patch_tag"
);
catalog_patch!(
    patch_template,
    patch_template,
    TemplateId,
    TemplateId::parse,
    PatchTemplateRequest,
    "/api/v1/templates/{template_id}",
    "template_id",
    "patch_template"
);
catalog_patch!(
    patch_saved_filter,
    patch_saved_filter,
    SavedFilterId,
    SavedFilterId::parse,
    PatchSavedFilterRequest,
    "/api/v1/saved_filters/{filter_id}",
    "filter_id",
    "patch_saved_filter"
);

macro_rules! catalog_delete {
    ($handler:ident, $method:ident, $parse:path, $path:literal, $param:literal, $op:literal) => {
        #[utoipa::path(
                                            delete,
                                            path = $path,
                                            operation_id = $op,
                                            params(
                                                ($param = String, Path, format = Uuid),
                                                ("Idempotency-Key" = String, Header, format = Uuid)
                                            ),
                                            responses(
                                                (status = 200, body = MutationResponse),
                                                (status = 401, body = crate::error::ErrorEnvelope),
                                                (status = 404, body = crate::error::ErrorEnvelope),
                                                (status = 409, body = crate::error::ErrorEnvelope),
                                                (status = 413, body = crate::error::ErrorEnvelope),
                                                (status = 422, body = crate::error::ErrorEnvelope),
                                                (status = 503, body = crate::error::ErrorEnvelope)
                                            ),
                                            security(("bearer_auth" = []))
                                        )]
        pub async fn $handler(
            State(state): State<ServerState>,
            Extension(request_id): Extension<RequestId>,
            AxumPath(id): AxumPath<String>,
            headers: HeaderMap,
        ) -> Result<Json<MutationResponse>, ApiError> {
            let id = parse_path_id(&id, $parse, &request_id)?;
            let operation_id = operation_id(&headers, &request_id)?;
            let mutation = state
                .service
                .$method(operation_id, id)
                .await
                .map_err(|error| ApiError::from_app(error, &request_id))?;
            Ok(Json(mutation.into()))
        }
    };
}

catalog_delete!(
    delete_project,
    delete_project,
    ProjectId::parse,
    "/api/v1/projects/{project_id}",
    "project_id",
    "delete_project"
);
catalog_delete!(
    delete_section,
    delete_section,
    SectionId::parse,
    "/api/v1/sections/{section_id}",
    "section_id",
    "delete_section"
);
catalog_delete!(
    delete_tag,
    delete_tag,
    TagId::parse,
    "/api/v1/tags/{tag_id}",
    "tag_id",
    "delete_tag"
);
catalog_delete!(
    delete_template,
    delete_template,
    TemplateId::parse,
    "/api/v1/templates/{template_id}",
    "template_id",
    "delete_template"
);
catalog_delete!(
    delete_saved_filter,
    delete_saved_filter,
    SavedFilterId::parse,
    "/api/v1/saved_filters/{filter_id}",
    "filter_id",
    "delete_saved_filter"
);

#[utoipa::path(
    post,
    path = "/api/v1/templates/apply",
    operation_id = "apply_template",
    request_body = ApplyTemplateRequest,
    params(("Idempotency-Key" = String, Header, format = Uuid)),
    responses(
        (status = 201, body = MutationResponse),
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
pub async fn apply_template(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
    payload: Result<Json<ApplyTemplateRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<MutationResponse>), ApiError> {
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let apply = payload.into_apply(&request_id)?;
    let mutation = state
        .service
        .apply_template(operation_id, apply)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok((StatusCode::CREATED, Json(mutation.into())))
}

// ── comments / relations / activity ────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/v1/tasks/{task_id}/comments",
    operation_id = "list_comments",
    params(("task_id" = String, Path, format = Uuid)),
    responses(
        (status = 200, body = CommentListResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn list_comments(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
) -> Result<Json<CommentListResponse>, ApiError> {
    let task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let comments = state
        .service
        .list_comments(task_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(CommentListResponse {
        comments: comments.into_iter().map(Into::into).collect(),
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/tasks/{task_id}/comments",
    operation_id = "create_comment",
    request_body = CreateCommentRequest,
    params(
        ("task_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 201, body = MutationResponse),
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
pub async fn create_comment(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<CreateCommentRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<MutationResponse>), ApiError> {
    let task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let mutation = state
        .service
        .create_comment(operation_id, task_id, payload.content)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok((StatusCode::CREATED, Json(mutation.into())))
}

#[utoipa::path(
    patch,
    path = "/api/v1/comments/{comment_id}",
    operation_id = "patch_comment",
    request_body = PatchCommentRequest,
    params(
        ("comment_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
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
pub async fn patch_comment(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(comment_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<PatchCommentRequest>, JsonRejection>,
) -> Result<Json<MutationResponse>, ApiError> {
    let comment_id = parse_path_id(&comment_id, CommentId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let mutation = state
        .service
        .patch_comment(operation_id, comment_id, payload.content)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    delete,
    path = "/api/v1/comments/{comment_id}",
    operation_id = "delete_comment",
    params(
        ("comment_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn delete_comment(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(comment_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<MutationResponse>, ApiError> {
    let comment_id = parse_path_id(&comment_id, CommentId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let mutation = state
        .service
        .delete_comment(operation_id, comment_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    get,
    path = "/api/v1/tasks/{task_id}/relations",
    operation_id = "list_relations",
    params(("task_id" = String, Path, format = Uuid)),
    responses(
        (status = 200, body = RelationListResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn list_relations(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
) -> Result<Json<RelationListResponse>, ApiError> {
    let task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let relations = state
        .service
        .list_relations(task_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(RelationListResponse {
        relations: relations.into_iter().map(Into::into).collect(),
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/tasks/{task_id}/relations",
    operation_id = "add_relation",
    request_body = AddRelationRequest,
    params(
        ("task_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 201, body = MutationResponse),
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
pub async fn add_relation(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<AddRelationRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<MutationResponse>), ApiError> {
    let from_task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    if payload.kind != "blocks" {
        return Err(validation_error(
            junban_domain::ValidationError::InvalidFormat {
                field: "kind",
                expected: "blocks",
            },
            &request_id,
        ));
    }
    let to_task_id =
        TaskId::parse(&payload.to_task_id).map_err(|e| validation_error(e, &request_id))?;
    let mutation = state
        .service
        .add_blocks_relation(operation_id, from_task_id, to_task_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok((StatusCode::CREATED, Json(mutation.into())))
}

#[utoipa::path(
    delete,
    path = "/api/v1/tasks/{task_id}/relations/{to_task_id}",
    operation_id = "remove_relation",
    params(
        ("task_id" = String, Path, format = Uuid),
        ("to_task_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid),
        ("kind" = Option<String>, Query)
    ),
    responses(
        (status = 200, body = MutationResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn remove_relation(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath((task_id, to_task_id)): AxumPath<(String, String)>,
    Query(query): Query<RelationKindQuery>,
    headers: HeaderMap,
) -> Result<Json<MutationResponse>, ApiError> {
    let from_task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let to_task_id = parse_path_id(&to_task_id, TaskId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let kind = query.kind.as_deref().unwrap_or("blocks");
    if kind != "blocks" {
        return Err(validation_error(
            junban_domain::ValidationError::InvalidFormat {
                field: "kind",
                expected: "blocks",
            },
            &request_id,
        ));
    }
    let mutation = state
        .service
        .remove_blocks_relation(operation_id, from_task_id, to_task_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[derive(Debug, Default, Deserialize)]
pub struct RelationKindQuery {
    kind: Option<String>,
}

#[derive(Debug, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ActivityQuery {
    pub after_revision: Option<u64>,
    pub after_sequence: Option<u32>,
    pub limit: Option<u32>,
}

#[utoipa::path(
    get,
    path = "/api/v1/tasks/{task_id}/activity",
    operation_id = "list_task_activity",
    params(
        ("task_id" = String, Path, format = Uuid),
        ActivityQuery
    ),
    responses(
        (status = 200, body = TaskActivityResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn list_task_activity(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
    Query(query): Query<ActivityQuery>,
) -> Result<Json<TaskActivityResponse>, ApiError> {
    let task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let limit = query.limit.unwrap_or(ACTIVITY_PAGE_DEFAULT);
    if limit == 0 || limit > ACTIVITY_PAGE_MAX {
        return Err(validation_error(
            junban_domain::ValidationError::OutOfRange {
                field: "limit",
                min: 1,
                max: i64::from(ACTIVITY_PAGE_MAX),
            },
            &request_id,
        ));
    }
    let activity = state
        .service
        .list_task_activity(task_id, query.after_revision, query.after_sequence, limit)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(TaskActivityResponse {
        activity: activity.into_iter().map(Into::into).collect(),
    }))
}

// ── undo / parsers / events ────────────────────────────────────────────────

#[utoipa::path(
    post,
    path = "/api/v1/operations/{source_operation_id}/undo",
    operation_id = "undo_operation",
    params(
        ("source_operation_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn undo_operation(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(source_operation_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<MutationResponse>, ApiError> {
    let source_operation_id = parse_path_id(&source_operation_id, OperationId::parse, &request_id)?;
    // The new Idempotency-Key is the undo operation ID.
    let new_operation_id = operation_id(&headers, &request_id)?;
    let mutation = state
        .service
        .undo(source_operation_id, new_operation_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    post,
    path = "/api/v1/parse/quick-entry",
    operation_id = "parse_quick_entry",
    request_body = ParseQuickEntryRequest,
    responses(
        (status = 200, body = QuickEntryDto),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn parse_quick_entry_route(
    Extension(request_id): Extension<RequestId>,
    payload: Result<Json<ParseQuickEntryRequest>, JsonRejection>,
) -> Result<Json<QuickEntryDto>, ApiError> {
    let payload = extract_json(payload, &request_id)?;
    let as_of_date = server_as_of_date();
    let entry = parse_quick_entry(&payload.input, as_of_date)
        .map_err(|e| validation_error(e, &request_id))?;
    Ok(Json(entry.into()))
}

#[utoipa::path(
    post,
    path = "/api/v1/parse/filter",
    operation_id = "parse_filter",
    request_body = ParseFilterRequest,
    responses(
        (status = 200, body = ParsedFilterResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn parse_filter_route(
    Extension(request_id): Extension<RequestId>,
    payload: Result<Json<ParseFilterRequest>, JsonRejection>,
) -> Result<Json<ParsedFilterResponse>, ApiError> {
    let payload = extract_json(payload, &request_id)?;
    let as_of_date = server_as_of_date();
    let query =
        parse_filter(&payload.input, as_of_date).map_err(|e| validation_error(e, &request_id))?;
    let mut response = ParsedFilterResponse::from(query);
    response.as_of_date = as_of_date;
    Ok(Json(response))
}

#[utoipa::path(
    post,
    path = "/api/v1/parse/text-import",
    operation_id = "parse_text_import",
    request_body = ParseTextImportRequest,
    responses(
        (status = 200, body = TextImportResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn parse_text_import_route(
    Extension(request_id): Extension<RequestId>,
    payload: Result<Json<ParseTextImportRequest>, JsonRejection>,
) -> Result<Json<TextImportResponse>, ApiError> {
    let payload = extract_json(payload, &request_id)?;
    let drafts = parse_text_import(&payload.input).map_err(|e| validation_error(e, &request_id))?;
    Ok(Json(TextImportResponse {
        drafts: drafts.into_iter().map(Into::into).collect(),
    }))
}

#[derive(Debug, Default, Deserialize)]
pub struct EventQuery {
    since: Option<u64>,
}

#[utoipa::path(
    get,
    path = "/api/v1/events",
    operation_id = "events",
    params(
        ("since" = Option<u64>, Query),
        ("Last-Event-ID" = Option<u64>, Header)
    ),
    responses(
        (status = 200, description = "Revisioned committed-event stream", content_type = "text/event-stream"),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn events(
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

    let permit = state.try_acquire_sse().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "sse_connection_limit",
            "too many concurrent event streams",
            true,
            &request_id,
        )
    })?;

    // Subscribe first so commits racing with durable catch-up remain queued.
    let receiver = state.events.subscribe();
    let catch_up = state
        .service
        .list_events(since)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;

    Ok(open_sse_stream(
        state.service.clone(),
        receiver,
        catch_up,
        since,
        state.shutdown_token(),
        permit,
        std::sync::Arc::clone(&state.active_forwarders),
    ))
}

// ── reminders ──────────────────────────────────────────────────────────────

fn parse_fence_term(
    raw: &str,
    request_id: &RequestId,
) -> Result<junban_domain::ReminderFenceTerm, ApiError> {
    junban_domain::ReminderFenceTerm::parse(raw).map_err(|e| validation_error(e, request_id))
}

#[utoipa::path(
    get,
    path = "/api/v1/tasks/{task_id}/reminders",
    operation_id = "list_task_reminders",
    params(("task_id" = String, Path, format = Uuid)),
    responses(
        (status = 200, body = ReminderListResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn list_task_reminders(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
) -> Result<Json<ReminderListResponse>, ApiError> {
    let task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let reminders = state
        .service
        .list_task_reminders(task_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(ReminderListResponse {
        reminders: reminders
            .into_iter()
            .map(ReminderOccurrenceDto::from)
            .collect(),
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/tasks/{task_id}/reminders/reschedule",
    operation_id = "reschedule_reminder",
    request_body = RescheduleReminderRequest,
    params(
        ("task_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
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
pub async fn reschedule_reminder(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<RescheduleReminderRequest>, JsonRejection>,
) -> Result<Json<MutationResponse>, ApiError> {
    let task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let mutation = state
        .service
        .reschedule_reminder(operation_id, task_id, payload.remind_at)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    post,
    path = "/api/v1/tasks/{task_id}/reminders/dismiss",
    operation_id = "dismiss_reminder",
    params(
        ("task_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn dismiss_reminder(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(task_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<MutationResponse>, ApiError> {
    let task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let mutation = state
        .service
        .dismiss_reminder(operation_id, task_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    post,
    path = "/api/v1/reminders/lease",
    operation_id = "acquire_reminder_lease",
    request_body = AcquireReminderLeaseRequest,
    responses(
        (status = 200, body = ReminderDeliveryLeaseDto),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn acquire_reminder_lease(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    payload: Result<Json<AcquireReminderLeaseRequest>, JsonRejection>,
) -> Result<Json<ReminderDeliveryLeaseDto>, ApiError> {
    let payload = extract_json(payload, &request_id)?;
    let lease = state
        .service
        .acquire_reminder_lease(payload.lease_secs)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    state.notify_reminder_wake();
    Ok(Json(lease.into()))
}

#[utoipa::path(
    post,
    path = "/api/v1/reminders/lease/renew",
    operation_id = "renew_reminder_lease",
    request_body = RenewReminderLeaseRequest,
    responses(
        (status = 200, body = ReminderDeliveryLeaseDto),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn renew_reminder_lease(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    payload: Result<Json<RenewReminderLeaseRequest>, JsonRejection>,
) -> Result<Json<ReminderDeliveryLeaseDto>, ApiError> {
    let payload = extract_json(payload, &request_id)?;
    let fence_term = parse_fence_term(&payload.fence_term, &request_id)?;
    let lease = state
        .service
        .renew_reminder_lease(fence_term, payload.lease_secs)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    state.notify_reminder_wake();
    Ok(Json(lease.into()))
}

#[utoipa::path(
    post,
    path = "/api/v1/reminders/lease/release",
    operation_id = "release_reminder_lease",
    request_body = ReleaseReminderLeaseRequest,
    responses(
        (status = 204),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn release_reminder_lease(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    payload: Result<Json<ReleaseReminderLeaseRequest>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let payload = extract_json(payload, &request_id)?;
    let fence_term = parse_fence_term(&payload.fence_term, &request_id)?;
    state
        .service
        .release_reminder_lease(fence_term)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    state.notify_reminder_wake();
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/v1/reminders/claim",
    operation_id = "claim_due_reminders",
    request_body = ClaimRemindersRequest,
    responses(
        (status = 200, body = ClaimRemindersResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn claim_due_reminders(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    payload: Result<Json<ClaimRemindersRequest>, JsonRejection>,
) -> Result<Json<ClaimRemindersResponse>, ApiError> {
    let payload = extract_json(payload, &request_id)?;
    let fence_term = parse_fence_term(&payload.fence_term, &request_id)?;
    let reminders = state
        .service
        .claim_due_reminders(fence_term, payload.limit, payload.claim_secs)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    state.notify_reminder_wake();
    Ok(Json(ClaimRemindersResponse {
        reminders: reminders.into_iter().map(Into::into).collect(),
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/reminders/settle/delivered",
    operation_id = "settle_reminder_delivered",
    request_body = SettleReminderDeliveredRequest,
    responses(
        (status = 204),
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
pub async fn settle_reminder_delivered(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    payload: Result<Json<SettleReminderDeliveredRequest>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let payload = extract_json(payload, &request_id)?;
    let fence_term = parse_fence_term(&payload.fence_term, &request_id)?;
    let task_id = TaskId::parse(&payload.task_id).map_err(|e| validation_error(e, &request_id))?;
    state
        .service
        .settle_reminder_delivered(
            fence_term,
            task_id,
            payload.remind_at,
            payload.claim_attempt,
            payload.channel.into(),
        )
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    state.notify_reminder_wake();
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/v1/reminders/settle/failed",
    operation_id = "settle_reminder_failed",
    request_body = SettleReminderFailedRequest,
    responses(
        (status = 204),
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
pub async fn settle_reminder_failed(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    payload: Result<Json<SettleReminderFailedRequest>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let payload = extract_json(payload, &request_id)?;
    let fence_term = parse_fence_term(&payload.fence_term, &request_id)?;
    let task_id = TaskId::parse(&payload.task_id).map_err(|e| validation_error(e, &request_id))?;
    state
        .service
        .settle_reminder_failed(
            fence_term,
            task_id,
            payload.remind_at,
            payload.claim_attempt,
            payload.error.into(),
        )
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    state.notify_reminder_wake();
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/v1/reminders/owner-lost",
    operation_id = "mark_owner_lost_reminders",
    request_body = MarkOwnerLostRemindersRequest,
    responses(
        (status = 200, body = MarkOwnerLostRemindersResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn mark_owner_lost_reminders(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    payload: Result<Json<MarkOwnerLostRemindersRequest>, JsonRejection>,
) -> Result<Json<MarkOwnerLostRemindersResponse>, ApiError> {
    let payload = extract_json(payload, &request_id)?;
    let fence_term = parse_fence_term(&payload.fence_term, &request_id)?;
    let marked = state
        .service
        .mark_owner_lost_reminders(fence_term, payload.limit)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    state.notify_reminder_wake();
    Ok(Json(MarkOwnerLostRemindersResponse { marked }))
}

#[utoipa::path(
    get,
    path = "/api/v1/reminders/events",
    operation_id = "reminder_events",
    responses(
        (
            status = 200,
            description = "Ephemeral reminder wake stream (not revisioned task events)",
            content_type = "text/event-stream",
            body = crate::reminder_wake::ReminderWakeEventDto
        ),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn reminder_events(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
) -> Result<impl IntoResponse, ApiError> {
    let permit = state.try_acquire_sse().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "sse_connection_limit",
            "too many concurrent event streams",
            true,
            &request_id,
        )
    })?;

    // Subscribe before the immediate snapshot so live wakes stay queued.
    let receiver = state.reminder_wakes.subscribe();
    Ok(open_reminder_sse_stream(
        std::sync::Arc::clone(&state.reminder_wakes),
        receiver,
        state.shutdown_token(),
        permit,
        std::sync::Arc::clone(&state.active_forwarders),
    ))
}

// ── time blocks / time slots ───────────────────────────────────────────────

#[derive(Debug, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListTimeBlocksQuery {
    /// Inclusive civil start date (`YYYY-MM-DD`). Defaults to server-local today.
    pub from: Option<String>,
    /// Inclusive civil end date (`YYYY-MM-DD`). Defaults to `from`.
    pub to: Option<String>,
}

#[derive(Debug, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListTimeSlotsQuery {
    /// Civil date filter (`YYYY-MM-DD`). Defaults to server-local today.
    pub date: Option<String>,
    /// Optional project filter. Use `-` for unscoped slots.
    pub project_id: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/v1/time-blocks",
    operation_id = "list_time_blocks",
    params(ListTimeBlocksQuery),
    responses(
        (status = 200, body = TimeBlockListResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn list_time_blocks(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<ListTimeBlocksQuery>,
) -> Result<Json<TimeBlockListResponse>, ApiError> {
    let today = server_as_of_date();
    let from = parse_date_param(query.from.as_deref(), "from", &request_id)?.unwrap_or(today);
    let to = parse_date_param(query.to.as_deref(), "to", &request_id)?.unwrap_or(from);
    let page = state
        .service
        .list_timeblocking_range(from, to)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(TimeBlockListResponse {
        time_blocks: page.blocks.into_iter().map(Into::into).collect(),
        revision: page.revision,
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/time-blocks",
    operation_id = "create_time_block",
    request_body = CreateTimeBlockRequest,
    params(("Idempotency-Key" = String, Header, format = Uuid)),
    responses(
        (status = 201, body = MutationResponse),
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
pub async fn create_time_block(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
    payload: Result<Json<CreateTimeBlockRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<MutationResponse>), ApiError> {
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let draft = payload.into_draft(&request_id)?;
    let mutation = state
        .service
        .create_time_block(operation_id, draft)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok((StatusCode::CREATED, Json(mutation.into())))
}

#[utoipa::path(
    patch,
    path = "/api/v1/time-blocks/{time_block_id}",
    operation_id = "patch_time_block",
    request_body = PatchTimeBlockRequest,
    params(
        ("time_block_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
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
pub async fn patch_time_block(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(time_block_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<PatchTimeBlockRequest>, JsonRejection>,
) -> Result<Json<MutationResponse>, ApiError> {
    let time_block_id = parse_path_id(&time_block_id, TimeBlockId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let patch = payload.into_patch(&request_id)?;
    let mutation = state
        .service
        .patch_time_block(operation_id, time_block_id, patch)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    delete,
    path = "/api/v1/time-blocks/{time_block_id}",
    operation_id = "delete_time_block",
    params(
        ("time_block_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn delete_time_block(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(time_block_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<MutationResponse>, ApiError> {
    let time_block_id = parse_path_id(&time_block_id, TimeBlockId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let mutation = state
        .service
        .delete_time_block(operation_id, time_block_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    post,
    path = "/api/v1/time-blocks/{time_block_id}/move",
    operation_id = "move_time_block",
    request_body = MoveTimeBlockRequest,
    params(
        ("time_block_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
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
pub async fn move_time_block(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(time_block_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<MoveTimeBlockRequest>, JsonRejection>,
) -> Result<Json<MutationResponse>, ApiError> {
    let time_block_id = parse_path_id(&time_block_id, TimeBlockId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let range = payload.into_range(&request_id)?;
    let mutation = state
        .service
        .move_time_block(operation_id, time_block_id, range)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    post,
    path = "/api/v1/time-blocks/{time_block_id}/resize",
    operation_id = "resize_time_block",
    request_body = ResizeTimeBlockRequest,
    params(
        ("time_block_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
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
pub async fn resize_time_block(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(time_block_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<ResizeTimeBlockRequest>, JsonRejection>,
) -> Result<Json<MutationResponse>, ApiError> {
    let time_block_id = parse_path_id(&time_block_id, TimeBlockId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let range = payload.into_range(&request_id)?;
    let mutation = state
        .service
        .resize_time_block(operation_id, time_block_id, range)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    get,
    path = "/api/v1/time-slots",
    operation_id = "list_time_slots",
    params(ListTimeSlotsQuery),
    responses(
        (status = 200, body = TimeSlotListResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn list_time_slots(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<ListTimeSlotsQuery>,
) -> Result<Json<TimeSlotListResponse>, ApiError> {
    let date = parse_date_param(query.date.as_deref(), "date", &request_id)?
        .unwrap_or_else(server_as_of_date);
    let project_filter =
        parse_nullable_id_filter(query.project_id.as_deref(), ProjectId::parse, &request_id)?;
    let page = state
        .service
        .list_timeblocking_range(date, date)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let time_slots = page
        .slots
        .into_iter()
        .filter(|slot| match project_filter {
            None => true,
            Some(None) => slot.project_id.is_none(),
            Some(Some(project_id)) => slot.project_id == Some(project_id),
        })
        .map(Into::into)
        .collect();
    Ok(Json(TimeSlotListResponse {
        time_slots,
        revision: page.revision,
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/time-slots",
    operation_id = "create_time_slot",
    request_body = CreateTimeSlotRequest,
    params(("Idempotency-Key" = String, Header, format = Uuid)),
    responses(
        (status = 201, body = MutationResponse),
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
pub async fn create_time_slot(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
    payload: Result<Json<CreateTimeSlotRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<MutationResponse>), ApiError> {
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let draft = payload.into_draft(&request_id)?;
    let mutation = state
        .service
        .create_time_slot(operation_id, draft)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok((StatusCode::CREATED, Json(mutation.into())))
}

#[utoipa::path(
    patch,
    path = "/api/v1/time-slots/{time_slot_id}",
    operation_id = "patch_time_slot",
    request_body = PatchTimeSlotRequest,
    params(
        ("time_slot_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
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
pub async fn patch_time_slot(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(time_slot_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<PatchTimeSlotRequest>, JsonRejection>,
) -> Result<Json<MutationResponse>, ApiError> {
    let time_slot_id = parse_path_id(&time_slot_id, TimeSlotId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let patch = payload.into_patch(&request_id)?;
    let mutation = state
        .service
        .patch_time_slot(operation_id, time_slot_id, patch)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    delete,
    path = "/api/v1/time-slots/{time_slot_id}",
    operation_id = "delete_time_slot",
    params(
        ("time_slot_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn delete_time_slot(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(time_slot_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<MutationResponse>, ApiError> {
    let time_slot_id = parse_path_id(&time_slot_id, TimeSlotId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let mutation = state
        .service
        .delete_time_slot(operation_id, time_slot_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    post,
    path = "/api/v1/time-slots/{time_slot_id}/tasks",
    operation_id = "append_time_slot_task",
    request_body = AppendTimeSlotTaskRequest,
    params(
        ("time_slot_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
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
pub async fn append_time_slot_task(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(time_slot_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<AppendTimeSlotTaskRequest>, JsonRejection>,
) -> Result<Json<MutationResponse>, ApiError> {
    let time_slot_id = parse_path_id(&time_slot_id, TimeSlotId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let task_id = payload.into_task_id(&request_id)?;
    let mutation = state
        .service
        .append_slot_task(operation_id, time_slot_id, task_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    put,
    path = "/api/v1/time-slots/{time_slot_id}/tasks",
    operation_id = "replace_time_slot_tasks",
    request_body = ReplaceTimeSlotTasksRequest,
    params(
        ("time_slot_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
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
pub async fn replace_time_slot_tasks(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath(time_slot_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<ReplaceTimeSlotTasksRequest>, JsonRejection>,
) -> Result<Json<MutationResponse>, ApiError> {
    let time_slot_id = parse_path_id(&time_slot_id, TimeSlotId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json(payload, &request_id)?;
    let ordered_ids = payload.into_task_ids(&request_id)?;
    let mutation = state
        .service
        .reorder_slot_tasks(operation_id, time_slot_id, ordered_ids)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(
    delete,
    path = "/api/v1/time-slots/{time_slot_id}/tasks/{task_id}",
    operation_id = "remove_time_slot_task",
    params(
        ("time_slot_id" = String, Path, format = Uuid),
        ("task_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid)
    ),
    responses(
        (status = 200, body = MutationResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn remove_time_slot_task(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    AxumPath((time_slot_id, task_id)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<MutationResponse>, ApiError> {
    let time_slot_id = parse_path_id(&time_slot_id, TimeSlotId::parse, &request_id)?;
    let task_id = parse_path_id(&task_id, TaskId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let mutation = state
        .service
        .remove_slot_task(operation_id, time_slot_id, task_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

// ── planning / analytics reads ─────────────────────────────────────────────

#[derive(Debug, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct CalendarTasksQuery {
    /// Inclusive civil start date (`YYYY-MM-DD`). Required.
    pub from: Option<String>,
    /// Inclusive civil end date (`YYYY-MM-DD`). Required.
    pub to: Option<String>,
    /// Optional exact project filter.
    pub project_id: Option<String>,
}

#[derive(Debug, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PlanningDateQuery {
    /// Civil date (`YYYY-MM-DD`). Defaults to server-local today.
    pub date: Option<String>,
    /// Daily capacity in whole minutes. Defaults to 480.
    pub capacity_minutes: Option<u32>,
}

#[derive(Debug, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct WeeklyReviewQuery {
    /// Civil date inside the current week (`YYYY-MM-DD`). Defaults to server-local today.
    pub date: Option<String>,
    /// Week start: `sunday` (default) or `monday`.
    pub week_start: Option<String>,
}

#[derive(Debug, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct StatsQuery {
    /// Inclusive civil start date (`YYYY-MM-DD`). Required.
    pub from: Option<String>,
    /// Inclusive civil end date (`YYYY-MM-DD`). Required.
    pub to: Option<String>,
}

#[derive(Debug, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct MotivationDateQuery {
    /// Civil date (`YYYY-MM-DD`). Defaults to server-local today.
    pub date: Option<String>,
}

fn require_date_param(
    raw: Option<&str>,
    field: &'static str,
    request_id: &RequestId,
) -> Result<Date, ApiError> {
    parse_date_param(raw, field, request_id)?.ok_or_else(|| {
        validation_error(junban_domain::ValidationError::Empty { field }, request_id)
    })
}

fn parse_capacity_param(
    raw: Option<u32>,
    request_id: &RequestId,
) -> Result<Option<DailyCapacityMinutes>, ApiError> {
    match raw {
        None => Ok(None),
        Some(value) => DailyCapacityMinutes::new(value)
            .map(Some)
            .map_err(|error| validation_error(error, request_id)),
    }
}

fn parse_week_start_param(
    raw: Option<&str>,
    request_id: &RequestId,
) -> Result<WeekStart, ApiError> {
    match raw {
        None => Ok(WeekStart::Sunday),
        Some(value) => WeekStart::parse(value).map_err(|error| validation_error(error, request_id)),
    }
}

fn id_strings(ids: impl IntoIterator<Item = junban_domain::TaskId>) -> Vec<String> {
    ids.into_iter().map(|id| id.to_string()).collect()
}

#[utoipa::path(
    get,
    path = "/api/v1/calendar/tasks",
    operation_id = "calendar_tasks",
    params(CalendarTasksQuery),
    responses(
        (status = 200, body = CalendarTasksResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn calendar_tasks(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<CalendarTasksQuery>,
) -> Result<Json<CalendarTasksResponse>, ApiError> {
    let from = require_date_param(query.from.as_deref(), "from", &request_id)?;
    let to = require_date_param(query.to.as_deref(), "to", &request_id)?;
    let project_id = match query.project_id.as_deref() {
        None => None,
        Some(raw) => Some(ProjectId::parse(raw).map_err(|e| validation_error(e, &request_id))?),
    };
    let as_of = server_list_as_of().map_err(|error| validation_error(error, &request_id))?;
    let page = state
        .service
        .calendar_tasks(from, to, project_id, as_of)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(CalendarTasksResponse {
        tasks: page.tasks.into_iter().map(Into::into).collect(),
        revision: page.revision,
    }))
}

#[utoipa::path(
    get,
    path = "/api/v1/planning/daily",
    operation_id = "planning_daily",
    params(PlanningDateQuery),
    responses(
        (status = 200, body = DailyPlanResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn planning_daily(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<PlanningDateQuery>,
) -> Result<Json<DailyPlanResponse>, ApiError> {
    let (today, zone) = server_planning_clock();
    let date = parse_date_param(query.date.as_deref(), "date", &request_id)?.unwrap_or(today);
    let capacity = parse_capacity_param(query.capacity_minutes, &request_id)?;
    let page = state
        .service
        .daily_plan(date, capacity, &zone)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(DailyPlanResponse {
        overdue_task_ids: id_strings(page.overdue_task_ids),
        overdue_tasks: page.overdue_tasks.into_iter().map(Into::into).collect(),
        focus_task_ids: id_strings(page.focus_task_ids),
        focus_tasks: page.focus_tasks.into_iter().map(Into::into).collect(),
        estimated_total_minutes: page.estimated_total_minutes,
        capacity_minutes: page.capacity_minutes,
        revision: page.revision,
    }))
}

#[utoipa::path(
    get,
    path = "/api/v1/planning/end-of-day",
    operation_id = "planning_end_of_day",
    params(PlanningDateQuery),
    responses(
        (status = 200, body = EndOfDayResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn planning_end_of_day(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<PlanningDateQuery>,
) -> Result<Json<EndOfDayResponse>, ApiError> {
    let (today, zone) = server_planning_clock();
    let date = parse_date_param(query.date.as_deref(), "date", &request_id)?.unwrap_or(today);
    let capacity = parse_capacity_param(query.capacity_minutes, &request_id)?;
    let page = state
        .service
        .end_of_day(date, capacity, &zone)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(EndOfDayResponse {
        win_task_ids: id_strings(page.win_task_ids),
        win_tasks: page.win_tasks.into_iter().map(Into::into).collect(),
        carry_over_task_ids: id_strings(page.carry_over_task_ids),
        carry_over_tasks: page.carry_over_tasks.into_iter().map(Into::into).collect(),
        tomorrow_task_ids: id_strings(page.tomorrow_task_ids),
        tomorrow_tasks: page.tomorrow_tasks.into_iter().map(Into::into).collect(),
        tomorrow_estimated_minutes: page.tomorrow_estimated_minutes,
        completion_rate_percent: page.completion_rate_percent,
        capacity_minutes: page.capacity_minutes,
        revision: page.revision,
    }))
}

#[utoipa::path(
    get,
    path = "/api/v1/planning/weekly",
    operation_id = "planning_weekly",
    params(WeeklyReviewQuery),
    responses(
        (status = 200, body = WeeklyReviewResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn planning_weekly(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<WeeklyReviewQuery>,
) -> Result<Json<WeeklyReviewResponse>, ApiError> {
    let (today, zone) = server_planning_clock();
    let date = parse_date_param(query.date.as_deref(), "date", &request_id)?.unwrap_or(today);
    let week_start = parse_week_start_param(query.week_start.as_deref(), &request_id)?;
    let page = state
        .service
        .weekly_review(date, week_start, &zone)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(WeeklyReviewResponse::from_page(page)))
}

#[utoipa::path(
    get,
    path = "/api/v1/stats",
    operation_id = "stats",
    params(StatsQuery),
    responses(
        (status = 200, body = StatsResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn stats(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<StatsQuery>,
) -> Result<Json<StatsResponse>, ApiError> {
    let from = require_date_param(query.from.as_deref(), "from", &request_id)?;
    let to = require_date_param(query.to.as_deref(), "to", &request_id)?;
    let (today, zone) = server_planning_clock();
    let page = state
        .service
        .stats(from, to, today, &zone)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(StatsResponse::from_page(page)))
}

#[utoipa::path(
    get,
    path = "/api/v1/nudges",
    operation_id = "nudges",
    params(PlanningDateQuery),
    responses(
        (status = 200, body = NudgesResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn nudges(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<PlanningDateQuery>,
) -> Result<Json<NudgesResponse>, ApiError> {
    let (today, zone) = server_planning_clock();
    let date = parse_date_param(query.date.as_deref(), "date", &request_id)?.unwrap_or(today);
    let capacity = parse_capacity_param(query.capacity_minutes, &request_id)?;
    let page = state
        .service
        .nudges(date, capacity, &zone)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(NudgesResponse::from_page(page)))
}

#[utoipa::path(
    get,
    path = "/api/v1/settings/temporal",
    operation_id = "get_temporal_settings",
    responses(
        (status = 200, body = TemporalSettingsResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn get_temporal_settings() -> Json<TemporalSettingsResponse> {
    let (_, zone) = server_planning_clock();
    Json(junban_app::default_temporal_settings(&zone).into())
}

#[utoipa::path(
    get,
    path = "/api/v1/motivation/eat-the-frog",
    operation_id = "motivation_eat_the_frog",
    params(MotivationDateQuery),
    responses(
        (status = 200, body = EatTheFrogResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn motivation_eat_the_frog(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<MotivationDateQuery>,
) -> Result<Json<EatTheFrogResponse>, ApiError> {
    let (today, zone) = server_planning_clock();
    let date = parse_date_param(query.date.as_deref(), "date", &request_id)?.unwrap_or(today);
    let page = state
        .service
        .eat_the_frog(date, &zone)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(EatTheFrogResponse {
        task: page.task.map(Into::into),
        revision: page.revision,
    }))
}

#[utoipa::path(
    get,
    path = "/api/v1/motivation/task-jar",
    operation_id = "motivation_task_jar",
    params(MotivationDateQuery),
    responses(
        (status = 200, body = TaskJarResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn motivation_task_jar(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<MotivationDateQuery>,
) -> Result<Json<TaskJarResponse>, ApiError> {
    let (today, zone) = server_planning_clock();
    let date = parse_date_param(query.date.as_deref(), "date", &request_id)?.unwrap_or(today);
    let page = state
        .service
        .task_jar(date, &zone)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(TaskJarResponse {
        task_ids: id_strings(page.task_ids),
        tasks: page.tasks.into_iter().map(Into::into).collect(),
        revision: page.revision,
    }))
}

#[utoipa::path(
    get,
    path = "/api/v1/motivation/dopamine-menu",
    operation_id = "motivation_dopamine_menu",
    params(MotivationDateQuery),
    responses(
        (status = 200, body = DopamineMenuResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn motivation_dopamine_menu(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<MotivationDateQuery>,
) -> Result<Json<DopamineMenuResponse>, ApiError> {
    let (today, zone) = server_planning_clock();
    let date = parse_date_param(query.date.as_deref(), "date", &request_id)?.unwrap_or(today);
    let page = state
        .service
        .dopamine_menu(date, &zone)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(DopamineMenuResponse {
        task_ids: id_strings(page.task_ids),
        tasks: page.tasks.into_iter().map(Into::into).collect(),
        revision: page.revision,
    }))
}

pub async fn api_not_found(Extension(request_id): Extension<RequestId>) -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "api_not_found",
        "API route was not found",
        false,
        &request_id,
    )
}

// Silence unused import warnings for types referenced only by utoipa macros in some builds.
const _: fn() = || {
    let _: Option<CommentDto> = None;
    let _: Option<RelationDto> = None;
    let _: Option<TaskActivityDto> = None;
    let _: Option<TextImportDraftDto> = None;
    let _: Option<ReminderOccurrenceDto> = None;
    let _: usize = MAX_SSE_CONNECTIONS;
};
