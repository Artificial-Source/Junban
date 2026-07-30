//! Shared mutation request, inverse, and post-image types.

use std::collections::BTreeMap;

use junban_app::{MoveTarget, OrderAnchor, RepositoryError};
use junban_domain::{Comment, CommentId, SortOrder, Task, TaskActivity, TaskId, TaskRelation};
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
    },
    /// Undo a completion that may have generated next occurrences.
    ReverseCompletion {
        /// Pre-completion source images (pending).
        sources: Vec<Task>,
        /// Generated child IDs owned by the completion receipt.
        generated_ids: Vec<TaskId>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TaskClosure {
    pub tasks: Vec<Task>,
    pub comments: Vec<Comment>,
    pub relations: Vec<TaskRelation>,
    pub activity: Vec<TaskActivity>,
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

pub(crate) fn status_name(status: junban_domain::TaskStatus) -> &'static str {
    match status {
        junban_domain::TaskStatus::Pending => "pending",
        junban_domain::TaskStatus::Completed => "completed",
        junban_domain::TaskStatus::Cancelled => "cancelled",
    }
}

#[allow(dead_code)]
pub(crate) fn _keep_order_anchor(_: &OrderAnchor, _: &MoveTarget) {}
