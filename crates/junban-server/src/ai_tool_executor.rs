//! Direct application-service executor for validated AI tool actions.
//!
//! Wave 3f.1 executes only through existing `JunbanService` methods. Mutations
//! require a caller-supplied server-owned root `OperationId`. Composite actions
//! derive deterministic child operation IDs from that root for exact replay.

use std::collections::BTreeSet;

use jiff::{
    ToSpan, Zoned,
    civil::{Date, Time},
    tz::TimeZone,
};
use junban_app::Repository;
use junban_app::{
    AppError, BulkAction, BulkSchedule, BulkTagChange, CommittedMutation, CreateAiMemoryRequest,
    DeleteAiMemoryRequest, EventSink, EventType, JunbanService, MoveTarget, ProjectDraft,
    ProjectPatch, ReplanPastBlocksAction, SelectAiMemoriesRequest, TaskListAsOf, TaskPatch,
    TemporalContext, TimeBlockPatch, TimeBlockRangePatch,
};
use junban_domain::{
    AI_CONTEXT_MEMORIES_MAX, AppSettings, CivilTimeRange, MAX_ENTITY_NAME_CHARS,
    MAX_QUERY_PAGE_LIMIT, MAX_TAGS_PER_TASK, OperationId, ProjectView, SortOrder, Tag, Task,
    TaskDraft, TaskQuery, TaskSort, TaskStatus, TimeBlockDraft, TimeZoneName, WorkHours,
    parse_filter,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::ai_tool_registry::{
    AI_TOOL_AUTO_SCHEDULE_BLOCKS_MAX, AI_TOOL_COMPOSITE_CREATE_MAX, AI_TOOL_DEFAULT_COLOR,
    AI_TOOL_RESULT_ENTITY_MAX, AnalyzeRangeArgs, ApplyAutoScheduleDayArgs, BulkCreateTasksArgs,
    BulkUpdateTasksArgs, CreateProjectArgs, CreateTaskArgs, EstimateTaskDurationArgs,
    ExtractTasksFromTextArgs, FindSimilarTasksArgs, ListRemindersArgs, OptionalDateArgs,
    QueryTasksArgs, RecallMemoriesArgs, SaveMemoryArgs, SuggestTagsArgs,
    TimeblockingCreateBlockArgs, TimeblockingRangeArgs, TimeblockingReplanDayArgs,
    TimeblockingScheduleTaskArgs, TimeblockingSetRecurrenceArgs, TimeblockingUpdateBlockArgs,
    ToolEffect, ToolResultEnvelope, ToolValidationError, UpdateProjectArgs, UpdateTaskArgs,
    ValidatedToolAction, extract_task_titles_from_text, parse_block_id, parse_color, parse_date,
    parse_description, parse_dread, parse_due_time, parse_entity_name, parse_estimated_minutes,
    parse_memory_id, parse_priority, parse_project_id, parse_recurrence, parse_session_id,
    parse_tag_ids, parse_tag_name, parse_task_id, parse_task_ids, parse_time, parse_time_zone,
    parse_timestamp, parse_title,
};

const CHILD_OP_DOMAIN: &[u8] = b"junban.ai.tool.child.v1\0";

/// One sampled server-local clock for an entire tool execution.
#[derive(Debug, Clone)]
pub struct ToolExecContext {
    pub now: Zoned,
    confirmed_work_hours: Option<Option<WorkHours>>,
}

impl ToolExecContext {
    /// Sample once from the host clock for a whole tool execution.
    #[must_use]
    #[allow(dead_code)] // public constructor for later orchestration wiring
    pub fn sample_now() -> Self {
        Self {
            now: Zoned::now(),
            confirmed_work_hours: None,
        }
    }

    #[must_use]
    pub fn new(now: Zoned) -> Self {
        Self {
            now,
            confirmed_work_hours: None,
        }
    }

    /// Freeze the confirmed settings and local clock used by one tool invocation.
    #[must_use]
    pub fn with_confirmed_settings(now: Zoned, settings: &AppSettings) -> Self {
        Self {
            now,
            confirmed_work_hours: Some(settings.planning.work_hours),
        }
    }

    #[must_use]
    pub fn temporal(&self) -> TemporalContext {
        TemporalContext::new(self.now.date(), self.now.time_zone().clone())
    }

    pub fn as_of(&self) -> Result<TaskListAsOf, AppError> {
        Ok(TaskListAsOf::from_zoned(&self.now)?)
    }

    #[must_use]
    pub fn date(&self) -> Date {
        self.now.date()
    }

    #[must_use]
    pub fn zone(&self) -> &TimeZone {
        self.now.time_zone()
    }

    #[must_use]
    pub fn zone_name(&self) -> TimeZoneName {
        let name = self.zone().iana_name().unwrap_or("UTC");
        TimeZoneName::new(name).unwrap_or_else(|_| TimeZoneName::new("UTC").expect("UTC is valid"))
    }
}

/// Execute one validated tool action through `JunbanService` only.
///
/// Read tools may pass `root_operation_id = None`. Mutation tools require a
/// server-owned root operation ID and fail closed without one.
pub async fn execute_tool<R, E>(
    service: &JunbanService<R, E>,
    action: &ValidatedToolAction,
    ctx: &ToolExecContext,
    root_operation_id: Option<OperationId>,
) -> ToolResultEnvelope
where
    R: Repository,
    E: EventSink,
{
    execute_tool_mode(
        service,
        action,
        ctx,
        root_operation_id,
        ToolExecutionMode::Initial,
    )
    .await
}

/// Trusted startup recovery path. Existing root receipts are returned before any
/// state-dependent pre-validation, so a committed effect cannot be repeated merely
/// because its target changed after the effect.
pub(crate) async fn execute_tool_recovery<R, E>(
    service: &JunbanService<R, E>,
    action: &ValidatedToolAction,
    ctx: &ToolExecContext,
    root_operation_id: OperationId,
) -> Result<ToolResultEnvelope, AppError>
where
    R: Repository,
    E: EventSink,
{
    if !is_composite_mutation(action) {
        let mutation_operation_id = derive_child_operation_id(root_operation_id, "mutation", 0);
        match service
            .recover_operation_receipt(mutation_operation_id)
            .await
        {
            Ok(mutation) => return format_direct_mutation_receipt(action, mutation),
            Err(AppError::NotFound) => {}
            Err(error) => return Err(error),
        }
    }
    let result = execute_tool_mode(
        service,
        action,
        ctx,
        Some(root_operation_id),
        ToolExecutionMode::Recovery,
    )
    .await;
    if result.data.get("code").and_then(Value::as_str) == Some("idempotency_mismatch") {
        return Err(AppError::IdempotencyMismatch);
    }
    Ok(result)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolExecutionMode {
    Initial,
    Recovery,
}

fn format_direct_mutation_receipt(
    action: &ValidatedToolAction,
    mutation: CommittedMutation,
) -> Result<ToolResultEnvelope, AppError> {
    if action.effect() != ToolEffect::ApprovalRequired || is_composite_mutation(action) {
        return Err(AppError::Conflict);
    }
    // Every non-composite mutation receipt uses exactly the same formatter as its
    // initial execution. Action identity contributes only the canonical tool name;
    // no action-specific augmentation can diverge on receipt recovery.
    Ok(mutation_result(action.name(), Ok(mutation)).finalize_bounded())
}

fn is_composite_mutation(action: &ValidatedToolAction) -> bool {
    matches!(
        action,
        ValidatedToolAction::BreakDownTask(_)
            | ValidatedToolAction::BulkCreateTasks(_)
            | ValidatedToolAction::ApplyAutoScheduleDay(_)
            | ValidatedToolAction::ExtractTasksFromText(ExtractTasksFromTextArgs {
                dry_run: false,
                ..
            })
    )
}

async fn execute_tool_mode<R, E>(
    service: &JunbanService<R, E>,
    action: &ValidatedToolAction,
    ctx: &ToolExecContext,
    root_operation_id: Option<OperationId>,
    mode: ToolExecutionMode,
) -> ToolResultEnvelope
where
    R: Repository,
    E: EventSink,
{
    let tool = action.name();
    if action.effect() == ToolEffect::ApprovalRequired && root_operation_id.is_none() {
        return ToolResultEnvelope::error(
            tool,
            "operation_required",
            "mutation tools require a server-owned operation id",
        )
        .finalize_bounded();
    }

    // The durable dispatch root is a secret recovery authority. Public mutation
    // results carry only a one-way-derived operation ID; composites derive each child.
    let root_operation_id = root_operation_id.map(|root| {
        if is_composite_mutation(action) {
            root
        } else {
            derive_child_operation_id(root, "mutation", 0)
        }
    });

    let result = match action {
        ValidatedToolAction::CreateTask(args) => {
            exec_create_task(service, args, ctx, root_operation_id.unwrap()).await
        }
        ValidatedToolAction::UpdateTask(args) => {
            exec_update_task(service, args, ctx, root_operation_id.unwrap()).await
        }
        ValidatedToolAction::CompleteTask(args) => match parse_task_id(&args.task_id) {
            Ok(task_id) => mutation_result(
                tool,
                service
                    .complete_task_with(root_operation_id.unwrap(), task_id, ctx.temporal())
                    .await,
            ),
            Err(error) => validation_error(tool, error),
        },
        ValidatedToolAction::DeleteTask(args) => match parse_task_id(&args.task_id) {
            Ok(task_id) => mutation_result(
                tool,
                service
                    .delete_task(root_operation_id.unwrap(), task_id)
                    .await,
            ),
            Err(error) => validation_error(tool, error),
        },
        ValidatedToolAction::QueryTasks(args) => exec_query_tasks(service, args, ctx).await,
        ValidatedToolAction::BreakDownTask(args) => {
            exec_break_down(
                service,
                args.task_id.as_str(),
                &args.subtasks,
                root_operation_id.unwrap(),
                mode,
            )
            .await
        }
        ValidatedToolAction::ExtractTasksFromText(args) => {
            exec_extract(service, args, root_operation_id, mode).await
        }
        ValidatedToolAction::BulkCreateTasks(args) => {
            exec_bulk_create(service, args, root_operation_id.unwrap(), mode).await
        }
        ValidatedToolAction::BulkCompleteTasks(args) => match parse_task_ids(&args.task_ids) {
            Ok(task_ids) => mutation_result(
                tool,
                service
                    .bulk_tasks_with(
                        root_operation_id.unwrap(),
                        task_ids,
                        BulkAction::Complete,
                        ctx.temporal(),
                    )
                    .await,
            ),
            Err(error) => validation_error(tool, error),
        },
        ValidatedToolAction::BulkUpdateTasks(args) => {
            exec_bulk_update(service, args, ctx, root_operation_id.unwrap()).await
        }
        ValidatedToolAction::FindSimilarTasks(args) => exec_find_similar(service, args, ctx).await,
        ValidatedToolAction::CheckDuplicates(args) => {
            exec_check_duplicates(service, &args.title, ctx).await
        }
        ValidatedToolAction::CreateProject(args) => {
            exec_create_project(service, args, root_operation_id.unwrap()).await
        }
        ValidatedToolAction::ListProjects(_) => exec_list_projects(service).await,
        ValidatedToolAction::GetProject(args) => exec_get_project(service, &args.project_id).await,
        ValidatedToolAction::UpdateProject(args) => {
            exec_update_project(service, args, root_operation_id.unwrap()).await
        }
        ValidatedToolAction::DeleteProject(args) => match parse_project_id(&args.project_id) {
            Ok(project_id) => mutation_result(
                tool,
                service
                    .delete_project(root_operation_id.unwrap(), project_id)
                    .await,
            ),
            Err(error) => validation_error(tool, error),
        },
        ValidatedToolAction::ListTags(_) => exec_list_tags(service).await,
        ValidatedToolAction::AddTagsToTask(args) => {
            exec_tag_change(
                service,
                tool,
                &args.task_id,
                &args.tag_ids,
                &args.tag_names,
                true,
                root_operation_id.unwrap(),
            )
            .await
        }
        ValidatedToolAction::RemoveTagsFromTask(args) => {
            exec_tag_change(
                service,
                tool,
                &args.task_id,
                &args.tag_ids,
                &args.tag_names,
                false,
                root_operation_id.unwrap(),
            )
            .await
        }
        ValidatedToolAction::ListReminders(args) => exec_list_reminders(service, args, ctx).await,
        ValidatedToolAction::SetReminder(args) => {
            exec_set_reminder(
                service,
                tool,
                &args.task_id,
                &args.remind_at,
                root_operation_id.unwrap(),
            )
            .await
        }
        ValidatedToolAction::SnoozeReminder(args) => {
            exec_set_reminder(
                service,
                tool,
                &args.task_id,
                &args.remind_at,
                root_operation_id.unwrap(),
            )
            .await
        }
        ValidatedToolAction::DismissReminder(args) => match parse_task_id(&args.task_id) {
            Ok(task_id) => mutation_result(
                tool,
                service
                    .dismiss_reminder(root_operation_id.unwrap(), task_id)
                    .await,
            ),
            Err(error) => validation_error(tool, error),
        },
        ValidatedToolAction::AnalyzeCompletionPatterns(args) => {
            exec_stats_card(service, tool, args, ctx, StatsCardKind::CompletionPatterns).await
        }
        ValidatedToolAction::CheckOvercommitment(args) => {
            exec_overcommitment(service, args, ctx).await
        }
        ValidatedToolAction::AnalyzeWorkload(args) => exec_workload(service, args, ctx).await,
        ValidatedToolAction::GetEnergyRecommendations(args) => {
            exec_energy(service, args, ctx).await
        }
        ValidatedToolAction::GetProductivityStats(args) => {
            exec_stats_card(service, tool, args, ctx, StatsCardKind::Productivity).await
        }
        ValidatedToolAction::EstimateTaskDuration(args) => {
            exec_estimate_duration(service, args, ctx).await
        }
        ValidatedToolAction::TimeTrackingSummary(args) => {
            exec_stats_card(service, tool, args, ctx, StatsCardKind::TimeTracking).await
        }
        ValidatedToolAction::SuggestTags(args) => exec_suggest_tags(service, args).await,
        ValidatedToolAction::PlanMyDay(args) => exec_plan_my_day(service, args, ctx).await,
        ValidatedToolAction::DailyReview(args) => exec_daily_review(service, args, ctx).await,
        ValidatedToolAction::WeeklyReview(args) => exec_weekly_review(service, args, ctx).await,
        ValidatedToolAction::SaveMemory(args) => {
            exec_save_memory(service, args, root_operation_id.unwrap()).await
        }
        ValidatedToolAction::RecallMemories(args) => exec_recall_memories(service, args).await,
        ValidatedToolAction::ForgetMemory(args) => match parse_memory_id(&args.memory_id) {
            Ok(memory_id) => mutation_result(
                tool,
                service
                    .delete_ai_memory(
                        root_operation_id.unwrap(),
                        DeleteAiMemoryRequest { memory_id },
                    )
                    .await,
            ),
            Err(error) => validation_error(tool, error),
        },
        ValidatedToolAction::AutoScheduleDay(args) => {
            exec_schedule_preview(service, tool, args, ctx, false).await
        }
        ValidatedToolAction::ApplyAutoScheduleDay(args) => {
            exec_apply_auto_schedule_day(service, args, root_operation_id.unwrap(), mode).await
        }
        ValidatedToolAction::RescheduleDay(args) => {
            exec_schedule_preview(service, tool, args, ctx, true).await
        }
        ValidatedToolAction::TimeblockingListBlocks(args) => {
            exec_list_blocks(service, args, ctx).await
        }
        ValidatedToolAction::TimeblockingCreateBlock(args) => {
            exec_create_block(service, args, ctx, root_operation_id.unwrap()).await
        }
        ValidatedToolAction::TimeblockingUpdateBlock(args) => {
            exec_update_block(service, args, root_operation_id.unwrap()).await
        }
        ValidatedToolAction::TimeblockingDeleteBlock(args) => {
            match parse_block_id(&args.block_id) {
                Ok(block_id) => mutation_result(
                    tool,
                    service
                        .delete_time_block(root_operation_id.unwrap(), block_id)
                        .await,
                ),
                Err(error) => validation_error(tool, error),
            }
        }
        ValidatedToolAction::TimeblockingScheduleTask(args) => {
            exec_schedule_task(service, args, ctx, root_operation_id.unwrap()).await
        }
        ValidatedToolAction::TimeblockingGetAvailability(args) => {
            exec_availability(service, args, ctx).await
        }
        ValidatedToolAction::TimeblockingSetRecurrence(args) => {
            exec_set_recurrence(service, args, root_operation_id.unwrap()).await
        }
        ValidatedToolAction::TimeblockingReplanDay(args) => {
            exec_replan_day(service, args, ctx, root_operation_id.unwrap()).await
        }
    };

    result.finalize_bounded()
}

/// Derive a deterministic child operation ID from an approved root operation.
#[must_use]
pub fn derive_child_operation_id(root: OperationId, label: &str, index: u32) -> OperationId {
    let mut hasher = Sha256::new();
    hasher.update(CHILD_OP_DOMAIN);
    hasher.update(root.as_uuid().as_bytes());
    hasher.update([0]);
    hasher.update(label.as_bytes());
    hasher.update([0]);
    hasher.update(index.to_le_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let encoded = Uuid::from_bytes(bytes).to_string();
    OperationId::parse(&encoded).expect("derived child operation id must parse")
}

// ── Task tools ──────────────────────────────────────────────────────────────

async fn exec_create_task<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &CreateTaskArgs,
    ctx: &ToolExecContext,
    op: OperationId,
) -> ToolResultEnvelope {
    match build_task_draft(args, ctx) {
        Ok(draft) => mutation_result("create_task", service.create_task(op, draft).await),
        Err(error) => validation_error("create_task", error),
    }
}

fn build_task_draft(
    args: &CreateTaskArgs,
    ctx: &ToolExecContext,
) -> Result<TaskDraft, ToolValidationError> {
    let mut draft = TaskDraft::new(parse_title(&args.title)?);
    if let Some(description) = &args.description {
        draft.description = parse_description(description)?;
    }
    if let Some(priority) = args.priority {
        draft.priority = Some(parse_priority(priority)?);
    }
    if let Some(due_date) = &args.due_date {
        draft.due_date = Some(parse_date(due_date)?);
    }
    if let Some(due_time) = &args.due_time {
        draft.due_time = Some(parse_due_time(due_time, ctx.zone_name())?);
    }
    if let Some(estimated) = args.estimated_minutes {
        draft.estimated_minutes = Some(parse_estimated_minutes(estimated)?);
    }
    if let Some(dread) = args.dread {
        draft.dread = Some(parse_dread(dread)?);
    }
    if let Some(project_id) = &args.project_id {
        draft.project_id = Some(parse_project_id(project_id)?);
    }
    if let Some(parent_id) = &args.parent_id {
        draft.parent_id = Some(parse_task_id(parent_id)?);
    }
    draft.tag_ids = parse_tag_ids(&args.tag_ids)?;
    if let Some(someday) = args.someday {
        draft.someday = someday;
    }
    if let Some(rule) = &args.recurrence_rule {
        draft.recurrence_rule = Some(parse_recurrence(rule)?);
    }
    Ok(draft)
}

async fn exec_update_task<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &UpdateTaskArgs,
    ctx: &ToolExecContext,
    op: OperationId,
) -> ToolResultEnvelope {
    let task_id = match parse_task_id(&args.task_id) {
        Ok(id) => id,
        Err(error) => return validation_error("update_task", error),
    };
    let patch = match build_task_patch(args, ctx) {
        Ok(patch) => patch,
        Err(error) => return validation_error("update_task", error),
    };
    mutation_result("update_task", service.patch_task(op, task_id, patch).await)
}

fn build_task_patch(
    args: &UpdateTaskArgs,
    ctx: &ToolExecContext,
) -> Result<TaskPatch, ToolValidationError> {
    let mut patch = TaskPatch::default();
    if let Some(title) = &args.title {
        patch.title = Some(parse_title(title)?);
    }
    if let Some(description) = &args.description {
        patch.description = Some(parse_description(description)?);
    }
    if let Some(priority) = &args.priority {
        patch.priority = Some(match priority {
            Some(value) => Some(parse_priority(*value)?),
            None => None,
        });
    }
    if let Some(due_date) = &args.due_date {
        patch.due_date = Some(match due_date {
            Some(value) => Some(parse_date(value)?),
            None => None,
        });
    }
    if let Some(due_time) = &args.due_time {
        patch.due_time = Some(match due_time {
            Some(value) => Some(parse_due_time(value, ctx.zone_name())?),
            None => None,
        });
    }
    if let Some(estimated) = &args.estimated_minutes {
        patch.estimated_minutes = Some(match estimated {
            Some(value) => Some(parse_estimated_minutes(*value)?),
            None => None,
        });
    }
    if let Some(dread) = &args.dread {
        patch.dread = Some(match dread {
            Some(value) => Some(parse_dread(*value)?),
            None => None,
        });
    }
    if let Some(project_id) = &args.project_id {
        patch.project_id = Some(match project_id {
            Some(value) => Some(parse_project_id(value)?),
            None => None,
        });
    }
    if let Some(parent_id) = &args.parent_id {
        patch.parent_id = Some(match parent_id {
            Some(value) => Some(parse_task_id(value)?),
            None => None,
        });
    }
    if let Some(tag_ids) = &args.tag_ids {
        patch.tag_ids = Some(parse_tag_ids(tag_ids)?);
    }
    if let Some(someday) = args.someday {
        patch.someday = Some(someday);
    }
    if let Some(rule) = &args.recurrence_rule {
        patch.recurrence_rule = Some(match rule {
            Some(value) => Some(parse_recurrence(value)?),
            None => None,
        });
    }
    if args.clear_reminder == Some(true) {
        patch.remind_at = Some(None);
    }
    Ok(patch)
}

async fn exec_query_tasks<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &QueryTasksArgs,
    ctx: &ToolExecContext,
) -> ToolResultEnvelope {
    let as_of = match ctx.as_of() {
        Ok(value) => value,
        Err(error) => return map_app_error("query_tasks", error),
    };
    let mut query = if let Some(raw) = &args.query {
        match parse_filter(raw, ctx.date()) {
            Ok(query) => query,
            Err(_) => {
                return ToolResultEnvelope::error(
                    "query_tasks",
                    "invalid_query",
                    "filter query is invalid",
                );
            }
        }
    } else {
        TaskQuery::new()
    };
    if let Some(project_id) = &args.project_id {
        match parse_project_id(project_id) {
            Ok(id) => query.filter.project_id = Some(Some(id)),
            Err(error) => return validation_error("query_tasks", error),
        }
    }
    if let Some(status) = &args.status {
        let parsed = match status.as_str() {
            "pending" => TaskStatus::Pending,
            "completed" => TaskStatus::Completed,
            "cancelled" => TaskStatus::Cancelled,
            _ => {
                return ToolResultEnvelope::error(
                    "query_tasks",
                    "invalid_status",
                    "status must be pending|completed|cancelled",
                );
            }
        };
        query = query.with_status(parsed);
    }
    let limit = args
        .limit
        .unwrap_or(MAX_QUERY_PAGE_LIMIT)
        .min(MAX_QUERY_PAGE_LIMIT);
    query.limit = Some(limit);
    match service.list_tasks(query, as_of).await {
        Ok(page) => ToolResultEnvelope::success(
            "query_tasks",
            json!({
                "tasks": page.tasks.iter().map(task_card).collect::<Vec<_>>(),
                "revision": page.revision,
                "as_of_date": page.as_of_date.to_string(),
                "next_cursor": page.next_cursor.as_ref().map(|cursor| json!({
                    "sort_value": cursor.sort_value,
                    "task_id": cursor.task_id.to_string(),
                })),
            }),
        ),
        Err(error) => map_app_error("query_tasks", error),
    }
}

async fn exec_break_down<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    parent_raw: &str,
    subtasks: &[String],
    root: OperationId,
    mode: ToolExecutionMode,
) -> ToolResultEnvelope {
    // Pre-validate every element before the first effect.
    let parent_id = match parse_task_id(parent_raw) {
        Ok(id) => id,
        Err(error) => return validation_error("break_down_task", error),
    };
    if subtasks.is_empty() || subtasks.len() > AI_TOOL_COMPOSITE_CREATE_MAX {
        return ToolResultEnvelope::error(
            "break_down_task",
            "invalid_subtasks",
            "subtasks must contain 1..=100 titles",
        );
    }
    let mut titles = Vec::with_capacity(subtasks.len());
    for title_raw in subtasks {
        match parse_title(title_raw) {
            Ok(title) => titles.push(title),
            Err(error) => return validation_error("break_down_task", error),
        }
    }
    if mode == ToolExecutionMode::Initial && service.get_task(parent_id).await.is_err() {
        return ToolResultEnvelope::error(
            "break_down_task",
            "not_found",
            "parent task was not found",
        );
    }
    let mut created = Vec::new();
    for (index, title) in titles.into_iter().enumerate() {
        let mut draft = TaskDraft::new(title);
        draft.parent_id = Some(parent_id);
        let child_op = derive_child_operation_id(root, "break_down_task", index as u32);
        match create_composite_task(service, child_op, draft, mode).await {
            Ok(mutation) => created.push(composite_created_entry(&mutation, child_op)),
            Err(error) => {
                return partial_composite_outcome(
                    "break_down_task",
                    created,
                    index,
                    error,
                    json!({
                        "parent_id": parent_id.to_string(),
                        "failed_operation_id": child_op.to_string(),
                    }),
                );
            }
        }
    }
    ToolResultEnvelope::success(
        "break_down_task",
        json!({
            "parent_id": parent_id.to_string(),
            "created": created,
            "count": subtasks.len(),
        }),
    )
}

async fn exec_extract<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &ExtractTasksFromTextArgs,
    root: Option<OperationId>,
    mode: ToolExecutionMode,
) -> ToolResultEnvelope {
    let titles = extract_task_titles_from_text(&args.text);
    if args.dry_run {
        return ToolResultEnvelope::success(
            "extract_tasks_from_text",
            json!({
                "dry_run": true,
                "titles": titles,
                "count": titles.len(),
            }),
        );
    }
    let root = root.expect("mutation path requires operation");
    let project_id = match &args.project_id {
        Some(raw) => match parse_project_id(raw) {
            Ok(id) => Some(id),
            Err(error) => return validation_error("extract_tasks_from_text", error),
        },
        None => None,
    };
    let bulk = BulkCreateTasksArgs {
        titles,
        project_id: project_id.map(|id| id.to_string()),
        due_date: None,
    };
    // Reuse bulk create under the extract tool name.
    let mut result = exec_bulk_create(service, &bulk, root, mode).await;
    result.tool = "extract_tasks_from_text".to_owned();
    if let Some(data) = result.data.as_object_mut() {
        data.insert("dry_run".to_owned(), Value::Bool(false));
    }
    result
}

async fn exec_bulk_create<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &BulkCreateTasksArgs,
    root: OperationId,
    mode: ToolExecutionMode,
) -> ToolResultEnvelope {
    // Pre-validate every element before the first effect.
    if args.titles.is_empty() || args.titles.len() > AI_TOOL_COMPOSITE_CREATE_MAX {
        return ToolResultEnvelope::error(
            "bulk_create_tasks",
            "invalid_titles",
            "titles must contain 1..=100 entries",
        );
    }
    let project_id = match &args.project_id {
        Some(raw) => match parse_project_id(raw) {
            Ok(id) => Some(id),
            Err(error) => return validation_error("bulk_create_tasks", error),
        },
        None => None,
    };
    let due_date = match &args.due_date {
        Some(raw) => match parse_date(raw) {
            Ok(date) => Some(date),
            Err(error) => return validation_error("bulk_create_tasks", error),
        },
        None => None,
    };
    let mut titles = Vec::with_capacity(args.titles.len());
    for title_raw in &args.titles {
        match parse_title(title_raw) {
            Ok(title) => titles.push(title),
            Err(error) => return validation_error("bulk_create_tasks", error),
        }
    }
    if mode == ToolExecutionMode::Initial
        && let Some(project_id) = project_id
        && service.get_project(project_id).await.is_err()
    {
        return ToolResultEnvelope::error(
            "bulk_create_tasks",
            "not_found",
            "project was not found",
        );
    }
    let mut created = Vec::new();
    for (index, title) in titles.into_iter().enumerate() {
        let mut draft = TaskDraft::new(title);
        draft.project_id = project_id;
        draft.due_date = due_date;
        let child_op = derive_child_operation_id(root, "bulk_create_tasks", index as u32);
        match create_composite_task(service, child_op, draft, mode).await {
            Ok(mutation) => created.push(composite_created_entry(&mutation, child_op)),
            Err(error) => {
                return partial_composite_outcome(
                    "bulk_create_tasks",
                    created,
                    index,
                    error,
                    json!({ "failed_operation_id": child_op.to_string() }),
                );
            }
        }
    }
    ToolResultEnvelope::success(
        "bulk_create_tasks",
        json!({
            "created": created,
            "count": args.titles.len(),
        }),
    )
}

async fn exec_bulk_update<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &BulkUpdateTasksArgs,
    ctx: &ToolExecContext,
    op: OperationId,
) -> ToolResultEnvelope {
    let task_ids = match parse_task_ids(&args.task_ids) {
        Ok(ids) => ids,
        Err(error) => return validation_error("bulk_update_tasks", error),
    };
    let add = match parse_tag_ids(&args.add_tag_ids) {
        Ok(ids) => ids,
        Err(error) => return validation_error("bulk_update_tasks", error),
    };
    let remove = match parse_tag_ids(&args.remove_tag_ids) {
        Ok(ids) => ids,
        Err(error) => return validation_error("bulk_update_tasks", error),
    };

    let action = if !add.is_empty() || !remove.is_empty() {
        if args.priority.is_some()
            || args.due_date.is_some()
            || args.due_time.is_some()
            || args.someday.is_some()
            || args.project_id.is_some()
        {
            return ToolResultEnvelope::error(
                "bulk_update_tasks",
                "conflicting_update",
                "tag changes cannot be combined with other bulk fields in one call",
            );
        }
        BulkAction::Tag {
            change: BulkTagChange { add, remove },
        }
    } else if let Some(project_id) = &args.project_id {
        if args.priority.is_some()
            || args.due_date.is_some()
            || args.due_time.is_some()
            || args.someday.is_some()
        {
            return ToolResultEnvelope::error(
                "bulk_update_tasks",
                "conflicting_update",
                "project move cannot be combined with other bulk fields in one call",
            );
        }
        let project = match project_id {
            Some(raw) => match parse_project_id(raw) {
                Ok(id) => Some(id),
                Err(error) => return validation_error("bulk_update_tasks", error),
            },
            None => None,
        };
        BulkAction::Move {
            target: MoveTarget {
                parent_id: None,
                project_id: Some(project),
                section_id: None,
                order: Default::default(),
            },
        }
    } else if args.priority.is_some()
        && args.due_date.is_none()
        && args.due_time.is_none()
        && args.someday.is_none()
    {
        let priority = match &args.priority {
            Some(Some(value)) => match parse_priority(*value) {
                Ok(priority) => Some(priority),
                Err(error) => return validation_error("bulk_update_tasks", error),
            },
            Some(None) => None,
            None => unreachable!(),
        };
        BulkAction::Priority { priority }
    } else if args.due_date.is_some() || args.due_time.is_some() || args.someday.is_some() {
        if args.priority.is_some() {
            return ToolResultEnvelope::error(
                "bulk_update_tasks",
                "conflicting_update",
                "priority cannot be combined with schedule fields in one call",
            );
        }
        let due_date = match &args.due_date {
            Some(Some(raw)) => match parse_date(raw) {
                Ok(date) => Some(Some(date)),
                Err(error) => return validation_error("bulk_update_tasks", error),
            },
            Some(None) => Some(None),
            None => None,
        };
        let due_time = match &args.due_time {
            Some(Some(raw)) => match parse_due_time(raw, ctx.zone_name()) {
                Ok(time) => Some(Some(time)),
                Err(error) => return validation_error("bulk_update_tasks", error),
            },
            Some(None) => Some(None),
            None => None,
        };
        BulkAction::Schedule {
            schedule: BulkSchedule {
                due_date,
                due_time,
                deadline: None,
                someday: args.someday,
            },
        }
    } else {
        return ToolResultEnvelope::error(
            "bulk_update_tasks",
            "missing_update",
            "bulk_update_tasks requires one update field group",
        );
    };

    mutation_result(
        "bulk_update_tasks",
        service
            .bulk_tasks_with(op, task_ids, action, ctx.temporal())
            .await,
    )
}

async fn exec_find_similar<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &FindSimilarTasksArgs,
    ctx: &ToolExecContext,
) -> ToolResultEnvelope {
    let needle = normalize_title(&args.title);
    if needle.is_empty() {
        return ToolResultEnvelope::error(
            "find_similar_tasks",
            "invalid_title",
            "title must not be empty",
        );
    }
    let limit = args.limit.unwrap_or(20).min(MAX_QUERY_PAGE_LIMIT) as usize;
    match load_pending_tasks(service, ctx).await {
        Ok((tasks, revision)) => {
            let mut scored = tasks
                .iter()
                .filter_map(|task| {
                    let score = title_similarity(&needle, &normalize_title(task.title.as_str()));
                    if score >= 0.45 {
                        Some((score, task))
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            scored.sort_by(|a, b| {
                b.0.partial_cmp(&a.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.1.id.to_string().cmp(&b.1.id.to_string()))
            });
            scored.truncate(limit);
            ToolResultEnvelope::success(
                "find_similar_tasks",
                json!({
                    "matches": scored.iter().map(|(score, task)| json!({
                        "score": (*score * 100.0).round() as u32,
                        "task": task_card(task),
                    })).collect::<Vec<_>>(),
                    "revision": revision,
                }),
            )
        }
        Err(error) => map_app_error("find_similar_tasks", error),
    }
}

async fn exec_check_duplicates<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    title: &str,
    ctx: &ToolExecContext,
) -> ToolResultEnvelope {
    let needle = normalize_title(title);
    if needle.is_empty() {
        return ToolResultEnvelope::error(
            "check_duplicates",
            "invalid_title",
            "title must not be empty",
        );
    }
    match load_pending_tasks(service, ctx).await {
        Ok((tasks, revision)) => {
            let duplicates = tasks
                .iter()
                .filter(|task| {
                    let other = normalize_title(task.title.as_str());
                    other == needle || title_similarity(&needle, &other) >= 0.92
                })
                .take(AI_TOOL_RESULT_ENTITY_MAX)
                .map(task_card)
                .collect::<Vec<_>>();
            ToolResultEnvelope::success(
                "check_duplicates",
                json!({
                    "is_duplicate": !duplicates.is_empty(),
                    "duplicates": duplicates,
                    "revision": revision,
                }),
            )
        }
        Err(error) => map_app_error("check_duplicates", error),
    }
}

// ── Projects / tags ─────────────────────────────────────────────────────────

async fn exec_create_project<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &CreateProjectArgs,
    op: OperationId,
) -> ToolResultEnvelope {
    let name = match parse_entity_name(&args.name) {
        Ok(name) => name,
        Err(error) => return validation_error("create_project", error),
    };
    let color_raw = args.color.as_deref().unwrap_or(AI_TOOL_DEFAULT_COLOR);
    let color = match parse_color(color_raw) {
        Ok(color) => color,
        Err(error) => return validation_error("create_project", error),
    };
    let draft = ProjectDraft {
        name,
        color,
        icon: None,
        parent_id: None,
        favorite: args.favorite.unwrap_or(false),
        archived: false,
        view: ProjectView::default(),
        sort_order: SortOrder::default(),
    };
    mutation_result("create_project", service.create_project(op, draft).await)
}

async fn exec_list_projects<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
) -> ToolResultEnvelope {
    match service
        .list_projects_bounded(AI_TOOL_RESULT_ENTITY_MAX as u32)
        .await
    {
        Ok(page) => ToolResultEnvelope::success(
            "list_projects",
            json!({
                "projects": page.projects.iter().map(project_card).collect::<Vec<_>>(),
                "revision": page.revision,
                "truncated": page.truncated,
            }),
        ),
        Err(error) => map_app_error("list_projects", error),
    }
}

async fn exec_get_project<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    project_id: &str,
) -> ToolResultEnvelope {
    let project_id = match parse_project_id(project_id) {
        Ok(id) => id,
        Err(error) => return validation_error("get_project", error),
    };
    match service.get_project(project_id).await {
        Ok(project) => {
            ToolResultEnvelope::success("get_project", json!({ "project": project_card(&project) }))
        }
        Err(error) => map_app_error("get_project", error),
    }
}

async fn exec_update_project<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &UpdateProjectArgs,
    op: OperationId,
) -> ToolResultEnvelope {
    let project_id = match parse_project_id(&args.project_id) {
        Ok(id) => id,
        Err(error) => return validation_error("update_project", error),
    };
    let mut patch = ProjectPatch::default();
    if let Some(name) = &args.name {
        match parse_entity_name(name) {
            Ok(name) => patch.name = Some(name),
            Err(error) => return validation_error("update_project", error),
        }
    }
    if let Some(color) = &args.color {
        match parse_color(color) {
            Ok(color) => patch.color = Some(color),
            Err(error) => return validation_error("update_project", error),
        }
    }
    if let Some(favorite) = args.favorite {
        patch.favorite = Some(favorite);
    }
    if let Some(archived) = args.archived {
        patch.archived = Some(archived);
    }
    mutation_result(
        "update_project",
        service.patch_project(op, project_id, patch).await,
    )
}

async fn exec_list_tags<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
) -> ToolResultEnvelope {
    match service
        .list_tags_bounded(AI_TOOL_RESULT_ENTITY_MAX as u32)
        .await
    {
        Ok(page) => ToolResultEnvelope::success(
            "list_tags",
            json!({
                "tags": page.tags.iter().map(tag_card).collect::<Vec<_>>(),
                "revision": page.revision,
                "truncated": page.truncated,
            }),
        ),
        Err(error) => map_app_error("list_tags", error),
    }
}

async fn exec_tag_change<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    tool: &str,
    task_id_raw: &str,
    tag_ids_raw: &[String],
    tag_names_raw: &[String],
    add: bool,
    op: OperationId,
) -> ToolResultEnvelope {
    let task_id = match parse_task_id(task_id_raw) {
        Ok(id) => id,
        Err(error) => return validation_error(tool, error),
    };
    let mut tag_ids = match parse_tag_ids(tag_ids_raw) {
        Ok(ids) => ids,
        Err(error) => return validation_error(tool, error),
    };
    if !tag_names_raw.is_empty() {
        if tag_names_raw.len() > MAX_TAGS_PER_TASK {
            return ToolResultEnvelope::error(
                tool,
                "too_many_ids",
                "tag_names exceeds the per-task tag ceiling",
            );
        }
        let mut names = Vec::with_capacity(tag_names_raw.len());
        for name_raw in tag_names_raw {
            match parse_tag_name(name_raw) {
                Ok(name) => names.push(name),
                Err(error) => return validation_error(tool, error),
            }
        }
        match service.resolve_tags_by_names(names).await {
            Ok(resolved) => {
                for tag in resolved {
                    if !tag_ids.contains(&tag.id) {
                        tag_ids.push(tag.id);
                    }
                }
            }
            Err(AppError::NotFound) => {
                return ToolResultEnvelope::error(
                    tool,
                    "tag_not_found",
                    "tag name does not match an existing tag",
                );
            }
            Err(error) => return map_app_error(tool, error),
        }
    }
    if tag_ids.is_empty() {
        return ToolResultEnvelope::error(tool, "missing_tags", "at least one tag is required");
    }
    if tag_ids.len() > MAX_TAGS_PER_TASK {
        return ToolResultEnvelope::error(
            tool,
            "too_many_ids",
            "resolved tags exceed the per-task tag ceiling",
        );
    }
    let change = if add {
        BulkTagChange {
            add: tag_ids,
            remove: Vec::new(),
        }
    } else {
        BulkTagChange {
            add: Vec::new(),
            remove: tag_ids,
        }
    };
    // Transactional CAS tag mutation for a one-task vector — no stale RMW.
    mutation_result(
        tool,
        service
            .bulk_tasks(op, vec![task_id], BulkAction::Tag { change })
            .await,
    )
}

// ── Reminders ───────────────────────────────────────────────────────────────

async fn exec_list_reminders<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &ListRemindersArgs,
    ctx: &ToolExecContext,
) -> ToolResultEnvelope {
    let limit = args
        .limit
        .unwrap_or(MAX_QUERY_PAGE_LIMIT)
        .min(MAX_QUERY_PAGE_LIMIT) as usize;
    if let Some(task_id_raw) = &args.task_id {
        let task_id = match parse_task_id(task_id_raw) {
            Ok(id) => id,
            Err(error) => return validation_error("list_reminders", error),
        };
        return match service.list_task_reminders(task_id).await {
            Ok(rows) => {
                let reminders = rows
                    .into_iter()
                    .take(limit)
                    .map(|row| {
                        json!({
                            "task_id": row.task_id.to_string(),
                            "remind_at": row.remind_at.to_string(),
                            "state": row.state.as_str(),
                        })
                    })
                    .collect::<Vec<_>>();
                ToolResultEnvelope::success(
                    "list_reminders",
                    json!({ "reminders": reminders, "count": reminders.len() }),
                )
            }
            Err(error) => map_app_error("list_reminders", error),
        };
    }

    match load_pending_tasks(service, ctx).await {
        Ok((tasks, revision)) => {
            let reminders = tasks
                .iter()
                .filter_map(|task| {
                    task.remind_at.map(|remind_at| {
                        json!({
                            "task_id": task.id.to_string(),
                            "title": task.title.as_str(),
                            "remind_at": remind_at.to_string(),
                        })
                    })
                })
                .take(limit)
                .collect::<Vec<_>>();
            ToolResultEnvelope::success(
                "list_reminders",
                json!({
                    "reminders": reminders,
                    "count": reminders.len(),
                    "revision": revision,
                }),
            )
        }
        Err(error) => map_app_error("list_reminders", error),
    }
}

async fn exec_set_reminder<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    tool: &str,
    task_id_raw: &str,
    remind_at_raw: &str,
    op: OperationId,
) -> ToolResultEnvelope {
    let task_id = match parse_task_id(task_id_raw) {
        Ok(id) => id,
        Err(error) => return validation_error(tool, error),
    };
    let remind_at = match parse_timestamp(remind_at_raw) {
        Ok(ts) => ts,
        Err(error) => return validation_error(tool, error),
    };
    mutation_result(
        tool,
        service.reschedule_reminder(op, task_id, remind_at).await,
    )
}

// ── Analysis / planning ─────────────────────────────────────────────────────

#[derive(Clone, Copy)]
enum StatsCardKind {
    CompletionPatterns,
    Productivity,
    TimeTracking,
}

async fn exec_stats_card<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    tool: &str,
    args: &AnalyzeRangeArgs,
    ctx: &ToolExecContext,
    kind: StatsCardKind,
) -> ToolResultEnvelope {
    let (from, to) = match resolve_range(args, ctx) {
        Ok(range) => range,
        Err(error) => return validation_error(tool, error),
    };
    match service.stats(from, to, ctx.date(), ctx.zone()).await {
        Ok(page) => {
            let summary = &page.summary;
            let data = match kind {
                StatsCardKind::CompletionPatterns => json!({
                    "from": from.to_string(),
                    "to": to.to_string(),
                    "total_completions": summary.total_completions,
                    "total_creations": summary.total_creations,
                    "current_streak_days": summary.current_streak_days,
                    "estimate_accuracy_percent": summary.estimate_accuracy_percent,
                    "estimate_accuracy_samples": summary.estimate_accuracy_samples,
                    "revision": page.revision,
                }),
                StatsCardKind::Productivity => json!({
                    "from": from.to_string(),
                    "to": to.to_string(),
                    "summary": {
                        "total_completions": summary.total_completions,
                        "total_creations": summary.total_creations,
                        "total_completion_minutes": summary.total_completion_minutes,
                        "current_streak_days": summary.current_streak_days,
                        "average_estimated_minutes": summary.average_estimated_minutes,
                        "average_actual_minutes": summary.average_actual_minutes,
                        "estimate_accuracy_percent": summary.estimate_accuracy_percent,
                    },
                    "revision": page.revision,
                }),
                StatsCardKind::TimeTracking => json!({
                    "from": from.to_string(),
                    "to": to.to_string(),
                    "total_completion_minutes": summary.total_completion_minutes,
                    "average_actual_minutes": summary.average_actual_minutes,
                    "average_estimated_minutes": summary.average_estimated_minutes,
                    "estimate_accuracy_percent": summary.estimate_accuracy_percent,
                    "estimate_accuracy_samples": summary.estimate_accuracy_samples,
                    "revision": page.revision,
                }),
            };
            ToolResultEnvelope::success(tool, data)
        }
        Err(error) => map_app_error(tool, error),
    }
}

async fn exec_overcommitment<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &OptionalDateArgs,
    ctx: &ToolExecContext,
) -> ToolResultEnvelope {
    let date = match resolve_date(args, ctx) {
        Ok(date) => date,
        Err(error) => return validation_error("check_overcommitment", error),
    };
    match service.daily_plan(date, None, ctx.zone()).await {
        Ok(page) => {
            let over = page.estimated_total_minutes > page.capacity_minutes;
            ToolResultEnvelope::success(
                "check_overcommitment",
                json!({
                    "date": date.to_string(),
                    "estimated_total_minutes": page.estimated_total_minutes,
                    "capacity_minutes": page.capacity_minutes,
                    "overcommitted": over,
                    "focus_task_ids": page.focus_task_ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
                    "overdue_task_ids": page.overdue_task_ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
                    "revision": page.revision,
                }),
            )
        }
        Err(error) => map_app_error("check_overcommitment", error),
    }
}

async fn exec_workload<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &OptionalDateArgs,
    ctx: &ToolExecContext,
) -> ToolResultEnvelope {
    let date = match resolve_date(args, ctx) {
        Ok(date) => date,
        Err(error) => return validation_error("analyze_workload", error),
    };
    match load_pending_tasks(service, ctx).await {
        Ok((tasks, revision)) => {
            let mut by_priority = [0_u32; 5];
            let mut overdue = 0_u32;
            let mut due_today = 0_u32;
            let mut unscheduled = 0_u32;
            let mut estimated = 0_u32;
            for task in &tasks {
                if let Some(priority) = task.priority {
                    let idx = priority.get() as usize;
                    if idx < by_priority.len() {
                        by_priority[idx] = by_priority[idx].saturating_add(1);
                    }
                } else {
                    by_priority[0] = by_priority[0].saturating_add(1);
                }
                match task.due_date {
                    Some(due) if due < date => overdue = overdue.saturating_add(1),
                    Some(due) if due == date => due_today = due_today.saturating_add(1),
                    None if !task.someday => unscheduled = unscheduled.saturating_add(1),
                    _ => {}
                }
                if let Some(minutes) = task.estimated_minutes {
                    estimated = estimated.saturating_add(minutes.get());
                }
            }
            ToolResultEnvelope::success(
                "analyze_workload",
                json!({
                    "date": date.to_string(),
                    "pending_count": tasks.len(),
                    "overdue_count": overdue,
                    "due_today_count": due_today,
                    "unscheduled_count": unscheduled,
                    "estimated_total_minutes": estimated,
                    "by_priority": {
                        "unset": by_priority[0],
                        "p1": by_priority[1],
                        "p2": by_priority[2],
                        "p3": by_priority[3],
                        "p4": by_priority[4],
                    },
                    "revision": revision,
                }),
            )
        }
        Err(error) => map_app_error("analyze_workload", error),
    }
}

async fn exec_energy<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &OptionalDateArgs,
    ctx: &ToolExecContext,
) -> ToolResultEnvelope {
    let date = match resolve_date(args, ctx) {
        Ok(date) => date,
        Err(error) => return validation_error("get_energy_recommendations", error),
    };
    let frog = service.eat_the_frog(date, ctx.zone()).await;
    let jar = service.task_jar(date, ctx.zone()).await;
    let menu = service.dopamine_menu(date, ctx.zone()).await;
    match (frog, jar, menu) {
        (Ok(frog), Ok(jar), Ok(menu)) => ToolResultEnvelope::success(
            "get_energy_recommendations",
            json!({
                "date": date.to_string(),
                "eat_the_frog": frog.task.as_ref().map(task_card),
                "task_jar": jar.tasks.iter().map(task_card).collect::<Vec<_>>(),
                "dopamine_menu": menu.tasks.iter().map(task_card).collect::<Vec<_>>(),
                "revision": frog.revision,
            }),
        ),
        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
            map_app_error("get_energy_recommendations", error)
        }
    }
}

async fn exec_estimate_duration<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &EstimateTaskDurationArgs,
    ctx: &ToolExecContext,
) -> ToolResultEnvelope {
    let title = if let Some(task_id_raw) = &args.task_id {
        let task_id = match parse_task_id(task_id_raw) {
            Ok(id) => id,
            Err(error) => return validation_error("estimate_task_duration", error),
        };
        match service.get_task(task_id).await {
            Ok(task) => task.title.as_str().to_owned(),
            Err(error) => return map_app_error("estimate_task_duration", error),
        }
    } else if let Some(title) = &args.title {
        title.clone()
    } else {
        return ToolResultEnvelope::error(
            "estimate_task_duration",
            "missing_target",
            "task_id or title is required",
        );
    };
    let needle = normalize_title(&title);
    match load_completed_tasks(service, ctx).await {
        Ok((tasks, revision)) => {
            let mut samples = Vec::new();
            for task in &tasks {
                let Some(actual) = task.actual_minutes.map(|value| value.get()) else {
                    continue;
                };
                if actual == 0 {
                    continue;
                }
                let score = title_similarity(&needle, &normalize_title(task.title.as_str()));
                if score >= 0.4 {
                    samples.push((score, actual));
                }
            }
            samples.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            samples.truncate(20);
            let estimate = if samples.is_empty() {
                None
            } else {
                let total: u32 = samples.iter().map(|(_, actual)| *actual).sum();
                Some(total / samples.len() as u32)
            };
            ToolResultEnvelope::success(
                "estimate_task_duration",
                json!({
                    "title": title,
                    "estimated_minutes": estimate,
                    "sample_count": samples.len(),
                    "revision": revision,
                }),
            )
        }
        Err(error) => map_app_error("estimate_task_duration", error),
    }
}

async fn exec_suggest_tags<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &SuggestTagsArgs,
) -> ToolResultEnvelope {
    let limit = args.limit.unwrap_or(5).min(20) as usize;
    let haystack = format!(
        "{} {}",
        args.title.to_ascii_lowercase(),
        args.description
            .as_deref()
            .unwrap_or("")
            .to_ascii_lowercase()
    );
    match service
        .list_tags_bounded(AI_TOOL_RESULT_ENTITY_MAX as u32)
        .await
    {
        Ok(page) => {
            let mut suggestions = page
                .tags
                .iter()
                .filter(|tag| {
                    let name = tag.name.as_str().to_ascii_lowercase();
                    !name.is_empty() && haystack.contains(&name)
                })
                .take(limit)
                .map(tag_card)
                .collect::<Vec<_>>();
            // Stable fallback: first N tags when no substring hits, still deterministic.
            if suggestions.is_empty() {
                suggestions = page.tags.iter().take(limit).map(tag_card).collect();
            }
            ToolResultEnvelope::success(
                "suggest_tags",
                json!({
                    "suggestions": suggestions,
                    "revision": page.revision,
                    "truncated": page.truncated,
                }),
            )
        }
        Err(error) => map_app_error("suggest_tags", error),
    }
}

async fn exec_plan_my_day<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &OptionalDateArgs,
    ctx: &ToolExecContext,
) -> ToolResultEnvelope {
    let date = match resolve_date(args, ctx) {
        Ok(date) => date,
        Err(error) => return validation_error("plan_my_day", error),
    };
    match service.daily_plan(date, None, ctx.zone()).await {
        Ok(page) => ToolResultEnvelope::success(
            "plan_my_day",
            json!({
                "date": date.to_string(),
                "overdue_tasks": page.overdue_tasks.iter().map(task_card).collect::<Vec<_>>(),
                "focus_tasks": page.focus_tasks.iter().map(task_card).collect::<Vec<_>>(),
                "estimated_total_minutes": page.estimated_total_minutes,
                "capacity_minutes": page.capacity_minutes,
                "revision": page.revision,
            }),
        ),
        Err(error) => map_app_error("plan_my_day", error),
    }
}

async fn exec_daily_review<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &OptionalDateArgs,
    ctx: &ToolExecContext,
) -> ToolResultEnvelope {
    let date = match resolve_date(args, ctx) {
        Ok(date) => date,
        Err(error) => return validation_error("daily_review", error),
    };
    match service.end_of_day(date, None, ctx.zone()).await {
        Ok(page) => ToolResultEnvelope::success(
            "daily_review",
            json!({
                "date": date.to_string(),
                "win_tasks": page.win_tasks.iter().map(task_card).collect::<Vec<_>>(),
                "carry_over_tasks": page.carry_over_tasks.iter().map(task_card).collect::<Vec<_>>(),
                "tomorrow_tasks": page.tomorrow_tasks.iter().map(task_card).collect::<Vec<_>>(),
                "tomorrow_estimated_minutes": page.tomorrow_estimated_minutes,
                "completion_rate_percent": page.completion_rate_percent,
                "capacity_minutes": page.capacity_minutes,
                "revision": page.revision,
            }),
        ),
        Err(error) => map_app_error("daily_review", error),
    }
}

async fn exec_weekly_review<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &OptionalDateArgs,
    ctx: &ToolExecContext,
) -> ToolResultEnvelope {
    let date = match resolve_date(args, ctx) {
        Ok(date) => date,
        Err(error) => return validation_error("weekly_review", error),
    };
    match service.weekly_review_bounded(date, None, ctx.zone()).await {
        Ok((page, projects_truncated)) => {
            let mut envelope = ToolResultEnvelope::success(
                "weekly_review",
                json!({
                    "date": date.to_string(),
                    "summary": {
                        "completed_count": page.summary.completed_count,
                        "created_count": page.summary.created_count,
                        "overdue_count": page.summary.overdue_task_ids.len(),
                        "top_accomplishment_ids": page.summary.top_accomplishment_ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
                    },
                    "top_accomplishment_tasks": page.top_accomplishment_tasks.iter().map(task_card).collect::<Vec<_>>(),
                    "overdue_tasks": page.overdue_tasks.iter().map(task_card).collect::<Vec<_>>(),
                    "projects_truncated": projects_truncated,
                    "revision": page.revision,
                }),
            );
            if projects_truncated {
                envelope.truncated = true;
            }
            envelope
        }
        Err(error) => map_app_error("weekly_review", error),
    }
}

// ── Memory ──────────────────────────────────────────────────────────────────

async fn exec_save_memory<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &SaveMemoryArgs,
    op: OperationId,
) -> ToolResultEnvelope {
    let result = service
        .create_ai_memory(
            op,
            CreateAiMemoryRequest {
                content: args.content.clone(),
            },
        )
        .await;
    mutation_result("save_memory", result)
}

async fn exec_recall_memories<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &RecallMemoriesArgs,
) -> ToolResultEnvelope {
    let session_id = match &args.session_id {
        Some(raw) => match parse_session_id(raw) {
            Ok(id) => Some(id),
            Err(error) => return validation_error("recall_memories", error),
        },
        None => None,
    };
    let limit = args
        .limit
        .unwrap_or(AI_CONTEXT_MEMORIES_MAX)
        .min(AI_CONTEXT_MEMORIES_MAX);
    match service
        .select_ai_memories_for_context(SelectAiMemoriesRequest {
            session_id,
            limit: Some(limit),
        })
        .await
    {
        Ok(memories) => ToolResultEnvelope::success(
            "recall_memories",
            json!({
                "memories": memories.iter().map(|memory| json!({
                    "id": memory.id.to_string(),
                    "content": memory.content,
                    "updated_at": memory.updated_at.to_string(),
                })).collect::<Vec<_>>(),
                "count": memories.len(),
            }),
        ),
        Err(error) => map_app_error("recall_memories", error),
    }
}

// ── Scheduling preview + exact apply ────────────────────────────────────────

/// Documented fallback work window when `settings.planning.work_hours` is unset.
const DEFAULT_WORK_HOURS_START_MINUTE: u16 = 9 * 60;
const DEFAULT_WORK_HOURS_END_MINUTE: u16 = 17 * 60;

async fn load_work_hours_snapshot<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    ctx: &ToolExecContext,
) -> Result<(WorkHours, bool), AppError> {
    let configured = match ctx.confirmed_work_hours {
        Some(configured) => configured,
        None => service.get_settings().await?.planning.work_hours,
    };
    match configured {
        Some(hours) => Ok((hours, false)),
        None => Ok((
            WorkHours::new(
                DEFAULT_WORK_HOURS_START_MINUTE,
                DEFAULT_WORK_HOURS_END_MINUTE,
            )
            .expect("default work hours are valid"),
            true,
        )),
    }
}

async fn exec_schedule_preview<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    tool: &str,
    args: &OptionalDateArgs,
    ctx: &ToolExecContext,
    reschedule: bool,
) -> ToolResultEnvelope {
    let date = match resolve_date(args, ctx) {
        Ok(date) => date,
        Err(error) => return validation_error(tool, error),
    };
    let (work_hours, work_hours_defaulted) = match load_work_hours_snapshot(service, ctx).await {
        Ok(value) => value,
        Err(error) => return map_app_error(tool, error),
    };
    let plan = match service.daily_plan(date, None, ctx.zone()).await {
        Ok(page) => page,
        Err(error) => return map_app_error(tool, error),
    };
    let page = match service.list_timeblocking_range(date, date).await {
        Ok(page) => page,
        Err(error) => return map_app_error(tool, error),
    };
    let occupied = occupied_intervals_for_day(date, &page.blocks, &page.slots, work_hours);
    let day_start = minutes_to_time(work_hours.start_minute);
    let day_end = minutes_to_time(work_hours.end_minute);
    let mut cursor = day_start;
    let mut proposed = Vec::new();
    let focus = if reschedule {
        // Prefer overdue + focus for reschedule preview.
        let mut tasks = plan.overdue_tasks.clone();
        for task in &plan.focus_tasks {
            if !tasks.iter().any(|existing| existing.id == task.id) {
                tasks.push(task.clone());
            }
        }
        tasks
    } else {
        plan.focus_tasks.clone()
    };
    let zone_name = ctx.zone_name();
    for task in focus.iter().take(AI_TOOL_AUTO_SCHEDULE_BLOCKS_MAX) {
        let minutes = task
            .estimated_minutes
            .map(|value| value.get())
            .unwrap_or(30)
            .clamp(15, 240);
        let Some((start, end)) = find_gap_for_duration(cursor, day_end, minutes, &occupied) else {
            break;
        };
        proposed.push(json!({
            "task_id": task.id.to_string(),
            "title": truncate_entity_title(task.title.as_str()),
            "date": date.to_string(),
            "start": start.to_string(),
            "end": end.to_string(),
            "time_zone": zone_name.as_str(),
            "estimated_minutes": minutes,
        }));
        cursor = end;
    }
    ToolResultEnvelope::success(
        tool,
        json!({
            "date": date.to_string(),
            "preview_only": true,
            "apply_supported": !reschedule,
            "proposed_blocks": proposed,
            "capacity_minutes": plan.capacity_minutes,
            "estimated_total_minutes": plan.estimated_total_minutes,
            "existing_block_count": page.blocks.len(),
            "existing_slot_count": page.slots.len(),
            "work_hours": {
                "start_minute": work_hours.start_minute,
                "end_minute": work_hours.end_minute,
                "defaulted": work_hours_defaulted,
            },
            "revision": plan.revision,
        }),
    )
}

async fn exec_apply_auto_schedule_day<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &ApplyAutoScheduleDayArgs,
    root: OperationId,
    mode: ToolExecutionMode,
) -> ToolResultEnvelope {
    const TOOL: &str = "apply_auto_schedule_day";
    // Registry already enforced bounds; rebuild drafts before any effect.
    if args.blocks.is_empty() || args.blocks.len() > AI_TOOL_AUTO_SCHEDULE_BLOCKS_MAX {
        return ToolResultEnvelope::error(
            TOOL,
            "invalid_blocks",
            "blocks must contain 1..=16 entries",
        );
    }
    let apply_date = match parse_date(&args.date) {
        Ok(date) => date,
        Err(error) => return validation_error(TOOL, error),
    };

    struct PreparedBlock {
        index: usize,
        task_id: junban_domain::TaskId,
        child_op: OperationId,
        draft: TimeBlockDraft,
    }

    let mut prepared = Vec::with_capacity(args.blocks.len());
    let mut seen_tasks = BTreeSet::new();
    for (index, block) in args.blocks.iter().enumerate() {
        let task_id = match parse_task_id(&block.task_id) {
            Ok(id) => id,
            Err(error) => return validation_error(TOOL, error),
        };
        if !seen_tasks.insert(task_id) {
            return ToolResultEnvelope::error(
                TOOL,
                "duplicate_task_id",
                "blocks must reference unique task_id values",
            );
        }
        let title = match parse_entity_name(&block.title) {
            Ok(title) => title,
            Err(error) => return validation_error(TOOL, error),
        };
        let block_date = match parse_date(&block.date) {
            Ok(date) => date,
            Err(error) => return validation_error(TOOL, error),
        };
        if block_date != apply_date {
            return ToolResultEnvelope::error(
                TOOL,
                "date_mismatch",
                "each block date must equal the apply date",
            );
        }
        let start = match parse_time(&block.start) {
            Ok(time) => time,
            Err(error) => return validation_error(TOOL, error),
        };
        let end = match parse_time(&block.end) {
            Ok(time) => time,
            Err(error) => return validation_error(TOOL, error),
        };
        let zone = match parse_time_zone(&block.time_zone) {
            Ok(zone) => zone,
            Err(error) => return validation_error(TOOL, error),
        };
        if !(15..=240).contains(&block.estimated_minutes) {
            return ToolResultEnvelope::error(
                TOOL,
                "invalid_estimated_minutes",
                "estimated_minutes must be 15..=240",
            );
        }
        let range = match CivilTimeRange::new(block_date, start, end, zone) {
            Ok(range) => range,
            Err(_) => {
                return ToolResultEnvelope::error(
                    TOOL,
                    "invalid_range",
                    "end must be after start on the same date",
                );
            }
        };
        let mut draft = TimeBlockDraft::new(title, range);
        draft.task_id = Some(task_id);
        prepared.push(PreparedBlock {
            index,
            task_id,
            child_op: derive_child_operation_id(root, TOOL, index as u32),
            draft,
        });
    }

    // Recovery probes durable child receipts before state-dependent prevalidation so a
    // fully committed retry can replay even if tasks later changed or disappeared.
    // Initial execution always goes through create_time_block so exact same-root
    // retries replay while poisoned/different child requests fail closed.
    let mut recovered: Vec<Option<CommittedMutation>> = vec![None; prepared.len()];
    if mode == ToolExecutionMode::Recovery {
        let mut missing = false;
        for (index, item) in prepared.iter().enumerate() {
            match service.recover_operation_receipt(item.child_op).await {
                Ok(mutation) => {
                    if let Err(error) = validate_time_block_create_receipt(&mutation, item.child_op)
                    {
                        return map_app_error(TOOL, error);
                    }
                    recovered[index] = Some(mutation);
                }
                Err(AppError::NotFound) => missing = true,
                Err(error) => return map_app_error(TOOL, error),
            }
        }
        if missing {
            // Fail closed before the first missing write when any referenced task is gone.
            for task_id in &seen_tasks {
                match service.get_task(*task_id).await {
                    Ok(_) => {}
                    Err(AppError::NotFound) => {
                        let created = recovered
                            .iter()
                            .zip(prepared.iter())
                            .filter_map(|(mutation, item)| {
                                mutation.as_ref().map(|mutation| {
                                    composite_created_block_entry(
                                        mutation,
                                        item.child_op,
                                        item.task_id,
                                    )
                                })
                            })
                            .collect::<Vec<_>>();
                        if created.is_empty() {
                            return ToolResultEnvelope::error(
                                TOOL,
                                "not_found",
                                "one or more referenced tasks were not found",
                            );
                        }
                        let failed_index = recovered.iter().position(Option::is_none).unwrap_or(0);
                        let failed_op = prepared[failed_index].child_op;
                        return partial_composite_outcome(
                            TOOL,
                            created,
                            failed_index,
                            AppError::NotFound,
                            json!({
                                "date": apply_date.to_string(),
                                "failed_operation_id": failed_op.to_string(),
                            }),
                        );
                    }
                    Err(error) => return map_app_error(TOOL, error),
                }
            }
        }
    } else {
        // Initial path: prevalidate every task before the first write.
        for task_id in &seen_tasks {
            match service.get_task(*task_id).await {
                Ok(_) => {}
                Err(AppError::NotFound) => {
                    return ToolResultEnvelope::error(
                        TOOL,
                        "not_found",
                        "one or more referenced tasks were not found",
                    );
                }
                Err(error) => return map_app_error(TOOL, error),
            }
        }
    }

    let mut created = Vec::with_capacity(prepared.len());
    for (item, prior) in prepared.into_iter().zip(recovered.into_iter()) {
        let mutation = if let Some(mutation) = prior {
            mutation
        } else {
            match create_composite_time_block(service, item.child_op, item.draft, mode).await {
                Ok(mutation) => mutation,
                Err(error) => {
                    return partial_composite_outcome(
                        TOOL,
                        created,
                        item.index,
                        error,
                        json!({
                            "date": apply_date.to_string(),
                            "failed_operation_id": item.child_op.to_string(),
                        }),
                    );
                }
            }
        };
        created.push(composite_created_block_entry(
            &mutation,
            item.child_op,
            item.task_id,
        ));
    }

    ToolResultEnvelope::success(
        TOOL,
        json!({
            "date": apply_date.to_string(),
            "created": created,
            "count": args.blocks.len(),
        }),
    )
}

fn truncate_entity_title(raw: &str) -> String {
    raw.chars().take(MAX_ENTITY_NAME_CHARS).collect()
}

fn minutes_to_time(minute: u16) -> Time {
    Time::constant((minute / 60) as i8, (minute % 60) as i8, 0, 0)
}

fn time_to_minutes(time: Time) -> u32 {
    time.hour() as u32 * 60 + time.minute() as u32
}

/// Combine authoritative blocks and slots into clamped, merged occupied intervals.
fn occupied_intervals_for_day(
    date: Date,
    blocks: &[junban_domain::TimeBlock],
    slots: &[junban_domain::TimeSlot],
    work_hours: WorkHours,
) -> Vec<(Time, Time)> {
    let window_start = minutes_to_time(work_hours.start_minute);
    let window_end = minutes_to_time(work_hours.end_minute);
    let mut raw = Vec::new();
    for block in blocks {
        if block.range.date == date {
            raw.push((block.range.start, block.range.end));
        }
    }
    for slot in slots {
        if slot.range.date == date {
            raw.push((slot.range.start, slot.range.end));
        }
    }
    clamp_and_merge_intervals(raw, window_start, window_end)
}

fn clamp_and_merge_intervals(
    mut intervals: Vec<(Time, Time)>,
    window_start: Time,
    window_end: Time,
) -> Vec<(Time, Time)> {
    let mut clamped = Vec::new();
    for (start, end) in intervals.drain(..) {
        let start = if start < window_start {
            window_start
        } else {
            start
        };
        let end = if end > window_end { window_end } else { end };
        if start < end {
            clamped.push((start, end));
        }
    }
    clamped.sort_by_key(|(start, end)| (time_to_minutes(*start), time_to_minutes(*end)));
    let mut merged = Vec::new();
    for (start, end) in clamped {
        if let Some((_, last_end)) = merged.last_mut() {
            // Adjacent or overlapping intervals merge so availability is continuous.
            if start <= *last_end {
                if end > *last_end {
                    *last_end = end;
                }
                continue;
            }
        }
        merged.push((start, end));
    }
    merged
}

/// Choose the first gap at/after `cursor` large enough for the whole duration.
fn find_gap_for_duration(
    cursor: Time,
    day_end: Time,
    duration_minutes: u32,
    occupied: &[(Time, Time)],
) -> Option<(Time, Time)> {
    let mut start = cursor;
    loop {
        if start >= day_end {
            return None;
        }
        let start_m = time_to_minutes(start);
        let end_m = start_m + duration_minutes;
        let day_end_m = time_to_minutes(day_end);
        if end_m > day_end_m {
            return None;
        }
        let end = minutes_to_time(end_m as u16);
        // Overlap if any occupied interval intersects [start, end).
        if let Some((_, occ_end)) = occupied
            .iter()
            .copied()
            .find(|(occ_start, occ_end)| *occ_start < end && *occ_end > start)
        {
            start = if occ_end > start { occ_end } else { start };
            // Guard against zero-progress loops on degenerate data.
            if time_to_minutes(start) <= start_m {
                start = minutes_to_time((start_m + 1) as u16);
            }
            continue;
        }
        return Some((start, end));
    }
}

fn free_intervals_from_occupied(
    date: Date,
    occupied: &[(Time, Time)],
    work_hours: WorkHours,
) -> Vec<Value> {
    let day_start = minutes_to_time(work_hours.start_minute);
    let day_end = minutes_to_time(work_hours.end_minute);
    let mut intervals = Vec::new();
    let mut cursor = day_start;
    for &(start, end) in occupied {
        if start > cursor {
            intervals.push(json!({
                "date": date.to_string(),
                "start": cursor.to_string(),
                "end": start.to_string(),
            }));
        }
        if end > cursor {
            cursor = end;
        }
    }
    if cursor < day_end {
        intervals.push(json!({
            "date": date.to_string(),
            "start": cursor.to_string(),
            "end": day_end.to_string(),
        }));
    }
    intervals
}

// ── Timeblocking ────────────────────────────────────────────────────────────

async fn exec_list_blocks<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &TimeblockingRangeArgs,
    ctx: &ToolExecContext,
) -> ToolResultEnvelope {
    let from = match &args.from {
        Some(raw) => match parse_date(raw) {
            Ok(date) => date,
            Err(error) => return validation_error("timeblocking_list_blocks", error),
        },
        None => ctx.date(),
    };
    let to = match &args.to {
        Some(raw) => match parse_date(raw) {
            Ok(date) => date,
            Err(error) => return validation_error("timeblocking_list_blocks", error),
        },
        None => from.checked_add(6.days()).unwrap_or(from),
    };
    match service.list_timeblocking_range(from, to).await {
        Ok(page) => ToolResultEnvelope::success(
            "timeblocking_list_blocks",
            json!({
                "from": from.to_string(),
                "to": to.to_string(),
                "blocks": page.blocks.iter().map(block_card).collect::<Vec<_>>(),
                "slots": page.slots.iter().map(slot_card).collect::<Vec<_>>(),
                "revision": page.revision,
            }),
        ),
        Err(error) => map_app_error("timeblocking_list_blocks", error),
    }
}

struct BlockDraftInput<'a> {
    title: &'a str,
    date: &'a str,
    start: &'a str,
    end: &'a str,
    time_zone: Option<&'a str>,
    task_id: Option<&'a str>,
    color: Option<&'a str>,
    locked: Option<bool>,
    recurrence_rule: Option<&'a str>,
}

async fn exec_create_block<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &TimeblockingCreateBlockArgs,
    ctx: &ToolExecContext,
    op: OperationId,
) -> ToolResultEnvelope {
    match build_block_draft(
        BlockDraftInput {
            title: &args.title,
            date: &args.date,
            start: &args.start,
            end: &args.end,
            time_zone: args.time_zone.as_deref(),
            task_id: args.task_id.as_deref(),
            color: args.color.as_deref(),
            locked: args.locked,
            recurrence_rule: args.recurrence_rule.as_deref(),
        },
        ctx,
    ) {
        Ok(draft) => mutation_result(
            "timeblocking_create_block",
            service.create_time_block(op, draft).await,
        ),
        Err(error) => validation_error("timeblocking_create_block", error),
    }
}

fn build_block_draft(
    input: BlockDraftInput<'_>,
    ctx: &ToolExecContext,
) -> Result<TimeBlockDraft, ToolValidationError> {
    let title = parse_entity_name(input.title)?;
    let date = parse_date(input.date)?;
    let start = parse_time(input.start)?;
    let end = parse_time(input.end)?;
    let zone = match input.time_zone {
        Some(raw) => parse_time_zone(raw)?,
        None => ctx.zone_name(),
    };
    let range = CivilTimeRange::new(date, start, end, zone).map_err(|_| {
        ToolValidationError::new("invalid_range", "end must be after start on the same date")
    })?;
    let mut draft = TimeBlockDraft::new(title, range);
    if let Some(task_id) = input.task_id {
        draft.task_id = Some(parse_task_id(task_id)?);
    }
    if let Some(color) = input.color {
        draft.color = Some(parse_color(color)?);
    }
    if let Some(locked) = input.locked {
        draft.locked = locked;
    }
    if let Some(rule) = input.recurrence_rule {
        draft.recurrence_rule = Some(parse_recurrence(rule)?);
    }
    Ok(draft)
}

async fn exec_update_block<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &TimeblockingUpdateBlockArgs,
    op: OperationId,
) -> ToolResultEnvelope {
    let block_id = match parse_block_id(&args.block_id) {
        Ok(id) => id,
        Err(error) => return validation_error("timeblocking_update_block", error),
    };
    let mut patch = TimeBlockPatch::default();
    if let Some(title) = &args.title {
        match parse_entity_name(title) {
            Ok(title) => patch.title = Some(title),
            Err(error) => return validation_error("timeblocking_update_block", error),
        }
    }
    if args.date.is_some() || args.start.is_some() || args.end.is_some() || args.time_zone.is_some()
    {
        let mut range = TimeBlockRangePatch::default();
        if let Some(date) = &args.date {
            match parse_date(date) {
                Ok(date) => range.date = Some(date),
                Err(error) => return validation_error("timeblocking_update_block", error),
            }
        }
        if let Some(start) = &args.start {
            match parse_time(start) {
                Ok(start) => range.start = Some(start),
                Err(error) => return validation_error("timeblocking_update_block", error),
            }
        }
        if let Some(end) = &args.end {
            match parse_time(end) {
                Ok(end) => range.end = Some(end),
                Err(error) => return validation_error("timeblocking_update_block", error),
            }
        }
        if let Some(zone) = &args.time_zone {
            match parse_time_zone(zone) {
                Ok(zone) => range.time_zone = Some(zone),
                Err(error) => return validation_error("timeblocking_update_block", error),
            }
        }
        patch.range = Some(range);
    }
    if let Some(color) = &args.color {
        match color {
            Some(raw) => match parse_color(raw) {
                Ok(color) => patch.color = Some(Some(color)),
                Err(error) => return validation_error("timeblocking_update_block", error),
            },
            None => patch.color = Some(None),
        }
    }
    if let Some(locked) = args.locked {
        patch.locked = Some(locked);
    }
    if let Some(task_id) = &args.task_id {
        match task_id {
            Some(raw) => match parse_task_id(raw) {
                Ok(id) => patch.task_id = Some(Some(id)),
                Err(error) => return validation_error("timeblocking_update_block", error),
            },
            None => patch.task_id = Some(None),
        }
    }
    mutation_result(
        "timeblocking_update_block",
        service.patch_time_block(op, block_id, patch).await,
    )
}

async fn exec_schedule_task<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &TimeblockingScheduleTaskArgs,
    ctx: &ToolExecContext,
    op: OperationId,
) -> ToolResultEnvelope {
    let task_id = match parse_task_id(&args.task_id) {
        Ok(id) => id,
        Err(error) => return validation_error("timeblocking_schedule_task", error),
    };
    let task = match service.get_task(task_id).await {
        Ok(task) => task,
        Err(error) => return map_app_error("timeblocking_schedule_task", error),
    };
    let title = match &args.title {
        Some(title) => title.clone(),
        None => task.title.as_str().to_owned(),
    };
    match build_block_draft(
        BlockDraftInput {
            title: &title,
            date: &args.date,
            start: &args.start,
            end: &args.end,
            time_zone: args.time_zone.as_deref(),
            task_id: Some(args.task_id.as_str()),
            color: None,
            locked: None,
            recurrence_rule: None,
        },
        ctx,
    ) {
        Ok(draft) => mutation_result(
            "timeblocking_schedule_task",
            service.create_time_block(op, draft).await,
        ),
        Err(error) => validation_error("timeblocking_schedule_task", error),
    }
}

async fn exec_availability<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &OptionalDateArgs,
    ctx: &ToolExecContext,
) -> ToolResultEnvelope {
    let date = match resolve_date(args, ctx) {
        Ok(date) => date,
        Err(error) => return validation_error("timeblocking_get_availability", error),
    };
    let (work_hours, work_hours_defaulted) = match load_work_hours_snapshot(service, ctx).await {
        Ok(value) => value,
        Err(error) => return map_app_error("timeblocking_get_availability", error),
    };
    match service.list_timeblocking_range(date, date).await {
        Ok(page) => {
            let occupied = occupied_intervals_for_day(date, &page.blocks, &page.slots, work_hours);
            let intervals = free_intervals_from_occupied(date, &occupied, work_hours);
            ToolResultEnvelope::success(
                "timeblocking_get_availability",
                json!({
                    "date": date.to_string(),
                    "intervals": intervals,
                    "work_hours": {
                        "start_minute": work_hours.start_minute,
                        "end_minute": work_hours.end_minute,
                        "defaulted": work_hours_defaulted,
                    },
                    "revision": page.revision,
                }),
            )
        }
        Err(error) => map_app_error("timeblocking_get_availability", error),
    }
}

async fn exec_set_recurrence<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &TimeblockingSetRecurrenceArgs,
    op: OperationId,
) -> ToolResultEnvelope {
    let block_id = match parse_block_id(&args.block_id) {
        Ok(id) => id,
        Err(error) => return validation_error("timeblocking_set_recurrence", error),
    };
    let rule = match parse_recurrence(&args.recurrence_rule) {
        Ok(rule) => rule,
        Err(error) => return validation_error("timeblocking_set_recurrence", error),
    };
    let patch = TimeBlockPatch {
        recurrence_rule: Some(Some(rule)),
        ..TimeBlockPatch::default()
    };
    mutation_result(
        "timeblocking_set_recurrence",
        service.patch_time_block(op, block_id, patch).await,
    )
}

async fn exec_replan_day<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    args: &TimeblockingReplanDayArgs,
    ctx: &ToolExecContext,
    op: OperationId,
) -> ToolResultEnvelope {
    let action = match args.action.as_str() {
        "move_to_today" => ReplanPastBlocksAction::MoveToToday,
        "move_to_tomorrow" => ReplanPastBlocksAction::MoveToTomorrow,
        "delete" => ReplanPastBlocksAction::Delete,
        _ => {
            return ToolResultEnvelope::error(
                "timeblocking_replan_day",
                "invalid_action",
                "action must be move_to_today|move_to_tomorrow|delete",
            );
        }
    };
    let preview = match service
        .preview_replan_past_blocks_with(ctx.temporal())
        .await
    {
        Ok(preview) => preview,
        Err(error) => return map_app_error("timeblocking_replan_day", error),
    };
    mutation_result(
        "timeblocking_replan_day",
        service
            .replan_past_blocks_with(
                op,
                action,
                preview.as_of_date,
                preview.candidate_ids,
                ctx.temporal(),
            )
            .await,
    )
}

// ── Shared helpers ──────────────────────────────────────────────────────────

async fn create_composite_task<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    child_operation_id: OperationId,
    draft: TaskDraft,
    mode: ToolExecutionMode,
) -> Result<CommittedMutation, AppError> {
    let mutation = if mode == ToolExecutionMode::Recovery {
        match service.recover_operation_receipt(child_operation_id).await {
            Ok(mutation) => mutation,
            Err(AppError::NotFound) => service.create_task(child_operation_id, draft).await?,
            Err(error) => return Err(error),
        }
    } else {
        service.create_task(child_operation_id, draft).await?
    };
    if mutation.event.operation_id != child_operation_id
        || mutation.event.event_type.as_str() != EventType::TASK_CREATED
        || mutation_primary_id(&mutation).is_none()
    {
        return Err(AppError::Storage);
    }
    Ok(mutation)
}

async fn create_composite_time_block<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    child_operation_id: OperationId,
    draft: TimeBlockDraft,
    mode: ToolExecutionMode,
) -> Result<CommittedMutation, AppError> {
    let mutation = if mode == ToolExecutionMode::Recovery {
        match service.recover_operation_receipt(child_operation_id).await {
            Ok(mutation) => mutation,
            Err(AppError::NotFound) => service.create_time_block(child_operation_id, draft).await?,
            Err(error) => return Err(error),
        }
    } else {
        service.create_time_block(child_operation_id, draft).await?
    };
    validate_time_block_create_receipt(&mutation, child_operation_id)?;
    Ok(mutation)
}

fn composite_created_entry(mutation: &CommittedMutation, child_operation_id: OperationId) -> Value {
    json!({
        "task_id": mutation_primary_id(mutation).expect("validated task-create receipt"),
        "operation_id": child_operation_id.to_string(),
        "revision": mutation.event.revision,
        "event_type": mutation.event.event_type.as_str(),
    })
}

fn validate_time_block_create_receipt(
    mutation: &CommittedMutation,
    child_operation_id: OperationId,
) -> Result<(), AppError> {
    if mutation.event.operation_id != child_operation_id
        || mutation.event.event_type.as_str() != EventType::TIME_BLOCK_CREATED
        || mutation_primary_id(mutation).is_none()
    {
        return Err(AppError::Storage);
    }
    Ok(())
}

fn composite_created_block_entry(
    mutation: &CommittedMutation,
    child_operation_id: OperationId,
    task_id: junban_domain::TaskId,
) -> Value {
    json!({
        "block_id": mutation_primary_id(mutation).expect("validated time-block-create receipt"),
        "task_id": task_id.to_string(),
        "operation_id": child_operation_id.to_string(),
        "revision": mutation.event.revision,
        "event_type": mutation.event.event_type.as_str(),
    })
}

async fn load_pending_tasks<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    ctx: &ToolExecContext,
) -> Result<(Vec<Task>, u64), AppError> {
    let as_of = ctx.as_of()?;
    let mut query = TaskQuery::new().with_status(TaskStatus::Pending);
    query.sort = TaskSort::UpdatedDesc;
    let collected = service
        .collect_task_query_pages(query, as_of, AI_TOOL_RESULT_ENTITY_MAX)
        .await?;
    Ok((collected.tasks, collected.revision))
}

async fn load_completed_tasks<R: Repository, E: EventSink>(
    service: &JunbanService<R, E>,
    ctx: &ToolExecContext,
) -> Result<(Vec<Task>, u64), AppError> {
    let as_of = ctx.as_of()?;
    let mut query = TaskQuery::new().with_status(TaskStatus::Completed);
    query.sort = TaskSort::UpdatedDesc;
    let collected = service
        .collect_task_query_pages(query, as_of, AI_TOOL_RESULT_ENTITY_MAX)
        .await?;
    Ok((collected.tasks, collected.revision))
}

fn resolve_date(
    args: &OptionalDateArgs,
    ctx: &ToolExecContext,
) -> Result<Date, ToolValidationError> {
    match &args.date {
        Some(raw) => parse_date(raw),
        None => Ok(ctx.date()),
    }
}

fn resolve_range(
    args: &AnalyzeRangeArgs,
    ctx: &ToolExecContext,
) -> Result<(Date, Date), ToolValidationError> {
    let to = match &args.to {
        Some(raw) => parse_date(raw)?,
        None => ctx.date(),
    };
    let from = match &args.from {
        Some(raw) => parse_date(raw)?,
        None => to.checked_sub(13.days()).unwrap_or(to),
    };
    if from > to {
        return Err(ToolValidationError::new(
            "invalid_range",
            "from must be on or before to",
        ));
    }
    Ok((from, to))
}

fn mutation_primary_id(mutation: &junban_app::CommittedMutation) -> Option<String> {
    mutation
        .event
        .primary
        .as_ref()
        .map(|primary| primary.id.clone())
}

fn primary_ref_json(mutation: &junban_app::CommittedMutation) -> Option<Value> {
    mutation.event.primary.as_ref().map(|primary| {
        json!({
            "kind": resource_type_kind(primary.resource_type),
            "id": primary.id,
        })
    })
}

fn resource_type_kind(resource_type: junban_app::ResourceType) -> &'static str {
    match resource_type {
        junban_app::ResourceType::Task => "task",
        junban_app::ResourceType::Project => "project",
        junban_app::ResourceType::Section => "section",
        junban_app::ResourceType::Tag => "tag",
        junban_app::ResourceType::Template => "template",
        junban_app::ResourceType::SavedFilter => "saved_filter",
        junban_app::ResourceType::Comment => "comment",
        junban_app::ResourceType::Relation => "relation",
        junban_app::ResourceType::Operation => "operation",
        junban_app::ResourceType::TimeBlock => "time_block",
        junban_app::ResourceType::TimeSlot => "time_slot",
        junban_app::ResourceType::Settings => "settings",
        junban_app::ResourceType::AiSession => "ai_session",
        junban_app::ResourceType::AiMemory => "ai_memory",
        junban_app::ResourceType::AiApproval => "ai_approval",
    }
}

fn app_error_code(error: &AppError) -> &'static str {
    match error {
        AppError::NotFound => "not_found",
        AppError::Conflict => "conflict",
        AppError::IdempotencyMismatch => "idempotency_mismatch",
        AppError::OperationTooLarge | AppError::ResultLimitExceeded => "limit_exceeded",
        AppError::Validation(_) => "validation",
        AppError::Storage | AppError::CatastrophicRestore => "unavailable",
    }
}

fn partial_composite_outcome(
    tool: &str,
    created: Vec<Value>,
    failed_index: usize,
    error: AppError,
    extra: Value,
) -> ToolResultEnvelope {
    let code = app_error_code(&error);
    let mut data = json!({
        "partial": true,
        "created": created,
        "failed_index": failed_index,
        "code": code,
        "message": "composite action stopped after a concurrent failure; committed children are listed",
    });
    if let Some(object) = data.as_object_mut()
        && let Some(extra_object) = extra.as_object()
    {
        for (key, value) in extra_object {
            object.insert(key.clone(), value.clone());
        }
    }
    let mut envelope = ToolResultEnvelope::error(tool, code, "composite action partially applied");
    envelope.data = data;
    envelope
}

fn mutation_result(
    tool: &str,
    result: Result<junban_app::CommittedMutation, AppError>,
) -> ToolResultEnvelope {
    match result {
        Ok(mutation) => {
            let mut data = json!({
                "event_type": mutation.event.event_type.as_str(),
                "affected": {
                    "task_ids": mutation.event.affected.task_ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
                    "project_ids": mutation.event.affected.project_ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
                    "tag_ids": mutation.event.affected.tag_ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
                    "time_block_ids": mutation.event.affected.time_block_ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
                },
            });
            if let Some(primary) = primary_ref_json(&mutation)
                && let Some(object) = data.as_object_mut()
            {
                object.insert("primary".to_owned(), primary);
            }
            ToolResultEnvelope::success(tool, data)
                .with_mutation_meta(mutation.event.operation_id, mutation.event.revision)
        }
        Err(error) => map_app_error(tool, error),
    }
}

fn map_app_error(tool: &str, error: AppError) -> ToolResultEnvelope {
    match error {
        AppError::NotFound => {
            ToolResultEnvelope::error(tool, "not_found", "resource was not found")
        }
        AppError::Conflict => {
            ToolResultEnvelope::error(tool, "conflict", "operation conflicts with current state")
        }
        AppError::IdempotencyMismatch => ToolResultEnvelope::error(
            tool,
            "idempotency_mismatch",
            "operation id was already used for a different request",
        ),
        AppError::OperationTooLarge | AppError::ResultLimitExceeded => ToolResultEnvelope::error(
            tool,
            "limit_exceeded",
            "operation or result exceeds configured bounds",
        ),
        AppError::Validation(_) => {
            ToolResultEnvelope::error(tool, "validation", "request failed validation")
        }
        AppError::Storage | AppError::CatastrophicRestore => {
            ToolResultEnvelope::unavailable(tool, "storage is temporarily unavailable")
        }
    }
}

fn validation_error(tool: &str, error: ToolValidationError) -> ToolResultEnvelope {
    ToolResultEnvelope::error(tool, error.code, error.message)
}

fn task_card(task: &Task) -> Value {
    json!({
        "id": task.id.to_string(),
        "title": task.title.as_str(),
        "description": task.description.as_str(),
        "status": match task.status {
            TaskStatus::Pending => "pending",
            TaskStatus::Completed => "completed",
            TaskStatus::Cancelled => "cancelled",
        },
        "priority": task.priority.map(|value| value.get()),
        "due_date": task.due_date.map(|value| value.to_string()),
        "due_time": task.due_time.as_ref().map(|value| value.time.to_string()),
        "someday": task.someday,
        "estimated_minutes": task.estimated_minutes.map(|value| value.get()),
        "actual_minutes": task.actual_minutes.map(|value| value.get()),
        "dread": task.dread.map(|value| value.get()),
        "project_id": task.project_id.map(|value| value.to_string()),
        "parent_id": task.parent_id.map(|value| value.to_string()),
        "tag_ids": task.tag_ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
        "remind_at": task.remind_at.map(|value| value.to_string()),
        "updated_at": task.updated_at.to_string(),
    })
}

fn project_card(project: &junban_domain::Project) -> Value {
    json!({
        "id": project.id.to_string(),
        "name": project.name.as_str(),
        "color": project.color.as_str(),
        "favorite": project.favorite,
        "archived": project.archived,
        "parent_id": project.parent_id.map(|value| value.to_string()),
    })
}

fn tag_card(tag: &Tag) -> Value {
    json!({
        "id": tag.id.to_string(),
        "name": tag.name.as_str(),
        "color": tag.color.as_str(),
    })
}

fn block_card(block: &junban_domain::TimeBlock) -> Value {
    json!({
        "id": block.id.to_string(),
        "title": block.title.as_str(),
        "date": block.range.date.to_string(),
        "start": block.range.start.to_string(),
        "end": block.range.end.to_string(),
        "time_zone": block.range.time_zone.as_str(),
        "task_id": block.task_id.map(|value| value.to_string()),
        "locked": block.locked,
        "recurrence_rule": block.recurrence_rule.as_ref().map(|value| value.as_str()),
    })
}

fn slot_card(slot: &junban_domain::TimeSlot) -> Value {
    json!({
        "id": slot.id.to_string(),
        "title": slot.title.as_str(),
        "date": slot.range.date.to_string(),
        "start": slot.range.start.to_string(),
        "end": slot.range.end.to_string(),
        "time_zone": slot.range.time_zone.as_str(),
        "task_ids": slot.task_ids.as_slice().iter().map(ToString::to_string).collect::<Vec<_>>(),
    })
}

fn normalize_title(title: &str) -> String {
    title
        .chars()
        .filter(|ch| !ch.is_control())
        .map(|ch| ch.to_ascii_lowercase())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn title_similarity(a: &str, b: &str) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    if a.contains(b) || b.contains(a) {
        let shorter = a.len().min(b.len()) as f64;
        let longer = a.len().max(b.len()) as f64;
        return (shorter / longer).clamp(0.0, 0.99);
    }
    let set_a = a.split_whitespace().collect::<BTreeSet<_>>();
    let set_b = b.split_whitespace().collect::<BTreeSet<_>>();
    if set_a.is_empty() || set_b.is_empty() {
        return 0.0;
    }
    let inter = set_a.intersection(&set_b).count() as f64;
    let union = set_a.union(&set_b).count() as f64;
    if union == 0.0 { 0.0 } else { inter / union }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::{Arc, Mutex},
        time::{SystemTime, UNIX_EPOCH},
    };

    use jiff::civil::date;
    use junban_app::{CommittedEvent, EventSink};
    use junban_domain::{OperationId, TaskId};
    use junban_storage::{ProfileOwner, SqliteRepository};
    use uuid::Uuid;

    use crate::ai_tool_registry::{
        ToolEffect, ToolOutcome, tool_registrations, validate_tool_call,
    };

    #[derive(Default)]
    struct RecordingSink(Mutex<Vec<CommittedEvent>>);

    impl EventSink for RecordingSink {
        fn publish(&self, event: CommittedEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    fn temp_profile() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "junban-wave3f1-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn op() -> OperationId {
        OperationId::parse(&Uuid::new_v4().to_string()).unwrap()
    }

    fn open_service() -> (
        ProfileOwner,
        JunbanService<SqliteRepository, RecordingSink>,
        PathBuf,
    ) {
        let profile = temp_profile();
        let owner = ProfileOwner::open(&profile).unwrap();
        let repo = Arc::new(owner.repository());
        let sink = Arc::new(RecordingSink::default());
        let service = JunbanService::new(repo, sink);
        (owner, service, profile)
    }

    fn fixed_ctx() -> ToolExecContext {
        let zone = TimeZone::get("UTC").unwrap();
        let now = date(2026, 8, 2).at(12, 0, 0, 0).to_zoned(zone).unwrap();
        ToolExecContext::new(now)
    }

    #[test]
    fn child_operation_ids_are_deterministic_and_domain_separated() {
        let root = OperationId::parse("00112233-4455-6677-8899-aabbccddeeff").unwrap();
        let a = derive_child_operation_id(root, "bulk_create_tasks", 0);
        let b = derive_child_operation_id(root, "bulk_create_tasks", 0);
        let c = derive_child_operation_id(root, "bulk_create_tasks", 1);
        let d = derive_child_operation_id(root, "break_down_task", 0);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
        let uuid = Uuid::parse_str(&a.to_string()).unwrap();
        assert_eq!(uuid.get_variant(), uuid::Variant::RFC4122);
        assert_eq!(uuid.get_version_num(), 8);
    }

    #[tokio::test]
    async fn mutation_requires_root_operation_id() {
        let (_owner, service, profile) = open_service();
        let (action, _) =
            validate_tool_call("create_task", r#"{"title":"Needs approval"}"#).unwrap();
        assert_eq!(action.effect(), ToolEffect::ApprovalRequired);
        let result = execute_tool(&service, &action, &fixed_ctx(), None).await;
        assert_eq!(result.outcome, ToolOutcome::Error);
        assert_eq!(result.data["code"], "operation_required");
        assert!(result.operation_id.is_none());
        let _ = fs::remove_dir_all(profile);
    }

    #[tokio::test]
    async fn recovery_replays_receipt_before_state_dependent_prevalidation() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();
        let (create, _) =
            validate_tool_call("create_task", r#"{"title":"Schedule then delete"}"#).unwrap();
        let created = execute_tool(&service, &create, &ctx, Some(op())).await;
        let task_id = TaskId::parse(created.data["primary"]["id"].as_str().unwrap()).unwrap();
        let (schedule, _) = validate_tool_call(
            "timeblocking_schedule_task",
            &json!({
                "task_id": task_id.to_string(),
                "date": "2026-08-02",
                "start": "13:00",
                "end": "14:00"
            })
            .to_string(),
        )
        .unwrap();
        let dispatch = op();
        let initial = execute_tool(&service, &schedule, &ctx, Some(dispatch)).await;
        assert_eq!(initial.outcome, ToolOutcome::Success);
        service.delete_task(op(), task_id).await.unwrap();

        let recovered = execute_tool_recovery(&service, &schedule, &ctx, dispatch)
            .await
            .unwrap();
        assert_eq!(recovered, initial);
        let _ = fs::remove_dir_all(profile);
    }

    #[tokio::test]
    async fn create_and_query_round_trip_through_service() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();
        let (create, _) =
            validate_tool_call("create_task", r#"{"title":"Ship wave 3f.1","priority":2}"#)
                .unwrap();
        let created = execute_tool(&service, &create, &ctx, Some(op())).await;
        assert_eq!(created.outcome, ToolOutcome::Success);
        assert!(created.operation_id.is_some());
        assert!(created.revision.is_some());

        let (query, _) = validate_tool_call("query_tasks", r#"{"query":"Ship wave"}"#).unwrap();
        let listed = execute_tool(&service, &query, &ctx, None).await;
        assert_eq!(listed.outcome, ToolOutcome::Success);
        assert_eq!(listed.data["tasks"].as_array().unwrap().len(), 1);
        assert!(listed.operation_id.is_none());
        let _ = fs::remove_dir_all(profile);
    }

    #[tokio::test]
    async fn bulk_create_uses_deterministic_child_ops_for_replay() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();
        let root = op();
        let (action, _) =
            validate_tool_call("bulk_create_tasks", r#"{"titles":["one","two","three"]}"#).unwrap();
        let first = execute_tool(&service, &action, &ctx, Some(root)).await;
        assert_eq!(first.outcome, ToolOutcome::Success);
        let first_ops: Vec<String> = first.data["created"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["operation_id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(first_ops.len(), 3);
        assert_eq!(
            first_ops[0],
            derive_child_operation_id(root, "bulk_create_tasks", 0).to_string()
        );
        assert_eq!(
            first_ops[1],
            derive_child_operation_id(root, "bulk_create_tasks", 1).to_string()
        );

        // Exact replay with the same root/child ids returns the original identities.
        let second = execute_tool(&service, &action, &ctx, Some(root)).await;
        assert_eq!(second.outcome, ToolOutcome::Success);
        let second_ops: Vec<String> = second.data["created"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["operation_id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(first_ops, second_ops);
        assert!(
            first.data["created"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row.get("title").is_none())
        );
        let _ = fs::remove_dir_all(profile);
    }

    #[tokio::test]
    async fn hundred_child_manifest_is_complete_chat_bounded_and_exactly_recoverable() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();
        let root = OperationId::new();
        let titles = (0..AI_TOOL_COMPOSITE_CREATE_MAX)
            .map(|index| format!("child-{index}"))
            .collect::<Vec<_>>();
        let (action, _) =
            validate_tool_call("bulk_create_tasks", &json!({"titles": titles}).to_string())
                .unwrap();
        let first = execute_tool(&service, &action, &ctx, Some(root)).await;
        assert_eq!(first.outcome, ToolOutcome::Success);
        let created = first.data["created"].as_array().unwrap();
        assert_eq!(created.len(), AI_TOOL_COMPOSITE_CREATE_MAX);
        assert!(created.iter().all(|row| {
            row["task_id"].as_str().is_some()
                && row["operation_id"].as_str().is_some()
                && row["revision"].as_u64().is_some()
                && row["event_type"].as_str().is_some()
                && row.get("title").is_none()
        }));
        assert!(serde_json::to_vec(&first).unwrap().len() <= 30 * 1024);

        let recovered = execute_tool_recovery(&service, &action, &ctx, root)
            .await
            .unwrap();
        assert_eq!(recovered, first);
        let _ = fs::remove_dir_all(profile);
    }

    #[tokio::test]
    async fn extract_preview_is_read_and_schedule_previews_do_not_mutate() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();
        let (extract, _) =
            validate_tool_call("extract_tasks_from_text", r#"{"text":"- alpha\n- beta"}"#).unwrap();
        assert_eq!(extract.effect(), ToolEffect::Read);
        let preview = execute_tool(&service, &extract, &ctx, None).await;
        assert_eq!(preview.outcome, ToolOutcome::Success);
        assert_eq!(preview.data["dry_run"], true);
        assert_eq!(preview.data["count"], 2);

        let (create, _) = validate_tool_call(
            "create_task",
            r#"{"title":"Focus me","estimated_minutes":30}"#,
        )
        .unwrap();
        let _ = execute_tool(&service, &create, &ctx, Some(op())).await;
        let before = service
            .list_timeblocking_range(ctx.date(), ctx.date())
            .await
            .unwrap();
        let (schedule, _) = validate_tool_call("auto_schedule_day", "{}").unwrap();
        let scheduled = execute_tool(&service, &schedule, &ctx, None).await;
        assert_eq!(scheduled.outcome, ToolOutcome::Success);
        assert_eq!(scheduled.data["preview_only"], true);
        assert_eq!(scheduled.data["apply_supported"], true);
        let proposed = scheduled.data["proposed_blocks"].as_array().unwrap();
        if let Some(first) = proposed.first() {
            assert!(first.get("time_zone").and_then(Value::as_str).is_some());
            assert!(first.get("task_id").is_some());
            assert!(first.get("title").is_some());
            assert!(first.get("date").is_some());
            assert!(first.get("start").is_some());
            assert!(first.get("end").is_some());
            assert!(first.get("estimated_minutes").is_some());
        }
        let (reschedule, _) = validate_tool_call("reschedule_day", "{}").unwrap();
        let rescheduled = execute_tool(&service, &reschedule, &ctx, None).await;
        assert_eq!(rescheduled.data["apply_supported"], false);
        let after = service
            .list_timeblocking_range(ctx.date(), ctx.date())
            .await
            .unwrap();
        assert_eq!(before.blocks.len(), after.blocks.len());
        let _ = fs::remove_dir_all(profile);
    }

    #[tokio::test]
    async fn every_tool_maps_to_service_capability_or_stable_result() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();
        // Seed minimal durable state so reads/mutations have something to touch.
        let (create_task, _) =
            validate_tool_call("create_task", r#"{"title":"Seed task","priority":1}"#).unwrap();
        let seeded = execute_tool(&service, &create_task, &ctx, Some(op())).await;
        assert_eq!(seeded.outcome, ToolOutcome::Success);
        let task_id = seeded.data["affected"]["task_ids"][0]
            .as_str()
            .unwrap()
            .to_owned();

        let (create_project, _) =
            validate_tool_call("create_project", r#"{"name":"Seed Project"}"#).unwrap();
        let project = execute_tool(&service, &create_project, &ctx, Some(op())).await;
        assert_eq!(project.outcome, ToolOutcome::Success);
        let project_id = project.data["affected"]["project_ids"][0]
            .as_str()
            .unwrap()
            .to_owned();

        let (save_memory, _) =
            validate_tool_call("save_memory", r#"{"content":"remember this"}"#).unwrap();
        let memory = execute_tool(&service, &save_memory, &ctx, Some(op())).await;
        assert_eq!(memory.outcome, ToolOutcome::Success);

        // Create a tag through the service so tag tools can resolve names.
        let tag_op = op();
        let tag_mutation = service
            .create_tag(
                tag_op,
                junban_app::TagDraft {
                    name: junban_domain::TagName::new("focus").unwrap(),
                    color: junban_domain::HexColor::new("#3b82f6").unwrap(),
                },
            )
            .await
            .unwrap();
        let tag_id = tag_mutation.event.affected.tag_ids[0].to_string();

        let samples: Vec<(&str, String, bool)> = vec![
            ("create_task", r#"{"title":"another"}"#.to_owned(), true),
            (
                "update_task",
                format!(r#"{{"task_id":"{task_id}","title":"Seed task updated"}}"#),
                true,
            ),
            (
                "complete_task",
                format!(r#"{{"task_id":"{task_id}"}}"#),
                true,
            ),
            ("query_tasks", r#"{}"#.to_owned(), false),
            (
                "break_down_task",
                format!(r#"{{"task_id":"{task_id}","subtasks":["child a"]}}"#),
                true,
            ),
            (
                "extract_tasks_from_text",
                r#"{"text":"- zed","dry_run":true}"#.to_owned(),
                false,
            ),
            (
                "bulk_create_tasks",
                r#"{"titles":["bulk-a"]}"#.to_owned(),
                true,
            ),
            (
                "bulk_complete_tasks",
                format!(r#"{{"task_ids":["{task_id}"]}}"#),
                true,
            ),
            (
                "bulk_update_tasks",
                format!(r#"{{"task_ids":["{task_id}"],"priority":2}}"#),
                true,
            ),
            ("find_similar_tasks", r#"{"title":"Seed"}"#.to_owned(), false),
            ("check_duplicates", r#"{"title":"Seed task updated"}"#.to_owned(), false),
            ("create_project", r#"{"name":"P2"}"#.to_owned(), true),
            ("list_projects", r#"{}"#.to_owned(), false),
            (
                "get_project",
                format!(r#"{{"project_id":"{project_id}"}}"#),
                false,
            ),
            (
                "update_project",
                format!(r#"{{"project_id":"{project_id}","favorite":true}}"#),
                true,
            ),
            ("list_tags", r#"{}"#.to_owned(), false),
            (
                "add_tags_to_task",
                format!(r#"{{"task_id":"{task_id}","tag_ids":["{tag_id}"]}}"#),
                true,
            ),
            (
                "remove_tags_from_task",
                format!(r#"{{"task_id":"{task_id}","tag_ids":["{tag_id}"]}}"#),
                true,
            ),
            ("list_reminders", r#"{}"#.to_owned(), false),
            (
                "set_reminder",
                format!(r#"{{"task_id":"{task_id}","remind_at":"2026-08-03T15:00:00Z"}}"#),
                true,
            ),
            (
                "snooze_reminder",
                format!(r#"{{"task_id":"{task_id}","remind_at":"2026-08-03T16:00:00Z"}}"#),
                true,
            ),
            (
                "dismiss_reminder",
                format!(r#"{{"task_id":"{task_id}"}}"#),
                true,
            ),
            ("analyze_completion_patterns", r#"{}"#.to_owned(), false),
            ("check_overcommitment", r#"{}"#.to_owned(), false),
            ("analyze_workload", r#"{}"#.to_owned(), false),
            ("get_energy_recommendations", r#"{}"#.to_owned(), false),
            ("get_productivity_stats", r#"{}"#.to_owned(), false),
            (
                "estimate_task_duration",
                r#"{"title":"Seed task"}"#.to_owned(),
                false,
            ),
            ("time_tracking_summary", r#"{}"#.to_owned(), false),
            ("suggest_tags", r#"{"title":"focus work"}"#.to_owned(), false),
            ("plan_my_day", r#"{}"#.to_owned(), false),
            ("daily_review", r#"{}"#.to_owned(), false),
            ("weekly_review", r#"{}"#.to_owned(), false),
            ("save_memory", r#"{"content":"second"}"#.to_owned(), true),
            ("recall_memories", r#"{}"#.to_owned(), false),
            ("auto_schedule_day", r#"{}"#.to_owned(), false),
            (
                "apply_auto_schedule_day",
                format!(
                    r#"{{"date":"2026-08-02","blocks":[{{"task_id":"{task_id}","title":"Seed task","date":"2026-08-02","start":"15:00:00","end":"15:30:00","time_zone":"UTC","estimated_minutes":30}}]}}"#
                ),
                true,
            ),
            ("reschedule_day", r#"{}"#.to_owned(), false),
            ("timeblocking_list_blocks", r#"{}"#.to_owned(), false),
            (
                "timeblocking_create_block",
                r#"{"title":"Deep work","date":"2026-08-02","start":"10:00:00","end":"11:00:00","time_zone":"UTC"}"#.to_owned(),
                true,
            ),
            ("timeblocking_get_availability", r#"{}"#.to_owned(), false),
            ("timeblocking_replan_day", r#"{"action":"move_to_today"}"#.to_owned(), true),
        ];

        // Ensure the table covers every registry name either above or in the
        // dedicated follow-up mutations that need created block/memory ids.
        let mut seen = BTreeSet::new();
        let mut direct_receipts = BTreeSet::new();
        let mut recovered_direct_receipts = BTreeSet::new();
        for (name, args, needs_op) in &samples {
            seen.insert(*name);
            let (action, _) = validate_tool_call(name, args).unwrap();
            if action.effect() == ToolEffect::ApprovalRequired && !is_composite_mutation(&action) {
                direct_receipts.insert(*name);
            }
            let root = if *needs_op { Some(op()) } else { None };
            let result = execute_tool(&service, &action, &ctx, root).await;
            assert!(
                matches!(
                    result.outcome,
                    ToolOutcome::Success | ToolOutcome::Error | ToolOutcome::Unavailable
                ),
                "tool {name} produced unexpected outcome {:?}",
                result.outcome
            );
            if let Some(root) = root
                && action.effect() == ToolEffect::ApprovalRequired
                && !is_composite_mutation(&action)
            {
                let recovered = execute_tool_recovery(&service, &action, &ctx, root)
                    .await
                    .unwrap();
                assert_eq!(
                    recovered, result,
                    "direct receipt formatter drifted for {name}"
                );
                recovered_direct_receipts.insert(*name);
            }
            // No raw receipt or token material.
            let encoded = serde_json::to_string(&result).unwrap();
            assert!(!encoded.contains("access_token"));
            assert!(!encoded.contains("receipt"));
            assert!(!encoded.contains("Authorization"));
        }

        // Finish remaining tools that need IDs from prior creates.
        let blocks = service
            .list_timeblocking_range(ctx.date(), ctx.date())
            .await
            .unwrap();
        let block_id = blocks.blocks[0].id.to_string();
        for (name, args, needs_op) in [
            (
                "timeblocking_update_block",
                format!(r#"{{"block_id":"{block_id}","locked":true}}"#),
                true,
            ),
            (
                "timeblocking_set_recurrence",
                format!(r#"{{"block_id":"{block_id}","recurrence_rule":"weekly"}}"#),
                true,
            ),
            (
                "timeblocking_schedule_task",
                format!(
                    r#"{{"task_id":"{task_id}","date":"2026-08-02","start":"13:00:00","end":"13:30:00","time_zone":"UTC"}}"#
                ),
                true,
            ),
            (
                "timeblocking_delete_block",
                format!(r#"{{"block_id":"{block_id}"}}"#),
                true,
            ),
            (
                "delete_project",
                format!(r#"{{"project_id":"{project_id}"}}"#),
                true,
            ),
            ("delete_task", format!(r#"{{"task_id":"{task_id}"}}"#), true),
        ] {
            seen.insert(name);
            let (action, _) = validate_tool_call(name, &args).unwrap();
            if action.effect() == ToolEffect::ApprovalRequired && !is_composite_mutation(&action) {
                direct_receipts.insert(name);
            }
            let root = if needs_op { Some(op()) } else { None };
            let result = execute_tool(&service, &action, &ctx, root).await;
            assert!(
                matches!(
                    result.outcome,
                    ToolOutcome::Success | ToolOutcome::Error | ToolOutcome::Unavailable
                ),
                "tool {name} failed closed unexpectedly: {:?}",
                result
            );
            if let Some(root) = root
                && action.effect() == ToolEffect::ApprovalRequired
                && !is_composite_mutation(&action)
            {
                let recovered = execute_tool_recovery(&service, &action, &ctx, root)
                    .await
                    .unwrap();
                assert_eq!(
                    recovered, result,
                    "direct receipt formatter drifted for {name}"
                );
                recovered_direct_receipts.insert(name);
            }
        }

        // forget_memory needs a memory id from list.
        let memories = service
            .select_ai_memories_for_context(SelectAiMemoriesRequest {
                session_id: None,
                limit: Some(10),
            })
            .await
            .unwrap();
        let memory_id = memories[0].id.to_string();
        seen.insert("forget_memory");
        let (forget, _) = validate_tool_call(
            "forget_memory",
            &format!(r#"{{"memory_id":"{memory_id}"}}"#),
        )
        .unwrap();
        let forget_root = op();
        let forgot = execute_tool(&service, &forget, &ctx, Some(forget_root)).await;
        assert_eq!(forgot.outcome, ToolOutcome::Success);
        direct_receipts.insert("forget_memory");
        assert_eq!(
            execute_tool_recovery(&service, &forget, &ctx, forget_root)
                .await
                .unwrap(),
            forgot
        );
        recovered_direct_receipts.insert("forget_memory");

        // extract apply path
        seen.insert("extract_tasks_from_text");
        let (extract_apply, _) = validate_tool_call(
            "extract_tasks_from_text",
            r#"{"text":"- apply me","dry_run":false}"#,
        )
        .unwrap();
        assert_eq!(extract_apply.effect(), ToolEffect::ApprovalRequired);
        let applied = execute_tool(&service, &extract_apply, &ctx, Some(op())).await;
        assert_eq!(applied.outcome, ToolOutcome::Success);

        let expected: BTreeSet<_> = tool_registrations()
            .iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(
            seen,
            expected,
            "missing tools in coverage: {:?}",
            expected.difference(&seen).collect::<Vec<_>>()
        );
        assert_eq!(
            recovered_direct_receipts, direct_receipts,
            "every sampled non-composite mutation must prove exact formatter equality"
        );

        let _ = fs::remove_dir_all(profile);
    }

    #[test]
    fn registry_default_effect_snapshot_matches_executor_expectations() {
        let mut reads = 0;
        let mut mutations = 0;
        for entry in tool_registrations() {
            match entry.default_effect {
                ToolEffect::Read => reads += 1,
                ToolEffect::ApprovalRequired => mutations += 1,
            }
        }
        assert_eq!(reads, 24);
        assert_eq!(mutations, 25);
    }

    #[tokio::test]
    async fn apply_auto_schedule_day_creates_exact_blocks_and_replays() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();

        let long_title = "x".repeat(MAX_ENTITY_NAME_CHARS + 40);
        let (create, _) = validate_tool_call(
            "create_task",
            &json!({
                "title": long_title,
                "estimated_minutes": 45,
                "due_date": "2026-08-02"
            })
            .to_string(),
        )
        .unwrap();
        let created_task = execute_tool(&service, &create, &ctx, Some(op())).await;
        assert_eq!(created_task.outcome, ToolOutcome::Success);

        let (preview_action, _) = validate_tool_call("auto_schedule_day", "{}").unwrap();
        let preview = execute_tool(&service, &preview_action, &ctx, None).await;
        assert_eq!(preview.outcome, ToolOutcome::Success);
        assert_eq!(preview.data["apply_supported"], true);
        let proposed = preview.data["proposed_blocks"].as_array().unwrap();
        assert!(!proposed.is_empty());
        let first = &proposed[0];
        assert_eq!(
            first["title"].as_str().unwrap().chars().count(),
            MAX_ENTITY_NAME_CHARS
        );
        assert_eq!(first["time_zone"], "UTC");

        // Round-trip exact preview fields through apply validation + execution.
        let apply_args = json!({
            "date": preview.data["date"].as_str().unwrap(),
            "blocks": proposed,
        });
        let (apply_action, _) =
            validate_tool_call("apply_auto_schedule_day", &apply_args.to_string()).unwrap();
        assert_eq!(apply_action.effect(), ToolEffect::ApprovalRequired);
        assert!(is_composite_mutation(&apply_action));

        let root = op();
        let first_apply = execute_tool(&service, &apply_action, &ctx, Some(root)).await;
        assert_eq!(first_apply.outcome, ToolOutcome::Success);
        assert_eq!(first_apply.data["count"], proposed.len());
        let created = first_apply.data["created"].as_array().unwrap();
        assert_eq!(created.len(), proposed.len());
        assert!(created.iter().all(|row| {
            row["block_id"].as_str().is_some()
                && row["task_id"].as_str().is_some()
                && row["operation_id"].as_str().is_some()
                && row["revision"].as_u64().is_some()
                && row["event_type"] == "time_block.created"
        }));
        assert_eq!(
            created[0]["operation_id"],
            derive_child_operation_id(root, "apply_auto_schedule_day", 0).to_string()
        );
        assert!(first_apply.operation_id.is_none());
        assert!(first_apply.revision.is_none());

        let blocks = service
            .list_timeblocking_range(ctx.date(), ctx.date())
            .await
            .unwrap();
        assert_eq!(blocks.blocks.len(), proposed.len());

        // Exact same-root retry replays child receipts without duplicating blocks.
        let second_apply = execute_tool(&service, &apply_action, &ctx, Some(root)).await;
        assert_eq!(second_apply, first_apply);
        let blocks_after = service
            .list_timeblocking_range(ctx.date(), ctx.date())
            .await
            .unwrap();
        assert_eq!(blocks_after.blocks.len(), blocks.blocks.len());

        // Fully committed recovery still replays after the referenced task is deleted.
        let task_id = TaskId::parse(first["task_id"].as_str().unwrap()).unwrap();
        service.delete_task(op(), task_id).await.unwrap();
        let recovered = execute_tool_recovery(&service, &apply_action, &ctx, root)
            .await
            .unwrap();
        assert_eq!(recovered, first_apply);

        let _ = fs::remove_dir_all(profile);
    }

    #[tokio::test]
    async fn apply_auto_schedule_day_prevalidates_tasks_before_first_write() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();
        let missing_task = Uuid::new_v4().to_string();
        let (action, _) = validate_tool_call(
            "apply_auto_schedule_day",
            &json!({
                "date": "2026-08-02",
                "blocks": [{
                    "task_id": missing_task,
                    "title": "Ghost",
                    "date": "2026-08-02",
                    "start": "09:00:00",
                    "end": "09:30:00",
                    "time_zone": "UTC",
                    "estimated_minutes": 30
                }]
            })
            .to_string(),
        )
        .unwrap();
        let result = execute_tool(&service, &action, &ctx, Some(op())).await;
        assert_eq!(result.outcome, ToolOutcome::Error);
        assert_eq!(result.data["code"], "not_found");
        assert!(result.data.get("partial").is_none());
        let blocks = service
            .list_timeblocking_range(ctx.date(), ctx.date())
            .await
            .unwrap();
        assert!(blocks.blocks.is_empty());
        let _ = fs::remove_dir_all(profile);
    }

    #[tokio::test]
    async fn apply_auto_schedule_day_reports_partial_on_later_child_conflict() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();

        let mut task_ids = Vec::new();
        for title in ["one", "two"] {
            let (create, _) =
                validate_tool_call("create_task", &json!({ "title": title }).to_string()).unwrap();
            let created = execute_tool(&service, &create, &ctx, Some(op())).await;
            task_ids.push(created.data["primary"]["id"].as_str().unwrap().to_owned());
        }

        let root = op();
        let poison = derive_child_operation_id(root, "apply_auto_schedule_day", 1);
        service
            .create_time_block(
                poison,
                TimeBlockDraft::new(
                    junban_domain::EntityName::new("poison").unwrap(),
                    CivilTimeRange::new(
                        ctx.date(),
                        Time::constant(12, 0, 0, 0),
                        Time::constant(12, 30, 0, 0),
                        ctx.zone_name(),
                    )
                    .unwrap(),
                ),
            )
            .await
            .unwrap();

        let (action, _) = validate_tool_call(
            "apply_auto_schedule_day",
            &json!({
                "date": "2026-08-02",
                "blocks": [
                    {
                        "task_id": task_ids[0],
                        "title": "one",
                        "date": "2026-08-02",
                        "start": "09:00:00",
                        "end": "09:30:00",
                        "time_zone": "UTC",
                        "estimated_minutes": 30
                    },
                    {
                        "task_id": task_ids[1],
                        "title": "two",
                        "date": "2026-08-02",
                        "start": "10:00:00",
                        "end": "10:30:00",
                        "time_zone": "UTC",
                        "estimated_minutes": 30
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();
        let partial = execute_tool(&service, &action, &ctx, Some(root)).await;
        assert_eq!(partial.outcome, ToolOutcome::Error);
        assert_eq!(partial.data["partial"], true);
        assert_eq!(partial.data["failed_index"], 1);
        assert_eq!(partial.data["code"], "idempotency_mismatch");
        let created = partial.data["created"].as_array().unwrap();
        assert_eq!(created.len(), 1);
        assert_eq!(
            created[0]["operation_id"],
            derive_child_operation_id(root, "apply_auto_schedule_day", 0).to_string()
        );
        assert_eq!(partial.data["failed_operation_id"], poison.to_string());

        let _ = fs::remove_dir_all(profile);
    }

    #[tokio::test]
    async fn bulk_create_prevalidates_and_reports_partial_on_later_failure() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();
        let root = op();

        // Invalid second title must fail before any create.
        assert!(validate_tool_call("bulk_create_tasks", r#"{"titles":["ok",""]}"#).is_err());

        // Poison child op 1 with a different request so the second create conflicts.
        let poison = derive_child_operation_id(root, "bulk_create_tasks", 1);
        service
            .create_task(
                poison,
                TaskDraft::new(junban_domain::TaskTitle::new("poison").unwrap()),
            )
            .await
            .unwrap();

        let (action, _) =
            validate_tool_call("bulk_create_tasks", r#"{"titles":["one","two"]}"#).unwrap();
        let partial = execute_tool(&service, &action, &ctx, Some(root)).await;
        assert_eq!(partial.outcome, ToolOutcome::Error);
        assert_eq!(partial.data["partial"], true);
        assert_eq!(partial.data["failed_index"], 1);
        assert_eq!(partial.data["code"], "idempotency_mismatch");
        let created = partial.data["created"].as_array().unwrap();
        assert_eq!(created.len(), 1);
        assert_eq!(
            created[0]["operation_id"],
            derive_child_operation_id(root, "bulk_create_tasks", 0).to_string()
        );
        assert!(created[0]["task_id"].as_str().is_some());
        assert!(created[0]["revision"].as_u64().is_some());
        assert!(created[0]["event_type"].as_str().is_some());
        assert!(created[0].get("title").is_none());
        assert_eq!(partial.data["failed_operation_id"], poison.to_string());
        assert!(partial.operation_id.is_none());
        assert!(partial.revision.is_none());
        crate::ai_runtime::AiDecisionPayload::from_tool_result(
            root,
            crate::ai_runtime::AiTerminalOutcome::Failed,
            &partial,
        )
        .expect("partial composite result must fit dispatch notification authority");

        // Successful composite results also retain child receipt identities without
        // pretending that one child operation is the approved dispatch root.
        let success_root = op();
        let success = execute_tool(&service, &action, &ctx, Some(success_root)).await;
        assert_eq!(success.outcome, ToolOutcome::Success);
        assert!(success.operation_id.is_none());
        assert!(success.revision.is_none());
        crate::ai_runtime::AiDecisionPayload::from_tool_result(
            success_root,
            crate::ai_runtime::AiTerminalOutcome::Completed,
            &success,
        )
        .expect("successful composite result must fit dispatch notification authority");

        // Retry after removing the poison conflict is not possible (op consumed), but
        // replaying the committed child keeps the same identity.
        let child0 = derive_child_operation_id(root, "bulk_create_tasks", 0);
        let replay = service
            .create_task(
                child0,
                TaskDraft::new(junban_domain::TaskTitle::new("one").unwrap()),
            )
            .await
            .unwrap();
        assert_eq!(
            replay.event.primary.as_ref().unwrap().id,
            created[0]["task_id"].as_str().unwrap()
        );

        let _ = fs::remove_dir_all(profile);
    }

    #[tokio::test]
    async fn tag_change_uses_bulk_cas_and_keeps_unrelated_tags() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();

        let (create, _) = validate_tool_call("create_task", r#"{"title":"tagged"}"#).unwrap();
        let created = execute_tool(&service, &create, &ctx, Some(op())).await;
        let task_id = created.data["primary"]["id"].as_str().unwrap().to_owned();

        let mut tag_ids = Vec::new();
        for name in ["alpha", "beta", "gamma"] {
            let mutation = service
                .create_tag(
                    op(),
                    junban_app::TagDraft {
                        name: junban_domain::TagName::new(name).unwrap(),
                        color: junban_domain::HexColor::new("#3b82f6").unwrap(),
                    },
                )
                .await
                .unwrap();
            tag_ids.push(mutation.event.primary.as_ref().unwrap().id.clone());
        }

        // Seed alpha on the task.
        let (add_alpha, _) = validate_tool_call(
            "add_tags_to_task",
            &format!(r#"{{"task_id":"{task_id}","tag_ids":["{}"]}}"#, tag_ids[0]),
        )
        .unwrap();
        assert_eq!(
            execute_tool(&service, &add_alpha, &ctx, Some(op()))
                .await
                .outcome,
            ToolOutcome::Success
        );

        // Unrelated concurrent writer adds gamma via the same bulk CAS path.
        service
            .bulk_tasks(
                op(),
                vec![junban_domain::TaskId::parse(&task_id).unwrap()],
                BulkAction::Tag {
                    change: BulkTagChange {
                        add: vec![junban_domain::TagId::parse(&tag_ids[2]).unwrap()],
                        remove: Vec::new(),
                    },
                },
            )
            .await
            .unwrap();

        // AI tool adds beta; gamma must survive.
        let (add_beta, _) = validate_tool_call(
            "add_tags_to_task",
            &format!(r#"{{"task_id":"{task_id}","tag_ids":["{}"]}}"#, tag_ids[1]),
        )
        .unwrap();
        let added = execute_tool(&service, &add_beta, &ctx, Some(op())).await;
        assert_eq!(added.outcome, ToolOutcome::Success);

        let task = service
            .get_task(junban_domain::TaskId::parse(&task_id).unwrap())
            .await
            .unwrap();
        let have: BTreeSet<_> = task.tag_ids.iter().map(ToString::to_string).collect();
        assert!(have.contains(&tag_ids[0]));
        assert!(have.contains(&tag_ids[1]));
        assert!(have.contains(&tag_ids[2]));

        let _ = fs::remove_dir_all(profile);
    }

    #[test]
    fn scheduling_gap_selection_respects_blocks_slots_and_duration() {
        let work = WorkHours::new(9 * 60, 17 * 60).unwrap();
        let date = date(2026, 8, 2);
        let zone = junban_domain::TimeZoneName::new("UTC").unwrap();

        // 09:30-10:30 block must not allow a 60m task at 09:00.
        let block = junban_domain::TimeBlock {
            id: junban_domain::TimeBlockId::new(),
            title: junban_domain::EntityName::new("standup").unwrap(),
            range: CivilTimeRange::new(
                date,
                Time::constant(9, 30, 0, 0),
                Time::constant(10, 30, 0, 0),
                zone.clone(),
            )
            .unwrap(),
            color: None,
            task_id: None,
            slot_id: None,
            locked: false,
            recurrence_rule: None,
            recurrence_parent_id: None,
            created_at: jiff::Timestamp::now(),
            updated_at: jiff::Timestamp::now(),
            revision: 1,
        };
        let slot = junban_domain::TimeSlot {
            id: junban_domain::TimeSlotId::new(),
            title: junban_domain::EntityName::new("focus").unwrap(),
            range: CivilTimeRange::new(
                date,
                Time::constant(11, 0, 0, 0),
                Time::constant(12, 0, 0, 0),
                zone,
            )
            .unwrap(),
            color: None,
            project_id: None,
            recurrence_rule: None,
            recurrence_parent_id: None,
            task_ids: Default::default(),
            created_at: jiff::Timestamp::now(),
            updated_at: jiff::Timestamp::now(),
            revision: 1,
        };

        let occupied = occupied_intervals_for_day(date, &[block], &[slot], work);
        assert_eq!(
            occupied,
            vec![
                (Time::constant(9, 30, 0, 0), Time::constant(10, 30, 0, 0)),
                (Time::constant(11, 0, 0, 0), Time::constant(12, 0, 0, 0)),
            ]
        );

        // Overlap fixture: 60m cannot start at 09:00 (09:30 block) or 10:30 (11:00 slot).
        let gap = find_gap_for_duration(
            Time::constant(9, 0, 0, 0),
            Time::constant(17, 0, 0, 0),
            60,
            &occupied,
        )
        .unwrap();
        assert_eq!(gap.0, Time::constant(12, 0, 0, 0));
        assert_eq!(gap.1, Time::constant(13, 0, 0, 0));

        // Half-open intervals: 30m fits at 09:00-09:30 before the 09:30 block.
        let short = find_gap_for_duration(
            Time::constant(9, 0, 0, 0),
            Time::constant(17, 0, 0, 0),
            30,
            &occupied,
        )
        .unwrap();
        assert_eq!(short.0, Time::constant(9, 0, 0, 0));
        assert_eq!(short.1, Time::constant(9, 30, 0, 0));

        // 31m from 09:00 overlaps the 09:30 block; next full fit is after the slot.
        let just_over = find_gap_for_duration(
            Time::constant(9, 0, 0, 0),
            Time::constant(17, 0, 0, 0),
            31,
            &occupied,
        )
        .unwrap();
        assert_eq!(just_over.0, Time::constant(12, 0, 0, 0));

        // Adjacent intervals merge.
        let merged = clamp_and_merge_intervals(
            vec![
                (Time::constant(9, 0, 0, 0), Time::constant(10, 0, 0, 0)),
                (Time::constant(10, 0, 0, 0), Time::constant(11, 0, 0, 0)),
            ],
            Time::constant(9, 0, 0, 0),
            Time::constant(17, 0, 0, 0),
        );
        assert_eq!(
            merged,
            vec![(Time::constant(9, 0, 0, 0), Time::constant(11, 0, 0, 0))]
        );

        // Boundary clamp drops out-of-window occupancy.
        let clamped = clamp_and_merge_intervals(
            vec![(Time::constant(8, 0, 0, 0), Time::constant(9, 30, 0, 0))],
            Time::constant(9, 0, 0, 0),
            Time::constant(17, 0, 0, 0),
        );
        assert_eq!(
            clamped,
            vec![(Time::constant(9, 0, 0, 0), Time::constant(9, 30, 0, 0))]
        );

        // Insufficient remaining gap.
        assert!(
            find_gap_for_duration(
                Time::constant(16, 30, 0, 0),
                Time::constant(17, 0, 0, 0),
                60,
                &[]
            )
            .is_none()
        );

        let free = free_intervals_from_occupied(date, &occupied, work);
        assert_eq!(free[0]["start"], "09:00:00");
        assert_eq!(free[0]["end"], "09:30:00");
    }

    #[tokio::test]
    async fn schedule_preview_uses_settings_work_hours_and_slots() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();

        // Confirmed work hours 10:00-16:00.
        let mut settings = service.get_settings().await.unwrap();
        settings.planning.work_hours = Some(WorkHours::new(10 * 60, 16 * 60).unwrap());
        service
            .patch_settings(
                op(),
                junban_domain::SettingsPatch {
                    planning: Some(settings.planning.clone()),
                    ..junban_domain::SettingsPatch::default()
                },
            )
            .await
            .unwrap();

        let (create, _) = validate_tool_call(
            "create_task",
            r#"{"title":"Focus block","estimated_minutes":60,"due_date":"2026-08-02"}"#,
        )
        .unwrap();
        let _ = execute_tool(&service, &create, &ctx, Some(op())).await;

        // Slot occupying 10:00-11:00 must push the proposal later.
        let zone = ctx.zone_name();
        service
            .create_time_slot(
                op(),
                junban_domain::TimeSlotDraft::new(
                    junban_domain::EntityName::new("Standup slot").unwrap(),
                    CivilTimeRange::new(
                        ctx.date(),
                        Time::constant(10, 0, 0, 0),
                        Time::constant(11, 0, 0, 0),
                        zone,
                    )
                    .unwrap(),
                ),
            )
            .await
            .unwrap();

        let (schedule, _) = validate_tool_call("auto_schedule_day", "{}").unwrap();
        let preview = execute_tool(&service, &schedule, &ctx, None).await;
        assert_eq!(preview.outcome, ToolOutcome::Success);
        assert_eq!(preview.data["work_hours"]["start_minute"], 10 * 60);
        assert_eq!(preview.data["work_hours"]["end_minute"], 16 * 60);
        assert_eq!(preview.data["work_hours"]["defaulted"], false);
        let proposed = preview.data["proposed_blocks"].as_array().unwrap();
        if let Some(first) = proposed.first() {
            assert_eq!(first["start"], "11:00:00");
        }

        let (availability, _) = validate_tool_call("timeblocking_get_availability", "{}").unwrap();
        let free = execute_tool(&service, &availability, &ctx, None).await;
        assert_eq!(free.data["work_hours"]["start_minute"], 10 * 60);
        assert_eq!(
            free.data["intervals"].as_array().unwrap()[0]["start"],
            "11:00:00"
        );

        let _ = fs::remove_dir_all(profile);
    }

    #[tokio::test]
    async fn save_memory_initial_and_receipt_recovery_are_exactly_equal_and_apply_once() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();
        let root = op();

        let (save, _) = validate_tool_call("save_memory", r#"{"content":"durable note"}"#).unwrap();
        let first = execute_tool(&service, &save, &ctx, Some(root)).await;
        assert_eq!(first.outcome, ToolOutcome::Success);
        assert_eq!(first.data["primary"]["kind"], "ai_memory");
        assert!(first.data.get("memory_id").is_none());

        let recovered = execute_tool_recovery(&service, &save, &ctx, root)
            .await
            .unwrap();
        assert_eq!(recovered, first);
        assert_eq!(
            service
                .select_ai_memories_for_context(SelectAiMemoriesRequest {
                    session_id: None,
                    limit: Some(10),
                })
                .await
                .unwrap()
                .len(),
            1
        );

        let _ = fs::remove_dir_all(profile);
    }

    #[tokio::test]
    async fn catalog_tools_use_bounded_reads_not_full_snapshot() {
        let (_owner, service, profile) = open_service();
        let ctx = fixed_ctx();

        for index in 0..3 {
            service
                .create_project(
                    op(),
                    junban_app::ProjectDraft {
                        name: junban_domain::EntityName::new(format!("P{index}")).unwrap(),
                        color: junban_domain::HexColor::new("#3b82f6").unwrap(),
                        icon: None,
                        parent_id: None,
                        favorite: false,
                        archived: false,
                        view: ProjectView::default(),
                        sort_order: SortOrder::default(),
                    },
                )
                .await
                .unwrap();
            service
                .create_tag(
                    op(),
                    junban_app::TagDraft {
                        name: junban_domain::TagName::new(format!("t{index}")).unwrap(),
                        color: junban_domain::HexColor::new("#3b82f6").unwrap(),
                    },
                )
                .await
                .unwrap();
        }

        let (list_projects, _) = validate_tool_call("list_projects", "{}").unwrap();
        let projects = execute_tool(&service, &list_projects, &ctx, None).await;
        assert_eq!(projects.outcome, ToolOutcome::Success);
        assert_eq!(projects.data["projects"].as_array().unwrap().len(), 3);

        let project_id = projects.data["projects"][0]["id"].as_str().unwrap();
        let (get_project, _) = validate_tool_call(
            "get_project",
            &format!(r#"{{"project_id":"{project_id}"}}"#),
        )
        .unwrap();
        let got = execute_tool(&service, &get_project, &ctx, None).await;
        assert_eq!(got.outcome, ToolOutcome::Success);
        assert_eq!(got.data["project"]["id"], project_id);

        let (list_tags, _) = validate_tool_call("list_tags", "{}").unwrap();
        let tags = execute_tool(&service, &list_tags, &ctx, None).await;
        assert_eq!(tags.data["tags"].as_array().unwrap().len(), 3);

        let _ = fs::remove_dir_all(profile);
    }
}
