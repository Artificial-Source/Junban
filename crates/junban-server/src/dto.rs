//! Explicit transport DTOs. Domain and repository types are never leaked by accident.

use jiff::{Timestamp, civil::Date, civil::Time};
use junban_app::{
    AffectedIds, BulkAction, BulkSchedule, BulkTagChange, CatalogSnapshot, CommittedEvent,
    CommittedMutation, MoveTarget, OrderAnchor, ProjectDraft, ProjectPatch, ReorderScope,
    ResourceRef, ResourceSnapshot, ResourceType, ResyncScope, SavedFilterDraft, SavedFilterPatch,
    SectionDraft, SectionPatch, TagDraft, TagPatch, TaskListPage, TaskPatch, TemplateApply,
    TemplateDraft, TemplatePatch, TimeBlockPatch, TimeSlotPatch,
};
use junban_domain::{
    ActualMinutes, CivilTimeRange, Comment, CompletionTimeBucket, CompletionTimeBuckets,
    DailyStatBucket, DreadLevel, EntityName, EstimatedMinutes, FilterQuery, HexColor, IconText,
    LocalDueTime, MarkdownText, NeglectedProjectFact, NeglectedProjectReason, NudgeFacts,
    NudgeRuleFacts, NudgeRuleKind, Priority, Project, ProjectId, ProjectView, QuickEntry,
    RecurrenceRule, RelationKind, SavedFilter, Section, SectionId, SortOrder, StatsSummary, Tag,
    TagId, TagName, Task, TaskActivity, TaskActivityAction, TaskDraft, TaskId, TaskQuery,
    TaskRelation, TaskSort, TaskStatus, TaskTitle, TaskViewPreset, Template, TemplateId,
    TextImportDraft, TimeBlock, TimeBlockDraft, TimeSlot, TimeSlotDraft, TimeSlotId, TimeZoneName,
    ValidationError, WeekStart, WeeklyDayStats, WeeklyReviewSummary, WeeklySuggestion,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::RequestId;
use crate::cursor::encode_task_cursor;
use crate::error::{ApiError, validation_error};

// ── shared primitives ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatusDto {
    Pending,
    Completed,
    Cancelled,
}

impl From<TaskStatus> for TaskStatusDto {
    fn from(value: TaskStatus) -> Self {
        match value {
            TaskStatus::Pending => Self::Pending,
            TaskStatus::Completed => Self::Completed,
            TaskStatus::Cancelled => Self::Cancelled,
        }
    }
}

impl From<TaskStatusDto> for TaskStatus {
    fn from(value: TaskStatusDto) -> Self {
        match value {
            TaskStatusDto::Pending => Self::Pending,
            TaskStatusDto::Completed => Self::Completed,
            TaskStatusDto::Cancelled => Self::Cancelled,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskSortDto {
    SortOrderAsc,
    CreatedAsc,
    CreatedDesc,
    UpdatedDesc,
    DueAsc,
    DueDesc,
    PriorityAsc,
    TitleAsc,
}

impl From<TaskSortDto> for TaskSort {
    fn from(value: TaskSortDto) -> Self {
        match value {
            TaskSortDto::SortOrderAsc => Self::SortOrderAsc,
            TaskSortDto::CreatedAsc => Self::CreatedAsc,
            TaskSortDto::CreatedDesc => Self::CreatedDesc,
            TaskSortDto::UpdatedDesc => Self::UpdatedDesc,
            TaskSortDto::DueAsc => Self::DueAsc,
            TaskSortDto::DueDesc => Self::DueDesc,
            TaskSortDto::PriorityAsc => Self::PriorityAsc,
            TaskSortDto::TitleAsc => Self::TitleAsc,
        }
    }
}

impl From<TaskSort> for TaskSortDto {
    fn from(value: TaskSort) -> Self {
        match value {
            TaskSort::SortOrderAsc => Self::SortOrderAsc,
            TaskSort::CreatedAsc => Self::CreatedAsc,
            TaskSort::CreatedDesc => Self::CreatedDesc,
            TaskSort::UpdatedDesc => Self::UpdatedDesc,
            TaskSort::DueAsc => Self::DueAsc,
            TaskSort::DueDesc => Self::DueDesc,
            TaskSort::PriorityAsc => Self::PriorityAsc,
            TaskSort::TitleAsc => Self::TitleAsc,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskViewPresetDto {
    Inbox,
    Today,
    Upcoming,
    Someday,
    Completed,
    Cancelled,
    Project,
}

impl From<TaskViewPresetDto> for TaskViewPreset {
    fn from(value: TaskViewPresetDto) -> Self {
        match value {
            TaskViewPresetDto::Inbox => Self::Inbox,
            TaskViewPresetDto::Today => Self::Today,
            TaskViewPresetDto::Upcoming => Self::Upcoming,
            TaskViewPresetDto::Someday => Self::Someday,
            TaskViewPresetDto::Completed => Self::Completed,
            TaskViewPresetDto::Cancelled => Self::Cancelled,
            TaskViewPresetDto::Project => Self::Project,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectViewDto {
    List,
    Board,
    Calendar,
}

impl From<ProjectView> for ProjectViewDto {
    fn from(value: ProjectView) -> Self {
        match value {
            ProjectView::List => Self::List,
            ProjectView::Board => Self::Board,
            ProjectView::Calendar => Self::Calendar,
        }
    }
}

impl From<ProjectViewDto> for ProjectView {
    fn from(value: ProjectViewDto) -> Self {
        match value {
            ProjectViewDto::List => Self::List,
            ProjectViewDto::Board => Self::Board,
            ProjectViewDto::Calendar => Self::Calendar,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LocalDueTimeDto {
    /// Civil wall-clock time `HH:MM[:SS]`.
    pub time: String,
    pub time_zone: String,
}

impl LocalDueTimeDto {
    fn try_into_domain(self) -> Result<LocalDueTime, ValidationError> {
        LocalDueTime::parse(&self.time, &self.time_zone)
    }
}

impl From<&LocalDueTime> for LocalDueTimeDto {
    fn from(value: &LocalDueTime) -> Self {
        Self {
            time: value.time.to_string(),
            time_zone: value.time_zone.as_str().to_owned(),
        }
    }
}

// ── task resources ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TaskDto {
    #[schema(value_type = String, format = Uuid)]
    pub id: String,
    pub title: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<u8>,
    #[schema(value_type = Option<String>, format = Date, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<Date>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_time: Option<LocalDueTimeDto>,
    #[schema(value_type = Option<String>, format = DateTime, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline: Option<Timestamp>,
    #[schema(value_type = Option<String>, format = DateTime, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remind_at: Option<Timestamp>,
    pub someday: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_minutes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_minutes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dread: Option<u8>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_id: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub tag_ids: Vec<String>,
    pub sort_order: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<String>,
    pub status: TaskStatusDto,
    #[schema(value_type = Option<String>, format = DateTime, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<Timestamp>,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
    pub revision: u64,
}

impl From<Task> for TaskDto {
    fn from(task: Task) -> Self {
        Self {
            id: task.id.to_string(),
            title: task.title.to_string(),
            description: task.description.to_string(),
            priority: task.priority.map(Priority::get),
            due_date: task.due_date,
            due_time: task.due_time.as_ref().map(Into::into),
            deadline: task.deadline,
            remind_at: task.remind_at,
            someday: task.someday,
            estimated_minutes: task.estimated_minutes.map(EstimatedMinutes::get),
            actual_minutes: task.actual_minutes.map(ActualMinutes::get),
            dread: task.dread.map(DreadLevel::get),
            project_id: task.project_id.map(|id| id.to_string()),
            section_id: task.section_id.map(|id| id.to_string()),
            parent_id: task.parent_id.map(|id| id.to_string()),
            tag_ids: task.tag_ids.iter().map(ToString::to_string).collect(),
            sort_order: task.sort_order.get(),
            recurrence_rule: task.recurrence_rule.map(|rule| rule.to_string()),
            status: task.status.into(),
            completed_at: task.completed_at,
            created_at: task.created_at,
            updated_at: task.updated_at,
            revision: task.revision,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateTaskRequest {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Option<u8>,
    #[schema(value_type = Option<String>, format = Date, nullable = true)]
    #[serde(default)]
    pub due_date: Option<Date>,
    #[serde(default)]
    pub due_time: Option<LocalDueTimeDto>,
    #[schema(value_type = Option<String>, format = DateTime, nullable = true)]
    #[serde(default)]
    pub deadline: Option<Timestamp>,
    #[serde(default)]
    pub someday: bool,
    #[serde(default)]
    pub estimated_minutes: Option<u32>,
    #[serde(default)]
    pub actual_minutes: Option<u32>,
    #[serde(default)]
    pub dread: Option<u8>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(default)]
    pub project_id: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(default)]
    pub section_id: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub sort_order: Option<i64>,
    #[serde(default)]
    pub recurrence_rule: Option<String>,
}

impl CreateTaskRequest {
    pub fn into_draft(self, request_id: &RequestId) -> Result<TaskDraft, ApiError> {
        build_task_draft(
            self.title,
            self.description,
            self.priority,
            self.due_date,
            self.due_time,
            self.deadline,
            self.someday,
            self.estimated_minutes,
            self.actual_minutes,
            self.dread,
            self.project_id,
            self.section_id,
            self.parent_id,
            self.tag_ids,
            self.sort_order,
            self.recurrence_rule,
        )
        .map_err(|e| validation_error(e, request_id))
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PatchTaskRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// `null` clears priority; omit leaves unchanged.
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub priority: Option<Option<u8>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Date, nullable = true)]
    pub due_date: Option<Option<Date>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub due_time: Option<Option<LocalDueTimeDto>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = DateTime, nullable = true)]
    pub deadline: Option<Option<Timestamp>>,
    #[serde(default)]
    pub someday: Option<bool>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub estimated_minutes: Option<Option<u32>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub actual_minutes: Option<Option<u32>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub dread: Option<Option<u8>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub project_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub section_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub parent_id: Option<Option<String>>,
    #[serde(default)]
    pub tag_ids: Option<Vec<String>>,
    #[serde(default)]
    pub sort_order: Option<i64>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub recurrence_rule: Option<Option<String>>,
}

impl PatchTaskRequest {
    pub fn into_patch(self, request_id: &RequestId) -> Result<TaskPatch, ApiError> {
        Ok(TaskPatch {
            title: map_opt(self.title, TaskTitle::new, request_id)?,
            description: map_opt(self.description, MarkdownText::new, request_id)?,
            priority: map_opt_null(self.priority, Priority::new, request_id)?,
            due_date: self.due_date,
            due_time: map_opt_null(self.due_time, LocalDueTimeDto::try_into_domain, request_id)?,
            deadline: self.deadline,
            someday: self.someday,
            estimated_minutes: map_opt_null(
                self.estimated_minutes,
                EstimatedMinutes::new,
                request_id,
            )?,
            actual_minutes: map_opt_null(self.actual_minutes, ActualMinutes::new, request_id)?,
            dread: map_opt_null(self.dread, DreadLevel::new, request_id)?,
            project_id: map_opt_null(self.project_id, |s| ProjectId::parse(&s), request_id)?,
            section_id: map_opt_null(self.section_id, |s| SectionId::parse(&s), request_id)?,
            parent_id: map_opt_null(self.parent_id, |s| TaskId::parse(&s), request_id)?,
            tag_ids: match self.tag_ids {
                None => None,
                Some(ids) => Some(
                    ids.into_iter()
                        .map(|id| TagId::parse(&id))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| validation_error(e, request_id))?,
                ),
            },
            sort_order: self.sort_order.map(SortOrder::new),
            recurrence_rule: map_opt_null(self.recurrence_rule, RecurrenceRule::new, request_id)?,
            // Phase 3 remind/anchor fields are owned by a later server wave.
            ..TaskPatch::default()
        })
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TaskListResponse {
    pub tasks: Vec<TaskDto>,
    pub revision: u64,
    #[schema(value_type = String, format = Date)]
    pub as_of_date: Date,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl TaskListResponse {
    pub fn from_page(page: TaskListPage, sort: TaskSort) -> Result<Self, ValidationError> {
        let next_cursor = match page.next_cursor {
            Some(cursor) => Some(encode_task_cursor(sort, &cursor)?),
            None => None,
        };
        Ok(Self {
            tasks: page.tasks.into_iter().map(Into::into).collect(),
            revision: page.revision,
            as_of_date: page.as_of_date,
            next_cursor,
        })
    }
}

// ── move / reorder / bulk ──────────────────────────────────────────────────

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub enum OrderAnchorDto {
    Keep,
    First,
    Last,
    Before {
        #[schema(value_type = String, format = Uuid)]
        task_id: String,
    },
    After {
        #[schema(value_type = String, format = Uuid)]
        task_id: String,
    },
}

impl OrderAnchorDto {
    fn into_domain(self, request_id: &RequestId) -> Result<OrderAnchor, ApiError> {
        Ok(match self {
            Self::Keep => OrderAnchor::Keep,
            Self::First => OrderAnchor::First,
            Self::Last => OrderAnchor::Last,
            Self::Before { task_id } => OrderAnchor::Before {
                task_id: TaskId::parse(&task_id).map_err(|e| validation_error(e, request_id))?,
            },
            Self::After { task_id } => OrderAnchor::After {
                task_id: TaskId::parse(&task_id).map_err(|e| validation_error(e, request_id))?,
            },
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MoveTaskRequest {
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub parent_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub project_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub section_id: Option<Option<String>>,
    #[serde(default)]
    pub order: Option<OrderAnchorDto>,
}

impl MoveTaskRequest {
    pub fn into_target(self, request_id: &RequestId) -> Result<MoveTarget, ApiError> {
        Ok(MoveTarget {
            parent_id: map_opt_null(self.parent_id, |s| TaskId::parse(&s), request_id)?,
            project_id: map_opt_null(self.project_id, |s| ProjectId::parse(&s), request_id)?,
            section_id: map_opt_null(self.section_id, |s| SectionId::parse(&s), request_id)?,
            order: match self.order {
                Some(order) => order.into_domain(request_id)?,
                None => OrderAnchor::Keep,
            },
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ReorderTasksRequest {
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub project_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub section_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub parent_id: Option<Option<String>>,
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub ordered_ids: Vec<String>,
}

impl ReorderTasksRequest {
    pub fn into_parts(
        self,
        request_id: &RequestId,
    ) -> Result<(ReorderScope, Vec<TaskId>), ApiError> {
        let scope = ReorderScope {
            project_id: map_opt_null(self.project_id, |s| ProjectId::parse(&s), request_id)?,
            section_id: map_opt_null(self.section_id, |s| SectionId::parse(&s), request_id)?,
            parent_id: map_opt_null(self.parent_id, |s| TaskId::parse(&s), request_id)?,
        };
        let ordered_ids = self
            .ordered_ids
            .into_iter()
            .map(|id| TaskId::parse(&id))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| validation_error(e, request_id))?;
        Ok((scope, ordered_ids))
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct BulkScheduleDto {
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Date, nullable = true)]
    pub due_date: Option<Option<Date>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub due_time: Option<Option<LocalDueTimeDto>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = DateTime, nullable = true)]
    pub deadline: Option<Option<Timestamp>>,
    #[serde(default)]
    pub someday: Option<bool>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct BulkTagChangeDto {
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum BulkActionDto {
    Complete {},
    Uncomplete {},
    Cancel {},
    Reopen {},
    Delete {},
    Move {
        target: MoveTaskRequest,
    },
    Tag {
        change: BulkTagChangeDto,
    },
    Schedule {
        schedule: BulkScheduleDto,
    },
    Priority {
        #[serde(default)]
        priority: Option<u8>,
    },
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct BulkTasksRequest {
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub task_ids: Vec<String>,
    pub action: BulkActionDto,
}

impl BulkTasksRequest {
    pub fn into_parts(self, request_id: &RequestId) -> Result<(Vec<TaskId>, BulkAction), ApiError> {
        let task_ids = self
            .task_ids
            .into_iter()
            .map(|id| TaskId::parse(&id))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| validation_error(e, request_id))?;
        let action = match self.action {
            BulkActionDto::Complete {} => BulkAction::Complete,
            BulkActionDto::Uncomplete {} => BulkAction::Uncomplete,
            BulkActionDto::Cancel {} => BulkAction::Cancel,
            BulkActionDto::Reopen {} => BulkAction::Reopen,
            BulkActionDto::Delete {} => BulkAction::Delete,
            BulkActionDto::Move { target } => BulkAction::Move {
                target: target.into_target(request_id)?,
            },
            BulkActionDto::Tag { change } => BulkAction::Tag {
                change: BulkTagChange {
                    add: change
                        .add
                        .into_iter()
                        .map(|id| TagId::parse(&id))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| validation_error(e, request_id))?,
                    remove: change
                        .remove
                        .into_iter()
                        .map(|id| TagId::parse(&id))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| validation_error(e, request_id))?,
                },
            },
            BulkActionDto::Schedule { schedule } => BulkAction::Schedule {
                schedule: BulkSchedule {
                    due_date: schedule.due_date,
                    due_time: map_opt_null(
                        schedule.due_time,
                        LocalDueTimeDto::try_into_domain,
                        request_id,
                    )?,
                    deadline: schedule.deadline,
                    someday: schedule.someday,
                },
            },
            BulkActionDto::Priority { priority } => BulkAction::Priority {
                priority: match priority {
                    None => None,
                    Some(value) => {
                        Some(Priority::new(value).map_err(|e| validation_error(e, request_id))?)
                    }
                },
            },
        };
        Ok((task_ids, action))
    }
}

// ── catalog ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ProjectDto {
    #[schema(value_type = String, format = Uuid)]
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub favorite: bool,
    pub archived: bool,
    pub view: ProjectViewDto,
    pub sort_order: i64,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
}

impl From<Project> for ProjectDto {
    fn from(project: Project) -> Self {
        Self {
            id: project.id.to_string(),
            name: project.name.to_string(),
            color: project.color.to_string(),
            icon: project.icon.map(|icon| icon.to_string()),
            parent_id: project.parent_id.map(|id| id.to_string()),
            favorite: project.favorite,
            archived: project.archived,
            view: project.view.into(),
            sort_order: project.sort_order.get(),
            created_at: project.created_at,
            updated_at: project.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SectionDto {
    #[schema(value_type = String, format = Uuid)]
    pub id: String,
    #[schema(value_type = String, format = Uuid)]
    pub project_id: String,
    pub name: String,
    pub collapsed: bool,
    pub sort_order: i64,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
}

impl From<Section> for SectionDto {
    fn from(section: Section) -> Self {
        Self {
            id: section.id.to_string(),
            project_id: section.project_id.to_string(),
            name: section.name.to_string(),
            collapsed: section.collapsed,
            sort_order: section.sort_order.get(),
            created_at: section.created_at,
            updated_at: section.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TagDto {
    #[schema(value_type = String, format = Uuid)]
    pub id: String,
    pub name: String,
    pub color: String,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
}

impl From<Tag> for TagDto {
    fn from(tag: Tag) -> Self {
        Self {
            id: tag.id.to_string(),
            name: tag.name.to_string(),
            color: tag.color.to_string(),
            created_at: tag.created_at,
            updated_at: tag.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TemplateDto {
    #[schema(value_type = String, format = Uuid)]
    pub id: String,
    pub name: String,
    pub title: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<u8>,
    pub tag_names: Vec<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<String>,
    pub sort_order: i64,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
}

impl From<Template> for TemplateDto {
    fn from(template: Template) -> Self {
        Self {
            id: template.id.to_string(),
            name: template.name.to_string(),
            title: template.title.to_string(),
            description: template.description.to_string(),
            priority: template.priority.map(Priority::get),
            tag_names: template.tag_names.iter().map(ToString::to_string).collect(),
            project_id: template.project_id.map(|id| id.to_string()),
            recurrence_rule: template.recurrence_rule.map(|rule| rule.to_string()),
            sort_order: template.sort_order.get(),
            created_at: template.created_at,
            updated_at: template.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SavedFilterDto {
    #[schema(value_type = String, format = Uuid)]
    pub id: String,
    pub name: String,
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub sort_order: i64,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
}

impl From<SavedFilter> for SavedFilterDto {
    fn from(filter: SavedFilter) -> Self {
        Self {
            id: filter.id.to_string(),
            name: filter.name.to_string(),
            query: filter.query.to_string(),
            color: filter.color.map(|color| color.to_string()),
            sort_order: filter.sort_order.get(),
            created_at: filter.created_at,
            updated_at: filter.updated_at,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CatalogResponse {
    pub projects: Vec<ProjectDto>,
    pub sections: Vec<SectionDto>,
    pub tags: Vec<TagDto>,
    pub templates: Vec<TemplateDto>,
    pub saved_filters: Vec<SavedFilterDto>,
    pub revision: u64,
}

impl From<CatalogSnapshot> for CatalogResponse {
    fn from(snapshot: CatalogSnapshot) -> Self {
        Self {
            projects: snapshot.projects.into_iter().map(Into::into).collect(),
            sections: snapshot.sections.into_iter().map(Into::into).collect(),
            tags: snapshot.tags.into_iter().map(Into::into).collect(),
            templates: snapshot.templates.into_iter().map(Into::into).collect(),
            saved_filters: snapshot.saved_filters.into_iter().map(Into::into).collect(),
            revision: snapshot.revision,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateProjectRequest {
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub view: Option<ProjectViewDto>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

impl CreateProjectRequest {
    pub fn into_draft(self, request_id: &RequestId) -> Result<ProjectDraft, ApiError> {
        Ok(ProjectDraft {
            name: EntityName::new(self.name).map_err(|e| validation_error(e, request_id))?,
            color: HexColor::new(self.color).map_err(|e| validation_error(e, request_id))?,
            icon: map_opt(self.icon, IconText::new, request_id)?,
            parent_id: map_opt(self.parent_id, |s| ProjectId::parse(&s), request_id)?,
            favorite: self.favorite,
            archived: self.archived,
            view: self.view.map(Into::into).unwrap_or_default(),
            sort_order: SortOrder::new(self.sort_order.unwrap_or(0)),
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PatchProjectRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub parent_id: Option<Option<String>>,
    #[serde(default)]
    pub favorite: Option<bool>,
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default)]
    pub view: Option<ProjectViewDto>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

impl PatchProjectRequest {
    pub fn into_patch(self, request_id: &RequestId) -> Result<ProjectPatch, ApiError> {
        Ok(ProjectPatch {
            name: map_opt(self.name, EntityName::new, request_id)?,
            color: map_opt(self.color, HexColor::new, request_id)?,
            icon: map_opt_null(self.icon, IconText::new, request_id)?,
            parent_id: map_opt_null(self.parent_id, |s| ProjectId::parse(&s), request_id)?,
            favorite: self.favorite,
            archived: self.archived,
            view: self.view.map(Into::into),
            sort_order: self.sort_order.map(SortOrder::new),
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateSectionRequest {
    #[schema(value_type = String, format = Uuid)]
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

impl CreateSectionRequest {
    pub fn into_draft(self, request_id: &RequestId) -> Result<SectionDraft, ApiError> {
        Ok(SectionDraft {
            project_id: ProjectId::parse(&self.project_id)
                .map_err(|e| validation_error(e, request_id))?,
            name: EntityName::new(self.name).map_err(|e| validation_error(e, request_id))?,
            collapsed: self.collapsed,
            sort_order: SortOrder::new(self.sort_order.unwrap_or(0)),
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PatchSectionRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub collapsed: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

impl PatchSectionRequest {
    pub fn into_patch(self, request_id: &RequestId) -> Result<SectionPatch, ApiError> {
        Ok(SectionPatch {
            name: map_opt(self.name, EntityName::new, request_id)?,
            collapsed: self.collapsed,
            sort_order: self.sort_order.map(SortOrder::new),
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateTagRequest {
    pub name: String,
    pub color: String,
}

impl CreateTagRequest {
    pub fn into_draft(self, request_id: &RequestId) -> Result<TagDraft, ApiError> {
        Ok(TagDraft {
            name: TagName::new(self.name).map_err(|e| validation_error(e, request_id))?,
            color: HexColor::new(self.color).map_err(|e| validation_error(e, request_id))?,
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PatchTagRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

impl PatchTagRequest {
    pub fn into_patch(self, request_id: &RequestId) -> Result<TagPatch, ApiError> {
        Ok(TagPatch {
            name: map_opt(self.name, TagName::new, request_id)?,
            color: map_opt(self.color, HexColor::new, request_id)?,
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateTemplateRequest {
    pub name: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub tag_names: Vec<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub recurrence_rule: Option<String>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

impl CreateTemplateRequest {
    pub fn into_draft(self, request_id: &RequestId) -> Result<TemplateDraft, ApiError> {
        Ok(TemplateDraft {
            name: EntityName::new(self.name).map_err(|e| validation_error(e, request_id))?,
            title: TaskTitle::new(self.title).map_err(|e| validation_error(e, request_id))?,
            description: match self.description {
                Some(value) => {
                    MarkdownText::new(value).map_err(|e| validation_error(e, request_id))?
                }
                None => MarkdownText::empty(),
            },
            priority: map_opt(self.priority, Priority::new, request_id)?,
            tag_names: self
                .tag_names
                .into_iter()
                .map(TagName::new)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| validation_error(e, request_id))?,
            project_id: map_opt(self.project_id, |s| ProjectId::parse(&s), request_id)?,
            recurrence_rule: map_opt(self.recurrence_rule, RecurrenceRule::new, request_id)?,
            sort_order: SortOrder::new(self.sort_order.unwrap_or(0)),
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PatchTemplateRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub priority: Option<Option<u8>>,
    #[serde(default)]
    pub tag_names: Option<Vec<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub project_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub recurrence_rule: Option<Option<String>>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

impl PatchTemplateRequest {
    pub fn into_patch(self, request_id: &RequestId) -> Result<TemplatePatch, ApiError> {
        Ok(TemplatePatch {
            name: map_opt(self.name, EntityName::new, request_id)?,
            title: map_opt(self.title, TaskTitle::new, request_id)?,
            description: map_opt(self.description, MarkdownText::new, request_id)?,
            priority: map_opt_null(self.priority, Priority::new, request_id)?,
            tag_names: match self.tag_names {
                None => None,
                Some(names) => Some(
                    names
                        .into_iter()
                        .map(TagName::new)
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| validation_error(e, request_id))?,
                ),
            },
            project_id: map_opt_null(self.project_id, |s| ProjectId::parse(&s), request_id)?,
            recurrence_rule: map_opt_null(self.recurrence_rule, RecurrenceRule::new, request_id)?,
            sort_order: self.sort_order.map(SortOrder::new),
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplyTemplateRequest {
    #[schema(value_type = String, format = Uuid)]
    pub template_id: String,
    /// Placeholder values keyed by name without braces. Bounded by request body size.
    #[serde(default)]
    pub variables: Vec<TemplateVariableDto>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TemplateVariableDto {
    pub name: String,
    pub value: String,
}

impl ApplyTemplateRequest {
    pub fn into_apply(self, request_id: &RequestId) -> Result<TemplateApply, ApiError> {
        Ok(TemplateApply {
            template_id: TemplateId::parse(&self.template_id)
                .map_err(|e| validation_error(e, request_id))?,
            variables: self
                .variables
                .into_iter()
                .map(|item| (item.name, item.value))
                .collect(),
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateSavedFilterRequest {
    pub name: String,
    pub query: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

impl CreateSavedFilterRequest {
    pub fn into_draft(self, request_id: &RequestId) -> Result<SavedFilterDraft, ApiError> {
        Ok(SavedFilterDraft {
            name: EntityName::new(self.name).map_err(|e| validation_error(e, request_id))?,
            query: FilterQuery::new(self.query).map_err(|e| validation_error(e, request_id))?,
            color: map_opt(self.color, HexColor::new, request_id)?,
            sort_order: SortOrder::new(self.sort_order.unwrap_or(0)),
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PatchSavedFilterRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub color: Option<Option<String>>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

impl PatchSavedFilterRequest {
    pub fn into_patch(self, request_id: &RequestId) -> Result<SavedFilterPatch, ApiError> {
        Ok(SavedFilterPatch {
            name: map_opt(self.name, EntityName::new, request_id)?,
            query: map_opt(self.query, FilterQuery::new, request_id)?,
            color: map_opt_null(self.color, HexColor::new, request_id)?,
            sort_order: self.sort_order.map(SortOrder::new),
        })
    }
}

// ── comments / relations / activity ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CommentDto {
    #[schema(value_type = String, format = Uuid)]
    pub id: String,
    #[schema(value_type = String, format = Uuid)]
    pub task_id: String,
    pub content: String,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
}

impl From<Comment> for CommentDto {
    fn from(comment: Comment) -> Self {
        Self {
            id: comment.id.to_string(),
            task_id: comment.task_id.to_string(),
            content: comment.content.to_string(),
            created_at: comment.created_at,
            updated_at: comment.updated_at,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateCommentRequest {
    pub content: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PatchCommentRequest {
    pub content: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CommentListResponse {
    pub comments: Vec<CommentDto>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RelationDto {
    #[schema(value_type = String, format = Uuid)]
    pub from_task_id: String,
    #[schema(value_type = String, format = Uuid)]
    pub to_task_id: String,
    pub kind: String,
}

impl From<TaskRelation> for RelationDto {
    fn from(relation: TaskRelation) -> Self {
        Self {
            from_task_id: relation.from_task_id.to_string(),
            to_task_id: relation.to_task_id.to_string(),
            kind: match relation.kind {
                RelationKind::Blocks => "blocks".to_owned(),
            },
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AddRelationRequest {
    #[schema(value_type = String, format = Uuid)]
    pub to_task_id: String,
    /// Only `blocks` is supported in Phase 2.
    pub kind: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RelationListResponse {
    pub relations: Vec<RelationDto>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TaskActivityDto {
    pub revision: u64,
    pub sequence: u32,
    #[schema(value_type = String, format = Uuid)]
    pub operation_id: String,
    #[schema(value_type = String, format = Uuid)]
    pub task_id: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_value: Option<String>,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
}

impl From<TaskActivity> for TaskActivityDto {
    fn from(activity: TaskActivity) -> Self {
        Self {
            revision: activity.revision,
            sequence: activity.sequence,
            operation_id: activity.operation_id.to_string(),
            task_id: activity.task_id.to_string(),
            action: match activity.action {
                TaskActivityAction::Created => "created",
                TaskActivityAction::Updated => "updated",
                TaskActivityAction::Completed => "completed",
                TaskActivityAction::Uncompleted => "uncompleted",
                TaskActivityAction::Cancelled => "cancelled",
                TaskActivityAction::Reopened => "reopened",
                TaskActivityAction::Deleted => "deleted",
                TaskActivityAction::Restored => "restored",
            }
            .to_owned(),
            field: activity.field,
            old_value: activity.old_value,
            new_value: activity.new_value,
            created_at: activity.created_at,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TaskActivityResponse {
    pub activity: Vec<TaskActivityDto>,
}

// ── events / mutations ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResourceTypeDto {
    Task,
    Project,
    Section,
    Tag,
    Template,
    SavedFilter,
    Comment,
    Relation,
    Operation,
    TimeBlock,
    TimeSlot,
}

impl From<ResourceType> for ResourceTypeDto {
    fn from(value: ResourceType) -> Self {
        match value {
            ResourceType::Task => Self::Task,
            ResourceType::Project => Self::Project,
            ResourceType::Section => Self::Section,
            ResourceType::Tag => Self::Tag,
            ResourceType::Template => Self::Template,
            ResourceType::SavedFilter => Self::SavedFilter,
            ResourceType::Comment => Self::Comment,
            ResourceType::Relation => Self::Relation,
            ResourceType::Operation => Self::Operation,
            ResourceType::TimeBlock => Self::TimeBlock,
            ResourceType::TimeSlot => Self::TimeSlot,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ResourceRefDto {
    pub resource_type: ResourceTypeDto,
    pub id: String,
}

impl From<ResourceRef> for ResourceRefDto {
    fn from(value: ResourceRef) -> Self {
        Self {
            resource_type: value.resource_type.into(),
            id: value.id,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "resource_type", rename_all = "snake_case")]
pub enum ResourceSnapshotDto {
    Task { task: TaskDto },
    Project { project: ProjectDto },
    Section { section: SectionDto },
    Tag { tag: TagDto },
    Template { template: TemplateDto },
    SavedFilter { saved_filter: SavedFilterDto },
    Comment { comment: CommentDto },
    TimeBlock { time_block: TimeBlockDto },
    TimeSlot { time_slot: TimeSlotDto },
}

impl From<ResourceSnapshot> for ResourceSnapshotDto {
    fn from(value: ResourceSnapshot) -> Self {
        match value {
            ResourceSnapshot::Task { task } => Self::Task { task: task.into() },
            ResourceSnapshot::Project { project } => Self::Project {
                project: project.into(),
            },
            ResourceSnapshot::Section { section } => Self::Section {
                section: section.into(),
            },
            ResourceSnapshot::Tag { tag } => Self::Tag { tag: tag.into() },
            ResourceSnapshot::Template { template } => Self::Template {
                template: template.into(),
            },
            ResourceSnapshot::SavedFilter { saved_filter } => Self::SavedFilter {
                saved_filter: saved_filter.into(),
            },
            ResourceSnapshot::Comment { comment } => Self::Comment {
                comment: comment.into(),
            },
            ResourceSnapshot::TimeBlock { time_block } => Self::TimeBlock {
                time_block: time_block.into(),
            },
            ResourceSnapshot::TimeSlot { time_slot } => Self::TimeSlot {
                time_slot: time_slot.into(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TimeBlockDto {
    #[schema(value_type = String, format = Uuid)]
    pub id: String,
    pub title: String,
    #[schema(value_type = String, format = Date)]
    pub date: Date,
    pub start: String,
    pub end: String,
    pub time_zone: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub locked: bool,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_parent_id: Option<String>,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
    pub revision: u64,
}

impl From<TimeBlock> for TimeBlockDto {
    fn from(block: TimeBlock) -> Self {
        Self {
            id: block.id.to_string(),
            title: block.title.to_string(),
            date: block.range.date,
            start: block.range.start.to_string(),
            end: block.range.end.to_string(),
            time_zone: block.range.time_zone.to_string(),
            color: block.color.map(|color| color.to_string()),
            locked: block.locked,
            task_id: block.task_id.map(|id| id.to_string()),
            slot_id: block.slot_id.map(|id| id.to_string()),
            recurrence_rule: block.recurrence_rule.map(|rule| rule.to_string()),
            recurrence_parent_id: block.recurrence_parent_id.map(|id| id.to_string()),
            created_at: block.created_at,
            updated_at: block.updated_at,
            revision: block.revision,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TimeSlotDto {
    #[schema(value_type = String, format = Uuid)]
    pub id: String,
    pub title: String,
    #[schema(value_type = String, format = Date)]
    pub date: Date,
    pub start: String,
    pub end: String,
    pub time_zone: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_ids: Vec<String>,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
    pub revision: u64,
}

impl From<TimeSlot> for TimeSlotDto {
    fn from(slot: TimeSlot) -> Self {
        Self {
            id: slot.id.to_string(),
            title: slot.title.to_string(),
            date: slot.range.date,
            start: slot.range.start.to_string(),
            end: slot.range.end.to_string(),
            time_zone: slot.range.time_zone.to_string(),
            color: slot.color.map(|color| color.to_string()),
            project_id: slot.project_id.map(|id| id.to_string()),
            recurrence_rule: slot.recurrence_rule.map(|rule| rule.to_string()),
            recurrence_parent_id: slot.recurrence_parent_id.map(|id| id.to_string()),
            task_ids: slot
                .task_ids
                .as_slice()
                .iter()
                .map(ToString::to_string)
                .collect(),
            created_at: slot.created_at,
            updated_at: slot.updated_at,
            revision: slot.revision,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TimeBlockListResponse {
    pub time_blocks: Vec<TimeBlockDto>,
    pub revision: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TimeSlotListResponse {
    pub time_slots: Vec<TimeSlotDto>,
    pub revision: u64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateTimeBlockRequest {
    pub title: String,
    #[schema(value_type = String, format = Date)]
    pub date: Date,
    /// Civil wall-clock time `HH:MM[:SS]`.
    pub start: String,
    /// Civil wall-clock time `HH:MM[:SS]`.
    pub end: String,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub locked: bool,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(default)]
    pub task_id: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(default)]
    pub slot_id: Option<String>,
    #[serde(default)]
    pub recurrence_rule: Option<String>,
}

impl CreateTimeBlockRequest {
    pub fn into_draft(self, request_id: &RequestId) -> Result<TimeBlockDraft, ApiError> {
        let range = parse_civil_range(
            self.date,
            &self.start,
            &self.end,
            self.time_zone.as_deref(),
            request_id,
        )?;
        Ok(TimeBlockDraft {
            title: EntityName::new(self.title).map_err(|e| validation_error(e, request_id))?,
            range,
            color: map_opt(self.color, HexColor::new, request_id)?,
            locked: self.locked,
            task_id: map_opt(self.task_id, |s| TaskId::parse(&s), request_id)?,
            slot_id: map_opt(self.slot_id, |s| TimeSlotId::parse(&s), request_id)?,
            recurrence_rule: map_opt(self.recurrence_rule, RecurrenceRule::new, request_id)?,
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PatchTimeBlockRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[schema(value_type = Option<String>, format = Date)]
    #[serde(default)]
    pub date: Option<Date>,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub color: Option<Option<String>>,
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub task_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub slot_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub recurrence_rule: Option<Option<String>>,
}

impl PatchTimeBlockRequest {
    pub fn into_patch(self, request_id: &RequestId) -> Result<TimeBlockPatch, ApiError> {
        Ok(TimeBlockPatch {
            title: map_opt(self.title, EntityName::new, request_id)?,
            range: parse_optional_civil_range(
                self.date,
                self.start.as_deref(),
                self.end.as_deref(),
                self.time_zone.as_deref(),
                request_id,
            )?,
            color: map_opt_null(self.color, HexColor::new, request_id)?,
            locked: self.locked,
            task_id: map_opt_null(self.task_id, |s| TaskId::parse(&s), request_id)?,
            slot_id: map_opt_null(self.slot_id, |s| TimeSlotId::parse(&s), request_id)?,
            recurrence_rule: map_opt_null(self.recurrence_rule, RecurrenceRule::new, request_id)?,
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MoveTimeBlockRequest {
    #[schema(value_type = String, format = Date)]
    pub date: Date,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub time_zone: Option<String>,
}

impl MoveTimeBlockRequest {
    pub fn into_range(self, request_id: &RequestId) -> Result<CivilTimeRange, ApiError> {
        parse_civil_range(
            self.date,
            &self.start,
            &self.end,
            self.time_zone.as_deref(),
            request_id,
        )
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ResizeTimeBlockRequest {
    #[schema(value_type = String, format = Date)]
    pub date: Date,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub time_zone: Option<String>,
}

impl ResizeTimeBlockRequest {
    pub fn into_range(self, request_id: &RequestId) -> Result<CivilTimeRange, ApiError> {
        parse_civil_range(
            self.date,
            &self.start,
            &self.end,
            self.time_zone.as_deref(),
            request_id,
        )
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateTimeSlotRequest {
    pub title: String,
    #[schema(value_type = String, format = Date)]
    pub date: Date,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub recurrence_rule: Option<String>,
}

impl CreateTimeSlotRequest {
    pub fn into_draft(self, request_id: &RequestId) -> Result<TimeSlotDraft, ApiError> {
        let range = parse_civil_range(
            self.date,
            &self.start,
            &self.end,
            self.time_zone.as_deref(),
            request_id,
        )?;
        Ok(TimeSlotDraft {
            title: EntityName::new(self.title).map_err(|e| validation_error(e, request_id))?,
            range,
            color: map_opt(self.color, HexColor::new, request_id)?,
            project_id: map_opt(self.project_id, |s| ProjectId::parse(&s), request_id)?,
            recurrence_rule: map_opt(self.recurrence_rule, RecurrenceRule::new, request_id)?,
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PatchTimeSlotRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[schema(value_type = Option<String>, format = Date)]
    #[serde(default)]
    pub date: Option<Date>,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub color: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(value_type = Option<Option<String>>, format = Uuid, nullable = true)]
    pub project_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    #[schema(nullable = true)]
    pub recurrence_rule: Option<Option<String>>,
}

impl PatchTimeSlotRequest {
    pub fn into_patch(self, request_id: &RequestId) -> Result<TimeSlotPatch, ApiError> {
        Ok(TimeSlotPatch {
            title: map_opt(self.title, EntityName::new, request_id)?,
            range: parse_optional_civil_range(
                self.date,
                self.start.as_deref(),
                self.end.as_deref(),
                self.time_zone.as_deref(),
                request_id,
            )?,
            color: map_opt_null(self.color, HexColor::new, request_id)?,
            project_id: map_opt_null(self.project_id, |s| ProjectId::parse(&s), request_id)?,
            recurrence_rule: map_opt_null(self.recurrence_rule, RecurrenceRule::new, request_id)?,
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AppendTimeSlotTaskRequest {
    #[schema(value_type = String, format = Uuid)]
    pub task_id: String,
}

impl AppendTimeSlotTaskRequest {
    pub fn into_task_id(self, request_id: &RequestId) -> Result<TaskId, ApiError> {
        TaskId::parse(&self.task_id).map_err(|e| validation_error(e, request_id))
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ReplaceTimeSlotTasksRequest {
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub task_ids: Vec<String>,
}

impl ReplaceTimeSlotTasksRequest {
    pub fn into_task_ids(self, request_id: &RequestId) -> Result<Vec<TaskId>, ApiError> {
        self.task_ids
            .into_iter()
            .map(|id| TaskId::parse(&id))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| validation_error(e, request_id))
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AffectedIdsDto {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub project_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub section_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub template_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub saved_filter_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub comment_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub time_block_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub time_slot_ids: Vec<String>,
}

impl From<AffectedIds> for AffectedIdsDto {
    fn from(value: AffectedIds) -> Self {
        Self {
            task_ids: value.task_ids.iter().map(ToString::to_string).collect(),
            project_ids: value.project_ids.iter().map(ToString::to_string).collect(),
            section_ids: value.section_ids.iter().map(ToString::to_string).collect(),
            tag_ids: value.tag_ids.iter().map(ToString::to_string).collect(),
            template_ids: value.template_ids.iter().map(ToString::to_string).collect(),
            saved_filter_ids: value
                .saved_filter_ids
                .iter()
                .map(ToString::to_string)
                .collect(),
            comment_ids: value.comment_ids.iter().map(ToString::to_string).collect(),
            time_block_ids: value
                .time_block_ids
                .iter()
                .map(ToString::to_string)
                .collect(),
            time_slot_ids: value
                .time_slot_ids
                .iter()
                .map(ToString::to_string)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ResyncScopeDto {
    pub tasks: bool,
    pub catalog: bool,
}

impl From<ResyncScope> for ResyncScopeDto {
    fn from(value: ResyncScope) -> Self {
        Self {
            tasks: value.tasks,
            catalog: value.catalog,
        }
    }
}

/// Full committed event envelope used by mutations and SSE.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CommittedEventDto {
    pub revision: u64,
    #[schema(value_type = String, format = Uuid)]
    pub operation_id: String,
    /// Forward-compatible event type string.
    pub event_type: String,
    #[schema(value_type = String, format = DateTime)]
    pub occurred_at: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary: Option<ResourceRefDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<ResourceSnapshotDto>,
    pub affected: AffectedIdsDto,
    pub resync: ResyncScopeDto,
}

impl From<CommittedEvent> for CommittedEventDto {
    fn from(event: CommittedEvent) -> Self {
        Self {
            revision: event.revision,
            operation_id: event.operation_id.to_string(),
            event_type: event.event_type.as_str().to_owned(),
            occurred_at: event.occurred_at,
            primary: event.primary.map(Into::into),
            snapshot: event.snapshot.map(Into::into),
            affected: event.affected.into(),
            resync: event.resync.into(),
        }
    }
}

/// Mutation responses carry exactly one committed event. `newly_committed` is never exposed.
#[derive(Debug, Serialize, ToSchema)]
pub struct MutationResponse {
    pub event: CommittedEventDto,
}

impl From<CommittedMutation> for MutationResponse {
    fn from(mutation: CommittedMutation) -> Self {
        Self {
            event: mutation.event.into(),
        }
    }
}

// ── parsers / misc ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: &'static str,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ProfileResponse {
    pub revision: u64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ParseQuickEntryRequest {
    pub input: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct QuickEntryDto {
    pub title: String,
    #[schema(value_type = Option<String>, format = Date, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<Date>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    pub tag_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_minutes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dread: Option<u8>,
    pub someday: bool,
    #[schema(value_type = Option<String>, format = DateTime, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline: Option<Timestamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<String>,
}

impl From<QuickEntry> for QuickEntryDto {
    fn from(entry: QuickEntry) -> Self {
        Self {
            title: entry.title.to_string(),
            due_date: entry.due_date,
            priority: entry.priority.map(Priority::get),
            project_name: entry.project_name.map(|name| name.to_string()),
            tag_names: entry.tag_names.iter().map(ToString::to_string).collect(),
            estimated_minutes: entry.estimated_minutes.map(EstimatedMinutes::get),
            dread: entry.dread.map(DreadLevel::get),
            someday: entry.someday,
            deadline: entry.deadline,
            recurrence_rule: entry.recurrence_rule.map(|rule| rule.to_string()),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ParseFilterRequest {
    pub input: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ParsedFilterResponse {
    pub filter: TaskFilterDto,
    pub sort: TaskSortDto,
    #[schema(value_type = String, format = Date)]
    pub as_of_date: Date,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TaskFilterDto {
    pub statuses: Vec<TaskStatusDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<u8>,
    #[schema(value_type = Option<String>, format = Date, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_before: Option<Date>,
    #[schema(value_type = Option<String>, format = Date, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_after: Option<Date>,
    #[schema(value_type = Option<String>, format = Date, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_on: Option<Date>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub someday: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overdue: Option<bool>,
    pub tag_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
}

impl From<TaskQuery> for ParsedFilterResponse {
    fn from(query: TaskQuery) -> Self {
        // as_of_date is filled by the route using the request-local server date.
        Self {
            filter: TaskFilterDto {
                statuses: query.filter.statuses.into_iter().map(Into::into).collect(),
                project_name: query.filter.project_name.map(|name| name.to_string()),
                priority: query.filter.priority.map(Priority::get),
                due_before: query.filter.due_before,
                due_after: query.filter.due_after,
                due_on: query.filter.due_on,
                someday: query.filter.someday,
                overdue: query.filter.overdue,
                tag_names: query
                    .filter
                    .tag_names
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
                search: query.filter.search,
            },
            sort: query.sort.into(),
            as_of_date: Date::constant(1970, 1, 1),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ParseTextImportRequest {
    pub input: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TextImportDraftDto {
    pub title: String,
    pub completed: bool,
    pub description: String,
}

impl From<TextImportDraft> for TextImportDraftDto {
    fn from(draft: TextImportDraft) -> Self {
        Self {
            title: draft.title.to_string(),
            completed: draft.completed,
            description: draft.description.to_string(),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TextImportResponse {
    pub drafts: Vec<TextImportDraftDto>,
}

// ── reminders ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReminderChannelDto {
    InApp,
    WebNotification,
    Sound,
    Native,
}

impl From<junban_domain::ReminderChannel> for ReminderChannelDto {
    fn from(value: junban_domain::ReminderChannel) -> Self {
        match value {
            junban_domain::ReminderChannel::InApp => Self::InApp,
            junban_domain::ReminderChannel::WebNotification => Self::WebNotification,
            junban_domain::ReminderChannel::Sound => Self::Sound,
            junban_domain::ReminderChannel::Native => Self::Native,
        }
    }
}

impl From<ReminderChannelDto> for junban_domain::ReminderChannel {
    fn from(value: ReminderChannelDto) -> Self {
        match value {
            ReminderChannelDto::InApp => Self::InApp,
            ReminderChannelDto::WebNotification => Self::WebNotification,
            ReminderChannelDto::Sound => Self::Sound,
            ReminderChannelDto::Native => Self::Native,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReminderOccurrenceStateDto {
    Pending,
    Claimed,
    Delivered,
    Failed,
    Cancelled,
}

impl From<junban_domain::ReminderOccurrenceState> for ReminderOccurrenceStateDto {
    fn from(value: junban_domain::ReminderOccurrenceState) -> Self {
        match value {
            junban_domain::ReminderOccurrenceState::Pending => Self::Pending,
            junban_domain::ReminderOccurrenceState::Claimed => Self::Claimed,
            junban_domain::ReminderOccurrenceState::Delivered => Self::Delivered,
            junban_domain::ReminderOccurrenceState::Failed => Self::Failed,
            junban_domain::ReminderOccurrenceState::Cancelled => Self::Cancelled,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReminderFailureCodeDto {
    PermissionDenied,
    TemporarilyUnavailable,
    ChannelFailed,
    OwnerLost,
}

impl From<ReminderFailureCodeDto> for junban_domain::ReminderFailureCode {
    fn from(value: ReminderFailureCodeDto) -> Self {
        match value {
            ReminderFailureCodeDto::PermissionDenied => Self::PermissionDenied,
            ReminderFailureCodeDto::TemporarilyUnavailable => Self::TemporarilyUnavailable,
            ReminderFailureCodeDto::ChannelFailed => Self::ChannelFailed,
            ReminderFailureCodeDto::OwnerLost => Self::OwnerLost,
        }
    }
}

impl From<junban_domain::ReminderFailureCode> for ReminderFailureCodeDto {
    fn from(value: junban_domain::ReminderFailureCode) -> Self {
        match value {
            junban_domain::ReminderFailureCode::PermissionDenied => Self::PermissionDenied,
            junban_domain::ReminderFailureCode::TemporarilyUnavailable => {
                Self::TemporarilyUnavailable
            }
            junban_domain::ReminderFailureCode::ChannelFailed => Self::ChannelFailed,
            junban_domain::ReminderFailureCode::OwnerLost => Self::OwnerLost,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ReminderOccurrenceDto {
    #[schema(value_type = String, format = Uuid)]
    pub task_id: String,
    #[schema(value_type = String, format = DateTime)]
    pub remind_at: Timestamp,
    pub state: ReminderOccurrenceStateDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_term: Option<String>,
    #[schema(value_type = Option<String>, format = DateTime, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_expires_at: Option<Timestamp>,
    pub attempts: u32,
    #[schema(value_type = Option<String>, format = DateTime, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<Timestamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_channel: Option<ReminderChannelDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_error_code: Option<ReminderFailureCodeDto>,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
}

impl From<junban_domain::ReminderOccurrence> for ReminderOccurrenceDto {
    fn from(value: junban_domain::ReminderOccurrence) -> Self {
        Self {
            task_id: value.task_id.to_string(),
            remind_at: value.remind_at,
            state: value.state.into(),
            claim_term: value.claim_term.map(|term| term.as_str().to_owned()),
            claim_expires_at: value.claim_expires_at,
            attempts: value.attempts,
            next_attempt_at: value.next_attempt_at,
            terminal_channel: value.terminal_channel.map(Into::into),
            terminal_error_code: value.terminal_error_code.map(Into::into),
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReminderListResponse {
    pub reminders: Vec<ReminderOccurrenceDto>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RescheduleReminderRequest {
    #[schema(value_type = String, format = DateTime)]
    pub remind_at: Timestamp,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AcquireReminderLeaseRequest {
    /// Positive bounded TTL in seconds. Omitted uses the service default (90).
    #[serde(default)]
    pub lease_secs: Option<u64>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RenewReminderLeaseRequest {
    pub fence_term: String,
    #[serde(default)]
    pub lease_secs: Option<u64>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ReleaseReminderLeaseRequest {
    pub fence_term: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ClaimRemindersRequest {
    pub fence_term: String,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub claim_secs: Option<u64>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SettleReminderDeliveredRequest {
    pub fence_term: String,
    #[schema(value_type = String, format = Uuid)]
    pub task_id: String,
    #[schema(value_type = String, format = DateTime)]
    pub remind_at: Timestamp,
    /// Exact `claim_attempt` from the claim response for this occurrence.
    pub claim_attempt: u32,
    pub channel: ReminderChannelDto,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SettleReminderFailedRequest {
    pub fence_term: String,
    #[schema(value_type = String, format = Uuid)]
    pub task_id: String,
    #[schema(value_type = String, format = DateTime)]
    pub remind_at: Timestamp,
    /// Exact `claim_attempt` from the claim response for this occurrence.
    pub claim_attempt: u32,
    pub error: ReminderFailureCodeDto,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MarkOwnerLostRemindersRequest {
    pub fence_term: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ReminderDeliveryLeaseDto {
    pub fence_term: String,
    #[schema(value_type = String, format = DateTime)]
    pub expires_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
}

impl From<junban_domain::ReminderDeliveryLease> for ReminderDeliveryLeaseDto {
    fn from(value: junban_domain::ReminderDeliveryLease) -> Self {
        Self {
            fence_term: value.fence_term.as_str().to_owned(),
            expires_at: value.expires_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ClaimedReminderDto {
    #[schema(value_type = String, format = Uuid)]
    pub task_id: String,
    #[schema(value_type = String, format = DateTime)]
    pub remind_at: Timestamp,
    pub claim_term: String,
    #[schema(value_type = String, format = DateTime)]
    pub claim_expires_at: Timestamp,
    /// Durable attempt generation that settle must echo exactly.
    pub claim_attempt: u32,
}

impl From<junban_domain::ClaimedReminder> for ClaimedReminderDto {
    fn from(value: junban_domain::ClaimedReminder) -> Self {
        Self {
            task_id: value.task_id.to_string(),
            remind_at: value.remind_at,
            claim_term: value.claim_term.as_str().to_owned(),
            claim_expires_at: value.claim_expires_at,
            claim_attempt: value.claim_attempt,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ClaimRemindersResponse {
    pub reminders: Vec<ClaimedReminderDto>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MarkOwnerLostRemindersResponse {
    pub marked: u32,
}

// ── planning / analytics reads ─────────────────────────────────────────────

#[derive(Debug, Serialize, ToSchema)]
pub struct CalendarTasksResponse {
    pub tasks: Vec<TaskDto>,
    pub revision: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DailyPlanResponse {
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub overdue_task_ids: Vec<String>,
    pub overdue_tasks: Vec<TaskDto>,
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub focus_task_ids: Vec<String>,
    pub focus_tasks: Vec<TaskDto>,
    pub estimated_total_minutes: u32,
    pub capacity_minutes: u32,
    pub revision: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct EndOfDayResponse {
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub win_task_ids: Vec<String>,
    pub win_tasks: Vec<TaskDto>,
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub carry_over_task_ids: Vec<String>,
    pub carry_over_tasks: Vec<TaskDto>,
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub tomorrow_task_ids: Vec<String>,
    pub tomorrow_tasks: Vec<TaskDto>,
    pub tomorrow_estimated_minutes: u32,
    pub completion_rate_percent: u32,
    pub capacity_minutes: u32,
    pub revision: u64,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WeekStartDto {
    Sunday,
    Monday,
}

impl From<WeekStart> for WeekStartDto {
    fn from(value: WeekStart) -> Self {
        match value {
            WeekStart::Sunday => Self::Sunday,
            WeekStart::Monday => Self::Monday,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CompletionTimeBucketDto {
    Morning,
    Afternoon,
    Evening,
    Night,
}

impl From<CompletionTimeBucket> for CompletionTimeBucketDto {
    fn from(value: CompletionTimeBucket) -> Self {
        match value {
            CompletionTimeBucket::Morning => Self::Morning,
            CompletionTimeBucket::Afternoon => Self::Afternoon,
            CompletionTimeBucket::Evening => Self::Evening,
            CompletionTimeBucket::Night => Self::Night,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CompletionTimeBucketsDto {
    pub morning: u32,
    pub afternoon: u32,
    pub evening: u32,
    pub night: u32,
}

impl From<CompletionTimeBuckets> for CompletionTimeBucketsDto {
    fn from(value: CompletionTimeBuckets) -> Self {
        Self {
            morning: value.morning,
            afternoon: value.afternoon,
            evening: value.evening,
            night: value.night,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct WeeklyDayStatsDto {
    #[schema(value_type = String, format = Date)]
    pub date: Date,
    pub completed: u32,
    pub created: u32,
}

impl From<WeeklyDayStats> for WeeklyDayStatsDto {
    fn from(value: WeeklyDayStats) -> Self {
        Self {
            date: value.date,
            completed: value.completed,
            created: value.created,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum NeglectedProjectReasonDto {
    OverdueTasks,
    NoActivity,
}

impl From<NeglectedProjectReason> for NeglectedProjectReasonDto {
    fn from(value: NeglectedProjectReason) -> Self {
        match value {
            NeglectedProjectReason::OverdueTasks => Self::OverdueTasks,
            NeglectedProjectReason::NoActivity => Self::NoActivity,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct NeglectedProjectFactDto {
    #[schema(value_type = String, format = Uuid)]
    pub project_id: String,
    pub overdue_count: u32,
    pub reason: NeglectedProjectReasonDto,
}

impl From<NeglectedProjectFact> for NeglectedProjectFactDto {
    fn from(value: NeglectedProjectFact) -> Self {
        Self {
            project_id: value.project_id.to_string(),
            overdue_count: value.overdue_count,
            reason: value.reason.into(),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WeeklySuggestionDto {
    TackleOverdue {
        count: u32,
    },
    CheckNeglected {
        #[schema(value_type = Vec<String>, format = Uuid)]
        project_ids: Vec<String>,
    },
    CreatedMoreThanCompleted,
    KeepStreak {
        days: u32,
    },
}

impl From<WeeklySuggestion> for WeeklySuggestionDto {
    fn from(value: WeeklySuggestion) -> Self {
        match value {
            WeeklySuggestion::TackleOverdue { count } => Self::TackleOverdue { count },
            WeeklySuggestion::CheckNeglected { project_ids } => Self::CheckNeglected {
                project_ids: project_ids.into_iter().map(|id| id.to_string()).collect(),
            },
            WeeklySuggestion::CreatedMoreThanCompleted => Self::CreatedMoreThanCompleted,
            WeeklySuggestion::KeepStreak { days } => Self::KeepStreak { days },
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct WeeklyReviewResponse {
    #[schema(value_type = String, format = Date)]
    pub week_start: Date,
    #[schema(value_type = String, format = Date)]
    pub week_end: Date,
    pub daily: Vec<WeeklyDayStatsDto>,
    pub created_count: u32,
    pub completed_count: u32,
    pub cancelled_count: u32,
    pub completion_rate_percent: u32,
    #[schema(value_type = Option<String>, format = Date, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub busiest_day: Option<Date>,
    pub completion_time_buckets: CompletionTimeBucketsDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dominant_completion_bucket: Option<CompletionTimeBucketDto>,
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub top_accomplishment_ids: Vec<String>,
    pub top_accomplishment_tasks: Vec<TaskDto>,
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub overdue_task_ids: Vec<String>,
    pub overdue_tasks: Vec<TaskDto>,
    pub neglected_projects: Vec<NeglectedProjectFactDto>,
    pub streak_days: u32,
    pub suggestions: Vec<WeeklySuggestionDto>,
    pub revision: u64,
}

impl WeeklyReviewResponse {
    pub fn from_page(page: junban_app::WeeklyReviewPage) -> Self {
        let WeeklyReviewSummary {
            week_start,
            week_end,
            daily,
            created_count,
            completed_count,
            cancelled_count,
            completion_rate_percent,
            busiest_day,
            completion_time_buckets,
            dominant_completion_bucket,
            top_accomplishment_ids,
            overdue_task_ids,
            neglected_projects,
            streak_days,
            suggestions,
        } = page.summary;
        Self {
            week_start,
            week_end,
            daily: daily.into_iter().map(Into::into).collect(),
            created_count,
            completed_count,
            cancelled_count,
            completion_rate_percent,
            busiest_day,
            completion_time_buckets: completion_time_buckets.into(),
            dominant_completion_bucket: dominant_completion_bucket.map(Into::into),
            top_accomplishment_ids: top_accomplishment_ids
                .into_iter()
                .map(|id| id.to_string())
                .collect(),
            top_accomplishment_tasks: page
                .top_accomplishment_tasks
                .into_iter()
                .map(Into::into)
                .collect(),
            overdue_task_ids: overdue_task_ids
                .into_iter()
                .map(|id| id.to_string())
                .collect(),
            overdue_tasks: page.overdue_tasks.into_iter().map(Into::into).collect(),
            neglected_projects: neglected_projects.into_iter().map(Into::into).collect(),
            streak_days,
            suggestions: suggestions.into_iter().map(Into::into).collect(),
            revision: page.revision,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DailyStatBucketDto {
    #[schema(value_type = String, format = Date)]
    pub date: Date,
    pub completions: u32,
    pub creations: u32,
    pub completion_minutes: u32,
}

impl From<DailyStatBucket> for DailyStatBucketDto {
    fn from(value: DailyStatBucket) -> Self {
        Self {
            date: value.date,
            completions: value.completions,
            creations: value.creations,
            completion_minutes: value.completion_minutes,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct StatsResponse {
    #[schema(value_type = String, format = Date)]
    pub from: Date,
    #[schema(value_type = String, format = Date)]
    pub to: Date,
    pub days: Vec<DailyStatBucketDto>,
    pub total_completions: u32,
    pub total_creations: u32,
    pub total_completion_minutes: u32,
    pub current_streak_days: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate_accuracy_percent: Option<u32>,
    pub estimate_accuracy_samples: u32,
    pub revision: u64,
}

impl StatsResponse {
    pub fn from_page(page: junban_app::StatsPage) -> Self {
        let StatsSummary {
            from,
            to,
            days,
            total_completions,
            total_creations,
            total_completion_minutes,
            current_streak_days,
            estimate_accuracy_percent,
            estimate_accuracy_samples,
        } = page.summary;
        Self {
            from,
            to,
            days: days.into_iter().map(Into::into).collect(),
            total_completions,
            total_creations,
            total_completion_minutes,
            current_streak_days,
            estimate_accuracy_percent,
            estimate_accuracy_samples,
            revision: page.revision,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum NudgeRuleKindDto {
    Overdue,
    ApproachingDeadline,
    StaleTask,
    EmptyToday,
    OverloadedDay,
}

impl From<NudgeRuleKind> for NudgeRuleKindDto {
    fn from(value: NudgeRuleKind) -> Self {
        match value {
            NudgeRuleKind::Overdue => Self::Overdue,
            NudgeRuleKind::ApproachingDeadline => Self::ApproachingDeadline,
            NudgeRuleKind::StaleTask => Self::StaleTask,
            NudgeRuleKind::EmptyToday => Self::EmptyToday,
            NudgeRuleKind::OverloadedDay => Self::OverloadedDay,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct NudgeRuleFactsDto {
    pub kind: NudgeRuleKindDto,
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub task_ids: Vec<String>,
    pub has_more: bool,
}

impl From<NudgeRuleFacts> for NudgeRuleFactsDto {
    fn from(value: NudgeRuleFacts) -> Self {
        Self {
            kind: value.kind.into(),
            task_ids: value
                .task_ids
                .into_iter()
                .map(|id| id.to_string())
                .collect(),
            has_more: value.has_more,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct NudgesResponse {
    pub rules: Vec<NudgeRuleFactsDto>,
    pub has_more: bool,
    pub tasks: Vec<TaskDto>,
    pub revision: u64,
}

impl NudgesResponse {
    pub fn from_page(page: junban_app::NudgesPage) -> Self {
        let NudgeFacts { rules, has_more } = page.facts;
        Self {
            rules: rules.into_iter().map(Into::into).collect(),
            has_more,
            tasks: page.tasks.into_iter().map(Into::into).collect(),
            revision: page.revision,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TemporalSettingsResponse {
    pub time_zone: String,
    pub capacity_minutes: u32,
    pub week_start: WeekStartDto,
    pub nudges_enabled: bool,
    pub eat_the_frog_enabled: bool,
    pub task_jar_enabled: bool,
}

impl From<junban_app::TemporalSettings> for TemporalSettingsResponse {
    fn from(value: junban_app::TemporalSettings) -> Self {
        Self {
            time_zone: value.time_zone,
            capacity_minutes: value.capacity_minutes,
            week_start: value.week_start.into(),
            nudges_enabled: value.nudges_enabled,
            eat_the_frog_enabled: value.eat_the_frog_enabled,
            task_jar_enabled: value.task_jar_enabled,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct EatTheFrogResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<TaskDto>,
    pub revision: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TaskJarResponse {
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub task_ids: Vec<String>,
    pub tasks: Vec<TaskDto>,
    pub revision: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DopamineMenuResponse {
    #[schema(value_type = Vec<String>, format = Uuid)]
    pub task_ids: Vec<String>,
    pub tasks: Vec<TaskDto>,
    pub revision: u64,
}

// ── optional/nullable helpers ──────────────────────────────────────────────

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

fn map_opt<T, U, F>(value: Option<T>, map: F, request_id: &RequestId) -> Result<Option<U>, ApiError>
where
    F: FnOnce(T) -> Result<U, ValidationError>,
{
    match value {
        None => Ok(None),
        Some(value) => Ok(Some(
            map(value).map_err(|e| validation_error(e, request_id))?,
        )),
    }
}

fn default_time_zone_name(request_id: &RequestId) -> Result<TimeZoneName, ApiError> {
    let now = jiff::Zoned::now();
    let name = now.time_zone().iana_name().unwrap_or("UTC");
    TimeZoneName::new(name.to_owned()).map_err(|e| validation_error(e, request_id))
}

fn parse_civil_time(
    raw: &str,
    field: &'static str,
    request_id: &RequestId,
) -> Result<Time, ApiError> {
    raw.parse::<Time>().map_err(|_| {
        validation_error(
            ValidationError::InvalidFormat {
                field,
                expected: "civil time HH:MM[:SS]",
            },
            request_id,
        )
    })
}

fn parse_civil_range(
    date: Date,
    start: &str,
    end: &str,
    time_zone: Option<&str>,
    request_id: &RequestId,
) -> Result<CivilTimeRange, ApiError> {
    let start = parse_civil_time(start, "start", request_id)?;
    let end = parse_civil_time(end, "end", request_id)?;
    let time_zone = match time_zone {
        Some(value) => {
            TimeZoneName::new(value.to_owned()).map_err(|e| validation_error(e, request_id))?
        }
        None => default_time_zone_name(request_id)?,
    };
    CivilTimeRange::new(date, start, end, time_zone).map_err(|e| validation_error(e, request_id))
}

fn parse_optional_civil_range(
    date: Option<Date>,
    start: Option<&str>,
    end: Option<&str>,
    time_zone: Option<&str>,
    request_id: &RequestId,
) -> Result<Option<CivilTimeRange>, ApiError> {
    match (date, start, end, time_zone) {
        (None, None, None, None) => Ok(None),
        (Some(date), Some(start), Some(end), time_zone) => Ok(Some(parse_civil_range(
            date, start, end, time_zone, request_id,
        )?)),
        _ => Err(validation_error(
            ValidationError::Invalid {
                field: "range",
                reason: "date, start, and end must be provided together",
            },
            request_id,
        )),
    }
}

fn map_opt_null<T, U, F>(
    value: Option<Option<T>>,
    map: F,
    request_id: &RequestId,
) -> Result<Option<Option<U>>, ApiError>
where
    F: FnOnce(T) -> Result<U, ValidationError>,
{
    match value {
        None => Ok(None),
        Some(None) => Ok(Some(None)),
        Some(Some(value)) => Ok(Some(Some(
            map(value).map_err(|e| validation_error(e, request_id))?,
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
fn build_task_draft(
    title: String,
    description: Option<String>,
    priority: Option<u8>,
    due_date: Option<Date>,
    due_time: Option<LocalDueTimeDto>,
    deadline: Option<Timestamp>,
    someday: bool,
    estimated_minutes: Option<u32>,
    actual_minutes: Option<u32>,
    dread: Option<u8>,
    project_id: Option<String>,
    section_id: Option<String>,
    parent_id: Option<String>,
    tag_ids: Vec<String>,
    sort_order: Option<i64>,
    recurrence_rule: Option<String>,
) -> Result<TaskDraft, ValidationError> {
    let mut draft = TaskDraft::new(TaskTitle::new(title)?);
    if let Some(description) = description {
        draft.description = MarkdownText::new(description)?;
    }
    draft.priority = priority.map(Priority::new).transpose()?;
    draft.due_date = due_date;
    draft.due_time = due_time.map(LocalDueTimeDto::try_into_domain).transpose()?;
    draft.deadline = deadline;
    draft.someday = someday;
    draft.estimated_minutes = estimated_minutes.map(EstimatedMinutes::new).transpose()?;
    draft.actual_minutes = actual_minutes.map(ActualMinutes::new).transpose()?;
    draft.dread = dread.map(DreadLevel::new).transpose()?;
    draft.project_id = project_id.as_deref().map(ProjectId::parse).transpose()?;
    draft.section_id = section_id.as_deref().map(SectionId::parse).transpose()?;
    draft.parent_id = parent_id.as_deref().map(TaskId::parse).transpose()?;
    draft.tag_ids = tag_ids
        .iter()
        .map(|id| TagId::parse(id))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(sort_order) = sort_order {
        draft.sort_order = SortOrder::new(sort_order);
    }
    draft.recurrence_rule = recurrence_rule.map(RecurrenceRule::new).transpose()?;
    Ok(draft)
}
