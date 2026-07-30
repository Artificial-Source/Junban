//! Time block and time slot value types with ordered membership bounds.

use jiff::civil::{Date, Time};
use serde::{Deserialize, Serialize};

use crate::{
    EntityName, HexColor, ProjectId, RecurrenceRule, TaskId, TimeZoneName, ValidationError,
};

/// Maximum tasks linked to one time slot.
pub const MAX_SLOT_MEMBERSHIP: usize = 100;

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

/// Ordered unique task membership for one slot, capped at [`MAX_SLOT_MEMBERSHIP`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
}
