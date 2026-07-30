//! Validated scalar value objects shared across the task and catalog model.

use std::{fmt, str::FromStr};

use jiff::civil::Time;
use serde::{Deserialize, Serialize};

use crate::ValidationError;

/// The longest task title accepted by the application.
pub const MAX_TASK_TITLE_CHARS: usize = 500;
/// Maximum Markdown body length for descriptions and comments.
pub const MAX_MARKDOWN_CHARS: usize = 10_000;
/// Maximum length for project, section, and template names.
pub const MAX_ENTITY_NAME_CHARS: usize = 200;
/// Maximum length for tag names.
pub const MAX_TAG_NAME_CHARS: usize = 100;
/// Maximum length for project icon text (emoji or short glyph).
pub const MAX_ICON_CHARS: usize = 100;
/// Maximum length for a recurrence rule string.
pub const MAX_RECURRENCE_RULE_CHARS: usize = 500;
/// Maximum length for an IANA-style timezone name.
pub const MAX_TIMEZONE_NAME_CHARS: usize = 64;
/// Maximum unique tags on one task.
pub const MAX_TAGS_PER_TASK: usize = 100;
/// Maximum unique IDs accepted by a bulk or reorder operation.
pub const MAX_BULK_IDS: usize = 500;
/// Maximum page size for task list queries (distinct from bulk mutation limits).
pub const MAX_QUERY_PAGE_LIMIT: u32 = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TaskTitle(String);

impl TaskTitle {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(ValidationError::EmptyTitle);
        }
        if value.chars().count() > MAX_TASK_TITLE_CHARS {
            return Err(ValidationError::TitleTooLong {
                max: MAX_TASK_TITLE_CHARS,
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TaskTitle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Markdown text bounded at [`MAX_MARKDOWN_CHARS`]. Empty content is allowed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MarkdownText(String);

impl MarkdownText {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.chars().count() > MAX_MARKDOWN_CHARS {
            return Err(ValidationError::TooLong {
                field: "markdown",
                max: MAX_MARKDOWN_CHARS,
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn empty() -> Self {
        Self(String::new())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Display for MarkdownText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Non-empty Markdown (or plain) comment body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CommentBody(String);

impl CommentBody {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(ValidationError::Empty { field: "content" });
        }
        if value.chars().count() > MAX_MARKDOWN_CHARS {
            return Err(ValidationError::TooLong {
                field: "content",
                max: MAX_MARKDOWN_CHARS,
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CommentBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Project, section, or template display name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EntityName(String);

impl EntityName {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(ValidationError::Empty { field: "name" });
        }
        if value.chars().count() > MAX_ENTITY_NAME_CHARS {
            return Err(ValidationError::TooLong {
                field: "name",
                max: MAX_ENTITY_NAME_CHARS,
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for EntityName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Tag label, bounded tighter than entity names.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TagName(String);

impl TagName {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(ValidationError::Empty { field: "tag_name" });
        }
        if trimmed.chars().count() > MAX_TAG_NAME_CHARS {
            return Err(ValidationError::TooLong {
                field: "tag_name",
                max: MAX_TAG_NAME_CHARS,
            });
        }
        Ok(Self(trimmed.to_owned()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TagName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Task priority P1 (highest) through P4 (lowest).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Priority(u8);

impl Priority {
    pub const MIN: u8 = 1;
    pub const MAX: u8 = 4;

    pub fn new(value: u8) -> Result<Self, ValidationError> {
        if !(Self::MIN..=Self::MAX).contains(&value) {
            return Err(ValidationError::OutOfRange {
                field: "priority",
                min: i64::from(Self::MIN),
                max: i64::from(Self::MAX),
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u8 {
        self.0
    }
}

/// Subjective dread level from 1 (lowest) to 5 (highest).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DreadLevel(u8);

impl DreadLevel {
    pub const MIN: u8 = 1;
    pub const MAX: u8 = 5;

    pub fn new(value: u8) -> Result<Self, ValidationError> {
        if !(Self::MIN..=Self::MAX).contains(&value) {
            return Err(ValidationError::OutOfRange {
                field: "dread",
                min: i64::from(Self::MIN),
                max: i64::from(Self::MAX),
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u8 {
        self.0
    }
}

/// Positive estimated effort in whole minutes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EstimatedMinutes(u32);

impl EstimatedMinutes {
    pub fn new(value: u32) -> Result<Self, ValidationError> {
        if value < 1 {
            return Err(ValidationError::TooSmall {
                field: "estimated_minutes",
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

/// Non-negative actual effort in whole minutes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ActualMinutes(u32);

impl ActualMinutes {
    pub fn new(value: u32) -> Result<Self, ValidationError> {
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// Stable sibling ordering key.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct SortOrder(i64);

impl SortOrder {
    #[must_use]
    pub const fn new(value: i64) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }
}

/// Strict `#RRGGBB` color.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HexColor(String);

impl HexColor {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if !is_strict_hex_color(&value) {
            return Err(ValidationError::InvalidFormat {
                field: "color",
                expected: "#RRGGBB",
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for HexColor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

fn is_strict_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 7 || bytes[0] != b'#' {
        return false;
    }
    bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
}

/// Short icon glyph or emoji text for projects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct IconText(String);

impl IconText {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.is_empty() {
            return Err(ValidationError::Empty { field: "icon" });
        }
        if value.chars().count() > MAX_ICON_CHARS {
            return Err(ValidationError::TooLong {
                field: "icon",
                max: MAX_ICON_CHARS,
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for IconText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Opaque recurrence rule string in the canonical grammar.
///
/// Accepted forms: `daily`, `weekly`, `monthly`, `yearly`, `weekdays`, or
/// `every N day(s)|week(s)`. Occurrence generation lives in [`crate::recurrence`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RecurrenceRule(String);

impl RecurrenceRule {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        let normalized = normalize_ascii_ws_case(value.trim());
        if normalized.is_empty() {
            return Err(ValidationError::Empty {
                field: "recurrence_rule",
            });
        }
        if normalized.chars().count() > MAX_RECURRENCE_RULE_CHARS {
            return Err(ValidationError::TooLong {
                field: "recurrence_rule",
                max: MAX_RECURRENCE_RULE_CHARS,
            });
        }
        let canonical = canonicalize_recurrence_rule(&normalized)?;
        Ok(Self(canonical))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn normalize_ascii_ws_case(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut prev_space = false;
    for ch in value.chars() {
        if ch.is_ascii_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
                prev_space = true;
            }
        } else {
            prev_space = false;
            out.push(ch.to_ascii_lowercase());
        }
    }
    out
}

fn canonicalize_recurrence_rule(normalized: &str) -> Result<String, ValidationError> {
    match normalized {
        "daily" | "weekly" | "monthly" | "yearly" | "weekdays" => Ok(normalized.to_owned()),
        other => canonicalize_every_rule(other),
    }
}

fn canonicalize_every_rule(value: &str) -> Result<String, ValidationError> {
    let invalid = || ValidationError::InvalidFormat {
        field: "recurrence_rule",
        expected: "daily|weekly|monthly|yearly|weekdays|every N day(s)|week(s)",
    };
    let mut parts = value.split(' ');
    let Some("every") = parts.next() else {
        return Err(invalid());
    };
    let Some(count_raw) = parts.next() else {
        return Err(invalid());
    };
    let Some(unit_raw) = parts.next() else {
        return Err(invalid());
    };
    if parts.next().is_some() {
        return Err(invalid());
    }
    // Reject signs, leading zeros, and non-decimal forms; require a plain positive u32.
    if count_raw.is_empty()
        || !count_raw.bytes().all(|byte| byte.is_ascii_digit())
        || (count_raw.len() > 1 && count_raw.starts_with('0'))
    {
        return Err(invalid());
    }
    let count = count_raw.parse::<u32>().map_err(|_| invalid())?;
    if count < 1 {
        return Err(ValidationError::TooSmall {
            field: "recurrence_rule",
            min: 1,
        });
    }
    let unit = match unit_raw {
        "day" | "days" => {
            if count == 1 {
                "day"
            } else {
                "days"
            }
        }
        "week" | "weeks" => {
            if count == 1 {
                "week"
            } else {
                "weeks"
            }
        }
        _ => return Err(invalid()),
    };
    Ok(format!("every {count} {unit}"))
}

impl fmt::Display for RecurrenceRule {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Syntactically validated IANA-style timezone name without loading a tz database.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TimeZoneName(String);

impl TimeZoneName {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if !is_plausible_iana_time_zone(&value) {
            return Err(ValidationError::InvalidFormat {
                field: "time_zone",
                expected: "IANA timezone name",
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TimeZoneName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

fn is_plausible_iana_time_zone(value: &str) -> bool {
    if value.is_empty() || value.chars().count() > MAX_TIMEZONE_NAME_CHARS {
        return false;
    }
    // Accept explicit UTC, or multi-segment names like "America/New_York" / "Etc/GMT+5".
    if value == "UTC" {
        return true;
    }
    let mut segments = 0usize;
    for segment in value.split('/') {
        segments += 1;
        if segment.is_empty() || segments > 3 {
            return false;
        }
        let mut chars = segment.chars();
        let Some(first) = chars.next() else {
            return false;
        };
        if !first.is_ascii_alphabetic() {
            return false;
        }
        if !chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '+' | '-' | '.')) {
            return false;
        }
    }
    // Non-UTC identifiers must have at least two nonempty slash-separated segments.
    segments >= 2
}

/// Local wall-clock time paired with a timezone name. Civil time is never shifted here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalDueTime {
    pub time: Time,
    pub time_zone: TimeZoneName,
}

impl LocalDueTime {
    pub fn new(time: Time, time_zone: TimeZoneName) -> Self {
        Self { time, time_zone }
    }

    pub fn parse(time: &str, time_zone: &str) -> Result<Self, ValidationError> {
        let time = Time::from_str(time).map_err(|_| ValidationError::InvalidFormat {
            field: "due_time",
            expected: "HH:MM[:SS]",
        })?;
        let time_zone = TimeZoneName::new(time_zone)?;
        Ok(Self { time, time_zone })
    }
}

/// How a project presents its tasks. Calendar is stored for continuity; Phase 3 owns behavior.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectView {
    #[default]
    List,
    Board,
    Calendar,
}

/// Directed relation kind. Only `blocks` ships in Phase 2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    Blocks,
}

/// Opaque saved-filter query text. Use [`crate::parse_filter`] to obtain a typed query.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FilterQuery(String);

impl FilterQuery {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.chars().count() > MAX_MARKDOWN_CHARS {
            return Err(ValidationError::TooLong {
                field: "query",
                max: MAX_MARKDOWN_CHARS,
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for FilterQuery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}
