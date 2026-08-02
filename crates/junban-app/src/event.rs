//! One committed mutation publishes exactly one revisioned event envelope.

use jiff::Timestamp;
use junban_domain::{
    Comment, CommentId, OperationId, Project, ProjectId, SavedFilter, SavedFilterId, Section,
    SectionId, Tag, TagId, Task, TaskId, Template, TemplateId, TimeBlock, TimeBlockId, TimeSlot,
    TimeSlotId, UncompleteOutcome,
};
use serde::{Deserialize, Serialize};

/// Stable event type strings used in storage, SSE, and receipts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EventType(String);

impl EventType {
    pub const TASK_CREATED: &'static str = "task.created";
    pub const TASK_UPDATED: &'static str = "task.updated";
    pub const TASK_COMPLETED: &'static str = "task.completed";
    pub const TASK_UNCOMPLETED: &'static str = "task.uncompleted";
    pub const TASK_CANCELLED: &'static str = "task.cancelled";
    pub const TASK_REOPENED: &'static str = "task.reopened";
    pub const TASK_DELETED: &'static str = "task.deleted";
    pub const TASK_MOVED: &'static str = "task.moved";
    pub const TASK_REORDERED: &'static str = "task.reordered";
    pub const TASK_BULK: &'static str = "task.bulk";
    pub const TASK_RESTORED: &'static str = "task.restored";
    pub const PROJECT_CREATED: &'static str = "project.created";
    pub const PROJECT_UPDATED: &'static str = "project.updated";
    pub const PROJECT_DELETED: &'static str = "project.deleted";
    pub const SECTION_CREATED: &'static str = "section.created";
    pub const SECTION_UPDATED: &'static str = "section.updated";
    pub const SECTION_DELETED: &'static str = "section.deleted";
    pub const TAG_CREATED: &'static str = "tag.created";
    pub const TAG_UPDATED: &'static str = "tag.updated";
    pub const TAG_DELETED: &'static str = "tag.deleted";
    pub const TEMPLATE_CREATED: &'static str = "template.created";
    pub const TEMPLATE_UPDATED: &'static str = "template.updated";
    pub const TEMPLATE_DELETED: &'static str = "template.deleted";
    pub const TEMPLATE_APPLIED: &'static str = "template.applied";
    pub const SAVED_FILTER_CREATED: &'static str = "saved_filter.created";
    pub const SAVED_FILTER_UPDATED: &'static str = "saved_filter.updated";
    pub const SAVED_FILTER_DELETED: &'static str = "saved_filter.deleted";
    pub const COMMENT_CREATED: &'static str = "comment.created";
    pub const COMMENT_UPDATED: &'static str = "comment.updated";
    pub const COMMENT_DELETED: &'static str = "comment.deleted";
    pub const RELATION_ADDED: &'static str = "relation.added";
    pub const RELATION_REMOVED: &'static str = "relation.removed";
    pub const OPERATION_UNDONE: &'static str = "operation.undone";
    pub const TIME_BLOCK_CREATED: &'static str = "time_block.created";
    pub const TIME_BLOCK_UPDATED: &'static str = "time_block.updated";
    pub const TIME_BLOCK_DELETED: &'static str = "time_block.deleted";
    pub const TIME_BLOCK_REPLANNED: &'static str = "time_block.replanned";
    pub const TIME_SLOT_CREATED: &'static str = "time_slot.created";
    pub const TIME_SLOT_UPDATED: &'static str = "time_slot.updated";
    pub const TIME_SLOT_DELETED: &'static str = "time_slot.deleted";
    pub const TIME_SLOT_MEMBERSHIP_UPDATED: &'static str = "time_slot.membership_updated";
    pub const SETTINGS_UPDATED: &'static str = "settings.updated";
    pub const IMPORT_APPLIED: &'static str = "import.applied";

    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&'static str> for EventType {
    fn from(value: &'static str) -> Self {
        Self::new(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceType {
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
    Settings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceRef {
    pub resource_type: ResourceType,
    pub id: String,
}

impl ResourceRef {
    #[must_use]
    pub fn task(id: TaskId) -> Self {
        Self {
            resource_type: ResourceType::Task,
            id: id.to_string(),
        }
    }

    #[must_use]
    pub fn project(id: ProjectId) -> Self {
        Self {
            resource_type: ResourceType::Project,
            id: id.to_string(),
        }
    }

    #[must_use]
    pub fn section(id: SectionId) -> Self {
        Self {
            resource_type: ResourceType::Section,
            id: id.to_string(),
        }
    }

    #[must_use]
    pub fn tag(id: TagId) -> Self {
        Self {
            resource_type: ResourceType::Tag,
            id: id.to_string(),
        }
    }

    #[must_use]
    pub fn template(id: TemplateId) -> Self {
        Self {
            resource_type: ResourceType::Template,
            id: id.to_string(),
        }
    }

    #[must_use]
    pub fn saved_filter(id: SavedFilterId) -> Self {
        Self {
            resource_type: ResourceType::SavedFilter,
            id: id.to_string(),
        }
    }

    #[must_use]
    pub fn comment(id: CommentId) -> Self {
        Self {
            resource_type: ResourceType::Comment,
            id: id.to_string(),
        }
    }

    #[must_use]
    pub fn operation(id: OperationId) -> Self {
        Self {
            resource_type: ResourceType::Operation,
            id: id.to_string(),
        }
    }

    #[must_use]
    pub fn time_block(id: TimeBlockId) -> Self {
        Self {
            resource_type: ResourceType::TimeBlock,
            id: id.to_string(),
        }
    }

    #[must_use]
    pub fn time_slot(id: TimeSlotId) -> Self {
        Self {
            resource_type: ResourceType::TimeSlot,
            id: id.to_string(),
        }
    }

    #[must_use]
    pub fn settings() -> Self {
        Self {
            resource_type: ResourceType::Settings,
            id: "settings".to_owned(),
        }
    }
}

/// At most one tagged resource snapshot is attached to a single-resource event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "resource_type", rename_all = "snake_case")]
pub enum ResourceSnapshot {
    Task { task: Task },
    Project { project: Project },
    Section { section: Section },
    Tag { tag: Tag },
    Template { template: Template },
    SavedFilter { saved_filter: SavedFilter },
    Comment { comment: Comment },
    TimeBlock { time_block: TimeBlock },
    TimeSlot { time_slot: TimeSlot },
}

impl ResourceSnapshot {
    #[must_use]
    pub fn task(task: Task) -> Self {
        Self::Task { task }
    }

    #[must_use]
    pub fn as_task(&self) -> Option<&Task> {
        match self {
            Self::Task { task } => Some(task),
            _ => None,
        }
    }

    #[must_use]
    pub fn time_block(time_block: TimeBlock) -> Self {
        Self::TimeBlock { time_block }
    }

    #[must_use]
    pub fn time_slot(time_slot: TimeSlot) -> Self {
        Self::TimeSlot { time_slot }
    }

    #[must_use]
    pub fn as_time_block(&self) -> Option<&TimeBlock> {
        match self {
            Self::TimeBlock { time_block } => Some(time_block),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_time_slot(&self) -> Option<&TimeSlot> {
        match self {
            Self::TimeSlot { time_slot } => Some(time_slot),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AffectedIds {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_ids: Vec<TaskId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub project_ids: Vec<ProjectId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub section_ids: Vec<SectionId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_ids: Vec<TagId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub template_ids: Vec<TemplateId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub saved_filter_ids: Vec<SavedFilterId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub comment_ids: Vec<CommentId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub time_block_ids: Vec<TimeBlockId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub time_slot_ids: Vec<TimeSlotId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResyncScope {
    /// Clients should re-query task lists rather than apply task arrays.
    pub tasks: bool,
    /// Clients should reload the organization catalog snapshot.
    pub catalog: bool,
    /// Clients should reload the settings aggregate.
    #[serde(default)]
    pub settings: bool,
}

impl ResyncScope {
    pub const NONE: Self = Self {
        tasks: false,
        catalog: false,
        settings: false,
    };
    pub const TASKS: Self = Self {
        tasks: true,
        catalog: false,
        settings: false,
    };
    pub const CATALOG: Self = Self {
        tasks: false,
        catalog: true,
        settings: false,
    };
    pub const SETTINGS: Self = Self {
        tasks: false,
        catalog: false,
        settings: true,
    };
    pub const BOTH: Self = Self {
        tasks: true,
        catalog: true,
        settings: false,
    };
}

/// One global revision = one durable event = one post-commit publication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommittedEvent {
    pub revision: u64,
    pub operation_id: OperationId,
    pub event_type: EventType,
    pub occurred_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<ResourceRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<ResourceSnapshot>,
    #[serde(default)]
    pub affected: AffectedIds,
    pub resync: ResyncScope,
}

/// Mutation response carries the single committed event envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommittedMutation {
    pub event: CommittedEvent,
    /// Present for ordinary uncomplete; retained in receipt material for exact retry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uncomplete_outcome: Option<UncompleteOutcome>,
    /// True only for a freshly committed mutation. Receipt replays stay false and
    /// are never serialized, so HTTP bodies remain byte-identical across retries.
    #[serde(skip, default)]
    pub newly_committed: bool,
}

impl PartialEq for CommittedMutation {
    fn eq(&self, other: &Self) -> bool {
        // Publication bookkeeping is not part of the durable mutation identity.
        self.event == other.event && self.uncomplete_outcome == other.uncomplete_outcome
    }
}

impl Eq for CommittedMutation {}

impl CommittedMutation {
    #[must_use]
    pub fn task(&self) -> Option<&Task> {
        self.event
            .snapshot
            .as_ref()
            .and_then(ResourceSnapshot::as_task)
    }

    #[must_use]
    pub fn time_block(&self) -> Option<&TimeBlock> {
        self.event
            .snapshot
            .as_ref()
            .and_then(ResourceSnapshot::as_time_block)
    }

    #[must_use]
    pub fn time_slot(&self) -> Option<&TimeSlot> {
        self.event
            .snapshot
            .as_ref()
            .and_then(ResourceSnapshot::as_time_slot)
    }
}

/// Maximum events returned by one catch-up page.
pub const EVENT_CATCHUP_MAX_COUNT: usize = 100;
/// Maximum serialized event JSON bytes returned by one catch-up page.
pub const EVENT_CATCHUP_MAX_BYTES: usize = 2 * 1024 * 1024;
/// Maximum durable events retained after post-commit pruning.
pub const EVENT_RETAIN_MAX_COUNT: usize = 2048;
/// Maximum total durable event JSON retained after post-commit pruning.
pub const EVENT_RETAIN_MAX_BYTES: usize = 64 * 1024 * 1024;

/// Bounded durable event catch-up. Never scans or returns unbounded history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventCatchUp {
    /// Page of events after the requested revision.
    Page {
        events: Vec<CommittedEvent>,
        has_more: bool,
        latest_revision: u64,
    },
    /// Client cursor predates retained history; full resync is required.
    ResyncRequired { latest_revision: u64 },
}
