//! Pure task entities, value objects, and validation rules for Junban.
//!
//! This crate deliberately has no knowledge of HTTP, SQLite, or async runtimes.

mod catalog;
mod ids;
mod invariants;
mod planning;
mod query;
mod quick_entry;
mod recurrence;
mod reminder;
mod task;
mod text_import;
mod timeblock;
mod values;

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
    CapacitySettings, DailyCapacityMinutes, MAX_NUDGE_TASKS_COMBINED, MAX_NUDGE_TASKS_PER_RULE,
    NudgeFacts, NudgeRuleFacts, NudgeRuleKind, NudgeRuleSettings, WeekStart, WorkHours,
};
pub use query::{
    MAX_FILTER_INPUT_CHARS, TaskCursor, TaskFilter, TaskQuery, TaskSort, TaskViewPreset,
    parse_filter, validate_page_limit,
};
pub use quick_entry::{MAX_QUICK_ENTRY_CHARS, QuickEntry, parse_quick_entry};
pub use recurrence::{
    MonthlyAnchorDay, NextOccurrence, NextOccurrenceRequest, OccurrenceAbsoluteOffsets,
    RecurrenceSource, next_occurrence, resolve_due_instant, shift_occurrence_absolutes,
};
pub use reminder::{
    ClaimedReminder, DEFAULT_REMINDER_CLAIM_LIMIT, DEFAULT_REMINDER_CLAIM_SECS,
    DEFAULT_REMINDER_LEASE_SECS, MAX_OWNER_LOST_MARK_LIMIT, MAX_REMINDER_CLAIM_LIMIT,
    MAX_REMINDER_LEASE_SECS, REMINDER_FAILURE_BACKOFF_MAX_SECS,
    REMINDER_FAILURE_BACKOFF_START_SECS, ReminderChannel, ReminderChannelSet,
    ReminderDeliveryLease, ReminderFailureCode, ReminderFenceTerm, ReminderLeadMinutes,
    ReminderOccurrence, ReminderOccurrenceState, ReminderSettings, reminder_failure_backoff,
    reminder_occurrence_key, validate_owner_lost_mark_limit, validate_reminder_claim_limit,
    validate_reminder_lease_secs,
};
pub use task::{
    Task, TaskDraft, TaskStatus, UncompleteOutcome, recurrence_rule_uses_anchor,
    resolve_recurrence_anchor,
};
pub use text_import::{MAX_TEXT_IMPORT_CHARS, TextImportDraft, parse_text_import};
pub use timeblock::{
    CivilTimeRange, MAX_SLOT_MEMBERSHIP, OrderedSlotMembership, TimeBlockDraft, TimeSlotDraft,
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
