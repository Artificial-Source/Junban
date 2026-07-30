//! Pure recurrence occurrence generation.
//!
//! Callers sample the server-local civil date at the use-case boundary and pass it
//! in. This module never reads the system clock.

use jiff::{
    Timestamp, ToSpan,
    civil::{Date, Weekday},
    tz::TimeZone,
};
use serde::{Deserialize, Serialize};

use crate::{LocalDueTime, RecurrenceRule, ValidationError};

/// Intended day-of-month for monthly (and leap-day yearly) lineage, range 1..=31.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MonthlyAnchorDay(u8);

impl MonthlyAnchorDay {
    pub const MIN: u8 = 1;
    pub const MAX: u8 = 31;

    pub fn new(value: u8) -> Result<Self, ValidationError> {
        if !(Self::MIN..=Self::MAX).contains(&value) {
            return Err(ValidationError::OutOfRange {
                field: "recurrence_anchor_day",
                min: i64::from(Self::MIN),
                max: i64::from(Self::MAX),
            });
        }
        Ok(Self(value))
    }

    /// Anchor taken from an occurrence's civil day. Callers use this after a manual
    /// due-date, representation, or rule change resets lineage.
    pub fn from_date(date: Date) -> Self {
        Self(u8::try_from(date.day()).expect("civil day is always 1..=31"))
    }

    #[must_use]
    pub const fn get(self) -> u8 {
        self.0
    }
}

/// Source task fields required to compute the next occurrence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecurrenceSource {
    pub rule: RecurrenceRule,
    pub due_date: Option<Date>,
    pub due_time: Option<LocalDueTime>,
    pub monthly_anchor: Option<MonthlyAnchorDay>,
}

impl RecurrenceSource {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.due_time.is_some() && self.due_date.is_none() {
            return Err(ValidationError::Invalid {
                field: "due_time",
                reason: "due_time requires due_date",
            });
        }
        Ok(())
    }
}

/// Explicit inputs for one deterministic next-occurrence evaluation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NextOccurrenceRequest {
    pub source: RecurrenceSource,
    /// Server-local civil date sampled once at the use-case boundary.
    pub sampled_completion_date: Date,
}

/// Validated next occurrence for application/storage to persist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NextOccurrence {
    pub due_date: Date,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_time: Option<LocalDueTime>,
    /// Retained monthly/leap-day anchor for the new pending occurrence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monthly_anchor: Option<MonthlyAnchorDay>,
    /// Absolute due instant when the source was timed; `None` for date-only results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_instant: Option<Timestamp>,
}

/// Absolute reminder/deadline values after advancing one occurrence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct OccurrenceAbsoluteOffsets {
    pub remind_at: Option<Timestamp>,
    pub deadline: Option<Timestamp>,
}

/// Shift due-relative absolute timestamps onto the next occurrence basis.
///
/// When the source has no due basis, absolute reminder/deadline clear. Timed sources use
/// their resolved due instants. Date-only sources use `server_zone` start-of-day for both
/// the source due date and the next due date.
pub fn shift_occurrence_absolutes(
    source: &RecurrenceSource,
    next: &NextOccurrence,
    source_remind_at: Option<Timestamp>,
    source_deadline: Option<Timestamp>,
    server_zone: &TimeZone,
) -> Result<OccurrenceAbsoluteOffsets, ValidationError> {
    let Some(source_basis) = source_due_basis(source, server_zone)? else {
        return Ok(OccurrenceAbsoluteOffsets {
            remind_at: None,
            deadline: None,
        });
    };
    let next_basis = next_due_basis(next, server_zone)?;
    Ok(OccurrenceAbsoluteOffsets {
        remind_at: shift_absolute(source_basis, next_basis, source_remind_at)?,
        deadline: shift_absolute(source_basis, next_basis, source_deadline)?,
    })
}

fn source_due_basis(
    source: &RecurrenceSource,
    server_zone: &TimeZone,
) -> Result<Option<Timestamp>, ValidationError> {
    let Some(due_date) = source.due_date else {
        return Ok(None);
    };
    match &source.due_time {
        Some(local) => Ok(Some(resolve_due_instant(due_date, local)?)),
        None => Ok(Some(civil_start_of_day(due_date, server_zone)?)),
    }
}

fn next_due_basis(
    next: &NextOccurrence,
    server_zone: &TimeZone,
) -> Result<Timestamp, ValidationError> {
    if let Some(instant) = next.due_instant {
        return Ok(instant);
    }
    civil_start_of_day(next.due_date, server_zone)
}

fn civil_start_of_day(date: Date, server_zone: &TimeZone) -> Result<Timestamp, ValidationError> {
    date.to_zoned(server_zone.clone())
        .map(|zoned| zoned.timestamp())
        .map_err(|_| ValidationError::Invalid {
            field: "due_date",
            reason: "could not resolve local day start to a timestamp",
        })
}

fn shift_absolute(
    source_basis: Timestamp,
    next_basis: Timestamp,
    absolute: Option<Timestamp>,
) -> Result<Option<Timestamp>, ValidationError> {
    let Some(absolute) = absolute else {
        return Ok(None);
    };
    let offset = absolute.duration_since(source_basis);
    next_basis
        .checked_add(offset)
        .map(Some)
        .map_err(|_| ValidationError::Invalid {
            field: "remind_at",
            reason: "shifted absolute timestamp is out of range",
        })
}

/// Advance exactly one interval from the source due value (or sampled completion date
/// when the source has no due date). Overdue sources do not skip intervals.
pub fn next_occurrence(request: &NextOccurrenceRequest) -> Result<NextOccurrence, ValidationError> {
    request.source.validate()?;

    let rule = parse_rule(request.source.rule.as_str())?;
    let base_date = request
        .source
        .due_date
        .unwrap_or(request.sampled_completion_date);
    let had_due_date = request.source.due_date.is_some();

    let (next_date, next_anchor) = advance_date(rule, base_date, request.source.monthly_anchor)?;

    // No-due completions always create a date-only next due; timed wall-clock values
    // are preserved only when the source itself carried a due date and time.
    let next_time = if had_due_date {
        request.source.due_time.clone()
    } else {
        None
    };

    let due_instant = match &next_time {
        Some(local) => Some(resolve_due_instant(next_date, local)?),
        None => None,
    };

    Ok(NextOccurrence {
        due_date: next_date,
        due_time: next_time,
        monthly_anchor: next_anchor,
        due_instant,
    })
}

/// Resolve a civil date + local wall time into a UTC instant using frozen DST policy:
/// nonexistent (gap) targets move forward by the gap; ambiguous (fold) targets use the
/// earlier offset. Jiff's compatible disambiguation matches both rules.
pub fn resolve_due_instant(
    due_date: Date,
    due_time: &LocalDueTime,
) -> Result<Timestamp, ValidationError> {
    let zone =
        TimeZone::get(due_time.time_zone.as_str()).map_err(|_| ValidationError::Invalid {
            field: "time_zone",
            reason: "unknown IANA timezone",
        })?;
    let civil = due_date.to_datetime(due_time.time);
    let zoned = zone.to_zoned(civil).map_err(|_| ValidationError::Invalid {
        field: "due_time",
        reason: "civil datetime cannot be resolved in timezone",
    })?;
    Ok(zoned.timestamp())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuleKind {
    Daily,
    Weekly,
    Monthly,
    Yearly,
    Weekdays,
    EveryDays(u32),
    EveryWeeks(u32),
}

fn parse_rule(canonical: &str) -> Result<RuleKind, ValidationError> {
    let invalid = || ValidationError::InvalidFormat {
        field: "recurrence_rule",
        expected: "daily|weekly|monthly|yearly|weekdays|every N day(s)|week(s)",
    };
    match canonical {
        "daily" => Ok(RuleKind::Daily),
        "weekly" => Ok(RuleKind::Weekly),
        "monthly" => Ok(RuleKind::Monthly),
        "yearly" => Ok(RuleKind::Yearly),
        "weekdays" => Ok(RuleKind::Weekdays),
        other => {
            let mut parts = other.split(' ');
            let Some("every") = parts.next() else {
                return Err(invalid());
            };
            let Some(count_raw) = parts.next() else {
                return Err(invalid());
            };
            let Some(unit) = parts.next() else {
                return Err(invalid());
            };
            if parts.next().is_some() {
                return Err(invalid());
            }
            let count = count_raw.parse::<u32>().map_err(|_| invalid())?;
            if count < 1 {
                return Err(ValidationError::TooSmall {
                    field: "recurrence_rule",
                    min: 1,
                });
            }
            match unit {
                "day" | "days" => Ok(RuleKind::EveryDays(count)),
                "week" | "weeks" => Ok(RuleKind::EveryWeeks(count)),
                _ => Err(invalid()),
            }
        }
    }
}

fn advance_date(
    rule: RuleKind,
    base: Date,
    anchor: Option<MonthlyAnchorDay>,
) -> Result<(Date, Option<MonthlyAnchorDay>), ValidationError> {
    match rule {
        RuleKind::Daily => Ok((add_days(base, 1)?, None)),
        RuleKind::Weekly => Ok((add_weeks(base, 1)?, None)),
        RuleKind::EveryDays(n) => Ok((add_days(base, i64::from(n))?, None)),
        RuleKind::EveryWeeks(n) => Ok((add_weeks(base, i64::from(n))?, None)),
        RuleKind::Weekdays => Ok((next_weekday(base)?, None)),
        RuleKind::Monthly => {
            let anchor = anchor.unwrap_or_else(|| MonthlyAnchorDay::from_date(base));
            Ok((next_monthly(base, anchor)?, Some(anchor)))
        }
        RuleKind::Yearly => {
            let series_anchor = yearly_series_anchor(base, anchor);
            let next = next_yearly(base, series_anchor)?;
            Ok((next, series_anchor))
        }
    }
}

fn add_days(base: Date, days: i64) -> Result<Date, ValidationError> {
    base.checked_add(days.days())
        .map_err(|_| ValidationError::Invalid {
            field: "due_date",
            reason: "recurrence advances outside the supported civil date range",
        })
}

fn add_weeks(base: Date, weeks: i64) -> Result<Date, ValidationError> {
    base.checked_add(weeks.weeks())
        .map_err(|_| ValidationError::Invalid {
            field: "due_date",
            reason: "recurrence advances outside the supported civil date range",
        })
}

fn next_weekday(base: Date) -> Result<Date, ValidationError> {
    // Advance at least one day, then skip Saturday/Sunday so Fri/Sat/Sun land on Monday.
    let mut cursor = add_days(base, 1)?;
    loop {
        match cursor.weekday() {
            Weekday::Saturday | Weekday::Sunday => cursor = add_days(cursor, 1)?,
            _ => return Ok(cursor),
        }
    }
}

fn next_monthly(base: Date, anchor: MonthlyAnchorDay) -> Result<Date, ValidationError> {
    // Advance the year-month of the source, then clamp the retained anchor into that month.
    let first_of_base =
        Date::new(base.year(), base.month(), 1).map_err(|_| ValidationError::Invalid {
            field: "due_date",
            reason: "invalid source due date",
        })?;
    let first_of_next =
        first_of_base
            .checked_add(1.month())
            .map_err(|_| ValidationError::Invalid {
                field: "due_date",
                reason: "recurrence advances outside the supported civil date range",
            })?;
    let day = i8::try_from(anchor.get()).expect("anchor is 1..=31");
    let clamped = day.min(first_of_next.days_in_month());
    Date::new(first_of_next.year(), first_of_next.month(), clamped).map_err(|_| {
        ValidationError::Invalid {
            field: "due_date",
            reason: "invalid monthly occurrence",
        }
    })
}

fn yearly_series_anchor(base: Date, anchor: Option<MonthlyAnchorDay>) -> Option<MonthlyAnchorDay> {
    // Preserve Feb-29 lineage across non-leap Mar 1 clamps via anchor day 29.
    if base.month() == 2 && base.day() == 29 {
        return Some(MonthlyAnchorDay::new(29).expect("29 is valid"));
    }
    if base.month() == 3
        && base.day() == 1
        && let Some(day) = anchor.filter(|value| value.get() == 29)
    {
        return Some(day);
    }
    None
}

fn next_yearly(
    base: Date,
    series_anchor: Option<MonthlyAnchorDay>,
) -> Result<Date, ValidationError> {
    let (series_month, series_day) = if series_anchor.is_some_and(|day| day.get() == 29)
        && ((base.month() == 2 && base.day() == 29) || (base.month() == 3 && base.day() == 1))
    {
        (2_i8, 29_i8)
    } else {
        (base.month(), base.day())
    };

    let next_year = base.year().checked_add(1).ok_or(ValidationError::Invalid {
        field: "due_date",
        reason: "recurrence advances outside the supported civil date range",
    })?;

    if series_month == 2 && series_day == 29 {
        // Product contract: Feb 29 rolls to Mar 1 in non-leap years.
        if is_leap_year(next_year) {
            return Date::new(next_year, 2, 29).map_err(|_| ValidationError::Invalid {
                field: "due_date",
                reason: "invalid yearly occurrence",
            });
        }
        return Date::new(next_year, 3, 1).map_err(|_| ValidationError::Invalid {
            field: "due_date",
            reason: "invalid yearly occurrence",
        });
    }

    let first = Date::new(next_year, series_month, 1).map_err(|_| ValidationError::Invalid {
        field: "due_date",
        reason: "invalid yearly occurrence",
    })?;
    let clamped = series_day.min(first.days_in_month());
    Date::new(next_year, series_month, clamped).map_err(|_| ValidationError::Invalid {
        field: "due_date",
        reason: "invalid yearly occurrence",
    })
}

fn is_leap_year(year: i16) -> bool {
    // Probe February length rather than re-implementing Gregorian rules.
    Date::new(year, 2, 1)
        .map(|date| date.days_in_month() == 29)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{LocalDueTime, RecurrenceRule, TimeZoneName};
    use jiff::civil::{Time, date};

    fn rule(raw: &str) -> RecurrenceRule {
        RecurrenceRule::new(raw).unwrap()
    }

    fn timed(hour: i8, minute: i8, zone: &str) -> LocalDueTime {
        LocalDueTime::new(
            Time::constant(hour, minute, 0, 0),
            TimeZoneName::new(zone).unwrap(),
        )
    }

    fn request(
        rule_raw: &str,
        due: Option<Date>,
        due_time: Option<LocalDueTime>,
        anchor: Option<u8>,
        sampled: Date,
    ) -> NextOccurrenceRequest {
        NextOccurrenceRequest {
            source: RecurrenceSource {
                rule: rule(rule_raw),
                due_date: due,
                due_time,
                monthly_anchor: anchor.map(|day| MonthlyAnchorDay::new(day).unwrap()),
            },
            sampled_completion_date: sampled,
        }
    }

    #[test]
    fn daily_date_only_advances_one_day() {
        let next = next_occurrence(&request(
            "daily",
            Some(date(2026, 3, 8)),
            None,
            None,
            date(2026, 3, 20),
        ))
        .unwrap();
        assert_eq!(next.due_date, date(2026, 3, 9));
        assert_eq!(next.due_time, None);
        assert_eq!(next.due_instant, None);
        assert_eq!(next.monthly_anchor, None);
    }

    #[test]
    fn overdue_source_does_not_skip_intervals() {
        let next = next_occurrence(&request(
            "weekly",
            Some(date(2026, 1, 1)),
            None,
            None,
            date(2026, 3, 20),
        ))
        .unwrap();
        assert_eq!(next.due_date, date(2026, 1, 8));
    }

    #[test]
    fn no_due_uses_sampled_completion_date_and_stays_date_only() {
        let next = next_occurrence(&request(
            "every 2 days",
            None,
            None,
            None,
            date(2026, 3, 10),
        ))
        .unwrap();
        assert_eq!(next.due_date, date(2026, 3, 12));
        assert_eq!(next.due_time, None);
        assert_eq!(next.due_instant, None);
    }

    #[test]
    fn weekdays_skip_weekend() {
        assert_eq!(
            next_occurrence(&request(
                "weekdays",
                Some(date(2026, 3, 6)), // Friday
                None,
                None,
                date(2026, 3, 6),
            ))
            .unwrap()
            .due_date,
            date(2026, 3, 9) // Monday
        );
        assert_eq!(
            next_occurrence(&request(
                "weekdays",
                Some(date(2026, 3, 7)), // Saturday
                None,
                None,
                date(2026, 3, 7),
            ))
            .unwrap()
            .due_date,
            date(2026, 3, 9)
        );
        assert_eq!(
            next_occurrence(&request(
                "weekdays",
                Some(date(2026, 3, 8)), // Sunday
                None,
                None,
                date(2026, 3, 8),
            ))
            .unwrap()
            .due_date,
            date(2026, 3, 9)
        );
        assert_eq!(
            next_occurrence(&request(
                "weekdays",
                Some(date(2026, 3, 9)), // Monday
                None,
                None,
                date(2026, 3, 9),
            ))
            .unwrap()
            .due_date,
            date(2026, 3, 10)
        );
    }

    #[test]
    fn monthly_anchor_survives_short_months() {
        let jan = next_occurrence(&request(
            "monthly",
            Some(date(2026, 1, 31)),
            None,
            Some(31),
            date(2026, 1, 31),
        ))
        .unwrap();
        assert_eq!(jan.due_date, date(2026, 2, 28));
        assert_eq!(jan.monthly_anchor.map(MonthlyAnchorDay::get), Some(31));

        let mar = next_occurrence(&request(
            "monthly",
            Some(jan.due_date),
            None,
            jan.monthly_anchor.map(MonthlyAnchorDay::get),
            date(2026, 2, 28),
        ))
        .unwrap();
        assert_eq!(mar.due_date, date(2026, 3, 31));
        assert_eq!(mar.monthly_anchor.map(MonthlyAnchorDay::get), Some(31));
    }

    #[test]
    fn yearly_feb_29_rolls_to_mar_1_then_returns_on_leap_year() {
        let y2025 = next_occurrence(&request(
            "yearly",
            Some(date(2024, 2, 29)),
            None,
            None,
            date(2024, 2, 29),
        ))
        .unwrap();
        assert_eq!(y2025.due_date, date(2025, 3, 1));
        assert_eq!(y2025.monthly_anchor.map(MonthlyAnchorDay::get), Some(29));

        let y2026 = next_occurrence(&request(
            "yearly",
            Some(y2025.due_date),
            None,
            y2025.monthly_anchor.map(MonthlyAnchorDay::get),
            date(2025, 3, 1),
        ))
        .unwrap();
        assert_eq!(y2026.due_date, date(2026, 3, 1));

        let y2027 = next_occurrence(&request(
            "yearly",
            Some(y2026.due_date),
            None,
            y2026.monthly_anchor.map(MonthlyAnchorDay::get),
            date(2026, 3, 1),
        ))
        .unwrap();
        assert_eq!(y2027.due_date, date(2027, 3, 1));

        let y2028 = next_occurrence(&request(
            "yearly",
            Some(y2027.due_date),
            None,
            y2027.monthly_anchor.map(MonthlyAnchorDay::get),
            date(2027, 3, 1),
        ))
        .unwrap();
        assert_eq!(y2028.due_date, date(2028, 2, 29));
    }

    #[test]
    fn timed_value_preserves_wall_clock_and_resolves_dst_gap() {
        let next = next_occurrence(&request(
            "daily",
            Some(date(2024, 3, 9)),
            Some(timed(2, 30, "America/New_York")),
            None,
            date(2024, 3, 9),
        ))
        .unwrap();
        assert_eq!(next.due_date, date(2024, 3, 10));
        let local = next.due_time.unwrap();
        assert_eq!(local.time, Time::constant(2, 30, 0, 0));
        assert_eq!(local.time_zone.as_str(), "America/New_York");
        // 2024-03-10 02:30 is in the spring-forward gap; compatible policy yields 03:30 EDT.
        assert_eq!(
            next.due_instant.unwrap().to_string(),
            "2024-03-10T07:30:00Z"
        );
    }

    #[test]
    fn timed_value_uses_earlier_offset_in_fold() {
        let instant =
            resolve_due_instant(date(2024, 11, 3), &timed(1, 30, "America/New_York")).unwrap();
        // First 01:30 is EDT (-04).
        assert_eq!(instant.to_string(), "2024-11-03T05:30:00Z");
    }

    #[test]
    fn unknown_timezone_is_rejected_when_resolving_instant() {
        let err = next_occurrence(&request(
            "daily",
            Some(date(2026, 3, 8)),
            Some(timed(9, 0, "America/Not_A_Real_Zone")),
            None,
            date(2026, 3, 8),
        ))
        .unwrap_err();
        assert_eq!(
            err,
            ValidationError::Invalid {
                field: "time_zone",
                reason: "unknown IANA timezone",
            }
        );
    }

    #[test]
    fn due_time_without_due_date_is_rejected() {
        let err = next_occurrence(&request(
            "daily",
            None,
            Some(timed(9, 0, "UTC")),
            None,
            date(2026, 3, 8),
        ));
        // no-due path strips time before validation of pair... source validation catches it
        // when due_time is set without due_date.
        assert!(err.is_err());
    }

    #[test]
    fn monthly_anchor_day_bounds() {
        assert!(MonthlyAnchorDay::new(0).is_err());
        assert!(MonthlyAnchorDay::new(32).is_err());
        assert_eq!(MonthlyAnchorDay::new(31).unwrap().get(), 31);
        assert_eq!(MonthlyAnchorDay::from_date(date(2026, 2, 28)).get(), 28);
    }

    #[test]
    fn no_due_clears_absolute_offsets_and_date_only_preserves_them() {
        let zone = TimeZone::UTC;
        let next = next_occurrence(&request("daily", None, None, None, date(2026, 3, 10))).unwrap();
        let cleared = shift_occurrence_absolutes(
            &RecurrenceSource {
                rule: rule("daily"),
                due_date: None,
                due_time: None,
                monthly_anchor: None,
            },
            &next,
            Some("2026-03-10T12:00:00Z".parse().unwrap()),
            Some("2026-03-10T18:00:00Z".parse().unwrap()),
            &zone,
        )
        .unwrap();
        assert_eq!(cleared.remind_at, None);
        assert_eq!(cleared.deadline, None);

        let next = next_occurrence(&request(
            "daily",
            Some(date(2026, 3, 10)),
            None,
            None,
            date(2026, 3, 10),
        ))
        .unwrap();
        let shifted = shift_occurrence_absolutes(
            &RecurrenceSource {
                rule: rule("daily"),
                due_date: Some(date(2026, 3, 10)),
                due_time: None,
                monthly_anchor: None,
            },
            &next,
            Some("2026-03-10T06:00:00Z".parse().unwrap()),
            Some("2026-03-10T18:00:00Z".parse().unwrap()),
            &zone,
        )
        .unwrap();
        assert_eq!(
            shifted.remind_at.unwrap().to_string(),
            "2026-03-11T06:00:00Z"
        );
        assert_eq!(
            shifted.deadline.unwrap().to_string(),
            "2026-03-11T18:00:00Z"
        );
    }
}
