//! Pure structural invariants that do not require storage access.

use std::collections::{HashMap, HashSet};

use crate::{
    ProjectId, TagId, TaskId, ValidationError, task::validate_tag_ids, values::MAX_BULK_IDS,
};

/// Reject self-parenting and cycles given the proposed parent and existing child→parent edges.
pub fn validate_parent_chain(
    task_id: TaskId,
    parent_id: Option<TaskId>,
    child_to_parent: &[(TaskId, TaskId)],
) -> Result<(), ValidationError> {
    let Some(mut current) = parent_id else {
        return Ok(());
    };
    if current == task_id {
        return Err(ValidationError::Invalid {
            field: "parent_id",
            reason: "a task cannot be its own parent",
        });
    }

    let mut parents: HashMap<TaskId, TaskId> = HashMap::with_capacity(child_to_parent.len());
    for &(child, parent) in child_to_parent {
        parents.insert(child, parent);
    }
    // Apply the proposed edge for cycle detection.
    parents.insert(task_id, current);

    let mut seen = HashSet::new();
    seen.insert(task_id);
    while let Some(next) = parents.get(&current).copied() {
        if next == task_id || !seen.insert(next) {
            return Err(ValidationError::Cycle { field: "parent_id" });
        }
        current = next;
    }
    Ok(())
}

/// A reorder request must be a complete, duplicate-free permutation of one sibling scope.
pub fn validate_reorder_permutation(
    scope_ids: &[TaskId],
    ordered_ids: &[TaskId],
) -> Result<(), ValidationError> {
    if scope_ids.len() != ordered_ids.len() {
        return Err(ValidationError::IncompletePermutation {
            field: "ordered_ids",
        });
    }
    if ordered_ids.len() > MAX_BULK_IDS {
        return Err(ValidationError::TooMany {
            field: "ordered_ids",
            count: ordered_ids.len(),
            max: MAX_BULK_IDS,
        });
    }

    let mut scope: HashSet<TaskId> = scope_ids.iter().copied().collect();
    if scope.len() != scope_ids.len() {
        return Err(ValidationError::Duplicate { field: "scope_ids" });
    }

    let mut seen = HashSet::with_capacity(ordered_ids.len());
    for id in ordered_ids {
        if !seen.insert(*id) {
            return Err(ValidationError::Duplicate {
                field: "ordered_ids",
            });
        }
        if !scope.remove(id) {
            return Err(ValidationError::IncompletePermutation {
                field: "ordered_ids",
            });
        }
    }
    if !scope.is_empty() {
        return Err(ValidationError::IncompletePermutation {
            field: "ordered_ids",
        });
    }
    Ok(())
}

/// Bulk and reorder operations accept at most [`MAX_BULK_IDS`] unique task IDs.
/// One user mutation still carries a single [`crate::OperationId`].
pub fn validate_unique_bulk_ids(ids: &[TaskId]) -> Result<(), ValidationError> {
    if ids.len() > MAX_BULK_IDS {
        return Err(ValidationError::TooMany {
            field: "task_ids",
            count: ids.len(),
            max: MAX_BULK_IDS,
        });
    }
    let unique = ids.iter().copied().collect::<HashSet<_>>();
    if unique.len() != ids.len() {
        return Err(ValidationError::Duplicate { field: "task_ids" });
    }
    Ok(())
}

/// At most 100 unique tags may be assigned to one task.
pub fn validate_task_tags(tag_ids: &[TagId]) -> Result<(), ValidationError> {
    validate_tag_ids(tag_ids)
}

/// Reject self-parenting and cycles for projects given the proposed parent edge.
pub fn validate_project_parent_chain(
    project_id: ProjectId,
    parent_id: Option<ProjectId>,
    child_to_parent: &[(ProjectId, ProjectId)],
) -> Result<(), ValidationError> {
    let Some(mut current) = parent_id else {
        return Ok(());
    };
    if current == project_id {
        return Err(ValidationError::Invalid {
            field: "parent_id",
            reason: "a project cannot be its own parent",
        });
    }

    let mut parents: HashMap<ProjectId, ProjectId> = HashMap::with_capacity(child_to_parent.len());
    for &(child, parent) in child_to_parent {
        parents.insert(child, parent);
    }
    parents.insert(project_id, current);

    let mut seen = HashSet::new();
    seen.insert(project_id);
    while let Some(next) = parents.get(&current).copied() {
        if next == project_id || !seen.insert(next) {
            return Err(ValidationError::Cycle { field: "parent_id" });
        }
        current = next;
    }
    Ok(())
}

/// Return true when adding `from_task_id` blocks `to_task_id` would introduce a cycle.
///
/// `existing` lists directed edges as `(blocker, blocked)`.
#[must_use]
pub fn blocks_edge_creates_cycle(
    existing: &[(TaskId, TaskId)],
    from_task_id: TaskId,
    to_task_id: TaskId,
) -> bool {
    if from_task_id == to_task_id {
        return true;
    }

    let mut adjacency: HashMap<TaskId, Vec<TaskId>> = HashMap::new();
    for &(from, to) in existing {
        adjacency.entry(from).or_default().push(to);
    }
    adjacency.entry(from_task_id).or_default().push(to_task_id);

    // If `to` can reach `from` after the insert, the new edge closes a cycle.
    let mut stack = vec![to_task_id];
    let mut seen = HashSet::new();
    while let Some(node) = stack.pop() {
        if node == from_task_id {
            return true;
        }
        if !seen.insert(node) {
            continue;
        }
        if let Some(next) = adjacency.get(&node) {
            stack.extend(next.iter().copied());
        }
    }
    false
}
