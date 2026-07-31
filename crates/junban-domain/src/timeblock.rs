//! Time block and time slot value types with ordered membership bounds.

use jiff::{
    Timestamp, ToSpan,
    civil::{Date, Time},
};
use serde::{Deserialize, Serialize};

use crate::{
    EntityName, HexColor, ProjectId, RecurrenceRule, TaskId, TimeBlockId, TimeSlotId, TimeZoneName,
    ValidationError,
};

/// Maximum tasks linked to one time slot.
pub const MAX_SLOT_MEMBERSHIP: usize = 100;
/// Inclusive civil-day window accepted by timeblocking range reads.
pub const MAX_TIMEBLOCK_RANGE_DAYS: i64 = 42;
/// Combined blocks + slots returned by one range read.
pub const MAX_TIMEBLOCK_RANGE_ITEMS: usize = 2_000;
/// Automatic replan examines this many complete civil days before today.
pub const REPLAN_LOOKBACK_DAYS: i64 = 7;

/// Local civil interval plus IANA zone. End must be strictly after start on the same date.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CivilTimeRange {
    pub date: Date,
    pub start: Time,
    pub end: Time,
    pub time_zone: TimeZoneName,
}

impl CivilTimeRange {
    pub fn new(
        date: Date,
        start: Time,
        end: Time,
        time_zone: TimeZoneName,
    ) -> Result<Self, ValidationError> {
        if end <= start {
            return Err(ValidationError::Invalid {
                field: "time_range",
                reason: "end must be after start on the same civil date",
            });
        }
        Ok(Self {
            date,
            start,
            end,
            time_zone,
        })
    }
}

/// Fields shared by first-party time blocks (task-linked calendar blocks).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeBlockDraft {
    pub title: EntityName,
    pub range: CivilTimeRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<HexColor>,
    #[serde(default)]
    pub locked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<TaskId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_id: Option<TimeSlotId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<RecurrenceRule>,
}

impl TimeBlockDraft {
    pub fn new(title: EntityName, range: CivilTimeRange) -> Self {
        Self {
            title,
            range,
            color: None,
            locked: false,
            task_id: None,
            slot_id: None,
            recurrence_rule: None,
        }
    }
}

/// Fields shared by first-party time slots (capacity containers with ordered tasks).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeSlotDraft {
    pub title: EntityName,
    pub range: CivilTimeRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<HexColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ProjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<RecurrenceRule>,
}

impl TimeSlotDraft {
    pub fn new(title: EntityName, range: CivilTimeRange) -> Self {
        Self {
            title,
            range,
            color: None,
            project_id: None,
            recurrence_rule: None,
        }
    }
}

/// Durable first-party time block. Recurrence is owner metadata only in Phase 3 core.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeBlock {
    pub id: TimeBlockId,
    pub title: EntityName,
    pub range: CivilTimeRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<HexColor>,
    #[serde(default)]
    pub locked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<TaskId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_id: Option<TimeSlotId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<RecurrenceRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_parent_id: Option<TimeBlockId>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub revision: u64,
}

impl TimeBlock {
    #[must_use]
    pub fn from_draft(
        id: TimeBlockId,
        draft: TimeBlockDraft,
        now: Timestamp,
        revision: u64,
    ) -> Self {
        Self {
            id,
            title: draft.title,
            range: draft.range,
            color: draft.color,
            locked: draft.locked,
            task_id: draft.task_id,
            slot_id: draft.slot_id,
            recurrence_rule: draft.recurrence_rule,
            recurrence_parent_id: None,
            created_at: now,
            updated_at: now,
            revision,
        }
    }
}

/// Durable first-party time slot with ordered unique task membership.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeSlot {
    pub id: TimeSlotId,
    pub title: EntityName,
    pub range: CivilTimeRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<HexColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ProjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<RecurrenceRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_parent_id: Option<TimeSlotId>,
    #[serde(default)]
    pub task_ids: OrderedSlotMembership,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub revision: u64,
}

impl TimeSlot {
    #[must_use]
    pub fn from_draft(id: TimeSlotId, draft: TimeSlotDraft, now: Timestamp, revision: u64) -> Self {
        Self {
            id,
            title: draft.title,
            range: draft.range,
            color: draft.color,
            project_id: draft.project_id,
            recurrence_rule: draft.recurrence_rule,
            recurrence_parent_id: None,
            task_ids: OrderedSlotMembership::empty(),
            created_at: now,
            updated_at: now,
            revision,
        }
    }
}

/// Ordered unique task membership for one slot, capped at [`MAX_SLOT_MEMBERSHIP`].
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct OrderedSlotMembership {
    task_ids: Vec<TaskId>,
}

impl OrderedSlotMembership {
    pub fn new(task_ids: Vec<TaskId>) -> Result<Self, ValidationError> {
        if task_ids.len() > MAX_SLOT_MEMBERSHIP {
            return Err(ValidationError::TooMany {
                field: "slot_task_ids",
                count: task_ids.len(),
                max: MAX_SLOT_MEMBERSHIP,
            });
        }
        let mut seen = Vec::with_capacity(task_ids.len());
        for id in &task_ids {
            if seen.contains(id) {
                return Err(ValidationError::Duplicate {
                    field: "slot_task_ids",
                });
            }
            seen.push(*id);
        }
        Ok(Self { task_ids })
    }

    #[must_use]
    pub fn empty() -> Self {
        Self {
            task_ids: Vec::new(),
        }
    }

    #[must_use]
    pub fn as_slice(&self) -> &[TaskId] {
        &self.task_ids
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.task_ids.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.task_ids.is_empty()
    }

    /// Appends when absent. Returns whether membership changed. Duplicate append is a no-op.
    pub fn append(&mut self, task_id: TaskId) -> Result<bool, ValidationError> {
        if self.task_ids.contains(&task_id) {
            return Ok(false);
        }
        if self.task_ids.len() >= MAX_SLOT_MEMBERSHIP {
            return Err(ValidationError::TooMany {
                field: "slot_task_ids",
                count: self.task_ids.len().saturating_add(1),
                max: MAX_SLOT_MEMBERSHIP,
            });
        }
        self.task_ids.push(task_id);
        Ok(true)
    }

    /// Removes a task when present. Returns whether membership changed.
    pub fn remove(&mut self, task_id: TaskId) -> bool {
        let before = self.task_ids.len();
        self.task_ids.retain(|id| *id != task_id);
        self.task_ids.len() != before
    }

    /// Replaces membership with an exact permutation of the current set.
    pub fn reorder(&mut self, ordered_ids: Vec<TaskId>) -> Result<(), ValidationError> {
        if ordered_ids.len() != self.task_ids.len() {
            return Err(ValidationError::IncompletePermutation {
                field: "ordered_ids",
            });
        }
        let mut expected = self.task_ids.clone();
        expected.sort_by_key(|id| id.as_uuid());
        let mut got = ordered_ids.clone();
        got.sort_by_key(|id| id.as_uuid());
        if expected != got {
            return Err(ValidationError::IncompletePermutation {
                field: "ordered_ids",
            });
        }
        // Preserve caller order after confirming the same set.
        let mut seen = Vec::with_capacity(ordered_ids.len());
        for id in &ordered_ids {
            if seen.contains(id) {
                return Err(ValidationError::Duplicate {
                    field: "ordered_ids",
                });
            }
            seen.push(*id);
        }
        self.task_ids = ordered_ids;
        Ok(())
    }
}

/// Validate an inclusive civil date range for timeblocking reads.
pub fn validate_timeblock_date_range(from: Date, to: Date) -> Result<(), ValidationError> {
    if to < from {
        return Err(ValidationError::Invalid {
            field: "range",
            reason: "to must be on or after from",
        });
    }
    let span_days = from
        .until(to)
        .map_err(|_| ValidationError::Invalid {
            field: "range",
            reason: "date range is not representable",
        })?
        .get_days();
    let inclusive = i64::from(span_days).saturating_add(1);
    if inclusive > MAX_TIMEBLOCK_RANGE_DAYS {
        return Err(ValidationError::TooMany {
            field: "range_days",
            count: usize::try_from(inclusive).unwrap_or(usize::MAX),
            max: usize::try_from(MAX_TIMEBLOCK_RANGE_DAYS).unwrap_or(usize::MAX),
        });
    }
    Ok(())
}

/// Prior complete civil days examined by automatic replan: `[today - lookback, yesterday]`.
pub fn replan_window(today: Date) -> Result<(Date, Date), ValidationError> {
    let start = today
        .checked_sub(REPLAN_LOOKBACK_DAYS.days())
        .map_err(|_| ValidationError::Invalid {
            field: "today",
            reason: "replan lookback is not representable",
        })?;
    let end = today
        .checked_sub(1.day())
        .map_err(|_| ValidationError::Invalid {
            field: "today",
            reason: "yesterday is not representable",
        })?;
    Ok((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jiff::civil::{Time, date};

    fn range(start_h: i8, end_h: i8) -> CivilTimeRange {
        CivilTimeRange::new(
            date(2026, 3, 8),
            Time::constant(start_h, 0, 0, 0),
            Time::constant(end_h, 0, 0, 0),
            TimeZoneName::new("UTC").unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn range_requires_end_after_start() {
        assert!(
            CivilTimeRange::new(
                date(2026, 3, 8),
                Time::constant(10, 0, 0, 0),
                Time::constant(10, 0, 0, 0),
                TimeZoneName::new("UTC").unwrap(),
            )
            .is_err()
        );
        assert!(range(9, 10).start < range(9, 10).end);
    }

    #[test]
    fn slot_membership_enforces_unique_and_max() {
        assert!(OrderedSlotMembership::new(vec![]).unwrap().is_empty());
        let id = TaskId::new();
        assert!(OrderedSlotMembership::new(vec![id, id]).is_err());
        let many = (0..=MAX_SLOT_MEMBERSHIP)
            .map(|_| TaskId::new())
            .collect::<Vec<_>>();
        assert_eq!(
            OrderedSlotMembership::new(many).unwrap_err(),
            ValidationError::TooMany {
                field: "slot_task_ids",
                count: MAX_SLOT_MEMBERSHIP + 1,
                max: MAX_SLOT_MEMBERSHIP,
            }
        );
        let ok = (0..MAX_SLOT_MEMBERSHIP)
            .map(|_| TaskId::new())
            .collect::<Vec<_>>();
        assert_eq!(OrderedSlotMembership::new(ok).unwrap().len(), 100);
        let _ = range(9, 17);
    }

    #[test]
    fn membership_append_is_idempotent_and_capped() {
        let mut membership = OrderedSlotMembership::empty();
        let id = TaskId::new();
        assert!(membership.append(id).unwrap());
        assert!(!membership.append(id).unwrap());
        assert_eq!(membership.len(), 1);
        for _ in 0..(MAX_SLOT_MEMBERSHIP - 1) {
            assert!(membership.append(TaskId::new()).unwrap());
        }
        assert_eq!(
            membership.append(TaskId::new()).unwrap_err(),
            ValidationError::TooMany {
                field: "slot_task_ids",
                count: MAX_SLOT_MEMBERSHIP + 1,
                max: MAX_SLOT_MEMBERSHIP,
            }
        );
    }

    #[test]
    fn membership_reorder_requires_exact_permutation() {
        let a = TaskId::new();
        let b = TaskId::new();
        let mut membership = OrderedSlotMembership::new(vec![a, b]).unwrap();
        membership.reorder(vec![b, a]).unwrap();
        assert_eq!(membership.as_slice(), &[b, a]);
        assert!(membership.reorder(vec![a]).is_err());
        assert!(membership.reorder(vec![a, TaskId::new()]).is_err());
        assert!(membership.remove(a));
        assert!(!membership.remove(a));
        assert_eq!(membership.as_slice(), &[b]);
    }

    #[test]
    fn range_bounds_are_inclusive_and_capped() {
        let from = date(2026, 3, 1);
        assert!(validate_timeblock_date_range(from, from).is_ok());
        let ok_to = from.checked_add(41.days()).unwrap();
        assert!(validate_timeblock_date_range(from, ok_to).is_ok());
        let over = from.checked_add(42.days()).unwrap();
        assert!(matches!(
            validate_timeblock_date_range(from, over),
            Err(ValidationError::TooMany {
                field: "range_days",
                ..
            })
        ));
        assert!(validate_timeblock_date_range(over, from).is_err());
    }

    #[test]
    fn replan_window_covers_prior_seven_days() {
        let today = date(2026, 3, 15);
        let (start, end) = replan_window(today).unwrap();
        assert_eq!(start, date(2026, 3, 8));
        assert_eq!(end, date(2026, 3, 14));
    }
}
