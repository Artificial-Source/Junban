//! Explicit request and result shapes for Phase 2 use cases.

use jiff::{Timestamp, ToSpan, Zoned, civil::Date, tz::TimeZone};
use junban_domain::{
    ActualMinutes, CommentBody, DreadLevel, EntityName, EstimatedMinutes, FilterQuery, HexColor,
    IconText, LocalDueTime, MarkdownText, Priority, Project, ProjectId, ProjectView,
    RecurrenceRule, SavedFilter, Section, SectionId, SortOrder, Tag, TagId, TagName, Task,
    TaskCursor, TaskId, TaskTitle, Template, TemplateId,
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
