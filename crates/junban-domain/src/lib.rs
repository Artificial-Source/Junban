//! Pure task entities, value objects, and validation rules for Junban.
//!
//! This crate deliberately has no knowledge of HTTP, SQLite, or async runtimes.

mod ai;
mod catalog;
mod ids;
mod invariants;
mod planning;
mod query;
mod quick_entry;
mod recurrence;
mod reminder;
mod settings;
mod task;
mod text_import;
mod timeblock;
mod transfer;
mod values;

pub use ai::{
    AI_APPROVAL_ACTION_HASH_DOMAIN, AI_APPROVAL_LIFETIME_SECS, AI_ASSISTANT_TEXT_BYTES_MAX,
    AI_BASE_URL_BYTES_MAX, AI_CONTEXT_MEMORIES_MAX, AI_CUSTOM_INSTRUCTIONS_BYTES_MAX,
    AI_DISPATCHING_APPROVAL_RECOVERY_MAX, AI_GRACE_PERIOD_MS_DEFAULT, AI_GRACE_PERIOD_MS_MAX,
    AI_GRACE_PERIOD_MS_MIN, AI_MEMORIES_PER_PROFILE_MAX, AI_MEMORY_BYTES_MAX,
    AI_MEMORY_CONTENT_BYTES_MAX, AI_MEMORY_PAGE_MAX, AI_MESSAGE_CONTENT_JSON_BYTES_MAX,
    AI_MESSAGE_PAGE_MAX, AI_MESSAGES_PER_SESSION_MAX, AI_MODEL_ID_BYTES_MAX,
    AI_PENDING_APPROVAL_CONTENT_BYTES_MAX, AI_PENDING_APPROVALS_MAX, AI_PROFILE_CONTENT_BYTES_MAX,
    AI_PROVIDER_ID_BYTES_MAX, AI_SECRET_BYTES_MAX, AI_SECRETS_FILE, AI_SECRETS_FILE_VERSION,
    AI_SECRETS_MAX, AI_SESSION_CONTENT_BYTES_MAX, AI_SESSION_PAGE_MAX, AI_SESSION_TITLE_BYTES_MAX,
    AI_SESSIONS_PER_PROFILE_MAX, AI_TOOL_ARGUMENTS_BYTES_MAX, AI_TOOL_EVENT_TRANSCRIPT_BYTES_MAX,
    AI_TOOL_RESULT_BYTES_MAX, AI_USER_INPUT_BYTES_MAX, AiApprovalId, AiApprovalStatus,
    AiCredentialId, AiMemory, AiMemoryId, AiMessage, AiMessageContent, AiMessageId, AiMessageRole,
    AiMessageStatus, AiModelId, AiProviderPreset, AiResponseRewriteKind, AiRunId, AiRunPhase,
    AiRunState, AiSecretKind, AiSecretMetadata, AiSession, AiSessionId, AiSessionStatus,
    AiSettings, AiToolApproval, AiToolEvent, AiToolEventType, AiTurnId, CustomInstructions,
    GracePeriodMs, ProviderBaseUrl, SpeechProviderPreset, VoiceMode, VoiceSettings,
    ai_approval_action_hash, referenced_ai_credential_ids, validate_ai_tool_name,
    validate_base_url,
};
pub use catalog::{
    Comment, Project, SavedFilter, Section, Tag, TaskActivity, TaskActivityAction, TaskRelation,
    Template,
};
pub use ids::{
    CommentId, OperationId, ProjectId, SavedFilterId, SectionId, TagId, TaskId, TemplateId,
    TimeBlockId, TimeSlotId,
};
pub use invariants::{
    blocks_edge_creates_cycle, validate_parent_chain, validate_project_parent_chain,
    validate_reorder_permutation, validate_task_tags, validate_unique_bulk_ids,
};
pub use planning::{
    CapacitySettings, CompletionTimeBucket, CompletionTimeBuckets, DailyCapacityMinutes,
    DailyPlanSummary, DailyStatBucket, EndOfDaySummary, MAX_ANALYSIS_TASK_READ,
    MAX_CALENDAR_RANGE_DAYS, MAX_CALENDAR_TASKS, MAX_NUDGE_TASKS_COMBINED,
    MAX_NUDGE_TASKS_PER_RULE, MAX_STATS_RANGE_DAYS, MAX_WEEKLY_ACCOMPLISHMENTS,
    MAX_WEEKLY_NEGLECTED_PROJECTS, MAX_WEEKLY_OVERDUE, MAX_WEEKLY_STREAK_DAYS,
    MAX_WEEKLY_SUGGESTIONS, MatrixDropResult, MatrixGrouping, MatrixQuadrant, NeglectedProjectFact,
    NeglectedProjectReason, NudgeFacts, NudgeRuleFacts, NudgeRuleKind, NudgeRuleSettings,
    StatsSummary, WeekStart, WeeklyDayStats, WeeklyReviewSummary, WeeklySuggestion, WorkHours,
    civil_date_in_zone, civil_hour_in_zone, classify_matrix_quadrant, current_completion_streak,
    daily_plan_summary, dopamine_menu_task_ids, end_of_day_summary, end_of_day_summary_with,
    estimate_accuracy, evaluate_nudges, evaluate_nudges_with, group_matrix_task_ids,
    matrix_drop_result, prior_complete_week, select_eat_the_frog, stats_summary,
    stats_summary_with, task_jar_candidates, validate_calendar_date_range,
    validate_stats_date_range, weekly_review_summary, weekly_review_summary_with,
};
pub use query::{
    MAX_FILTER_INPUT_CHARS, TaskCursor, TaskFilter, TaskQuery, TaskSort, TaskViewPreset,
    parse_filter, validate_page_limit,
};
pub use quick_entry::{MAX_QUICK_ENTRY_CHARS, QuickEntry, parse_quick_entry};
pub use recurrence::{
    MonthlyAnchorDay, NextOccurrence, NextOccurrenceRequest, OccurrenceAbsoluteOffsets,
    RecurrenceSource, civil_occurrences_in_range, next_occurrence, resolve_due_instant,
    shift_occurrence_absolutes,
};
pub use reminder::{
    ClaimedReminder, DEFAULT_REMINDER_CLAIM_LIMIT, DEFAULT_REMINDER_CLAIM_SECS,
    DEFAULT_REMINDER_LEASE_SECS, MAX_OWNER_LOST_MARK_LIMIT, MAX_REMINDER_CLAIM_LIMIT,
    MAX_REMINDER_LEASE_SECS, REMINDER_FAILURE_BACKOFF_MAX_SECS,
    REMINDER_FAILURE_BACKOFF_START_SECS, REMINDER_TERMINAL_MAX_BYTES, REMINDER_TERMINAL_MAX_ROWS,
    REMINDER_TERMINAL_RETENTION_DAYS, ReminderChannel, ReminderChannelSet, ReminderDeliveryLease,
    ReminderFailureCode, ReminderFenceTerm, ReminderLeadMinutes, ReminderOccurrence,
    ReminderOccurrenceState, ReminderSettings, format_reminder_timestamp, reminder_failure_backoff,
    reminder_occurrence_key, validate_owner_lost_mark_limit, validate_reminder_claim_limit,
    validate_reminder_lease_secs,
};
pub use settings::{
    AppSettings, AppearanceSettings, CalendarDefault, DateFormat, DateTimeSettings, Density,
    FeatureSettings, FontFamily, FontSize, KEYBOARD_SHORTCUT_ACTIONS, KeyboardShortcut,
    MAX_CAPACITY_MINUTES, MIN_CAPACITY_MINUTES, NotificationSettings, PlanningSettings,
    RESERVED_BROWSER_CHORDS, SettingsPatch, TaskDefaults, Theme, TimeFormat, VolumePercent,
    is_reserved_browser_chord, normalize_chord,
};
// AiSettings/VoiceSettings are re-exported from `ai` above.
pub use task::{
    Task, TaskDraft, TaskStatus, UncompleteOutcome, recurrence_rule_uses_anchor,
    resolve_recurrence_anchor,
};
pub use text_import::{MAX_TEXT_IMPORT_CHARS, TextImportDraft, parse_text_import};
pub use timeblock::{
    CivilTimeRange, MAX_SLOT_MEMBERSHIP, MAX_TIMEBLOCK_RANGE_DAYS, MAX_TIMEBLOCK_RANGE_ITEMS,
    OrderedSlotMembership, REPLAN_LOOKBACK_DAYS, TimeBlock, TimeBlockDraft, TimeSlot,
    TimeSlotDraft, replan_window, validate_timeblock_date_range,
};
pub use transfer::{
    BACKUP_HEADER_LEN, BACKUP_MAGIC, BACKUP_VERSION, BackupError, BackupHeader, BackupManifest,
    ImportDraft, MAX_BACKUP_MANIFEST_BYTES, MAX_BACKUP_PAYLOAD_BYTES, MAX_TRANSFER_CONTENT_BYTES,
    TransferApply, TransferError, TransferFormat, TransferPreview, TransferWarning,
    content_fingerprint, decode_sha256_hex, draft_to_task_fields, export_tasks_csv,
    export_tasks_csv_with_names, export_tasks_json, export_tasks_markdown, frame_backup_envelope,
    parse_backup_envelope, parse_csv_transfer, parse_json_transfer, parse_markdown_transfer,
    parse_todoist_json, preview_transfer, read_backup_header, sha256_bytes, sha256_hex,
    validate_backup_header, validate_preview_matches_apply, write_backup_header,
};
pub use values::{
    ActualMinutes, CommentBody, DreadLevel, EntityName, EstimatedMinutes, FilterQuery, HexColor,
    IconText, LocalDueTime, MAX_BULK_IDS, MAX_ENTITY_NAME_CHARS, MAX_ICON_CHARS,
    MAX_MARKDOWN_CHARS, MAX_QUERY_PAGE_LIMIT, MAX_RECURRENCE_RULE_CHARS, MAX_TAG_NAME_CHARS,
    MAX_TAGS_PER_TASK, MAX_TASK_TITLE_CHARS, MAX_TIMEZONE_NAME_CHARS, MarkdownText, Priority,
    ProjectView, RecurrenceRule, RelationKind, SortOrder, TagName, TaskTitle, TimeZoneName,
};

use thiserror::Error;

/// Structured validation failure suitable for application and HTTP field mapping.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ValidationError {
    #[error("{field} must be a UUID")]
    InvalidId { field: &'static str },
    #[error("title must not be empty")]
    EmptyTitle,
    #[error("title must contain at most {max} characters")]
    TitleTooLong { max: usize },
    #[error("{field} must not be empty")]
    Empty { field: &'static str },
    #[error("{field} must contain at most {max} characters")]
    TooLong { field: &'static str, max: usize },
    #[error("{field} must be at least {min}")]
    TooSmall { field: &'static str, min: i64 },
    #[error("{field} must be between {min} and {max}")]
    OutOfRange {
        field: &'static str,
        min: i64,
        max: i64,
    },
    #[error("{field} must match {expected}")]
    InvalidFormat {
        field: &'static str,
        expected: &'static str,
    },
    #[error("{field} is invalid: {reason}")]
    Invalid {
        field: &'static str,
        reason: &'static str,
    },
    #[error("{field} contains {count} items; at most {max} are allowed")]
    TooMany {
        field: &'static str,
        count: usize,
        max: usize,
    },
    #[error("{field} contains duplicate values")]
    Duplicate { field: &'static str },
    #[error("{field} would create a cycle")]
    Cycle { field: &'static str },
    #[error("{field} is not a complete permutation of the expected scope")]
    IncompletePermutation { field: &'static str },
}

impl ValidationError {
    /// Primary request field associated with this error, for transport mapping.
    #[must_use]
    pub const fn field(&self) -> &'static str {
        match self {
            Self::InvalidId { field }
            | Self::Empty { field }
            | Self::TooLong { field, .. }
            | Self::TooSmall { field, .. }
            | Self::OutOfRange { field, .. }
            | Self::InvalidFormat { field, .. }
            | Self::Invalid { field, .. }
            | Self::TooMany { field, .. }
            | Self::Duplicate { field }
            | Self::Cycle { field }
            | Self::IncompletePermutation { field } => field,
            Self::EmptyTitle | Self::TitleTooLong { .. } => "title",
        }
    }
}
