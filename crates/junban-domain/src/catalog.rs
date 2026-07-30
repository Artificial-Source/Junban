//! Organization entities: projects, sections, tags, templates, comments, relations, filters.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};

use crate::{
    CommentBody, CommentId, EntityName, FilterQuery, HexColor, IconText, MarkdownText, OperationId,
    Priority, ProjectId, ProjectView, RecurrenceRule, RelationKind, SavedFilterId, SectionId,
    SortOrder, TagId, TagName, TaskDraft, TaskId, TaskTitle, TemplateId, ValidationError,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub id: ProjectId,
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
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Project {
    #[must_use]
    pub fn new(id: ProjectId, name: EntityName, color: HexColor, now: Timestamp) -> Self {
        Self {
            id,
            name,
            color,
            icon: None,
            parent_id: None,
            favorite: false,
            archived: false,
            view: ProjectView::List,
            sort_order: SortOrder::default(),
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Section {
    pub id: SectionId,
    pub project_id: ProjectId,
    pub name: EntityName,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub sort_order: SortOrder,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Section {
    #[must_use]
    pub fn new(id: SectionId, project_id: ProjectId, name: EntityName, now: Timestamp) -> Self {
        Self {
            id,
            project_id,
            name,
            collapsed: false,
            sort_order: SortOrder::default(),
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tag {
    pub id: TagId,
    pub name: TagName,
    pub color: HexColor,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Tag {
    #[must_use]
    pub fn new(id: TagId, name: TagName, color: HexColor, now: Timestamp) -> Self {
        Self {
            id,
            name,
            color,
            created_at: now,
            updated_at: now,
        }
    }
}

/// Template stores task draft fields and `{{variable}}` source text only—no macro language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Template {
    pub id: TemplateId,
    pub name: EntityName,
    /// Title pattern; may contain `{{variable}}` placeholders.
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
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Template {
    /// Materialize a draft after the caller substitutes `{{variable}}` placeholders.
    pub fn draft_after_substitution(
        &self,
        title: TaskTitle,
        description: MarkdownText,
    ) -> TaskDraft {
        let mut draft = TaskDraft::new(title);
        draft.description = description;
        draft.priority = self.priority;
        draft.project_id = self.project_id;
        draft.recurrence_rule = self.recurrence_rule.clone();
        draft
    }

    /// Substitute `{{name}}` placeholders using exact key matches. Unknown keys stay literal.
    #[must_use]
    pub fn substitute(input: &str, variables: &[(&str, &str)]) -> String {
        if !input.contains("{{") {
            return input.to_owned();
        }
        let mut output = input.to_owned();
        for &(key, value) in variables {
            let needle = format!("{{{{{key}}}}}");
            output = output.replace(&needle, value);
        }
        output
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Comment {
    pub id: CommentId,
    pub task_id: TaskId,
    pub content: CommentBody,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Directed task relation. Phase 2 only models `blocks`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskRelation {
    pub from_task_id: TaskId,
    pub to_task_id: TaskId,
    pub kind: RelationKind,
}

impl TaskRelation {
    pub fn blocks(from_task_id: TaskId, to_task_id: TaskId) -> Result<Self, ValidationError> {
        if from_task_id == to_task_id {
            return Err(ValidationError::Invalid {
                field: "task_relation",
                reason: "a task cannot block itself",
            });
        }
        Ok(Self {
            from_task_id,
            to_task_id,
            kind: RelationKind::Blocks,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedFilter {
    pub id: SavedFilterId,
    pub name: EntityName,
    pub query: FilterQuery,
    /// Optional accent color, matching the visible legacy saved-filter contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<HexColor>,
    #[serde(default)]
    pub sort_order: SortOrder,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl SavedFilter {
    #[must_use]
    pub fn new(id: SavedFilterId, name: EntityName, query: FilterQuery, now: Timestamp) -> Self {
        Self {
            id,
            name,
            query,
            color: None,
            sort_order: SortOrder::default(),
            created_at: now,
            updated_at: now,
        }
    }
}

/// Serialized task-activity action vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskActivityAction {
    Created,
    Updated,
    Completed,
    Uncompleted,
    Cancelled,
    Reopened,
    Deleted,
    Restored,
}

/// Field-level task activity value written beside mutations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskActivity {
    /// Global committed revision; the first half of the stable page cursor.
    pub revision: u64,
    /// Deterministic order among activity rows in the same committed operation.
    pub sequence: u32,
    pub operation_id: OperationId,
    pub task_id: TaskId,
    pub action: TaskActivityAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_value: Option<String>,
    pub created_at: Timestamp,
}
