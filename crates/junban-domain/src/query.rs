//! Task query shapes and the handwritten saved-filter text parser.
//!
//! # Filter vocabulary (Phase 2)
//!
//! Tokens are whitespace-separated. Recognized clauses become typed filter
//! fields; unknown ordinary words join the residual `search` string.
//!
//! | Clause | Effect |
//! | --- | --- |
//! | `priority:1`‥`4` / `p:1`‥`4` / `!1`‥`!4` | Priority |
//! | `status:pending\|completed\|cancelled` | Status (repeatable) |
//! | `tag:name` / `#name` | Tag **name** (storage resolves IDs) |
//! | `project:name` / `@name` | Project **name** (kept typed; not dropped) |
//! | `overdue` | Overdue flag for storage interpretation |
//! | `today` / `tomorrow` | `due_on` relative to supplied `today` |
//! | `week` | Inclusive due window `today`..=`today+6` |
//! | `due:YYYY-MM-DD` / `due_on:…` | Exact due date |
//! | `due_before:YYYY-MM-DD` | Inclusive upper bound |
//! | `due_after:YYYY-MM-DD` | Inclusive lower bound |
//! | `someday` / `someday:true\|false` | Someday flag |
//!
//! Malformed recognized clauses return a stable field-specific [`ValidationError`].
//! Due range bounds use inclusive civil-date comparisons at the storage boundary.

use std::str::FromStr;

use jiff::{ToSpan, civil::Date};
use serde::{Deserialize, Serialize};

use crate::{
    EntityName, Priority, ProjectId, SectionId, TagName, TaskId, TaskStatus, ValidationError,
    values::{MAX_QUERY_PAGE_LIMIT, MAX_TAGS_PER_TASK},
};

/// Maximum characters accepted for one filter query string.
pub const MAX_FILTER_INPUT_CHARS: usize = 10_000;

/// Stable sort keys for task list pages.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskSort {
    #[default]
    SortOrderAsc,
    CreatedAsc,
    CreatedDesc,
    UpdatedDesc,
    DueAsc,
    DueDesc,
    PriorityAsc,
    TitleAsc,
}

/// Exact built-in task view semantics. Structured filters are applied in addition
/// to the selected preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskViewPreset {
    Inbox,
    Today,
    Upcoming,
    Someday,
    Completed,
    Cancelled,
    Project,
}

/// Opaque pagination cursor that pairs a sort key with a task identity for stability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskCursor {
    /// Serialized sort payload interpreted by storage for the active [`TaskSort`].
    pub sort_value: String,
    pub task_id: TaskId,
}

/// Field-level filter criteria for task views and saved filters.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskFilter {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub statuses: Vec<TaskStatus>,
    /// `None` means any project; `Some(None)` means unprojected (inbox-style).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Option<ProjectId>>,
    /// Unresolved project name from text filters. Storage resolves this to IDs.
    ///
    /// Preserving the name here fixes the legacy bug where project clauses parsed
    /// but never filtered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<EntityName>,
    /// `None` means any section; `Some(None)` means no section.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_id: Option<Option<SectionId>>,
    /// `None` means any parent; `Some(None)` means root tasks only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Option<TaskId>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_ids: Vec<crate::TagId>,
    /// Tag names from text filters; storage resolves to tag IDs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_names: Vec<TagName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    /// Inclusive upper bound: `due_date <= due_before`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_before: Option<Date>,
    /// Inclusive lower bound: `due_date >= due_after`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_after: Option<Date>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_on: Option<Date>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub someday: Option<bool>,
    /// When true, storage selects pending tasks with `due_date < today`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overdue: Option<bool>,
    /// Residual title/description search text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
}

/// Complete list query including filter, order, and cursor pagination.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<TaskViewPreset>,
    #[serde(default)]
    pub filter: TaskFilter,
    #[serde(default)]
    pub sort: TaskSort,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<TaskCursor>,
    /// Page size. Must be in `1..=MAX_QUERY_PAGE_LIMIT` when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// Reject zero or oversized query page limits. Bulk mutation limits are separate.
pub fn validate_page_limit(limit: u32) -> Result<(), ValidationError> {
    if limit == 0 || limit > MAX_QUERY_PAGE_LIMIT {
        return Err(ValidationError::OutOfRange {
            field: "limit",
            min: 1,
            max: i64::from(MAX_QUERY_PAGE_LIMIT),
        });
    }
    Ok(())
}

impl TaskQuery {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_status(mut self, status: TaskStatus) -> Self {
        if !self.filter.statuses.contains(&status) {
            self.filter.statuses.push(status);
        }
        self
    }

    #[must_use]
    pub fn with_search(mut self, search: impl Into<String>) -> Self {
        self.filter.search = Some(search.into());
        self
    }

    pub fn with_limit(mut self, limit: u32) -> Result<Self, ValidationError> {
        validate_page_limit(limit)?;
        self.limit = Some(limit);
        Ok(self)
    }

    /// Validate carried page limits after deserialization or manual construction.
    pub fn validate(&self) -> Result<(), ValidationError> {
        if let Some(limit) = self.limit {
            validate_page_limit(limit)?;
        }
        Ok(())
    }
}

/// Parse a saved-filter / search string into a typed [`TaskQuery`].
///
/// `today` resolves relative date keywords. Project and tag clauses remain as
/// names in the typed filter so storage can resolve them to IDs.
pub fn parse_filter(input: &str, today: Date) -> Result<TaskQuery, ValidationError> {
    if input.chars().count() > MAX_FILTER_INPUT_CHARS {
        return Err(ValidationError::TooLong {
            field: "query",
            max: MAX_FILTER_INPUT_CHARS,
        });
    }

    let mut filter = TaskFilter::default();
    let mut search_parts: Vec<&str> = Vec::new();

    for token in input.split_whitespace() {
        if apply_filter_token(token, today, &mut filter)? {
            continue;
        }
        search_parts.push(token);
    }

    if !search_parts.is_empty() {
        filter.search = Some(search_parts.join(" "));
    }

    Ok(TaskQuery {
        filter,
        ..TaskQuery::default()
    })
}

/// Returns `Ok(true)` when the token was consumed as a filter clause.
fn apply_filter_token(
    token: &str,
    today: Date,
    filter: &mut TaskFilter,
) -> Result<bool, ValidationError> {
    if token.eq_ignore_ascii_case("overdue") {
        filter.overdue = Some(true);
        return Ok(true);
    }
    if token.eq_ignore_ascii_case("today") {
        filter.due_on = Some(today);
        return Ok(true);
    }
    if token.eq_ignore_ascii_case("tomorrow") {
        filter.due_on = Some(today.tomorrow().map_err(|_| ValidationError::Invalid {
            field: "due_on",
            reason: "date out of range",
        })?);
        return Ok(true);
    }
    if token.eq_ignore_ascii_case("week") {
        filter.due_after = Some(today);
        filter.due_before =
            Some(
                today
                    .checked_add(6.days())
                    .map_err(|_| ValidationError::Invalid {
                        field: "due_before",
                        reason: "date out of range",
                    })?,
            );
        // A bare week window is a range, not a single day.
        filter.due_on = None;
        return Ok(true);
    }
    if token.eq_ignore_ascii_case("someday") {
        filter.someday = Some(true);
        return Ok(true);
    }

    if let Some(rest) = token.strip_prefix('!') {
        if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
            return Ok(false);
        }
        filter.priority = Some(parse_priority_value(rest)?);
        return Ok(true);
    }
    if let Some(rest) = token.strip_prefix('#') {
        if rest.is_empty() {
            return Err(ValidationError::Empty { field: "tag_name" });
        }
        push_tag_name(filter, rest)?;
        return Ok(true);
    }
    if let Some(rest) = token.strip_prefix('@') {
        if rest.is_empty() {
            return Err(ValidationError::Empty {
                field: "project_name",
            });
        }
        set_project_name(filter, rest)?;
        return Ok(true);
    }

    if let Some(rest) = strip_prefix_ignore_ascii_case(token, "priority:") {
        filter.priority = Some(parse_priority_value(rest)?);
        return Ok(true);
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(token, "p:") {
        filter.priority = Some(parse_priority_value(rest)?);
        return Ok(true);
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(token, "status:") {
        let status = parse_status_value(rest)?;
        if !filter.statuses.contains(&status) {
            filter.statuses.push(status);
        }
        return Ok(true);
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(token, "tag:") {
        if rest.is_empty() {
            return Err(ValidationError::Empty { field: "tag_name" });
        }
        push_tag_name(filter, rest)?;
        return Ok(true);
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(token, "project:") {
        if rest.is_empty() {
            return Err(ValidationError::Empty {
                field: "project_name",
            });
        }
        set_project_name(filter, rest)?;
        return Ok(true);
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(token, "someday:") {
        filter.someday = Some(parse_bool_value(rest, "someday")?);
        return Ok(true);
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(token, "due_before:") {
        filter.due_before = Some(parse_due_date(rest, "due_before")?);
        return Ok(true);
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(token, "due_after:") {
        filter.due_after = Some(parse_due_date(rest, "due_after")?);
        return Ok(true);
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(token, "due_on:") {
        filter.due_on = Some(parse_due_date(rest, "due_on")?);
        return Ok(true);
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(token, "due:") {
        filter.due_on = Some(parse_due_date(rest, "due_on")?);
        return Ok(true);
    }

    Ok(false)
}

fn parse_priority_value(raw: &str) -> Result<Priority, ValidationError> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ValidationError::OutOfRange {
            field: "priority",
            min: i64::from(Priority::MIN),
            max: i64::from(Priority::MAX),
        });
    }
    let value = raw.parse::<u8>().map_err(|_| ValidationError::OutOfRange {
        field: "priority",
        min: i64::from(Priority::MIN),
        max: i64::from(Priority::MAX),
    })?;
    Priority::new(value)
}

fn parse_status_value(raw: &str) -> Result<TaskStatus, ValidationError> {
    match raw.to_ascii_lowercase().as_str() {
        "pending" => Ok(TaskStatus::Pending),
        "completed" => Ok(TaskStatus::Completed),
        "cancelled" | "canceled" => Ok(TaskStatus::Cancelled),
        _ => Err(ValidationError::InvalidFormat {
            field: "status",
            expected: "pending|completed|cancelled",
        }),
    }
}

fn parse_bool_value(raw: &str, field: &'static str) -> Result<bool, ValidationError> {
    match raw.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" => Ok(true),
        "false" | "0" | "no" => Ok(false),
        _ => Err(ValidationError::InvalidFormat {
            field,
            expected: "true|false",
        }),
    }
}

fn parse_due_date(raw: &str, field: &'static str) -> Result<Date, ValidationError> {
    if raw.is_empty() {
        return Err(ValidationError::InvalidFormat {
            field,
            expected: "YYYY-MM-DD",
        });
    }
    Date::from_str(raw).map_err(|_| ValidationError::InvalidFormat {
        field,
        expected: "YYYY-MM-DD",
    })
}

fn push_tag_name(filter: &mut TaskFilter, raw: &str) -> Result<(), ValidationError> {
    let name = TagName::new(raw)?;
    if filter
        .tag_names
        .iter()
        .any(|existing| existing.as_str().to_lowercase() == name.as_str().to_lowercase())
    {
        return Ok(());
    }
    if filter.tag_names.len() >= MAX_TAGS_PER_TASK {
        return Err(ValidationError::TooMany {
            field: "tag_names",
            count: filter.tag_names.len() + 1,
            max: MAX_TAGS_PER_TASK,
        });
    }
    filter.tag_names.push(name);
    Ok(())
}

fn set_project_name(filter: &mut TaskFilter, raw: &str) -> Result<(), ValidationError> {
    // Keep the validated name typed until storage resolves it to a project ID.
    let name = EntityName::new(raw).map_err(|err| match err {
        ValidationError::Empty { .. } => ValidationError::Empty {
            field: "project_name",
        },
        ValidationError::TooLong { max, .. } => ValidationError::TooLong {
            field: "project_name",
            max,
        },
        other => other,
    })?;
    filter.project_name = Some(name);
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

#[cfg(test)]
mod tests {
    use super::*;
    use jiff::civil::date;

    fn today() -> Date {
        date(2026, 3, 11)
    }

    #[test]
    fn parses_structured_clauses_and_residual_text() {
        let query = parse_filter(
            "report priority:2 status:pending #rust @Junban overdue someday due_before:2026-04-01 notes",
            today(),
        )
        .unwrap();
        let filter = query.filter;
        assert_eq!(filter.priority.unwrap().get(), 2);
        assert_eq!(filter.statuses, vec![TaskStatus::Pending]);
        assert_eq!(filter.tag_names[0].as_str(), "rust");
        assert_eq!(
            filter.project_name.as_ref().map(EntityName::as_str),
            Some("Junban")
        );
        assert_eq!(filter.overdue, Some(true));
        assert_eq!(filter.someday, Some(true));
        assert_eq!(filter.due_before, Some(date(2026, 4, 1)));
        assert_eq!(filter.search.as_deref(), Some("report notes"));
    }

    #[test]
    fn project_clause_is_preserved_for_storage_resolution() {
        let query = parse_filter("project:Workbench inbox", today()).unwrap();
        assert_eq!(
            query.filter.project_name.as_ref().map(EntityName::as_str),
            Some("Workbench")
        );
        assert_eq!(query.filter.search.as_deref(), Some("inbox"));
        // Must not be silently dropped or converted to a missing project_id.
        assert_eq!(query.filter.project_id, None);
    }

    #[test]
    fn relative_dates_and_week_window() {
        let today_q = parse_filter("today", today()).unwrap();
        assert_eq!(today_q.filter.due_on, Some(today()));

        let tomorrow_q = parse_filter("tomorrow", today()).unwrap();
        assert_eq!(tomorrow_q.filter.due_on, Some(date(2026, 3, 12)));

        let week_q = parse_filter("week", today()).unwrap();
        assert_eq!(week_q.filter.due_after, Some(date(2026, 3, 11)));
        assert_eq!(week_q.filter.due_before, Some(date(2026, 3, 17)));
        assert_eq!(week_q.filter.due_on, None);
    }

    #[test]
    fn malformed_recognized_clauses_error() {
        assert_eq!(
            parse_filter("priority:9", today()).unwrap_err().field(),
            "priority"
        );
        assert_eq!(
            parse_filter("status:done", today()).unwrap_err().field(),
            "status"
        );
        assert_eq!(
            parse_filter("due_before:nope", today())
                .unwrap_err()
                .field(),
            "due_before"
        );
        assert_eq!(
            parse_filter("tag:", today()).unwrap_err().field(),
            "tag_name"
        );
        assert_eq!(
            parse_filter("project:", today()).unwrap_err().field(),
            "project_name"
        );
    }

    #[test]
    fn unknown_words_become_search_and_input_is_bounded() {
        let query = parse_filter("alpha beta !1", today()).unwrap();
        assert_eq!(query.filter.search.as_deref(), Some("alpha beta"));
        assert_eq!(query.filter.priority.unwrap().get(), 1);

        let huge = "x".repeat(MAX_FILTER_INPUT_CHARS + 1);
        assert_eq!(parse_filter(&huge, today()).unwrap_err().field(), "query");
    }

    #[test]
    fn unicode_residual_search_is_kept() {
        let query = parse_filter("優先度 high", today()).unwrap();
        assert_eq!(query.filter.search.as_deref(), Some("優先度 high"));
    }
}
