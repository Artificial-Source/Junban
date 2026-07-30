//! Public domain model coverage for values, tasks, catalog entities, and queries.

use jiff::{
    Timestamp,
    civil::{Date, Time},
};
use junban_domain::{
    ActualMinutes, CommentId, DreadLevel, EntityName, EstimatedMinutes, FilterQuery, HexColor,
    IconText, LocalDueTime, MAX_MARKDOWN_CHARS, MAX_QUERY_PAGE_LIMIT, MAX_TAGS_PER_TASK,
    MAX_TASK_TITLE_CHARS, MarkdownText, OperationId, Priority, Project, ProjectId, ProjectView,
    RecurrenceRule, RelationKind, SavedFilter, SavedFilterId, Section, SectionId, SortOrder, Tag,
    TagId, TagName, Task, TaskActivity, TaskActivityAction, TaskDraft, TaskId, TaskQuery,
    TaskRelation, TaskStatus, TaskTitle, TemplateId, TimeZoneName, ValidationError,
};
use proptest::prelude::*;
use uuid::{Uuid, Version};

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
    assert_eq!(
        SectionId::new().as_uuid().get_version(),
        Some(Version::SortRand)
    );
    assert_eq!(
        TemplateId::new().as_uuid().get_version(),
        Some(Version::SortRand)
    );
    assert_eq!(
        CommentId::new().as_uuid().get_version(),
        Some(Version::SortRand)
    );
    assert_eq!(
        SavedFilterId::new().as_uuid().get_version(),
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

    task.cancel(completed);
    assert_eq!(task.status, TaskStatus::Cancelled);
    assert_eq!(task.completed_at, None);

    task.reopen(completed);
    assert_eq!(task.status, TaskStatus::Pending);
}

#[test]
fn phase_one_task_json_deserializes_with_phase_two_defaults() {
    let id = TaskId::new();
    let json = format!(
        r#"{{
            "id":"{id}",
            "title":"Legacy",
            "due_date":null,
            "status":"pending",
            "completed_at":null,
            "created_at":"2026-03-08T01:00:00Z",
            "updated_at":"2026-03-08T01:00:00Z",
            "revision":1
        }}"#
    );
    let task: Task = serde_json::from_str(&json).unwrap();
    assert!(task.description.is_empty());
    assert!(task.tag_ids.is_empty());
    assert!(!task.someday);
    assert_eq!(task.sort_order, SortOrder::default());
}

#[test]
fn instants_round_trip_as_utc_timestamps() {
    let instant: Timestamp = "2026-11-01T06:30:00Z".parse().unwrap();
    let json = serde_json::to_string(&instant).unwrap();
    assert_eq!(serde_json::from_str::<Timestamp>(&json).unwrap(), instant);
    assert!(json.ends_with("Z\""));
}

#[test]
fn markdown_and_priority_bounds() {
    assert!(MarkdownText::new("é".repeat(MAX_MARKDOWN_CHARS)).is_ok());
    assert!(MarkdownText::new("x".repeat(MAX_MARKDOWN_CHARS + 1)).is_err());
    assert!(Priority::new(0).is_err());
    assert!(Priority::new(5).is_err());
    assert_eq!(Priority::new(3).unwrap().get(), 3);
    assert!(DreadLevel::new(0).is_err());
    assert!(DreadLevel::new(6).is_err());
    assert!(EstimatedMinutes::new(0).is_err());
    assert!(EstimatedMinutes::new(15).is_ok());
    assert!(ActualMinutes::new(0).is_ok());
}

#[test]
fn hex_color_and_timezone_validation() {
    assert!(HexColor::new("#3b82f6").is_ok());
    assert!(HexColor::new("#3B82F6").is_ok());
    assert!(HexColor::new("#fff").is_err());
    assert!(HexColor::new("3b82f6").is_err());
    assert!(TimeZoneName::new("UTC").is_ok());
    assert!(TimeZoneName::new("America/New_York").is_ok());
    assert!(TimeZoneName::new("America/Argentina/Buenos_Aires").is_ok());
    assert!(TimeZoneName::new("Etc/GMT+5").is_ok());
    assert!(TimeZoneName::new("").is_err());
    assert!(TimeZoneName::new("Foo").is_err());
    assert!(TimeZoneName::new("/UTC").is_err());
    assert!(TimeZoneName::new("UTC/").is_err());
    assert!(TimeZoneName::new("America/").is_err());
    assert!(TimeZoneName::new("/America/New_York").is_err());
    assert!(TimeZoneName::new("Not a zone").is_err());
    assert!(TimeZoneName::new("America/New York").is_err());
    assert!(TimeZoneName::new("America\\New_York").is_err());
}

#[test]
fn local_due_time_pairs_civil_time_with_zone() {
    let due = LocalDueTime::parse("09:30:00", "Europe/London").unwrap();
    let json = serde_json::to_string(&due).unwrap();
    let back: LocalDueTime = serde_json::from_str(&json).unwrap();
    assert_eq!(back.time, "09:30:00".parse::<Time>().unwrap());
    assert_eq!(back.time_zone.as_str(), "Europe/London");
}

#[test]
fn recurrence_rule_canonicalizes_phase_two_grammar() {
    assert_eq!(RecurrenceRule::new(" Daily ").unwrap().as_str(), "daily");
    assert_eq!(RecurrenceRule::new("WEEKLY").unwrap().as_str(), "weekly");
    assert_eq!(RecurrenceRule::new("monthly").unwrap().as_str(), "monthly");
    assert_eq!(RecurrenceRule::new("yearly").unwrap().as_str(), "yearly");
    assert_eq!(
        RecurrenceRule::new("weekdays").unwrap().as_str(),
        "weekdays"
    );
    assert_eq!(
        RecurrenceRule::new(" every  2   DAYS ").unwrap().as_str(),
        "every 2 days"
    );
    assert_eq!(
        RecurrenceRule::new("EVERY 1 WEEK").unwrap().as_str(),
        "every 1 week"
    );
    assert_eq!(
        RecurrenceRule::new("every 3 weeks").unwrap().as_str(),
        "every 3 weeks"
    );

    assert!(RecurrenceRule::new("").is_err());
    assert!(RecurrenceRule::new("hourly").is_err());
    assert!(RecurrenceRule::new("every 0 days").is_err());
    assert!(RecurrenceRule::new("every -1 day").is_err());
    assert!(RecurrenceRule::new("every 01 days").is_err());
    assert!(RecurrenceRule::new("every two days").is_err());
    assert!(RecurrenceRule::new("every 2 months").is_err());
    assert!(RecurrenceRule::new("RRULE:FREQ=DAILY").is_err());
}

#[test]
fn task_draft_rejects_self_parent_too_many_tags_and_due_time_without_date() {
    let id = TaskId::new();
    let mut draft = TaskDraft::new(TaskTitle::new("T").unwrap());
    draft.parent_id = Some(id);
    let now: Timestamp = "2026-03-08T01:00:00Z".parse().unwrap();
    assert!(Task::from_draft(id, draft, now, 1).is_err());

    let mut draft = TaskDraft::new(TaskTitle::new("T").unwrap());
    draft.tag_ids = (0..=MAX_TAGS_PER_TASK).map(|_| TagId::new()).collect();
    assert!(Task::from_draft(TaskId::new(), draft, now, 1).is_err());

    let mut draft = TaskDraft::new(TaskTitle::new("T").unwrap());
    draft.due_time = Some(LocalDueTime::parse("09:00:00", "UTC").unwrap());
    assert_eq!(
        Task::from_draft(TaskId::new(), draft, now, 1),
        Err(ValidationError::Invalid {
            field: "due_time",
            reason: "due_time requires due_date",
        })
    );

    let mut draft = TaskDraft::new(TaskTitle::new("T").unwrap());
    draft.due_date = Some("2026-03-08".parse().unwrap());
    draft.due_time = Some(LocalDueTime::parse("09:00:00", "UTC").unwrap());
    assert!(Task::from_draft(TaskId::new(), draft, now, 1).is_ok());
}

#[test]
fn catalog_entities_round_trip_with_timestamps() {
    let now: Timestamp = "2026-03-08T01:00:00Z".parse().unwrap();
    let project = Project {
        id: ProjectId::new(),
        name: EntityName::new("Work").unwrap(),
        color: HexColor::new("#3b82f6").unwrap(),
        icon: Some(IconText::new("📁").unwrap()),
        parent_id: None,
        favorite: true,
        archived: false,
        view: ProjectView::Board,
        sort_order: SortOrder::new(2),
        created_at: now,
        updated_at: now,
    };
    let json = serde_json::to_string(&project).unwrap();
    assert_eq!(serde_json::from_str::<Project>(&json).unwrap(), project);

    let section = Section::new(
        SectionId::new(),
        project.id,
        EntityName::new("Inbox").unwrap(),
        now,
    );
    assert_eq!(section.created_at, now);
    assert_eq!(section.updated_at, now);

    let tag = Tag::new(
        TagId::new(),
        TagName::new("focus").unwrap(),
        HexColor::new("#111111").unwrap(),
        now,
    );
    assert_eq!(tag.created_at, now);
    assert_eq!(tag.updated_at, now);

    let filter = SavedFilter::new(
        SavedFilterId::new(),
        EntityName::new("Today").unwrap(),
        FilterQuery::new("due:today").unwrap(),
        now,
    );
    assert!(filter.color.is_none());
    assert_eq!(filter.created_at, now);
    assert_eq!(filter.updated_at, now);
    let filter_json = serde_json::to_value(&filter).unwrap();
    assert!(filter_json.get("color").is_none());

    let relation = TaskRelation::blocks(TaskId::new(), TaskId::new()).unwrap();
    assert_eq!(relation.kind, RelationKind::Blocks);
    assert!(TaskRelation::blocks(relation.from_task_id, relation.from_task_id).is_err());

    let operation_id = OperationId::parse("68be2544-16f2-4d50-905c-e50a10c60820").unwrap();
    let activity = TaskActivity {
        revision: 7,
        sequence: 2,
        operation_id,
        task_id: TaskId::new(),
        action: TaskActivityAction::Updated,
        field: Some("title".into()),
        old_value: Some("old".into()),
        new_value: Some("new".into()),
        created_at: now,
    };
    assert_eq!(activity.revision, 7);
    assert_eq!(activity.sequence, 2);
    assert_eq!(activity.operation_id, operation_id);
    assert_eq!(activity.action, TaskActivityAction::Updated);
    assert_eq!(activity.field.as_deref(), Some("title"));
}

#[test]
fn task_query_shape_serializes_snake_case_and_rejects_bad_limits() {
    let query = TaskQuery::new()
        .with_status(TaskStatus::Pending)
        .with_search("report")
        .with_limit(50)
        .unwrap();
    let json = serde_json::to_value(&query).unwrap();
    assert_eq!(json["filter"]["statuses"][0], "pending");
    assert_eq!(json["filter"]["search"], "report");
    assert_eq!(json["sort"], "sort_order_asc");
    assert_eq!(json["limit"], 50);

    assert!(TaskQuery::new().with_limit(0).is_err());
    assert!(
        TaskQuery::new()
            .with_limit(MAX_QUERY_PAGE_LIMIT + 1)
            .is_err()
    );
    assert!(TaskQuery::new().with_limit(MAX_QUERY_PAGE_LIMIT).is_ok());
    assert_ne!(MAX_QUERY_PAGE_LIMIT, 500);

    let mut oversized = TaskQuery::new();
    oversized.limit = Some(500);
    assert_eq!(
        oversized.validate(),
        Err(ValidationError::OutOfRange {
            field: "limit",
            min: 1,
            max: i64::from(MAX_QUERY_PAGE_LIMIT),
        })
    );
}

#[test]
fn validation_error_exposes_field_for_mapping() {
    assert_eq!(ValidationError::EmptyTitle.field(), "title");
    assert_eq!(
        ValidationError::OutOfRange {
            field: "priority",
            min: 1,
            max: 4
        }
        .field(),
        "priority"
    );
}

proptest! {
    #[test]
    fn multibyte_title_bound_is_character_not_byte(
        prefix in "\\PC{0,20}",
        pad in 0usize..=MAX_TASK_TITLE_CHARS
    ) {
        let mut value = prefix.clone();
        let remaining = MAX_TASK_TITLE_CHARS.saturating_sub(value.chars().count());
        value.extend(std::iter::repeat_n('字', remaining.min(pad)));
        if value.chars().count() == 0 {
            return Ok(());
        }
        if value.chars().count() <= MAX_TASK_TITLE_CHARS {
            prop_assert!(TaskTitle::new(value).is_ok());
        } else {
            prop_assert!(TaskTitle::new(value).is_err());
        }
    }

    #[test]
    fn markdown_bound_counts_unicode_scalars(
        count in 0usize..=(MAX_MARKDOWN_CHARS + 16)
    ) {
        let value = "🙂".repeat(count);
        let result = MarkdownText::new(value);
        if count <= MAX_MARKDOWN_CHARS {
            prop_assert!(result.is_ok());
        } else {
            prop_assert!(result.is_err());
        }
    }

    #[test]
    fn entity_id_parse_rejects_non_uuid(value in "\\PC{0,40}") {
        prop_assume!(Uuid::parse_str(&value).is_err());
        prop_assert!(TaskId::parse(&value).is_err());
        prop_assert!(SectionId::parse(&value).is_err());
    }

    #[test]
    fn civil_time_round_trips(
        hour in 0u8..=23,
        minute in 0u8..=59,
        second in 0u8..=59,
    ) {
        let raw = format!("{hour:02}:{minute:02}:{second:02}");
        let time: Time = raw.parse().unwrap();
        let json = serde_json::to_string(&time).unwrap();
        let back: Time = serde_json::from_str(&json).unwrap();
        prop_assert_eq!(time, back);
    }
}
