//! Pure planning, matrix, stats, nudge, and motivation evaluation.
//!
//! Callers sample the server-local civil date, instant, and timezone once per
//! use case and pass them in. This module never reads the system clock.

use jiff::{
    Timestamp, ToSpan,
    civil::{Date, Weekday},
    tz::TimeZone,
};
use serde::{Deserialize, Serialize};

use crate::{
    ActualMinutes, DreadLevel, EstimatedMinutes, Priority, Project, ProjectId, Task, TaskId,
    TaskStatus, ValidationError,
};

/// Maximum tasks returned for one nudge rule.
pub const MAX_NUDGE_TASKS_PER_RULE: usize = 20;
/// Maximum tasks across all nudge rules in one evaluation response.
pub const MAX_NUDGE_TASKS_COMBINED: usize = 50;
/// Inclusive civil-day window accepted by stats range reads.
pub const MAX_STATS_RANGE_DAYS: i64 = 366;
/// Inclusive civil-day window accepted by calendar range reads.
pub const MAX_CALENDAR_RANGE_DAYS: i64 = 42;
/// Maximum tasks returned by one calendar range read (never silently truncated).
pub const MAX_CALENDAR_TASKS: usize = 2_000;
/// Hard ceiling when paging analysis inputs (planning/stats/nudges/motivation).
///
/// Sized above the 10,000-task acceptance dataset so those runs succeed; callers
/// must fail closed with a structured limit error beyond this cap.
pub const MAX_ANALYSIS_TASK_READ: usize = 20_000;
/// Weekly-review streak walks at most this many civil days ending today.
pub const MAX_WEEKLY_STREAK_DAYS: i64 = 30;
/// Top accomplishments retained by weekly review.
pub const MAX_WEEKLY_ACCOMPLISHMENTS: usize = 5;
/// Top overdue tasks retained by weekly review.
pub const MAX_WEEKLY_OVERDUE: usize = 10;
/// Neglected projects retained by weekly review.
pub const MAX_WEEKLY_NEGLECTED_PROJECTS: usize = 10;
/// Suggestion facts retained by weekly review.
pub const MAX_WEEKLY_SUGGESTIONS: usize = 4;

// ── Capacity / settings (Phase 3 temporal keys) ─────────────────────────────

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

    /// Zero-based offset of `weekday` within a week that starts on this value.
    #[must_use]
    pub fn offset_of(self, weekday: Weekday) -> i8 {
        match self {
            Self::Monday => weekday.to_monday_zero_offset(),
            Self::Sunday => weekday.to_sunday_zero_offset(),
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

// ── Temporal seams ──────────────────────────────────────────────────────────

/// Convert a UTC instant to a civil date in the supplied timezone.
///
/// Callers that already hold a precomputed day can pass a trivial seam instead
/// of a live [`TimeZone`] by mapping timestamps themselves and feeding civil
/// dates into the planning helpers that accept dates directly.
#[must_use]
pub fn civil_date_in_zone(instant: Timestamp, zone: &TimeZone) -> Date {
    instant.to_zoned(zone.clone()).date()
}

/// Local wall-clock hour (0..=23) of an instant in the supplied timezone.
#[must_use]
pub fn civil_hour_in_zone(instant: Timestamp, zone: &TimeZone) -> i8 {
    instant.to_zoned(zone.clone()).hour()
}

// ── Matrix ──────────────────────────────────────────────────────────────────

/// Eisenhower matrix quadrant for pending tasks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatrixQuadrant {
    /// Priority 1–2 and due on/before today.
    DoFirst,
    /// Priority 1–2 and not urgent.
    Schedule,
    /// Priority 3–4 (or unset) and urgent.
    Delegate,
    /// Remaining pending tasks.
    Eliminate,
}

impl MatrixQuadrant {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DoFirst => "do_first",
            Self::Schedule => "schedule",
            Self::Delegate => "delegate",
            Self::Eliminate => "eliminate",
        }
    }
}

/// Canonical field writes applied when a task is dropped onto a quadrant.
///
/// `due_date` is always a civil date (or cleared). Never an ISO timestamp.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatrixDropResult {
    pub priority: Priority,
    pub due_date: Option<Date>,
}

/// Classify one pending task into a matrix quadrant using sampled civil today.
///
/// Non-pending tasks return `None`.
#[must_use]
pub fn classify_matrix_quadrant(task: &Task, today: Date) -> Option<MatrixQuadrant> {
    if task.status != TaskStatus::Pending {
        return None;
    }
    let high_priority = matches!(task.priority.map(Priority::get), Some(1 | 2));
    let urgent = task.due_date.is_some_and(|due| due <= today);
    Some(match (high_priority, urgent) {
        (true, true) => MatrixQuadrant::DoFirst,
        (true, false) => MatrixQuadrant::Schedule,
        (false, true) => MatrixQuadrant::Delegate,
        (false, false) => MatrixQuadrant::Eliminate,
    })
}

/// Canonical priority/due-date writes for a matrix drop onto `quadrant`.
#[must_use]
pub fn matrix_drop_result(quadrant: MatrixQuadrant, today: Date) -> MatrixDropResult {
    let priority_one = Priority::new(1).expect("priority 1 is in range");
    let priority_three = Priority::new(3).expect("priority 3 is in range");
    match quadrant {
        MatrixQuadrant::DoFirst => MatrixDropResult {
            priority: priority_one,
            due_date: Some(today),
        },
        MatrixQuadrant::Schedule => MatrixDropResult {
            priority: priority_one,
            due_date: None,
        },
        MatrixQuadrant::Delegate => MatrixDropResult {
            priority: priority_three,
            due_date: Some(today),
        },
        MatrixQuadrant::Eliminate => MatrixDropResult {
            priority: priority_three,
            due_date: None,
        },
    }
}

/// Partition pending tasks into the four quadrants (task IDs only, stable order).
#[must_use]
pub fn group_matrix_task_ids(tasks: &[Task], today: Date) -> MatrixGrouping {
    let mut grouping = MatrixGrouping::default();
    let mut pending: Vec<&Task> = tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Pending)
        .collect();
    pending.sort_by(|a, b| cmp_task_stable(a, b));
    for task in pending {
        match classify_matrix_quadrant(task, today) {
            Some(MatrixQuadrant::DoFirst) => grouping.do_first.push(task.id),
            Some(MatrixQuadrant::Schedule) => grouping.schedule.push(task.id),
            Some(MatrixQuadrant::Delegate) => grouping.delegate.push(task.id),
            Some(MatrixQuadrant::Eliminate) => grouping.eliminate.push(task.id),
            None => {}
        }
    }
    grouping
}

/// ID-only matrix partition.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatrixGrouping {
    pub do_first: Vec<TaskId>,
    pub schedule: Vec<TaskId>,
    pub delegate: Vec<TaskId>,
    pub eliminate: Vec<TaskId>,
}

// ── Daily planning / end of day ─────────────────────────────────────────────

/// Plan-My-Day facts derived from pending tasks and capacity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DailyPlanSummary {
    pub overdue_task_ids: Vec<TaskId>,
    pub focus_task_ids: Vec<TaskId>,
    pub estimated_total_minutes: u32,
    pub capacity_minutes: u32,
}

/// End-of-day facts for the sampled civil day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EndOfDaySummary {
    pub win_task_ids: Vec<TaskId>,
    pub carry_over_task_ids: Vec<TaskId>,
    pub tomorrow_task_ids: Vec<TaskId>,
    pub tomorrow_estimated_minutes: u32,
    /// Whole-percent completion rate for the sampled day, or 0 when no work.
    pub completion_rate_percent: u32,
}

/// Build Plan-My-Day facts. `capacity` defaults to 480 minutes when omitted.
#[must_use]
pub fn daily_plan_summary(
    tasks: &[Task],
    today: Date,
    capacity: Option<DailyCapacityMinutes>,
) -> DailyPlanSummary {
    let capacity_minutes = capacity.unwrap_or(DailyCapacityMinutes::DEFAULT).get();

    let mut overdue: Vec<&Task> = tasks
        .iter()
        .filter(|task| {
            task.status == TaskStatus::Pending && task.due_date.is_some_and(|due| due < today)
        })
        .collect();
    overdue.sort_by(|a, b| cmp_overdue(a, b));

    let mut focus: Vec<&Task> = tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Pending && task.due_date == Some(today))
        .collect();
    focus.sort_by(|a, b| cmp_task_stable(a, b));

    let estimated_total_minutes = focus
        .iter()
        .map(|task| {
            task.estimated_minutes
                .map(EstimatedMinutes::get)
                .unwrap_or(0)
        })
        .fold(0u32, u32::saturating_add);

    DailyPlanSummary {
        overdue_task_ids: overdue.into_iter().map(|task| task.id).collect(),
        focus_task_ids: focus.into_iter().map(|task| task.id).collect(),
        estimated_total_minutes,
        capacity_minutes,
    }
}

/// Build End-of-Day facts using a timezone (or equivalent seam) for completion days.
#[must_use]
pub fn end_of_day_summary(tasks: &[Task], today: Date, zone: &TimeZone) -> EndOfDaySummary {
    end_of_day_summary_with(tasks, today, |ts| civil_date_in_zone(ts, zone))
}

/// End-of-day evaluation with an explicit timestamp→date seam (no timezone needed).
#[must_use]
pub fn end_of_day_summary_with<F>(tasks: &[Task], today: Date, civil_date_of: F) -> EndOfDaySummary
where
    F: Fn(Timestamp) -> Date,
{
    let tomorrow = today.checked_add(1.day()).ok();

    let mut wins: Vec<&Task> = tasks
        .iter()
        .filter(|task| {
            task.status == TaskStatus::Completed
                && task
                    .completed_at
                    .is_some_and(|ts| civil_date_of(ts) == today)
        })
        .collect();
    wins.sort_by(|a, b| cmp_completed_desc(a, b));

    let mut carry: Vec<&Task> = tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Pending && task.due_date == Some(today))
        .collect();
    carry.sort_by(|a, b| cmp_task_stable(a, b));

    let mut tomorrow_tasks: Vec<&Task> = tasks
        .iter()
        .filter(|task| {
            task.status == TaskStatus::Pending
                && tomorrow.is_some_and(|day| task.due_date == Some(day))
        })
        .collect();
    tomorrow_tasks.sort_by(|a, b| cmp_task_stable(a, b));

    let tomorrow_estimated_minutes = tomorrow_tasks
        .iter()
        .map(|task| {
            task.estimated_minutes
                .map(EstimatedMinutes::get)
                .unwrap_or(0)
        })
        .fold(0u32, u32::saturating_add);

    let completed = wins.len() as u32;
    let pending = carry.len() as u32;
    let total = completed.saturating_add(pending);
    let completion_rate_percent = if total == 0 {
        0
    } else {
        // Integer percent rounded half-up without floating point.
        ((completed as u64 * 100) + u64::from(total / 2)) / u64::from(total)
    } as u32;

    EndOfDaySummary {
        win_task_ids: wins.into_iter().map(|task| task.id).collect(),
        carry_over_task_ids: carry.into_iter().map(|task| task.id).collect(),
        tomorrow_task_ids: tomorrow_tasks.into_iter().map(|task| task.id).collect(),
        tomorrow_estimated_minutes,
        completion_rate_percent,
    }
}

// ── Weekly review ───────────────────────────────────────────────────────────

/// Wall-clock bucket for completion-time distribution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionTimeBucket {
    Morning,
    Afternoon,
    Evening,
    Night,
}

impl CompletionTimeBucket {
    /// Bucket local hour using legacy boundaries: 5–12 / 12–17 / 17–21 / else.
    #[must_use]
    pub const fn from_hour(hour: i8) -> Self {
        if hour >= 5 && hour < 12 {
            Self::Morning
        } else if hour >= 12 && hour < 17 {
            Self::Afternoon
        } else if hour >= 17 && hour < 21 {
            Self::Evening
        } else {
            Self::Night
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Morning => "morning",
            Self::Afternoon => "afternoon",
            Self::Evening => "evening",
            Self::Night => "night",
        }
    }
}

/// One civil day inside a weekly review window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WeeklyDayStats {
    pub date: Date,
    pub completed: u32,
    pub created: u32,
}

/// Completion-time histogram for the review week.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct CompletionTimeBuckets {
    pub morning: u32,
    pub afternoon: u32,
    pub evening: u32,
    pub night: u32,
}

impl CompletionTimeBuckets {
    #[must_use]
    pub fn dominant(self) -> Option<CompletionTimeBucket> {
        let entries = [
            (CompletionTimeBucket::Morning, self.morning),
            (CompletionTimeBucket::Afternoon, self.afternoon),
            (CompletionTimeBucket::Evening, self.evening),
            (CompletionTimeBucket::Night, self.night),
        ];
        let total: u32 = entries.iter().map(|(_, n)| *n).sum();
        if total == 0 {
            return None;
        }
        // Prefer earlier buckets on ties for stability.
        entries
            .into_iter()
            .max_by_key(|(_, n)| *n)
            .map(|(bucket, _)| bucket)
    }
}

/// Neglected project fact for weekly review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NeglectedProjectFact {
    pub project_id: ProjectId,
    pub overdue_count: u32,
    pub reason: NeglectedProjectReason,
}

/// Why a project appears in the neglected list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NeglectedProjectReason {
    OverdueTasks,
    NoActivity,
}

/// Typed weekly-review suggestion facts (at most four).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WeeklySuggestion {
    TackleOverdue { count: u32 },
    CheckNeglected { project_ids: Vec<ProjectId> },
    CreatedMoreThanCompleted,
    KeepStreak { days: u32 },
}

/// Full weekly-review payload for the prior complete week.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WeeklyReviewSummary {
    pub week_start: Date,
    pub week_end: Date,
    pub daily: Vec<WeeklyDayStats>,
    pub created_count: u32,
    pub completed_count: u32,
    pub cancelled_count: u32,
    pub completion_rate_percent: u32,
    pub busiest_day: Option<Date>,
    pub completion_time_buckets: CompletionTimeBuckets,
    pub dominant_completion_bucket: Option<CompletionTimeBucket>,
    pub top_accomplishment_ids: Vec<TaskId>,
    pub overdue_task_ids: Vec<TaskId>,
    pub neglected_projects: Vec<NeglectedProjectFact>,
    pub streak_days: u32,
    pub suggestions: Vec<WeeklySuggestion>,
}

/// Inclusive prior complete week for `today` under `week_start`.
///
/// The current (possibly partial) week is skipped; the returned range is the
/// seven civil days immediately before the start of the current week.
pub fn prior_complete_week(
    today: Date,
    week_start: WeekStart,
) -> Result<(Date, Date), ValidationError> {
    let offset = i64::from(week_start.offset_of(today.weekday()));
    let current_week_start =
        today
            .checked_sub(offset.days())
            .map_err(|_| ValidationError::Invalid {
                field: "today",
                reason: "current week start is not representable",
            })?;
    let prior_start =
        current_week_start
            .checked_sub(7.days())
            .map_err(|_| ValidationError::Invalid {
                field: "today",
                reason: "prior week start is not representable",
            })?;
    let prior_end =
        current_week_start
            .checked_sub(1.day())
            .map_err(|_| ValidationError::Invalid {
                field: "today",
                reason: "prior week end is not representable",
            })?;
    Ok((prior_start, prior_end))
}

/// Build weekly-review facts for the prior complete week.
pub fn weekly_review_summary(
    tasks: &[Task],
    projects: &[Project],
    today: Date,
    week_start: WeekStart,
    zone: &TimeZone,
) -> Result<WeeklyReviewSummary, ValidationError> {
    weekly_review_summary_with(
        tasks,
        projects,
        today,
        week_start,
        |ts| civil_date_in_zone(ts, zone),
        |ts| civil_hour_in_zone(ts, zone),
    )
}

/// Weekly review with explicit timestamp seams (no timezone dependency).
pub fn weekly_review_summary_with<D, H>(
    tasks: &[Task],
    projects: &[Project],
    today: Date,
    week_start: WeekStart,
    civil_date_of: D,
    civil_hour_of: H,
) -> Result<WeeklyReviewSummary, ValidationError>
where
    D: Fn(Timestamp) -> Date,
    H: Fn(Timestamp) -> i8,
{
    let (week_start_date, week_end_date) = prior_complete_week(today, week_start)?;

    let in_week = |day: Date| day >= week_start_date && day <= week_end_date;

    let mut completed_in_week: Vec<&Task> = Vec::new();
    let mut created_in_week: Vec<&Task> = Vec::new();
    let mut cancelled_in_week: Vec<&Task> = Vec::new();

    for task in tasks {
        let created_day = civil_date_of(task.created_at);
        if in_week(created_day) {
            created_in_week.push(task);
        }
        match task.status {
            TaskStatus::Completed => {
                if let Some(done_at) = task.completed_at {
                    let day = civil_date_of(done_at);
                    if in_week(day) {
                        completed_in_week.push(task);
                    }
                }
            }
            TaskStatus::Cancelled => {
                let day = civil_date_of(task.updated_at);
                if in_week(day) {
                    cancelled_in_week.push(task);
                }
            }
            TaskStatus::Pending => {}
        }
    }

    let completed_count = completed_in_week.len() as u32;
    let created_count = created_in_week.len() as u32;
    let cancelled_count = cancelled_in_week.len() as u32;
    let actionable = completed_count.saturating_add(cancelled_count);
    let completion_rate_percent = if actionable == 0 {
        0
    } else {
        ((u64::from(completed_count) * 100) + u64::from(actionable / 2)) / u64::from(actionable)
    } as u32;

    let mut daily = Vec::with_capacity(7);
    let mut busiest_day: Option<(Date, u32)> = None;
    for offset in 0i64..7 {
        let date =
            week_start_date
                .checked_add(offset.days())
                .map_err(|_| ValidationError::Invalid {
                    field: "week_start",
                    reason: "week day is not representable",
                })?;
        let completed = completed_in_week
            .iter()
            .filter(|task| {
                task.completed_at
                    .is_some_and(|ts| civil_date_of(ts) == date)
            })
            .count() as u32;
        let created = created_in_week
            .iter()
            .filter(|task| civil_date_of(task.created_at) == date)
            .count() as u32;
        daily.push(WeeklyDayStats {
            date,
            completed,
            created,
        });
        match busiest_day {
            Some((_, best)) if completed < best => {}
            Some((best_date, best)) if completed == best && date >= best_date => {}
            _ if completed > 0 => busiest_day = Some((date, completed)),
            _ => {}
        }
    }

    let mut buckets = CompletionTimeBuckets::default();
    for task in &completed_in_week {
        if let Some(done_at) = task.completed_at {
            match CompletionTimeBucket::from_hour(civil_hour_of(done_at)) {
                CompletionTimeBucket::Morning => buckets.morning += 1,
                CompletionTimeBucket::Afternoon => buckets.afternoon += 1,
                CompletionTimeBucket::Evening => buckets.evening += 1,
                CompletionTimeBucket::Night => buckets.night += 1,
            }
        }
    }

    let mut accomplishments = completed_in_week.clone();
    accomplishments.sort_by(|a, b| cmp_accomplishment(a, b));
    let top_accomplishment_ids = accomplishments
        .into_iter()
        .take(MAX_WEEKLY_ACCOMPLISHMENTS)
        .map(|task| task.id)
        .collect();

    let mut overdue: Vec<&Task> = tasks
        .iter()
        .filter(|task| {
            task.status == TaskStatus::Pending && task.due_date.is_some_and(|due| due < today)
        })
        .collect();
    overdue.sort_by(|a, b| cmp_overdue(a, b));
    let overdue_count = overdue.len() as u32;
    let overdue_task_ids = overdue
        .into_iter()
        .take(MAX_WEEKLY_OVERDUE)
        .map(|task| task.id)
        .collect();

    let neglected_projects = neglected_project_facts(
        tasks,
        projects,
        today,
        week_start_date,
        week_end_date,
        &civil_date_of,
    );

    let streak_days =
        bounded_completion_streak(tasks, today, MAX_WEEKLY_STREAK_DAYS, &civil_date_of);

    let mut suggestions = Vec::with_capacity(MAX_WEEKLY_SUGGESTIONS);
    if overdue_count > 0 {
        suggestions.push(WeeklySuggestion::TackleOverdue {
            count: overdue_count,
        });
    }
    if !neglected_projects.is_empty() {
        let project_ids = neglected_projects
            .iter()
            .take(3)
            .map(|fact| fact.project_id)
            .collect();
        suggestions.push(WeeklySuggestion::CheckNeglected { project_ids });
    }
    if created_count > completed_count && created_count > 0 {
        suggestions.push(WeeklySuggestion::CreatedMoreThanCompleted);
    }
    if streak_days > 0 {
        suggestions.push(WeeklySuggestion::KeepStreak { days: streak_days });
    }
    suggestions.truncate(MAX_WEEKLY_SUGGESTIONS);

    Ok(WeeklyReviewSummary {
        week_start: week_start_date,
        week_end: week_end_date,
        daily,
        created_count,
        completed_count,
        cancelled_count,
        completion_rate_percent,
        busiest_day: busiest_day.map(|(date, _)| date),
        completion_time_buckets: buckets,
        dominant_completion_bucket: buckets.dominant(),
        top_accomplishment_ids,
        overdue_task_ids,
        neglected_projects,
        streak_days,
        suggestions,
    })
}

fn neglected_project_facts<D>(
    tasks: &[Task],
    projects: &[Project],
    today: Date,
    week_start: Date,
    week_end: Date,
    civil_date_of: &D,
) -> Vec<NeglectedProjectFact>
where
    D: Fn(Timestamp) -> Date,
{
    let in_week = |day: Date| day >= week_start && day <= week_end;
    let mut facts = Vec::new();

    let mut projects_sorted = projects.to_vec();
    projects_sorted.sort_by(|a, b| {
        a.name
            .as_str()
            .cmp(b.name.as_str())
            .then_with(|| a.id.as_uuid().cmp(&b.id.as_uuid()))
    });

    for project in &projects_sorted {
        if project.archived {
            continue;
        }
        let project_tasks: Vec<&Task> = tasks
            .iter()
            .filter(|task| task.project_id == Some(project.id))
            .collect();
        if project_tasks.is_empty() {
            continue;
        }
        let overdue_count = project_tasks
            .iter()
            .filter(|task| {
                task.status == TaskStatus::Pending && task.due_date.is_some_and(|due| due < today)
            })
            .count() as u32;
        if overdue_count > 0 {
            facts.push(NeglectedProjectFact {
                project_id: project.id,
                overdue_count,
                reason: NeglectedProjectReason::OverdueTasks,
            });
            continue;
        }
        let had_activity = project_tasks.iter().any(|task| {
            in_week(civil_date_of(task.created_at))
                || task
                    .completed_at
                    .is_some_and(|ts| in_week(civil_date_of(ts)))
        });
        let has_pending = project_tasks
            .iter()
            .any(|task| task.status == TaskStatus::Pending);
        if !had_activity && has_pending {
            facts.push(NeglectedProjectFact {
                project_id: project.id,
                overdue_count: 0,
                reason: NeglectedProjectReason::NoActivity,
            });
        }
    }

    facts.sort_by(|a, b| {
        b.overdue_count
            .cmp(&a.overdue_count)
            .then_with(|| a.project_id.as_uuid().cmp(&b.project_id.as_uuid()))
    });
    facts.truncate(MAX_WEEKLY_NEGLECTED_PROJECTS);
    facts
}

// ── Stats ───────────────────────────────────────────────────────────────────

/// One civil day's derived productivity counters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DailyStatBucket {
    pub date: Date,
    pub completions: u32,
    pub creations: u32,
    /// Sum of estimates on tasks completed this civil day.
    pub completion_minutes: u32,
}

/// Aggregate stats over an inclusive civil range plus current streak/accuracy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatsSummary {
    pub from: Date,
    pub to: Date,
    pub days: Vec<DailyStatBucket>,
    pub total_completions: u32,
    pub total_creations: u32,
    pub total_completion_minutes: u32,
    /// Consecutive completion days ending on `today`; 0 when today has none.
    pub current_streak_days: u32,
    /// Estimate accuracy percent when any completed task has positive estimate+actual.
    pub estimate_accuracy_percent: Option<u32>,
    pub estimate_accuracy_samples: u32,
}

/// Validate an inclusive civil date range for stats reads (max 366 days).
pub fn validate_stats_date_range(from: Date, to: Date) -> Result<(), ValidationError> {
    validate_inclusive_date_range(from, to, MAX_STATS_RANGE_DAYS)
}

/// Validate an inclusive civil date range for calendar reads (max 42 days).
pub fn validate_calendar_date_range(from: Date, to: Date) -> Result<(), ValidationError> {
    validate_inclusive_date_range(from, to, MAX_CALENDAR_RANGE_DAYS)
}

fn validate_inclusive_date_range(
    from: Date,
    to: Date,
    max_inclusive_days: i64,
) -> Result<(), ValidationError> {
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
    if inclusive > max_inclusive_days {
        return Err(ValidationError::TooMany {
            field: "range_days",
            count: usize::try_from(inclusive).unwrap_or(usize::MAX),
            max: usize::try_from(max_inclusive_days).unwrap_or(usize::MAX),
        });
    }
    Ok(())
}

/// Derive stats for an inclusive civil range. Completions/creations use `zone`.
pub fn stats_summary(
    tasks: &[Task],
    from: Date,
    to: Date,
    today: Date,
    zone: &TimeZone,
) -> Result<StatsSummary, ValidationError> {
    stats_summary_with(tasks, from, to, today, |ts| civil_date_in_zone(ts, zone))
}

/// Stats with an explicit timestamp→date seam.
pub fn stats_summary_with<F>(
    tasks: &[Task],
    from: Date,
    to: Date,
    today: Date,
    civil_date_of: F,
) -> Result<StatsSummary, ValidationError>
where
    F: Fn(Timestamp) -> Date,
{
    validate_stats_date_range(from, to)?;

    let day_count = inclusive_day_count(from, to)?;
    let mut days = Vec::with_capacity(day_count);
    for offset in 0..day_count as i64 {
        let date = from
            .checked_add(offset.days())
            .map_err(|_| ValidationError::Invalid {
                field: "range",
                reason: "date in range is not representable",
            })?;
        days.push(DailyStatBucket {
            date,
            completions: 0,
            creations: 0,
            completion_minutes: 0,
        });
    }

    let index_of = |day: Date| -> Option<usize> {
        if day < from || day > to {
            return None;
        }
        let span = from.until(day).ok()?.get_days();
        usize::try_from(span).ok()
    };

    for task in tasks {
        if let Some(idx) = index_of(civil_date_of(task.created_at)) {
            days[idx].creations = days[idx].creations.saturating_add(1);
        }
        if task.status == TaskStatus::Completed
            && let Some(done_at) = task.completed_at
            && let Some(idx) = index_of(civil_date_of(done_at))
        {
            days[idx].completions = days[idx].completions.saturating_add(1);
            let minutes = task
                .estimated_minutes
                .map(EstimatedMinutes::get)
                .unwrap_or(0);
            days[idx].completion_minutes = days[idx].completion_minutes.saturating_add(minutes);
        }
    }

    let total_completions = days
        .iter()
        .map(|d| d.completions)
        .fold(0u32, u32::saturating_add);
    let total_creations = days
        .iter()
        .map(|d| d.creations)
        .fold(0u32, u32::saturating_add);
    let total_completion_minutes = days
        .iter()
        .map(|d| d.completion_minutes)
        .fold(0u32, u32::saturating_add);

    let current_streak_days = current_completion_streak(tasks, today, &civil_date_of);
    let (estimate_accuracy_percent, estimate_accuracy_samples) = estimate_accuracy(tasks);

    Ok(StatsSummary {
        from,
        to,
        days,
        total_completions,
        total_creations,
        total_completion_minutes,
        current_streak_days,
        estimate_accuracy_percent,
        estimate_accuracy_samples,
    })
}

/// Estimate accuracy over completed tasks with positive estimate and actual:
/// `max(0, round((1 - mean(abs(actual - estimate) / estimate)) * 100))`.
///
/// Returns `(percent, sample_count)`. Percent is `None` when there are no samples.
#[must_use]
pub fn estimate_accuracy(tasks: &[Task]) -> (Option<u32>, u32) {
    let mut total_ratio = 0.0_f64;
    let mut count = 0u32;
    for task in tasks {
        if task.status != TaskStatus::Completed {
            continue;
        }
        let Some(estimate) = task.estimated_minutes.map(EstimatedMinutes::get) else {
            continue;
        };
        let Some(actual) = task.actual_minutes.map(ActualMinutes::get) else {
            continue;
        };
        if estimate == 0 || actual == 0 {
            continue;
        }
        let ratio = f64::from(actual.abs_diff(estimate)) / f64::from(estimate);
        total_ratio += ratio;
        count = count.saturating_add(1);
    }
    if count == 0 {
        return (None, 0);
    }
    let mean = total_ratio / f64::from(count);
    let percent = ((1.0 - mean) * 100.0).round().max(0.0) as u32;
    (Some(percent), count)
}

/// Consecutive civil days with ≥1 completion ending on `today`.
/// Zero when today itself has no completion.
#[must_use]
pub fn current_completion_streak<F>(tasks: &[Task], today: Date, civil_date_of: F) -> u32
where
    F: Fn(Timestamp) -> Date,
{
    bounded_completion_streak(tasks, today, i64::from(u16::MAX), &civil_date_of)
}

fn bounded_completion_streak<F>(
    tasks: &[Task],
    today: Date,
    max_days: i64,
    civil_date_of: &F,
) -> u32
where
    F: Fn(Timestamp) -> Date,
{
    let mut completion_days = Vec::new();
    for task in tasks {
        if task.status == TaskStatus::Completed
            && let Some(done_at) = task.completed_at
        {
            let day = civil_date_of(done_at);
            if !completion_days.contains(&day) {
                completion_days.push(day);
            }
        }
    }
    if !completion_days.contains(&today) {
        return 0;
    }
    let mut streak = 1u32;
    for offset in 1..=max_days {
        let Ok(day) = today.checked_sub(offset.days()) else {
            break;
        };
        if completion_days.contains(&day) {
            streak = streak.saturating_add(1);
        } else {
            break;
        }
    }
    streak
}

fn inclusive_day_count(from: Date, to: Date) -> Result<usize, ValidationError> {
    let span_days = from
        .until(to)
        .map_err(|_| ValidationError::Invalid {
            field: "range",
            reason: "date range is not representable",
        })?
        .get_days();
    let inclusive = i64::from(span_days).saturating_add(1);
    usize::try_from(inclusive).map_err(|_| ValidationError::Invalid {
        field: "range",
        reason: "date range is not representable",
    })
}

// ── Smart nudges ────────────────────────────────────────────────────────────

/// Evaluate Smart Nudge rules in stable order with frozen ceilings.
///
/// Disabled kinds in `enabled` are skipped when the slice is non-empty. An empty
/// `enabled` slice means all rules are active. `stale_after_days` defaults to 14
/// when `None`.
#[must_use]
pub fn evaluate_nudges(
    tasks: &[Task],
    today: Date,
    capacity: DailyCapacityMinutes,
    zone: &TimeZone,
    enabled: &[NudgeRuleKind],
    stale_after_days: Option<u32>,
) -> NudgeFacts {
    evaluate_nudges_with(
        tasks,
        today,
        capacity,
        |ts| civil_date_in_zone(ts, zone),
        enabled,
        stale_after_days,
    )
}

/// Nudge evaluation with an explicit timestamp→date seam.
#[must_use]
pub fn evaluate_nudges_with<F>(
    tasks: &[Task],
    today: Date,
    capacity: DailyCapacityMinutes,
    civil_date_of: F,
    enabled: &[NudgeRuleKind],
    stale_after_days: Option<u32>,
) -> NudgeFacts
where
    F: Fn(Timestamp) -> Date,
{
    let stale_after = i64::from(stale_after_days.unwrap_or(14));
    let all_enabled = enabled.is_empty();
    let is_enabled = |kind: NudgeRuleKind| all_enabled || enabled.contains(&kind);

    let pending: Vec<&Task> = tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Pending)
        .collect();

    let mut rules = Vec::new();
    let mut remaining = MAX_NUDGE_TASKS_COMBINED;
    let mut combined_truncated = false;

    for kind in NudgeRuleKind::ALL {
        if !is_enabled(kind) {
            continue;
        }
        if remaining == 0 {
            // Still report zero-ID rules that fire; otherwise note overflow.
            if matches!(kind, NudgeRuleKind::EmptyToday) {
                let has_today = pending.iter().any(|task| task.due_date == Some(today));
                if !has_today {
                    rules.push(NudgeRuleFacts {
                        kind,
                        task_ids: Vec::new(),
                        has_more: false,
                    });
                }
            } else {
                combined_truncated = true;
            }
            continue;
        }

        let mut ids = match kind {
            NudgeRuleKind::Overdue => {
                let mut hits: Vec<&Task> = pending
                    .iter()
                    .copied()
                    .filter(|task| task.due_date.is_some_and(|due| due < today))
                    .collect();
                hits.sort_by(|a, b| cmp_overdue(a, b));
                hits.into_iter().map(|task| task.id).collect::<Vec<_>>()
            }
            NudgeRuleKind::ApproachingDeadline => {
                let tomorrow = today.checked_add(1.day()).ok();
                let mut hits: Vec<(&Task, Date)> = pending
                    .iter()
                    .copied()
                    .filter_map(|task| {
                        let deadline = task.deadline?;
                        let day = civil_date_of(deadline);
                        if day == today || tomorrow == Some(day) {
                            Some((task, day))
                        } else {
                            None
                        }
                    })
                    .collect();
                hits.sort_by(|(a, a_day), (b, b_day)| {
                    a_day
                        .cmp(b_day)
                        .then_with(|| a.title.as_str().cmp(b.title.as_str()))
                        .then_with(|| a.id.as_uuid().cmp(&b.id.as_uuid()))
                });
                hits.into_iter().map(|(task, _)| task.id).collect()
            }
            NudgeRuleKind::StaleTask => {
                let mut hits: Vec<&Task> = pending
                    .iter()
                    .copied()
                    .filter(|task| {
                        if task.due_date.is_some() {
                            return false;
                        }
                        let created = civil_date_of(task.created_at);
                        days_between(created, today).is_some_and(|days| days >= stale_after)
                    })
                    .collect();
                // Oldest first.
                hits.sort_by(|a, b| {
                    a.created_at
                        .cmp(&b.created_at)
                        .then_with(|| a.id.as_uuid().cmp(&b.id.as_uuid()))
                });
                hits.into_iter().map(|task| task.id).collect()
            }
            NudgeRuleKind::EmptyToday => {
                let has_today = pending.iter().any(|task| task.due_date == Some(today));
                if !has_today {
                    // Fire with no task identities.
                    rules.push(NudgeRuleFacts {
                        kind,
                        task_ids: Vec::new(),
                        has_more: false,
                    });
                }
                continue;
            }
            NudgeRuleKind::OverloadedDay => {
                let mut hits: Vec<&Task> = pending
                    .iter()
                    .copied()
                    .filter(|task| task.due_date.is_some_and(|due| due <= today))
                    .collect();
                let total: u32 = hits
                    .iter()
                    .map(|task| {
                        task.estimated_minutes
                            .map(EstimatedMinutes::get)
                            .unwrap_or(0)
                    })
                    .fold(0u32, u32::saturating_add);
                if total <= capacity.get() {
                    Vec::new()
                } else {
                    hits.sort_by(|a, b| cmp_overdue(a, b));
                    hits.into_iter().map(|task| task.id).collect()
                }
            }
        };

        if ids.is_empty() {
            continue;
        }

        let per_rule_cap = MAX_NUDGE_TASKS_PER_RULE.min(remaining);
        let has_more = ids.len() > per_rule_cap;
        if has_more {
            ids.truncate(per_rule_cap);
            combined_truncated = true;
        }
        remaining = remaining.saturating_sub(ids.len());
        rules.push(NudgeRuleFacts {
            kind,
            task_ids: ids,
            has_more,
        });
    }

    let has_more = combined_truncated || rules.iter().any(|rule| rule.has_more);
    NudgeFacts { rules, has_more }
}

// ── Motivation selectors ────────────────────────────────────────────────────

/// Eat-the-Frog: highest dread, then earliest due, then title, then id.
#[must_use]
pub fn select_eat_the_frog(tasks: &[Task]) -> Option<TaskId> {
    let mut candidates: Vec<&Task> = tasks
        .iter()
        .filter(|task| {
            task.status == TaskStatus::Pending && task.dread.is_some_and(|level| level.get() > 0)
        })
        .collect();
    if candidates.is_empty() {
        return None;
    }
    candidates.sort_by(|a, b| {
        let dread_a = a.dread.map(DreadLevel::get).unwrap_or(0);
        let dread_b = b.dread.map(DreadLevel::get).unwrap_or(0);
        dread_b
            .cmp(&dread_a)
            .then_with(|| cmp_due_date_nulls_last(a.due_date, b.due_date))
            .then_with(|| a.title.as_str().cmp(b.title.as_str()))
            .then_with(|| a.id.as_uuid().cmp(&b.id.as_uuid()))
    });
    candidates.first().map(|task| task.id)
}

/// Task Jar eligible IDs: pending due on/before today, stable deterministic order.
///
/// RNG selection stays outside the domain.
#[must_use]
pub fn task_jar_candidates(tasks: &[Task], today: Date) -> Vec<TaskId> {
    let mut candidates: Vec<&Task> = tasks
        .iter()
        .filter(|task| {
            task.status == TaskStatus::Pending && task.due_date.is_some_and(|due| due <= today)
        })
        .collect();
    candidates.sort_by(|a, b| {
        cmp_due_date_nulls_last(a.due_date, b.due_date)
            .then_with(|| a.title.as_str().cmp(b.title.as_str()))
            .then_with(|| a.id.as_uuid().cmp(&b.id.as_uuid()))
    });
    candidates.into_iter().map(|task| task.id).collect()
}

/// Dopamine Menu: pending with estimate ≤ 15 or priority 3–4; shortest estimate first.
#[must_use]
pub fn dopamine_menu_task_ids(tasks: &[Task]) -> Vec<TaskId> {
    let mut candidates: Vec<&Task> = tasks
        .iter()
        .filter(|task| {
            if task.status != TaskStatus::Pending {
                return false;
            }
            let short = task.estimated_minutes.is_some_and(|mins| mins.get() <= 15);
            let low_priority = matches!(task.priority.map(Priority::get), Some(3 | 4));
            short || low_priority
        })
        .collect();
    candidates.sort_by(|a, b| {
        cmp_estimate_nulls_last(a.estimated_minutes, b.estimated_minutes)
            .then_with(|| a.title.as_str().cmp(b.title.as_str()))
            .then_with(|| a.id.as_uuid().cmp(&b.id.as_uuid()))
    });
    candidates.into_iter().map(|task| task.id).collect()
}

// ── Ordering helpers ────────────────────────────────────────────────────────

fn cmp_task_stable(a: &Task, b: &Task) -> std::cmp::Ordering {
    a.title
        .as_str()
        .cmp(b.title.as_str())
        .then_with(|| a.id.as_uuid().cmp(&b.id.as_uuid()))
}

fn cmp_overdue(a: &Task, b: &Task) -> std::cmp::Ordering {
    cmp_due_date_nulls_last(a.due_date, b.due_date)
        .then_with(|| {
            let pa = a
                .priority
                .map(Priority::get)
                .unwrap_or(Priority::MAX.saturating_add(1));
            let pb = b
                .priority
                .map(Priority::get)
                .unwrap_or(Priority::MAX.saturating_add(1));
            pa.cmp(&pb)
        })
        .then_with(|| a.title.as_str().cmp(b.title.as_str()))
        .then_with(|| a.id.as_uuid().cmp(&b.id.as_uuid()))
}

fn cmp_accomplishment(a: &Task, b: &Task) -> std::cmp::Ordering {
    let pa = a
        .priority
        .map(Priority::get)
        .unwrap_or(Priority::MAX.saturating_add(1));
    let pb = b
        .priority
        .map(Priority::get)
        .unwrap_or(Priority::MAX.saturating_add(1));
    pa.cmp(&pb)
        .then_with(|| match (a.completed_at, b.completed_at) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        })
        .then_with(|| a.id.as_uuid().cmp(&b.id.as_uuid()))
}

fn cmp_completed_desc(a: &Task, b: &Task) -> std::cmp::Ordering {
    match (a.completed_at, b.completed_at) {
        (Some(x), Some(y)) => y.cmp(&x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
    .then_with(|| a.id.as_uuid().cmp(&b.id.as_uuid()))
}

fn cmp_due_date_nulls_last(a: Option<Date>, b: Option<Date>) -> std::cmp::Ordering {
    match (a, b) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn cmp_estimate_nulls_last(
    a: Option<EstimatedMinutes>,
    b: Option<EstimatedMinutes>,
) -> std::cmp::Ordering {
    match (a, b) {
        (Some(x), Some(y)) => x.get().cmp(&y.get()),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn days_between(earlier: Date, later: Date) -> Option<i64> {
    earlier
        .until(later)
        .ok()
        .map(|span| i64::from(span.get_days()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jiff::civil::{date, time};
    use uuid::Uuid;

    use crate::{
        ActualMinutes, DreadLevel, EntityName, EstimatedMinutes, HexColor, Priority, ProjectId,
        TaskTitle,
    };

    fn ts(ymd_hms: &str) -> Timestamp {
        ymd_hms.parse::<Timestamp>().unwrap()
    }

    fn task_id(n: u8) -> TaskId {
        // Stable UUID for ordering tests.
        let mut bytes = [0u8; 16];
        bytes[15] = n;
        TaskId::parse(&Uuid::from_bytes(bytes).to_string()).unwrap()
    }

    fn project_id(n: u8) -> ProjectId {
        let mut bytes = [0u8; 16];
        bytes[0] = 0x10;
        bytes[15] = n;
        ProjectId::parse(&Uuid::from_bytes(bytes).to_string()).unwrap()
    }

    fn base_task(id: TaskId, title: &str, created: Timestamp) -> Task {
        let mut task = Task::new(id, TaskTitle::new(title).unwrap(), None, created, 1);
        task.updated_at = created;
        task
    }

    fn pending_due(id: u8, title: &str, due: Date, priority: Option<u8>) -> Task {
        let mut task = base_task(task_id(id), title, ts("2026-01-01T12:00:00Z"));
        task.due_date = Some(due);
        task.priority = priority.map(|p| Priority::new(p).unwrap());
        task
    }

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
            .map(|n| task_id(n as u8))
            .collect::<Vec<_>>();
        assert!(NudgeRuleFacts::new(NudgeRuleKind::Overdue, ids, false).is_err());

        let rule = NudgeRuleFacts::new(
            NudgeRuleKind::Overdue,
            (0..MAX_NUDGE_TASKS_PER_RULE)
                .map(|n| task_id(n as u8))
                .collect(),
            true,
        )
        .unwrap();
        let other = NudgeRuleFacts::new(
            NudgeRuleKind::StaleTask,
            (0..MAX_NUDGE_TASKS_PER_RULE)
                .map(|n| task_id(100 + n as u8))
                .collect(),
            false,
        )
        .unwrap();
        let facts = NudgeFacts::new(vec![rule, other]).unwrap();
        assert!(facts.has_more);

        let a = NudgeRuleFacts::new(
            NudgeRuleKind::Overdue,
            (0..20).map(|n| task_id(n as u8)).collect(),
            false,
        )
        .unwrap();
        let b = NudgeRuleFacts::new(
            NudgeRuleKind::StaleTask,
            (0..20).map(|n| task_id(40 + n as u8)).collect(),
            false,
        )
        .unwrap();
        let c = NudgeRuleFacts::new(
            NudgeRuleKind::EmptyToday,
            (0..15).map(|n| task_id(80 + n as u8)).collect(),
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

    #[test]
    fn matrix_classification_and_date_only_drop() {
        let today = date(2026, 3, 15);
        let mut t = pending_due(1, "A", today, Some(1));
        assert_eq!(
            classify_matrix_quadrant(&t, today),
            Some(MatrixQuadrant::DoFirst)
        );
        t.due_date = Some(today.checked_add(2.days()).unwrap());
        assert_eq!(
            classify_matrix_quadrant(&t, today),
            Some(MatrixQuadrant::Schedule)
        );
        t.priority = Some(Priority::new(3).unwrap());
        t.due_date = Some(today);
        assert_eq!(
            classify_matrix_quadrant(&t, today),
            Some(MatrixQuadrant::Delegate)
        );
        t.due_date = None;
        assert_eq!(
            classify_matrix_quadrant(&t, today),
            Some(MatrixQuadrant::Eliminate)
        );
        // Unset priority + not urgent → eliminate.
        t.priority = None;
        assert_eq!(
            classify_matrix_quadrant(&t, today),
            Some(MatrixQuadrant::Eliminate)
        );
        t.status = TaskStatus::Completed;
        assert_eq!(classify_matrix_quadrant(&t, today), None);

        let drop = matrix_drop_result(MatrixQuadrant::DoFirst, today);
        assert_eq!(drop.priority.get(), 1);
        assert_eq!(drop.due_date, Some(today));
        let drop = matrix_drop_result(MatrixQuadrant::Schedule, today);
        assert_eq!(drop.due_date, None);
        let drop = matrix_drop_result(MatrixQuadrant::Delegate, today);
        assert_eq!(drop.priority.get(), 3);
        assert_eq!(drop.due_date, Some(today));
        let drop = matrix_drop_result(MatrixQuadrant::Eliminate, today);
        assert_eq!(drop.priority.get(), 3);
        assert_eq!(drop.due_date, None);
    }

    #[test]
    fn daily_and_end_of_day_summaries() {
        let today = date(2026, 3, 15);
        let zone = TimeZone::UTC;
        let mut overdue = pending_due(1, "Old", date(2026, 3, 10), Some(2));
        let mut focus = pending_due(2, "Focus", today, Some(1));
        focus.estimated_minutes = Some(EstimatedMinutes::new(30).unwrap());
        let mut later = pending_due(3, "Later", date(2026, 3, 16), None);
        later.estimated_minutes = Some(EstimatedMinutes::new(45).unwrap());
        let mut win = base_task(task_id(4), "Win", ts("2026-03-15T09:00:00Z"));
        win.status = TaskStatus::Completed;
        win.completed_at = Some(ts("2026-03-15T18:00:00Z"));
        overdue.due_date = Some(date(2026, 3, 10));

        let plan = daily_plan_summary(
            &[overdue.clone(), focus.clone(), later.clone(), win.clone()],
            today,
            None,
        );
        assert_eq!(plan.overdue_task_ids, vec![task_id(1)]);
        assert_eq!(plan.focus_task_ids, vec![task_id(2)]);
        assert_eq!(plan.estimated_total_minutes, 30);
        assert_eq!(plan.capacity_minutes, 480);

        let eod = end_of_day_summary(&[overdue, focus.clone(), later.clone(), win], today, &zone);
        assert_eq!(eod.win_task_ids, vec![task_id(4)]);
        assert_eq!(eod.carry_over_task_ids, vec![task_id(2)]);
        assert_eq!(eod.tomorrow_task_ids, vec![task_id(3)]);
        assert_eq!(eod.tomorrow_estimated_minutes, 45);
        // 1 win + 1 carry = 50%
        assert_eq!(eod.completion_rate_percent, 50);
    }

    #[test]
    fn timezone_day_conversion_for_completions() {
        // 2026-03-15 is EDT (UTC-4). 03:00 UTC is still 2026-03-14 23:00 in New York.
        let zone = TimeZone::get("America/New_York").unwrap();
        let instant = ts("2026-03-15T03:00:00Z");
        assert_eq!(civil_date_in_zone(instant, &zone), date(2026, 3, 14));
        assert_eq!(
            civil_date_in_zone(instant, &TimeZone::UTC),
            date(2026, 3, 15)
        );

        let mut task = base_task(task_id(1), "Late", ts("2026-03-01T00:00:00Z"));
        task.status = TaskStatus::Completed;
        task.completed_at = Some(instant);

        let eod_ny = end_of_day_summary(&[task.clone()], date(2026, 3, 14), &zone);
        assert_eq!(eod_ny.win_task_ids, vec![task_id(1)]);
        let eod_utc = end_of_day_summary(&[task], date(2026, 3, 14), &TimeZone::UTC);
        assert!(eod_utc.win_task_ids.is_empty());
    }

    #[test]
    fn prior_complete_week_sunday_and_monday() {
        // Wednesday 2026-03-11.
        let today = date(2026, 3, 11);
        let (sun_start, sun_end) = prior_complete_week(today, WeekStart::Sunday).unwrap();
        // Current week starts Sunday 2026-03-08; prior is 2026-03-01..2026-03-07.
        assert_eq!(sun_start, date(2026, 3, 1));
        assert_eq!(sun_end, date(2026, 3, 7));
        assert_eq!(sun_start.weekday(), Weekday::Sunday);
        assert_eq!(sun_end.weekday(), Weekday::Saturday);

        let (mon_start, mon_end) = prior_complete_week(today, WeekStart::Monday).unwrap();
        // Current week starts Monday 2026-03-09; prior is 2026-03-02..2026-03-08.
        assert_eq!(mon_start, date(2026, 3, 2));
        assert_eq!(mon_end, date(2026, 3, 8));
        assert_eq!(mon_start.weekday(), Weekday::Monday);
        assert_eq!(mon_end.weekday(), Weekday::Sunday);

        // On the week-start day itself, prior week is still the previous seven days.
        let sunday = date(2026, 3, 8);
        let (s0, s1) = prior_complete_week(sunday, WeekStart::Sunday).unwrap();
        assert_eq!(s0, date(2026, 3, 1));
        assert_eq!(s1, date(2026, 3, 7));
    }

    #[test]
    fn weekly_review_aggregates_and_bounds() {
        let today = date(2026, 3, 11);
        let zone = TimeZone::UTC;
        let project = Project::new(
            project_id(1),
            EntityName::new("Alpha").unwrap(),
            HexColor::new("#112233").unwrap(),
            ts("2026-01-01T00:00:00Z"),
        );

        let mut done = base_task(task_id(1), "Done high", ts("2026-03-03T10:00:00Z"));
        done.status = TaskStatus::Completed;
        done.completed_at = Some(ts("2026-03-03T15:00:00Z")); // afternoon
        done.priority = Some(Priority::new(1).unwrap());
        done.project_id = Some(project.id);

        let mut done2 = base_task(task_id(2), "Done low", ts("2026-03-04T10:00:00Z"));
        done2.status = TaskStatus::Completed;
        done2.completed_at = Some(ts("2026-03-04T09:00:00Z")); // morning
        done2.priority = Some(Priority::new(4).unwrap());

        let mut cancelled = base_task(task_id(3), "Cancel", ts("2026-03-05T10:00:00Z"));
        cancelled.status = TaskStatus::Cancelled;
        cancelled.updated_at = ts("2026-03-05T12:00:00Z");

        let mut overdue = pending_due(4, "Over", date(2026, 3, 1), Some(1));
        overdue.project_id = Some(project.id);

        let mut neglected_pending = pending_due(5, "Idle", date(2026, 4, 1), None);
        neglected_pending.project_id = Some(project.id);
        // Project also has overdue so overdue reason wins.

        let summary = weekly_review_summary(
            &[done, done2, cancelled, overdue, neglected_pending],
            &[project],
            today,
            WeekStart::Sunday,
            &zone,
        )
        .unwrap();

        assert_eq!(summary.week_start, date(2026, 3, 1));
        assert_eq!(summary.week_end, date(2026, 3, 7));
        assert_eq!(summary.completed_count, 2);
        assert_eq!(summary.cancelled_count, 1);
        assert_eq!(summary.created_count, 3); // done, done2, cancelled created in week
        assert_eq!(summary.completion_rate_percent, 67); // 2/3
        assert_eq!(summary.busiest_day, Some(date(2026, 3, 3)));
        assert_eq!(summary.completion_time_buckets.afternoon, 1);
        assert_eq!(summary.completion_time_buckets.morning, 1);
        assert_eq!(summary.top_accomplishment_ids[0], task_id(1)); // priority 1 first
        assert_eq!(summary.overdue_task_ids, vec![task_id(4)]);
        assert_eq!(summary.neglected_projects.len(), 1);
        assert_eq!(
            summary.neglected_projects[0].reason,
            NeglectedProjectReason::OverdueTasks
        );
        assert!(summary.suggestions.len() <= MAX_WEEKLY_SUGGESTIONS);
        assert!(matches!(
            summary.suggestions[0],
            WeeklySuggestion::TackleOverdue { count: 1 }
        ));
    }

    #[test]
    fn stats_range_validation_accuracy_and_streak() {
        let today = date(2026, 3, 15);
        assert!(validate_stats_date_range(today, today.checked_sub(1.day()).unwrap()).is_err());
        let from = today.checked_sub(366.days()).unwrap();
        // 367 inclusive days should fail: from = today-366 → 367 days.
        assert!(validate_stats_date_range(from, today).is_err());
        let from_ok = today.checked_sub(365.days()).unwrap();
        assert!(validate_stats_date_range(from_ok, today).is_ok());

        let mut a = base_task(task_id(1), "A", ts("2026-03-14T10:00:00Z"));
        a.status = TaskStatus::Completed;
        a.completed_at = Some(ts("2026-03-14T12:00:00Z"));
        a.estimated_minutes = Some(EstimatedMinutes::new(100).unwrap());
        a.actual_minutes = Some(ActualMinutes::new(120).unwrap()); // 20% over

        let mut b = base_task(task_id(2), "B", ts("2026-03-15T10:00:00Z"));
        b.status = TaskStatus::Completed;
        b.completed_at = Some(ts("2026-03-15T12:00:00Z"));
        b.estimated_minutes = Some(EstimatedMinutes::new(50).unwrap());
        b.actual_minutes = Some(ActualMinutes::new(50).unwrap()); // exact

        // mean abs ratio = (0.2 + 0.0) / 2 = 0.1 → accuracy 90
        let (pct, samples) = estimate_accuracy(&[a.clone(), b.clone()]);
        assert_eq!(samples, 2);
        assert_eq!(pct, Some(90));

        // No positive actual → no sample.
        let mut c = b.clone();
        c.id = task_id(3);
        c.actual_minutes = Some(ActualMinutes::new(0).unwrap());
        assert_eq!(estimate_accuracy(&[c]), (None, 0));

        let stats = stats_summary(
            &[a, b],
            date(2026, 3, 14),
            date(2026, 3, 15),
            today,
            &TimeZone::UTC,
        )
        .unwrap();
        assert_eq!(stats.days.len(), 2);
        assert_eq!(stats.days[0].completions, 1);
        assert_eq!(stats.days[1].completions, 1);
        assert_eq!(stats.total_completion_minutes, 150);
        assert_eq!(stats.current_streak_days, 2);
        assert_eq!(stats.estimate_accuracy_percent, Some(90));

        // Streak is zero when today has no completion.
        let mut only_yesterday = base_task(task_id(9), "Y", ts("2026-03-14T10:00:00Z"));
        only_yesterday.status = TaskStatus::Completed;
        only_yesterday.completed_at = Some(ts("2026-03-14T12:00:00Z"));
        let streak = current_completion_streak(&[only_yesterday], today, |ts| {
            civil_date_in_zone(ts, &TimeZone::UTC)
        });
        assert_eq!(streak, 0);
    }

    #[test]
    fn nudges_stable_order_truncation_and_coexistence() {
        let today = date(2026, 3, 15);
        let mut tasks = Vec::new();
        // 25 overdue
        for i in 0..25u8 {
            tasks.push(pending_due(
                i,
                &format!("O{i:02}"),
                date(2026, 3, 1)
                    .checked_add(i64::from(i % 5).days())
                    .unwrap(),
                Some(2),
            ));
        }
        // approaching deadline today
        let mut approaching = pending_due(30, "Deadline", date(2026, 4, 1), None);
        approaching.deadline = Some(ts("2026-03-15T20:00:00Z"));
        tasks.push(approaching);
        // stale (no due, old)
        let stale = base_task(task_id(40), "Stale", ts("2026-01-01T00:00:00Z"));
        tasks.push(stale);
        // no today due → empty_today fires alongside overdue
        // overloaded: many estimated overdue already exceed capacity
        for task in &mut tasks {
            if task.due_date.is_some_and(|d| d < today) {
                task.estimated_minutes = Some(EstimatedMinutes::new(60).unwrap());
            }
        }

        let facts = evaluate_nudges(
            &tasks,
            today,
            DailyCapacityMinutes::DEFAULT,
            &TimeZone::UTC,
            &[],
            None,
        );
        let kinds: Vec<_> = facts.rules.iter().map(|r| r.kind).collect();
        assert!(kinds.contains(&NudgeRuleKind::Overdue));
        assert!(kinds.contains(&NudgeRuleKind::ApproachingDeadline));
        assert!(kinds.contains(&NudgeRuleKind::StaleTask));
        assert!(kinds.contains(&NudgeRuleKind::EmptyToday));
        assert!(kinds.contains(&NudgeRuleKind::OverloadedDay));
        // Stable rule order.
        for window in kinds.windows(2) {
            let pos = |k| NudgeRuleKind::ALL.iter().position(|x| *x == k).unwrap();
            assert!(pos(window[0]) < pos(window[1]));
        }
        let overdue_rule = facts
            .rules
            .iter()
            .find(|r| r.kind == NudgeRuleKind::Overdue)
            .unwrap();
        assert_eq!(overdue_rule.task_ids.len(), MAX_NUDGE_TASKS_PER_RULE);
        assert!(overdue_rule.has_more);
        assert!(facts.has_more);
        let empty = facts
            .rules
            .iter()
            .find(|r| r.kind == NudgeRuleKind::EmptyToday)
            .unwrap();
        assert!(empty.task_ids.is_empty());

        // Combined ceiling: 20+1+1 + overloaded truncated.
        let total: usize = facts.rules.iter().map(|r| r.task_ids.len()).sum();
        assert!(total <= MAX_NUDGE_TASKS_COMBINED);

        // With a pending task due today, empty_today must not fire.
        tasks.push(pending_due(50, "Today item", today, None));
        let with_today = evaluate_nudges(
            &tasks,
            today,
            DailyCapacityMinutes::DEFAULT,
            &TimeZone::UTC,
            &[],
            None,
        );
        assert!(
            !with_today
                .rules
                .iter()
                .any(|r| r.kind == NudgeRuleKind::EmptyToday)
        );
    }

    #[test]
    fn motivation_selectors_are_deterministic() {
        let today = date(2026, 3, 15);
        let mut high = pending_due(1, "Zed", today, Some(1));
        high.dread = Some(DreadLevel::new(5).unwrap());
        let mut also_high = pending_due(2, "Amy", today, Some(1));
        also_high.dread = Some(DreadLevel::new(5).unwrap());
        let mut lower = pending_due(3, "Bee", today, Some(1));
        lower.dread = Some(DreadLevel::new(2).unwrap());
        // Amy wins on title among equal dread/due.
        assert_eq!(
            select_eat_the_frog(&[high, also_high, lower]),
            Some(task_id(2))
        );
        assert_eq!(select_eat_the_frog(&[]), None);

        let jar = task_jar_candidates(
            &[
                pending_due(5, "B", today, None),
                pending_due(4, "A", date(2026, 3, 10), None),
                pending_due(6, "C", date(2026, 3, 20), None), // future excluded
            ],
            today,
        );
        assert_eq!(jar, vec![task_id(4), task_id(5)]);

        let mut short = pending_due(7, "Quick", today, Some(1));
        short.due_date = None;
        short.estimated_minutes = Some(EstimatedMinutes::new(10).unwrap());
        let low_pri = pending_due(8, "Low", today, Some(4));
        let mut long_high = pending_due(9, "Long", today, Some(1));
        long_high.estimated_minutes = Some(EstimatedMinutes::new(60).unwrap());
        let menu = dopamine_menu_task_ids(&[short, low_pri, long_high]);
        assert_eq!(menu, vec![task_id(7), task_id(8)]);
    }

    #[test]
    fn empty_inputs_are_safe() {
        let today = date(2026, 3, 15);
        let zone = TimeZone::UTC;
        assert!(group_matrix_task_ids(&[], today).do_first.is_empty());
        let plan = daily_plan_summary(&[], today, Some(DailyCapacityMinutes::new(120).unwrap()));
        assert!(plan.overdue_task_ids.is_empty());
        assert_eq!(plan.capacity_minutes, 120);
        let eod = end_of_day_summary(&[], today, &zone);
        assert_eq!(eod.completion_rate_percent, 0);
        let weekly = weekly_review_summary(&[], &[], today, WeekStart::Sunday, &zone).unwrap();
        assert_eq!(weekly.daily.len(), 7);
        assert!(weekly.suggestions.is_empty());
        let stats = stats_summary(&[], today, today, today, &zone).unwrap();
        assert_eq!(stats.days[0].completions, 0);
        assert_eq!(stats.current_streak_days, 0);
        let nudges = evaluate_nudges(&[], today, DailyCapacityMinutes::DEFAULT, &zone, &[], None);
        // Empty today still fires.
        assert_eq!(nudges.rules.len(), 1);
        assert_eq!(nudges.rules[0].kind, NudgeRuleKind::EmptyToday);
    }

    #[test]
    fn matrix_drop_never_emits_timestamp_strings() {
        // Serialize drop result and ensure due_date is a pure civil date.
        let drop = matrix_drop_result(MatrixQuadrant::DoFirst, date(2026, 3, 15));
        let json = serde_json::to_string(&drop).unwrap();
        assert!(json.contains("2026-03-15"));
        assert!(!json.contains('T'));
        assert!(!json.contains('Z'));
        // unused import guard for time in case
        let _ = time(0, 0, 0, 0);
    }
}
