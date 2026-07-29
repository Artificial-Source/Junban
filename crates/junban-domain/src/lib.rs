//! Pure task entities, value objects, and validation rules for Junban.
//!
//! This crate deliberately has no knowledge of HTTP, SQLite, or async runtimes.

use std::{fmt, str::FromStr};

use jiff::{Timestamp, civil::Date};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

/// The longest task title accepted by the application.
pub const MAX_TASK_TITLE_CHARS: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ValidationError {
    #[error("{field} must be a UUID")]
    InvalidId { field: &'static str },
    #[error("title must not be empty")]
    EmptyTitle,
    #[error("title must contain at most {max} characters")]
    TitleTooLong { max: usize },
}

macro_rules! entity_id {
    ($name:ident, $field:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }

            pub fn parse(value: &str) -> Result<Self, ValidationError> {
                let uuid = Uuid::parse_str(value)
                    .map_err(|_| ValidationError::InvalidId { field: $field })?;
                Ok(Self(uuid))
            }

            #[must_use]
            pub const fn as_uuid(self) -> Uuid {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }

        impl FromStr for $name {
            type Err = ValidationError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::parse(value)
            }
        }
    };
}

entity_id!(TaskId, "task_id");
entity_id!(ProjectId, "project_id");
entity_id!(TagId, "tag_id");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OperationId(Uuid);

impl OperationId {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        let uuid = Uuid::parse_str(value).map_err(|_| ValidationError::InvalidId {
            field: "operation_id",
        })?;
        Ok(Self(uuid))
    }

    #[must_use]
    pub const fn as_uuid(self) -> Uuid {
        self.0
    }
}

impl fmt::Display for OperationId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for OperationId {
    type Err = ValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: TaskId,
    pub title: TaskTitle,
    pub due_date: Option<Date>,
    pub status: TaskStatus,
    pub completed_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub revision: u64,
}

impl Task {
    #[must_use]
    pub fn new(
        id: TaskId,
        title: TaskTitle,
        due_date: Option<Date>,
        now: Timestamp,
        revision: u64,
    ) -> Self {
        Self {
            id,
            title,
            due_date,
            status: TaskStatus::Pending,
            completed_at: None,
            created_at: now,
            updated_at: now,
            revision,
        }
    }

    pub fn replace(&mut self, title: TaskTitle, due_date: Option<Date>, now: Timestamp) {
        self.title = title;
        self.due_date = due_date;
        self.updated_at = now;
    }

    pub fn complete(&mut self, now: Timestamp) {
        self.status = TaskStatus::Completed;
        self.completed_at = Some(now);
        self.updated_at = now;
    }

    pub fn uncomplete(&mut self, now: Timestamp) {
        self.status = TaskStatus::Pending;
        self.completed_at = None;
        self.updated_at = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Version;

    #[test]
    fn entity_ids_are_version_seven_and_round_trip() {
        let id = TaskId::new();
        assert_eq!(id.as_uuid().get_version(), Some(Version::SortRand));
        assert_eq!(TaskId::parse(&id.to_string()), Ok(id));
        assert!(TaskId::parse("not-a-uuid").is_err());
        assert_eq!(
            ProjectId::new().as_uuid().get_version(),
            Some(Version::SortRand)
        );
        assert_eq!(
            TagId::new().as_uuid().get_version(),
            Some(Version::SortRand)
        );
    }

    #[test]
    fn operation_ids_accept_client_generated_uuids() {
        let raw = Uuid::new_v4().to_string();
        assert_eq!(OperationId::parse(&raw).unwrap().to_string(), raw);
    }

    #[test]
    fn title_is_nonempty_and_character_bounded() {
        assert_eq!(TaskTitle::new(" \n"), Err(ValidationError::EmptyTitle));
        assert!(TaskTitle::new("é".repeat(MAX_TASK_TITLE_CHARS)).is_ok());
        assert_eq!(
            TaskTitle::new("x".repeat(MAX_TASK_TITLE_CHARS + 1)),
            Err(ValidationError::TitleTooLong {
                max: MAX_TASK_TITLE_CHARS
            })
        );
    }

    #[test]
    fn civil_date_serializes_without_a_timezone() {
        let date: Date = "2026-03-08".parse().unwrap();
        assert_eq!(serde_json::to_string(&date).unwrap(), "\"2026-03-08\"");
        assert_eq!(
            serde_json::from_str::<Date>("\"2026-03-08\"").unwrap(),
            date
        );
    }

    #[test]
    fn task_state_transitions_preserve_date_and_clear_completion() {
        let created: Timestamp = "2026-03-08T01:00:00Z".parse().unwrap();
        let completed: Timestamp = "2026-03-08T02:00:00Z".parse().unwrap();
        let due_date: Date = "2026-03-08".parse().unwrap();
        let mut task = Task::new(
            TaskId::new(),
            TaskTitle::new("Write tests").unwrap(),
            Some(due_date),
            created,
            1,
        );

        task.complete(completed);
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.completed_at, Some(completed));
        assert_eq!(task.due_date, Some(due_date));

        task.uncomplete(completed);
        assert_eq!(task.status, TaskStatus::Pending);
        assert_eq!(task.completed_at, None);
    }

    #[test]
    fn instants_round_trip_as_utc_timestamps() {
        let instant: Timestamp = "2026-11-01T06:30:00Z".parse().unwrap();
        let json = serde_json::to_string(&instant).unwrap();
        assert_eq!(serde_json::from_str::<Timestamp>(&json).unwrap(), instant);
        assert!(json.ends_with("Z\""));
    }
}
