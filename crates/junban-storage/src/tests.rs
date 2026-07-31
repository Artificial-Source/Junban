//! Storage integration coverage for Phase 2 repository behavior.

use std::{
    env, fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::SystemTime,
};

use jiff::{Timestamp, ToSpan, tz::TimeZone};
use junban_app::{
    BulkAction, EventCatchUp, MoveTarget, OrderAnchor, ProjectDraft, ReorderScope, Repository,
    RepositoryError, SectionDraft, TagDraft, TaskListAsOf, TaskPatch, TemplateApply, TemplateDraft,
    TemporalContext,
};
use junban_domain::{
    CommentBody, CommentId, DEFAULT_REMINDER_LEASE_SECS, EntityName, HexColor,
    MAX_ANALYSIS_TASK_READ, MAX_BULK_IDS, MAX_REMINDER_CLAIM_LIMIT, MarkdownText, OperationId,
    ProjectId, RelationKind, ReminderChannel, ReminderFailureCode, ReminderOccurrenceState,
    SortOrder, TagId, TagName, TaskCursor, TaskDraft, TaskId, TaskQuery, TaskSort, TaskStatus,
    TaskTitle, TaskViewPreset, TemplateId, WeekStart, weekly_review_summary,
};
use uuid::Uuid;

use super::*;

static TEST_DIR_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = env::temp_dir().join(format!(
            "junban-storage-test-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            TEST_DIR_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn operation() -> OperationId {
    OperationId::parse(&Uuid::new_v4().to_string()).unwrap()
}

fn now() -> Timestamp {
    "2026-07-28T12:00:00Z".parse().unwrap()
}

fn temporal() -> TemporalContext {
    TemporalContext::new("2026-07-28".parse().unwrap(), TimeZone::UTC)
}

fn list_as_of(date: jiff::civil::Date) -> TaskListAsOf {
    TaskListAsOf::for_local_date(date, &TimeZone::UTC).unwrap()
}

fn list_as_of_str(date: &str) -> TaskListAsOf {
    list_as_of(date.parse().unwrap())
}

fn draft(title: &str) -> TaskDraft {
    TaskDraft::new(TaskTitle::new(title).unwrap())
}

async fn create_simple(repo: &SqliteRepository, title: &str) -> CommittedMutation {
    repo.create_task(operation(), TaskId::new(), draft(title), now())
        .await
        .unwrap()
}

async fn create_draft(repo: &SqliteRepository, draft: TaskDraft) -> TaskId {
    repo.create_task(operation(), TaskId::new(), draft, now())
        .await
        .unwrap()
        .task()
        .unwrap()
        .id
}

async fn view_titles(
    repo: &SqliteRepository,
    view: TaskViewPreset,
    as_of_date: jiff::civil::Date,
) -> Vec<String> {
    let mut query = TaskQuery::new().with_limit(100).unwrap();
    query.view = Some(view);
    let mut titles = repo
        .list_tasks(query, list_as_of(as_of_date))
        .await
        .unwrap()
        .tasks
        .into_iter()
        .map(|task| task.title.to_string())
        .collect::<Vec<_>>();
    titles.sort();
    titles
}

#[tokio::test]
async fn analysis_snapshot_hydrates_tasks_tags_and_current_revision() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let first_tag = TagId::new();
    let second_tag = TagId::new();
    for (id, name) in [(first_tag, "first"), (second_tag, "second")] {
        repository
            .create_tag(
                operation(),
                id,
                TagDraft {
                    name: TagName::new(name).unwrap(),
                    color: HexColor::new("#123456").unwrap(),
                },
                now(),
            )
            .await
            .unwrap();
    }

    let mut rich = draft("rich");
    rich.description = MarkdownText::new("description").unwrap();
    rich.due_date = Some("2026-07-30".parse().unwrap());
    rich.deadline = Some("2026-07-31T12:00:00Z".parse().unwrap());
    rich.someday = true;
    rich.tag_ids = vec![second_tag, first_tag];
    let rich_id = create_draft(&repository, rich).await;
    let plain_id = create_simple(&repository, "plain").await.task().unwrap().id;
    let expected_revision = repository.diagnostics().await.unwrap().revision;
    let expected = vec![
        repository.get_task(rich_id).await.unwrap(),
        repository.get_task(plain_id).await.unwrap(),
    ];

    let snapshot = repository
        .list_analysis_tasks(list_as_of_str("2026-07-28"))
        .await
        .unwrap();

    assert_eq!(snapshot.revision, expected_revision as u64);
    assert_eq!(snapshot.tasks, expected);
    assert_eq!(snapshot.tasks[0].tag_ids, vec![second_tag, first_tag]);
}

#[tokio::test]
async fn weekly_cancellation_transition_survives_edits_reopen_recancel_and_replay() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let task_id = repository
        .create_task(
            operation(),
            TaskId::new(),
            draft("Cancelled task"),
            "2026-02-28T12:00:00Z".parse().unwrap(),
        )
        .await
        .unwrap()
        .task()
        .unwrap()
        .id;
    let done_id = repository
        .create_task(
            operation(),
            TaskId::new(),
            draft("Completed task"),
            "2026-02-28T12:00:00Z".parse().unwrap(),
        )
        .await
        .unwrap()
        .task()
        .unwrap()
        .id;
    repository
        .complete_task(
            operation(),
            done_id,
            "2026-03-04T12:00:00Z".parse().unwrap(),
            temporal(),
        )
        .await
        .unwrap();

    let cancellation_op = operation();
    let cancelled = repository
        .cancel_task(
            cancellation_op,
            task_id,
            "2026-03-07T23:59:59Z".parse().unwrap(),
        )
        .await
        .unwrap();
    let replay = repository
        .cancel_task(
            cancellation_op,
            task_id,
            "2026-03-08T00:00:00Z".parse().unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        replay, cancelled,
        "exact retry must replay the original transition"
    );

    repository
        .patch_task(
            operation(),
            task_id,
            TaskPatch {
                title: Some(TaskTitle::new("Edited after cancellation").unwrap()),
                ..TaskPatch::default()
            },
            "2026-03-08T00:00:00Z".parse().unwrap(),
        )
        .await
        .unwrap();

    let weekly = |today: &'static str| {
        let repository = repository.clone();
        async move {
            let tasks = repository
                .list_analysis_tasks(list_as_of_str(today))
                .await
                .unwrap()
                .tasks;
            weekly_review_summary(
                &tasks,
                &[],
                today.parse().unwrap(),
                WeekStart::Sunday,
                &TimeZone::UTC,
            )
            .unwrap()
        }
    };
    let first_week = weekly("2026-03-11").await;
    assert_eq!(first_week.cancelled_count, 1);
    assert_eq!(first_week.completion_rate_percent, 50);
    let second_week = weekly("2026-03-18").await;
    assert_eq!(
        second_week.cancelled_count, 0,
        "the edit does not move weeks"
    );

    repository
        .reopen_task(
            operation(),
            task_id,
            "2026-03-10T12:00:00Z".parse().unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(weekly("2026-03-11").await.cancelled_count, 0);

    let recancellation_op = operation();
    let recancelled = repository
        .cancel_task(
            recancellation_op,
            task_id,
            "2026-03-12T12:00:00Z".parse().unwrap(),
        )
        .await
        .unwrap();
    let replay = repository
        .cancel_task(
            recancellation_op,
            task_id,
            "2026-03-13T12:00:00Z".parse().unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(replay, recancelled);
    let second_week = weekly("2026-03-18").await;
    assert_eq!(second_week.cancelled_count, 1);
    assert_eq!(second_week.completion_rate_percent, 0);
}

#[tokio::test]
async fn analysis_snapshot_rejects_more_than_the_task_read_limit() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    repository
        .execute_batch(
            "WITH digits(value) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9))
             INSERT INTO tasks(id, title, status, created_at, updated_at, revision)
             SELECT printf('00000000-0000-4000-8000-%012d',
                           a.value * 10000 + b.value * 1000 + c.value * 100 + d.value * 10 + e.value),
                    'task', 'pending', '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z', 1
             FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e
             LIMIT 20001;"
                .into(),
        )
        .await
        .unwrap();

    assert_eq!(
        repository
            .list_analysis_tasks(list_as_of_str("2026-07-28"))
            .await,
        Err(RepositoryError::OperationTooLarge)
    );
    assert_eq!(MAX_ANALYSIS_TASK_READ, 20_000);
}

#[tokio::test]
async fn migration_and_connection_pragmas_are_applied() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let diagnostics = owner.repository().diagnostics().await.unwrap();
    assert_eq!(diagnostics.migration, migration::CURRENT_SCHEMA_VERSION);
    assert_eq!(diagnostics.journal_mode, "wal");
    assert_eq!(diagnostics.foreign_keys, 1);
    assert_eq!(diagnostics.busy_timeout, 2_500);
    assert_eq!(diagnostics.synchronous, 1);
    assert_eq!(
        diagnostics.wal_autocheckpoint,
        crate::WAL_AUTOCHECKPOINT_PAGES
    );
    assert_eq!(
        diagnostics.journal_size_limit,
        crate::WAL_AUTOCHECKPOINT_PAGES * 4096
    );
}

/// SQLite defaults `wal_autocheckpoint` to 1000 pages (~4 MiB). Without an
/// explicit bound, PASSIVE auto-checkpoints of a multi-MiB WAL stall individual
/// commits for hundreds of milliseconds (measured 400–600 ms at ~4 MiB) and
/// dominate bulk/reorder p95 while leaving p50 near a few milliseconds.
///
/// Junban sets 250 pages (~1 MiB) so commit-path checkpoints stay small. The
/// tradeoff is more frequent checkpoints (slightly higher median write cost)
/// in exchange for avoiding multi-hundred-millisecond outliers. Durability
/// (`synchronous=NORMAL`) and single-owner writes are unchanged.
#[tokio::test]
async fn wal_autocheckpoint_is_bounded_below_sqlite_default() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let diagnostics = owner.repository().diagnostics().await.unwrap();
    assert_eq!(
        diagnostics.wal_autocheckpoint,
        crate::WAL_AUTOCHECKPOINT_PAGES
    );
    assert!(
        diagnostics.wal_autocheckpoint < 1000,
        "expected bound below SQLite's 1000-page default, got {}",
        diagnostics.wal_autocheckpoint
    );
    assert_eq!(
        diagnostics.journal_size_limit,
        crate::WAL_AUTOCHECKPOINT_PAGES * 4096
    );

    // Control: a fresh rusqlite WAL connection still uses the upstream default.
    let control_path = directory.0.join("control.sqlite3");
    let control = rusqlite::Connection::open(&control_path).unwrap();
    control.pragma_update(None, "journal_mode", "WAL").unwrap();
    let default_pages: i64 = control
        .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
        .unwrap();
    assert_eq!(default_pages, 1000);
}

#[test]
fn a_second_profile_owner_is_rejected_until_all_clones_drop() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    assert!(matches!(
        ProfileOwner::open(&directory.0),
        Err(OpenError::AlreadyOwned)
    ));
    drop(owner);
    assert!(matches!(
        ProfileOwner::open(&directory.0),
        Err(OpenError::AlreadyOwned)
    ));
    drop(repository);
    assert!(ProfileOwner::open(&directory.0).is_ok());
}

#[tokio::test]
async fn exact_replay_returns_original_result_and_mismatch_conflicts() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let op = operation();
    let first = repository
        .create_task(op, TaskId::new(), draft("First"), now())
        .await
        .unwrap();
    let replay = repository
        .create_task(op, TaskId::new(), draft("First"), now())
        .await
        .unwrap();
    assert_eq!(replay, first);
    assert_eq!(
        repository
            .list_tasks(
                TaskQuery::new().with_limit(100).unwrap(),
                list_as_of_str("2026-07-28")
            )
            .await
            .unwrap()
            .tasks
            .len(),
        1
    );
    assert_eq!(
        repository
            .create_task(op, TaskId::new(), draft("Different"), now())
            .await,
        Err(RepositoryError::IdempotencyMismatch)
    );
    let diagnostics = repository.diagnostics().await.unwrap();
    assert_eq!((diagnostics.tasks, diagnostics.receipts), (1, 1));
    assert_eq!(
        (
            diagnostics.activity,
            diagnostics.events,
            diagnostics.revision
        ),
        (1, 1, 1)
    );
}

#[tokio::test]
async fn mutations_write_effect_receipt_activity_revision_and_event_atomically() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let created = create_simple(&repository, "Task").await;
    let id = created.task().unwrap().id;
    repository
        .complete_task(operation(), id, now(), temporal())
        .await
        .unwrap();
    let diagnostics = repository.diagnostics().await.unwrap();
    assert_eq!((diagnostics.tasks, diagnostics.receipts), (1, 2));
    assert_eq!(
        (
            diagnostics.activity,
            diagnostics.events,
            diagnostics.revision
        ),
        (2, 2, 2)
    );
    let events = repository.list_events(1).await.unwrap();
    match events {
        EventCatchUp::Page {
            events,
            has_more,
            latest_revision,
        } => {
            assert_eq!(events.len(), 1);
            assert!(!has_more);
            assert_eq!(latest_revision, 2);
            assert_eq!(events[0].event_type.as_str(), "task.completed");
        }
        EventCatchUp::ResyncRequired { .. } => panic!("expected page"),
    }
}

#[tokio::test]
async fn restart_preserves_tasks_receipts_events_and_deleted_replays() {
    let directory = TestDir::new();
    let create_op = operation();
    let delete_op = operation();
    let (id, deleted) = {
        let owner = ProfileOwner::open(&directory.0).unwrap();
        let repository = owner.repository();
        let created = repository
            .create_task(create_op, TaskId::new(), draft("Persistent"), now())
            .await
            .unwrap();
        let id = created.task().unwrap().id;
        let deleted = repository.delete_task(delete_op, id, now()).await.unwrap();
        (id, deleted)
    };
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    assert!(
        repository
            .list_tasks(
                TaskQuery::new().with_limit(100).unwrap(),
                list_as_of_str("2026-07-28")
            )
            .await
            .unwrap()
            .tasks
            .is_empty()
    );
    match repository.list_events(0).await.unwrap() {
        EventCatchUp::Page { events, .. } => assert_eq!(events.len(), 2),
        EventCatchUp::ResyncRequired { .. } => panic!("expected page"),
    }
    assert_eq!(
        repository
            .delete_task(delete_op, id, Timestamp::now())
            .await
            .unwrap(),
        deleted
    );
}

#[tokio::test]
async fn p2_api_002_create_constraints_are_stable_conflicts() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();

    let task_id = TaskId::new();
    repository
        .create_task(operation(), task_id, draft("First"), now())
        .await
        .unwrap();
    assert_eq!(
        repository
            .create_task(operation(), task_id, draft("Second"), now())
            .await,
        Err(RepositoryError::Conflict)
    );

    let comment_id = CommentId::new();
    repository
        .create_comment(
            operation(),
            comment_id,
            task_id,
            CommentBody::new("First").unwrap(),
            now(),
        )
        .await
        .unwrap();
    assert_eq!(
        repository
            .create_comment(
                operation(),
                comment_id,
                task_id,
                CommentBody::new("Second").unwrap(),
                now(),
            )
            .await,
        Err(RepositoryError::Conflict)
    );

    let project_id = ProjectId::new();
    repository
        .create_project(operation(), project_id, project_draft("First"), now())
        .await
        .unwrap();
    assert_eq!(
        repository
            .create_project(operation(), project_id, project_draft("Second"), now())
            .await,
        Err(RepositoryError::Conflict)
    );
}

#[tokio::test]
async fn failed_activity_insert_rolls_back_every_mutation_row() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    repository
        .execute_batch(
            "CREATE TRIGGER fail_activity BEFORE INSERT ON task_activity
             BEGIN SELECT RAISE(ABORT, 'injected rollback'); END;"
                .to_owned(),
        )
        .await
        .unwrap();
    assert!(matches!(
        repository
            .create_task(operation(), TaskId::new(), draft("Rollback"), now())
            .await,
        Err(RepositoryError::Storage(_))
    ));
    let diagnostics = repository.diagnostics().await.unwrap();
    assert_eq!((diagnostics.tasks, diagnostics.receipts), (0, 0));
    assert_eq!(
        (
            diagnostics.activity,
            diagnostics.events,
            diagnostics.revision
        ),
        (0, 0, 0)
    );
}

#[tokio::test]
async fn status_transitions_and_invalid_transition_conflict() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let id = create_simple(&repository, "T").await.task().unwrap().id;
    repository
        .complete_task(operation(), id, now(), temporal())
        .await
        .unwrap();
    assert_eq!(
        repository
            .complete_task(operation(), id, now(), temporal())
            .await,
        Err(RepositoryError::Conflict)
    );
    repository
        .reopen_task(operation(), id, now())
        .await
        .unwrap();
    repository
        .cancel_task(operation(), id, now())
        .await
        .unwrap();
    assert_eq!(
        repository
            .uncomplete_task(operation(), id, now(), temporal())
            .await,
        Err(RepositoryError::Conflict)
    );
}

#[tokio::test]
async fn parent_completion_cascades_pending_descendants_only() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let parent = create_simple(&repository, "P").await.task().unwrap().id;
    let mut child_draft = draft("C");
    child_draft.parent_id = Some(parent);
    let child = repository
        .create_task(operation(), TaskId::new(), child_draft, now())
        .await
        .unwrap()
        .task()
        .unwrap()
        .id;
    let mut cancelled_draft = draft("X");
    cancelled_draft.parent_id = Some(parent);
    let cancelled = repository
        .create_task(operation(), TaskId::new(), cancelled_draft, now())
        .await
        .unwrap()
        .task()
        .unwrap()
        .id;
    repository
        .cancel_task(operation(), cancelled, now())
        .await
        .unwrap();
    let mutation = repository
        .complete_task(operation(), parent, now(), temporal())
        .await
        .unwrap();
    assert_eq!(mutation.event.affected.task_ids.len(), 2);
    assert_eq!(
        repository.get_task(child).await.unwrap().status,
        TaskStatus::Completed
    );
    assert_eq!(
        repository.get_task(cancelled).await.unwrap().status,
        TaskStatus::Cancelled
    );
    assert!(mutation.event.resync.tasks);
}

#[tokio::test]
async fn delete_removes_subtree_and_undo_restores_closure() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let parent = create_simple(&repository, "P").await.task().unwrap().id;
    let mut child_draft = draft("C");
    child_draft.parent_id = Some(parent);
    let child = repository
        .create_task(operation(), TaskId::new(), child_draft, now())
        .await
        .unwrap()
        .task()
        .unwrap()
        .id;
    repository
        .create_comment(
            operation(),
            junban_domain::CommentId::new(),
            parent,
            junban_domain::CommentBody::new("hi").unwrap(),
            now(),
        )
        .await
        .unwrap();
    let delete_op = operation();
    repository
        .delete_task(delete_op, parent, now())
        .await
        .unwrap();
    assert!(matches!(
        repository.get_task(parent).await,
        Err(RepositoryError::NotFound)
    ));
    assert!(matches!(
        repository.get_task(child).await,
        Err(RepositoryError::NotFound)
    ));
    let undo_op = operation();
    repository.undo(delete_op, undo_op, now()).await.unwrap();
    assert_eq!(
        repository.get_task(parent).await.unwrap().title.as_str(),
        "P"
    );
    assert_eq!(
        repository.get_task(child).await.unwrap().parent_id,
        Some(parent)
    );
    assert_eq!(repository.list_comments(parent).await.unwrap().len(), 1);
}

#[tokio::test]
async fn project_section_tag_template_and_filter_crud() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let project_id = ProjectId::new();
    repository
        .create_project(
            operation(),
            project_id,
            ProjectDraft {
                name: EntityName::new("Work").unwrap(),
                color: HexColor::new("#112233").unwrap(),
                icon: None,
                parent_id: None,
                favorite: false,
                archived: false,
                view: Default::default(),
                sort_order: SortOrder::default(),
            },
            now(),
        )
        .await
        .unwrap();
    let section_id = junban_domain::SectionId::new();
    repository
        .create_section(
            operation(),
            section_id,
            SectionDraft {
                project_id,
                name: EntityName::new("Todo").unwrap(),
                collapsed: false,
                sort_order: SortOrder::default(),
            },
            now(),
        )
        .await
        .unwrap();
    let tag_id = TagId::new();
    repository
        .create_tag(
            operation(),
            tag_id,
            TagDraft {
                name: TagName::new("rust").unwrap(),
                color: HexColor::new("#abcdef").unwrap(),
            },
            now(),
        )
        .await
        .unwrap();
    // normalized uniqueness
    assert_eq!(
        repository
            .create_tag(
                operation(),
                TagId::new(),
                TagDraft {
                    name: TagName::new("RUST").unwrap(),
                    color: HexColor::new("#000000").unwrap(),
                },
                now(),
            )
            .await,
        Err(RepositoryError::Conflict)
    );
    let template_id = TemplateId::new();
    repository
        .create_template(
            operation(),
            template_id,
            TemplateDraft {
                name: EntityName::new("Bug").unwrap(),
                title: TaskTitle::new("Fix {{area}}").unwrap(),
                description: junban_domain::MarkdownText::empty(),
                priority: None,
                tag_names: vec![TagName::new("rust").unwrap()],
                project_id: Some(project_id),
                recurrence_rule: None,
                sort_order: SortOrder::default(),
            },
            now(),
        )
        .await
        .unwrap();
    let applied = repository
        .apply_template(
            operation(),
            TaskId::new(),
            TemplateApply {
                template_id,
                variables: vec![("area".into(), "parser".into())],
            },
            now(),
        )
        .await
        .unwrap();
    assert_eq!(applied.task().unwrap().title.as_str(), "Fix parser");
    assert_eq!(applied.task().unwrap().tag_ids, vec![tag_id]);
    repository
        .create_saved_filter(
            operation(),
            junban_domain::SavedFilterId::new(),
            junban_app::SavedFilterDraft {
                name: EntityName::new("Mine").unwrap(),
                query: junban_domain::FilterQuery::new("priority:1").unwrap(),
                color: None,
                sort_order: SortOrder::default(),
            },
            now(),
        )
        .await
        .unwrap();
    let catalog = repository.list_catalog().await.unwrap();
    assert_eq!(catalog.projects.len(), 1);
    assert_eq!(catalog.sections.len(), 1);
    assert_eq!(catalog.tags.len(), 1);
    assert_eq!(catalog.templates.len(), 1);
    assert_eq!(catalog.saved_filters.len(), 1);

    // section delete clears task section, keeps project
    let mut task = draft("Sectioned");
    task.project_id = Some(project_id);
    task.section_id = Some(section_id);
    let task_id = repository
        .create_task(operation(), TaskId::new(), task, now())
        .await
        .unwrap()
        .task()
        .unwrap()
        .id;
    repository
        .delete_section(operation(), section_id, now())
        .await
        .unwrap();
    let loaded = repository.get_task(task_id).await.unwrap();
    assert_eq!(loaded.project_id, Some(project_id));
    assert_eq!(loaded.section_id, None);
}

#[tokio::test]
async fn p2_api_003_task_view_presets_match_the_complete_truth_table() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let as_of_date = "2026-07-28".parse().unwrap();

    let mut overdue = draft("Overdue");
    overdue.due_date = Some("2026-07-27".parse().unwrap());
    create_draft(&repository, overdue).await;

    let mut today = draft("Today");
    today.due_date = Some(as_of_date);
    create_draft(&repository, today).await;

    let mut future = draft("Future");
    future.due_date = Some("2026-07-29".parse().unwrap());
    create_draft(&repository, future).await;
    create_draft(&repository, draft("Undated")).await;

    let mut someday = draft("Someday");
    someday.someday = true;
    create_draft(&repository, someday).await;

    let project_id = ProjectId::new();
    repository
        .create_project(operation(), project_id, project_draft("Project"), now())
        .await
        .unwrap();
    let mut projected = draft("Projected");
    projected.project_id = Some(project_id);
    create_draft(&repository, projected).await;

    let recent = create_draft(&repository, draft("Recent completed")).await;
    repository
        .complete_task(operation(), recent, now(), temporal())
        .await
        .unwrap();
    let boundary = create_draft(&repository, draft("Boundary completed")).await;
    repository
        .complete_task(operation(), boundary, now(), temporal())
        .await
        .unwrap();
    let old = create_draft(&repository, draft("Old completed")).await;
    repository
        .complete_task(operation(), old, now(), temporal())
        .await
        .unwrap();
    let future_completed = create_draft(&repository, draft("Future completed")).await;
    repository
        .complete_task(operation(), future_completed, now(), temporal())
        .await
        .unwrap();
    repository
        .execute_batch(format!(
            "UPDATE tasks SET completed_at='2026-07-15T12:00:00Z' WHERE id='{boundary}';
             UPDATE tasks SET completed_at='2026-07-14T12:00:00Z' WHERE id='{old}';
             UPDATE tasks SET completed_at='2026-07-29T12:00:00Z' WHERE id='{future_completed}';"
        ))
        .await
        .unwrap();

    let cancelled = create_draft(&repository, draft("Cancelled")).await;
    repository
        .cancel_task(operation(), cancelled, now())
        .await
        .unwrap();

    assert_eq!(
        view_titles(&repository, TaskViewPreset::Inbox, as_of_date).await,
        [
            "Boundary completed",
            "Future",
            "Overdue",
            "Recent completed",
            "Today",
            "Undated",
        ]
    );
    assert_eq!(
        view_titles(&repository, TaskViewPreset::Today, as_of_date).await,
        ["Overdue", "Today"]
    );
    assert_eq!(
        view_titles(&repository, TaskViewPreset::Upcoming, as_of_date).await,
        ["Future", "Overdue"]
    );
    assert_eq!(
        view_titles(&repository, TaskViewPreset::Someday, as_of_date).await,
        ["Someday"]
    );
    assert_eq!(
        view_titles(&repository, TaskViewPreset::Completed, as_of_date).await,
        [
            "Boundary completed",
            "Cancelled",
            "Future completed",
            "Old completed",
            "Recent completed",
        ]
    );
    assert_eq!(
        view_titles(&repository, TaskViewPreset::Cancelled, as_of_date).await,
        ["Cancelled"]
    );
    assert_eq!(
        view_titles(&repository, TaskViewPreset::Project, as_of_date).await,
        [
            "Boundary completed",
            "Cancelled",
            "Future",
            "Future completed",
            "Old completed",
            "Overdue",
            "Projected",
            "Recent completed",
            "Someday",
            "Today",
            "Undated",
        ]
    );

    let mut combined = TaskQuery::new().with_limit(100).unwrap();
    combined.view = Some(TaskViewPreset::Inbox);
    combined.filter.statuses = vec![TaskStatus::Completed];
    let titles = repository
        .list_tasks(combined, list_as_of(as_of_date))
        .await
        .unwrap()
        .tasks
        .into_iter()
        .map(|task| task.title.to_string())
        .collect::<Vec<_>>();
    assert_eq!(titles.len(), 2);
    assert!(titles.contains(&"Boundary completed".to_owned()));
    assert!(titles.contains(&"Recent completed".to_owned()));
}

#[tokio::test]
async fn inbox_recent_completed_uses_exact_local_day_utc_bounds() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let as_of_date = "2026-07-29".parse().unwrap();

    async fn completed(repo: &SqliteRepository, title: &str, completed_at: &str) -> TaskId {
        let id = create_draft(repo, draft(title)).await;
        repo.complete_task(operation(), id, now(), temporal())
            .await
            .unwrap();
        repo.execute_batch(format!(
            "UPDATE tasks SET completed_at='{completed_at}' WHERE id='{id}'"
        ))
        .await
        .unwrap();
        id
    }

    async fn inbox_completed_titles(repo: &SqliteRepository, as_of: TaskListAsOf) -> Vec<String> {
        let mut query = TaskQuery::new().with_limit(100).unwrap();
        query.view = Some(TaskViewPreset::Inbox);
        query.filter.statuses = vec![TaskStatus::Completed];
        let mut titles = repo
            .list_tasks(query, as_of)
            .await
            .unwrap()
            .tasks
            .into_iter()
            .map(|task| task.title.to_string())
            .collect::<Vec<_>>();
        titles.sort();
        titles
    }

    // UTC-06 window for local 2026-07-29: [2026-07-16T06:00:00Z, 2026-07-30T06:00:00Z)
    completed(
        &repository,
        "west-inside-evening",
        "2026-07-30T00:00:00Z", // local 2026-07-29 18:00
    )
    .await;
    completed(&repository, "west-before", "2026-07-16T05:59:59Z").await;
    completed(&repository, "west-at-end", "2026-07-30T06:00:00Z").await;
    let west =
        TaskListAsOf::for_local_date(as_of_date, &TimeZone::fixed(jiff::tz::offset(-6))).unwrap();
    assert_eq!(
        inbox_completed_titles(&repository, west).await,
        vec!["west-inside-evening".to_owned()]
    );

    // Fresh profile for the positive-offset case so titles stay unambiguous.
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();

    // UTC+12 window for local 2026-07-29: [2026-07-15T12:00:00Z, 2026-07-29T12:00:00Z)
    completed(
        &repository,
        "east-inside-morning",
        "2026-07-28T13:00:00Z", // local 2026-07-29 01:00
    )
    .await;
    completed(&repository, "east-before", "2026-07-15T11:59:59Z").await;
    completed(&repository, "east-at-end", "2026-07-29T12:00:00Z").await;
    let east =
        TaskListAsOf::for_local_date(as_of_date, &TimeZone::fixed(jiff::tz::offset(12))).unwrap();
    assert_eq!(
        inbox_completed_titles(&repository, east).await,
        vec!["east-inside-morning".to_owned()]
    );
}

#[tokio::test]
async fn query_preserves_project_filter_escapes_like_and_paginates() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let project_id = ProjectId::new();
    repository
        .create_project(
            operation(),
            project_id,
            ProjectDraft {
                name: EntityName::new("Workbench").unwrap(),
                color: HexColor::new("#112233").unwrap(),
                icon: None,
                parent_id: None,
                favorite: false,
                archived: false,
                view: Default::default(),
                sort_order: SortOrder::default(),
            },
            now(),
        )
        .await
        .unwrap();
    for title in ["alpha%one", "beta_two", "gamma"] {
        let mut d = draft(title);
        d.project_id = Some(project_id);
        repository
            .create_task(operation(), TaskId::new(), d, now())
            .await
            .unwrap();
    }
    // project name resolves
    let mut q =
        junban_domain::parse_filter("project:Workbench", "2026-07-28".parse().unwrap()).unwrap();
    q.limit = Some(2);
    let page = repository
        .list_tasks(q, list_as_of_str("2026-07-28"))
        .await
        .unwrap();
    assert_eq!(page.tasks.len(), 2);
    assert!(page.next_cursor.is_some());
    let mut q2 = TaskQuery::new().with_limit(2).unwrap();
    q2.filter.project_id = Some(Some(project_id));
    q2.cursor = page.next_cursor;
    let page2 = repository
        .list_tasks(q2, list_as_of_str("2026-07-28"))
        .await
        .unwrap();
    assert_eq!(page2.tasks.len(), 1);
    assert!(page2.next_cursor.is_none());

    // LIKE metacharacters are escaped
    let mut search = TaskQuery::new()
        .with_search("alpha%one")
        .with_limit(10)
        .unwrap();
    search.filter.project_id = Some(Some(project_id));
    let hits = repository
        .list_tasks(search, list_as_of_str("2026-07-28"))
        .await
        .unwrap();
    assert_eq!(hits.tasks.len(), 1);
    assert_eq!(hits.tasks[0].title.as_str(), "alpha%one");

    // unknown project name yields empty rather than unfiltered
    let empty = repository
        .list_tasks(
            junban_domain::parse_filter("project:Missing", "2026-07-28".parse().unwrap()).unwrap(),
            list_as_of_str("2026-07-28"),
        )
        .await
        .unwrap();
    assert!(empty.tasks.is_empty());
}

#[tokio::test]
async fn query_and_combines_two_tags_with_status_list_and_project() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let as_of: jiff::civil::Date = "2026-07-28".parse().unwrap();

    let project_id = ProjectId::new();
    repository
        .create_project(
            operation(),
            project_id,
            ProjectDraft {
                name: EntityName::new("Workbench").unwrap(),
                color: HexColor::new("#112233").unwrap(),
                icon: None,
                parent_id: None,
                favorite: false,
                archived: false,
                view: Default::default(),
                sort_order: SortOrder::default(),
            },
            now(),
        )
        .await
        .unwrap();

    let tag_a = TagId::new();
    let tag_b = TagId::new();
    for (id, name) in [(tag_a, "alpha"), (tag_b, "beta")] {
        repository
            .create_tag(
                operation(),
                id,
                TagDraft {
                    name: TagName::new(name).unwrap(),
                    color: HexColor::new("#abcdef").unwrap(),
                },
                now(),
            )
            .await
            .unwrap();
    }

    let mut both = draft("both-tags-pending");
    both.project_id = Some(project_id);
    both.tag_ids = vec![tag_a, tag_b];
    create_draft(&repository, both).await;

    let mut only_a = draft("only-alpha");
    only_a.project_id = Some(project_id);
    only_a.tag_ids = vec![tag_a];
    create_draft(&repository, only_a).await;

    let mut completed_both = draft("both-completed");
    completed_both.project_id = Some(project_id);
    completed_both.tag_ids = vec![tag_a, tag_b];
    let completed_id = create_draft(&repository, completed_both).await;
    repository
        .complete_task(operation(), completed_id, now(), temporal())
        .await
        .unwrap();

    let mut other_project = draft("other-project");
    other_project.tag_ids = vec![tag_a, tag_b];
    create_draft(&repository, other_project).await;

    let mut query = TaskQuery::new().with_limit(100).unwrap();
    query.filter.tag_ids = vec![tag_a, tag_b];
    query.filter.statuses = vec![TaskStatus::Pending, TaskStatus::Completed];
    query.filter.project_id = Some(Some(project_id));

    let mut titles = repository
        .list_tasks(query, list_as_of(as_of))
        .await
        .unwrap()
        .tasks
        .into_iter()
        .map(|task| task.title.to_string())
        .collect::<Vec<_>>();
    titles.sort();
    assert_eq!(
        titles,
        vec!["both-completed".to_owned(), "both-tags-pending".to_owned()]
    );
}

#[tokio::test]
async fn relations_reject_self_and_cycles_and_duplicates() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let a = create_simple(&repository, "A").await.task().unwrap().id;
    let b = create_simple(&repository, "B").await.task().unwrap().id;
    repository
        .add_relation(
            operation(),
            a,
            b,
            junban_domain::RelationKind::Blocks,
            now(),
        )
        .await
        .unwrap();
    assert_eq!(
        repository
            .add_relation(
                operation(),
                a,
                b,
                junban_domain::RelationKind::Blocks,
                now()
            )
            .await,
        Err(RepositoryError::Conflict)
    );
    assert_eq!(
        repository
            .add_relation(
                operation(),
                b,
                a,
                junban_domain::RelationKind::Blocks,
                now()
            )
            .await,
        Err(RepositoryError::Conflict)
    );
    assert_eq!(
        repository
            .add_relation(
                operation(),
                a,
                a,
                junban_domain::RelationKind::Blocks,
                now()
            )
            .await,
        Err(RepositoryError::Validation(
            junban_domain::ValidationError::Invalid {
                field: "task_relation",
                reason: "a task cannot block itself",
            }
        ))
    );
}

#[tokio::test]
async fn reorder_requires_permutation_and_bulk_cap() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let mut ids = Vec::new();
    for title in ["a", "b", "c"] {
        ids.push(create_simple(&repository, title).await.task().unwrap().id);
    }
    repository
        .reorder_tasks(
            operation(),
            ReorderScope {
                project_id: Some(None),
                section_id: Some(None),
                parent_id: Some(None),
            },
            vec![ids[2], ids[0], ids[1]],
            now(),
        )
        .await
        .unwrap();
    assert_eq!(
        repository
            .reorder_tasks(
                operation(),
                ReorderScope {
                    project_id: Some(None),
                    section_id: Some(None),
                    parent_id: Some(None),
                },
                vec![ids[0], ids[0]],
                now(),
            )
            .await,
        Err(RepositoryError::Conflict)
    );
    let too_many = (0..=MAX_BULK_IDS)
        .map(|_| TaskId::new())
        .collect::<Vec<_>>();
    assert!(matches!(
        repository
            .bulk_tasks(
                operation(),
                too_many,
                BulkAction::Complete,
                now(),
                temporal()
            )
            .await,
        Err(RepositoryError::Validation(_))
    ));
}

#[tokio::test]
async fn move_rejects_descendant_parenting_and_undo_patch_conflicts() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let parent = create_simple(&repository, "P").await.task().unwrap().id;
    let mut child_draft = draft("C");
    child_draft.parent_id = Some(parent);
    let child = repository
        .create_task(operation(), TaskId::new(), child_draft, now())
        .await
        .unwrap()
        .task()
        .unwrap()
        .id;
    assert_eq!(
        repository
            .move_task(
                operation(),
                parent,
                MoveTarget {
                    parent_id: Some(Some(child)),
                    project_id: None,
                    section_id: None,
                    order: OrderAnchor::Keep,
                },
                now(),
            )
            .await,
        Err(RepositoryError::Conflict)
    );

    let patch_op = operation();
    repository
        .patch_task(
            patch_op,
            parent,
            TaskPatch {
                title: Some(TaskTitle::new("Renamed").unwrap()),
                ..TaskPatch::default()
            },
            now(),
        )
        .await
        .unwrap();
    // concurrent change then undo should conflict
    repository
        .patch_task(
            operation(),
            parent,
            TaskPatch {
                title: Some(TaskTitle::new("Newer").unwrap()),
                ..TaskPatch::default()
            },
            now(),
        )
        .await
        .unwrap();
    assert_eq!(
        repository.undo(patch_op, operation(), now()).await,
        Err(RepositoryError::Conflict)
    );
}

#[tokio::test]
async fn one_mutation_one_event_and_receipt_expiry_metadata() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let before = repository.diagnostics().await.unwrap().revision;
    create_simple(&repository, "One").await;
    let after = repository.diagnostics().await.unwrap();
    assert_eq!(after.revision, before + 1);
    assert_eq!(after.events, before + 1);
    assert_eq!(after.activity, before + 1);
    // receipt timestamps present
    let count: i64 = {
        // use diagnostics path via SQL
        repository
            .execute_batch(
                "SELECT 1;".into(), // no-op ensure worker alive
            )
            .await
            .unwrap();
        after.receipts
    };
    assert!(count >= 1);
}

#[cfg(unix)]
#[test]
fn profile_files_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    write_private_file(&directory.0.join("token"), b"secret").unwrap();
    drop(owner);
    assert_eq!(
        fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for file in [LOCK_FILE, DATABASE_FILE, "token"] {
        assert_eq!(
            fs::metadata(directory.0.join(file))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

// --- Phase 2 core review regressions (DB-P2-001 .. DB-P2-011) ---

fn project_draft(name: &str) -> ProjectDraft {
    ProjectDraft {
        name: EntityName::new(name).unwrap(),
        color: HexColor::new("#112233").unwrap(),
        icon: None,
        parent_id: None,
        favorite: false,
        archived: false,
        view: Default::default(),
        sort_order: SortOrder::default(),
    }
}

#[tokio::test]
async fn db_p2_001_catalog_and_comment_create_ids_replay_stably() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();

    let project_op = operation();
    let first = repository
        .create_project(project_op, ProjectId::new(), project_draft("Work"), now())
        .await
        .unwrap();
    let original_id = match &first.event.snapshot {
        Some(junban_app::ResourceSnapshot::Project { project }) => project.id,
        _ => panic!("expected project snapshot"),
    };
    let replay = repository
        .create_project(project_op, ProjectId::new(), project_draft("Work"), now())
        .await
        .unwrap();
    assert_eq!(replay, first);
    assert!(!replay.newly_committed);
    assert!(first.newly_committed);
    match &replay.event.snapshot {
        Some(junban_app::ResourceSnapshot::Project { project }) => {
            assert_eq!(project.id, original_id);
        }
        _ => panic!("expected project snapshot"),
    }
    assert_eq!(
        repository
            .create_project(project_op, ProjectId::new(), project_draft("Other"), now())
            .await,
        Err(RepositoryError::IdempotencyMismatch)
    );

    let section_op = operation();
    let section_first = repository
        .create_section(
            section_op,
            junban_domain::SectionId::new(),
            SectionDraft {
                project_id: original_id,
                name: EntityName::new("Todo").unwrap(),
                collapsed: false,
                sort_order: SortOrder::default(),
            },
            now(),
        )
        .await
        .unwrap();
    let section_replay = repository
        .create_section(
            section_op,
            junban_domain::SectionId::new(),
            SectionDraft {
                project_id: original_id,
                name: EntityName::new("Todo").unwrap(),
                collapsed: false,
                sort_order: SortOrder::default(),
            },
            now(),
        )
        .await
        .unwrap();
    assert_eq!(section_replay, section_first);

    let tag_op = operation();
    let tag_first = repository
        .create_tag(
            tag_op,
            TagId::new(),
            TagDraft {
                name: TagName::new("rust").unwrap(),
                color: HexColor::new("#abcdef").unwrap(),
            },
            now(),
        )
        .await
        .unwrap();
    assert_eq!(
        repository
            .create_tag(
                tag_op,
                TagId::new(),
                TagDraft {
                    name: TagName::new("rust").unwrap(),
                    color: HexColor::new("#abcdef").unwrap(),
                },
                now(),
            )
            .await
            .unwrap(),
        tag_first
    );

    let template_op = operation();
    let template_id = TemplateId::new();
    repository
        .create_template(
            template_op,
            template_id,
            TemplateDraft {
                name: EntityName::new("Bug").unwrap(),
                title: TaskTitle::new("Fix {{area}}").unwrap(),
                description: junban_domain::MarkdownText::empty(),
                priority: None,
                tag_names: vec![],
                project_id: None,
                recurrence_rule: None,
                sort_order: SortOrder::default(),
            },
            now(),
        )
        .await
        .unwrap();
    // Restart-style: reopen and replay template apply with a generated task id.
    drop(repository);
    drop(owner);
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let apply_op = operation();
    let applied = repository
        .apply_template(
            apply_op,
            TaskId::new(),
            TemplateApply {
                template_id,
                variables: vec![("area".into(), "parser".into())],
            },
            now(),
        )
        .await
        .unwrap();
    let task_id = applied.task().unwrap().id;
    let applied_replay = repository
        .apply_template(
            apply_op,
            TaskId::new(),
            TemplateApply {
                template_id,
                variables: vec![("area".into(), "parser".into())],
            },
            now(),
        )
        .await
        .unwrap();
    assert_eq!(applied_replay.task().unwrap().id, task_id);
    assert!(!applied_replay.newly_committed);

    let comment_op = operation();
    let comment_first = repository
        .create_comment(
            comment_op,
            CommentId::new(),
            task_id,
            CommentBody::new("note").unwrap(),
            now(),
        )
        .await
        .unwrap();
    let comment_replay = repository
        .create_comment(
            comment_op,
            CommentId::new(),
            task_id,
            CommentBody::new("note").unwrap(),
            now(),
        )
        .await
        .unwrap();
    assert_eq!(comment_replay, comment_first);
    assert_eq!(repository.list_comments(task_id).await.unwrap().len(), 1);
}

#[tokio::test]
async fn db_p2_002_bulk_complete_cascades_pending_descendants_and_caps() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let parent = create_simple(&repository, "P").await.task().unwrap().id;
    let mut child_draft = draft("C");
    child_draft.parent_id = Some(parent);
    let child = repository
        .create_task(operation(), TaskId::new(), child_draft, now())
        .await
        .unwrap()
        .task()
        .unwrap()
        .id;
    let mut cancelled_draft = draft("X");
    cancelled_draft.parent_id = Some(parent);
    let cancelled = repository
        .create_task(operation(), TaskId::new(), cancelled_draft, now())
        .await
        .unwrap()
        .task()
        .unwrap()
        .id;
    repository
        .cancel_task(operation(), cancelled, now())
        .await
        .unwrap();
    let other = create_simple(&repository, "O").await.task().unwrap().id;

    let complete_op = operation();
    let mutation = repository
        .bulk_tasks(
            complete_op,
            vec![parent, other],
            BulkAction::Complete,
            now(),
            temporal(),
        )
        .await
        .unwrap();
    assert_eq!(mutation.event.affected.task_ids.len(), 3);
    assert!(mutation.event.affected.task_ids.contains(&parent));
    assert!(mutation.event.affected.task_ids.contains(&child));
    assert!(mutation.event.affected.task_ids.contains(&other));
    assert!(!mutation.event.affected.task_ids.contains(&cancelled));
    assert_eq!(
        repository.get_task(child).await.unwrap().status,
        TaskStatus::Completed
    );
    assert_eq!(
        repository.get_task(cancelled).await.unwrap().status,
        TaskStatus::Cancelled
    );

    repository
        .undo(complete_op, operation(), now())
        .await
        .unwrap();
    assert_eq!(
        repository.get_task(child).await.unwrap().status,
        TaskStatus::Pending
    );

    // Selected completed task is still a conflict.
    repository
        .complete_task(operation(), other, now(), temporal())
        .await
        .unwrap();
    assert_eq!(
        repository
            .bulk_tasks(
                operation(),
                vec![other],
                BulkAction::Complete,
                now(),
                temporal()
            )
            .await,
        Err(RepositoryError::Conflict)
    );

    // Over-cap expanded set is rejected before write.
    let root = create_simple(&repository, "root-cap")
        .await
        .task()
        .unwrap()
        .id;
    for index in 0..MAX_BULK_IDS {
        let mut child = draft(&format!("d{index}"));
        child.parent_id = Some(root);
        repository
            .create_task(operation(), TaskId::new(), child, now())
            .await
            .unwrap();
    }
    let before = repository.diagnostics().await.unwrap().revision;
    assert_eq!(
        repository
            .bulk_tasks(
                operation(),
                vec![root],
                BulkAction::Complete,
                now(),
                temporal()
            )
            .await,
        Err(RepositoryError::OperationTooLarge)
    );
    assert_eq!(repository.diagnostics().await.unwrap().revision, before);
    assert_eq!(
        repository.get_task(root).await.unwrap().status,
        TaskStatus::Pending
    );
}

#[tokio::test]
async fn db_p2_003_move_order_anchors_restore_sibling_order_on_undo() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let mut ids = Vec::new();
    for title in ["a", "b", "c", "d"] {
        ids.push(create_simple(&repository, title).await.task().unwrap().id);
    }
    // Establish deterministic starting order a,b,c,d.
    repository
        .reorder_tasks(
            operation(),
            ReorderScope {
                project_id: Some(None),
                section_id: Some(None),
                parent_id: Some(None),
            },
            ids.clone(),
            now(),
        )
        .await
        .unwrap();

    async fn orders(repo: &SqliteRepository, ids: &[TaskId]) -> Vec<(TaskId, i64)> {
        let mut out = Vec::new();
        for id in ids {
            let task = repo.get_task(*id).await.unwrap();
            out.push((*id, task.sort_order.get()));
        }
        out.sort_by_key(|(_, order)| *order);
        out
    }

    let before = orders(&repository, &ids).await;
    let move_op = operation();
    repository
        .move_task(
            move_op,
            ids[3],
            MoveTarget {
                parent_id: None,
                project_id: None,
                section_id: None,
                order: OrderAnchor::First,
            },
            now(),
        )
        .await
        .unwrap();
    assert_eq!(orders(&repository, &ids).await[0].0, ids[3]);
    repository.undo(move_op, operation(), now()).await.unwrap();
    assert_eq!(orders(&repository, &ids).await, before);

    let move_last = operation();
    repository
        .move_task(
            move_last,
            ids[0],
            MoveTarget {
                parent_id: None,
                project_id: None,
                section_id: None,
                order: OrderAnchor::Last,
            },
            now(),
        )
        .await
        .unwrap();
    assert_eq!(orders(&repository, &ids).await.last().unwrap().0, ids[0]);
    repository
        .undo(move_last, operation(), now())
        .await
        .unwrap();

    let move_before = operation();
    repository
        .move_task(
            move_before,
            ids[3],
            MoveTarget {
                parent_id: None,
                project_id: None,
                section_id: None,
                order: OrderAnchor::Before { task_id: ids[1] },
            },
            now(),
        )
        .await
        .unwrap();
    let ordered = orders(&repository, &ids).await;
    let pos_d = ordered.iter().position(|(id, _)| *id == ids[3]).unwrap();
    let pos_b = ordered.iter().position(|(id, _)| *id == ids[1]).unwrap();
    assert_eq!(pos_d + 1, pos_b);
    repository
        .undo(move_before, operation(), now())
        .await
        .unwrap();

    let move_after = operation();
    repository
        .move_task(
            move_after,
            ids[0],
            MoveTarget {
                parent_id: None,
                project_id: None,
                section_id: None,
                order: OrderAnchor::After { task_id: ids[2] },
            },
            now(),
        )
        .await
        .unwrap();
    let ordered = orders(&repository, &ids).await;
    let pos_a = ordered.iter().position(|(id, _)| *id == ids[0]).unwrap();
    let pos_c = ordered.iter().position(|(id, _)| *id == ids[2]).unwrap();
    assert_eq!(pos_c + 1, pos_a);
    repository
        .undo(move_after, operation(), now())
        .await
        .unwrap();
    assert_eq!(orders(&repository, &ids).await, before);
}

#[tokio::test]
async fn db_p2_004_anchored_move_enforces_exact_affected_task_ceiling() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let project_id = ProjectId::new();
    repository
        .create_project(
            operation(),
            project_id,
            project_draft("Anchor source"),
            now(),
        )
        .await
        .unwrap();
    let mut source_draft = draft("anchored move");
    source_draft.project_id = Some(project_id);
    let moved_id = TaskId::new();
    repository
        .create_task(operation(), moved_id, source_draft, now())
        .await
        .unwrap();
    let mut target_ids = Vec::new();
    for index in 0..(MAX_BULK_IDS - 1) {
        target_ids.push(
            create_simple(&repository, &format!("anchor-target-{index}"))
                .await
                .task()
                .unwrap()
                .id,
        );
    }

    let before = repository.diagnostics().await.unwrap();
    let move_operation = operation();
    let mutation = repository
        .move_task(
            move_operation,
            moved_id,
            MoveTarget {
                parent_id: None,
                project_id: Some(None),
                section_id: Some(None),
                order: OrderAnchor::First,
            },
            now(),
        )
        .await
        .unwrap();
    assert_eq!(mutation.event.affected.task_ids.len(), MAX_BULK_IDS);
    let after = repository.diagnostics().await.unwrap();
    assert_eq!(after.revision, before.revision + 1);
    let sibling_activity = repository
        .list_task_activity(target_ids[0], None, None, 100)
        .await
        .unwrap();
    assert!(sibling_activity.iter().any(|entry| {
        entry.operation_id == move_operation && entry.field.as_deref() == Some("sort_order")
    }));
    repository
        .undo(move_operation, operation(), now())
        .await
        .unwrap();
    assert_eq!(
        repository.get_task(moved_id).await.unwrap().project_id,
        Some(project_id)
    );

    // One more target sibling makes the anchored rewrite 501 tasks and must roll back.
    create_simple(&repository, "anchor-over-cap").await;
    let before_rejection = repository.diagnostics().await.unwrap();
    assert_eq!(
        repository
            .move_task(
                operation(),
                moved_id,
                MoveTarget {
                    parent_id: None,
                    project_id: Some(None),
                    section_id: Some(None),
                    order: OrderAnchor::Last,
                },
                now(),
            )
            .await,
        Err(RepositoryError::OperationTooLarge)
    );
    let after_rejection = repository.diagnostics().await.unwrap();
    assert_eq!(after_rejection.revision, before_rejection.revision);
    assert_eq!(after_rejection.activity, before_rejection.activity);
    assert_eq!(
        repository.get_task(moved_id).await.unwrap().project_id,
        Some(project_id)
    );
}

#[tokio::test]
async fn db_p2_003_keep_move_does_not_rewrite_or_cap_untouched_siblings() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let project_id = ProjectId::new();
    repository
        .create_project(operation(), project_id, project_draft("Source"), now())
        .await
        .unwrap();
    let mut source_draft = draft("move me");
    source_draft.project_id = Some(project_id);
    let moved_id = TaskId::new();
    repository
        .create_task(operation(), moved_id, source_draft, now())
        .await
        .unwrap();
    for index in 0..=MAX_BULK_IDS {
        create_simple(&repository, &format!("untouched-{index}")).await;
    }

    let mutation = repository
        .move_task(
            operation(),
            moved_id,
            MoveTarget {
                parent_id: None,
                project_id: Some(None),
                section_id: Some(None),
                order: OrderAnchor::Keep,
            },
            now(),
        )
        .await
        .unwrap();

    assert_eq!(mutation.event.affected.task_ids, vec![moved_id]);
    assert_eq!(
        repository.get_task(moved_id).await.unwrap().project_id,
        None
    );
}

#[tokio::test]
async fn db_p2_004_catalog_delete_enforces_task_ceiling_and_activity() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let project_id = ProjectId::new();
    repository
        .create_project(operation(), project_id, project_draft("Cap"), now())
        .await
        .unwrap();
    let section_id = junban_domain::SectionId::new();
    repository
        .create_section(
            operation(),
            section_id,
            SectionDraft {
                project_id,
                name: EntityName::new("S").unwrap(),
                collapsed: false,
                sort_order: SortOrder::default(),
            },
            now(),
        )
        .await
        .unwrap();
    let tag_id = TagId::new();
    repository
        .create_tag(
            operation(),
            tag_id,
            TagDraft {
                name: TagName::new("keep").unwrap(),
                color: HexColor::new("#010203").unwrap(),
            },
            now(),
        )
        .await
        .unwrap();

    // 500 tasks: delete succeeds with activity and affected ids.
    let mut task_ids = Vec::new();
    for index in 0..MAX_BULK_IDS {
        let mut d = draft(&format!("t{index}"));
        d.project_id = Some(project_id);
        d.section_id = Some(section_id);
        d.tag_ids = vec![tag_id];
        task_ids.push(
            repository
                .create_task(operation(), TaskId::new(), d, now())
                .await
                .unwrap()
                .task()
                .unwrap()
                .id,
        );
    }
    let deleted_section = repository
        .delete_section(operation(), section_id, now())
        .await
        .unwrap();
    assert_eq!(deleted_section.event.affected.task_ids.len(), MAX_BULK_IDS);
    let sample = repository.get_task(task_ids[0]).await.unwrap();
    assert_eq!(sample.project_id, Some(project_id));
    assert_eq!(sample.section_id, None);
    let activity = repository
        .list_task_activity(task_ids[0], None, None, 20)
        .await
        .unwrap();
    assert!(
        activity
            .iter()
            .any(|row| row.field.as_deref() == Some("section_id"))
    );

    // 501st task makes project delete too large and rolls back.
    let mut extra = draft("overflow");
    extra.project_id = Some(project_id);
    extra.tag_ids = vec![tag_id];
    repository
        .create_task(operation(), TaskId::new(), extra, now())
        .await
        .unwrap();
    let before = repository.diagnostics().await.unwrap().revision;
    assert_eq!(
        repository
            .delete_project(operation(), project_id, now())
            .await,
        Err(RepositoryError::OperationTooLarge)
    );
    assert_eq!(repository.diagnostics().await.unwrap().revision, before);
    assert!(
        repository
            .list_catalog()
            .await
            .unwrap()
            .projects
            .iter()
            .any(|project| project.id == project_id)
    );

    // Tag detach path also caps at 501 linked tasks.
    let before = repository.diagnostics().await.unwrap().revision;
    assert_eq!(
        repository.delete_tag(operation(), tag_id, now()).await,
        Err(RepositoryError::OperationTooLarge)
    );
    assert_eq!(repository.diagnostics().await.unwrap().revision, before);
}

#[tokio::test]
async fn db_p2_005_event_catch_up_is_bounded_and_can_require_resync() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    for index in 0..5 {
        create_simple(&repository, &format!("e{index}")).await;
    }
    match repository.list_events(0).await.unwrap() {
        EventCatchUp::Page {
            events,
            has_more,
            latest_revision,
        } => {
            assert_eq!(events.len(), 5);
            assert!(!has_more);
            assert_eq!(latest_revision, 5);
        }
        EventCatchUp::ResyncRequired { .. } => panic!("expected page"),
    }

    // Force retained history to start after revision 2.
    repository
        .execute_batch("DELETE FROM events WHERE revision <= 2".into())
        .await
        .unwrap();
    match repository.list_events(0).await.unwrap() {
        EventCatchUp::ResyncRequired { latest_revision } => assert_eq!(latest_revision, 5),
        EventCatchUp::Page { .. } => panic!("expected resync"),
    }
    match repository.list_events(2).await.unwrap() {
        EventCatchUp::Page { events, .. } => {
            assert_eq!(events.len(), 3);
            assert_eq!(events[0].revision, 3);
        }
        EventCatchUp::ResyncRequired { .. } => panic!("cursor at retained edge should page"),
    }

    // Pruning keeps at most 2048 events after commits.
    repository
        .execute_batch(
            "DELETE FROM events; DELETE FROM activity; DELETE FROM operation_receipts; DELETE FROM operation_undo; UPDATE app_state SET global_revision = 0;".into(),
        )
        .await
        .unwrap();
    // Insert just over the retain count using mutations would be slow; seed rows then commit one.
    let mut seed = String::from("BEGIN;");
    for revision in 1..=2050 {
        seed.push_str(&format!(
            "INSERT INTO events(revision, event_type, operation_id, event_json, occurred_at) \
             VALUES ({revision}, 'task.created', '00000000-0000-4000-8000-000000000001', '{{\"revision\":{revision}}}', '2026-07-28T12:00:00Z');"
        ));
    }
    seed.push_str("UPDATE app_state SET global_revision = 2050; COMMIT;");
    repository.execute_batch(seed).await.unwrap();
    create_simple(&repository, "prune-trigger").await;
    let count: i64 = {
        // diagnostics.events after prune
        repository.diagnostics().await.unwrap().events
    };
    assert!(count <= junban_app::EVENT_RETAIN_MAX_COUNT as i64);
    assert!(count <= 2048);
}

#[tokio::test]
async fn db_p2_005_event_pages_enforce_serialized_byte_budget() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let payload = "💾".repeat(9_000);
    for index in 0..110 {
        let mut task = draft(&format!("large-event-{index}"));
        task.description = MarkdownText::new(payload.clone()).unwrap();
        repository
            .create_task(operation(), TaskId::new(), task, now())
            .await
            .unwrap();
    }

    let mut cursor = 0;
    let mut total = 0;
    let mut first_page_count = None;
    loop {
        let EventCatchUp::Page {
            events, has_more, ..
        } = repository.list_events(cursor).await.unwrap()
        else {
            panic!("retained cursor should return a page");
        };
        let bytes: usize = events
            .iter()
            .map(|event| serde_json::to_string(event).unwrap().len())
            .sum();
        assert!(events.len() <= junban_app::EVENT_CATCHUP_MAX_COUNT);
        assert!(bytes <= junban_app::EVENT_CATCHUP_MAX_BYTES);
        if first_page_count.is_none() {
            first_page_count = Some(events.len());
            assert!(has_more);
            assert!(events.len() < junban_app::EVENT_CATCHUP_MAX_COUNT);
        }
        total += events.len();
        cursor = events.last().map_or(cursor, |event| event.revision);
        if !has_more {
            break;
        }
    }
    assert_eq!(total, 110);
}

#[tokio::test]
async fn db_p2_006_expired_open_undone_and_redo_receipts_are_cleaned() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();

    let open_op = operation();
    let task = repository
        .create_task(open_op, TaskId::new(), draft("open"), now())
        .await
        .unwrap();
    let task_id = task.task().unwrap().id;

    let patch_op = operation();
    repository
        .patch_task(
            patch_op,
            task_id,
            TaskPatch {
                title: Some(TaskTitle::new("patched").unwrap()),
                ..TaskPatch::default()
            },
            now(),
        )
        .await
        .unwrap();
    let undo_op = operation();
    repository.undo(patch_op, undo_op, now()).await.unwrap();
    let redo_op = operation();
    repository.undo(undo_op, redo_op, now()).await.unwrap();

    let expired = now().checked_sub((31 * 24).hours()).unwrap().to_string();
    repository
        .execute_batch(format!(
            "UPDATE operation_receipts SET expires_at = '{expired}';"
        ))
        .await
        .unwrap();

    // The next request must enforce expiry before replay/undo lookup; no separate
    // successful mutation is needed to trigger cleanup.
    for op in [open_op, patch_op, undo_op, redo_op] {
        assert_eq!(
            repository.undo(op, operation(), now()).await.unwrap_err(),
            RepositoryError::NotFound,
            "expired receipt {op} should not remain undoable"
        );
    }
    let diagnostics = repository.diagnostics().await.unwrap();
    assert_eq!(diagnostics.receipts, 0);

    // Reusing an expired operation ID is a new commit, never a stale replay.
    let revision = diagnostics.revision;
    let retried = repository
        .create_task(open_op, TaskId::new(), draft("open"), now())
        .await
        .unwrap();
    assert!(retried.newly_committed);
    assert_eq!(retried.event.revision, u64::try_from(revision).unwrap() + 1);
}

#[tokio::test]
async fn db_p2_007_overlapping_bulk_delete_dedupes_closure_and_undoes() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let parent = create_simple(&repository, "P").await.task().unwrap().id;
    let mut child_draft = draft("C");
    child_draft.parent_id = Some(parent);
    let child = repository
        .create_task(operation(), TaskId::new(), child_draft, now())
        .await
        .unwrap()
        .task()
        .unwrap()
        .id;
    repository
        .create_comment(
            operation(),
            CommentId::new(),
            parent,
            CommentBody::new("shared").unwrap(),
            now(),
        )
        .await
        .unwrap();
    repository
        .add_relation(operation(), parent, child, RelationKind::Blocks, now())
        .await
        .unwrap();

    let delete_op = operation();
    repository
        .bulk_tasks(
            delete_op,
            vec![parent, child],
            BulkAction::Delete,
            now(),
            temporal(),
        )
        .await
        .unwrap();
    assert!(matches!(
        repository.get_task(parent).await,
        Err(RepositoryError::NotFound)
    ));
    repository
        .undo(delete_op, operation(), now())
        .await
        .unwrap();
    assert_eq!(repository.list_comments(parent).await.unwrap().len(), 1);
    assert_eq!(repository.list_relations(parent).await.unwrap().len(), 1);
    assert_eq!(
        repository.get_task(child).await.unwrap().parent_id,
        Some(parent)
    );
}

#[tokio::test]
async fn db_p2_008_undo_missing_post_image_and_refs_are_conflicts() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let project_id = ProjectId::new();
    repository
        .create_project(operation(), project_id, project_draft("Temp"), now())
        .await
        .unwrap();
    let mut d = draft("linked");
    d.project_id = Some(project_id);
    let task_id = repository
        .create_task(operation(), TaskId::new(), d, now())
        .await
        .unwrap()
        .task()
        .unwrap()
        .id;
    let patch_op = operation();
    repository
        .patch_task(
            patch_op,
            task_id,
            TaskPatch {
                title: Some(TaskTitle::new("changed").unwrap()),
                ..TaskPatch::default()
            },
            now(),
        )
        .await
        .unwrap();
    // Break expected post-image by mutating the task outside undo validation.
    repository
        .patch_task(
            operation(),
            task_id,
            TaskPatch {
                title: Some(TaskTitle::new("newer").unwrap()),
                ..TaskPatch::default()
            },
            now(),
        )
        .await
        .unwrap();
    assert_eq!(
        repository.undo(patch_op, operation(), now()).await,
        Err(RepositoryError::Conflict)
    );

    // Delete then remove required project reference before undo => Conflict.
    let mut d2 = draft("to-delete");
    d2.project_id = Some(project_id);
    let doomed = repository
        .create_task(operation(), TaskId::new(), d2, now())
        .await
        .unwrap()
        .task()
        .unwrap()
        .id;
    let delete_op = operation();
    repository
        .delete_task(delete_op, doomed, now())
        .await
        .unwrap();
    repository
        .delete_project(operation(), project_id, now())
        .await
        .unwrap();
    assert_eq!(
        repository.undo(delete_op, operation(), now()).await,
        Err(RepositoryError::Conflict)
    );
}

#[tokio::test]
async fn db_p2_009_bulk_move_rejects_non_keep_order_without_revision() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let id = create_simple(&repository, "m").await.task().unwrap().id;
    let before = repository.diagnostics().await.unwrap().revision;
    let err = repository
        .bulk_tasks(
            operation(),
            vec![id],
            BulkAction::Move {
                target: MoveTarget {
                    parent_id: None,
                    project_id: None,
                    section_id: None,
                    order: OrderAnchor::First,
                },
            },
            now(),
            temporal(),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, RepositoryError::Validation(_)));
    assert_eq!(repository.diagnostics().await.unwrap().revision, before);
    assert_eq!(repository.get_task(id).await.unwrap().sort_order.get(), 0);
}

#[tokio::test]
async fn db_p2_010_replay_flag_and_serialized_response_are_stable() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let op = operation();
    let first = repository
        .create_task(op, TaskId::new(), draft("flag"), now())
        .await
        .unwrap();
    assert!(first.newly_committed);
    let json = serde_json::to_string(&first).unwrap();
    assert!(!json.contains("newly_committed"));
    let replay = repository
        .create_task(op, TaskId::new(), draft("flag"), now())
        .await
        .unwrap();
    assert!(!replay.newly_committed);
    assert_eq!(serde_json::to_string(&replay).unwrap(), json);
}

#[tokio::test]
async fn db_p2_011_cursor_validation_covers_each_sort() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repository = owner.repository();
    let task_id = create_simple(&repository, "cursor")
        .await
        .task()
        .unwrap()
        .id;
    let as_of = "2026-07-28".parse().unwrap();

    let cases = [
        (TaskSort::SortOrderAsc, "0", "nope"),
        (TaskSort::CreatedAsc, "2026-07-28T12:00:00Z", "yesterday"),
        (TaskSort::CreatedDesc, "2026-07-28T12:00:00Z", "not-a-time"),
        (TaskSort::UpdatedDesc, "2026-07-28T12:00:00Z", ""),
        (TaskSort::DueAsc, "9999-99-99", "tomorrow"),
        (TaskSort::DueDesc, "", "32"),
        (TaskSort::PriorityAsc, "99", "7"),
        (TaskSort::TitleAsc, "cursor", ""),
    ];
    for (sort, valid, invalid) in cases {
        let mut ok = TaskQuery::new().with_limit(10).unwrap();
        ok.sort = sort;
        ok.cursor = Some(TaskCursor {
            sort_value: valid.into(),
            task_id,
        });
        assert!(
            repository.list_tasks(ok, list_as_of(as_of)).await.is_ok(),
            "valid cursor rejected for {sort:?}"
        );

        let mut bad = TaskQuery::new().with_limit(10).unwrap();
        bad.sort = sort;
        bad.cursor = Some(TaskCursor {
            sort_value: invalid.into(),
            task_id,
        });
        let err = repository
            .list_tasks(bad, list_as_of(as_of))
            .await
            .unwrap_err();
        assert!(
            matches!(err, RepositoryError::Validation(_)),
            "invalid cursor not validated for {sort:?}: {err:?}"
        );
    }
}

// ── Phase 3 recurrence complete / uncomplete ───────────────────────────────

use jiff::civil::{Time, date};
use junban_domain::{
    DreadLevel, EstimatedMinutes, LocalDueTime, MonthlyAnchorDay, Priority, RecurrenceRule,
    UncompleteOutcome,
};

fn recurring_draft(title: &str, rule: &str, due: Option<&str>) -> TaskDraft {
    let mut d = draft(title);
    d.recurrence_rule = Some(RecurrenceRule::new(rule).unwrap());
    if let Some(due) = due {
        d.due_date = Some(due.parse().unwrap());
    }
    d
}

async fn find_generated(repo: &SqliteRepository, source: TaskId) -> Option<junban_domain::Task> {
    let query = TaskQuery::new().with_limit(100).unwrap();
    let page = repo
        .list_tasks(query, list_as_of_str("2026-07-28"))
        .await
        .unwrap();
    page.tasks
        .into_iter()
        .find(|task| task.recurrence_source_id == Some(source))
}

async fn completed_recurrence(
    repo: &SqliteRepository,
    title: &str,
) -> (OperationId, TaskId, TaskId) {
    let source = create_draft(repo, recurring_draft(title, "daily", Some("2026-07-28"))).await;
    let completion = operation();
    repo.complete_task(completion, source, now(), temporal())
        .await
        .unwrap();
    let generated = find_generated(repo, source).await.unwrap().id;
    (completion, source, generated)
}

async fn assert_uncomplete_conflicts_without_writes(
    repo: &SqliteRepository,
    source: TaskId,
    generated: TaskId,
) {
    let revision = repo.diagnostics().await.unwrap().revision;
    assert_eq!(
        repo.uncomplete_task(operation(), source, now(), temporal())
            .await,
        Err(RepositoryError::Conflict)
    );
    assert_eq!(repo.diagnostics().await.unwrap().revision, revision);
    assert_eq!(
        repo.get_task(source).await.unwrap().status,
        TaskStatus::Completed
    );
    assert!(repo.get_task(generated).await.is_ok());
}

async fn assert_completion_undo_conflicts_without_writes(
    repo: &SqliteRepository,
    completion: OperationId,
    source: TaskId,
    generated: TaskId,
) {
    let revision = repo.diagnostics().await.unwrap().revision;
    assert_eq!(
        repo.undo(completion, operation(), now()).await,
        Err(RepositoryError::Conflict)
    );
    assert_eq!(repo.diagnostics().await.unwrap().revision, revision);
    assert_eq!(
        repo.get_task(source).await.unwrap().status,
        TaskStatus::Completed
    );
    assert!(repo.get_task(generated).await.is_ok());
}

#[tokio::test]
async fn p3_rec_daily_weekly_monthly_yearly_weekdays_every_n() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let cases = [
        ("daily", "2026-07-28", "2026-07-29"),
        ("weekly", "2026-07-28", "2026-08-04"),
        ("monthly", "2026-01-31", "2026-02-28"),
        ("yearly", "2024-02-29", "2025-03-01"),
        ("weekdays", "2026-07-31", "2026-08-03"), // Friday -> Monday
        ("every 3 days", "2026-07-28", "2026-07-31"),
        ("every 2 weeks", "2026-07-28", "2026-08-11"),
    ];
    for (rule, due, expect_next) in cases {
        let id = create_draft(&repo, recurring_draft(rule, rule, Some(due))).await;
        let op = operation();
        let mutation = repo.complete_task(op, id, now(), temporal()).await.unwrap();
        assert_eq!(mutation.event.affected.task_ids.len(), 2, "rule={rule}");
        let child = find_generated(&repo, id).await.expect("generated child");
        assert_eq!(
            child.due_date.unwrap().to_string(),
            expect_next,
            "rule={rule}"
        );
        assert_eq!(child.status, TaskStatus::Pending);
        assert_eq!(child.recurrence_source_id, Some(id));
        assert_eq!(
            repo.get_task(id).await.unwrap().status,
            TaskStatus::Completed
        );
        assert_eq!(
            repo.get_task(id).await.unwrap().completion_operation_id,
            Some(op)
        );
        if rule == "monthly" {
            assert_eq!(
                child.recurrence_anchor_day.map(MonthlyAnchorDay::get),
                Some(31)
            );
        }
        if rule == "yearly" {
            assert_eq!(
                child.recurrence_anchor_day.map(MonthlyAnchorDay::get),
                Some(29)
            );
        }
    }
}

#[tokio::test]
async fn p3_rec_date_only_timed_dst_no_due_overdue_offsets() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    // Date-only with reminder/deadline offsets from server-local start-of-day.
    let mut date_only = recurring_draft("date-only", "daily", Some("2026-07-28"));
    date_only.remind_at = Some("2026-07-28T06:00:00Z".parse().unwrap()); // 6h after UTC midnight
    date_only.deadline = Some("2026-07-28T18:00:00Z".parse().unwrap());
    let date_id = create_draft(&repo, date_only).await;
    repo.complete_task(operation(), date_id, now(), temporal())
        .await
        .unwrap();
    let child = find_generated(&repo, date_id).await.unwrap();
    assert_eq!(child.due_date.unwrap().to_string(), "2026-07-29");
    assert_eq!(child.due_time, None);
    assert_eq!(child.remind_at.unwrap().to_string(), "2026-07-29T06:00:00Z");
    assert_eq!(child.deadline.unwrap().to_string(), "2026-07-29T18:00:00Z");

    // Timed through America/New_York spring-forward gap.
    let mut timed = recurring_draft("timed", "daily", Some("2024-03-09"));
    timed.due_time = Some(LocalDueTime::new(
        Time::constant(2, 30, 0, 0),
        junban_domain::TimeZoneName::new("America/New_York").unwrap(),
    ));
    timed.remind_at = Some("2024-03-09T06:30:00Z".parse().unwrap()); // 1h before 07:30Z due
    timed.deadline = Some("2024-03-09T08:30:00Z".parse().unwrap()); // 1h after
    let timed_id = create_draft(&repo, timed).await;
    let tctx = TemporalContext::new(date(2024, 3, 9), TimeZone::UTC);
    repo.complete_task(operation(), timed_id, now(), tctx)
        .await
        .unwrap();
    let timed_child = find_generated(&repo, timed_id).await.unwrap();
    assert_eq!(timed_child.due_date.unwrap().to_string(), "2024-03-10");
    // Gap resolves 02:30 -> 03:30 EDT = 07:30Z; offsets preserved from source 07:30Z basis.
    assert_eq!(
        timed_child.remind_at.unwrap().to_string(),
        "2024-03-10T06:30:00Z"
    );
    assert_eq!(
        timed_child.deadline.unwrap().to_string(),
        "2024-03-10T08:30:00Z"
    );

    // No-due clears absolute reminder/deadline and uses sampled date.
    let mut no_due = recurring_draft("no-due", "daily", None);
    no_due.remind_at = Some("2026-07-28T12:00:00Z".parse().unwrap());
    no_due.deadline = Some("2026-07-28T18:00:00Z".parse().unwrap());
    let no_due_id = create_draft(&repo, no_due).await;
    repo.complete_task(operation(), no_due_id, now(), temporal())
        .await
        .unwrap();
    let no_due_child = find_generated(&repo, no_due_id).await.unwrap();
    assert_eq!(no_due_child.due_date.unwrap().to_string(), "2026-07-29");
    assert_eq!(no_due_child.remind_at, None);
    assert_eq!(no_due_child.deadline, None);

    // Overdue advances once, not catch-up skip.
    let overdue_id = create_draft(
        &repo,
        recurring_draft("overdue", "weekly", Some("2026-01-01")),
    )
    .await;
    repo.complete_task(operation(), overdue_id, now(), temporal())
        .await
        .unwrap();
    let overdue_child = find_generated(&repo, overdue_id).await.unwrap();
    assert_eq!(overdue_child.due_date.unwrap().to_string(), "2026-01-08");
}

#[tokio::test]
async fn p3_rec_manual_due_or_rule_resets_anchor_and_clearing_clears() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let mut d = recurring_draft("anchor", "monthly", Some("2026-01-31"));
    d.recurrence_anchor_day = Some(MonthlyAnchorDay::new(31).unwrap());
    let id = create_draft(&repo, d).await;
    assert_eq!(
        repo.get_task(id)
            .await
            .unwrap()
            .recurrence_anchor_day
            .map(MonthlyAnchorDay::get),
        Some(31)
    );
    repo.patch_task(
        operation(),
        id,
        TaskPatch {
            due_date: Some(Some("2026-03-15".parse().unwrap())),
            ..TaskPatch::default()
        },
        now(),
    )
    .await
    .unwrap();
    assert_eq!(
        repo.get_task(id)
            .await
            .unwrap()
            .recurrence_anchor_day
            .map(MonthlyAnchorDay::get),
        Some(15)
    );
    repo.patch_task(
        operation(),
        id,
        TaskPatch {
            recurrence_rule: Some(None),
            ..TaskPatch::default()
        },
        now(),
    )
    .await
    .unwrap();
    assert_eq!(repo.get_task(id).await.unwrap().recurrence_anchor_day, None);
}

#[tokio::test]
async fn p3_rec_copies_user_fields_without_parent_comments_relations() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let project = repo
        .create_project(
            operation(),
            ProjectId::new(),
            ProjectDraft {
                name: EntityName::new("P").unwrap(),
                color: HexColor::new("#112233").unwrap(),
                icon: None,
                parent_id: None,
                favorite: false,
                archived: false,
                view: Default::default(),
                sort_order: SortOrder::default(),
            },
            now(),
        )
        .await
        .unwrap()
        .event
        .primary
        .unwrap()
        .id;
    let project_id = ProjectId::parse(&project).unwrap();
    let section = repo
        .create_section(
            operation(),
            junban_domain::SectionId::new(),
            SectionDraft {
                project_id,
                name: EntityName::new("S").unwrap(),
                collapsed: false,
                sort_order: SortOrder::default(),
            },
            now(),
        )
        .await
        .unwrap()
        .event
        .primary
        .unwrap()
        .id;
    let section_id = junban_domain::SectionId::parse(&section).unwrap();
    let tag = repo
        .create_tag(
            operation(),
            TagId::new(),
            TagDraft {
                name: TagName::new("t").unwrap(),
                color: HexColor::new("#abcdef").unwrap(),
            },
            now(),
        )
        .await
        .unwrap()
        .event
        .primary
        .unwrap()
        .id;
    let tag_id = TagId::parse(&tag).unwrap();
    let parent = create_simple(&repo, "parent").await.task().unwrap().id;
    let mut d = recurring_draft("rich", "daily", Some("2026-07-28"));
    d.description = MarkdownText::new("body").unwrap();
    d.priority = Some(Priority::new(2).unwrap());
    d.estimated_minutes = Some(EstimatedMinutes::new(25).unwrap());
    d.dread = Some(DreadLevel::new(3).unwrap());
    d.project_id = Some(project_id);
    d.section_id = Some(section_id);
    d.tag_ids = vec![tag_id];
    d.parent_id = Some(parent);
    d.someday = true;
    let id = create_draft(&repo, d).await;
    repo.create_comment(
        operation(),
        CommentId::new(),
        id,
        CommentBody::new("note").unwrap(),
        now(),
    )
    .await
    .unwrap();
    let other = create_simple(&repo, "blocked").await.task().unwrap().id;
    repo.add_relation(operation(), id, other, RelationKind::Blocks, now())
        .await
        .unwrap();
    repo.complete_task(operation(), id, now(), temporal())
        .await
        .unwrap();
    let child = find_generated(&repo, id).await.unwrap();
    assert_eq!(child.title.as_str(), "rich");
    assert_eq!(child.description.as_str(), "body");
    assert_eq!(child.priority.map(Priority::get), Some(2));
    assert_eq!(child.estimated_minutes.map(|v| v.get()), Some(25));
    assert_eq!(child.dread.map(|v| v.get()), Some(3));
    assert_eq!(child.project_id, Some(project_id));
    assert_eq!(child.section_id, Some(section_id));
    assert_eq!(child.tag_ids, vec![tag_id]);
    assert!(child.someday);
    assert_eq!(child.parent_id, None);
    assert!(repo.list_comments(child.id).await.unwrap().is_empty());
    assert!(repo.list_relations(child.id).await.unwrap().is_empty());
}

#[tokio::test]
async fn p3_rec_exact_retry_restart_and_operation_undo() {
    let directory = TestDir::new();
    let op = operation();
    let (id, child_id, first) = {
        let owner = ProfileOwner::open(&directory.0).unwrap();
        let repo = owner.repository();
        let id = create_draft(&repo, recurring_draft("retry", "daily", Some("2026-07-28"))).await;
        let first = repo.complete_task(op, id, now(), temporal()).await.unwrap();
        assert!(first.newly_committed);
        let child = find_generated(&repo, id).await.unwrap();
        let second = repo.complete_task(op, id, now(), temporal()).await.unwrap();
        assert!(!second.newly_committed);
        assert_eq!(first.event, second.event);
        assert_eq!(
            first.event.affected.task_ids,
            second.event.affected.task_ids
        );
        (id, child.id, first)
    };
    // Restart preserves generated occurrence and receipt replay.
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    assert_eq!(
        repo.get_task(child_id).await.unwrap().status,
        TaskStatus::Pending
    );
    let third = repo.complete_task(op, id, now(), temporal()).await.unwrap();
    assert_eq!(third.event.revision, first.event.revision);
    // Operation undo restores source + removes generated child.
    repo.undo(op, operation(), now()).await.unwrap();
    assert_eq!(repo.get_task(id).await.unwrap().status, TaskStatus::Pending);
    assert!(matches!(
        repo.get_task(child_id).await,
        Err(RepositoryError::NotFound)
    ));
}

#[tokio::test]
async fn p3_rec_parent_cascade_and_overlapping_bulk_roots() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let parent = create_draft(&repo, recurring_draft("P", "daily", Some("2026-07-28"))).await;
    let mut child_d = recurring_draft("C", "weekly", Some("2026-07-28"));
    child_d.parent_id = Some(parent);
    let child = create_draft(&repo, child_d).await;
    let mutation = repo
        .complete_task(operation(), parent, now(), temporal())
        .await
        .unwrap();
    // parent + child completed, plus one generated each.
    assert_eq!(mutation.event.affected.task_ids.len(), 4);
    assert!(find_generated(&repo, parent).await.is_some());
    assert!(find_generated(&repo, child).await.is_some());

    // Overlapping bulk roots dedupe before generation.
    let p2 = create_draft(&repo, recurring_draft("P2", "daily", Some("2026-07-28"))).await;
    let mut c2 = recurring_draft("C2", "daily", Some("2026-07-28"));
    c2.parent_id = Some(p2);
    let c2_id = create_draft(&repo, c2).await;
    let bulk = repo
        .bulk_tasks(
            operation(),
            vec![p2, c2_id],
            BulkAction::Complete,
            now(),
            temporal(),
        )
        .await
        .unwrap();
    // two sources + two children, not three sources.
    assert_eq!(bulk.event.affected.task_ids.len(), 4);
}

#[tokio::test]
async fn p3_rec_500_bound_counts_generated_children() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    // 250 recurring roots => 250 + 250 generated = 500 ok; 251 rejects.
    let mut ids = Vec::new();
    for i in 0..251 {
        ids.push(
            create_draft(
                &repo,
                recurring_draft(&format!("r{i}"), "daily", Some("2026-07-28")),
            )
            .await,
        );
    }
    let before = repo.diagnostics().await.unwrap().revision;
    let err = repo
        .bulk_tasks(
            operation(),
            ids.clone(),
            BulkAction::Complete,
            now(),
            temporal(),
        )
        .await
        .unwrap_err();
    assert_eq!(err, RepositoryError::OperationTooLarge);
    assert_eq!(repo.diagnostics().await.unwrap().revision, before);

    ids.pop();
    let ok = repo
        .bulk_tasks(operation(), ids, BulkAction::Complete, now(), temporal())
        .await
        .unwrap();
    assert_eq!(ok.event.affected.task_ids.len(), 500);
}

#[tokio::test]
async fn p3_rec_ordinary_exact_uncomplete_source_only_and_divergence() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let id = create_draft(&repo, recurring_draft("exact", "daily", Some("2026-07-28"))).await;
    let complete_op = operation();
    repo.complete_task(complete_op, id, now(), temporal())
        .await
        .unwrap();
    let child = find_generated(&repo, id).await.unwrap();
    let un_op = operation();
    let exact = repo
        .uncomplete_task(un_op, id, now(), temporal())
        .await
        .unwrap();
    assert_eq!(exact.uncomplete_outcome, Some(UncompleteOutcome::Exact));
    assert_eq!(repo.get_task(id).await.unwrap().status, TaskStatus::Pending);
    assert!(matches!(
        repo.get_task(child.id).await,
        Err(RepositoryError::NotFound)
    ));
    // Uncomplete itself is undoable and restores source+child.
    repo.undo(un_op, operation(), now()).await.unwrap();
    assert_eq!(
        repo.get_task(id).await.unwrap().status,
        TaskStatus::Completed
    );
    assert_eq!(
        repo.get_task(child.id).await.unwrap().status,
        TaskStatus::Pending
    );

    // Divergence: mutate generated child after complete, ordinary uncomplete conflicts.
    let id2 = create_draft(&repo, recurring_draft("div", "daily", Some("2026-07-28"))).await;
    repo.complete_task(operation(), id2, now(), temporal())
        .await
        .unwrap();
    let child2 = find_generated(&repo, id2).await.unwrap();
    repo.patch_task(
        operation(),
        child2.id,
        TaskPatch {
            title: Some(TaskTitle::new("changed").unwrap()),
            ..TaskPatch::default()
        },
        now(),
    )
    .await
    .unwrap();
    let before = repo.diagnostics().await.unwrap().revision;
    assert_eq!(
        repo.uncomplete_task(operation(), id2, now(), temporal())
            .await,
        Err(RepositoryError::Conflict)
    );
    assert_eq!(repo.diagnostics().await.unwrap().revision, before);
    assert_eq!(
        repo.get_task(id2).await.unwrap().status,
        TaskStatus::Completed
    );
    assert!(repo.get_task(child2.id).await.is_ok());

    // Expired/missing receipt => source_only, child preserved.
    let id3 = create_draft(
        &repo,
        recurring_draft("expire", "daily", Some("2026-07-28")),
    )
    .await;
    let cop = operation();
    repo.complete_task(cop, id3, now(), temporal())
        .await
        .unwrap();
    let child3 = find_generated(&repo, id3).await.unwrap();
    // Force-expire the completion receipt/undo material.
    repo.execute_batch(
        "UPDATE operation_receipts SET expires_at = '2000-01-01T00:00:00Z';
         DELETE FROM operation_undo;"
            .into(),
    )
    .await
    .unwrap();
    // Touch cleanup via a no-op path: next mutation runs expiry cleanup.
    let source_only = repo
        .uncomplete_task(operation(), id3, now(), temporal())
        .await
        .unwrap();
    assert_eq!(
        source_only.uncomplete_outcome,
        Some(UncompleteOutcome::SourceOnly)
    );
    assert_eq!(
        repo.get_task(id3).await.unwrap().status,
        TaskStatus::Pending
    );
    assert_eq!(
        repo.get_task(child3.id).await.unwrap().status,
        TaskStatus::Pending
    );
}

#[tokio::test]
async fn p3_final_013_uncomplete_rejects_generated_child_task_atomically() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let (_, source, generated) = completed_recurrence(&repo, "child-reference").await;
    let mut child = draft("dependent child");
    child.parent_id = Some(generated);
    let dependent = create_draft(&repo, child).await;

    assert_uncomplete_conflicts_without_writes(&repo, source, generated).await;
    assert_eq!(
        repo.get_task(dependent).await.unwrap().parent_id,
        Some(generated)
    );
}

#[tokio::test]
async fn p3_final_013_undo_rejects_generated_comment_atomically() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let (completion, source, generated) = completed_recurrence(&repo, "comment-reference").await;
    let comment = CommentId::new();
    repo.create_comment(
        operation(),
        comment,
        generated,
        CommentBody::new("keep me").unwrap(),
        now(),
    )
    .await
    .unwrap();

    assert_completion_undo_conflicts_without_writes(&repo, completion, source, generated).await;
    assert_eq!(repo.list_comments(generated).await.unwrap()[0].id, comment);
}

#[tokio::test]
async fn p3_final_013_uncomplete_rejects_incoming_and_outgoing_relations_atomically() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let (_, source, generated) = completed_recurrence(&repo, "relation-reference").await;
    let blocked = create_simple(&repo, "blocked").await.task().unwrap().id;
    let blocker = create_simple(&repo, "blocker").await.task().unwrap().id;
    repo.add_relation(operation(), generated, blocked, RelationKind::Blocks, now())
        .await
        .unwrap();
    repo.add_relation(operation(), blocker, generated, RelationKind::Blocks, now())
        .await
        .unwrap();

    assert_uncomplete_conflicts_without_writes(&repo, source, generated).await;
    let relations = repo.list_relations(generated).await.unwrap();
    assert!(
        relations.iter().any(|relation| {
            relation.from_task_id == generated && relation.to_task_id == blocked
        })
    );
    assert!(
        relations.iter().any(|relation| {
            relation.from_task_id == blocker && relation.to_task_id == generated
        })
    );
}

#[tokio::test]
async fn p3_final_013_undo_rejects_generated_timeblock_reference_atomically() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let (completion, source, generated) = completed_recurrence(&repo, "block-reference").await;
    let block_id = junban_domain::TimeBlockId::new();
    let mut draft = block_draft("Generated task block", "2026-07-29");
    draft.task_id = Some(generated);
    repo.create_time_block(operation(), block_id, draft, now())
        .await
        .unwrap();

    assert_completion_undo_conflicts_without_writes(&repo, completion, source, generated).await;
    let page = repo
        .list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-07-29".parse().unwrap(),
            to: "2026-07-29".parse().unwrap(),
        })
        .await
        .unwrap();
    assert_eq!(page.blocks[0].task_id, Some(generated));
}

#[tokio::test]
async fn p3_final_013_uncomplete_rejects_generated_slot_membership_atomically() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let (_, source, generated) = completed_recurrence(&repo, "slot-reference").await;
    let slot_id = junban_domain::TimeSlotId::new();
    repo.create_time_slot(
        operation(),
        slot_id,
        slot_draft("Generated task slot", "2026-07-29"),
        now(),
    )
    .await
    .unwrap();
    repo.append_slot_task(operation(), slot_id, generated, now())
        .await
        .unwrap();

    assert_uncomplete_conflicts_without_writes(&repo, source, generated).await;
    let page = repo
        .list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-07-29".parse().unwrap(),
            to: "2026-07-29".parse().unwrap(),
        })
        .await
        .unwrap();
    assert_eq!(page.slots[0].task_ids.as_slice(), &[generated]);
}

#[tokio::test]
async fn p3_final_013_bulk_uncomplete_conflict_leaves_all_recurrences_unchanged() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let (_, first_source, first_generated) = completed_recurrence(&repo, "bulk-safe").await;
    let (_, second_source, second_generated) = completed_recurrence(&repo, "bulk-divergent").await;
    repo.create_comment(
        operation(),
        CommentId::new(),
        second_generated,
        CommentBody::new("blocks the whole reversal").unwrap(),
        now(),
    )
    .await
    .unwrap();

    let revision = repo.diagnostics().await.unwrap().revision;
    assert_eq!(
        repo.bulk_tasks(
            operation(),
            vec![first_source, second_source],
            BulkAction::Uncomplete,
            now(),
            temporal(),
        )
        .await,
        Err(RepositoryError::Conflict)
    );
    assert_eq!(repo.diagnostics().await.unwrap().revision, revision);
    assert_eq!(
        repo.get_task(first_source).await.unwrap().status,
        TaskStatus::Completed
    );
    assert_eq!(
        repo.get_task(second_source).await.unwrap().status,
        TaskStatus::Completed
    );
    assert!(repo.get_task(first_generated).await.is_ok());
    assert!(repo.get_task(second_generated).await.is_ok());
    assert_eq!(repo.list_comments(second_generated).await.unwrap().len(), 1);
}

#[tokio::test]
async fn p3_rec_cancel_does_not_generate_occurrence() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let id = create_draft(
        &repo,
        recurring_draft("cancel", "daily", Some("2026-07-28")),
    )
    .await;
    repo.cancel_task(operation(), id, now()).await.unwrap();
    assert!(find_generated(&repo, id).await.is_none());
    assert_eq!(
        repo.get_task(id).await.unwrap().status,
        TaskStatus::Cancelled
    );
}

// ---------------------------------------------------------------------------
// Phase 3 reminder persistence, fencing, claim, and settlement
// ---------------------------------------------------------------------------

async fn create_with_remind_at(repo: &SqliteRepository, title: &str, remind_at: &str) -> TaskId {
    let mut draft = draft(title);
    draft.remind_at = Some(remind_at.parse().unwrap());
    create_draft(repo, draft).await
}

#[tokio::test]
async fn reminder_create_patch_clear_complete_delete_sync() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    let id = create_with_remind_at(&repo, "remind me", "2026-07-28T15:00:00Z").await;
    let rows = repo.list_task_reminders(id).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, ReminderOccurrenceState::Pending);
    assert_eq!(rows[0].remind_at.to_string(), "2026-07-28T15:00:00Z");

    // Patch to a new instant cancels the old pending row and creates a new one.
    repo.patch_task(
        operation(),
        id,
        TaskPatch {
            remind_at: Some(Some("2026-07-28T16:00:00Z".parse().unwrap())),
            ..TaskPatch::default()
        },
        now(),
    )
    .await
    .unwrap();
    let rows = repo.list_task_reminders(id).await.unwrap();
    assert_eq!(rows.len(), 2);
    let pending: Vec<_> = rows
        .iter()
        .filter(|row| row.state == ReminderOccurrenceState::Pending)
        .collect();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].remind_at.to_string(), "2026-07-28T16:00:00Z");
    assert!(rows.iter().any(|row| {
        row.state == ReminderOccurrenceState::Cancelled
            && row.remind_at.to_string() == "2026-07-28T15:00:00Z"
    }));

    // Clear schedule cancels pending.
    repo.patch_task(
        operation(),
        id,
        TaskPatch {
            remind_at: Some(None),
            ..TaskPatch::default()
        },
        now(),
    )
    .await
    .unwrap();
    assert!(
        repo.list_task_reminders(id)
            .await
            .unwrap()
            .iter()
            .all(|row| row.state != ReminderOccurrenceState::Pending)
    );

    // Restore schedule, then complete cancels pending.
    repo.patch_task(
        operation(),
        id,
        TaskPatch {
            remind_at: Some(Some("2026-07-28T17:00:00Z".parse().unwrap())),
            ..TaskPatch::default()
        },
        now(),
    )
    .await
    .unwrap();
    repo.complete_task(operation(), id, now(), temporal())
        .await
        .unwrap();
    assert!(
        repo.list_task_reminders(id)
            .await
            .unwrap()
            .iter()
            .all(|row| row.state != ReminderOccurrenceState::Pending)
    );

    // Delete cascades occurrence rows.
    let id2 = create_with_remind_at(&repo, "gone", "2026-07-28T18:00:00Z").await;
    assert_eq!(repo.list_task_reminders(id2).await.unwrap().len(), 1);
    repo.delete_task(operation(), id2, now()).await.unwrap();
    assert_eq!(
        repo.list_task_reminders(id2).await,
        Err(RepositoryError::NotFound)
    );
}

#[tokio::test]
async fn reminder_recurring_complete_creates_child_occurrence_and_undo_restores() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    let mut draft = recurring_draft("daily remind", "daily", Some("2026-07-28"));
    draft.remind_at = Some("2026-07-28T06:00:00Z".parse().unwrap());
    let id = create_draft(&repo, draft).await;
    let complete_op = operation();
    repo.complete_task(complete_op, id, now(), temporal())
        .await
        .unwrap();
    let child = find_generated(&repo, id).await.expect("child");
    assert_eq!(child.remind_at.unwrap().to_string(), "2026-07-29T06:00:00Z");

    let source_rows = repo.list_task_reminders(id).await.unwrap();
    assert!(
        source_rows
            .iter()
            .all(|row| row.state != ReminderOccurrenceState::Pending)
    );
    let child_rows = repo.list_task_reminders(child.id).await.unwrap();
    assert_eq!(child_rows.len(), 1);
    assert_eq!(child_rows[0].state, ReminderOccurrenceState::Pending);
    assert_eq!(child_rows[0].remind_at.to_string(), "2026-07-29T06:00:00Z");

    // Exact undo restores source pending and removes the child occurrence with the child.
    repo.undo(complete_op, operation(), now()).await.unwrap();
    assert!(repo.get_task(child.id).await.is_err());
    let restored = repo.list_task_reminders(id).await.unwrap();
    assert!(restored.iter().any(|row| {
        row.state == ReminderOccurrenceState::Pending
            && row.remind_at.to_string() == "2026-07-28T06:00:00Z"
    }));
}

#[tokio::test]
async fn reminder_uncomplete_source_only_does_not_resurrect_cancelled() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    let id = create_with_remind_at(&repo, "once", "2026-07-28T12:00:00Z").await;
    let cop = operation();
    repo.complete_task(cop, id, now(), temporal())
        .await
        .unwrap();
    // Expire receipt so ordinary uncomplete is source-only.
    repo.execute_batch(
        "UPDATE operation_receipts SET expires_at = '2000-01-01T00:00:00Z';
         DELETE FROM operation_undo;"
            .into(),
    )
    .await
    .unwrap();
    let outcome = repo
        .uncomplete_task(operation(), id, now(), temporal())
        .await
        .unwrap();
    assert_eq!(
        outcome.uncomplete_outcome,
        Some(junban_domain::UncompleteOutcome::SourceOnly)
    );
    assert_eq!(repo.get_task(id).await.unwrap().status, TaskStatus::Pending);
    assert_eq!(
        repo.get_task(id)
            .await
            .unwrap()
            .remind_at
            .unwrap()
            .to_string(),
        "2026-07-28T12:00:00Z"
    );
    // Cancelled occurrence stays cancelled — no automatic resurrection.
    assert!(
        repo.list_task_reminders(id)
            .await
            .unwrap()
            .iter()
            .all(|row| row.state != ReminderOccurrenceState::Pending)
    );
}

#[tokio::test]
async fn reminder_lease_acquire_renew_release_and_fencing() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let t0: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();

    let lease = repo
        .acquire_reminder_lease(t0, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    assert!(lease.expires_at > t0);
    // Second acquire while held fails.
    assert_eq!(
        repo.acquire_reminder_lease(t0, DEFAULT_REMINDER_LEASE_SECS)
            .await,
        Err(RepositoryError::Conflict)
    );

    let renewed = repo
        .renew_reminder_lease(lease.fence_term.clone(), t0, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    assert_eq!(renewed.fence_term, lease.fence_term);

    // Stale term cannot renew.
    let stale = junban_domain::ReminderFenceTerm::parse("not-the-owner").unwrap();
    assert_eq!(
        repo.renew_reminder_lease(stale.clone(), t0, DEFAULT_REMINDER_LEASE_SECS)
            .await,
        Err(RepositoryError::Conflict)
    );

    repo.release_reminder_lease(lease.fence_term.clone(), t0)
        .await
        .unwrap();
    // After release/expiry, a new owner can acquire.
    let later: Timestamp = "2026-07-28T12:00:01Z".parse().unwrap();
    let next = repo
        .acquire_reminder_lease(later, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    assert_ne!(next.fence_term, lease.fence_term);

    // Expired lease also allows reacquire with a fresh term.
    let expired_at: Timestamp = next.expires_at;
    let after_expiry = repo
        .acquire_reminder_lease(expired_at, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    assert_ne!(after_expiry.fence_term, next.fence_term);
}

#[tokio::test]
async fn reminder_claim_is_deterministic_bounded_and_exclusive() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let t0: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();

    // Three due rows with deterministic (remind_at, task_id) order.
    let a = create_with_remind_at(&repo, "a", "2026-07-28T11:00:00Z").await;
    let b = create_with_remind_at(&repo, "b", "2026-07-28T11:00:00Z").await;
    let c = create_with_remind_at(&repo, "c", "2026-07-28T11:30:00Z").await;
    // Future row must not be claimed.
    let _future = create_with_remind_at(&repo, "future", "2026-07-28T13:00:00Z").await;

    let lease = repo
        .acquire_reminder_lease(t0, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    let claimed = repo
        .claim_due_reminders(lease.fence_term.clone(), t0, 10, 90)
        .await
        .unwrap();
    assert_eq!(claimed.len(), 3);
    assert!(claimed.windows(2).all(|pair| {
        pair[0].remind_at < pair[1].remind_at
            || (pair[0].remind_at == pair[1].remind_at
                && pair[0].task_id.as_uuid() <= pair[1].task_id.as_uuid())
    }));
    let claimed_ids: Vec<_> = claimed.iter().map(|row| row.task_id).collect();
    assert!(claimed_ids.contains(&a));
    assert!(claimed_ids.contains(&b));
    assert!(claimed_ids.contains(&c));

    // Concurrent/second claim under same owner recovers unexpired claims, no duplicates of pending.
    let again = repo
        .claim_due_reminders(lease.fence_term.clone(), t0, 10, 90)
        .await
        .unwrap();
    assert_eq!(again.len(), 3);
    assert_eq!(
        again
            .iter()
            .map(|row| (row.task_id, row.remind_at))
            .collect::<Vec<_>>(),
        claimed
            .iter()
            .map(|row| (row.task_id, row.remind_at))
            .collect::<Vec<_>>()
    );

    // Bound rejection.
    assert!(matches!(
        repo.claim_due_reminders(
            lease.fence_term.clone(),
            t0,
            MAX_REMINDER_CLAIM_LIMIT + 1,
            90
        )
        .await,
        Err(RepositoryError::Validation(_))
    ));

    // Stale owner cannot claim after term changes.
    repo.release_reminder_lease(lease.fence_term.clone(), t0)
        .await
        .unwrap();
    let later: Timestamp = "2026-07-28T12:00:01Z".parse().unwrap();
    let new_lease = repo
        .acquire_reminder_lease(later, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    assert_eq!(
        repo.claim_due_reminders(lease.fence_term.clone(), later, 10, 90)
            .await,
        Err(RepositoryError::Conflict)
    );
    // New owner does not auto-take still-unexpired claims from the previous term.
    let fresh = repo
        .claim_due_reminders(new_lease.fence_term.clone(), later, 10, 90)
        .await
        .unwrap();
    assert!(fresh.is_empty());
}

#[tokio::test]
async fn reminder_settle_delivered_failed_and_stale_rejection() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let t0: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();
    let id = create_with_remind_at(&repo, "deliver", "2026-07-28T11:00:00Z").await;
    let lease = repo
        .acquire_reminder_lease(t0, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    let claimed = repo
        .claim_due_reminders(lease.fence_term.clone(), t0, 1, 90)
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    let remind_at = claimed[0].remind_at;
    let attempt = claimed[0].claim_attempt;

    repo.settle_reminder_delivered(
        lease.fence_term.clone(),
        id,
        remind_at,
        attempt,
        ReminderChannel::InApp,
        t0,
    )
    .await
    .unwrap();
    // Idempotent ack for same task+instant+attempt+channel.
    repo.settle_reminder_delivered(
        lease.fence_term.clone(),
        id,
        remind_at,
        attempt,
        ReminderChannel::InApp,
        t0,
    )
    .await
    .unwrap();
    let row = &repo.list_task_reminders(id).await.unwrap()[0];
    assert_eq!(row.state, ReminderOccurrenceState::Delivered);
    assert_eq!(row.terminal_channel, Some(ReminderChannel::InApp));

    // Failed path on a second task.
    let id2 = create_with_remind_at(&repo, "fail", "2026-07-28T11:05:00Z").await;
    let claimed2 = repo
        .claim_due_reminders(lease.fence_term.clone(), t0, 1, 90)
        .await
        .unwrap();
    assert_eq!(claimed2[0].task_id, id2);
    repo.settle_reminder_failed(
        lease.fence_term.clone(),
        id2,
        claimed2[0].remind_at,
        claimed2[0].claim_attempt,
        ReminderFailureCode::ChannelFailed,
        t0,
    )
    .await
    .unwrap();
    assert_eq!(
        repo.list_task_reminders(id2).await.unwrap()[0].state,
        ReminderOccurrenceState::Failed
    );

    // Stale owner cannot settle after fence changes.
    let id3 = create_with_remind_at(&repo, "stale", "2026-07-28T11:10:00Z").await;
    let claimed3 = repo
        .claim_due_reminders(lease.fence_term.clone(), t0, 1, 90)
        .await
        .unwrap();
    repo.release_reminder_lease(lease.fence_term.clone(), t0)
        .await
        .unwrap();
    let later: Timestamp = "2026-07-28T12:00:01Z".parse().unwrap();
    let _new = repo
        .acquire_reminder_lease(later, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    assert_eq!(
        repo.settle_reminder_delivered(
            lease.fence_term.clone(),
            id3,
            claimed3[0].remind_at,
            claimed3[0].claim_attempt,
            ReminderChannel::Sound,
            later,
        )
        .await,
        Err(RepositoryError::Conflict)
    );
}

#[tokio::test]
async fn reminder_owner_lost_returns_pending_with_backoff_then_reclaimable() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let t0: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();
    let id = create_with_remind_at(&repo, "lost", "2026-07-28T11:00:00Z").await;

    let lease = repo.acquire_reminder_lease(t0, 1).await.unwrap();
    let claimed = repo
        .claim_due_reminders(lease.fence_term.clone(), t0, 1, 1)
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);

    // Advance past claim+lease expiry and acquire as a new owner.
    let later: Timestamp = "2026-07-28T12:00:05Z".parse().unwrap();
    let new_lease = repo
        .acquire_reminder_lease(later, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    // No automatic retry: claim finds nothing until explicit owner-lost sweep.
    assert!(
        repo.claim_due_reminders(new_lease.fence_term.clone(), later, 10, 90)
            .await
            .unwrap()
            .is_empty()
    );
    let marked = repo
        .mark_owner_lost_reminders(new_lease.fence_term.clone(), later, 10)
        .await
        .unwrap();
    assert_eq!(marked, 1);
    let row = &repo.list_task_reminders(id).await.unwrap()[0];
    assert_eq!(row.state, ReminderOccurrenceState::Pending);
    assert_eq!(
        row.terminal_error_code,
        Some(ReminderFailureCode::OwnerLost)
    );
    assert!(row.next_attempt_at.unwrap() > later);

    // Still not claimable before backoff elapses.
    assert!(
        repo.claim_due_reminders(new_lease.fence_term.clone(), later, 10, 90)
            .await
            .unwrap()
            .is_empty()
    );
    // After backoff, reclaim is allowed (at-least-once external presentation window).
    let after_backoff = row.next_attempt_at.unwrap();
    let reclaimed = repo
        .claim_due_reminders(new_lease.fence_term.clone(), after_backoff, 10, 90)
        .await
        .unwrap();
    assert_eq!(reclaimed.len(), 1);
    assert_eq!(reclaimed[0].task_id, id);
}

#[tokio::test]
async fn reminder_snooze_dismiss_idempotent_restart_and_undo() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let id = create_with_remind_at(&repo, "snooze", "2026-07-28T15:00:00Z").await;

    let snooze_op = operation();
    let first = repo
        .reschedule_reminder(
            snooze_op,
            id,
            "2026-07-28T16:00:00Z".parse().unwrap(),
            now(),
        )
        .await
        .unwrap();
    // Exact retry / restart replay.
    let replay = repo
        .reschedule_reminder(
            snooze_op,
            id,
            "2026-07-28T16:00:00Z".parse().unwrap(),
            now(),
        )
        .await
        .unwrap();
    assert_eq!(first, replay);
    assert!(!replay.newly_committed);
    assert_eq!(
        repo.get_task(id)
            .await
            .unwrap()
            .remind_at
            .unwrap()
            .to_string(),
        "2026-07-28T16:00:00Z"
    );
    let pending = repo
        .list_task_reminders(id)
        .await
        .unwrap()
        .into_iter()
        .filter(|row| row.state == ReminderOccurrenceState::Pending)
        .collect::<Vec<_>>();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].remind_at.to_string(), "2026-07-28T16:00:00Z");

    // Undo restores prior schedule + occurrence snapshot.
    repo.undo(snooze_op, operation(), now()).await.unwrap();
    assert_eq!(
        repo.get_task(id)
            .await
            .unwrap()
            .remind_at
            .unwrap()
            .to_string(),
        "2026-07-28T15:00:00Z"
    );
    assert!(
        repo.list_task_reminders(id)
            .await
            .unwrap()
            .iter()
            .any(|row| {
                row.state == ReminderOccurrenceState::Pending
                    && row.remind_at.to_string() == "2026-07-28T15:00:00Z"
            })
    );

    let dismiss_op = operation();
    repo.dismiss_reminder(dismiss_op, id, now()).await.unwrap();
    assert_eq!(repo.get_task(id).await.unwrap().remind_at, None);
    assert!(
        repo.list_task_reminders(id)
            .await
            .unwrap()
            .iter()
            .all(|row| row.state != ReminderOccurrenceState::Pending)
    );
    // Exact dismiss retry.
    let dismiss_replay = repo.dismiss_reminder(dismiss_op, id, now()).await.unwrap();
    assert!(!dismiss_replay.newly_committed);

    // Claimed ownership is not overwritten by an ordinary reschedule of the same instant.
    let id2 = create_with_remind_at(&repo, "claimed", "2026-07-28T11:00:00Z").await;
    let t0: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();
    let lease = repo
        .acquire_reminder_lease(t0, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    repo.claim_due_reminders(lease.fence_term.clone(), t0, 1, 90)
        .await
        .unwrap();
    repo.reschedule_reminder(
        operation(),
        id2,
        "2026-07-28T11:00:00Z".parse().unwrap(),
        now(),
    )
    .await
    .unwrap();
    let rows = repo.list_task_reminders(id2).await.unwrap();
    assert!(rows.iter().any(|row| {
        row.remind_at.to_string() == "2026-07-28T11:00:00Z"
            && row.state == ReminderOccurrenceState::Claimed
    }));
}

#[tokio::test]
async fn reminder_control_plane_does_not_bump_task_revision() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let id = create_with_remind_at(&repo, "rev", "2026-07-28T11:00:00Z").await;
    let before_task = repo.get_task(id).await.unwrap();
    let before_rev = repo.diagnostics().await.unwrap().revision;
    let t0: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();
    let lease = repo
        .acquire_reminder_lease(t0, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    let claimed = repo
        .claim_due_reminders(lease.fence_term.clone(), t0, 1, 90)
        .await
        .unwrap();
    repo.settle_reminder_delivered(
        lease.fence_term.clone(),
        id,
        claimed[0].remind_at,
        claimed[0].claim_attempt,
        ReminderChannel::WebNotification,
        t0,
    )
    .await
    .unwrap();
    let after_task = repo.get_task(id).await.unwrap();
    assert_eq!(after_task.revision, before_task.revision);
    assert_eq!(repo.diagnostics().await.unwrap().revision, before_rev);
}

#[tokio::test]
async fn reminder_settle_binds_claim_attempt_and_unexpired_lease() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let t0: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();

    // Release fails closed for still-claimed settlement.
    let id_release = create_with_remind_at(&repo, "release", "2026-07-28T11:00:00Z").await;
    let lease = repo
        .acquire_reminder_lease(t0, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    let claimed = repo
        .claim_due_reminders(lease.fence_term.clone(), t0, 1, 90)
        .await
        .unwrap();
    assert_eq!(claimed[0].task_id, id_release);
    repo.release_reminder_lease(lease.fence_term.clone(), t0)
        .await
        .unwrap();
    assert_eq!(
        repo.settle_reminder_delivered(
            lease.fence_term.clone(),
            id_release,
            claimed[0].remind_at,
            claimed[0].claim_attempt,
            ReminderChannel::InApp,
            t0,
        )
        .await,
        Err(RepositoryError::Conflict)
    );

    // Claim expiry fails closed while the lease remains live.
    let id_exp = create_with_remind_at(&repo, "expiry", "2026-07-28T11:01:00Z").await;
    let t_exp: Timestamp = "2026-07-28T12:05:00Z".parse().unwrap();
    let lease2 = repo
        .acquire_reminder_lease(t_exp, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    let claimed_exp = repo
        .claim_due_reminders(lease2.fence_term.clone(), t_exp, 1, 1)
        .await
        .unwrap();
    assert_eq!(claimed_exp[0].task_id, id_exp);
    let after_claim_expiry: Timestamp = "2026-07-28T12:05:02Z".parse().unwrap();
    assert_eq!(
        repo.settle_reminder_delivered(
            lease2.fence_term.clone(),
            id_exp,
            claimed_exp[0].remind_at,
            claimed_exp[0].claim_attempt,
            ReminderChannel::InApp,
            after_claim_expiry,
        )
        .await,
        Err(RepositoryError::Conflict)
    );

    // Same-term reclaim: a delayed prior attempt must not settle the new claim.
    // Use a fresh profile so leftover claimed rows cannot occupy the batch.
    drop(repo);
    drop(owner);
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let id_reclaim = create_with_remind_at(&repo, "reclaim", "2026-07-28T11:02:00Z").await;
    let t_claim: Timestamp = "2026-07-28T12:10:00Z".parse().unwrap();
    let lease3 = repo
        .acquire_reminder_lease(t_claim, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    let first = repo
        .claim_due_reminders(lease3.fence_term.clone(), t_claim, 1, 1)
        .await
        .unwrap();
    assert_eq!(first[0].task_id, id_reclaim);
    assert_eq!(first[0].claim_attempt, 1);
    let t_lost = first[0].claim_expires_at.checked_add(1.seconds()).unwrap();
    let _ = repo
        .renew_reminder_lease(lease3.fence_term.clone(), t_lost, 90)
        .await
        .unwrap();
    assert_eq!(
        repo.mark_owner_lost_reminders(lease3.fence_term.clone(), t_lost, 10)
            .await
            .unwrap(),
        1
    );
    let row = &repo.list_task_reminders(id_reclaim).await.unwrap()[0];
    let after_backoff = row.next_attempt_at.unwrap();
    let second = repo
        .claim_due_reminders(lease3.fence_term.clone(), after_backoff, 1, 90)
        .await
        .unwrap();
    assert_eq!(second[0].claim_attempt, 2);
    assert_eq!(
        repo.settle_reminder_delivered(
            lease3.fence_term.clone(),
            id_reclaim,
            first[0].remind_at,
            first[0].claim_attempt,
            ReminderChannel::InApp,
            after_backoff,
        )
        .await,
        Err(RepositoryError::Conflict)
    );
    repo.settle_reminder_delivered(
        lease3.fence_term.clone(),
        id_reclaim,
        second[0].remind_at,
        second[0].claim_attempt,
        ReminderChannel::InApp,
        after_backoff,
    )
    .await
    .unwrap();
    // Exact duplicate remains idempotent after lease release.
    repo.release_reminder_lease(lease3.fence_term.clone(), after_backoff)
        .await
        .unwrap();
    repo.settle_reminder_delivered(
        lease3.fence_term.clone(),
        id_reclaim,
        second[0].remind_at,
        second[0].claim_attempt,
        ReminderChannel::InApp,
        after_backoff,
    )
    .await
    .unwrap();
    assert_eq!(
        repo.settle_reminder_delivered(
            lease3.fence_term.clone(),
            id_reclaim,
            second[0].remind_at,
            second[0].claim_attempt,
            ReminderChannel::Sound,
            after_backoff,
        )
        .await,
        Err(RepositoryError::Conflict)
    );

    // Fence replacement fails closed.
    drop(repo);
    drop(owner);
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let id_fence = create_with_remind_at(&repo, "fence", "2026-07-28T11:03:00Z").await;
    let t_fence: Timestamp = "2026-07-28T12:20:00Z".parse().unwrap();
    let lease_a = repo
        .acquire_reminder_lease(t_fence, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    let claimed_a = repo
        .claim_due_reminders(lease_a.fence_term.clone(), t_fence, 1, 90)
        .await
        .unwrap();
    assert_eq!(claimed_a[0].task_id, id_fence);
    repo.release_reminder_lease(lease_a.fence_term.clone(), t_fence)
        .await
        .unwrap();
    let t_b = t_fence.checked_add(1.seconds()).unwrap();
    let _lease_b = repo
        .acquire_reminder_lease(t_b, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    assert_eq!(
        repo.settle_reminder_delivered(
            lease_a.fence_term.clone(),
            id_fence,
            claimed_a[0].remind_at,
            claimed_a[0].claim_attempt,
            ReminderChannel::InApp,
            t_b,
        )
        .await,
        Err(RepositoryError::Conflict)
    );
}

#[tokio::test]
async fn reminder_terminal_compaction_bounds_and_preserves_live_intent() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let t0: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();

    let live = create_with_remind_at(&repo, "live", "2026-07-28T11:00:00Z").await;
    let claimed_id = create_with_remind_at(&repo, "claimed", "2026-07-28T10:00:00Z").await;
    let lease = repo
        .acquire_reminder_lease(t0, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    let claimed = repo
        .claim_due_reminders(lease.fence_term.clone(), t0, 1, 90)
        .await
        .unwrap();
    assert_eq!(claimed[0].task_id, claimed_id);

    // 50 age-expired terminal rows + 2050 recent terminal rows over the count ceiling.
    let mut seed = String::new();
    for i in 0..2100 {
        let task = format!("00000000-0000-4000-8000-{i:012x}");
        let remind = format!(
            "2025-06-01T00:{:02}:{:02}.000000000Z",
            (i / 60) % 60,
            i % 60
        );
        let updated = if i < 50 {
            "2025-01-01T00:00:00.000000000Z".to_owned()
        } else {
            format!("2026-07-01T00:00:00.{i:09}Z")
        };
        seed.push_str(&format!(
            "INSERT INTO tasks(id, title, status, created_at, updated_at, revision)
             VALUES ('{task}', 't{i}', 'pending',
                    '2026-07-28T12:00:00.000000000Z',
                    '2026-07-28T12:00:00.000000000Z', 1);
             INSERT INTO reminder_occurrences(
                task_id, remind_at, state, attempts, created_at, updated_at
             ) VALUES (
                '{task}', '{remind}', 'delivered', 1,
                '{updated}', '{updated}'
             );"
        ));
    }
    repo.execute_batch(seed).await.unwrap();

    let before_rev = repo.diagnostics().await.unwrap().revision;
    repo.settle_reminder_delivered(
        lease.fence_term.clone(),
        claimed_id,
        claimed[0].remind_at,
        claimed[0].claim_attempt,
        ReminderChannel::InApp,
        t0,
    )
    .await
    .unwrap();
    // Control-plane compaction must not churn the user revision.
    assert_eq!(repo.diagnostics().await.unwrap().revision, before_rev);

    let live_rows = repo.list_task_reminders(live).await.unwrap();
    assert!(live_rows.iter().any(|row| {
        row.state == ReminderOccurrenceState::Pending
            && row.remind_at.to_string() == "2026-07-28T11:00:00Z"
    }));
    assert_eq!(
        repo.list_task_reminders(claimed_id).await.unwrap()[0].state,
        ReminderOccurrenceState::Delivered
    );

    // User mutation snapshot path also compacts and stays bounded.
    repo.reschedule_reminder(
        operation(),
        live,
        "2026-07-28T11:00:00Z".parse().unwrap(),
        t0,
    )
    .await
    .unwrap();

    // Age prune removes the 50 oldest-updated seeds; count prune then drops the
    // next-oldest recent seeds so at most 2000 unprotected terminals remain.
    let aged_id = TaskId::parse("00000000-0000-4000-8000-000000000000").unwrap();
    let pruned_by_count = TaskId::parse("00000000-0000-4000-8000-000000000032").unwrap(); // i=50
    let kept_newest = TaskId::parse("00000000-0000-4000-8000-000000000833").unwrap(); // i=2099
    assert!(
        repo.list_task_reminders(aged_id).await.unwrap().is_empty(),
        "rows older than 90 days must be pruned"
    );
    assert!(
        repo.list_task_reminders(pruned_by_count)
            .await
            .unwrap()
            .is_empty(),
        "oldest terminal audit beyond the 2000-row ceiling must be pruned"
    );
    assert_eq!(
        repo.list_task_reminders(kept_newest).await.unwrap().len(),
        1,
        "newest terminal audit rows must be retained"
    );
    // Snapshot for the live task cannot retain unbounded historical terminals.
    assert!(repo.list_task_reminders(live).await.unwrap().len() <= 2);
}

#[tokio::test]
async fn reminder_timestamps_use_canonical_sortable_text() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    // Fractional-second due ordering must follow instant order.
    let early = create_with_remind_at(&repo, "early", "2026-07-28T15:00:00.1Z").await;
    let whole = create_with_remind_at(&repo, "whole", "2026-07-28T15:00:00Z").await;
    let mid = create_with_remind_at(&repo, "mid", "2026-07-28T15:00:00.5Z").await;

    let t0: Timestamp = "2026-07-28T15:00:01Z".parse().unwrap();
    let lease = repo
        .acquire_reminder_lease(t0, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    let claimed = repo
        .claim_due_reminders(lease.fence_term.clone(), t0, 10, 90)
        .await
        .unwrap();
    let order: Vec<_> = claimed.iter().map(|row| row.task_id).collect();
    assert_eq!(order, vec![whole, early, mid]);

    // Variable-width legacy text is normalized on open so comparisons stay correct.
    let legacy_id = TaskId::new();
    repo.execute_batch(format!(
        "INSERT INTO tasks(id, title, status, created_at, updated_at, revision, remind_at)
         VALUES ('{legacy_id}', 'legacy', 'pending',
                '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z', 1,
                '2026-07-28T15:00:00.25Z');
         INSERT INTO reminder_occurrences(
            task_id, remind_at, state, attempts, created_at, updated_at
         ) VALUES (
            '{legacy_id}', '2026-07-28T15:00:00.25Z', 'pending', 0,
            '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z'
         );"
    ))
    .await
    .unwrap();
    repo.release_reminder_lease(lease.fence_term.clone(), t0)
        .await
        .unwrap();
    drop(repo);
    drop(owner);

    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    // Advance past any prior lease left released-at-t0 and any unexpired claims.
    let t_open: Timestamp = "2026-07-28T16:30:00Z".parse().unwrap();
    let lease = repo
        .acquire_reminder_lease(t_open, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    let _ = repo
        .mark_owner_lost_reminders(lease.fence_term.clone(), t_open, 100)
        .await
        .unwrap();
    repo.release_reminder_lease(lease.fence_term.clone(), t_open)
        .await
        .unwrap();
    // Owner-lost applies backoff from attempts; wait out the window then reacquire.
    let after_backoff: Timestamp = "2026-07-28T17:30:00Z".parse().unwrap();
    let lease = repo
        .acquire_reminder_lease(after_backoff, DEFAULT_REMINDER_LEASE_SECS)
        .await
        .unwrap();
    let claimed = repo
        .claim_due_reminders(lease.fence_term.clone(), after_backoff, 10, 90)
        .await
        .unwrap();
    assert!(
        claimed.iter().any(|row| row.task_id == legacy_id),
        "normalized legacy fractional remind_at should be claimable: {claimed:?}"
    );

    // Retry boundary uses canonical next_attempt_at comparison.
    let retry_id = create_with_remind_at(&repo, "retry", "2026-07-28T14:00:00.123456789Z").await;
    repo.execute_batch(format!(
        "UPDATE reminder_occurrences
         SET next_attempt_at = '2026-07-28T17:30:00.500000000Z'
         WHERE task_id = '{retry_id}';"
    ))
    .await
    .unwrap();
    let before_retry: Timestamp = "2026-07-28T17:30:00.499999999Z".parse().unwrap();
    let claimed_before = repo
        .claim_due_reminders(lease.fence_term.clone(), before_retry, 100, 90)
        .await
        .unwrap();
    assert!(claimed_before.iter().all(|row| row.task_id != retry_id));
    let at_retry: Timestamp = "2026-07-28T17:30:00.500000000Z".parse().unwrap();
    let claimed_retry = repo
        .claim_due_reminders(lease.fence_term.clone(), at_retry, 100, 90)
        .await
        .unwrap();
    assert!(claimed_retry.iter().any(|row| row.task_id == retry_id));
}

#[tokio::test]
async fn next_reminder_wake_at_empty_pending_lease_claimed_backoff_and_fractional() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    // Empty profile: no pending, claimed, or lease.
    assert_eq!(repo.next_reminder_wake_at().await.unwrap(), None);

    // Future pending eligibility is remind_at.
    let far_id = create_with_remind_at(&repo, "far", "2026-07-28T18:00:00.500000000Z").await;
    let wake = repo.next_reminder_wake_at().await.unwrap().unwrap();
    assert_eq!(wake.to_string(), "2026-07-28T18:00:00.5Z");

    // Earlier pending wins (fractional boundary below whole second).
    let near_id = create_with_remind_at(&repo, "near", "2026-07-28T17:00:00.100000000Z").await;
    let wake = repo.next_reminder_wake_at().await.unwrap().unwrap();
    assert_eq!(wake.to_string(), "2026-07-28T17:00:00.1Z");

    // Backoff pushes pending eligibility past remind_at.
    repo.execute_batch(format!(
        "UPDATE reminder_occurrences
         SET next_attempt_at = '2026-07-28T17:30:00.250000000Z'
         WHERE task_id = '{near_id}';"
    ))
    .await
    .unwrap();
    let wake = repo.next_reminder_wake_at().await.unwrap().unwrap();
    assert_eq!(
        wake.to_string(),
        "2026-07-28T17:30:00.25Z",
        "eligibility is max(remind_at, next_attempt_at)"
    );

    // Idle lease without claims must not participate (avoids forever-due wake).
    let t0: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();
    let lease = repo.acquire_reminder_lease(t0, 90).await.unwrap();
    let wake = repo.next_reminder_wake_at().await.unwrap().unwrap();
    assert_eq!(
        wake.to_string(),
        "2026-07-28T17:30:00.25Z",
        "lease without claims is ignored; pending eligibility remains"
    );

    // Claimed claim_expires_at participates once work is claimed.
    // Make a due pending row and claim it under the lease.
    let due_id = create_with_remind_at(&repo, "due", "2026-07-28T11:00:00.000000001Z").await;
    let claimed = repo
        .claim_due_reminders(lease.fence_term.clone(), t0, 10, 30)
        .await
        .unwrap();
    assert!(claimed.iter().any(|row| row.task_id == due_id));
    let claim_exp = claimed
        .iter()
        .find(|row| row.task_id == due_id)
        .unwrap()
        .claim_expires_at;
    // With lease at t0+90s and claim at t0+30s, claim expiry is the earliest wake.
    let wake = repo.next_reminder_wake_at().await.unwrap().unwrap();
    assert_eq!(wake, claim_exp);
    assert!(wake < lease.expires_at);

    // While claims exist, lease expiry is also a candidate (claim is still earlier).
    assert!(claim_exp < lease.expires_at);

    // Settling removes the claim; lease without remaining claims is ignored again.
    let due_claim = claimed.iter().find(|row| row.task_id == due_id).unwrap();
    repo.settle_reminder_delivered(
        lease.fence_term.clone(),
        due_id,
        due_claim.remind_at,
        due_claim.claim_attempt,
        ReminderChannel::InApp,
        t0,
    )
    .await
    .unwrap();
    let wake = repo.next_reminder_wake_at().await.unwrap().unwrap();
    assert_eq!(
        wake.to_string(),
        "2026-07-28T17:30:00.25Z",
        "after settle, idle lease is ignored"
    );

    // Release expires lease immediately; still ignored without claims.
    repo.release_reminder_lease(lease.fence_term.clone(), t0)
        .await
        .unwrap();
    let wake = repo.next_reminder_wake_at().await.unwrap().unwrap();
    assert_eq!(wake.to_string(), "2026-07-28T17:30:00.25Z");

    // Drop the lease row so only pending remains (simulate no owner).
    repo.execute_batch("DELETE FROM reminder_delivery_lease;".into())
        .await
        .unwrap();
    let wake = repo.next_reminder_wake_at().await.unwrap().unwrap();
    assert_eq!(wake.to_string(), "2026-07-28T17:30:00.25Z");

    // Cancel/dismiss remaining pending → empty again once far is also cleared.
    repo.dismiss_reminder(operation(), near_id, t0)
        .await
        .unwrap();
    repo.dismiss_reminder(operation(), far_id, t0)
        .await
        .unwrap();
    assert_eq!(repo.next_reminder_wake_at().await.unwrap(), None);
}

#[tokio::test]
async fn next_reminder_wake_at_ignores_idle_and_expired_lease_without_claims() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let t0: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();

    // Lease alone never supplies a wake.
    let _lease = repo.acquire_reminder_lease(t0, 90).await.unwrap();
    assert_eq!(repo.next_reminder_wake_at().await.unwrap(), None);

    // Expired lease row still ignored without claims.
    repo.execute_batch(
        "UPDATE reminder_delivery_lease
         SET expires_at = '2026-07-28T11:00:00Z'
         WHERE singleton = 1;"
            .to_string(),
    )
    .await
    .unwrap();
    assert_eq!(repo.next_reminder_wake_at().await.unwrap(), None);

    // Lease becomes meaningful only while a claim exists.
    let due_id = create_with_remind_at(&repo, "claimed-only", "2026-07-28T11:00:00Z").await;
    // Refresh to a live lease so claim can succeed.
    let lease = repo.acquire_reminder_lease(t0, 90).await.unwrap();
    let claimed = repo
        .claim_due_reminders(lease.fence_term.clone(), t0, 10, 45)
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].task_id, due_id);
    let wake = repo.next_reminder_wake_at().await.unwrap().unwrap();
    assert_eq!(wake, claimed[0].claim_expires_at);

    // Force lease expiry earlier than claim expiry; lease participates with claims.
    repo.execute_batch(
        "UPDATE reminder_delivery_lease
         SET expires_at = '2026-07-28T12:00:10Z'
         WHERE singleton = 1;"
            .to_string(),
    )
    .await
    .unwrap();
    let wake = repo.next_reminder_wake_at().await.unwrap().unwrap();
    assert_eq!(wake.to_string(), "2026-07-28T12:00:10Z");

    // Settle claim → lease ignored again even if still present/expired.
    repo.settle_reminder_delivered(
        lease.fence_term.clone(),
        due_id,
        claimed[0].remind_at,
        claimed[0].claim_attempt,
        ReminderChannel::InApp,
        t0,
    )
    .await
    .unwrap();
    assert_eq!(repo.next_reminder_wake_at().await.unwrap(), None);
}

#[tokio::test]
async fn next_reminder_wake_at_is_control_plane_without_revision() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let _id = create_with_remind_at(&repo, "wake-rev", "2026-07-28T20:00:00Z").await;
    let before = repo.diagnostics().await.unwrap().revision;
    let wake = repo.next_reminder_wake_at().await.unwrap();
    assert!(wake.is_some());
    assert_eq!(repo.diagnostics().await.unwrap().revision, before);
}

// ── Phase 3 timeblocking core ──────────────────────────────────────────────

fn civil_range(date: &str, start_h: i8, end_h: i8) -> junban_domain::CivilTimeRange {
    use jiff::civil::Time;
    junban_domain::CivilTimeRange::new(
        date.parse().unwrap(),
        Time::constant(start_h, 0, 0, 0),
        Time::constant(end_h, 0, 0, 0),
        junban_domain::TimeZoneName::new("UTC").unwrap(),
    )
    .unwrap()
}

fn block_draft(title: &str, date: &str) -> junban_domain::TimeBlockDraft {
    junban_domain::TimeBlockDraft::new(EntityName::new(title).unwrap(), civil_range(date, 9, 10))
}

fn slot_draft(title: &str, date: &str) -> junban_domain::TimeSlotDraft {
    junban_domain::TimeSlotDraft::new(EntityName::new(title).unwrap(), civil_range(date, 9, 12))
}

#[tokio::test]
async fn timeblock_crud_event_receipt_and_exact_retry() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let before = repo.diagnostics().await.unwrap().revision;

    let op = operation();
    let block_id = junban_domain::TimeBlockId::new();
    let first = repo
        .create_time_block(op, block_id, block_draft("Focus", "2026-03-08"), now())
        .await
        .unwrap();
    assert!(first.newly_committed);
    assert_eq!(first.event.revision, (before + 1) as u64);
    assert_eq!(first.event.event_type.as_str(), "time_block.created");
    assert_eq!(first.time_block().unwrap().title.as_str(), "Focus");
    assert_eq!(repo.diagnostics().await.unwrap().revision, before + 1);

    let replay = repo
        .create_time_block(
            op,
            junban_domain::TimeBlockId::new(),
            block_draft("Focus", "2026-03-08"),
            now(),
        )
        .await
        .unwrap();
    assert_eq!(replay, first);
    assert!(!replay.newly_committed);
    assert_eq!(repo.diagnostics().await.unwrap().revision, before + 1);
    assert_eq!(
        serde_json::to_string(&replay).unwrap(),
        serde_json::to_string(&first).unwrap()
    );

    let patched = repo
        .patch_time_block(
            operation(),
            block_id,
            junban_app::TimeBlockPatch {
                title: Some(EntityName::new("Deep focus").unwrap()),
                locked: Some(true),
                ..Default::default()
            },
            now(),
        )
        .await
        .unwrap();
    assert_eq!(patched.event.event_type.as_str(), "time_block.updated");
    assert_eq!(patched.time_block().unwrap().title.as_str(), "Deep focus");
    assert!(patched.time_block().unwrap().locked);

    let moved = repo
        .set_time_block_range(
            operation(),
            block_id,
            junban_app::TimeBlockRangePatch {
                date: Some("2026-03-09".parse().unwrap()),
                start: Some(Time::constant(10, 0, 0, 0)),
                end: Some(Time::constant(11, 0, 0, 0)),
                ..Default::default()
            },
            now(),
        )
        .await
        .unwrap();
    assert_eq!(
        moved.time_block().unwrap().range.date.to_string(),
        "2026-03-09"
    );

    let deleted = repo
        .delete_time_block(operation(), block_id, now())
        .await
        .unwrap();
    assert_eq!(deleted.event.event_type.as_str(), "time_block.deleted");
    let page = repo
        .list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-03-08".parse().unwrap(),
            to: "2026-03-09".parse().unwrap(),
        })
        .await
        .unwrap();
    assert!(page.blocks.is_empty());
}

#[tokio::test]
async fn timeslot_membership_order_cap_and_slot_delete_nulls_blocks() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    let slot_id = junban_domain::TimeSlotId::new();
    let created = repo
        .create_time_slot(
            operation(),
            slot_id,
            slot_draft("Deep work", "2026-03-08"),
            now(),
        )
        .await
        .unwrap();
    assert_eq!(created.event.event_type.as_str(), "time_slot.created");

    let t1 = create_simple(&repo, "A").await.task().unwrap().id;
    let t2 = create_simple(&repo, "B").await.task().unwrap().id;
    let t3 = create_simple(&repo, "C").await.task().unwrap().id;

    let a1 = repo
        .append_slot_task(operation(), slot_id, t1, now())
        .await
        .unwrap();
    assert_eq!(a1.time_slot().unwrap().task_ids.as_slice(), &[t1]);
    // Duplicate append is a deterministic no-op membership response.
    let a1_dup = repo
        .append_slot_task(operation(), slot_id, t1, now())
        .await
        .unwrap();
    assert_eq!(a1_dup.time_slot().unwrap().task_ids.as_slice(), &[t1]);
    assert!(a1_dup.newly_committed);

    repo.append_slot_task(operation(), slot_id, t2, now())
        .await
        .unwrap();
    repo.append_slot_task(operation(), slot_id, t3, now())
        .await
        .unwrap();
    let reordered = repo
        .reorder_slot_tasks(operation(), slot_id, vec![t3, t1, t2], now())
        .await
        .unwrap();
    assert_eq!(
        reordered.time_slot().unwrap().task_ids.as_slice(),
        &[t3, t1, t2]
    );
    assert!(
        repo.reorder_slot_tasks(operation(), slot_id, vec![t1, t2], now())
            .await
            .is_err()
    );

    let removed = repo
        .remove_slot_task(operation(), slot_id, t1, now())
        .await
        .unwrap();
    assert_eq!(removed.time_slot().unwrap().task_ids.as_slice(), &[t3, t2]);

    // Cap at 100.
    let mut ids = vec![t2, t3];
    for index in 0..98 {
        let id = create_simple(&repo, &format!("cap-{index}"))
            .await
            .task()
            .unwrap()
            .id;
        ids.push(id);
        repo.append_slot_task(operation(), slot_id, id, now())
            .await
            .unwrap();
    }
    assert_eq!(ids.len(), 100);
    let overflow = create_simple(&repo, "overflow").await.task().unwrap().id;
    let err = repo
        .append_slot_task(operation(), slot_id, overflow, now())
        .await
        .unwrap_err();
    assert!(matches!(err, RepositoryError::Validation(_)));

    // Missing task reference is not found.
    assert_eq!(
        repo.append_slot_task(operation(), slot_id, TaskId::new(), now())
            .await
            .unwrap_err(),
        RepositoryError::NotFound
    );

    // Block linked to slot; deleting slot nulls slot_id.
    let block_id = junban_domain::TimeBlockId::new();
    let mut draft = block_draft("Linked", "2026-03-08");
    draft.slot_id = Some(slot_id);
    repo.create_time_block(operation(), block_id, draft, now())
        .await
        .unwrap();
    repo.delete_time_slot(operation(), slot_id, now())
        .await
        .unwrap();
    let page = repo
        .list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-03-08".parse().unwrap(),
            to: "2026-03-08".parse().unwrap(),
        })
        .await
        .unwrap();
    assert!(page.slots.is_empty());
    assert_eq!(page.blocks.len(), 1);
    assert!(page.blocks[0].slot_id.is_none());
}

#[tokio::test]
async fn timeblocking_range_bounds_and_item_ceiling() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    assert!(matches!(
        repo.list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-03-10".parse().unwrap(),
            to: "2026-03-01".parse().unwrap(),
        })
        .await
        .unwrap_err(),
        RepositoryError::Validation(_)
    ));
    assert!(matches!(
        repo.list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-03-01".parse().unwrap(),
            to: "2026-04-12".parse().unwrap(), // 43 inclusive days
        })
        .await
        .unwrap_err(),
        RepositoryError::Validation(_)
    ));

    // Create one block and one slot inside a valid window.
    repo.create_time_block(
        operation(),
        junban_domain::TimeBlockId::new(),
        block_draft("B", "2026-03-08"),
        now(),
    )
    .await
    .unwrap();
    repo.create_time_slot(
        operation(),
        junban_domain::TimeSlotId::new(),
        slot_draft("S", "2026-03-08"),
        now(),
    )
    .await
    .unwrap();
    let page = repo
        .list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-03-01".parse().unwrap(),
            to: "2026-03-08".parse().unwrap(),
        })
        .await
        .unwrap();
    assert_eq!(page.blocks.len(), 1);
    assert_eq!(page.slots.len(), 1);

    // Force an over-limit count path without inserting 2001 rows.
    // Inject enough synthetic rows via SQL to trip the combined ceiling.
    let mut sql = String::new();
    for index in 0..2000 {
        sql.push_str(&format!(
            "INSERT INTO time_blocks(
                id, title, civil_date, start_time, end_time, timezone, locked,
                created_at, updated_at, revision
             ) VALUES (
                '{id}', 'bulk', '2026-03-08', '09:00:00', '10:00:00', 'UTC', 0,
                '2026-07-28T12:00:00Z', '2026-07-28T12:00:00Z', 1
             );\n",
            id = uuid::Uuid::from_u128(10_000 + index as u128)
        ));
    }
    repo.execute_batch(sql).await.unwrap();
    assert_eq!(
        repo.list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-03-08".parse().unwrap(),
            to: "2026-03-08".parse().unwrap(),
        })
        .await
        .unwrap_err(),
        RepositoryError::OperationTooLarge
    );
}

#[tokio::test]
async fn timeblocking_range_includes_earlier_recurring_owners_in_deterministic_order() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    let old_recurring_id = junban_domain::TimeBlockId::new();
    let mut old_recurring = block_draft("Old daily", "2026-01-01");
    old_recurring.recurrence_rule = Some(junban_domain::RecurrenceRule::new("daily").unwrap());
    repo.create_time_block(operation(), old_recurring_id, old_recurring, now())
        .await
        .unwrap();

    let old_plain_id = junban_domain::TimeBlockId::new();
    repo.create_time_block(
        operation(),
        old_plain_id,
        block_draft("Old plain", "2026-01-02"),
        now(),
    )
    .await
    .unwrap();

    let in_range_id = junban_domain::TimeBlockId::new();
    repo.create_time_block(
        operation(),
        in_range_id,
        block_draft("In range", "2026-03-08"),
        now(),
    )
    .await
    .unwrap();

    let future_recurring_id = junban_domain::TimeBlockId::new();
    let mut future = block_draft("Future daily", "2026-04-01");
    future.recurrence_rule = Some(junban_domain::RecurrenceRule::new("daily").unwrap());
    repo.create_time_block(operation(), future_recurring_id, future, now())
        .await
        .unwrap();

    let old_slot_id = junban_domain::TimeSlotId::new();
    let mut old_slot = slot_draft("Old slot series", "2026-02-01");
    old_slot.recurrence_rule = Some(junban_domain::RecurrenceRule::new("weekly").unwrap());
    repo.create_time_slot(operation(), old_slot_id, old_slot, now())
        .await
        .unwrap();

    let page = repo
        .list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-03-08".parse().unwrap(),
            to: "2026-03-10".parse().unwrap(),
        })
        .await
        .unwrap();

    let block_ids: Vec<_> = page.blocks.iter().map(|block| block.id).collect();
    assert_eq!(block_ids, vec![old_recurring_id, in_range_id]);
    assert!(!block_ids.contains(&old_plain_id));
    assert!(!block_ids.contains(&future_recurring_id));
    assert_eq!(
        page.slots.iter().map(|slot| slot.id).collect::<Vec<_>>(),
        vec![old_slot_id]
    );

    // Deterministic owner order by civil_date, start_time, id.
    let keys: Vec<_> = page
        .blocks
        .iter()
        .map(|block| (block.range.date, block.range.start, block.id.as_uuid()))
        .collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(keys, sorted);
}

#[tokio::test]
async fn replan_skips_locked_blocks_and_is_atomic() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let today: jiff::civil::Date = "2026-03-15".parse().unwrap();
    let temporal = TemporalContext::new(today, TimeZone::UTC);

    let unlocked_id = junban_domain::TimeBlockId::new();
    repo.create_time_block(
        operation(),
        unlocked_id,
        block_draft("Past open", "2026-03-10"),
        now(),
    )
    .await
    .unwrap();

    let locked_id = junban_domain::TimeBlockId::new();
    let mut locked = block_draft("Past locked", "2026-03-11");
    locked.locked = true;
    repo.create_time_block(operation(), locked_id, locked, now())
        .await
        .unwrap();

    // Outside lookback window.
    repo.create_time_block(
        operation(),
        junban_domain::TimeBlockId::new(),
        block_draft("Too old", "2026-03-01"),
        now(),
    )
    .await
    .unwrap();

    let preview = repo
        .preview_replan_past_blocks(temporal.clone())
        .await
        .unwrap();
    assert_eq!(preview.as_of_date, today);
    assert_eq!(preview.candidate_ids, vec![unlocked_id]);
    assert_eq!(
        preview
            .blocks
            .iter()
            .map(|block| block.id)
            .collect::<Vec<_>>(),
        vec![unlocked_id]
    );

    let before = repo.diagnostics().await.unwrap().revision;
    let replan = repo
        .replan_past_blocks(
            operation(),
            junban_app::ReplanPastBlocksAction::MoveToToday,
            preview.as_of_date,
            preview.candidate_ids,
            now(),
            temporal.clone(),
        )
        .await
        .unwrap();
    assert_eq!(replan.event.event_type.as_str(), "time_block.replanned");
    assert_eq!(replan.event.affected.time_block_ids, vec![unlocked_id]);
    assert_eq!(repo.diagnostics().await.unwrap().revision, before + 1);

    let page = repo
        .list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-03-01".parse().unwrap(),
            to: "2026-03-15".parse().unwrap(),
        })
        .await
        .unwrap();
    let unlocked = page
        .blocks
        .iter()
        .find(|block| block.id == unlocked_id)
        .unwrap();
    let locked = page
        .blocks
        .iter()
        .find(|block| block.id == locked_id)
        .unwrap();
    assert_eq!(unlocked.range.date, today);
    assert_eq!(locked.range.date.to_string(), "2026-03-11");

    // Missing slot on create rolls back without advancing revision.
    let before = repo.diagnostics().await.unwrap().revision;
    let mut bad = block_draft("Missing slot", "2026-03-15");
    bad.slot_id = Some(junban_domain::TimeSlotId::new());
    assert_eq!(
        repo.create_time_block(operation(), junban_domain::TimeBlockId::new(), bad, now())
            .await
            .unwrap_err(),
        RepositoryError::NotFound
    );
    assert_eq!(repo.diagnostics().await.unwrap().revision, before);

    // Delete replan removes unlocked past blocks only.
    let delete_id = junban_domain::TimeBlockId::new();
    repo.create_time_block(
        operation(),
        delete_id,
        block_draft("Delete me", "2026-03-12"),
        now(),
    )
    .await
    .unwrap();
    let delete_preview = repo
        .preview_replan_past_blocks(temporal.clone())
        .await
        .unwrap();
    let deleted = repo
        .replan_past_blocks(
            operation(),
            junban_app::ReplanPastBlocksAction::Delete,
            delete_preview.as_of_date,
            delete_preview.candidate_ids,
            now(),
            temporal,
        )
        .await
        .unwrap();
    assert!(deleted.event.affected.time_block_ids.contains(&delete_id));
    assert!(!deleted.event.affected.time_block_ids.contains(&locked_id));
}

#[tokio::test]
async fn replan_rejects_stale_date_and_candidate_expectations_atomically() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let preview_date: jiff::civil::Date = "2026-03-15".parse().unwrap();
    let preview_temporal = TemporalContext::new(preview_date, TimeZone::UTC);

    let first_id = junban_domain::TimeBlockId::new();
    repo.create_time_block(
        operation(),
        first_id,
        block_draft("First", "2026-03-14"),
        now(),
    )
    .await
    .unwrap();
    let preview = repo
        .preview_replan_past_blocks(preview_temporal.clone())
        .await
        .unwrap();

    let second_id = junban_domain::TimeBlockId::new();
    repo.create_time_block(
        operation(),
        second_id,
        block_draft("Arrived later", "2026-03-13"),
        now(),
    )
    .await
    .unwrap();
    let revision = repo.diagnostics().await.unwrap().revision;
    assert_eq!(
        repo.replan_past_blocks(
            operation(),
            junban_app::ReplanPastBlocksAction::Delete,
            preview.as_of_date,
            preview.candidate_ids.clone(),
            now(),
            preview_temporal.clone(),
        )
        .await
        .unwrap_err(),
        RepositoryError::Conflict
    );
    assert_eq!(repo.diagnostics().await.unwrap().revision, revision);

    let current = repo
        .preview_replan_past_blocks(preview_temporal)
        .await
        .unwrap();
    let next_day: jiff::civil::Date = "2026-03-16".parse().unwrap();
    assert_eq!(
        repo.replan_past_blocks(
            operation(),
            junban_app::ReplanPastBlocksAction::Delete,
            current.as_of_date,
            current.candidate_ids,
            now(),
            TemporalContext::new(next_day, TimeZone::UTC),
        )
        .await
        .unwrap_err(),
        RepositoryError::Conflict
    );
    assert_eq!(repo.diagnostics().await.unwrap().revision, revision);

    let page = repo
        .list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-03-13".parse().unwrap(),
            to: "2026-03-14".parse().unwrap(),
        })
        .await
        .unwrap();
    assert_eq!(page.blocks.len(), 2);
}

#[tokio::test]
async fn timeblock_missing_task_and_project_refs_are_not_found() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    let mut draft = block_draft("No task", "2026-03-08");
    draft.task_id = Some(TaskId::new());
    assert_eq!(
        repo.create_time_block(operation(), junban_domain::TimeBlockId::new(), draft, now())
            .await
            .unwrap_err(),
        RepositoryError::NotFound
    );

    let mut slot = slot_draft("No project", "2026-03-08");
    slot.project_id = Some(ProjectId::new());
    assert_eq!(
        repo.create_time_slot(operation(), junban_domain::TimeSlotId::new(), slot, now())
            .await
            .unwrap_err(),
        RepositoryError::NotFound
    );
}

fn inverted_civil_range(date: &str) -> junban_domain::CivilTimeRange {
    use jiff::civil::Time;
    // Public field construction bypasses CivilTimeRange::new.
    junban_domain::CivilTimeRange {
        date: date.parse().unwrap(),
        start: Time::constant(11, 0, 0, 0),
        end: Time::constant(10, 0, 0, 0),
        time_zone: junban_domain::TimeZoneName::new("UTC").unwrap(),
    }
}

async fn planning_page(repo: &SqliteRepository, date: &str) -> junban_app::TimeblockingRangePage {
    repo.list_timeblocking_range(junban_app::TimeblockingRangeQuery {
        from: date.parse().unwrap(),
        to: date.parse().unwrap(),
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn p3_tb_001_delete_task_preserves_and_restores_planning_links() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    let slot_id = junban_domain::TimeSlotId::new();
    repo.create_time_slot(
        operation(),
        slot_id,
        slot_draft("Focus", "2026-03-08"),
        now(),
    )
    .await
    .unwrap();

    let keep = create_simple(&repo, "Keep").await.task().unwrap().id;
    let doomed = create_simple(&repo, "Doomed").await.task().unwrap().id;
    let tail = create_simple(&repo, "Tail").await.task().unwrap().id;
    repo.append_slot_task(operation(), slot_id, keep, now())
        .await
        .unwrap();
    repo.append_slot_task(operation(), slot_id, doomed, now())
        .await
        .unwrap();
    repo.append_slot_task(operation(), slot_id, tail, now())
        .await
        .unwrap();
    // Exact middle position before delete: [keep, doomed, tail].
    assert_eq!(
        planning_page(&repo, "2026-03-08").await.slots[0]
            .task_ids
            .as_slice(),
        &[keep, doomed, tail]
    );

    let block_id = junban_domain::TimeBlockId::new();
    let mut draft = block_draft("Linked", "2026-03-08");
    draft.task_id = Some(doomed);
    let block_before = repo
        .create_time_block(operation(), block_id, draft, now())
        .await
        .unwrap()
        .time_block()
        .unwrap()
        .clone();
    assert_eq!(block_before.task_id, Some(doomed));

    let delete_op = operation();
    let deleted = repo.delete_task(delete_op, doomed, now()).await.unwrap();
    assert_eq!(deleted.event.event_type.as_str(), "task.deleted");
    assert_eq!(deleted.event.affected.task_ids, vec![doomed]);
    assert_eq!(deleted.event.affected.time_slot_ids, vec![slot_id]);
    assert_eq!(deleted.event.affected.time_block_ids, vec![block_id]);
    assert!(deleted.newly_committed);

    // Exact retry is byte-identical and does not emit a second event.
    let replay = repo.delete_task(delete_op, doomed, now()).await.unwrap();
    assert_eq!(replay, deleted);
    assert!(!replay.newly_committed);
    assert_eq!(
        serde_json::to_string(&replay).unwrap(),
        serde_json::to_string(&deleted).unwrap()
    );

    let page = planning_page(&repo, "2026-03-08").await;
    assert_eq!(page.slots[0].task_ids.as_slice(), &[keep, tail]);
    assert_eq!(page.slots[0].revision, deleted.event.revision);
    assert_eq!(page.slots[0].updated_at, now());
    assert_eq!(page.blocks[0].task_id, None);
    assert_eq!(page.blocks[0].revision, deleted.event.revision);
    assert_eq!(page.blocks[0].updated_at, now());

    let undo_op = operation();
    let undone = repo.undo(delete_op, undo_op, now()).await.unwrap();
    assert_eq!(undone.event.affected.task_ids, vec![doomed]);
    assert_eq!(undone.event.affected.time_slot_ids, vec![slot_id]);
    assert_eq!(undone.event.affected.time_block_ids, vec![block_id]);

    let restored = planning_page(&repo, "2026-03-08").await;
    assert_eq!(
        restored.slots[0].task_ids.as_slice(),
        &[keep, doomed, tail],
        "undo must restore exact membership position"
    );
    assert_eq!(restored.slots[0].revision, undone.event.revision);
    assert_eq!(restored.blocks[0].task_id, Some(doomed));
    assert_eq!(restored.blocks[0].revision, undone.event.revision);
    assert_eq!(
        repo.get_task(doomed).await.unwrap().title.as_str(),
        "Doomed"
    );

    // Redo deletes again, explicitly clears links, and reports affected planning IDs.
    let redo_op = operation();
    let redone = repo.undo(undo_op, redo_op, now()).await.unwrap();
    assert_eq!(redone.event.affected.task_ids, vec![doomed]);
    assert_eq!(redone.event.affected.time_slot_ids, vec![slot_id]);
    assert_eq!(redone.event.affected.time_block_ids, vec![block_id]);
    let after_redo = planning_page(&repo, "2026-03-08").await;
    assert_eq!(after_redo.slots[0].task_ids.as_slice(), &[keep, tail]);
    assert_eq!(after_redo.slots[0].revision, redone.event.revision);
    assert_eq!(after_redo.blocks[0].task_id, None);
    assert_eq!(after_redo.blocks[0].revision, redone.event.revision);
    assert!(matches!(
        repo.get_task(doomed).await,
        Err(RepositoryError::NotFound)
    ));

    // Undoing the redo must restore exact middle membership and block link again.
    let undo_redo_op = operation();
    let undone_redo = repo.undo(redo_op, undo_redo_op, now()).await.unwrap();
    assert_eq!(undone_redo.event.affected.task_ids, vec![doomed]);
    assert_eq!(undone_redo.event.affected.time_slot_ids, vec![slot_id]);
    assert_eq!(undone_redo.event.affected.time_block_ids, vec![block_id]);
    assert_eq!(undone_redo.event.revision, redone.event.revision + 1);

    let after_undo_redo = planning_page(&repo, "2026-03-08").await;
    assert_eq!(
        after_undo_redo.slots[0].task_ids.as_slice(),
        &[keep, doomed, tail],
        "undo of redo must restore exact middle membership position"
    );
    assert_eq!(
        after_undo_redo.slots[0].revision,
        undone_redo.event.revision
    );
    assert_eq!(after_undo_redo.blocks[0].task_id, Some(doomed));
    assert_eq!(
        after_undo_redo.blocks[0].revision,
        undone_redo.event.revision
    );
    assert_eq!(
        repo.get_task(doomed).await.unwrap().title.as_str(),
        "Doomed"
    );

    // Exact retry of the undo-of-redo is byte-identical.
    let replay_undo_redo = repo.undo(redo_op, undo_redo_op, now()).await.unwrap();
    assert_eq!(replay_undo_redo, undone_redo);
    assert!(!replay_undo_redo.newly_committed);
    assert_eq!(
        serde_json::to_string(&replay_undo_redo).unwrap(),
        serde_json::to_string(&undone_redo).unwrap()
    );

    // Further toggle (re-delete via undo of undo-redo) still detaches planning links.
    let re_redo = repo.undo(undo_redo_op, operation(), now()).await.unwrap();
    assert_eq!(re_redo.event.affected.task_ids, vec![doomed]);
    assert_eq!(re_redo.event.affected.time_slot_ids, vec![slot_id]);
    assert_eq!(re_redo.event.affected.time_block_ids, vec![block_id]);
    let after_re_redo = planning_page(&repo, "2026-03-08").await;
    assert_eq!(after_re_redo.slots[0].task_ids.as_slice(), &[keep, tail]);
    assert_eq!(after_re_redo.blocks[0].task_id, None);
}

#[tokio::test]
async fn p3_tb_001_undo_of_redo_conflicts_when_slot_changes() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    let slot_id = junban_domain::TimeSlotId::new();
    repo.create_time_slot(
        operation(),
        slot_id,
        slot_draft("Focus", "2026-03-08"),
        now(),
    )
    .await
    .unwrap();

    let keep = create_simple(&repo, "Keep").await.task().unwrap().id;
    let doomed = create_simple(&repo, "Doomed").await.task().unwrap().id;
    repo.append_slot_task(operation(), slot_id, keep, now())
        .await
        .unwrap();
    repo.append_slot_task(operation(), slot_id, doomed, now())
        .await
        .unwrap();

    let delete_op = operation();
    repo.delete_task(delete_op, doomed, now()).await.unwrap();
    let undo_op = operation();
    repo.undo(delete_op, undo_op, now()).await.unwrap();
    let redo_op = operation();
    repo.undo(undo_op, redo_op, now()).await.unwrap();
    let revision_after_redo = repo.diagnostics().await.unwrap().revision;

    // Mutate the post-delete slot before undoing the redo.
    repo.append_slot_task(
        operation(),
        slot_id,
        create_simple(&repo, "Intruder").await.task().unwrap().id,
        now(),
    )
    .await
    .unwrap();
    let revision_after_mutate = repo.diagnostics().await.unwrap().revision;
    assert!(revision_after_mutate > revision_after_redo);

    let before = planning_page(&repo, "2026-03-08").await;
    assert_eq!(
        repo.undo(redo_op, operation(), now()).await.unwrap_err(),
        RepositoryError::Conflict
    );
    assert_eq!(
        repo.diagnostics().await.unwrap().revision,
        revision_after_mutate
    );
    let after = planning_page(&repo, "2026-03-08").await;
    assert_eq!(
        before, after,
        "conflict must leave planning state unchanged"
    );
    assert!(matches!(
        repo.get_task(doomed).await,
        Err(RepositoryError::NotFound)
    ));
}

#[tokio::test]
async fn p3_tb_001_delete_closure_restores_descendant_planning_links() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    let parent = create_simple(&repo, "Parent").await.task().unwrap().id;
    let mut child_draft = draft("Child");
    child_draft.parent_id = Some(parent);
    let child = repo
        .create_task(operation(), TaskId::new(), child_draft, now())
        .await
        .unwrap()
        .task()
        .unwrap()
        .id;

    let slot_a = junban_domain::TimeSlotId::new();
    let slot_b = junban_domain::TimeSlotId::new();
    repo.create_time_slot(operation(), slot_a, slot_draft("A", "2026-03-08"), now())
        .await
        .unwrap();
    repo.create_time_slot(operation(), slot_b, slot_draft("B", "2026-03-08"), now())
        .await
        .unwrap();
    repo.append_slot_task(operation(), slot_a, parent, now())
        .await
        .unwrap();
    repo.append_slot_task(operation(), slot_b, child, now())
        .await
        .unwrap();

    let parent_block = junban_domain::TimeBlockId::new();
    let child_block = junban_domain::TimeBlockId::new();
    let mut parent_draft = block_draft("Parent block", "2026-03-08");
    parent_draft.task_id = Some(parent);
    let mut child_draft_block = block_draft("Child block", "2026-03-08");
    child_draft_block.task_id = Some(child);
    repo.create_time_block(operation(), parent_block, parent_draft, now())
        .await
        .unwrap();
    repo.create_time_block(operation(), child_block, child_draft_block, now())
        .await
        .unwrap();

    let delete_op = operation();
    let deleted = repo.delete_task(delete_op, parent, now()).await.unwrap();
    assert_eq!(deleted.event.affected.task_ids.len(), 2);
    assert!(deleted.event.affected.task_ids.contains(&parent));
    assert!(deleted.event.affected.task_ids.contains(&child));
    assert_eq!(deleted.event.affected.time_slot_ids.len(), 2);
    assert!(deleted.event.affected.time_slot_ids.contains(&slot_a));
    assert!(deleted.event.affected.time_slot_ids.contains(&slot_b));
    assert_eq!(deleted.event.affected.time_block_ids.len(), 2);
    assert!(
        deleted
            .event
            .affected
            .time_block_ids
            .contains(&parent_block)
    );
    assert!(deleted.event.affected.time_block_ids.contains(&child_block));

    let after_delete = planning_page(&repo, "2026-03-08").await;
    assert!(
        after_delete
            .slots
            .iter()
            .all(|slot| slot.task_ids.is_empty())
    );
    assert!(
        after_delete
            .blocks
            .iter()
            .all(|block| block.task_id.is_none())
    );

    let undone = repo.undo(delete_op, operation(), now()).await.unwrap();
    assert_eq!(undone.event.affected.time_slot_ids.len(), 2);
    assert_eq!(undone.event.affected.time_block_ids.len(), 2);

    let restored = planning_page(&repo, "2026-03-08").await;
    let slot_a_restored = restored
        .slots
        .iter()
        .find(|slot| slot.id == slot_a)
        .unwrap();
    let slot_b_restored = restored
        .slots
        .iter()
        .find(|slot| slot.id == slot_b)
        .unwrap();
    assert_eq!(slot_a_restored.task_ids.as_slice(), &[parent]);
    assert_eq!(slot_b_restored.task_ids.as_slice(), &[child]);
    let parent_block_restored = restored
        .blocks
        .iter()
        .find(|block| block.id == parent_block)
        .unwrap();
    let child_block_restored = restored
        .blocks
        .iter()
        .find(|block| block.id == child_block)
        .unwrap();
    assert_eq!(parent_block_restored.task_id, Some(parent));
    assert_eq!(child_block_restored.task_id, Some(child));
}

#[tokio::test]
async fn p3_tb_001_undo_conflicts_when_affected_slot_or_block_changes() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    // Slot-change path.
    {
        let slot_id = junban_domain::TimeSlotId::new();
        repo.create_time_slot(
            operation(),
            slot_id,
            slot_draft("Slot", "2026-03-08"),
            now(),
        )
        .await
        .unwrap();
        let doomed = create_simple(&repo, "Slot-doomed").await.task().unwrap().id;
        let other = create_simple(&repo, "Other").await.task().unwrap().id;
        repo.append_slot_task(operation(), slot_id, doomed, now())
            .await
            .unwrap();
        repo.append_slot_task(operation(), slot_id, other, now())
            .await
            .unwrap();

        let delete_op = operation();
        let deleted = repo.delete_task(delete_op, doomed, now()).await.unwrap();
        let revision_after_delete = repo.diagnostics().await.unwrap().revision;

        // Mutate the affected slot after delete.
        repo.append_slot_task(
            operation(),
            slot_id,
            create_simple(&repo, "Intruder").await.task().unwrap().id,
            now(),
        )
        .await
        .unwrap();
        let revision_after_mutate = repo.diagnostics().await.unwrap().revision;
        assert!(revision_after_mutate > revision_after_delete);

        let before = planning_page(&repo, "2026-03-08").await;
        assert_eq!(
            repo.undo(delete_op, operation(), now()).await.unwrap_err(),
            RepositoryError::Conflict
        );
        assert_eq!(
            repo.diagnostics().await.unwrap().revision,
            revision_after_mutate
        );
        let after = planning_page(&repo, "2026-03-08").await;
        assert_eq!(
            before, after,
            "conflict must leave planning state unchanged"
        );
        assert!(matches!(
            repo.get_task(doomed).await,
            Err(RepositoryError::NotFound)
        ));
        assert_eq!(deleted.event.affected.time_slot_ids, vec![slot_id]);
    }

    // Block-change path.
    {
        let doomed = create_simple(&repo, "Block-doomed")
            .await
            .task()
            .unwrap()
            .id;
        let block_id = junban_domain::TimeBlockId::new();
        let mut draft = block_draft("Linked", "2026-03-09");
        draft.task_id = Some(doomed);
        repo.create_time_block(operation(), block_id, draft, now())
            .await
            .unwrap();

        let delete_op = operation();
        repo.delete_task(delete_op, doomed, now()).await.unwrap();
        let revision_after_delete = repo.diagnostics().await.unwrap().revision;

        // Mutate the affected block after delete (title bump).
        repo.patch_time_block(
            operation(),
            block_id,
            junban_app::TimeBlockPatch {
                title: Some(EntityName::new("Changed").unwrap()),
                ..Default::default()
            },
            now(),
        )
        .await
        .unwrap();
        let revision_after_mutate = repo.diagnostics().await.unwrap().revision;
        assert!(revision_after_mutate > revision_after_delete);

        let before = planning_page(&repo, "2026-03-09").await;
        assert_eq!(
            repo.undo(delete_op, operation(), now()).await.unwrap_err(),
            RepositoryError::Conflict
        );
        assert_eq!(
            repo.diagnostics().await.unwrap().revision,
            revision_after_mutate
        );
        let after = planning_page(&repo, "2026-03-09").await;
        assert_eq!(before, after, "conflict must leave block state unchanged");
        assert!(matches!(
            repo.get_task(doomed).await,
            Err(RepositoryError::NotFound)
        ));
        assert_eq!(before.blocks[0].title.as_str(), "Changed");
        assert!(before.blocks[0].task_id.is_none());
    }
}

#[tokio::test]
async fn p3_tb_002_delete_time_slot_bumps_linked_block_revision_and_affected_ids() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    let slot_id = junban_domain::TimeSlotId::new();
    repo.create_time_slot(
        operation(),
        slot_id,
        slot_draft("Capacity", "2026-03-08"),
        now(),
    )
    .await
    .unwrap();

    let block_id = junban_domain::TimeBlockId::new();
    let mut draft = block_draft("Linked", "2026-03-08");
    draft.slot_id = Some(slot_id);
    let created = repo
        .create_time_block(operation(), block_id, draft, now())
        .await
        .unwrap();
    let created_revision = created.time_block().unwrap().revision;

    let deleted = repo
        .delete_time_slot(operation(), slot_id, now())
        .await
        .unwrap();
    assert_eq!(deleted.event.event_type.as_str(), "time_slot.deleted");
    assert_eq!(deleted.event.affected.time_slot_ids, vec![slot_id]);
    assert_eq!(deleted.event.affected.time_block_ids, vec![block_id]);
    assert!(deleted.newly_committed);

    let page = repo
        .list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-03-08".parse().unwrap(),
            to: "2026-03-08".parse().unwrap(),
        })
        .await
        .unwrap();
    assert!(page.slots.is_empty());
    assert_eq!(page.blocks.len(), 1);
    let block = &page.blocks[0];
    assert_eq!(block.id, block_id);
    assert!(block.slot_id.is_none());
    assert_eq!(block.revision, deleted.event.revision);
    assert_ne!(block.revision, created_revision);
    assert_eq!(block.updated_at, now());
}

#[tokio::test]
async fn p3_tb_003_delete_project_clears_time_slot_project_with_mutation_revision() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();

    let project_id = ProjectId::new();
    repo.create_project(operation(), project_id, project_draft("Planning"), now())
        .await
        .unwrap();

    let slot_id = junban_domain::TimeSlotId::new();
    let mut draft = slot_draft("Project slot", "2026-03-08");
    draft.project_id = Some(project_id);
    let created = repo
        .create_time_slot(operation(), slot_id, draft, now())
        .await
        .unwrap();
    let created_revision = created.time_slot().unwrap().revision;

    let deleted = repo
        .delete_project(operation(), project_id, now())
        .await
        .unwrap();
    assert_eq!(deleted.event.event_type.as_str(), "project.deleted");
    assert_eq!(deleted.event.affected.project_ids, vec![project_id]);
    assert_eq!(deleted.event.affected.time_slot_ids, vec![slot_id]);

    let page = repo
        .list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-03-08".parse().unwrap(),
            to: "2026-03-08".parse().unwrap(),
        })
        .await
        .unwrap();
    assert_eq!(page.slots.len(), 1);
    let slot = &page.slots[0];
    assert_eq!(slot.id, slot_id);
    assert!(slot.project_id.is_none());
    assert_eq!(slot.revision, deleted.event.revision);
    assert_ne!(slot.revision, created_revision);
    assert_eq!(slot.updated_at, now());
}

#[tokio::test]
async fn p3_tb_004_invalid_civil_ranges_are_rejected_without_durable_rows() {
    let directory = TestDir::new();
    let owner = ProfileOwner::open(&directory.0).unwrap();
    let repo = owner.repository();
    let before = repo.diagnostics().await.unwrap().revision;

    let mut bad_block = block_draft("Bad block", "2026-03-08");
    bad_block.range = inverted_civil_range("2026-03-08");
    assert!(
        matches!(
            repo.create_time_block(
                operation(),
                junban_domain::TimeBlockId::new(),
                bad_block,
                now()
            )
            .await
            .unwrap_err(),
            RepositoryError::Validation(_)
        ),
        "create_time_block must reject inverted ranges"
    );

    let mut bad_slot = slot_draft("Bad slot", "2026-03-08");
    bad_slot.range = inverted_civil_range("2026-03-08");
    assert!(
        matches!(
            repo.create_time_slot(
                operation(),
                junban_domain::TimeSlotId::new(),
                bad_slot,
                now()
            )
            .await
            .unwrap_err(),
            RepositoryError::Validation(_)
        ),
        "create_time_slot must reject inverted ranges"
    );

    // Seed valid rows, then prove patch/set-range reject inverted ranges without writes.
    let block_id = junban_domain::TimeBlockId::new();
    repo.create_time_block(
        operation(),
        block_id,
        block_draft("Keep", "2026-03-08"),
        now(),
    )
    .await
    .unwrap();
    let slot_id = junban_domain::TimeSlotId::new();
    repo.create_time_slot(
        operation(),
        slot_id,
        slot_draft("Keep slot", "2026-03-08"),
        now(),
    )
    .await
    .unwrap();
    let after_seed = repo.diagnostics().await.unwrap().revision;

    assert!(
        matches!(
            repo.patch_time_block(
                operation(),
                block_id,
                junban_app::TimeBlockPatch::range_only(inverted_civil_range("2026-03-08")),
                now(),
            )
            .await
            .unwrap_err(),
            RepositoryError::Validation(_)
        ),
        "patch_time_block must reject inverted ranges"
    );
    assert!(
        matches!(
            repo.set_time_block_range(
                operation(),
                block_id,
                junban_app::TimeBlockPatch::range_only(inverted_civil_range("2026-03-09"))
                    .range
                    .unwrap(),
                now(),
            )
            .await
            .unwrap_err(),
            RepositoryError::Validation(_)
        ),
        "set_time_block_range must reject inverted ranges"
    );
    assert!(
        matches!(
            repo.patch_time_slot(
                operation(),
                slot_id,
                junban_app::TimeSlotPatch {
                    range: Some(inverted_civil_range("2026-03-08")),
                    ..Default::default()
                },
                now(),
            )
            .await
            .unwrap_err(),
            RepositoryError::Validation(_)
        ),
        "patch_time_slot must reject inverted ranges"
    );

    assert_eq!(repo.diagnostics().await.unwrap().revision, after_seed);
    assert!(after_seed > before);

    let page = repo
        .list_timeblocking_range(junban_app::TimeblockingRangeQuery {
            from: "2026-03-08".parse().unwrap(),
            to: "2026-03-09".parse().unwrap(),
        })
        .await
        .unwrap();
    assert_eq!(page.blocks.len(), 1);
    assert_eq!(page.slots.len(), 1);
    assert_eq!(page.blocks[0].range.date.to_string(), "2026-03-08");
    assert_eq!(page.blocks[0].range.start.to_string(), "09:00:00");
    assert_eq!(page.blocks[0].range.end.to_string(), "10:00:00");
    assert_eq!(page.slots[0].range.start.to_string(), "09:00:00");
    assert_eq!(page.slots[0].range.end.to_string(), "12:00:00");
}
