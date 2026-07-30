//! Phase 3 pure temporal domain coverage: recurrence matrix, reminders, blocks, planning.

use jiff::civil::{Date, Time, date};
use junban_domain::{
    CivilTimeRange, DailyCapacityMinutes, EntityName, LocalDueTime, MAX_NUDGE_TASKS_COMBINED,
    MAX_NUDGE_TASKS_PER_RULE, MAX_SLOT_MEMBERSHIP, MonthlyAnchorDay, NextOccurrenceRequest,
    NudgeFacts, NudgeRuleFacts, NudgeRuleKind, OrderedSlotMembership, RecurrenceRule,
    RecurrenceSource, ReminderChannel, ReminderChannelSet, ReminderFailureCode,
    ReminderOccurrenceState, ReminderSettings, TaskId, TimeBlockDraft, TimeSlotDraft, TimeZoneName,
    ValidationError, WeekStart, WorkHours, next_occurrence, reminder_failure_backoff,
    resolve_due_instant, validate_reminder_claim_limit,
};
use proptest::prelude::*;

fn rule(raw: &str) -> RecurrenceRule {
    RecurrenceRule::new(raw).unwrap()
}

fn timed(hour: i8, minute: i8, zone: &str) -> LocalDueTime {
    LocalDueTime::new(
        Time::constant(hour, minute, 0, 0),
        TimeZoneName::new(zone).unwrap(),
    )
}

fn req(
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
fn date_only_rules_advance_exactly_one_interval() {
    assert_eq!(
        next_occurrence(&req(
            "daily",
            Some(date(2026, 3, 8)),
            None,
            None,
            date(2026, 4, 1)
        ))
        .unwrap()
        .due_date,
        date(2026, 3, 9)
    );
    assert_eq!(
        next_occurrence(&req(
            "weekly",
            Some(date(2026, 3, 8)),
            None,
            None,
            date(2026, 4, 1)
        ))
        .unwrap()
        .due_date,
        date(2026, 3, 15)
    );
    assert_eq!(
        next_occurrence(&req(
            "every 3 days",
            Some(date(2026, 3, 8)),
            None,
            None,
            date(2026, 4, 1)
        ))
        .unwrap()
        .due_date,
        date(2026, 3, 11)
    );
    assert_eq!(
        next_occurrence(&req(
            "every 2 weeks",
            Some(date(2026, 3, 8)),
            None,
            None,
            date(2026, 4, 1)
        ))
        .unwrap()
        .due_date,
        date(2026, 3, 22)
    );
}

#[test]
fn overdue_never_catches_up_multiple_intervals() {
    // Source due is far in the past relative to sampled completion; still +1 week only.
    let next = next_occurrence(&req(
        "weekly",
        Some(date(2025, 1, 1)),
        None,
        None,
        date(2026, 3, 20),
    ))
    .unwrap();
    assert_eq!(next.due_date, date(2025, 1, 8));
}

#[test]
fn no_due_uses_sampled_completion_only() {
    let next = next_occurrence(&req("monthly", None, None, None, date(2026, 1, 31))).unwrap();
    assert_eq!(next.due_date, date(2026, 2, 28));
    assert_eq!(next.monthly_anchor.map(MonthlyAnchorDay::get), Some(31));
    assert!(next.due_time.is_none());
    assert!(next.due_instant.is_none());
}

#[test]
fn weekdays_matrix() {
    let cases = [
        (date(2026, 3, 2), date(2026, 3, 3)), // Mon -> Tue
        (date(2026, 3, 3), date(2026, 3, 4)), // Tue -> Wed
        (date(2026, 3, 4), date(2026, 3, 5)), // Wed -> Thu
        (date(2026, 3, 5), date(2026, 3, 6)), // Thu -> Fri
        (date(2026, 3, 6), date(2026, 3, 9)), // Fri -> Mon
        (date(2026, 3, 7), date(2026, 3, 9)), // Sat -> Mon
        (date(2026, 3, 8), date(2026, 3, 9)), // Sun -> Mon
    ];
    for (source, expected) in cases {
        let next = next_occurrence(&req("weekdays", Some(source), None, None, source)).unwrap();
        assert_eq!(next.due_date, expected, "from {source}");
    }
}

#[test]
fn monthly_end_of_month_anchor_chain() {
    let mut due = date(2026, 1, 31);
    let mut anchor = Some(31u8);
    let expected = [
        date(2026, 2, 28),
        date(2026, 3, 31),
        date(2026, 4, 30),
        date(2026, 5, 31),
    ];
    for want in expected {
        let next = next_occurrence(&req("monthly", Some(due), None, anchor, due)).unwrap();
        assert_eq!(next.due_date, want);
        assert_eq!(next.monthly_anchor.map(MonthlyAnchorDay::get), Some(31));
        due = next.due_date;
        anchor = next.monthly_anchor.map(MonthlyAnchorDay::get);
    }
}

#[test]
fn yearly_leap_day_lineage() {
    let mut due = date(2024, 2, 29);
    let mut anchor = None;
    let expected = [
        date(2025, 3, 1),
        date(2026, 3, 1),
        date(2027, 3, 1),
        date(2028, 2, 29),
        date(2029, 3, 1),
    ];
    for want in expected {
        let next = next_occurrence(&req("yearly", Some(due), None, anchor, due)).unwrap();
        assert_eq!(next.due_date, want);
        assert_eq!(next.monthly_anchor.map(MonthlyAnchorDay::get), Some(29));
        due = next.due_date;
        anchor = next.monthly_anchor.map(MonthlyAnchorDay::get);
    }
}

#[test]
fn timed_preserves_zone_and_wall_time_across_ordinary_day() {
    let next = next_occurrence(&req(
        "daily",
        Some(date(2026, 6, 1)),
        Some(timed(14, 15, "Europe/London")),
        None,
        date(2026, 6, 1),
    ))
    .unwrap();
    assert_eq!(next.due_date, date(2026, 6, 2));
    let local = next.due_time.expect("timed");
    assert_eq!(local.time, Time::constant(14, 15, 0, 0));
    assert_eq!(local.time_zone.as_str(), "Europe/London");
    assert_eq!(
        next.due_instant.unwrap(),
        resolve_due_instant(date(2026, 6, 2), &local).unwrap()
    );
}

#[test]
fn dst_spring_forward_gap_moves_forward() {
    // America/New_York 2024-03-10 skips 02:00-03:00. Compatible policy -> 03:30-04:00.
    let next = next_occurrence(&req(
        "daily",
        Some(date(2024, 3, 9)),
        Some(timed(2, 30, "America/New_York")),
        None,
        date(2024, 3, 9),
    ))
    .unwrap();
    assert_eq!(next.due_date, date(2024, 3, 10));
    assert_eq!(
        next.due_time.as_ref().unwrap().time,
        Time::constant(2, 30, 0, 0)
    );
    assert_eq!(
        next.due_instant.unwrap().to_string(),
        "2024-03-10T07:30:00Z"
    );
}

#[test]
fn dst_fall_back_fold_uses_earlier_offset() {
    let instant =
        resolve_due_instant(date(2024, 11, 3), &timed(1, 30, "America/New_York")).unwrap();
    assert_eq!(instant.to_string(), "2024-11-03T05:30:00Z");
}

#[test]
fn dst_repeat_daily_across_transition_keeps_wall_clock() {
    let mut due = date(2024, 3, 8);
    let zone_time = timed(1, 30, "America/New_York");
    for _ in 0..5 {
        let next =
            next_occurrence(&req("daily", Some(due), Some(zone_time.clone()), None, due)).unwrap();
        assert_eq!(
            next.due_time.as_ref().unwrap().time,
            Time::constant(1, 30, 0, 0)
        );
        assert_eq!(
            next.due_time.as_ref().unwrap().time_zone.as_str(),
            "America/New_York"
        );
        due = next.due_date;
    }
    assert_eq!(due, date(2024, 3, 13));
}

#[test]
fn invalid_inputs_are_rejected() {
    assert!(MonthlyAnchorDay::new(0).is_err());
    assert!(MonthlyAnchorDay::new(32).is_err());
    assert_eq!(
        next_occurrence(&req(
            "daily",
            None,
            Some(timed(9, 0, "UTC")),
            None,
            date(2026, 1, 1)
        ))
        .unwrap_err(),
        ValidationError::Invalid {
            field: "due_time",
            reason: "due_time requires due_date",
        }
    );
    assert_eq!(
        next_occurrence(&req(
            "daily",
            Some(date(2026, 1, 1)),
            Some(timed(9, 0, "Fake/Zone")),
            None,
            date(2026, 1, 1)
        ))
        .unwrap_err(),
        ValidationError::Invalid {
            field: "time_zone",
            reason: "unknown IANA timezone",
        }
    );
    // Syntactic TimeZoneName still rejects empty/garbage before resolution.
    assert!(TimeZoneName::new("").is_err());
    assert!(TimeZoneName::new("not a zone").is_err());
}

#[test]
fn manual_anchor_reset_helper_uses_occurrence_day() {
    let reset = MonthlyAnchorDay::from_date(date(2026, 4, 15));
    assert_eq!(reset.get(), 15);
    let next = next_occurrence(&req(
        "monthly",
        Some(date(2026, 4, 15)),
        None,
        Some(reset.get()),
        date(2026, 4, 15),
    ))
    .unwrap();
    assert_eq!(next.due_date, date(2026, 5, 15));
    assert_eq!(next.monthly_anchor.map(MonthlyAnchorDay::get), Some(15));
}

#[test]
fn reminder_types_and_bounds() {
    let channels =
        ReminderChannelSet::new(vec![ReminderChannel::InApp, ReminderChannel::Sound]).unwrap();
    let settings = ReminderSettings::new(channels, None);
    assert_eq!(settings.channels.as_slice().len(), 2);
    assert!(ReminderChannel::parse("push").is_err());
    assert_eq!(
        ReminderFailureCode::parse("channel_failed").unwrap(),
        ReminderFailureCode::ChannelFailed
    );
    assert!(ReminderOccurrenceState::parse("pending").unwrap() == ReminderOccurrenceState::Pending);
    assert_eq!(validate_reminder_claim_limit(20).unwrap(), 20);
    assert!(validate_reminder_claim_limit(101).is_err());
    assert_eq!(reminder_failure_backoff(1).as_secs(), 30);
    assert_eq!(reminder_failure_backoff(100).as_secs(), 3600);
}

#[test]
fn timeblock_and_slot_membership_bounds() {
    let range = CivilTimeRange::new(
        date(2026, 3, 8),
        Time::constant(9, 0, 0, 0),
        Time::constant(10, 30, 0, 0),
        TimeZoneName::new("America/Chicago").unwrap(),
    )
    .unwrap();
    let block = TimeBlockDraft::new(EntityName::new("Focus").unwrap(), range.clone());
    assert!(!block.locked);
    let slot = TimeSlotDraft::new(EntityName::new("Deep work").unwrap(), range);
    assert!(slot.project_id.is_none());

    assert!(OrderedSlotMembership::new(vec![TaskId::new(); 2]).is_err());
    let overflow = (0..=MAX_SLOT_MEMBERSHIP)
        .map(|_| TaskId::new())
        .collect::<Vec<_>>();
    assert_eq!(
        OrderedSlotMembership::new(overflow).unwrap_err(),
        ValidationError::TooMany {
            field: "slot_task_ids",
            count: MAX_SLOT_MEMBERSHIP + 1,
            max: MAX_SLOT_MEMBERSHIP,
        }
    );
}

#[test]
fn planning_capacity_and_nudge_bounds() {
    assert_eq!(DailyCapacityMinutes::DEFAULT.get(), 480);
    assert_eq!(WeekStart::Monday.as_str(), "monday");
    assert_eq!(
        WorkHours::new(8 * 60, 16 * 60).unwrap().duration_minutes(),
        480
    );

    let overflow_rule = (0..=MAX_NUDGE_TASKS_PER_RULE)
        .map(|_| TaskId::new())
        .collect::<Vec<_>>();
    assert!(NudgeRuleFacts::new(NudgeRuleKind::Overdue, overflow_rule, false).is_err());

    let a = NudgeRuleFacts::new(
        NudgeRuleKind::Overdue,
        (0..20).map(|_| TaskId::new()).collect(),
        true,
    )
    .unwrap();
    let b = NudgeRuleFacts::new(
        NudgeRuleKind::ApproachingDeadline,
        (0..20).map(|_| TaskId::new()).collect(),
        false,
    )
    .unwrap();
    let c = NudgeRuleFacts::new(
        NudgeRuleKind::StaleTask,
        (0..11).map(|_| TaskId::new()).collect(),
        false,
    )
    .unwrap();
    assert_eq!(
        NudgeFacts::new(vec![a, b, c]).unwrap_err(),
        ValidationError::TooMany {
            field: "nudge_tasks",
            count: 51,
            max: MAX_NUDGE_TASKS_COMBINED,
        }
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn daily_is_exactly_one_day(year in 2000i16..=2090, day_ord in 1u16..=365) {
        use jiff::ToSpan;
        let start = Date::new(year, 1, 1)
            .unwrap()
            .checked_add((day_ord as i64 - 1).days())
            .unwrap();
        // Keep room for +1 day within the year range used above.
        prop_assume!(start < date(2090, 12, 31));
        let next = next_occurrence(&req("daily", Some(start), None, None, start)).unwrap();
        let delta = next.due_date.since(start).unwrap();
        prop_assert_eq!(delta.get_days(), 1);
        prop_assert!(next.due_instant.is_none());
    }

    #[test]
    fn every_n_days_matches_count(
        year in 2000i16..=2080,
        day_ord in 1u16..=300,
        n in 1u32..=30,
    ) {
        use jiff::ToSpan;
        let start = Date::new(year, 1, 1)
            .unwrap()
            .checked_add((day_ord as i64 - 1).days())
            .unwrap();
        let next = next_occurrence(&req(
            &format!("every {n} days"),
            Some(start),
            None,
            None,
            start,
        ))
        .unwrap();
        let delta = next.due_date.since(start).unwrap();
        prop_assert_eq!(delta.get_days(), n as i32);
    }

    #[test]
    fn monthly_anchor_never_exceeds_month_length(
        year in 2000i16..=2090,
        month in 1i8..=12,
        anchor in 1u8..=31,
    ) {
        use jiff::ToSpan;
        let start_day = i8::try_from(anchor)
            .unwrap()
            .min(Date::new(year, month, 1).unwrap().days_in_month());
        let start = Date::new(year, month, start_day).unwrap();
        prop_assume!(!(year == 2090 && month == 12));
        let next =
            next_occurrence(&req("monthly", Some(start), None, Some(anchor), start)).unwrap();
        prop_assert!(next.due_date.day() <= next.due_date.days_in_month());
        prop_assert!((next.due_date.day() as u8) <= anchor);
        prop_assert_eq!(next.monthly_anchor.map(MonthlyAnchorDay::get), Some(anchor));
        // Next month after start.
        let start_first = Date::new(year, month, 1).unwrap();
        let expect_month = start_first.checked_add(1.month()).unwrap();
        prop_assert_eq!(next.due_date.year(), expect_month.year());
        prop_assert_eq!(next.due_date.month(), expect_month.month());
    }
}
