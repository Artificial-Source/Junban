//! Shared mutation request, inverse, and post-image types.

use std::collections::BTreeMap;

use junban_app::{MoveTarget, OrderAnchor, RepositoryError};
use junban_domain::{
    Comment, CommentId, ReminderOccurrence, SortOrder, Task, TaskActivity, TaskId, TaskRelation,
    TimeBlockId, TimeSlotId,
};
use serde::{Deserialize, Serialize};

use crate::rows::storage_error;
use crate::tx::UndoRecord;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Inverse {
    DeleteTasks {
        task_ids: Vec<TaskId>,
    },
    RestoreClosure {
        closure: TaskClosure,
    },
    RestoreTasks {
        tasks: Vec<Task>,
        /// Full occurrence snapshot for the restored tasks (exact undo/retry).
        #[serde(default)]
        reminders: Vec<ReminderOccurrence>,
        /// Exact slot memberships detached by the paired delete inverse (redo undo).
        #[serde(default)]
        slot_memberships: Vec<ClosureSlotMembership>,
        /// Exact block task links detached by the paired delete inverse (redo undo).
        #[serde(default)]
        block_links: Vec<ClosureBlockLink>,
    },
    /// Undo a completion that may have generated next occurrences.
    ReverseCompletion {
        /// Pre-completion source images (pending).
        sources: Vec<Task>,
        /// Generated child IDs owned by the completion receipt.
        generated_ids: Vec<TaskId>,
        /// Pre-completion occurrence rows for the source tasks.
        #[serde(default)]
        source_reminders: Vec<ReminderOccurrence>,
    },
    RestoreOrders {
        orders: Vec<(TaskId, SortOrder)>,
    },
    RestoreComment {
        before: Option<Comment>,
        after_id: CommentId,
    },
    RestoreRelation {
        relation: TaskRelation,
        present: bool,
    },
}

/// Exact slot membership row owned by a deleted task closure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ClosureSlotMembership {
    pub slot_id: TimeSlotId,
    pub task_id: TaskId,
    pub position: i64,
}

/// Exact time-block task link owned by a deleted task closure.
/// The block row itself is retained; only `task_id` is cleared on delete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ClosureBlockLink {
    pub block_id: TimeBlockId,
    pub task_id: TaskId,
}

/// Post-delete slot state used to fail closed if membership changes before undo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PostTimeSlotState {
    pub revision: u64,
    pub task_ids: Vec<TaskId>,
}

/// Post-delete block state used to fail closed if the task link changes before undo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PostTimeBlockState {
    pub revision: u64,
    pub task_id: Option<TaskId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TaskClosure {
    pub tasks: Vec<Task>,
    pub comments: Vec<Comment>,
    pub relations: Vec<TaskRelation>,
    pub activity: Vec<TaskActivity>,
    #[serde(default)]
    pub reminders: Vec<ReminderOccurrence>,
    /// Slot memberships for every task in the deleted closure (exact positions).
    #[serde(default)]
    pub slot_memberships: Vec<ClosureSlotMembership>,
    /// Block task links for every task in the deleted closure (blocks remain).
    #[serde(default)]
    pub block_links: Vec<ClosureBlockLink>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct PostImage {
    #[serde(default)]
    pub tasks: BTreeMap<String, Task>,
    #[serde(default)]
    pub absent_task_ids: Vec<TaskId>,
    #[serde(default)]
    pub comments: BTreeMap<String, Comment>,
    #[serde(default)]
    pub absent_comment_ids: Vec<CommentId>,
    #[serde(default)]
    pub relations_present: Vec<TaskRelation>,
    #[serde(default)]
    pub relations_absent: Vec<TaskRelation>,
    #[serde(default)]
    pub orders: BTreeMap<String, i64>,
    /// Expected occurrence rows after the mutation (keyed by task_id/remind_at).
    #[serde(default)]
    pub reminders: BTreeMap<String, ReminderOccurrence>,
    /// Expected slot membership/revision after the mutation (keyed by slot id).
    #[serde(default)]
    pub time_slots: BTreeMap<String, PostTimeSlotState>,
    /// Expected block task link/revision after the mutation (keyed by block id).
    #[serde(default)]
    pub time_blocks: BTreeMap<String, PostTimeBlockState>,
}

pub(crate) fn post_from_tasks(tasks: impl IntoIterator<Item = Task>) -> PostImage {
    let mut image = PostImage::default();
    for task in tasks {
        image
            .orders
            .insert(task.id.to_string(), task.sort_order.get());
        image.tasks.insert(task.id.to_string(), task);
    }
    image
}

pub(crate) fn undo_pair(
    inverse: &Inverse,
    post: &PostImage,
) -> Result<UndoRecord, RepositoryError> {
    Ok(UndoRecord {
        inverse_json: serde_json::to_string(inverse).map_err(storage_error)?,
        post_image_json: serde_json::to_string(post).map_err(storage_error)?,
    })
}

/// Build a task-row restore inverse without planning-link material.
pub(crate) fn restore_tasks_inverse(
    tasks: Vec<Task>,
    reminders: Vec<ReminderOccurrence>,
) -> Inverse {
    Inverse::RestoreTasks {
        tasks,
        reminders,
        slot_memberships: Vec::new(),
        block_links: Vec::new(),
    }
}

/// Build a restore inverse that also reattaches receipt-owned planning links.
pub(crate) fn restore_tasks_with_planning(
    tasks: Vec<Task>,
    reminders: Vec<ReminderOccurrence>,
    slot_memberships: Vec<ClosureSlotMembership>,
    block_links: Vec<ClosureBlockLink>,
) -> Inverse {
    Inverse::RestoreTasks {
        tasks,
        reminders,
        slot_memberships,
        block_links,
    }
}

pub(crate) fn status_name(status: junban_domain::TaskStatus) -> &'static str {
    match status {
        junban_domain::TaskStatus::Pending => "pending",
        junban_domain::TaskStatus::Completed => "completed",
        junban_domain::TaskStatus::Cancelled => "cancelled",
    }
}

#[allow(dead_code)]
pub(crate) fn _keep_order_anchor(_: &OrderAnchor, _: &MoveTarget) {}
