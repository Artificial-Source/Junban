//! Explicit request and result shapes for Phase 2 use cases.

use jiff::{
    Timestamp, ToSpan, Zoned,
    civil::{Date, Time},
    tz::TimeZone,
};
use junban_domain::{
    ActualMinutes, CivilTimeRange, CommentBody, DailyPlanSummary, DreadLevel, EndOfDaySummary,
    EntityName, EstimatedMinutes, FilterQuery, HexColor, IconText, LocalDueTime, MarkdownText,
    NudgeFacts, Priority, Project, ProjectId, ProjectView, RecurrenceRule, SavedFilter, Section,
    SectionId, SortOrder, StatsSummary, Tag, TagId, TagName, Task, TaskCursor, TaskId, TaskTitle,
    Template, TemplateId, TimeBlock, TimeBlockId, TimeSlot, TimeSlotId, TimeZoneName, WeekStart,
    WeeklyReviewSummary,
};

pub use junban_domain::{
    AppSettings, SettingsPatch, TransferApply, TransferFormat, TransferPreview,
};
use serde::{Deserialize, Serialize};

pub const ACTIVITY_PAGE_DEFAULT: u32 = 50;
pub const ACTIVITY_PAGE_MAX: u32 = 100;

/// Partial task update. `None` leaves a field unchanged; `Some(None)` clears nullable fields.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<TaskTitle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<MarkdownText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Option<Priority>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_date: Option<Option<Date>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_time: Option<Option<LocalDueTime>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<Option<Timestamp>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub someday: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_minutes: Option<Option<EstimatedMinutes>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_minutes: Option<Option<ActualMinutes>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dread: Option<Option<DreadLevel>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Option<ProjectId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_id: Option<Option<SectionId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Option<TaskId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_ids: Option<Vec<TagId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<SortOrder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<Option<RecurrenceRule>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remind_at: Option<Option<Timestamp>>,
    /// When set with a due/rule change, callers usually leave this `None` so storage resets it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_anchor_day: Option<Option<junban_domain::MonthlyAnchorDay>>,
}

/// One sampled server-local civil day and zone for temporal mutations.
///
/// Constructed at the use-case boundary (or with an explicit test sample). Domain and
/// storage code never read the system clock independently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemporalContext {
    pub sampled_completion_date: Date,
    pub server_time_zone: TimeZone,
}

impl TemporalContext {
    /// Sample once from the host zone via Jiff `tz-system`.
    pub fn sample_now() -> Self {
        let now = Zoned::now();
        Self {
            sampled_completion_date: now.date(),
            server_time_zone: now.time_zone().clone(),
        }
    }

    /// Deterministic internal/test seam.
    #[must_use]
    pub fn new(sampled_completion_date: Date, server_time_zone: TimeZone) -> Self {
        Self {
            sampled_completion_date,
            server_time_zone,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderAnchor {
    /// Leave sort_order unchanged.
    #[default]
    Keep,
    First,
    Last,
    Before {
        task_id: TaskId,
    },
    After {
        task_id: TaskId,
    },
}

/// Hierarchy/scope move with an explicit order anchor. Omitted fields keep current values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveTarget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Option<TaskId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Option<ProjectId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_id: Option<Option<SectionId>>,
    #[serde(default)]
    pub order: OrderAnchor,
}

/// One sibling/project/section scope for a complete reorder permutation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReorderScope {
    /// `None` = any/unspecified project filter is not used; scope is explicit:
    /// `project_id = Some(None)` means unprojected roots when combined with parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Option<ProjectId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_id: Option<Option<SectionId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Option<TaskId>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkSchedule {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_date: Option<Option<Date>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_time: Option<Option<LocalDueTime>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<Option<Timestamp>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub someday: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkTagChange {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add: Vec<TagId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove: Vec<TagId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum BulkAction {
    Complete,
    Uncomplete,
    Cancel,
    Reopen,
    Delete,
    Move { target: MoveTarget },
    Tag { change: BulkTagChange },
    Schedule { schedule: BulkSchedule },
    Priority { priority: Option<Priority> },
}

/// Server-local evaluation context for one task list request.
///
/// `as_of_date` is the local civil day used for due/overdue views. The recent-
/// completion timestamps are the exact UTC half-open window covering that local
/// day and the previous 13 local days (14 local civil days total), computed from
/// one zoned clock sample so DST transitions stay correct.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskListAsOf {
    pub as_of_date: Date,
    /// Inclusive lower UTC bound for Inbox recent completions.
    pub recent_completed_from: Timestamp,
    /// Exclusive upper UTC bound for Inbox recent completions.
    pub recent_completed_until: Timestamp,
}

impl TaskListAsOf {
    /// Build bounds from one local [`Zoned`] clock sample.
    pub fn from_zoned(now: &Zoned) -> Result<Self, junban_domain::ValidationError> {
        Self::for_local_date(now.date(), now.time_zone())
    }

    /// Build bounds for a local civil date in the given time zone.
    pub fn for_local_date(
        as_of_date: Date,
        time_zone: &TimeZone,
    ) -> Result<Self, junban_domain::ValidationError> {
        let first_recent = as_of_date.checked_sub(13.days()).map_err(|_| {
            junban_domain::ValidationError::Invalid {
                field: "as_of_date",
                reason: "date underflow computing recent-completion window",
            }
        })?;
        let next_local_day = as_of_date.checked_add(1.day()).map_err(|_| {
            junban_domain::ValidationError::Invalid {
                field: "as_of_date",
                reason: "date overflow computing recent-completion window",
            }
        })?;
        let recent_completed_from = first_recent
            .to_zoned(time_zone.clone())
            .map_err(|_| junban_domain::ValidationError::Invalid {
                field: "as_of_date",
                reason: "could not resolve local day start to a timestamp",
            })?
            .timestamp();
        let recent_completed_until = next_local_day
            .to_zoned(time_zone.clone())
            .map_err(|_| junban_domain::ValidationError::Invalid {
                field: "as_of_date",
                reason: "could not resolve next local day start to a timestamp",
            })?
            .timestamp();
        Ok(Self {
            as_of_date,
            recent_completed_from,
            recent_completed_until,
        })
    }
}

#[cfg(test)]
mod task_list_as_of_tests {
    use super::*;
    use jiff::tz;

    #[test]
    fn negative_offset_keeps_local_evening_completion_inside_window() {
        // UTC-06: local 2026-07-29 18:00 is 2026-07-30T00:00Z — UTC date already rolled.
        let tz = TimeZone::fixed(tz::offset(-6));
        let as_of = TaskListAsOf::for_local_date("2026-07-29".parse().unwrap(), &tz).unwrap();
        assert_eq!(as_of.as_of_date.to_string(), "2026-07-29");
        assert_eq!(
            as_of.recent_completed_from.to_string(),
            "2026-07-16T06:00:00Z"
        );
        assert_eq!(
            as_of.recent_completed_until.to_string(),
            "2026-07-30T06:00:00Z"
        );
        let local_evening: Timestamp = "2026-07-30T00:00:00Z".parse().unwrap();
        assert!(local_evening >= as_of.recent_completed_from);
        assert!(local_evening < as_of.recent_completed_until);
        let just_before: Timestamp = "2026-07-16T05:59:59Z".parse().unwrap();
        let at_end: Timestamp = "2026-07-30T06:00:00Z".parse().unwrap();
        assert!(just_before < as_of.recent_completed_from);
        assert!(at_end >= as_of.recent_completed_until);
    }

    #[test]
    fn positive_offset_keeps_local_morning_completion_inside_window() {
        // UTC+12: local 2026-07-29 01:00 is 2026-07-28T13:00Z — UTC date still yesterday.
        let tz = TimeZone::fixed(tz::offset(12));
        let as_of = TaskListAsOf::for_local_date("2026-07-29".parse().unwrap(), &tz).unwrap();
        assert_eq!(
            as_of.recent_completed_from.to_string(),
            "2026-07-15T12:00:00Z"
        );
        assert_eq!(
            as_of.recent_completed_until.to_string(),
            "2026-07-29T12:00:00Z"
        );
        let local_morning: Timestamp = "2026-07-28T13:00:00Z".parse().unwrap();
        assert!(local_morning >= as_of.recent_completed_from);
        assert!(local_morning < as_of.recent_completed_until);
        let just_before: Timestamp = "2026-07-15T11:59:59Z".parse().unwrap();
        let at_end: Timestamp = "2026-07-29T12:00:00Z".parse().unwrap();
        assert!(just_before < as_of.recent_completed_from);
        assert!(at_end >= as_of.recent_completed_until);
    }

    #[test]
    fn from_zoned_uses_the_sample_date_and_zone() {
        let now = Date::constant(2026, 7, 29)
            .at(18, 30, 0, 0)
            .to_zoned(TimeZone::fixed(tz::offset(-6)))
            .unwrap();
        let as_of = TaskListAsOf::from_zoned(&now).unwrap();
        assert_eq!(as_of.as_of_date, Date::constant(2026, 7, 29));
        assert_eq!(
            as_of.recent_completed_until.to_string(),
            "2026-07-30T06:00:00Z"
        );
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskListPage {
    pub tasks: Vec<Task>,
    pub revision: u64,
    pub as_of_date: Date,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<TaskCursor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogSnapshot {
    pub projects: Vec<Project>,
    pub sections: Vec<Section>,
    pub tags: Vec<Tag>,
    pub templates: Vec<Template>,
    pub saved_filters: Vec<SavedFilter>,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectDraft {
    pub name: EntityName,
    pub color: HexColor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<IconText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<ProjectId>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub view: ProjectView,
    #[serde(default)]
    pub sort_order: SortOrder,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<EntityName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<HexColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<Option<IconText>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Option<ProjectId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<ProjectView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<SortOrder>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SectionDraft {
    pub project_id: ProjectId,
    pub name: EntityName,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub sort_order: SortOrder,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SectionPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<EntityName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapsed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<SortOrder>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagDraft {
    pub name: TagName,
    pub color: HexColor,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<TagName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<HexColor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateDraft {
    pub name: EntityName,
    pub title: TaskTitle,
    #[serde(default = "MarkdownText::empty")]
    pub description: MarkdownText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_names: Vec<TagName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ProjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<RecurrenceRule>,
    #[serde(default)]
    pub sort_order: SortOrder,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplatePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<EntityName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<TaskTitle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<MarkdownText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Option<Priority>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_names: Option<Vec<TagName>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Option<ProjectId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<Option<RecurrenceRule>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<SortOrder>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateApply {
    pub template_id: TemplateId,
    /// Placeholder values keyed by name without braces.
    #[serde(default)]
    pub variables: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedFilterDraft {
    pub name: EntityName,
    pub query: FilterQuery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<HexColor>,
    #[serde(default)]
    pub sort_order: SortOrder,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedFilterPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<EntityName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<FilterQuery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Option<HexColor>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<SortOrder>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<CommentBody>,
}

/// User-facing reminder schedule change. Reuses `Task.remind_at` as the intent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RescheduleReminder {
    pub task_id: TaskId,
    pub remind_at: Timestamp,
}

/// Clear the task reminder schedule and cancel any still-pending occurrence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DismissReminder {
    pub task_id: TaskId,
}

/// Acquire or renew parameters for the single global delivery lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReminderLeaseRequest {
    /// Positive bounded TTL in seconds. Defaults are applied by the service when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_secs: Option<u64>,
}

/// Claim due pending occurrences under the caller's current fence term.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimRemindersRequest {
    pub fence_term: junban_domain::ReminderFenceTerm,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_secs: Option<u64>,
}

/// Settle one claimed occurrence as delivered on an allowlisted channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettleReminderDelivered {
    pub fence_term: junban_domain::ReminderFenceTerm,
    pub task_id: TaskId,
    pub remind_at: Timestamp,
    /// Exact generation returned by the successful claim for this occurrence.
    pub claim_attempt: u32,
    pub channel: junban_domain::ReminderChannel,
}

/// Settle one claimed occurrence as failed with a bounded error code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettleReminderFailed {
    pub fence_term: junban_domain::ReminderFenceTerm,
    pub task_id: TaskId,
    pub remind_at: Timestamp,
    /// Exact generation returned by the successful claim for this occurrence.
    pub claim_attempt: u32,
    pub error: junban_domain::ReminderFailureCode,
}

/// Mark expired claimed rows `failed/owner_lost` under the new valid owner term.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkOwnerLostReminders {
    pub fence_term: junban_domain::ReminderFenceTerm,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// Partial civil range update for an existing time block.
///
/// Omitted values retain durable owner state; in particular, an omitted timezone
/// must never be replaced with the server timezone.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeBlockRangePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<Date>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<Time>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<Time>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<TimeZoneName>,
}

/// Partial time-block update. `None` leaves a field unchanged; `Some(None)` clears nullable fields.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeBlockPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<EntityName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<TimeBlockRangePatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Option<HexColor>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<Option<TaskId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_id: Option<Option<TimeSlotId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<Option<RecurrenceRule>>,
}

/// Partial time-slot update.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeSlotPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<EntityName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<CivilTimeRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Option<HexColor>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Option<ProjectId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<Option<RecurrenceRule>>,
}

/// Inclusive civil-date range for first-party blocks and slots.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeblockingRangeQuery {
    pub from: Date,
    pub to: Date,
}

/// Bounded range read of series-owner blocks and slots.
///
/// Storage returns durable owners only (including earlier recurring owners that may
/// expand into the window). The app service expands recurring owners into virtual
/// instances before returning this page to HTTP callers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeblockingRangePage {
    pub blocks: Vec<TimeBlock>,
    pub slots: Vec<TimeSlot>,
    pub revision: u64,
}

/// Server-derived, bounded candidates for automatic replan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplanPastBlocksPreview {
    pub as_of_date: Date,
    pub candidate_ids: Vec<TimeBlockId>,
    pub blocks: Vec<TimeBlock>,
}

/// Automatic replan action for unlocked blocks in the prior seven civil days.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplanPastBlocksAction {
    MoveToToday,
    MoveToTomorrow,
    Delete,
}

/// Tasks collected across cursor pages under one sampled list context and revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectedTasks {
    pub tasks: Vec<Task>,
    pub revision: u64,
    pub as_of_date: Date,
}

/// Bounded calendar range read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalendarTasksPage {
    pub tasks: Vec<Task>,
    pub revision: u64,
}

/// Plan-My-Day read model with embedded task bodies for listed IDs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DailyPlanPage {
    pub overdue_task_ids: Vec<TaskId>,
    pub overdue_tasks: Vec<Task>,
    pub focus_task_ids: Vec<TaskId>,
    pub focus_tasks: Vec<Task>,
    pub estimated_total_minutes: u32,
    pub capacity_minutes: u32,
    pub revision: u64,
}

impl DailyPlanPage {
    pub(crate) fn from_summary(summary: DailyPlanSummary, tasks: &[Task], revision: u64) -> Self {
        Self {
            overdue_tasks: tasks_for_ids(tasks, &summary.overdue_task_ids),
            focus_tasks: tasks_for_ids(tasks, &summary.focus_task_ids),
            overdue_task_ids: summary.overdue_task_ids,
            focus_task_ids: summary.focus_task_ids,
            estimated_total_minutes: summary.estimated_total_minutes,
            capacity_minutes: summary.capacity_minutes,
            revision,
        }
    }
}

/// End-of-Day read model with embedded task bodies for listed IDs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EndOfDayPage {
    pub win_task_ids: Vec<TaskId>,
    pub win_tasks: Vec<Task>,
    pub carry_over_task_ids: Vec<TaskId>,
    pub carry_over_tasks: Vec<Task>,
    pub tomorrow_task_ids: Vec<TaskId>,
    pub tomorrow_tasks: Vec<Task>,
    pub tomorrow_estimated_minutes: u32,
    pub completion_rate_percent: u32,
    pub capacity_minutes: u32,
    pub revision: u64,
}

impl EndOfDayPage {
    pub(crate) fn from_summary(
        summary: EndOfDaySummary,
        tasks: &[Task],
        capacity_minutes: u32,
        revision: u64,
    ) -> Self {
        Self {
            win_tasks: tasks_for_ids(tasks, &summary.win_task_ids),
            carry_over_tasks: tasks_for_ids(tasks, &summary.carry_over_task_ids),
            tomorrow_tasks: tasks_for_ids(tasks, &summary.tomorrow_task_ids),
            win_task_ids: summary.win_task_ids,
            carry_over_task_ids: summary.carry_over_task_ids,
            tomorrow_task_ids: summary.tomorrow_task_ids,
            tomorrow_estimated_minutes: summary.tomorrow_estimated_minutes,
            completion_rate_percent: summary.completion_rate_percent,
            capacity_minutes,
            revision,
        }
    }
}

/// Weekly review facts plus embedded bodies for bounded ID lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WeeklyReviewPage {
    pub summary: WeeklyReviewSummary,
    pub top_accomplishment_tasks: Vec<Task>,
    pub overdue_tasks: Vec<Task>,
    pub revision: u64,
}

/// Stats range aggregates plus revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatsPage {
    pub summary: StatsSummary,
    pub revision: u64,
}

/// Nudge facts plus embedded bodies for referenced task IDs only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NudgesPage {
    pub facts: NudgeFacts,
    pub tasks: Vec<Task>,
    pub revision: u64,
}

/// Compatibility projection of the settings aggregate for Phase 3 temporal callers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemporalSettings {
    pub time_zone: String,
    pub capacity_minutes: u32,
    pub week_start: WeekStart,
    pub nudges_enabled: bool,
    pub eat_the_frog_enabled: bool,
    pub task_jar_enabled: bool,
}

impl TemporalSettings {
    /// Project persisted settings plus the currently sampled system IANA zone.
    ///
    /// `time_zone` is not a user-persisted authority; callers must pass the live
    /// server-local/system zone name.
    #[must_use]
    pub fn from_app_settings(settings: &AppSettings, time_zone: impl Into<String>) -> Self {
        Self {
            time_zone: time_zone.into(),
            capacity_minutes: settings.planning.capacity_minutes,
            week_start: settings.date_time.week_start,
            nudges_enabled: settings.features.nudges_enabled,
            eat_the_frog_enabled: settings.features.eat_the_frog_enabled,
            task_jar_enabled: settings.features.task_jar_enabled,
        }
    }
}

/// Eat-the-Frog selection (single task or none).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EatTheFrogPage {
    pub task: Option<Task>,
    pub revision: u64,
}

/// Task Jar candidates in stable domain order (browser picks randomly).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskJarPage {
    pub task_ids: Vec<TaskId>,
    pub tasks: Vec<Task>,
    pub revision: u64,
}

/// Dopamine Menu candidates in stable domain order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DopamineMenuPage {
    pub task_ids: Vec<TaskId>,
    pub tasks: Vec<Task>,
    pub revision: u64,
}

fn tasks_for_ids(tasks: &[Task], ids: &[TaskId]) -> Vec<Task> {
    ids.iter()
        .filter_map(|id| tasks.iter().find(|task| task.id == *id).cloned())
        .collect()
}

/// Helper constructors used by tests and thin service wrappers.
impl TimeBlockPatch {
    #[must_use]
    pub fn range_only(range: CivilTimeRange) -> Self {
        Self {
            range: Some(TimeBlockRangePatch {
                date: Some(range.date),
                start: Some(range.start),
                end: Some(range.end),
                time_zone: Some(range.time_zone),
            }),
            ..Self::default()
        }
    }
}

/// Preview a transfer import without writing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportPreviewRequest {
    pub format: TransferFormat,
    pub content: String,
}

/// Apply a previously previewed transfer import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportApplyRequest {
    pub format: TransferFormat,
    pub content: String,
    pub fingerprint: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub project_name_mapping: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_name_mapping: Vec<(String, String)>,
}

impl ImportApplyRequest {
    #[must_use]
    pub fn into_apply(self) -> TransferApply {
        TransferApply {
            format: self.format,
            content: self.content,
            fingerprint: self.fingerprint,
            project_name_mapping: self.project_name_mapping,
            tag_name_mapping: self.tag_name_mapping,
        }
    }
}

/// Export format for task transfer downloads (`todoist_json` is import-only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Json,
    Csv,
    Markdown,
}

impl ExportFormat {
    pub fn parse(value: &str) -> Result<Self, junban_domain::TransferError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "json" => Ok(Self::Json),
            "csv" => Ok(Self::Csv),
            "markdown" | "md" => Ok(Self::Markdown),
            _ => Err(junban_domain::TransferError::UnsupportedFormat),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Csv => "csv",
            Self::Markdown => "markdown",
        }
    }

    #[must_use]
    pub const fn content_type(self) -> &'static str {
        match self {
            Self::Json => "application/json; charset=utf-8",
            Self::Csv => "text/csv; charset=utf-8",
            Self::Markdown => "text/markdown; charset=utf-8",
        }
    }

    #[must_use]
    pub const fn file_name(self) -> &'static str {
        match self {
            Self::Json => "junban-tasks.json",
            Self::Csv => "junban-tasks.csv",
            Self::Markdown => "junban-tasks.md",
        }
    }
}
