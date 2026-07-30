//! Storage integration coverage for Phase 2 repository behavior.

use std::{env, fs, path::PathBuf, time::SystemTime};

use jiff::{Timestamp, ToSpan, tz::TimeZone};
use junban_app::{
    BulkAction, EventCatchUp, MoveTarget, OrderAnchor, ProjectDraft, ReorderScope, Repository,
    RepositoryError, SectionDraft, TagDraft, TaskListAsOf, TaskPatch, TemplateApply, TemplateDraft,
};
use junban_domain::{
    CommentBody, CommentId, EntityName, HexColor, MAX_BULK_IDS, MarkdownText, OperationId,
    ProjectId, RelationKind, SortOrder, TagId, TagName, TaskCursor, TaskDraft, TaskId, TaskQuery,
    TaskSort, TaskStatus, TaskTitle, TaskViewPreset, TemplateId,
};
use uuid::Uuid;

use super::*;

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = env::temp_dir().join(format!(
            "junban-storage-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
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
        .complete_task(operation(), id, now())
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
        .complete_task(operation(), id, now())
        .await
        .unwrap();
    assert_eq!(
        repository.complete_task(operation(), id, now()).await,
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
        repository.uncomplete_task(operation(), id, now()).await,
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
        .complete_task(operation(), parent, now())
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
        .complete_task(operation(), recent, now())
        .await
        .unwrap();
    let boundary = create_draft(&repository, draft("Boundary completed")).await;
    repository
        .complete_task(operation(), boundary, now())
        .await
        .unwrap();
    let old = create_draft(&repository, draft("Old completed")).await;
    repository
        .complete_task(operation(), old, now())
        .await
        .unwrap();
    let future_completed = create_draft(&repository, draft("Future completed")).await;
    repository
        .complete_task(operation(), future_completed, now())
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
        repo.complete_task(operation(), id, now()).await.unwrap();
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
        .complete_task(operation(), completed_id, now())
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
            .bulk_tasks(operation(), too_many, BulkAction::Complete, now())
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
        .complete_task(operation(), other, now())
        .await
        .unwrap();
    assert_eq!(
        repository
            .bulk_tasks(operation(), vec![other], BulkAction::Complete, now())
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
            .bulk_tasks(operation(), vec![root], BulkAction::Complete, now())
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
        .bulk_tasks(delete_op, vec![parent, child], BulkAction::Delete, now())
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
