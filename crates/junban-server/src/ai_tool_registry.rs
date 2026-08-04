//! Authoritative Rust-owned AI tool registry, validation, and result envelope.
//!
//! Wave 3f freezes the advertised tool names, strict JSON argument validation,
//! effect classification, and the trusted structured result model. Provider
//! orchestration, approvals, routes, and UI are intentionally layered elsewhere.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::LazyLock;

use jiff::{
    Timestamp,
    civil::{Date, Time},
};
use junban_ai::{MAX_TOOL_ARGUMENTS_BYTES, ToolSpec};
use junban_domain::{
    AI_CONTEXT_MEMORIES_MAX, AI_MEMORY_BYTES_MAX, AI_TOOL_RESULT_BYTES_MAX, AiMemoryId,
    AiSessionId, DreadLevel, EntityName, EstimatedMinutes, HexColor, LocalDueTime, MAX_BULK_IDS,
    MAX_ENTITY_NAME_CHARS, MAX_MARKDOWN_CHARS, MAX_QUERY_PAGE_LIMIT, MAX_RECURRENCE_RULE_CHARS,
    MAX_TAG_NAME_CHARS, MAX_TAGS_PER_TASK, MAX_TASK_TITLE_CHARS, MAX_TIMEZONE_NAME_CHARS,
    MarkdownText, Priority, ProjectId, RecurrenceRule, TagId, TagName, TaskId, TaskTitle,
    TimeBlockId, TimeZoneName, ValidationError,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// Frozen advertised tool inventory size.
pub const AI_TOOL_COUNT: usize = 49;
/// Maximum exact blocks accepted by `apply_auto_schedule_day`.
pub const AI_TOOL_AUTO_SCHEDULE_BLOCKS_MAX: usize = 16;
/// Maximum UTF-8 bytes accepted for one tool name.
pub const AI_TOOL_NAME_MAX_BYTES: usize = 64;
/// Maximum entities retained in one tool result payload before truncation.
pub const AI_TOOL_RESULT_ENTITY_MAX: usize = 500;
/// Conservative ceiling for composite task-creation actions whose exact manifest must fit chat.
pub const AI_TOOL_COMPOSITE_CREATE_MAX: usize = 100;
/// Default accent used when a create-project/create-tag tool omits color.
pub const AI_TOOL_DEFAULT_COLOR: &str = "#3b82f6";

const ONE_CALL_PER_ROUND: &str =
    " Exactly one tool call is accepted per round; do not emit multiple calls.";

/// Effect class used by approval gating (wired in a later subwave).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolEffect {
    /// May execute without a user approval.
    Read,
    /// Requires an explicit user approval before executor dispatch.
    ApprovalRequired,
}

/// Trusted structured tool outcome. Never carries receipts, tokens, or raw errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolOutcome {
    Success,
    Error,
    Unavailable,
}

/// Bounded, trusted tool result returned to higher layers (not raw provider frames).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ToolResultEnvelope {
    pub tool: String,
    pub outcome: ToolOutcome,
    pub data: Value,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
}

impl ToolResultEnvelope {
    #[must_use]
    pub fn success(tool: &str, data: Value) -> Self {
        Self {
            tool: tool.to_owned(),
            outcome: ToolOutcome::Success,
            data,
            truncated: false,
            operation_id: None,
            revision: None,
        }
    }

    #[must_use]
    pub fn error(tool: &str, code: &str, message: &str) -> Self {
        Self {
            tool: tool.to_owned(),
            outcome: ToolOutcome::Error,
            data: json!({ "code": code, "message": message }),
            truncated: false,
            operation_id: None,
            revision: None,
        }
    }

    #[must_use]
    pub fn unavailable(tool: &str, message: &str) -> Self {
        Self {
            tool: tool.to_owned(),
            outcome: ToolOutcome::Unavailable,
            data: json!({ "code": "unavailable", "message": message }),
            truncated: false,
            operation_id: None,
            revision: None,
        }
    }

    #[must_use]
    pub fn with_mutation_meta(
        mut self,
        operation_id: junban_domain::OperationId,
        revision: u64,
    ) -> Self {
        self.operation_id = Some(operation_id.to_string());
        self.revision = Some(revision);
        self
    }

    /// Serialize to canonical JSON, truncating entity arrays first when needed.
    pub fn finalize_bounded(mut self) -> Self {
        let (data, truncated) = bound_result_data(self.data);
        self.data = data;
        self.truncated = self.truncated || truncated;
        match serde_json::to_vec(&self) {
            Ok(bytes) if bytes.len() <= AI_TOOL_RESULT_BYTES_MAX => self,
            Ok(_) | Err(_) => Self::error(
                &self.tool,
                "result_too_large",
                "tool result exceeds the 256 KiB bound after truncation",
            ),
        }
    }
}

/// Strict validation failure for model-supplied tool calls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolValidationError {
    pub code: &'static str,
    pub message: &'static str,
}

impl ToolValidationError {
    pub(crate) const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

impl fmt::Display for ToolValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ToolValidationError {}

/// One validated, exhaustive tool action after strict argument parsing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidatedToolAction {
    CreateTask(CreateTaskArgs),
    UpdateTask(UpdateTaskArgs),
    CompleteTask(CompleteTaskArgs),
    DeleteTask(DeleteTaskArgs),
    QueryTasks(QueryTasksArgs),
    BreakDownTask(BreakDownTaskArgs),
    ExtractTasksFromText(ExtractTasksFromTextArgs),
    BulkCreateTasks(BulkCreateTasksArgs),
    BulkCompleteTasks(BulkCompleteTasksArgs),
    BulkUpdateTasks(BulkUpdateTasksArgs),
    FindSimilarTasks(FindSimilarTasksArgs),
    CheckDuplicates(CheckDuplicatesArgs),
    CreateProject(CreateProjectArgs),
    ListProjects(EmptyArgs),
    GetProject(GetProjectArgs),
    UpdateProject(UpdateProjectArgs),
    DeleteProject(DeleteProjectArgs),
    ListTags(EmptyArgs),
    AddTagsToTask(AddTagsToTaskArgs),
    RemoveTagsFromTask(RemoveTagsFromTaskArgs),
    ListReminders(ListRemindersArgs),
    SetReminder(SetReminderArgs),
    SnoozeReminder(SnoozeReminderArgs),
    DismissReminder(DismissReminderArgs),
    AnalyzeCompletionPatterns(AnalyzeRangeArgs),
    CheckOvercommitment(OptionalDateArgs),
    AnalyzeWorkload(OptionalDateArgs),
    GetEnergyRecommendations(OptionalDateArgs),
    GetProductivityStats(AnalyzeRangeArgs),
    EstimateTaskDuration(EstimateTaskDurationArgs),
    TimeTrackingSummary(AnalyzeRangeArgs),
    SuggestTags(SuggestTagsArgs),
    PlanMyDay(OptionalDateArgs),
    DailyReview(OptionalDateArgs),
    WeeklyReview(OptionalDateArgs),
    SaveMemory(SaveMemoryArgs),
    RecallMemories(RecallMemoriesArgs),
    ForgetMemory(ForgetMemoryArgs),
    AutoScheduleDay(OptionalDateArgs),
    ApplyAutoScheduleDay(ApplyAutoScheduleDayArgs),
    RescheduleDay(OptionalDateArgs),
    TimeblockingListBlocks(TimeblockingRangeArgs),
    TimeblockingCreateBlock(TimeblockingCreateBlockArgs),
    TimeblockingUpdateBlock(TimeblockingUpdateBlockArgs),
    TimeblockingDeleteBlock(TimeblockingDeleteBlockArgs),
    TimeblockingScheduleTask(TimeblockingScheduleTaskArgs),
    TimeblockingGetAvailability(OptionalDateArgs),
    TimeblockingSetRecurrence(TimeblockingSetRecurrenceArgs),
    TimeblockingReplanDay(TimeblockingReplanDayArgs),
}

impl ValidatedToolAction {
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::CreateTask(_) => "create_task",
            Self::UpdateTask(_) => "update_task",
            Self::CompleteTask(_) => "complete_task",
            Self::DeleteTask(_) => "delete_task",
            Self::QueryTasks(_) => "query_tasks",
            Self::BreakDownTask(_) => "break_down_task",
            Self::ExtractTasksFromText(_) => "extract_tasks_from_text",
            Self::BulkCreateTasks(_) => "bulk_create_tasks",
            Self::BulkCompleteTasks(_) => "bulk_complete_tasks",
            Self::BulkUpdateTasks(_) => "bulk_update_tasks",
            Self::FindSimilarTasks(_) => "find_similar_tasks",
            Self::CheckDuplicates(_) => "check_duplicates",
            Self::CreateProject(_) => "create_project",
            Self::ListProjects(_) => "list_projects",
            Self::GetProject(_) => "get_project",
            Self::UpdateProject(_) => "update_project",
            Self::DeleteProject(_) => "delete_project",
            Self::ListTags(_) => "list_tags",
            Self::AddTagsToTask(_) => "add_tags_to_task",
            Self::RemoveTagsFromTask(_) => "remove_tags_from_task",
            Self::ListReminders(_) => "list_reminders",
            Self::SetReminder(_) => "set_reminder",
            Self::SnoozeReminder(_) => "snooze_reminder",
            Self::DismissReminder(_) => "dismiss_reminder",
            Self::AnalyzeCompletionPatterns(_) => "analyze_completion_patterns",
            Self::CheckOvercommitment(_) => "check_overcommitment",
            Self::AnalyzeWorkload(_) => "analyze_workload",
            Self::GetEnergyRecommendations(_) => "get_energy_recommendations",
            Self::GetProductivityStats(_) => "get_productivity_stats",
            Self::EstimateTaskDuration(_) => "estimate_task_duration",
            Self::TimeTrackingSummary(_) => "time_tracking_summary",
            Self::SuggestTags(_) => "suggest_tags",
            Self::PlanMyDay(_) => "plan_my_day",
            Self::DailyReview(_) => "daily_review",
            Self::WeeklyReview(_) => "weekly_review",
            Self::SaveMemory(_) => "save_memory",
            Self::RecallMemories(_) => "recall_memories",
            Self::ForgetMemory(_) => "forget_memory",
            Self::AutoScheduleDay(_) => "auto_schedule_day",
            Self::ApplyAutoScheduleDay(_) => "apply_auto_schedule_day",
            Self::RescheduleDay(_) => "reschedule_day",
            Self::TimeblockingListBlocks(_) => "timeblocking_list_blocks",
            Self::TimeblockingCreateBlock(_) => "timeblocking_create_block",
            Self::TimeblockingUpdateBlock(_) => "timeblocking_update_block",
            Self::TimeblockingDeleteBlock(_) => "timeblocking_delete_block",
            Self::TimeblockingScheduleTask(_) => "timeblocking_schedule_task",
            Self::TimeblockingGetAvailability(_) => "timeblocking_get_availability",
            Self::TimeblockingSetRecurrence(_) => "timeblocking_set_recurrence",
            Self::TimeblockingReplanDay(_) => "timeblocking_replan_day",
        }
    }

    #[must_use]
    pub fn effect(&self) -> ToolEffect {
        match self {
            Self::QueryTasks(_)
            | Self::FindSimilarTasks(_)
            | Self::CheckDuplicates(_)
            | Self::ListProjects(_)
            | Self::GetProject(_)
            | Self::ListTags(_)
            | Self::ListReminders(_)
            | Self::AnalyzeCompletionPatterns(_)
            | Self::CheckOvercommitment(_)
            | Self::AnalyzeWorkload(_)
            | Self::GetEnergyRecommendations(_)
            | Self::GetProductivityStats(_)
            | Self::EstimateTaskDuration(_)
            | Self::TimeTrackingSummary(_)
            | Self::SuggestTags(_)
            | Self::PlanMyDay(_)
            | Self::DailyReview(_)
            | Self::WeeklyReview(_)
            | Self::RecallMemories(_)
            | Self::AutoScheduleDay(_)
            | Self::RescheduleDay(_)
            | Self::TimeblockingListBlocks(_)
            | Self::TimeblockingGetAvailability(_) => ToolEffect::Read,
            Self::ExtractTasksFromText(args) if args.dry_run => ToolEffect::Read,
            Self::CreateTask(_)
            | Self::UpdateTask(_)
            | Self::CompleteTask(_)
            | Self::DeleteTask(_)
            | Self::BreakDownTask(_)
            | Self::ExtractTasksFromText(_)
            | Self::BulkCreateTasks(_)
            | Self::BulkCompleteTasks(_)
            | Self::BulkUpdateTasks(_)
            | Self::CreateProject(_)
            | Self::UpdateProject(_)
            | Self::DeleteProject(_)
            | Self::AddTagsToTask(_)
            | Self::RemoveTagsFromTask(_)
            | Self::SetReminder(_)
            | Self::SnoozeReminder(_)
            | Self::DismissReminder(_)
            | Self::SaveMemory(_)
            | Self::ForgetMemory(_)
            | Self::ApplyAutoScheduleDay(_)
            | Self::TimeblockingCreateBlock(_)
            | Self::TimeblockingUpdateBlock(_)
            | Self::TimeblockingDeleteBlock(_)
            | Self::TimeblockingScheduleTask(_)
            | Self::TimeblockingSetRecurrence(_)
            | Self::TimeblockingReplanDay(_) => ToolEffect::ApprovalRequired,
        }
    }
}

// ── Argument DTOs (deny unknown fields) ─────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyArgs {}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateTaskArgs {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub due_time: Option<String>,
    #[serde(default)]
    pub estimated_minutes: Option<u32>,
    #[serde(default)]
    pub dread: Option<u8>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub someday: Option<bool>,
    #[serde(default)]
    pub recurrence_rule: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateTaskArgs {
    pub task_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Option<Option<u8>>,
    #[serde(default)]
    pub due_date: Option<Option<String>>,
    #[serde(default)]
    pub due_time: Option<Option<String>>,
    #[serde(default)]
    pub estimated_minutes: Option<Option<u32>>,
    #[serde(default)]
    pub dread: Option<Option<u8>>,
    #[serde(default)]
    pub project_id: Option<Option<String>>,
    #[serde(default)]
    pub parent_id: Option<Option<String>>,
    #[serde(default)]
    pub tag_ids: Option<Vec<String>>,
    #[serde(default)]
    pub someday: Option<bool>,
    #[serde(default)]
    pub recurrence_rule: Option<Option<String>>,
    #[serde(default)]
    pub clear_reminder: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompleteTaskArgs {
    pub task_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteTaskArgs {
    pub task_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryTasksArgs {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BreakDownTaskArgs {
    pub task_id: String,
    pub subtasks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExtractTasksFromTextArgs {
    pub text: String,
    #[serde(default = "default_true")]
    pub dry_run: bool,
    #[serde(default)]
    pub project_id: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BulkCreateTasksArgs {
    pub titles: Vec<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BulkCompleteTasksArgs {
    pub task_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BulkUpdateTasksArgs {
    pub task_ids: Vec<String>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub priority: Option<Option<u8>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub due_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub due_time: Option<Option<String>>,
    #[serde(default)]
    pub someday: Option<bool>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub project_id: Option<Option<String>>,
    #[serde(default)]
    pub add_tag_ids: Vec<String>,
    #[serde(default)]
    pub remove_tag_ids: Vec<String>,
}

/// Serde helper: missing → None, null → Some(None), value → Some(Some(value)).
mod double_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Ok(Some(Option::<T>::deserialize(deserializer)?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FindSimilarTasksArgs {
    pub title: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckDuplicatesArgs {
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateProjectArgs {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub favorite: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GetProjectArgs {
    pub project_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateProjectArgs {
    pub project_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub favorite: Option<bool>,
    #[serde(default)]
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteProjectArgs {
    pub project_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AddTagsToTaskArgs {
    pub task_id: String,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub tag_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoveTagsFromTaskArgs {
    pub task_id: String,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub tag_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListRemindersArgs {
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetReminderArgs {
    pub task_id: String,
    pub remind_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnoozeReminderArgs {
    pub task_id: String,
    pub remind_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DismissReminderArgs {
    pub task_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnalyzeRangeArgs {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptionalDateArgs {
    #[serde(default)]
    pub date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyAutoScheduleDayArgs {
    pub date: String,
    pub blocks: Vec<ApplyAutoScheduleBlockArgs>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyAutoScheduleBlockArgs {
    pub task_id: String,
    pub title: String,
    pub date: String,
    pub start: String,
    pub end: String,
    pub time_zone: String,
    pub estimated_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EstimateTaskDurationArgs {
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SuggestTagsArgs {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveMemoryArgs {
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecallMemoriesArgs {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ForgetMemoryArgs {
    pub memory_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeblockingRangeArgs {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeblockingCreateBlockArgs {
    pub title: String,
    pub date: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub recurrence_rule: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeblockingUpdateBlockArgs {
    pub block_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub color: Option<Option<String>>,
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub task_id: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeblockingDeleteBlockArgs {
    pub block_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeblockingScheduleTaskArgs {
    pub task_id: String,
    pub date: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeblockingSetRecurrenceArgs {
    pub block_id: String,
    pub recurrence_rule: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeblockingReplanDayArgs {
    pub action: String,
}

/// Static registry entry metadata used by tests and classification tables.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolRegistration {
    pub name: &'static str,
    /// Static default effect. Dynamic tools recompute from validated args.
    pub default_effect: ToolEffect,
    pub dynamic_effect: bool,
}

/// Deterministic ordered inventory of the advertised tool names.
#[must_use]
pub fn tool_registrations() -> &'static [ToolRegistration; AI_TOOL_COUNT] {
    &TOOL_REGISTRATIONS
}

/// Provider-advertised tool specs (`junban_ai::ToolSpec`) for the frozen inventory.
#[must_use]
pub fn tool_specs() -> &'static [ToolSpec] {
    &TOOL_SPECS
}

/// Lookup one registration by exact name.
#[must_use]
pub fn registration(name: &str) -> Option<&'static ToolRegistration> {
    TOOL_REGISTRATIONS.iter().find(|entry| entry.name == name)
}

/// Parse and strictly validate one model tool call into a typed action.
pub fn validate_tool_call(
    name: &str,
    arguments_json: &str,
) -> Result<(ValidatedToolAction, String), ToolValidationError> {
    if name.is_empty() || name.len() > AI_TOOL_NAME_MAX_BYTES {
        return Err(ToolValidationError::new(
            "invalid_tool_name",
            "tool name must be 1..=64 bytes",
        ));
    }
    if registration(name).is_none() {
        return Err(ToolValidationError::new(
            "unknown_tool",
            "tool name is not in the allowlist",
        ));
    }
    if arguments_json.len() > MAX_TOOL_ARGUMENTS_BYTES {
        return Err(ToolValidationError::new(
            "arguments_too_large",
            "tool arguments exceed the 128 KiB bound",
        ));
    }
    let value = parse_strict_json_object(arguments_json)?;
    reject_forbidden_value(&value)?;
    reject_control_chars(&value)?;
    let canonical = canonicalize_json(&value);
    if canonical.len() > MAX_TOOL_ARGUMENTS_BYTES {
        return Err(ToolValidationError::new(
            "arguments_too_large",
            "canonical tool arguments exceed the 128 KiB bound",
        ));
    }
    let action = deserialize_action(name, &value)?;
    validate_action_semantics(&action)?;
    Ok((action, canonical))
}

/// Exhaustive domain/limit validation before any action is considered validated.
fn validate_action_semantics(action: &ValidatedToolAction) -> Result<(), ToolValidationError> {
    match action {
        ValidatedToolAction::CreateTask(args) => {
            parse_title(&args.title)?;
            if let Some(description) = &args.description {
                parse_description(description)?;
            }
            if let Some(priority) = args.priority {
                parse_priority(priority)?;
            }
            if let Some(due_date) = &args.due_date {
                parse_date(due_date)?;
            }
            if let Some(due_time) = &args.due_time {
                parse_time(due_time)?;
            }
            if let Some(minutes) = args.estimated_minutes {
                parse_estimated_minutes(minutes)?;
            }
            if let Some(dread) = args.dread {
                parse_dread(dread)?;
            }
            if let Some(project_id) = &args.project_id {
                parse_project_id(project_id)?;
            }
            if let Some(parent_id) = &args.parent_id {
                parse_task_id(parent_id)?;
            }
            parse_tag_ids(&args.tag_ids)?;
            if let Some(rule) = &args.recurrence_rule {
                parse_recurrence(rule)?;
            }
        }
        ValidatedToolAction::UpdateTask(args) => {
            parse_task_id(&args.task_id)?;
            if let Some(title) = &args.title {
                parse_title(title)?;
            }
            if let Some(description) = &args.description {
                parse_description(description)?;
            }
            if let Some(Some(priority)) = args.priority {
                parse_priority(priority)?;
            }
            if let Some(Some(due_date)) = &args.due_date {
                parse_date(due_date)?;
            }
            if let Some(Some(due_time)) = &args.due_time {
                parse_time(due_time)?;
            }
            if let Some(Some(minutes)) = args.estimated_minutes {
                parse_estimated_minutes(minutes)?;
            }
            if let Some(Some(dread)) = args.dread {
                parse_dread(dread)?;
            }
            if let Some(Some(project_id)) = &args.project_id {
                parse_project_id(project_id)?;
            }
            if let Some(Some(parent_id)) = &args.parent_id {
                parse_task_id(parent_id)?;
            }
            if let Some(tag_ids) = &args.tag_ids {
                parse_tag_ids(tag_ids)?;
            }
            if let Some(Some(rule)) = &args.recurrence_rule {
                parse_recurrence(rule)?;
            }
        }
        ValidatedToolAction::CompleteTask(args) => {
            parse_task_id(&args.task_id)?;
        }
        ValidatedToolAction::DeleteTask(args) => {
            parse_task_id(&args.task_id)?;
        }
        ValidatedToolAction::QueryTasks(args) => {
            if let Some(project_id) = &args.project_id {
                parse_project_id(project_id)?;
            }
            if let Some(status) = &args.status {
                match status.as_str() {
                    "pending" | "completed" | "cancelled" => {}
                    _ => {
                        return Err(ToolValidationError::new(
                            "invalid_status",
                            "status must be pending|completed|cancelled",
                        ));
                    }
                }
            }
            validate_optional_limit(args.limit, MAX_QUERY_PAGE_LIMIT, "limit")?;
        }
        ValidatedToolAction::BreakDownTask(args) => {
            parse_task_id(&args.task_id)?;
            validate_composite_title_list(&args.subtasks, "subtasks")?;
        }
        ValidatedToolAction::ExtractTasksFromText(args) => {
            if args.text.chars().count() > MAX_MARKDOWN_CHARS {
                return Err(ToolValidationError::new(
                    "invalid_text",
                    "text exceeds the bound",
                ));
            }
            if let Some(project_id) = &args.project_id {
                parse_project_id(project_id)?;
            }
            if !args.dry_run {
                let titles = extract_task_titles_from_text(&args.text);
                validate_composite_title_list(&titles, "titles")?;
            }
        }
        ValidatedToolAction::BulkCreateTasks(args) => {
            validate_composite_title_list(&args.titles, "titles")?;
            if let Some(project_id) = &args.project_id {
                parse_project_id(project_id)?;
            }
            if let Some(due_date) = &args.due_date {
                parse_date(due_date)?;
            }
        }
        ValidatedToolAction::BulkCompleteTasks(args) => {
            parse_task_ids(&args.task_ids)?;
        }
        ValidatedToolAction::BulkUpdateTasks(args) => {
            validate_bulk_update_tasks_args(args)?;
        }
        ValidatedToolAction::FindSimilarTasks(args) => {
            parse_title(&args.title)?;
            validate_optional_limit(args.limit, MAX_QUERY_PAGE_LIMIT, "limit")?;
        }
        ValidatedToolAction::CheckDuplicates(args) => {
            parse_title(&args.title)?;
        }
        ValidatedToolAction::CreateProject(args) => {
            parse_entity_name(&args.name)?;
            if let Some(color) = &args.color {
                parse_color(color)?;
            }
        }
        ValidatedToolAction::GetProject(args) => {
            parse_project_id(&args.project_id)?;
        }
        ValidatedToolAction::DeleteProject(args) => {
            parse_project_id(&args.project_id)?;
        }
        ValidatedToolAction::UpdateProject(args) => {
            parse_project_id(&args.project_id)?;
            if let Some(name) = &args.name {
                parse_entity_name(name)?;
            }
            if let Some(color) = &args.color {
                parse_color(color)?;
            }
        }
        ValidatedToolAction::AddTagsToTask(args) => {
            parse_task_id(&args.task_id)?;
            parse_tag_ids(&args.tag_ids)?;
            validate_tag_names(&args.tag_names)?;
            if args.tag_ids.is_empty() && args.tag_names.is_empty() {
                return Err(ToolValidationError::new(
                    "missing_tags",
                    "at least one tag is required",
                ));
            }
        }
        ValidatedToolAction::RemoveTagsFromTask(args) => {
            parse_task_id(&args.task_id)?;
            parse_tag_ids(&args.tag_ids)?;
            validate_tag_names(&args.tag_names)?;
            if args.tag_ids.is_empty() && args.tag_names.is_empty() {
                return Err(ToolValidationError::new(
                    "missing_tags",
                    "at least one tag is required",
                ));
            }
        }
        ValidatedToolAction::ListReminders(args) => {
            if let Some(task_id) = &args.task_id {
                parse_task_id(task_id)?;
            }
            validate_optional_limit(args.limit, MAX_QUERY_PAGE_LIMIT, "limit")?;
        }
        ValidatedToolAction::SetReminder(args) => {
            parse_task_id(&args.task_id)?;
            parse_timestamp(&args.remind_at)?;
        }
        ValidatedToolAction::SnoozeReminder(args) => {
            parse_task_id(&args.task_id)?;
            parse_timestamp(&args.remind_at)?;
        }
        ValidatedToolAction::DismissReminder(args) => {
            parse_task_id(&args.task_id)?;
        }
        ValidatedToolAction::AnalyzeCompletionPatterns(args)
        | ValidatedToolAction::GetProductivityStats(args)
        | ValidatedToolAction::TimeTrackingSummary(args) => {
            validate_optional_date_range(&args.from, &args.to)?;
        }
        ValidatedToolAction::CheckOvercommitment(args)
        | ValidatedToolAction::AnalyzeWorkload(args)
        | ValidatedToolAction::GetEnergyRecommendations(args)
        | ValidatedToolAction::PlanMyDay(args)
        | ValidatedToolAction::DailyReview(args)
        | ValidatedToolAction::WeeklyReview(args)
        | ValidatedToolAction::AutoScheduleDay(args)
        | ValidatedToolAction::RescheduleDay(args)
        | ValidatedToolAction::TimeblockingGetAvailability(args) => {
            if let Some(date) = &args.date {
                parse_date(date)?;
            }
        }
        ValidatedToolAction::ApplyAutoScheduleDay(args) => {
            validate_apply_auto_schedule_day_args(args)?;
        }
        ValidatedToolAction::EstimateTaskDuration(args) => {
            if let Some(task_id) = &args.task_id {
                parse_task_id(task_id)?;
            }
            if let Some(title) = &args.title {
                parse_title(title)?;
            }
        }
        ValidatedToolAction::SuggestTags(args) => {
            parse_title(&args.title)?;
            if let Some(description) = &args.description {
                parse_description(description)?;
            }
            validate_optional_limit(args.limit, 20, "limit")?;
        }
        ValidatedToolAction::SaveMemory(args) => {
            if args.content.is_empty() || args.content.len() > AI_MEMORY_BYTES_MAX {
                return Err(ToolValidationError::new(
                    "invalid_content",
                    "memory content must be 1..=10000 bytes",
                ));
            }
        }
        ValidatedToolAction::RecallMemories(args) => {
            if let Some(session_id) = &args.session_id {
                parse_session_id(session_id)?;
            }
            validate_optional_limit(args.limit, AI_CONTEXT_MEMORIES_MAX, "limit")?;
        }
        ValidatedToolAction::ForgetMemory(args) => {
            parse_memory_id(&args.memory_id)?;
        }
        ValidatedToolAction::TimeblockingListBlocks(args) => {
            validate_optional_date_range(&args.from, &args.to)?;
        }
        ValidatedToolAction::TimeblockingCreateBlock(args) => {
            parse_entity_name(&args.title)?;
            let date = parse_date(&args.date)?;
            let start = parse_time(&args.start)?;
            let end = parse_time(&args.end)?;
            if end <= start {
                return Err(ToolValidationError::new(
                    "invalid_range",
                    "end must be after start on the same date",
                ));
            }
            let _ = date;
            if let Some(zone) = &args.time_zone {
                parse_time_zone(zone)?;
            }
            if let Some(task_id) = &args.task_id {
                parse_task_id(task_id)?;
            }
            if let Some(color) = &args.color {
                parse_color(color)?;
            }
            if let Some(rule) = &args.recurrence_rule {
                parse_recurrence(rule)?;
            }
        }
        ValidatedToolAction::TimeblockingUpdateBlock(args) => {
            parse_block_id(&args.block_id)?;
            if let Some(title) = &args.title {
                parse_entity_name(title)?;
            }
            if let Some(date) = &args.date {
                parse_date(date)?;
            }
            let start = args.start.as_deref().map(parse_time).transpose()?;
            let end = args.end.as_deref().map(parse_time).transpose()?;
            if let (Some(start), Some(end)) = (start, end)
                && end <= start
            {
                return Err(ToolValidationError::new(
                    "invalid_range",
                    "end must be after start on the same date",
                ));
            }
            if let Some(zone) = &args.time_zone {
                parse_time_zone(zone)?;
            }
            if let Some(Some(color)) = &args.color {
                parse_color(color)?;
            }
            if let Some(Some(task_id)) = &args.task_id {
                parse_task_id(task_id)?;
            }
        }
        ValidatedToolAction::TimeblockingDeleteBlock(args) => {
            parse_block_id(&args.block_id)?;
        }
        ValidatedToolAction::TimeblockingScheduleTask(args) => {
            parse_task_id(&args.task_id)?;
            parse_date(&args.date)?;
            let start = parse_time(&args.start)?;
            let end = parse_time(&args.end)?;
            if end <= start {
                return Err(ToolValidationError::new(
                    "invalid_range",
                    "end must be after start on the same date",
                ));
            }
            if let Some(zone) = &args.time_zone {
                parse_time_zone(zone)?;
            }
            if let Some(title) = &args.title {
                parse_entity_name(title)?;
            }
        }
        ValidatedToolAction::TimeblockingSetRecurrence(args) => {
            parse_block_id(&args.block_id)?;
            parse_recurrence(&args.recurrence_rule)?;
        }
        ValidatedToolAction::TimeblockingReplanDay(args) => match args.action.as_str() {
            "move_to_today" | "move_to_tomorrow" | "delete" => {}
            _ => {
                return Err(ToolValidationError::new(
                    "invalid_action",
                    "action must be move_to_today|move_to_tomorrow|delete",
                ));
            }
        },
        ValidatedToolAction::ListProjects(_) | ValidatedToolAction::ListTags(_) => {}
    }
    Ok(())
}

fn validate_optional_limit(
    limit: Option<u32>,
    max: u32,
    field: &'static str,
) -> Result<(), ToolValidationError> {
    let Some(limit) = limit else {
        return Ok(());
    };
    if limit == 0 || limit > max {
        return Err(ToolValidationError::new(
            "invalid_limit",
            match field {
                "limit" => "limit must be within the advertised bounds",
                _ => "limit must be within the advertised bounds",
            },
        ));
    }
    Ok(())
}

fn validate_optional_date_range(
    from: &Option<String>,
    to: &Option<String>,
) -> Result<(), ToolValidationError> {
    let from = from.as_deref().map(parse_date).transpose()?;
    let to = to.as_deref().map(parse_date).transpose()?;
    if let (Some(from), Some(to)) = (from, to)
        && from > to
    {
        return Err(ToolValidationError::new(
            "invalid_range",
            "from must be on or before to",
        ));
    }
    Ok(())
}

fn validate_apply_auto_schedule_day_args(
    args: &ApplyAutoScheduleDayArgs,
) -> Result<(), ToolValidationError> {
    let apply_date = parse_date(&args.date)?;
    if args.blocks.is_empty() || args.blocks.len() > AI_TOOL_AUTO_SCHEDULE_BLOCKS_MAX {
        return Err(ToolValidationError::new(
            "invalid_blocks",
            "blocks must contain 1..=16 entries",
        ));
    }
    let mut seen_tasks = BTreeSet::new();
    for block in &args.blocks {
        let task_id = parse_task_id(&block.task_id)?;
        if !seen_tasks.insert(task_id.to_string()) {
            return Err(ToolValidationError::new(
                "duplicate_task_id",
                "blocks must reference unique task_id values",
            ));
        }
        parse_entity_name(&block.title)?;
        let block_date = parse_date(&block.date)?;
        if block_date != apply_date {
            return Err(ToolValidationError::new(
                "date_mismatch",
                "each block date must equal the apply date",
            ));
        }
        let start = parse_time(&block.start)?;
        let end = parse_time(&block.end)?;
        if end <= start {
            return Err(ToolValidationError::new(
                "invalid_range",
                "end must be after start on the same date",
            ));
        }
        parse_time_zone(&block.time_zone)?;
        if !(15..=240).contains(&block.estimated_minutes) {
            return Err(ToolValidationError::new(
                "invalid_estimated_minutes",
                "estimated_minutes must be 15..=240",
            ));
        }
    }
    Ok(())
}

/// Reject bulk_update_tasks args that the executor would refuse after classification.
fn validate_bulk_update_tasks_args(args: &BulkUpdateTasksArgs) -> Result<(), ToolValidationError> {
    parse_task_ids(&args.task_ids)?;
    if let Some(Some(priority)) = args.priority {
        parse_priority(priority)?;
    }
    if let Some(Some(due_date)) = &args.due_date {
        parse_date(due_date)?;
    }
    if let Some(Some(due_time)) = &args.due_time {
        parse_time(due_time)?;
    }
    if let Some(Some(project_id)) = &args.project_id {
        parse_project_id(project_id)?;
    }
    parse_tag_ids(&args.add_tag_ids)?;
    parse_tag_ids(&args.remove_tag_ids)?;

    let has_tags = !args.add_tag_ids.is_empty() || !args.remove_tag_ids.is_empty();
    let has_project = args.project_id.is_some();
    let has_priority = args.priority.is_some();
    let has_schedule = args.due_date.is_some() || args.due_time.is_some() || args.someday.is_some();

    if has_tags {
        if has_priority || has_schedule || has_project {
            return Err(ToolValidationError::new(
                "conflicting_update",
                "tag changes cannot be combined with other bulk fields in one call",
            ));
        }
        return Ok(());
    }
    if has_project {
        if has_priority || has_schedule {
            return Err(ToolValidationError::new(
                "conflicting_update",
                "project move cannot be combined with other bulk fields in one call",
            ));
        }
        return Ok(());
    }
    if has_priority && !has_schedule {
        return Ok(());
    }
    if has_schedule {
        if has_priority {
            return Err(ToolValidationError::new(
                "conflicting_update",
                "priority cannot be combined with schedule fields in one call",
            ));
        }
        return Ok(());
    }
    Err(ToolValidationError::new(
        "missing_update",
        "bulk_update_tasks requires one update field group",
    ))
}

fn validate_composite_title_list(
    titles: &[String],
    field: &'static str,
) -> Result<(), ToolValidationError> {
    if titles.is_empty() || titles.len() > AI_TOOL_COMPOSITE_CREATE_MAX {
        return Err(ToolValidationError::new(
            if field == "subtasks" {
                "invalid_subtasks"
            } else {
                "invalid_titles"
            },
            if field == "subtasks" {
                "subtasks must contain 1..=100 titles"
            } else {
                "titles must contain 1..=100 entries"
            },
        ));
    }
    for title in titles {
        parse_title(title)?;
    }
    Ok(())
}

fn validate_tag_names(names: &[String]) -> Result<(), ToolValidationError> {
    if names.len() > MAX_TAGS_PER_TASK {
        return Err(ToolValidationError::new(
            "too_many_ids",
            "tag_names exceeds the per-task tag ceiling",
        ));
    }
    let mut seen = BTreeSet::new();
    for name in names {
        let parsed = parse_tag_name(name)?;
        if !seen.insert(parsed.as_str().to_ascii_lowercase()) {
            return Err(ToolValidationError::new(
                "duplicate_tag_name",
                "tag_names must be unique",
            ));
        }
    }
    Ok(())
}

/// Names that must never appear in model-supplied tool arguments.
pub fn forbidden_argument_names() -> &'static [&'static str] {
    &FORBIDDEN_ARGUMENT_NAMES
}

// ── Domain conversion helpers used by the executor ──────────────────────────

pub(crate) fn parse_task_id(raw: &str) -> Result<TaskId, ToolValidationError> {
    TaskId::parse(raw)
        .map_err(|_| ToolValidationError::new("invalid_task_id", "task_id must be a UUID"))
}

pub(crate) fn parse_project_id(raw: &str) -> Result<ProjectId, ToolValidationError> {
    ProjectId::parse(raw)
        .map_err(|_| ToolValidationError::new("invalid_project_id", "project_id must be a UUID"))
}

pub(crate) fn parse_tag_id(raw: &str) -> Result<TagId, ToolValidationError> {
    TagId::parse(raw)
        .map_err(|_| ToolValidationError::new("invalid_tag_id", "tag_id must be a UUID"))
}

pub(crate) fn parse_block_id(raw: &str) -> Result<TimeBlockId, ToolValidationError> {
    TimeBlockId::parse(raw)
        .map_err(|_| ToolValidationError::new("invalid_block_id", "block_id must be a UUID"))
}

pub(crate) fn parse_memory_id(raw: &str) -> Result<AiMemoryId, ToolValidationError> {
    AiMemoryId::parse(raw)
        .map_err(|_| ToolValidationError::new("invalid_memory_id", "memory_id must be a UUID"))
}

pub(crate) fn parse_session_id(raw: &str) -> Result<AiSessionId, ToolValidationError> {
    AiSessionId::parse(raw)
        .map_err(|_| ToolValidationError::new("invalid_session_id", "session_id must be a UUID"))
}

pub(crate) fn parse_date(raw: &str) -> Result<Date, ToolValidationError> {
    raw.parse::<Date>()
        .map_err(|_| ToolValidationError::new("invalid_date", "date must be YYYY-MM-DD"))
}

pub(crate) fn parse_time(raw: &str) -> Result<Time, ToolValidationError> {
    raw.parse::<Time>()
        .map_err(|_| ToolValidationError::new("invalid_time", "time must be HH:MM[:SS]"))
}

pub(crate) fn parse_timestamp(raw: &str) -> Result<Timestamp, ToolValidationError> {
    raw.parse::<Timestamp>().map_err(|_| {
        ToolValidationError::new("invalid_timestamp", "timestamp must be an RFC 3339 instant")
    })
}

pub(crate) fn parse_priority(value: u8) -> Result<Priority, ToolValidationError> {
    Priority::new(value)
        .map_err(|_| ToolValidationError::new("invalid_priority", "priority must be 1..=4"))
}

pub(crate) fn parse_dread(value: u8) -> Result<DreadLevel, ToolValidationError> {
    DreadLevel::new(value)
        .map_err(|_| ToolValidationError::new("invalid_dread", "dread must be 1..=5"))
}

pub(crate) fn parse_estimated_minutes(value: u32) -> Result<EstimatedMinutes, ToolValidationError> {
    EstimatedMinutes::new(value).map_err(|_| {
        ToolValidationError::new(
            "invalid_estimated_minutes",
            "estimated_minutes must be >= 1",
        )
    })
}

pub(crate) fn parse_title(raw: &str) -> Result<TaskTitle, ToolValidationError> {
    TaskTitle::new(raw).map_err(|error| match error {
        ValidationError::EmptyTitle => {
            ToolValidationError::new("invalid_title", "title must not be empty")
        }
        _ => ToolValidationError::new("invalid_title", "title is invalid"),
    })
}

pub(crate) fn parse_description(raw: &str) -> Result<MarkdownText, ToolValidationError> {
    MarkdownText::new(raw).map_err(|_| {
        ToolValidationError::new("invalid_description", "description exceeds the bound")
    })
}

pub(crate) fn parse_entity_name(raw: &str) -> Result<EntityName, ToolValidationError> {
    EntityName::new(raw).map_err(|_| {
        ToolValidationError::new("invalid_name", "name must be a non-empty bounded string")
    })
}

pub(crate) fn parse_tag_name(raw: &str) -> Result<TagName, ToolValidationError> {
    TagName::new(raw).map_err(|_| {
        ToolValidationError::new("invalid_tag_name", "tag name must be non-empty and bounded")
    })
}

pub(crate) fn parse_color(raw: &str) -> Result<HexColor, ToolValidationError> {
    HexColor::new(raw)
        .map_err(|_| ToolValidationError::new("invalid_color", "color must be a #RRGGBB hex value"))
}

pub(crate) fn parse_recurrence(raw: &str) -> Result<RecurrenceRule, ToolValidationError> {
    RecurrenceRule::new(raw).map_err(|_| {
        ToolValidationError::new("invalid_recurrence_rule", "recurrence_rule is invalid")
    })
}

pub(crate) fn parse_due_time(
    raw: &str,
    time_zone: TimeZoneName,
) -> Result<LocalDueTime, ToolValidationError> {
    let time = parse_time(raw)?;
    Ok(LocalDueTime::new(time, time_zone))
}

pub(crate) fn parse_time_zone(raw: &str) -> Result<TimeZoneName, ToolValidationError> {
    TimeZoneName::new(raw).map_err(|_| {
        ToolValidationError::new("invalid_time_zone", "time_zone must be an IANA name")
    })
}

pub(crate) fn parse_task_ids(raw: &[String]) -> Result<Vec<TaskId>, ToolValidationError> {
    if raw.len() > MAX_BULK_IDS {
        return Err(ToolValidationError::new(
            "too_many_ids",
            "task_ids exceeds the bulk ceiling",
        ));
    }
    if raw.is_empty() {
        return Err(ToolValidationError::new(
            "empty_task_ids",
            "task_ids must not be empty",
        ));
    }
    let mut ids = Vec::with_capacity(raw.len());
    let mut seen = BTreeSet::new();
    for value in raw {
        let id = parse_task_id(value)?;
        if !seen.insert(id) {
            return Err(ToolValidationError::new(
                "duplicate_task_id",
                "task_ids must be unique",
            ));
        }
        ids.push(id);
    }
    Ok(ids)
}

pub(crate) fn parse_tag_ids(raw: &[String]) -> Result<Vec<TagId>, ToolValidationError> {
    if raw.len() > MAX_TAGS_PER_TASK {
        return Err(ToolValidationError::new(
            "too_many_ids",
            "tag_ids exceeds the per-task tag ceiling",
        ));
    }
    let mut ids = Vec::with_capacity(raw.len());
    let mut seen = BTreeSet::new();
    for value in raw {
        let id = parse_tag_id(value)?;
        if !seen.insert(id) {
            return Err(ToolValidationError::new(
                "duplicate_tag_id",
                "tag_ids must be unique",
            ));
        }
        ids.push(id);
    }
    Ok(ids)
}

/// Deterministic line/bullet extraction used by `extract_tasks_from_text`.
#[must_use]
pub fn extract_task_titles_from_text(text: &str) -> Vec<String> {
    let mut titles = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let without_bullet = strip_list_prefix(trimmed);
        let title = without_bullet.trim();
        if title.is_empty() || title.chars().count() > MAX_TASK_TITLE_CHARS {
            continue;
        }
        if titles.len() >= MAX_BULK_IDS {
            break;
        }
        titles.push(title.to_owned());
    }
    titles
}

fn strip_list_prefix(line: &str) -> &str {
    let trimmed = line.trim_start();
    for prefix in ["- ", "* ", "• ", "+ "] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return rest;
        }
    }
    let bytes = trimmed.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i > 0 {
        if trimmed[i..].starts_with(". ") {
            return &trimmed[i + 2..];
        }
        if trimmed[i..].starts_with(") ") {
            return &trimmed[i + 2..];
        }
    }
    trimmed
}

// ── Internal parsing / schema construction ──────────────────────────────────

const FORBIDDEN_ARGUMENT_NAMES: [&str; 28] = [
    "operation_id",
    "approval_id",
    "dispatch_operation_id",
    "revision",
    "access_token",
    "token",
    "credential",
    "credentials",
    "secret",
    "password",
    "authorization",
    "url",
    "href",
    "path",
    "file_path",
    "filepath",
    "preview_hash",
    "apply_hash",
    "action_hash",
    "preview_authority",
    "apply_authority",
    "receipt",
    "receipt_id",
    "request_id",
    "idempotency_key",
    "provider_id",
    "vendor_id",
    "api_key",
];

static TOOL_REGISTRATIONS: [ToolRegistration; AI_TOOL_COUNT] = [
    ToolRegistration {
        name: "create_task",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "update_task",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "complete_task",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "delete_task",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "query_tasks",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "break_down_task",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "extract_tasks_from_text",
        default_effect: ToolEffect::Read,
        dynamic_effect: true,
    },
    ToolRegistration {
        name: "bulk_create_tasks",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "bulk_complete_tasks",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "bulk_update_tasks",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "find_similar_tasks",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "check_duplicates",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "create_project",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "list_projects",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "get_project",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "update_project",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "delete_project",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "list_tags",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "add_tags_to_task",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "remove_tags_from_task",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "list_reminders",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "set_reminder",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "snooze_reminder",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "dismiss_reminder",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "analyze_completion_patterns",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "check_overcommitment",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "analyze_workload",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "get_energy_recommendations",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "get_productivity_stats",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "estimate_task_duration",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "time_tracking_summary",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "suggest_tags",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "plan_my_day",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "daily_review",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "weekly_review",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "save_memory",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "recall_memories",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "forget_memory",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "auto_schedule_day",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "apply_auto_schedule_day",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "reschedule_day",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "timeblocking_list_blocks",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "timeblocking_create_block",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "timeblocking_update_block",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "timeblocking_delete_block",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "timeblocking_schedule_task",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "timeblocking_get_availability",
        default_effect: ToolEffect::Read,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "timeblocking_set_recurrence",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
    ToolRegistration {
        name: "timeblocking_replan_day",
        default_effect: ToolEffect::ApprovalRequired,
        dynamic_effect: false,
    },
];

static TOOL_SPECS: LazyLock<Vec<ToolSpec>> = LazyLock::new(build_tool_specs);

fn build_tool_specs() -> Vec<ToolSpec> {
    TOOL_REGISTRATIONS
        .iter()
        .map(|entry| ToolSpec {
            name: entry.name.to_owned(),
            description: tool_description(entry.name).to_owned(),
            parameters: tool_parameters(entry.name),
        })
        .collect()
}

fn tool_description(name: &str) -> String {
    let base = match name {
        "create_task" => "Create one task with validated fields.",
        "update_task" => "Update fields on one existing task.",
        "complete_task" => "Mark one task completed.",
        "delete_task" => "Delete one task.",
        "query_tasks" => "Query tasks with an optional filter string and bounds.",
        "break_down_task" => "Create bounded child subtasks under one parent task.",
        "extract_tasks_from_text" => {
            "Deterministically extract task titles from text. dry_run defaults true (preview only)."
        }
        "bulk_create_tasks" => "Create multiple tasks from titles in one approved action.",
        "bulk_complete_tasks" => "Complete multiple tasks in one approved bulk action.",
        "bulk_update_tasks" => {
            "Apply exactly one bounded bulk field-update group to multiple tasks. Groups: tag changes (add_tag_ids and/or remove_tag_ids), project_id, priority alone, or schedule fields (due_date/due_time/someday). Groups cannot be combined."
        }
        "find_similar_tasks" => "Find tasks with similar titles using local comparison.",
        "check_duplicates" => "Check for duplicate or near-duplicate task titles.",
        "create_project" => "Create one project.",
        "list_projects" => "List projects from the catalog snapshot.",
        "get_project" => "Get one project by exact ID lookup.",
        "update_project" => "Update one project.",
        "delete_project" => "Delete one project.",
        "list_tags" => "List tags from the catalog snapshot.",
        "add_tags_to_task" => "Add existing tags to one task. Does not create tags.",
        "remove_tags_from_task" => "Remove tags from one task.",
        "list_reminders" => "List reminder schedules for one task or a bounded task set.",
        "set_reminder" => "Set or replace one task reminder instant.",
        "snooze_reminder" => "Snooze one task reminder to a new instant.",
        "dismiss_reminder" => "Dismiss one task reminder.",
        "analyze_completion_patterns" => {
            "Local analysis of completion patterns over a bounded date range."
        }
        "check_overcommitment" => "Compare planned estimate load against daily capacity.",
        "analyze_workload" => "Local workload summary for pending work.",
        "get_energy_recommendations" => {
            "Local energy-oriented task recommendations (frog/jar/menu)."
        }
        "get_productivity_stats" => "Local productivity stats for a bounded date range.",
        "estimate_task_duration" => "Estimate duration from similar local completed tasks.",
        "time_tracking_summary" => "Summarize tracked actual minutes over a date range.",
        "suggest_tags" => "Suggest existing catalog tags for a title/description.",
        "plan_my_day" => "Return the Plan My Day summary for a civil date.",
        "daily_review" => "Return the end-of-day review for a civil date.",
        "weekly_review" => "Return the weekly review for a civil date.",
        "save_memory" => "Save one explicit content-only memory.",
        "recall_memories" => "Recall up to 50 explicit memories for context.",
        "forget_memory" => "Delete one explicit memory.",
        "auto_schedule_day" => "Preview a deterministic day schedule only. Does not apply changes.",
        "apply_auto_schedule_day" => {
            "Apply exact approved auto-schedule blocks by creating one time block per entry. Does not recompute the schedule."
        }
        "reschedule_day" => "Preview a deterministic reschedule plan only. Does not apply changes.",
        "timeblocking_list_blocks" => "List time blocks and slots in a civil date range.",
        "timeblocking_create_block" => "Create one time block.",
        "timeblocking_update_block" => "Update one time block.",
        "timeblocking_delete_block" => "Delete one time block.",
        "timeblocking_schedule_task" => "Schedule one task into a new time block.",
        "timeblocking_get_availability" => "Compute free civil intervals for one date.",
        "timeblocking_set_recurrence" => "Set recurrence metadata on one time block.",
        "timeblocking_replan_day" => {
            "Apply automatic replan of unlocked past blocks using server-owned candidates."
        }
        _ => "Junban tool.",
    };
    format!("{base}{ONE_CALL_PER_ROUND}")
}

fn tool_parameters(name: &str) -> Value {
    match name {
        "create_task" => object(
            json!({
                "title": string_prop("Task title", MAX_TASK_TITLE_CHARS),
                "description": string_prop("Optional description", MAX_MARKDOWN_CHARS),
                "priority": int_prop("Priority 1..=4", 1, 4),
                "due_date": string_prop("Due date YYYY-MM-DD", 10),
                "due_time": string_prop("Due time HH:MM[:SS]", 16),
                "estimated_minutes": int_prop("Positive estimate minutes", 1, 100_000),
                "dread": int_prop("Dread 1..=5", 1, 5),
                "project_id": uuid_prop("Project ID"),
                "parent_id": uuid_prop("Parent task ID"),
                "tag_ids": uuid_array_prop("Existing tag IDs", MAX_TAGS_PER_TASK),
                "someday": bool_prop("Someday flag"),
                "recurrence_rule": string_prop("Recurrence rule", MAX_RECURRENCE_RULE_CHARS),
            }),
            &["title"],
        ),
        "update_task" => object(
            json!({
                "task_id": uuid_prop("Task ID"),
                "title": string_prop("New title", MAX_TASK_TITLE_CHARS),
                "description": string_prop("New description", MAX_MARKDOWN_CHARS),
                "priority": nullable_int_prop("Priority 1..=4 or null to clear", 1, 4),
                "due_date": nullable_string_prop("Due date or null to clear", 10),
                "due_time": nullable_string_prop("Due time or null to clear", 16),
                "estimated_minutes": nullable_int_prop("Estimate or null to clear", 1, 100_000),
                "dread": nullable_int_prop("Dread or null to clear", 1, 5),
                "project_id": nullable_uuid_prop("Project ID or null to clear"),
                "parent_id": nullable_uuid_prop("Parent task ID or null to clear"),
                "tag_ids": uuid_array_prop("Replacement tag IDs", MAX_TAGS_PER_TASK),
                "someday": bool_prop("Someday flag"),
                "recurrence_rule": nullable_string_prop("Recurrence or null to clear", MAX_RECURRENCE_RULE_CHARS),
                "clear_reminder": bool_prop("When true, clears remind_at"),
            }),
            &["task_id"],
        ),
        "complete_task" | "delete_task" => {
            object(json!({ "task_id": uuid_prop("Task ID") }), &["task_id"])
        }
        "query_tasks" => object(
            json!({
                "query": string_prop("Optional filter string", 10_000),
                "project_id": uuid_prop("Optional project filter"),
                "status": string_enum_prop("Status filter", &["pending", "completed", "cancelled"]),
                "limit": int_prop("Page limit", 1, i64::from(MAX_QUERY_PAGE_LIMIT)),
            }),
            &[],
        ),
        "break_down_task" => object(
            json!({
                "task_id": uuid_prop("Parent task ID"),
                "subtasks": {
                    "type": "array",
                    "description": "Child task titles",
                    "minItems": 1,
                    "maxItems": AI_TOOL_COMPOSITE_CREATE_MAX,
                    "items": string_prop("Subtask title", MAX_TASK_TITLE_CHARS),
                }
            }),
            &["task_id", "subtasks"],
        ),
        "extract_tasks_from_text" => object(
            json!({
                "text": string_prop("Source text", MAX_MARKDOWN_CHARS),
                "dry_run": bool_prop("When true (default), preview only"),
                "project_id": uuid_prop("Optional project for apply"),
            }),
            &["text"],
        ),
        "bulk_create_tasks" => object(
            json!({
                "titles": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": AI_TOOL_COMPOSITE_CREATE_MAX,
                    "items": string_prop("Task title", MAX_TASK_TITLE_CHARS),
                },
                "project_id": uuid_prop("Optional shared project"),
                "due_date": string_prop("Optional shared due date", 10),
            }),
            &["titles"],
        ),
        "bulk_complete_tasks" => object(
            json!({
                "task_ids": uuid_array_prop("Task IDs", MAX_BULK_IDS),
            }),
            &["task_ids"],
        ),
        "bulk_update_tasks" => object(
            json!({
                "task_ids": uuid_array_prop_min(
                    "Task IDs (1..=500 unique)",
                    1,
                    MAX_BULK_IDS
                ),
                "priority": nullable_int_prop(
                    "Priority-only group: set priority or null. Mutually exclusive with tags, project_id, and schedule fields",
                    1,
                    4
                ),
                "due_date": nullable_string_prop(
                    "Schedule group field: due date or null. Combine only with due_time/someday",
                    10
                ),
                "due_time": nullable_string_prop(
                    "Schedule group field: due time or null. Combine only with due_date/someday",
                    16
                ),
                "someday": bool_prop(
                    "Schedule group field: someday flag. Combine only with due_date/due_time"
                ),
                "project_id": nullable_uuid_prop(
                    "Project-move group: project id or null. Mutually exclusive with other groups"
                ),
                "add_tag_ids": uuid_array_prop(
                    "Tag group: tag IDs to add. May combine with remove_tag_ids only",
                    MAX_TAGS_PER_TASK
                ),
                "remove_tag_ids": uuid_array_prop(
                    "Tag group: tag IDs to remove. May combine with add_tag_ids only",
                    MAX_TAGS_PER_TASK
                ),
            }),
            &["task_ids"],
        ),
        "find_similar_tasks" => object(
            json!({
                "title": string_prop("Reference title", MAX_TASK_TITLE_CHARS),
                "limit": int_prop("Max matches", 1, i64::from(MAX_QUERY_PAGE_LIMIT)),
            }),
            &["title"],
        ),
        "check_duplicates" => object(
            json!({ "title": string_prop("Title to check", MAX_TASK_TITLE_CHARS) }),
            &["title"],
        ),
        "create_project" => object(
            json!({
                "name": string_prop("Project name", MAX_ENTITY_NAME_CHARS),
                "color": string_prop("Optional #RRGGBB color", 7),
                "favorite": bool_prop("Favorite flag"),
            }),
            &["name"],
        ),
        "list_projects" | "list_tags" => empty_object(),
        "get_project" | "delete_project" => object(
            json!({ "project_id": uuid_prop("Project ID") }),
            &["project_id"],
        ),
        "update_project" => object(
            json!({
                "project_id": uuid_prop("Project ID"),
                "name": string_prop("New name", MAX_ENTITY_NAME_CHARS),
                "color": string_prop("New color", 7),
                "favorite": bool_prop("Favorite flag"),
                "archived": bool_prop("Archived flag"),
            }),
            &["project_id"],
        ),
        "add_tags_to_task" | "remove_tags_from_task" => object(
            json!({
                "task_id": uuid_prop("Task ID"),
                "tag_ids": uuid_array_prop("Existing tag IDs", MAX_TAGS_PER_TASK),
                "tag_names": {
                    "type": "array",
                    "maxItems": MAX_TAGS_PER_TASK,
                    "items": string_prop("Existing tag name", MAX_TAG_NAME_CHARS),
                }
            }),
            &["task_id"],
        ),
        "list_reminders" => object(
            json!({
                "task_id": uuid_prop("Optional task filter"),
                "limit": int_prop("Max reminders", 1, i64::from(MAX_QUERY_PAGE_LIMIT)),
            }),
            &[],
        ),
        "set_reminder" | "snooze_reminder" => object(
            json!({
                "task_id": uuid_prop("Task ID"),
                "remind_at": string_prop("RFC 3339 instant", 40),
            }),
            &["task_id", "remind_at"],
        ),
        "dismiss_reminder" => object(json!({ "task_id": uuid_prop("Task ID") }), &["task_id"]),
        "analyze_completion_patterns" | "get_productivity_stats" | "time_tracking_summary" => {
            object(
                json!({
                    "from": string_prop("Range start YYYY-MM-DD", 10),
                    "to": string_prop("Range end YYYY-MM-DD", 10),
                }),
                &[],
            )
        }
        "check_overcommitment"
        | "analyze_workload"
        | "get_energy_recommendations"
        | "plan_my_day"
        | "daily_review"
        | "weekly_review"
        | "auto_schedule_day"
        | "reschedule_day"
        | "timeblocking_get_availability" => object(
            json!({ "date": string_prop("Civil date YYYY-MM-DD", 10) }),
            &[],
        ),
        "estimate_task_duration" => object(
            json!({
                "task_id": uuid_prop("Optional existing task"),
                "title": string_prop("Optional title", MAX_TASK_TITLE_CHARS),
            }),
            &[],
        ),
        "suggest_tags" => object(
            json!({
                "title": string_prop("Task title", MAX_TASK_TITLE_CHARS),
                "description": string_prop("Optional description", MAX_MARKDOWN_CHARS),
                "limit": int_prop("Max suggestions", 1, 20),
            }),
            &["title"],
        ),
        "save_memory" => object(
            json!({ "content": string_prop("Memory content only", AI_MEMORY_BYTES_MAX) }),
            &["content"],
        ),
        "recall_memories" => object(
            json!({
                "session_id": uuid_prop("Optional session for linked-first selection"),
                "limit": int_prop(
                    "Max memories",
                    1,
                    i64::from(AI_CONTEXT_MEMORIES_MAX),
                ),
            }),
            &[],
        ),
        "forget_memory" => object(
            json!({ "memory_id": uuid_prop("Memory ID") }),
            &["memory_id"],
        ),
        "apply_auto_schedule_day" => object(
            json!({
                "date": string_prop("Civil date YYYY-MM-DD", 10),
                "blocks": {
                    "type": "array",
                    "description": "Exact approved blocks to create",
                    "minItems": 1,
                    "maxItems": AI_TOOL_AUTO_SCHEDULE_BLOCKS_MAX,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                            "task_id": uuid_prop("Task ID"),
                            "title": string_prop("Block title", MAX_ENTITY_NAME_CHARS),
                            "date": string_prop("Civil date YYYY-MM-DD", 10),
                            "start": string_prop("Start time", 16),
                            "end": string_prop("End time", 16),
                            "time_zone": string_prop("IANA time zone", MAX_TIMEZONE_NAME_CHARS),
                            "estimated_minutes": int_prop("Duration minutes", 15, 240),
                        },
                        "required": [
                            "task_id",
                            "title",
                            "date",
                            "start",
                            "end",
                            "time_zone",
                            "estimated_minutes"
                        ],
                    }
                }
            }),
            &["date", "blocks"],
        ),
        "timeblocking_list_blocks" => object(
            json!({
                "from": string_prop("Range start YYYY-MM-DD", 10),
                "to": string_prop("Range end YYYY-MM-DD", 10),
            }),
            &[],
        ),
        "timeblocking_create_block" => object(
            json!({
                "title": string_prop("Block title", MAX_ENTITY_NAME_CHARS),
                "date": string_prop("Civil date", 10),
                "start": string_prop("Start time", 16),
                "end": string_prop("End time", 16),
                "time_zone": string_prop("IANA time zone", MAX_TIMEZONE_NAME_CHARS),
                "task_id": uuid_prop("Optional linked task"),
                "color": string_prop("Optional color", 7),
                "locked": bool_prop("Locked flag"),
                "recurrence_rule": string_prop("Optional recurrence", MAX_RECURRENCE_RULE_CHARS),
            }),
            &["title", "date", "start", "end"],
        ),
        "timeblocking_update_block" => object(
            json!({
                "block_id": uuid_prop("Block ID"),
                "title": string_prop("New title", MAX_ENTITY_NAME_CHARS),
                "date": string_prop("New date", 10),
                "start": string_prop("New start", 16),
                "end": string_prop("New end", 16),
                "time_zone": string_prop("IANA time zone", MAX_TIMEZONE_NAME_CHARS),
                "color": nullable_string_prop("Color or null", 7),
                "locked": bool_prop("Locked flag"),
                "task_id": nullable_uuid_prop("Task or null"),
            }),
            &["block_id"],
        ),
        "timeblocking_delete_block" => {
            object(json!({ "block_id": uuid_prop("Block ID") }), &["block_id"])
        }
        "timeblocking_schedule_task" => object(
            json!({
                "task_id": uuid_prop("Task ID"),
                "date": string_prop("Civil date", 10),
                "start": string_prop("Start time", 16),
                "end": string_prop("End time", 16),
                "time_zone": string_prop("IANA time zone", MAX_TIMEZONE_NAME_CHARS),
                "title": string_prop("Optional block title", MAX_ENTITY_NAME_CHARS),
            }),
            &["task_id", "date", "start", "end"],
        ),
        "timeblocking_set_recurrence" => object(
            json!({
                "block_id": uuid_prop("Block ID"),
                "recurrence_rule": string_prop("Recurrence rule", MAX_RECURRENCE_RULE_CHARS),
            }),
            &["block_id", "recurrence_rule"],
        ),
        "timeblocking_replan_day" => object(
            json!({
                "action": string_enum_prop(
                    "Replan action",
                    &["move_to_today", "move_to_tomorrow", "delete"],
                ),
            }),
            &["action"],
        ),
        _ => empty_object(),
    }
}

fn empty_object() -> Value {
    object(json!({}), &[])
}

fn object(properties: Value, required: &[&str]) -> Value {
    let mut schema = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": properties,
    });
    if !required.is_empty() {
        schema["required"] = Value::Array(
            required
                .iter()
                .map(|name| Value::String((*name).to_owned()))
                .collect(),
        );
    }
    schema
}

fn string_prop(description: &str, max_length: usize) -> Value {
    json!({
        "type": "string",
        "description": description,
        "minLength": 1,
        "maxLength": max_length,
    })
}

fn nullable_string_prop(description: &str, max_length: usize) -> Value {
    json!({
        "description": description,
        "anyOf": [
            { "type": "string", "minLength": 1, "maxLength": max_length },
            { "type": "null" }
        ]
    })
}

fn uuid_prop(description: &str) -> Value {
    json!({
        "type": "string",
        "description": description,
        "minLength": 36,
        "maxLength": 36,
    })
}

fn nullable_uuid_prop(description: &str) -> Value {
    json!({
        "description": description,
        "anyOf": [
            { "type": "string", "minLength": 36, "maxLength": 36 },
            { "type": "null" }
        ]
    })
}

fn bool_prop(description: &str) -> Value {
    json!({ "type": "boolean", "description": description })
}

fn int_prop(description: &str, min: i64, max: i64) -> Value {
    json!({
        "type": "integer",
        "description": description,
        "minimum": min,
        "maximum": max,
    })
}

fn nullable_int_prop(description: &str, min: i64, max: i64) -> Value {
    json!({
        "description": description,
        "anyOf": [
            { "type": "integer", "minimum": min, "maximum": max },
            { "type": "null" }
        ]
    })
}

fn uuid_array_prop(description: &str, max_items: usize) -> Value {
    uuid_array_prop_min(description, 0, max_items)
}

fn uuid_array_prop_min(description: &str, min_items: usize, max_items: usize) -> Value {
    let mut schema = json!({
        "type": "array",
        "description": description,
        "maxItems": max_items,
        "items": {
            "type": "string",
            "minLength": 36,
            "maxLength": 36,
        }
    });
    if min_items > 0 {
        schema["minItems"] = json!(min_items);
    }
    schema
}

fn string_enum_prop(description: &str, values: &[&str]) -> Value {
    json!({
        "type": "string",
        "description": description,
        "enum": values,
    })
}

fn deserialize_action(
    name: &str,
    value: &Value,
) -> Result<ValidatedToolAction, ToolValidationError> {
    let action = match name {
        "create_task" => ValidatedToolAction::CreateTask(from_value(value)?),
        "update_task" => ValidatedToolAction::UpdateTask(from_value(value)?),
        "complete_task" => ValidatedToolAction::CompleteTask(from_value(value)?),
        "delete_task" => ValidatedToolAction::DeleteTask(from_value(value)?),
        "query_tasks" => ValidatedToolAction::QueryTasks(from_value(value)?),
        "break_down_task" => ValidatedToolAction::BreakDownTask(from_value(value)?),
        "extract_tasks_from_text" => ValidatedToolAction::ExtractTasksFromText(from_value(value)?),
        "bulk_create_tasks" => ValidatedToolAction::BulkCreateTasks(from_value(value)?),
        "bulk_complete_tasks" => ValidatedToolAction::BulkCompleteTasks(from_value(value)?),
        "bulk_update_tasks" => ValidatedToolAction::BulkUpdateTasks(from_value(value)?),
        "find_similar_tasks" => ValidatedToolAction::FindSimilarTasks(from_value(value)?),
        "check_duplicates" => ValidatedToolAction::CheckDuplicates(from_value(value)?),
        "create_project" => ValidatedToolAction::CreateProject(from_value(value)?),
        "list_projects" => ValidatedToolAction::ListProjects(from_value(value)?),
        "get_project" => ValidatedToolAction::GetProject(from_value(value)?),
        "update_project" => ValidatedToolAction::UpdateProject(from_value(value)?),
        "delete_project" => ValidatedToolAction::DeleteProject(from_value(value)?),
        "list_tags" => ValidatedToolAction::ListTags(from_value(value)?),
        "add_tags_to_task" => ValidatedToolAction::AddTagsToTask(from_value(value)?),
        "remove_tags_from_task" => ValidatedToolAction::RemoveTagsFromTask(from_value(value)?),
        "list_reminders" => ValidatedToolAction::ListReminders(from_value(value)?),
        "set_reminder" => ValidatedToolAction::SetReminder(from_value(value)?),
        "snooze_reminder" => ValidatedToolAction::SnoozeReminder(from_value(value)?),
        "dismiss_reminder" => ValidatedToolAction::DismissReminder(from_value(value)?),
        "analyze_completion_patterns" => {
            ValidatedToolAction::AnalyzeCompletionPatterns(from_value(value)?)
        }
        "check_overcommitment" => ValidatedToolAction::CheckOvercommitment(from_value(value)?),
        "analyze_workload" => ValidatedToolAction::AnalyzeWorkload(from_value(value)?),
        "get_energy_recommendations" => {
            ValidatedToolAction::GetEnergyRecommendations(from_value(value)?)
        }
        "get_productivity_stats" => ValidatedToolAction::GetProductivityStats(from_value(value)?),
        "estimate_task_duration" => ValidatedToolAction::EstimateTaskDuration(from_value(value)?),
        "time_tracking_summary" => ValidatedToolAction::TimeTrackingSummary(from_value(value)?),
        "suggest_tags" => ValidatedToolAction::SuggestTags(from_value(value)?),
        "plan_my_day" => ValidatedToolAction::PlanMyDay(from_value(value)?),
        "daily_review" => ValidatedToolAction::DailyReview(from_value(value)?),
        "weekly_review" => ValidatedToolAction::WeeklyReview(from_value(value)?),
        "save_memory" => ValidatedToolAction::SaveMemory(from_value(value)?),
        "recall_memories" => ValidatedToolAction::RecallMemories(from_value(value)?),
        "forget_memory" => ValidatedToolAction::ForgetMemory(from_value(value)?),
        "auto_schedule_day" => ValidatedToolAction::AutoScheduleDay(from_value(value)?),
        "apply_auto_schedule_day" => ValidatedToolAction::ApplyAutoScheduleDay(from_value(value)?),
        "reschedule_day" => ValidatedToolAction::RescheduleDay(from_value(value)?),
        "timeblocking_list_blocks" => {
            ValidatedToolAction::TimeblockingListBlocks(from_value(value)?)
        }
        "timeblocking_create_block" => {
            ValidatedToolAction::TimeblockingCreateBlock(from_value(value)?)
        }
        "timeblocking_update_block" => {
            ValidatedToolAction::TimeblockingUpdateBlock(from_value(value)?)
        }
        "timeblocking_delete_block" => {
            ValidatedToolAction::TimeblockingDeleteBlock(from_value(value)?)
        }
        "timeblocking_schedule_task" => {
            ValidatedToolAction::TimeblockingScheduleTask(from_value(value)?)
        }
        "timeblocking_get_availability" => {
            ValidatedToolAction::TimeblockingGetAvailability(from_value(value)?)
        }
        "timeblocking_set_recurrence" => {
            ValidatedToolAction::TimeblockingSetRecurrence(from_value(value)?)
        }
        "timeblocking_replan_day" => ValidatedToolAction::TimeblockingReplanDay(from_value(value)?),
        _ => {
            return Err(ToolValidationError::new(
                "unknown_tool",
                "tool name is not in the allowlist",
            ));
        }
    };
    Ok(action)
}

fn from_value<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T, ToolValidationError> {
    serde_json::from_value(value.clone()).map_err(|_| {
        ToolValidationError::new(
            "invalid_arguments",
            "arguments failed strict schema validation",
        )
    })
}

fn parse_strict_json_object(raw: &str) -> Result<Value, ToolValidationError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(json!({}));
    }
    let value = parse_value_rejecting_duplicates(trimmed)?;
    if !value.is_object() {
        return Err(ToolValidationError::new(
            "arguments_not_object",
            "tool arguments must be a JSON object",
        ));
    }
    Ok(value)
}

fn parse_value_rejecting_duplicates(raw: &str) -> Result<Value, ToolValidationError> {
    let mut de = serde_json::Deserializer::from_str(raw);
    let value = deserialize_reject_duplicates(&mut de).map_err(|error| {
        if error.to_string().contains("duplicate field") {
            ToolValidationError::new(
                "duplicate_key",
                "tool arguments contain duplicate JSON keys",
            )
        } else {
            ToolValidationError::new("malformed_json", "tool arguments must be valid JSON")
        }
    })?;
    de.end().map_err(|_| {
        ToolValidationError::new("malformed_json", "tool arguments must be valid JSON")
    })?;
    Ok(value)
}

fn deserialize_reject_duplicates<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{self, MapAccess, SeqAccess, Visitor};

    struct StrictVisitor;

    impl<'de> Visitor<'de> for StrictVisitor {
        type Value = Value;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("any valid JSON value")
        }

        fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
            Ok(Value::Bool(value))
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
            Ok(Value::Number(value.into()))
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
            Ok(Value::Number(value.into()))
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            serde_json::Number::from_f64(value)
                .map(Value::Number)
                .ok_or_else(|| de::Error::custom("invalid number"))
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
            Ok(Value::String(value.to_owned()))
        }

        fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
            Ok(Value::String(value))
        }

        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(Value::Null)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(Value::Null)
        }

        fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            let mut items = Vec::new();
            while let Some(item) = seq.next_element_seed(StrictSeed)? {
                items.push(item);
            }
            Ok(Value::Array(items))
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut object = Map::new();
            while let Some(key) = map.next_key::<String>()? {
                if object.contains_key(&key) {
                    return Err(de::Error::custom(format!("duplicate field `{key}`")));
                }
                let value = map.next_value_seed(StrictSeed)?;
                object.insert(key, value);
            }
            Ok(Value::Object(object))
        }
    }

    struct StrictSeed;

    impl<'de> de::DeserializeSeed<'de> for StrictSeed {
        type Value = Value;

        fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            deserializer.deserialize_any(StrictVisitor)
        }
    }

    deserializer.deserialize_any(StrictVisitor)
}

fn reject_forbidden_value(value: &Value) -> Result<(), ToolValidationError> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if FORBIDDEN_ARGUMENT_NAMES.contains(&key.as_str()) {
                    return Err(ToolValidationError::new(
                        "forbidden_field",
                        "arguments contain a forbidden field",
                    ));
                }
                reject_forbidden_value(child)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                reject_forbidden_value(item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn reject_control_chars(value: &Value) -> Result<(), ToolValidationError> {
    match value {
        Value::String(text) => {
            if text.chars().any(is_disallowed_control) {
                return Err(ToolValidationError::new(
                    "control_characters",
                    "arguments must not contain control characters",
                ));
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                reject_control_chars(item)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (key, child) in map {
                if key.chars().any(is_disallowed_control) {
                    return Err(ToolValidationError::new(
                        "control_characters",
                        "arguments must not contain control characters",
                    ));
                }
                reject_control_chars(child)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn is_disallowed_control(ch: char) -> bool {
    // Allow ordinary text whitespace; reject NUL and other controls.
    ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t'
}

fn canonicalize_json(value: &Value) -> String {
    serde_json::to_string(&sort_value(value)).unwrap_or_else(|_| "{}".to_owned())
}

fn sort_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut ordered = BTreeMap::new();
            for (key, child) in map {
                ordered.insert(key.clone(), sort_value(child));
            }
            Value::Object(ordered.into_iter().collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(sort_value).collect()),
        other => other.clone(),
    }
}

fn bound_result_data(mut data: Value) -> (Value, bool) {
    let mut truncated = false;
    // One aggregate array-element budget across every JSON array in the payload.
    let mut remaining = AI_TOOL_RESULT_ENTITY_MAX;
    enforce_aggregate_array_budget(&mut data, &mut remaining, &mut truncated);
    if let Ok(bytes) = serde_json::to_vec(&data)
        && bytes.len() <= AI_TOOL_RESULT_BYTES_MAX
    {
        return (data, truncated);
    }
    // Deterministic non-quadratic byte-budget pass over the same aggregate count.
    apply_byte_budget(&mut data, &mut truncated);
    (data, truncated)
}

/// Recursively budget every JSON array element under one shared ceiling.
/// Object keys and scalar leaves are preserved; only array tails are dropped.
fn enforce_aggregate_array_budget(value: &mut Value, remaining: &mut usize, truncated: &mut bool) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<String> = map.keys().cloned().collect();
            keys.sort();
            for key in keys {
                let Some(child) = map.get_mut(&key) else {
                    continue;
                };
                enforce_aggregate_array_budget(child, remaining, truncated);
            }
        }
        Value::Array(items) => {
            if items.len() > *remaining {
                items.truncate(*remaining);
                *truncated = true;
            }
            *remaining = remaining.saturating_sub(items.len());
            for item in items.iter_mut() {
                enforce_aggregate_array_budget(item, remaining, truncated);
            }
        }
        _ => {}
    }
}

fn apply_byte_budget(value: &mut Value, truncated: &mut bool) {
    let measured = match serde_json::to_vec(value) {
        Ok(bytes) => bytes.len(),
        Err(_) => return,
    };
    if measured <= AI_TOOL_RESULT_BYTES_MAX {
        return;
    }
    let total = count_array_elements(value);
    if total == 0 {
        // Scalar/object oversize cannot be repaired by array truncation.
        return;
    }

    // Deterministic binary search on aggregate keep-count (O(log n) probes).
    let snapshot = value.clone();
    let mut best_keep = 0_usize;
    let mut lo = 0_usize;
    let mut hi = total;
    while lo <= hi {
        let mid = (lo + hi) / 2;
        *value = snapshot.clone();
        let mut remaining = mid;
        let mut local = false;
        enforce_aggregate_array_budget(value, &mut remaining, &mut local);
        let fits = serde_json::to_vec(value)
            .map(|bytes| bytes.len() <= AI_TOOL_RESULT_BYTES_MAX)
            .unwrap_or(false);
        if fits {
            best_keep = mid;
            lo = mid.saturating_add(1);
        } else if mid == 0 {
            break;
        } else {
            hi = mid - 1;
        }
    }
    *value = snapshot;
    let mut remaining = best_keep;
    let mut local = false;
    enforce_aggregate_array_budget(value, &mut remaining, &mut local);
    if best_keep < total {
        *truncated = true;
    }
}

fn count_array_elements(value: &Value) -> usize {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            keys.into_iter()
                .map(|key| count_array_elements(&map[key]))
                .sum()
        }
        Value::Array(items) => items.len() + items.iter().map(count_array_elements).sum::<usize>(),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use junban_ai::MAX_TOOL_ARGUMENTS_BYTES as ARG_BOUND;

    #[test]
    fn registry_has_exact_inventory_order_and_name_bound() {
        let regs = tool_registrations();
        assert_eq!(regs.len(), AI_TOOL_COUNT);
        let specs = tool_specs();
        assert_eq!(specs.len(), AI_TOOL_COUNT);
        let mut names = BTreeSet::new();
        for (index, entry) in regs.iter().enumerate() {
            assert_eq!(specs[index].name, entry.name);
            assert!(entry.name.len() <= AI_TOOL_NAME_MAX_BYTES);
            assert!(names.insert(entry.name));
            assert!(
                specs[index]
                    .description
                    .contains("Exactly one tool call is accepted per round")
            );
        }
        assert_eq!(names.len(), AI_TOOL_COUNT);
        // Snapshot first/last and counts by default effect.
        assert_eq!(regs[0].name, "create_task");
        assert_eq!(regs[AI_TOOL_COUNT - 1].name, "timeblocking_replan_day");
        let reads = regs
            .iter()
            .filter(|entry| entry.default_effect == ToolEffect::Read)
            .count();
        let mutations = regs
            .iter()
            .filter(|entry| entry.default_effect == ToolEffect::ApprovalRequired)
            .count();
        assert_eq!(reads, 24);
        assert_eq!(mutations, 25);
        assert_eq!(regs.iter().filter(|entry| entry.dynamic_effect).count(), 1);
    }

    #[test]
    fn all_schemas_are_closed_objects_without_operation_ids() {
        for spec in tool_specs() {
            let schema = &spec.parameters;
            assert_eq!(schema["type"], "object");
            assert_eq!(schema["additionalProperties"], false);
            assert!(schema.get("$ref").is_none());
            let encoded = schema.to_string();
            for forbidden in forbidden_argument_names() {
                assert!(
                    !encoded.contains(&format!("\"{forbidden}\"")),
                    "schema for {} mentions forbidden field {forbidden}",
                    spec.name
                );
            }
            assert!(!encoded.contains("operation_id"));
            assert!(!encoded.contains("approval_id"));
            walk_closed_objects(schema);
        }
    }

    fn walk_closed_objects(value: &Value) {
        if let Some(object) = value.as_object() {
            if object.get("type").and_then(Value::as_str) == Some("object") {
                assert_eq!(
                    object.get("additionalProperties"),
                    Some(&Value::Bool(false))
                );
            }
            if let Some(properties) = object.get("properties")
                && let Some(map) = properties.as_object()
            {
                for child in map.values() {
                    walk_closed_objects(child);
                }
            }
            if let Some(items) = object.get("items") {
                walk_closed_objects(items);
            }
            if let Some(any_of) = object.get("anyOf")
                && let Some(items) = any_of.as_array()
            {
                for child in items {
                    walk_closed_objects(child);
                }
            }
        }
    }

    #[test]
    fn validate_accepts_create_task_and_classifies_effects() {
        let (action, canonical) = validate_tool_call(
            "create_task",
            r#"{"title":"Write docs","priority":2,"tag_ids":[]}"#,
        )
        .unwrap();
        assert_eq!(action.name(), "create_task");
        assert_eq!(action.effect(), ToolEffect::ApprovalRequired);
        assert!(canonical.contains("Write docs"));

        let (preview, _) =
            validate_tool_call("extract_tasks_from_text", r#"{"text":"- one\n- two"}"#).unwrap();
        assert_eq!(preview.effect(), ToolEffect::Read);

        let (apply, _) = validate_tool_call(
            "extract_tasks_from_text",
            r#"{"text":"- one","dry_run":false}"#,
        )
        .unwrap();
        assert_eq!(apply.effect(), ToolEffect::ApprovalRequired);

        let (schedule, _) =
            validate_tool_call("auto_schedule_day", r#"{"date":"2026-08-02"}"#).unwrap();
        assert_eq!(schedule.effect(), ToolEffect::Read);
        let (apply_schedule, _) = validate_tool_call(
            "apply_auto_schedule_day",
            r#"{
                "date":"2026-08-02",
                "blocks":[{
                    "task_id":"00112233-4455-6677-8899-aabbccddeeff",
                    "title":"Deep work",
                    "date":"2026-08-02",
                    "start":"09:00:00",
                    "end":"09:30:00",
                    "time_zone":"UTC",
                    "estimated_minutes":30
                }]
            }"#,
        )
        .unwrap();
        assert_eq!(apply_schedule.effect(), ToolEffect::ApprovalRequired);
        assert!(
            !registration("apply_auto_schedule_day")
                .unwrap()
                .dynamic_effect
        );
        let (reschedule, _) = validate_tool_call("reschedule_day", "{}").unwrap();
        assert_eq!(reschedule.effect(), ToolEffect::Read);
    }

    #[test]
    fn validate_rejects_unknown_fields_names_and_forbidden_material() {
        assert_eq!(
            validate_tool_call("not_a_tool", "{}").unwrap_err().code,
            "unknown_tool"
        );
        assert_eq!(
            validate_tool_call("create_task", r#"{"title":"x","extra":1}"#)
                .unwrap_err()
                .code,
            "invalid_arguments"
        );
        assert_eq!(
            validate_tool_call("create_task", r#"{"title":"x","operation_id":"y"}"#)
                .unwrap_err()
                .code,
            "forbidden_field"
        );
        assert_eq!(
            validate_tool_call("create_task", r#"{"title":"x","url":"https://evil.test"}"#)
                .unwrap_err()
                .code,
            "forbidden_field"
        );
        assert_eq!(
            validate_tool_call("create_task", r#"{"title":"x","path":"/etc/passwd"}"#)
                .unwrap_err()
                .code,
            "forbidden_field"
        );
        assert_eq!(
            validate_tool_call("create_task", r#"{"title":"x","preview_hash":"abc"}"#)
                .unwrap_err()
                .code,
            "forbidden_field"
        );
        assert_eq!(
            validate_tool_call("create_task", r#"{"title":"a\u0001b"}"#)
                .unwrap_err()
                .code,
            "control_characters"
        );
        assert_eq!(
            validate_tool_call("create_task", r#"{"title":"x","title":"y"}"#)
                .unwrap_err()
                .code,
            "duplicate_key"
        );
        assert_eq!(
            validate_tool_call("create_task", r#"[1,2,3]"#)
                .unwrap_err()
                .code,
            "arguments_not_object"
        );
        assert_eq!(
            validate_tool_call("create_task", "{").unwrap_err().code,
            "malformed_json"
        );
        let oversized = format!("{{\"title\":\"{}\"}}", "x".repeat(ARG_BOUND));
        assert_eq!(
            validate_tool_call("create_task", &oversized)
                .unwrap_err()
                .code,
            "arguments_too_large"
        );
    }

    #[test]
    fn forbidden_name_fuzz_corpus_is_rejected_everywhere() {
        for name in forbidden_argument_names() {
            let raw = format!(r#"{{"title":"ok","{name}":"nope"}}"#);
            let error = validate_tool_call("create_task", &raw).unwrap_err();
            assert_eq!(error.code, "forbidden_field", "name={name}");
        }
    }

    #[test]
    fn result_envelope_truncates_entity_arrays_and_bounds_bytes() {
        let tasks: Vec<Value> = (0..600)
            .map(|index| json!({ "id": format!("{index:036}"), "title": format!("t{index}") }))
            .collect();
        let envelope = ToolResultEnvelope::success("query_tasks", json!({ "tasks": tasks }))
            .finalize_bounded();
        assert_eq!(envelope.outcome, ToolOutcome::Success);
        assert!(envelope.truncated);
        assert_eq!(envelope.data["tasks"].as_array().unwrap().len(), 500);
        assert!(serde_json::to_vec(&envelope).unwrap().len() <= AI_TOOL_RESULT_BYTES_MAX);

        let huge = ToolResultEnvelope::success(
            "query_tasks",
            json!({ "blob": "x".repeat(AI_TOOL_RESULT_BYTES_MAX) }),
        )
        .finalize_bounded();
        assert_eq!(huge.outcome, ToolOutcome::Error);
        assert_eq!(huge.data["code"], "result_too_large");
    }

    #[test]
    fn extract_titles_are_deterministic_and_bounded() {
        let titles = extract_task_titles_from_text("- alpha\n* beta\n1. gamma\n\nplain");
        assert_eq!(titles, vec!["alpha", "beta", "gamma", "plain"]);
    }

    #[test]
    fn empty_args_tools_accept_empty_object() {
        for name in [
            "list_projects",
            "list_tags",
            "plan_my_day",
            "auto_schedule_day",
        ] {
            validate_tool_call(name, "{}").unwrap();
            validate_tool_call(name, "").unwrap();
        }
    }

    #[test]
    fn canonical_json_sorts_object_keys() {
        let (_, canonical) = validate_tool_call(
            "create_task",
            r#"{"priority":1,"title":"A","description":"B"}"#,
        )
        .unwrap();
        assert_eq!(canonical, r#"{"description":"B","priority":1,"title":"A"}"#);
    }

    #[test]
    fn schema_bounds_agree_with_domain_constants() {
        let specs: BTreeMap<_, _> = tool_specs()
            .iter()
            .map(|spec| (spec.name.as_str(), spec))
            .collect();
        let create = &specs["create_task"].parameters["properties"];
        assert_eq!(create["title"]["maxLength"], MAX_TASK_TITLE_CHARS);
        assert_eq!(create["tag_ids"]["maxItems"], MAX_TAGS_PER_TASK);
        assert_eq!(create["priority"]["minimum"], 1);
        assert_eq!(create["priority"]["maximum"], 4);

        let add_tags = &specs["add_tags_to_task"].parameters["properties"];
        assert_eq!(add_tags["tag_ids"]["maxItems"], MAX_TAGS_PER_TASK);
        assert_eq!(add_tags["tag_names"]["maxItems"], MAX_TAGS_PER_TASK);

        let query = &specs["query_tasks"].parameters["properties"];
        assert_eq!(query["limit"]["minimum"], 1);
        assert_eq!(query["limit"]["maximum"], i64::from(MAX_QUERY_PAGE_LIMIT));

        let bulk = &specs["bulk_create_tasks"].parameters["properties"];
        assert_eq!(bulk["titles"]["maxItems"], AI_TOOL_COMPOSITE_CREATE_MAX);
        assert_eq!(bulk["titles"]["minItems"], 1);
        let breakdown = &specs["break_down_task"].parameters["properties"];
        assert_eq!(
            breakdown["subtasks"]["maxItems"],
            AI_TOOL_COMPOSITE_CREATE_MAX
        );
        let bulk_complete = &specs["bulk_complete_tasks"].parameters["properties"];
        assert_eq!(bulk_complete["task_ids"]["maxItems"], MAX_BULK_IDS);

        let apply_schedule = &specs["apply_auto_schedule_day"].parameters["properties"];
        assert_eq!(
            apply_schedule["blocks"]["maxItems"],
            AI_TOOL_AUTO_SCHEDULE_BLOCKS_MAX
        );
        assert_eq!(apply_schedule["blocks"]["minItems"], 1);
        assert_eq!(
            apply_schedule["blocks"]["items"]["properties"]["estimated_minutes"]["minimum"],
            15
        );
        assert_eq!(
            apply_schedule["blocks"]["items"]["properties"]["estimated_minutes"]["maximum"],
            240
        );
        assert_eq!(
            apply_schedule["blocks"]["items"]["properties"]["title"]["maxLength"],
            MAX_ENTITY_NAME_CHARS
        );

        let recall = &specs["recall_memories"].parameters["properties"];
        assert_eq!(
            recall["limit"]["maximum"],
            i64::from(AI_CONTEXT_MEMORIES_MAX)
        );
    }

    #[test]
    fn invalid_mutation_calls_never_become_validated_actions() {
        let cases = [
            ("create_task", r#"{"title":""}"#),
            ("create_task", r#"{"title":"ok","priority":9}"#),
            ("create_task", r#"{"title":"ok","tag_ids":["not-a-uuid"]}"#),
            ("complete_task", r#"{"task_id":"nope"}"#),
            ("bulk_create_tasks", r#"{"titles":[]}"#),
            ("bulk_complete_tasks", r#"{"task_ids":[]}"#),
            ("query_tasks", r#"{"limit":0}"#),
            ("query_tasks", r#"{"status":"done"}"#),
            (
                "add_tags_to_task",
                r#"{"task_id":"00112233-4455-6677-8899-aabbccddeeff"}"#,
            ),
            (
                "timeblocking_create_block",
                r#"{"title":"x","date":"2026-08-02","start":"11:00:00","end":"10:00:00"}"#,
            ),
            ("timeblocking_replan_day", r#"{"action":"explode"}"#),
            ("save_memory", r#"{"content":""}"#),
            (
                "break_down_task",
                r#"{"task_id":"00112233-4455-6677-8899-aabbccddeeff","subtasks":[""]}"#,
            ),
            (
                "apply_auto_schedule_day",
                r#"{"date":"2026-08-02","blocks":[]}"#,
            ),
            (
                "apply_auto_schedule_day",
                r#"{
                    "date":"2026-08-02",
                    "blocks":[{
                        "task_id":"00112233-4455-6677-8899-aabbccddeeff",
                        "title":"Deep work",
                        "date":"2026-08-03",
                        "start":"09:00:00",
                        "end":"09:30:00",
                        "time_zone":"UTC",
                        "estimated_minutes":30
                    }]
                }"#,
            ),
            (
                "apply_auto_schedule_day",
                r#"{
                    "date":"2026-08-02",
                    "blocks":[{
                        "task_id":"00112233-4455-6677-8899-aabbccddeeff",
                        "title":"Deep work",
                        "date":"2026-08-02",
                        "start":"10:00:00",
                        "end":"09:00:00",
                        "time_zone":"UTC",
                        "estimated_minutes":30
                    }]
                }"#,
            ),
            (
                "apply_auto_schedule_day",
                r#"{
                    "date":"2026-08-02",
                    "blocks":[{
                        "task_id":"00112233-4455-6677-8899-aabbccddeeff",
                        "title":"Deep work",
                        "date":"2026-08-02",
                        "start":"09:00:00",
                        "end":"09:30:00",
                        "time_zone":"UTC",
                        "estimated_minutes":14
                    }]
                }"#,
            ),
            (
                "apply_auto_schedule_day",
                r#"{
                    "date":"2026-08-02",
                    "blocks":[
                        {
                            "task_id":"00112233-4455-6677-8899-aabbccddeeff",
                            "title":"One",
                            "date":"2026-08-02",
                            "start":"09:00:00",
                            "end":"09:30:00",
                            "time_zone":"UTC",
                            "estimated_minutes":30
                        },
                        {
                            "task_id":"00112233-4455-6677-8899-aabbccddeeff",
                            "title":"Two",
                            "date":"2026-08-02",
                            "start":"10:00:00",
                            "end":"10:30:00",
                            "time_zone":"UTC",
                            "estimated_minutes":30
                        }
                    ]
                }"#,
            ),
        ];
        for (name, args) in cases {
            assert!(
                validate_tool_call(name, args).is_err(),
                "expected rejection for {name} args={args}"
            );
        }

        let titles = (0..=AI_TOOL_COMPOSITE_CREATE_MAX)
            .map(|index| format!("task-{index}"))
            .collect::<Vec<_>>();
        let bulk = json!({"titles": titles}).to_string();
        assert!(validate_tool_call("bulk_create_tasks", &bulk).is_err());
        let breakdown = json!({
            "task_id": "00112233-4455-6677-8899-aabbccddeeff",
            "subtasks": (0..=AI_TOOL_COMPOSITE_CREATE_MAX)
                .map(|index| format!("task-{index}"))
                .collect::<Vec<_>>(),
        })
        .to_string();
        assert!(validate_tool_call("break_down_task", &breakdown).is_err());
        let text = (0..=AI_TOOL_COMPOSITE_CREATE_MAX)
            .map(|index| format!("- task-{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            validate_tool_call(
                "extract_tasks_from_text",
                &json!({"text": text.clone(), "dry_run": false}).to_string(),
            )
            .is_err()
        );
        assert!(
            validate_tool_call(
                "extract_tasks_from_text",
                &json!({"text": text, "dry_run": true}).to_string(),
            )
            .is_ok()
        );
    }

    #[test]
    fn aggregate_entity_budget_spans_multiple_arrays() {
        let blocks: Vec<Value> = (0..300)
            .map(|index| json!({ "id": format!("b{index}") }))
            .collect();
        let slots: Vec<Value> = (0..300)
            .map(|index| json!({ "id": format!("s{index}") }))
            .collect();
        let envelope = ToolResultEnvelope::success(
            "timeblocking_list_blocks",
            json!({ "blocks": blocks, "slots": slots }),
        )
        .finalize_bounded();
        assert_eq!(envelope.outcome, ToolOutcome::Success);
        assert!(envelope.truncated);
        let block_len = envelope.data["blocks"].as_array().unwrap().len();
        let slot_len = envelope.data["slots"].as_array().unwrap().len();
        assert_eq!(block_len + slot_len, AI_TOOL_RESULT_ENTITY_MAX);
        assert!(block_len <= 300);
        assert!(slot_len <= 300);
    }

    #[test]
    fn aggregate_array_budget_covers_nested_and_energy_keys() {
        let nested_ids: Vec<Value> = (0..50)
            .map(|index| Value::String(format!("id-{index}")))
            .collect();
        let task_jar: Vec<Value> = (0..200)
            .map(|index| {
                json!({
                    "id": format!("jar-{index}"),
                    "tag_ids": nested_ids.clone(),
                })
            })
            .collect();
        let dopamine_menu: Vec<Value> = (0..200)
            .map(|index| json!({ "id": format!("menu-{index}") }))
            .collect();
        let top_ids: Vec<Value> = (0..100)
            .map(|index| Value::String(format!("top-{index}")))
            .collect();
        let envelope = ToolResultEnvelope::success(
            "get_energy_recommendations",
            json!({
                "date": "2026-08-02",
                "scalar": "kept",
                "count": 42,
                "task_jar": task_jar,
                "dopamine_menu": dopamine_menu,
                "top_accomplishment_ids": top_ids,
                "nested": { "blocks": (0..80).map(|i| json!({"id": i})).collect::<Vec<_>>() },
            }),
        )
        .finalize_bounded();

        assert_eq!(envelope.outcome, ToolOutcome::Success);
        assert!(envelope.truncated);
        assert_eq!(envelope.data["scalar"], "kept");
        assert_eq!(envelope.data["count"], 42);
        assert_eq!(envelope.data["date"], "2026-08-02");
        let total = count_array_elements(&envelope.data);
        assert!(
            total <= AI_TOOL_RESULT_ENTITY_MAX,
            "retained array elements {total} exceed budget"
        );
        assert!(serde_json::to_vec(&envelope).unwrap().len() <= AI_TOOL_RESULT_BYTES_MAX);

        // Energy keys participate in the shared budget (not selected-key exempt).
        let jar = envelope.data["task_jar"]
            .as_array()
            .map(Vec::len)
            .unwrap_or(0);
        let menu = envelope.data["dopamine_menu"]
            .as_array()
            .map(Vec::len)
            .unwrap_or(0);
        assert!(jar + menu <= AI_TOOL_RESULT_ENTITY_MAX);
    }

    #[test]
    fn bulk_update_tasks_table_driven_validation() {
        let task = "00112233-4455-6677-8899-aabbccddeeff";
        let tag = "aabbccdd-eeff-0011-2233-445566778899";
        let project = "11223344-5566-7788-99aa-bbccddeeff00";
        let reject = vec![
            (r#"{"task_ids":[]}"#.to_owned(), "empty_task_ids"),
            (format!(r#"{{"task_ids":["{task}"]}}"#), "missing_update"),
            (
                format!(r#"{{"task_ids":["{task}"],"priority":1,"due_date":"2026-08-02"}}"#),
                "conflicting_update",
            ),
            (
                format!(r#"{{"task_ids":["{task}"],"add_tag_ids":["{tag}"],"priority":2}}"#),
                "conflicting_update",
            ),
            (
                format!(r#"{{"task_ids":["{task}"],"project_id":"{project}","someday":true}}"#),
                "conflicting_update",
            ),
            (
                format!(
                    r#"{{"task_ids":["{task}"],"add_tag_ids":["{tag}"],"project_id":"{project}"}}"#
                ),
                "conflicting_update",
            ),
            (
                format!(r#"{{"task_ids":["{task}"],"priority":1,"project_id":"{project}"}}"#),
                "conflicting_update",
            ),
        ];
        for (args, code) in &reject {
            let error = validate_tool_call("bulk_update_tasks", args).unwrap_err();
            assert_eq!(error.code, *code, "args={args}");
        }

        let accept = [
            format!(r#"{{"task_ids":["{task}"],"priority":1}}"#),
            format!(r#"{{"task_ids":["{task}"],"priority":null}}"#),
            format!(r#"{{"task_ids":["{task}"],"due_date":"2026-08-02"}}"#),
            format!(r#"{{"task_ids":["{task}"],"due_date":null,"someday":true}}"#),
            format!(r#"{{"task_ids":["{task}"],"project_id":"{project}"}}"#),
            format!(r#"{{"task_ids":["{task}"],"project_id":null}}"#),
            format!(r#"{{"task_ids":["{task}"],"add_tag_ids":["{tag}"]}}"#),
            format!(r#"{{"task_ids":["{task}"],"remove_tag_ids":["{tag}"]}}"#),
            format!(
                r#"{{"task_ids":["{task}"],"add_tag_ids":["{tag}"],"remove_tag_ids":["{tag}"]}}"#
            ),
            format!(r#"{{"task_ids":["{task}"],"due_date":"2026-08-02","due_time":"09:30:00"}}"#),
        ];
        for args in accept {
            validate_tool_call("bulk_update_tasks", &args)
                .unwrap_or_else(|error| panic!("expected accept args={args}: {error}"));
        }

        let specs: BTreeMap<_, _> = tool_specs()
            .iter()
            .map(|spec| (spec.name.as_str(), spec))
            .collect();
        let bulk = &specs["bulk_update_tasks"].parameters["properties"];
        assert_eq!(bulk["task_ids"]["minItems"], 1);
        assert_eq!(bulk["task_ids"]["maxItems"], MAX_BULK_IDS);
        assert!(
            specs["bulk_update_tasks"]
                .description
                .contains("Groups cannot be combined")
        );
    }

    #[test]
    fn large_description_byte_budget_is_linear_and_stable() {
        let tasks: Vec<Value> = (0..200)
            .map(|index| {
                json!({
                    "id": format!("{index:036}"),
                    "title": format!("t{index}"),
                    "description": "d".repeat(4_000),
                })
            })
            .collect();
        let started = std::time::Instant::now();
        let envelope = ToolResultEnvelope::success("query_tasks", json!({ "tasks": tasks }))
            .finalize_bounded();
        let elapsed = started.elapsed();
        assert!(
            elapsed.as_millis() < 1_500,
            "finalize took too long: {elapsed:?}"
        );
        assert!(
            matches!(envelope.outcome, ToolOutcome::Success | ToolOutcome::Error),
            "unexpected outcome {:?}",
            envelope.outcome
        );
        if envelope.outcome == ToolOutcome::Success {
            assert!(envelope.truncated || envelope.data["tasks"].as_array().unwrap().len() <= 200);
            assert!(serde_json::to_vec(&envelope).unwrap().len() <= AI_TOOL_RESULT_BYTES_MAX);
        } else {
            assert_eq!(envelope.data["code"], "result_too_large");
        }
    }
}
