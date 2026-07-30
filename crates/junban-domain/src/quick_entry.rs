//! Handwritten quick-entry parser for a single task line.
//!
//! # Token vocabulary (Phase 2)
//!
//! Whitespace-separated tokens are scanned left to right. Recognized metadata is
//! removed from the remaining title. Unknown ordinary words stay in the title.
//!
//! | Token | Meaning |
//! | --- | --- |
//! | `today` / `tomorrow` | Civil due date relative to the supplied `today` |
//! | weekday name | Next on-or-after `today` matching that weekday |
//! | `next <weekday>` | Next strictly-after-`today` matching weekday |
//! | `YYYY-MM-DD` | Exact civil due date |
//! | `!1`‥`!4` / `p1`‥`p4` | Priority (case-insensitive; standalone tokens only) |
//! | `#tag` | Tag name (unique, first-seen order) |
//! | `@project` | Project name (last token wins) |
//! | `~N` | Positive estimated minutes |
//! | `dread:N` | Dread level 1–5 |
//! | `someday` | Someday flag |
//! | `deadline:<RFC3339>` | UTC deadline instant |
//! | `every:daily\|weekly\|monthly` | Canonical recurrence rule |
//!
//! # Precedence
//!
//! - Single-value fields keep the **last** successful token.
//! - Tags accumulate uniquely (exact name match).
//! - A recognized key with an invalid value is a field-specific [`ValidationError`].
//! - Token-like text that is not a recognized form remains in the title.
//! - After removal, the remaining title must be non-empty and within title limits.

use std::str::FromStr;

use serde::{Deserialize, Serialize};

use jiff::{
    Timestamp, ToSpan,
    civil::{Date, Weekday},
};

use crate::{
    DreadLevel, EntityName, EstimatedMinutes, Priority, RecurrenceRule, TagName, TaskTitle,
    ValidationError, values::MAX_TAGS_PER_TASK,
};

/// Maximum characters accepted for one quick-entry line.
pub const MAX_QUICK_ENTRY_CHARS: usize = 10_000;

/// Parsed quick-entry fields before catalog ID resolution or persistence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuickEntry {
    pub title: TaskTitle,
    pub due_date: Option<Date>,
    pub priority: Option<Priority>,
    pub project_name: Option<EntityName>,
    pub tag_names: Vec<TagName>,
    pub estimated_minutes: Option<EstimatedMinutes>,
    pub dread: Option<DreadLevel>,
    pub someday: bool,
    pub deadline: Option<Timestamp>,
    pub recurrence_rule: Option<RecurrenceRule>,
}

/// Parse one task line against an explicit civil `today`.
///
/// `today` is only used to resolve relative date tokens. It is never written as a
/// due date unless a relative/absolute date token is present.
pub fn parse_quick_entry(input: &str, today: Date) -> Result<QuickEntry, ValidationError> {
    if input.chars().count() > MAX_QUICK_ENTRY_CHARS {
        return Err(ValidationError::TooLong {
            field: "input",
            max: MAX_QUICK_ENTRY_CHARS,
        });
    }

    let tokens: Vec<&str> = input.split_whitespace().collect();
    let mut title_parts: Vec<&str> = Vec::new();
    let mut due_date = None;
    let mut priority = None;
    let mut project_name = None;
    let mut tag_names: Vec<TagName> = Vec::new();
    let mut estimated_minutes = None;
    let mut dread = None;
    let mut someday = false;
    let mut deadline = None;
    let mut recurrence_rule = None;

    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];

        if let Some(rest) = tokens.get(index + 1).copied()
            && token.eq_ignore_ascii_case("next")
            && let Some(weekday) = parse_weekday(rest)
        {
            due_date = Some(next_weekday_after(today, weekday)?);
            index += 2;
            continue;
        }

        match classify_token(token, today)? {
            TokenEffect::Title => title_parts.push(token),
            TokenEffect::DueDate(date) => due_date = Some(date),
            TokenEffect::Priority(value) => priority = Some(value),
            TokenEffect::Project(name) => project_name = Some(name),
            TokenEffect::Tag(name) => push_unique_tag(&mut tag_names, name)?,
            TokenEffect::Estimated(minutes) => estimated_minutes = Some(minutes),
            TokenEffect::Dread(level) => dread = Some(level),
            TokenEffect::Someday => someday = true,
            TokenEffect::Deadline(ts) => deadline = Some(ts),
            TokenEffect::Recurrence(rule) => recurrence_rule = Some(rule),
        }
        index += 1;
    }

    let title = title_parts.join(" ");
    let title = TaskTitle::new(title)?;

    Ok(QuickEntry {
        title,
        due_date,
        priority,
        project_name,
        tag_names,
        estimated_minutes,
        dread,
        someday,
        deadline,
        recurrence_rule,
    })
}

enum TokenEffect {
    Title,
    DueDate(Date),
    Priority(Priority),
    Project(EntityName),
    Tag(TagName),
    Estimated(EstimatedMinutes),
    Dread(DreadLevel),
    Someday,
    Deadline(Timestamp),
    Recurrence(RecurrenceRule),
}

fn classify_token(token: &str, today: Date) -> Result<TokenEffect, ValidationError> {
    if token.eq_ignore_ascii_case("today") {
        return Ok(TokenEffect::DueDate(today));
    }
    if token.eq_ignore_ascii_case("tomorrow") {
        let date = today.tomorrow().map_err(|_| ValidationError::Invalid {
            field: "due_date",
            reason: "date out of range",
        })?;
        return Ok(TokenEffect::DueDate(date));
    }
    if token.eq_ignore_ascii_case("someday") {
        return Ok(TokenEffect::Someday);
    }
    if let Some(weekday) = parse_weekday(token) {
        return Ok(TokenEffect::DueDate(next_weekday_on_or_after(
            today, weekday,
        )?));
    }
    if looks_like_iso_date(token) {
        let date = Date::from_str(token).map_err(|_| ValidationError::InvalidFormat {
            field: "due_date",
            expected: "YYYY-MM-DD",
        })?;
        return Ok(TokenEffect::DueDate(date));
    }
    if let Some(rest) = token.strip_prefix('!') {
        if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
            // `!` alone or `!foo` is not the priority form; keep in title.
            return Ok(TokenEffect::Title);
        }
        let value = rest
            .parse::<u8>()
            .map_err(|_| ValidationError::OutOfRange {
                field: "priority",
                min: i64::from(Priority::MIN),
                max: i64::from(Priority::MAX),
            })?;
        return Ok(TokenEffect::Priority(Priority::new(value)?));
    }
    // Standalone `p1`‥`p4` / `P1`‥`P4` (legacy quick-entry). Embedded forms like
    // `prep2` or `p10` stay in the title; only exact two-char tokens qualify.
    if let Some(value) = parse_standalone_p_priority(token) {
        return Ok(TokenEffect::Priority(Priority::new(value)?));
    }
    if let Some(rest) = token.strip_prefix('#') {
        if rest.is_empty() {
            return Err(ValidationError::Empty { field: "tag_name" });
        }
        // Bare `#` with junk that cannot be a tag still errors as a recognized key.
        return Ok(TokenEffect::Tag(TagName::new(rest)?));
    }
    if let Some(rest) = token.strip_prefix('@') {
        if rest.is_empty() {
            return Err(ValidationError::Empty {
                field: "project_name",
            });
        }
        let name = EntityName::new(rest).map_err(|err| match err {
            ValidationError::Empty { .. } => ValidationError::Empty {
                field: "project_name",
            },
            ValidationError::TooLong { max, .. } => ValidationError::TooLong {
                field: "project_name",
                max,
            },
            other => other,
        })?;
        return Ok(TokenEffect::Project(name));
    }
    if let Some(rest) = token.strip_prefix('~') {
        if rest.is_empty() {
            return Err(ValidationError::TooSmall {
                field: "estimated_minutes",
                min: 1,
            });
        }
        if !rest.bytes().all(|b| b.is_ascii_digit()) || (rest.len() > 1 && rest.starts_with('0')) {
            return Err(ValidationError::InvalidFormat {
                field: "estimated_minutes",
                expected: "positive integer minutes",
            });
        }
        let value = rest
            .parse::<u32>()
            .map_err(|_| ValidationError::InvalidFormat {
                field: "estimated_minutes",
                expected: "positive integer minutes",
            })?;
        return Ok(TokenEffect::Estimated(EstimatedMinutes::new(value)?));
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(token, "dread:") {
        if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ValidationError::OutOfRange {
                field: "dread",
                min: i64::from(DreadLevel::MIN),
                max: i64::from(DreadLevel::MAX),
            });
        }
        let value = rest
            .parse::<u8>()
            .map_err(|_| ValidationError::OutOfRange {
                field: "dread",
                min: i64::from(DreadLevel::MIN),
                max: i64::from(DreadLevel::MAX),
            })?;
        return Ok(TokenEffect::Dread(DreadLevel::new(value)?));
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(token, "deadline:") {
        if rest.is_empty() {
            return Err(ValidationError::InvalidFormat {
                field: "deadline",
                expected: "RFC3339 timestamp",
            });
        }
        let ts = Timestamp::from_str(rest).map_err(|_| ValidationError::InvalidFormat {
            field: "deadline",
            expected: "RFC3339 timestamp",
        })?;
        return Ok(TokenEffect::Deadline(ts));
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(token, "every:") {
        let canonical = match rest.to_ascii_lowercase().as_str() {
            "daily" | "weekly" | "monthly" => rest,
            _ => {
                return Err(ValidationError::InvalidFormat {
                    field: "recurrence_rule",
                    expected: "every:daily|weekly|monthly",
                });
            }
        };
        let rule = RecurrenceRule::new(canonical)?;
        return Ok(TokenEffect::Recurrence(rule));
    }

    Ok(TokenEffect::Title)
}

/// Accept only exact standalone `p1`‥`p4` (ASCII, case-insensitive).
fn parse_standalone_p_priority(token: &str) -> Option<u8> {
    let bytes = token.as_bytes();
    if bytes.len() != 2 {
        return None;
    }
    if !matches!(bytes[0], b'p' | b'P') {
        return None;
    }
    match bytes[1] {
        b'1'..=b'4' => Some(bytes[1] - b'0'),
        _ => None,
    }
}

fn push_unique_tag(tags: &mut Vec<TagName>, name: TagName) -> Result<(), ValidationError> {
    if tags
        .iter()
        .any(|existing| existing.as_str().to_lowercase() == name.as_str().to_lowercase())
    {
        return Ok(());
    }
    if tags.len() >= MAX_TAGS_PER_TASK {
        return Err(ValidationError::TooMany {
            field: "tag_names",
            count: tags.len() + 1,
            max: MAX_TAGS_PER_TASK,
        });
    }
    tags.push(name);
    Ok(())
}

fn strip_prefix_ignore_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    // Prefixes are ASCII keywords; walk chars so non-ASCII input is never sliced mid-scalar.
    let mut end = 0usize;
    let mut chars = value.char_indices();
    for expected in prefix.chars() {
        let (index, ch) = chars.next()?;
        if !ch.eq_ignore_ascii_case(&expected) {
            return None;
        }
        end = index + ch.len_utf8();
    }
    Some(&value[end..])
}

fn looks_like_iso_date(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

fn parse_weekday(token: &str) -> Option<Weekday> {
    match token.to_ascii_lowercase().as_str() {
        "monday" | "mon" => Some(Weekday::Monday),
        "tuesday" | "tue" | "tues" => Some(Weekday::Tuesday),
        "wednesday" | "wed" => Some(Weekday::Wednesday),
        "thursday" | "thu" | "thur" | "thurs" => Some(Weekday::Thursday),
        "friday" | "fri" => Some(Weekday::Friday),
        "saturday" | "sat" => Some(Weekday::Saturday),
        "sunday" | "sun" => Some(Weekday::Sunday),
        _ => None,
    }
}

fn next_weekday_on_or_after(today: Date, target: Weekday) -> Result<Date, ValidationError> {
    let delta = days_until_weekday(today.weekday(), target, true);
    add_days(today, delta)
}

fn next_weekday_after(today: Date, target: Weekday) -> Result<Date, ValidationError> {
    let delta = days_until_weekday(today.weekday(), target, false);
    add_days(today, delta)
}

fn days_until_weekday(from: Weekday, target: Weekday, allow_today: bool) -> i64 {
    let from = i64::from(from.to_monday_zero_offset());
    let target = i64::from(target.to_monday_zero_offset());
    let mut delta = (target - from).rem_euclid(7);
    if delta == 0 && !allow_today {
        delta = 7;
    }
    delta
}

fn add_days(date: Date, days: i64) -> Result<Date, ValidationError> {
    date.checked_add(days.days())
        .map_err(|_| ValidationError::Invalid {
            field: "due_date",
            reason: "date out of range",
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jiff::civil::date;

    fn today() -> Date {
        date(2026, 3, 11) // Wednesday
    }

    #[test]
    fn parses_core_vocabulary_and_strips_metadata() {
        let parsed = parse_quick_entry(
            "Ship docs !1 #rust @Junban ~45 dread:2 someday deadline:2026-03-12T15:30:00Z every:weekly tomorrow",
            today(),
        )
        .unwrap();
        assert_eq!(parsed.title.as_str(), "Ship docs");
        assert_eq!(parsed.due_date, Some(date(2026, 3, 12)));
        assert_eq!(parsed.priority.unwrap().get(), 1);
        assert_eq!(parsed.project_name.unwrap().as_str(), "Junban");
        assert_eq!(parsed.tag_names.len(), 1);
        assert_eq!(parsed.tag_names[0].as_str(), "rust");
        assert_eq!(parsed.estimated_minutes.unwrap().get(), 45);
        assert_eq!(parsed.dread.unwrap().get(), 2);
        assert!(parsed.someday);
        assert_eq!(parsed.deadline.unwrap().to_string(), "2026-03-12T15:30:00Z");
        assert_eq!(parsed.recurrence_rule.unwrap().as_str(), "weekly");
    }

    #[test]
    fn last_single_value_token_wins_and_tags_dedupe() {
        let parsed = parse_quick_entry("A !1 !3 #a #b #A today tomorrow", today()).unwrap();
        assert_eq!(parsed.priority.unwrap().get(), 3);
        assert_eq!(parsed.due_date, Some(date(2026, 3, 12)));
        assert_eq!(
            parsed
                .tag_names
                .iter()
                .map(TagName::as_str)
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }

    #[test]
    fn weekday_and_next_weekday_are_deterministic() {
        // today is Wednesday 2026-03-11
        let mon = parse_quick_entry("Task monday", today()).unwrap();
        assert_eq!(mon.due_date, Some(date(2026, 3, 16)));
        let wed = parse_quick_entry("Task wednesday", today()).unwrap();
        assert_eq!(wed.due_date, Some(date(2026, 3, 11)));
        let next_wed = parse_quick_entry("Task next wednesday", today()).unwrap();
        assert_eq!(next_wed.due_date, Some(date(2026, 3, 18)));
        let next_mon = parse_quick_entry("Task next monday", today()).unwrap();
        assert_eq!(next_mon.due_date, Some(date(2026, 3, 16)));
    }

    #[test]
    fn invalid_recognized_values_error_and_unknown_tokens_stay() {
        assert_eq!(
            parse_quick_entry("x !5", today()).unwrap_err().field(),
            "priority"
        );
        assert_eq!(
            parse_quick_entry("x dread:9", today()).unwrap_err().field(),
            "dread"
        );
        assert_eq!(
            parse_quick_entry("x ~0", today()).unwrap_err().field(),
            "estimated_minutes"
        );
        assert_eq!(
            parse_quick_entry("x every:yearly", today())
                .unwrap_err()
                .field(),
            "recurrence_rule"
        );
        assert_eq!(
            parse_quick_entry("x deadline:not-a-time", today())
                .unwrap_err()
                .field(),
            "deadline"
        );
        assert_eq!(
            parse_quick_entry("x 2026-13-01", today())
                .unwrap_err()
                .field(),
            "due_date"
        );

        let kept = parse_quick_entry("review !later foo#bar", today()).unwrap();
        assert_eq!(kept.title.as_str(), "review !later foo#bar");
    }

    #[test]
    fn rejects_metadata_only_and_oversized_input() {
        assert_eq!(
            parse_quick_entry("!1 today", today()),
            Err(ValidationError::EmptyTitle)
        );
        let huge = format!("title {}", "x".repeat(MAX_QUICK_ENTRY_CHARS));
        assert_eq!(
            parse_quick_entry(&huge, today()).unwrap_err().field(),
            "input"
        );
    }

    #[test]
    fn order_independence_for_scattered_metadata() {
        let a = parse_quick_entry("Write !2 #x @P ~10", today()).unwrap();
        let b = parse_quick_entry("@P ~10 Write #x !2", today()).unwrap();
        assert_eq!(a.title.as_str(), b.title.as_str());
        assert_eq!(a.priority, b.priority);
        assert_eq!(a.project_name, b.project_name);
        assert_eq!(a.estimated_minutes, b.estimated_minutes);
        assert_eq!(a.tag_names, b.tag_names);
    }

    #[test]
    fn unicode_title_is_preserved() {
        let parsed = parse_quick_entry("整理 タスク !2", today()).unwrap();
        assert_eq!(parsed.title.as_str(), "整理 タスク");
        assert_eq!(parsed.priority.unwrap().get(), 2);
    }

    #[test]
    fn accepts_standalone_p_priority_tokens() {
        for level in 1..=4u8 {
            let lower =
                parse_quick_entry(&format!("Dogfood priority today p{level}"), today()).unwrap();
            assert_eq!(lower.title.as_str(), "Dogfood priority");
            assert_eq!(lower.due_date, Some(today()));
            assert_eq!(lower.priority.unwrap().get(), level);

            let upper = parse_quick_entry(&format!("Ship P{level}"), today()).unwrap();
            assert_eq!(upper.title.as_str(), "Ship");
            assert_eq!(upper.priority.unwrap().get(), level);
        }

        // Last priority token wins across both spellings.
        let mixed = parse_quick_entry("A p1 !3 p2", today()).unwrap();
        assert_eq!(mixed.title.as_str(), "A");
        assert_eq!(mixed.priority.unwrap().get(), 2);
    }

    #[test]
    fn rejects_embedded_and_malformed_p_priority_lookalikes() {
        // Embedded / longer tokens stay in the title (not priority forms).
        let embedded = parse_quick_entry("review prep2 p10 p0 p5", today()).unwrap();
        assert_eq!(embedded.title.as_str(), "review prep2 p10 p0 p5");
        assert!(embedded.priority.is_none());

        // Bang form still validates range; p-form only matches 1–4.
        assert_eq!(
            parse_quick_entry("x !5", today()).unwrap_err().field(),
            "priority"
        );
        let bang = parse_quick_entry("keep !1", today()).unwrap();
        assert_eq!(bang.priority.unwrap().get(), 1);
        assert_eq!(bang.title.as_str(), "keep");
    }
}
