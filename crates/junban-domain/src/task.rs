//! Task entity, status transitions, and draft construction.

use jiff::{Timestamp, civil::Date};
use serde::{Deserialize, Serialize};

use crate::{
    ActualMinutes, DreadLevel, EstimatedMinutes, LocalDueTime, MarkdownText, MonthlyAnchorDay,
    OperationId, Priority, ProjectId, RecurrenceRule, SectionId, SortOrder, TagId, TaskId,
    TaskTitle, ValidationError, values::MAX_TAGS_PER_TASK,
};

/// Result of ordinary uncomplete when durable completion authority is consulted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UncompleteOutcome {
    /// Retained receipt matched; source closure and generated children were reversed exactly.
    Exact,
    /// Receipt absent/expired/imported; only the requested source was reopened.
    SourceOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Completed,
    Cancelled,
}

/// Full set of mutable task fields used for create/update without huge positional constructors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskDraft {
    pub title: TaskTitle,
    #[serde(default = "MarkdownText::empty")]
    pub description: MarkdownText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_date: Option<Date>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_time: Option<LocalDueTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<Timestamp>,
    #[serde(default)]
    pub someday: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_minutes: Option<EstimatedMinutes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_minutes: Option<ActualMinutes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dread: Option<DreadLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ProjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_id: Option<SectionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<TaskId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_ids: Vec<TagId>,
    #[serde(default)]
    pub sort_order: SortOrder,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<RecurrenceRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remind_at: Option<Timestamp>,
    /// Explicit monthly/leap-day anchor. Reset on manual due/rule changes by callers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_anchor_day: Option<MonthlyAnchorDay>,
}

impl TaskDraft {
    pub fn new(title: TaskTitle) -> Self {
        Self {
            title,
            description: MarkdownText::empty(),
            priority: None,
            due_date: None,
            due_time: None,
            deadline: None,
            someday: false,
            estimated_minutes: None,
            actual_minutes: None,
            dread: None,
            project_id: None,
            section_id: None,
            parent_id: None,
            tag_ids: Vec::new(),
            sort_order: SortOrder::default(),
            recurrence_rule: None,
            remind_at: None,
            recurrence_anchor_day: None,
        }
    }

    fn validate_for(&self, task_id: TaskId) -> Result<(), ValidationError> {
        validate_tag_ids(&self.tag_ids)?;
        if self.parent_id == Some(task_id) {
            return Err(ValidationError::Invalid {
                field: "parent_id",
                reason: "a task cannot be its own parent",
            });
        }
        if self.section_id.is_some() && self.project_id.is_none() {
            return Err(ValidationError::Invalid {
                field: "section_id",
                reason: "a section requires a project",
            });
        }
        if self.due_time.is_some() && self.due_date.is_none() {
            return Err(ValidationError::Invalid {
                field: "due_time",
                reason: "due_time requires due_date",
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: TaskId,
    pub title: TaskTitle,
    #[serde(default = "MarkdownText::empty")]
    pub description: MarkdownText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    pub due_date: Option<Date>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_time: Option<LocalDueTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<Timestamp>,
    #[serde(default)]
    pub someday: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_minutes: Option<EstimatedMinutes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_minutes: Option<ActualMinutes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dread: Option<DreadLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ProjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_id: Option<SectionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<TaskId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_ids: Vec<TagId>,
    #[serde(default)]
    pub sort_order: SortOrder,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<RecurrenceRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remind_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_anchor_day: Option<MonthlyAnchorDay>,
    /// Historical lineage identity of a generated occurrence; never rewritten on patch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_source_id: Option<TaskId>,
    /// Operation that last completed this task; used by ordinary uncomplete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_operation_id: Option<OperationId>,
    pub status: TaskStatus,
    pub completed_at: Option<Timestamp>,
    /// Instant of the current transition into cancelled; cleared when reopened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancelled_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub revision: u64,
}

impl Task {
    /// Phase 1 constructor. New organization fields receive safe defaults.
    #[must_use]
    pub fn new(
        id: TaskId,
        title: TaskTitle,
        due_date: Option<Date>,
        now: Timestamp,
        revision: u64,
    ) -> Self {
        Self {
            id,
            title,
            description: MarkdownText::empty(),
            priority: None,
            due_date,
            due_time: None,
            deadline: None,
            someday: false,
            estimated_minutes: None,
            actual_minutes: None,
            dread: None,
            project_id: None,
            section_id: None,
            parent_id: None,
            tag_ids: Vec::new(),
            sort_order: SortOrder::default(),
            recurrence_rule: None,
            remind_at: None,
            recurrence_anchor_day: None,
            recurrence_source_id: None,
            completion_operation_id: None,
            status: TaskStatus::Pending,
            completed_at: None,
            cancelled_at: None,
            created_at: now,
            updated_at: now,
            revision,
        }
    }

    pub fn from_draft(
        id: TaskId,
        draft: TaskDraft,
        now: Timestamp,
        revision: u64,
    ) -> Result<Self, ValidationError> {
        draft.validate_for(id)?;
        let recurrence_anchor_day = resolve_recurrence_anchor(
            draft.recurrence_rule.as_ref(),
            draft.due_date,
            draft.recurrence_anchor_day,
        );
        Ok(Self {
            id,
            title: draft.title,
            description: draft.description,
            priority: draft.priority,
            due_date: draft.due_date,
            due_time: draft.due_time,
            deadline: draft.deadline,
            someday: draft.someday,
            estimated_minutes: draft.estimated_minutes,
            actual_minutes: draft.actual_minutes,
            dread: draft.dread,
            project_id: draft.project_id,
            section_id: draft.section_id,
            parent_id: draft.parent_id,
            tag_ids: draft.tag_ids,
            sort_order: draft.sort_order,
            recurrence_rule: draft.recurrence_rule,
            remind_at: draft.remind_at,
            recurrence_anchor_day,
            recurrence_source_id: None,
            completion_operation_id: None,
            status: TaskStatus::Pending,
            completed_at: None,
            cancelled_at: None,
            created_at: now,
            updated_at: now,
            revision,
        })
    }

    /// Phase 1 title/due replace. Organization fields are left untouched.
    pub fn replace(&mut self, title: TaskTitle, due_date: Option<Date>, now: Timestamp) {
        self.title = title;
        self.due_date = due_date;
        self.updated_at = now;
    }

    pub fn apply_draft(&mut self, draft: TaskDraft, now: Timestamp) -> Result<(), ValidationError> {
        draft.validate_for(self.id)?;
        let due_changed = self.due_date != draft.due_date || self.due_time != draft.due_time;
        let rule_changed = self.recurrence_rule != draft.recurrence_rule;
        self.title = draft.title;
        self.description = draft.description;
        self.priority = draft.priority;
        self.due_date = draft.due_date;
        self.due_time = draft.due_time;
        self.deadline = draft.deadline;
        self.someday = draft.someday;
        self.estimated_minutes = draft.estimated_minutes;
        self.actual_minutes = draft.actual_minutes;
        self.dread = draft.dread;
        self.project_id = draft.project_id;
        self.section_id = draft.section_id;
        self.parent_id = draft.parent_id;
        self.tag_ids = draft.tag_ids;
        self.sort_order = draft.sort_order;
        self.recurrence_rule = draft.recurrence_rule;
        self.remind_at = draft.remind_at;
        if due_changed || rule_changed {
            // Manual due/rule edits reset the monthly/yearly anchor; lineage source stays.
            self.recurrence_anchor_day =
                resolve_recurrence_anchor(self.recurrence_rule.as_ref(), self.due_date, None);
        } else if draft.recurrence_anchor_day.is_some() {
            self.recurrence_anchor_day = draft.recurrence_anchor_day;
        }
        self.updated_at = now;
        Ok(())
    }

    pub fn complete(&mut self, now: Timestamp) {
        self.status = TaskStatus::Completed;
        self.completed_at = Some(now);
        self.cancelled_at = None;
        self.updated_at = now;
    }

    /// Complete only from pending. Invalid transitions return [`ValidationError::Invalid`].
    pub fn try_complete(&mut self, now: Timestamp) -> Result<(), ValidationError> {
        match self.status {
            TaskStatus::Pending => {
                self.complete(now);
                Ok(())
            }
            TaskStatus::Completed | TaskStatus::Cancelled => Err(ValidationError::Invalid {
                field: "status",
                reason: "only pending tasks can be completed",
            }),
        }
    }

    pub fn uncomplete(&mut self, now: Timestamp) {
        self.status = TaskStatus::Pending;
        self.completed_at = None;
        self.cancelled_at = None;
        self.updated_at = now;
    }

    /// Uncomplete only from completed.
    pub fn try_uncomplete(&mut self, now: Timestamp) -> Result<(), ValidationError> {
        match self.status {
            TaskStatus::Completed => {
                self.uncomplete(now);
                Ok(())
            }
            TaskStatus::Pending | TaskStatus::Cancelled => Err(ValidationError::Invalid {
                field: "status",
                reason: "only completed tasks can be uncompleted",
            }),
        }
    }

    pub fn cancel(&mut self, now: Timestamp) {
        self.status = TaskStatus::Cancelled;
        self.completed_at = None;
        self.cancelled_at = Some(now);
        self.updated_at = now;
    }

    /// Cancel only from pending.
    pub fn try_cancel(&mut self, now: Timestamp) -> Result<(), ValidationError> {
        match self.status {
            TaskStatus::Pending => {
                self.cancel(now);
                Ok(())
            }
            TaskStatus::Completed | TaskStatus::Cancelled => Err(ValidationError::Invalid {
                field: "status",
                reason: "only pending tasks can be cancelled",
            }),
        }
    }

    /// Return a cancelled or completed task to pending.
    pub fn reopen(&mut self, now: Timestamp) {
        self.status = TaskStatus::Pending;
        self.completed_at = None;
        self.cancelled_at = None;
        self.updated_at = now;
    }

    /// Reopen only from completed or cancelled.
    pub fn try_reopen(&mut self, now: Timestamp) -> Result<(), ValidationError> {
        match self.status {
            TaskStatus::Completed | TaskStatus::Cancelled => {
                self.reopen(now);
                Ok(())
            }
            TaskStatus::Pending => Err(ValidationError::Invalid {
                field: "status",
                reason: "only completed or cancelled tasks can be reopened",
            }),
        }
    }

    #[must_use]
    pub fn to_draft(&self) -> TaskDraft {
        TaskDraft {
            title: self.title.clone(),
            description: self.description.clone(),
            priority: self.priority,
            due_date: self.due_date,
            due_time: self.due_time.clone(),
            deadline: self.deadline,
            someday: self.someday,
            estimated_minutes: self.estimated_minutes,
            actual_minutes: self.actual_minutes,
            dread: self.dread,
            project_id: self.project_id,
            section_id: self.section_id,
            parent_id: self.parent_id,
            tag_ids: self.tag_ids.clone(),
            sort_order: self.sort_order,
            recurrence_rule: self.recurrence_rule.clone(),
            remind_at: self.remind_at,
            recurrence_anchor_day: self.recurrence_anchor_day,
        }
    }
}

/// Monthly/yearly anchors follow the due day; other rules and cleared recurrence drop it.
#[must_use]
pub fn resolve_recurrence_anchor(
    rule: Option<&RecurrenceRule>,
    due_date: Option<Date>,
    explicit: Option<MonthlyAnchorDay>,
) -> Option<MonthlyAnchorDay> {
    let rule = rule?;
    if !recurrence_rule_uses_anchor(rule) {
        return None;
    }
    if let Some(day) = explicit {
        return Some(day);
    }
    due_date.map(MonthlyAnchorDay::from_date)
}

#[must_use]
pub fn recurrence_rule_uses_anchor(rule: &RecurrenceRule) -> bool {
    matches!(rule.as_str(), "monthly" | "yearly")
}

pub(crate) fn validate_tag_ids(tag_ids: &[TagId]) -> Result<(), ValidationError> {
    if tag_ids.len() > MAX_TAGS_PER_TASK {
        return Err(ValidationError::TooMany {
            field: "tag_ids",
            count: tag_ids.len(),
            max: MAX_TAGS_PER_TASK,
        });
    }
    let mut seen = tag_ids.to_vec();
    seen.sort_by_key(|id| id.as_uuid());
    seen.dedup();
    if seen.len() != tag_ids.len() {
        return Err(ValidationError::Duplicate { field: "tag_ids" });
    }
    Ok(())
}
