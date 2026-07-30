//! Capacity settings and Smart Nudge fact bounds.
//!
//! Full nudge evaluation against task sets is owned by later app/storage waves.
//! Domain only freezes rule kinds, capacity values, and result-size ceilings.

use jiff::civil::Weekday;
use serde::{Deserialize, Serialize};

use crate::{TaskId, ValidationError};

/// Maximum tasks returned for one nudge rule.
pub const MAX_NUDGE_TASKS_PER_RULE: usize = 20;
/// Maximum tasks across all nudge rules in one evaluation response.
pub const MAX_NUDGE_TASKS_COMBINED: usize = 50;

/// The five first-party Smart Nudge rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NudgeRuleKind {
    Overdue,
    ApproachingDeadline,
    StaleTask,
    EmptyToday,
    OverloadedDay,
}

impl NudgeRuleKind {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "overdue" => Ok(Self::Overdue),
            "approaching_deadline" => Ok(Self::ApproachingDeadline),
            "stale_task" => Ok(Self::StaleTask),
            "empty_today" => Ok(Self::EmptyToday),
            "overloaded_day" => Ok(Self::OverloadedDay),
            _ => Err(ValidationError::InvalidFormat {
                field: "nudge_rule",
                expected: "overdue|approaching_deadline|stale_task|empty_today|overloaded_day",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Overdue => "overdue",
            Self::ApproachingDeadline => "approaching_deadline",
            Self::StaleTask => "stale_task",
            Self::EmptyToday => "empty_today",
            Self::OverloadedDay => "overloaded_day",
        }
    }

    /// Stable iteration order for deterministic multi-rule evaluation.
    pub const ALL: [Self; 5] = [
        Self::Overdue,
        Self::ApproachingDeadline,
        Self::StaleTask,
        Self::EmptyToday,
        Self::OverloadedDay,
    ];
}

/// Per-rule enablement and optional threshold used by settings storage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NudgeRuleSettings {
    pub kind: NudgeRuleKind,
    pub enabled: bool,
    /// Rule-specific whole-day or whole-minute threshold when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<u32>,
}

impl NudgeRuleSettings {
    pub fn new(kind: NudgeRuleKind, enabled: bool, threshold: Option<u32>) -> Self {
        Self {
            kind,
            enabled,
            threshold,
        }
    }
}

/// Configured daily planning capacity in whole minutes (replaces hard-coded 480).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DailyCapacityMinutes(u32);

impl DailyCapacityMinutes {
    pub const DEFAULT: Self = Self(480);

    pub fn new(value: u32) -> Result<Self, ValidationError> {
        if value == 0 {
            return Err(ValidationError::TooSmall {
                field: "daily_capacity_minutes",
                min: 1,
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// Work-week start day used by Calendar and Weekly Review.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WeekStart {
    Monday,
    Sunday,
}

impl WeekStart {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "monday" => Ok(Self::Monday),
            "sunday" => Ok(Self::Sunday),
            _ => Err(ValidationError::InvalidFormat {
                field: "week_start",
                expected: "monday|sunday",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Monday => "monday",
            Self::Sunday => "sunday",
        }
    }

    #[must_use]
    pub const fn to_weekday(self) -> Weekday {
        match self {
            Self::Monday => Weekday::Monday,
            Self::Sunday => Weekday::Sunday,
        }
    }
}

/// Local work-hours window on a civil clock (end strictly after start).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkHours {
    pub start_minute: u16,
    pub end_minute: u16,
}

impl WorkHours {
    pub const MINUTES_PER_DAY: u16 = 24 * 60;

    pub fn new(start_minute: u16, end_minute: u16) -> Result<Self, ValidationError> {
        if start_minute >= Self::MINUTES_PER_DAY || end_minute > Self::MINUTES_PER_DAY {
            return Err(ValidationError::OutOfRange {
                field: "work_hours",
                min: 0,
                max: i64::from(Self::MINUTES_PER_DAY),
            });
        }
        if end_minute <= start_minute {
            return Err(ValidationError::Invalid {
                field: "work_hours",
                reason: "end must be after start",
            });
        }
        Ok(Self {
            start_minute,
            end_minute,
        })
    }

    #[must_use]
    pub const fn duration_minutes(self) -> u16 {
        self.end_minute - self.start_minute
    }
}

/// Phase 3 temporal capacity/planning settings bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapacitySettings {
    pub daily_capacity: DailyCapacityMinutes,
    pub week_start: WeekStart,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_hours: Option<WorkHours>,
}

impl CapacitySettings {
    pub fn new(
        daily_capacity: DailyCapacityMinutes,
        week_start: WeekStart,
        work_hours: Option<WorkHours>,
    ) -> Self {
        Self {
            daily_capacity,
            week_start,
            work_hours,
        }
    }
}

/// One rule's bounded task hits plus overflow flag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NudgeRuleFacts {
    pub kind: NudgeRuleKind,
    pub task_ids: Vec<TaskId>,
    pub has_more: bool,
}

impl NudgeRuleFacts {
    pub fn new(
        kind: NudgeRuleKind,
        task_ids: Vec<TaskId>,
        has_more: bool,
    ) -> Result<Self, ValidationError> {
        if task_ids.len() > MAX_NUDGE_TASKS_PER_RULE {
            return Err(ValidationError::TooMany {
                field: "nudge_rule_tasks",
                count: task_ids.len(),
                max: MAX_NUDGE_TASKS_PER_RULE,
            });
        }
        Ok(Self {
            kind,
            task_ids,
            has_more,
        })
    }
}

/// Combined nudge evaluation payload with the frozen combined ceiling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NudgeFacts {
    pub rules: Vec<NudgeRuleFacts>,
    pub has_more: bool,
}

impl NudgeFacts {
    pub fn new(rules: Vec<NudgeRuleFacts>) -> Result<Self, ValidationError> {
        let mut total = 0usize;
        let mut seen_kinds = Vec::with_capacity(rules.len());
        for rule in &rules {
            if seen_kinds.contains(&rule.kind) {
                return Err(ValidationError::Duplicate {
                    field: "nudge_rules",
                });
            }
            seen_kinds.push(rule.kind);
            total = total.saturating_add(rule.task_ids.len());
        }
        if total > MAX_NUDGE_TASKS_COMBINED {
            return Err(ValidationError::TooMany {
                field: "nudge_tasks",
                count: total,
                max: MAX_NUDGE_TASKS_COMBINED,
            });
        }
        let has_more = rules.iter().any(|rule| rule.has_more);
        Ok(Self { rules, has_more })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_and_work_hours_validate() {
        assert_eq!(DailyCapacityMinutes::DEFAULT.get(), 480);
        assert!(DailyCapacityMinutes::new(0).is_err());
        assert_eq!(WeekStart::parse("monday").unwrap(), WeekStart::Monday);
        assert!(WeekStart::parse("friday").is_err());
        assert!(WorkHours::new(9 * 60, 9 * 60).is_err());
        assert_eq!(
            WorkHours::new(9 * 60, 17 * 60).unwrap().duration_minutes(),
            480
        );
    }

    #[test]
    fn nudge_fact_bounds() {
        let ids = (0..MAX_NUDGE_TASKS_PER_RULE + 1)
            .map(|_| TaskId::new())
            .collect::<Vec<_>>();
        assert!(NudgeRuleFacts::new(NudgeRuleKind::Overdue, ids, false).is_err());

        let rule = NudgeRuleFacts::new(
            NudgeRuleKind::Overdue,
            (0..MAX_NUDGE_TASKS_PER_RULE)
                .map(|_| TaskId::new())
                .collect(),
            true,
        )
        .unwrap();
        let other = NudgeRuleFacts::new(
            NudgeRuleKind::StaleTask,
            (0..MAX_NUDGE_TASKS_PER_RULE)
                .map(|_| TaskId::new())
                .collect(),
            false,
        )
        .unwrap();
        // 20 + 20 = 40, under combined 50.
        let facts = NudgeFacts::new(vec![rule, other]).unwrap();
        assert!(facts.has_more);

        let a = NudgeRuleFacts::new(
            NudgeRuleKind::Overdue,
            (0..20).map(|_| TaskId::new()).collect(),
            false,
        )
        .unwrap();
        let b = NudgeRuleFacts::new(
            NudgeRuleKind::StaleTask,
            (0..20).map(|_| TaskId::new()).collect(),
            false,
        )
        .unwrap();
        let c = NudgeRuleFacts::new(
            NudgeRuleKind::EmptyToday,
            (0..15).map(|_| TaskId::new()).collect(),
            false,
        )
        .unwrap();
        assert_eq!(
            NudgeFacts::new(vec![a, b, c]).unwrap_err(),
            ValidationError::TooMany {
                field: "nudge_tasks",
                count: 55,
                max: MAX_NUDGE_TASKS_COMBINED,
            }
        );
    }
}
