//! Golden and small property-style coverage for Phase 2 pure parsers.

use jiff::civil::{Date, Weekday, date};
use junban_domain::{
    MAX_QUICK_ENTRY_CHARS, TaskStatus, ValidationError, parse_filter, parse_quick_entry,
    parse_text_import,
};

fn fixed_today() -> Date {
    date(2026, 7, 15) // Wednesday
}

#[test]
fn quick_entry_iso_and_relative_dates() {
    let today = fixed_today();
    assert_eq!(
        parse_quick_entry("A 2026-07-20", today).unwrap().due_date,
        Some(date(2026, 7, 20))
    );
    assert_eq!(
        parse_quick_entry("A today", today).unwrap().due_date,
        Some(today)
    );
    assert_eq!(
        parse_quick_entry("A tomorrow", today).unwrap().due_date,
        Some(date(2026, 7, 16))
    );
}

#[test]
fn quick_entry_weekday_matrix_loop() {
    let today = fixed_today();
    assert_eq!(today.weekday(), Weekday::Wednesday);

    for (name, on_or_after, strictly_after) in [
        ("monday", date(2026, 7, 20), date(2026, 7, 20)),
        ("tuesday", date(2026, 7, 21), date(2026, 7, 21)),
        ("wednesday", date(2026, 7, 15), date(2026, 7, 22)),
        ("thursday", date(2026, 7, 16), date(2026, 7, 16)),
        ("friday", date(2026, 7, 17), date(2026, 7, 17)),
        ("saturday", date(2026, 7, 18), date(2026, 7, 18)),
        ("sunday", date(2026, 7, 19), date(2026, 7, 19)),
    ] {
        let bare = parse_quick_entry(&format!("T {name}"), today).unwrap();
        assert_eq!(bare.due_date, Some(on_or_after), "bare {name}");
        let next = parse_quick_entry(&format!("T next {name}"), today).unwrap();
        assert_eq!(next.due_date, Some(strictly_after), "next {name}");
    }
}

#[test]
fn quick_entry_priorities_and_invalid_values() {
    let today = fixed_today();
    for level in 1..=4 {
        let parsed = parse_quick_entry(&format!("Task !{level}"), today).unwrap();
        assert_eq!(parsed.priority.unwrap().get(), level);
        let p_form = parse_quick_entry(&format!("Task p{level}"), today).unwrap();
        assert_eq!(p_form.priority.unwrap().get(), level);
        assert_eq!(p_form.title.as_str(), "Task");
        let upper = parse_quick_entry(&format!("Task P{level}"), today).unwrap();
        assert_eq!(upper.priority.unwrap().get(), level);
    }
    // Advertised placeholder form: due date + p-priority stripped from title.
    let dogfood = parse_quick_entry("Dogfood priority today p2", today).unwrap();
    assert_eq!(dogfood.title.as_str(), "Dogfood priority");
    assert_eq!(dogfood.due_date, Some(today));
    assert_eq!(dogfood.priority.unwrap().get(), 2);
    // Embedded / out-of-range p-lookalikes remain title text.
    let kept = parse_quick_entry("review prep1 p5 p10", today).unwrap();
    assert_eq!(kept.title.as_str(), "review prep1 p5 p10");
    assert!(kept.priority.is_none());
    assert!(matches!(
        parse_quick_entry("Task !0", today),
        Err(ValidationError::OutOfRange {
            field: "priority",
            ..
        })
    ));
    assert!(matches!(
        parse_quick_entry("Task dread:0", today),
        Err(ValidationError::OutOfRange { field: "dread", .. })
    ));
    assert!(matches!(
        parse_quick_entry("Task ~", today),
        Err(ValidationError::TooSmall {
            field: "estimated_minutes",
            ..
        })
    ));
    assert!(matches!(
        parse_quick_entry("Task every:dailyy", today),
        Err(ValidationError::InvalidFormat {
            field: "recurrence_rule",
            ..
        })
    ));
}

#[test]
fn quick_entry_duplicate_tags_and_order_independence() {
    let today = fixed_today();
    let a = parse_quick_entry("Title #a #b #a !2 @P ~15", today).unwrap();
    let b = parse_quick_entry("!2 ~15 @P #b Title #a #a", today).unwrap();
    assert_eq!(a.title.as_str(), "Title");
    assert_eq!(b.title.as_str(), "Title");
    assert_eq!(a.priority, b.priority);
    assert_eq!(a.project_name, b.project_name);
    assert_eq!(a.estimated_minutes, b.estimated_minutes);
    assert_eq!(
        a.tag_names.iter().map(|t| t.as_str()).collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    assert_eq!(
        b.tag_names.iter().map(|t| t.as_str()).collect::<Vec<_>>(),
        vec!["b", "a"]
    );
}

#[test]
fn quick_entry_rejects_empty_title_and_size_boundary() {
    let today = fixed_today();
    assert_eq!(
        parse_quick_entry("!1 #tag someday", today),
        Err(ValidationError::EmptyTitle)
    );
    let mut input = "T ".to_owned();
    input.extend(std::iter::repeat_n('字', MAX_QUICK_ENTRY_CHARS));
    assert_eq!(
        parse_quick_entry(&input, today).unwrap_err().field(),
        "input"
    );
}

#[test]
fn text_import_checked_rows_have_intent_only() {
    let drafts = parse_text_import("- [x] Done item\n- [ ] Open item\nplain\n").unwrap();
    assert_eq!(drafts.len(), 3);
    assert!(drafts[0].completed);
    assert!(!drafts[1].completed);
    assert!(!drafts[2].completed);
    assert_eq!(drafts[0].title.as_str(), "Done item");
}

#[test]
fn filter_parser_preserves_project_and_rejects_malformed() {
    let today = fixed_today();
    let query = parse_filter(
        "status:completed project:Roadmap tag:infra due_after:2026-01-01 baguette",
        today,
    )
    .unwrap();
    assert_eq!(query.filter.statuses, vec![TaskStatus::Completed]);
    assert_eq!(
        query.filter.project_name.as_ref().map(|name| name.as_str()),
        Some("Roadmap")
    );
    assert_eq!(query.filter.tag_names[0].as_str(), "infra");
    assert_eq!(query.filter.due_after, Some(date(2026, 1, 1)));
    assert_eq!(query.filter.search.as_deref(), Some("baguette"));
    assert!(query.filter.project_id.is_none());

    assert_eq!(
        parse_filter("due_on:2026-99-01", today)
            .unwrap_err()
            .field(),
        "due_on"
    );
}

#[test]
fn filter_relative_keywords_loop_across_month_boundary() {
    // Near end of month exercises date arithmetic.
    for day in 25..=31 {
        let Ok(today) = Date::new(2026, 1, day) else {
            continue;
        };
        let parsed = parse_filter("today tomorrow week", today).unwrap();
        // last keyword wins for due_on; week clears due_on
        assert_eq!(parsed.filter.due_on, None);
        assert_eq!(parsed.filter.due_after, Some(today));
        use jiff::ToSpan;
        assert_eq!(
            parsed.filter.due_before,
            Some(today.checked_add(6.days()).unwrap())
        );
    }
}

#[test]
fn unicode_across_parsers() {
    let today = fixed_today();
    let entry = parse_quick_entry("写文档 #标签 @项目", today).unwrap();
    assert_eq!(entry.title.as_str(), "写文档");
    assert_eq!(entry.tag_names[0].as_str(), "标签");
    assert_eq!(entry.project_name.unwrap().as_str(), "项目");

    let drafts = parse_text_import("* [ ] café\n").unwrap();
    assert_eq!(drafts[0].title.as_str(), "café");

    let query = parse_filter("проект status:pending", today).unwrap();
    assert_eq!(query.filter.search.as_deref(), Some("проект"));
}
