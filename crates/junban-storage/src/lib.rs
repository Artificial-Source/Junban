//! SQLite persistence with one profile owner and one dedicated connection thread.

mod catalog_ops;
mod detail_ops;
mod helpers;
mod migration;
mod ops_types;
mod query_ops;
mod rows;
#[cfg(feature = "scale-bench")]
pub mod scale_seed;
mod task_ops;
mod tx;
mod undo_ops;

use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};

use fs4::FileExt;
use jiff::Timestamp;
use junban_app::{
    BulkAction, CatalogSnapshot, CommentPatch, CommittedMutation, EventCatchUp, MoveTarget,
    ProjectDraft, ProjectPatch, ReorderScope, Repository, RepositoryError, RepositoryFuture,
    SavedFilterDraft, SavedFilterPatch, SectionDraft, SectionPatch, TagDraft, TagPatch,
    TaskListAsOf, TaskListPage, TaskPatch, TemplateApply, TemplateDraft, TemplatePatch,
    TemporalContext,
};
use junban_domain::{
    Comment, CommentBody, CommentId, OperationId, ProjectId, RelationKind, SavedFilterId,
    SectionId, TagId, Task, TaskActivity, TaskDraft, TaskId, TaskQuery, TaskRelation, TemplateId,
};
use rusqlite::Connection;
use thiserror::Error;
use tokio::sync::oneshot;

const DATABASE_FILE: &str = "junban.sqlite3";
const LOCK_FILE: &str = "profile.lock";
const BUSY_TIMEOUT: Duration = Duration::from_millis(2_500);
/// WAL pages between automatic PASSIVE checkpoints (4 KiB pages → 1 MiB).
///
/// SQLite's default is 1000 pages (~4 MiB). On a representative host, PASSIVE
/// checkpoint of a ~4 MiB WAL measured 400–600 ms and produced bulk/reorder
/// p95 stalls well above the Phase 2 scale budget. Bounding the threshold keeps
/// commit-path checkpoints small. Tradeoff: checkpoints run more often, so
/// median write cost can rise slightly while multi-hundred-millisecond outliers
/// are avoided. Durability and the single-owner writer model are unchanged.
pub(crate) const WAL_AUTOCHECKPOINT_PAGES: i64 = 250;
/// After a checkpoint, keep the WAL file from retaining more than ~1 MiB.
const WAL_JOURNAL_SIZE_LIMIT_BYTES: i64 = WAL_AUTOCHECKPOINT_PAGES * 4096;

#[derive(Debug, Error)]
pub enum OpenError {
    #[error("profile is already owned by another Junban process")]
    AlreadyOwned,
    #[error("could not prepare profile: {0}")]
    Io(#[from] io::Error),
    #[error("could not open database: {0}")]
    Database(String),
}

/// Keeps a profile's lock and SQLite worker alive together.
pub struct ProfileOwner {
    repository: SqliteRepository,
}

impl ProfileOwner {
    pub fn open(profile_dir: impl AsRef<Path>) -> Result<Self, OpenError> {
        let profile_dir = profile_dir.as_ref();
        ensure_private_dir(profile_dir)?;

        let lock_path = profile_dir.join(LOCK_FILE);
        let lock = open_private_file(&lock_path)?;
        FileExt::try_lock(&lock).map_err(|error| match error {
            fs4::TryLockError::WouldBlock => OpenError::AlreadyOwned,
            fs4::TryLockError::Error(error) => OpenError::Io(error),
        })?;

        let database_path = profile_dir.join(DATABASE_FILE);
        open_private_file(&database_path)?;
        let repository = SqliteRepository::start(database_path, lock)?;
        Ok(Self { repository })
    }

    #[must_use]
    pub fn repository(&self) -> SqliteRepository {
        self.repository.clone()
    }
}

pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub fn write_private_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    io::Write::write_all(&mut file, contents)?;
    file.sync_all()?;
    set_private_file_permissions(path)
}

fn open_private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    set_private_file_permissions(path)?;
    Ok(file)
}

pub(crate) fn set_private_file_permissions(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[derive(Clone)]
pub struct SqliteRepository {
    worker: Arc<Worker>,
}

struct Worker {
    _lock: File,
    sender: Mutex<Option<mpsc::Sender<Command>>>,
    join: Mutex<Option<thread::JoinHandle<()>>>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.sender.lock().expect("worker sender poisoned").take();
        if let Some(join) = self.join.lock().expect("worker join poisoned").take() {
            let _ = join.join();
        }
    }
}

impl SqliteRepository {
    fn start(database_path: PathBuf, lock: File) -> Result<Self, OpenError> {
        let (sender, receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let join = thread::Builder::new()
            .name("junban-sqlite".to_owned())
            .spawn(move || {
                let connection = open_connection(&database_path);
                match connection {
                    Ok(mut connection) => {
                        let _ = ready_sender.send(Ok(()));
                        run_worker(&mut connection, receiver);
                    }
                    Err(error) => {
                        let _ = ready_sender.send(Err(error.to_string()));
                    }
                }
            })?;

        match ready_receiver.recv() {
            Ok(Ok(())) => Ok(Self {
                worker: Arc::new(Worker {
                    _lock: lock,
                    sender: Mutex::new(Some(sender)),
                    join: Mutex::new(Some(join)),
                }),
            }),
            Ok(Err(error)) => {
                let _ = join.join();
                Err(OpenError::Database(error))
            }
            Err(error) => {
                let _ = join.join();
                Err(OpenError::Database(error.to_string()))
            }
        }
    }

    fn request<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<Result<T, RepositoryError>>) -> Command + Send + 'static,
    ) -> RepositoryFuture<'_, T>
    where
        T: Send + 'static,
    {
        let sender = self
            .worker
            .sender
            .lock()
            .expect("worker sender poisoned")
            .as_ref()
            .cloned();
        Box::pin(async move {
            let sender = sender.ok_or_else(|| {
                RepositoryError::Storage("database worker has stopped".to_owned())
            })?;
            let (reply_sender, reply_receiver) = oneshot::channel();
            sender
                .send(command(reply_sender))
                .map_err(|_| RepositoryError::Storage("database worker has stopped".to_owned()))?;
            reply_receiver
                .await
                .map_err(|_| RepositoryError::Storage("database worker did not reply".to_owned()))?
        })
    }

    #[cfg(test)]
    async fn diagnostics(&self) -> Result<Diagnostics, RepositoryError> {
        self.request(Command::Diagnostics).await
    }

    #[cfg(test)]
    async fn execute_batch(&self, sql: String) -> Result<(), RepositoryError> {
        self.request(move |reply| Command::ExecuteBatch { sql, reply })
            .await
    }
}

macro_rules! mut_cmd {
    ($self:ident, $variant:ident { $($field:ident),* }) => {
        $self.request(move |reply| Command::$variant { $($field,)* reply })
    };
}

impl Repository for SqliteRepository {
    fn create_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        draft: TaskDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CreateTask {
                operation_id,
                task_id,
                draft,
                now
            }
        )
    }
    fn get_task(&self, task_id: TaskId) -> RepositoryFuture<'_, Task> {
        mut_cmd!(self, GetTask { task_id })
    }
    fn patch_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        patch: TaskPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            PatchTask {
                operation_id,
                task_id,
                patch,
                now
            }
        )
    }
    fn complete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
        temporal: TemporalContext,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CompleteTask {
                operation_id,
                task_id,
                now,
                temporal
            }
        )
    }
    fn uncomplete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
        temporal: TemporalContext,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            UncompleteTask {
                operation_id,
                task_id,
                now,
                temporal
            }
        )
    }
    fn cancel_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CancelTask {
                operation_id,
                task_id,
                now
            }
        )
    }
    fn reopen_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            ReopenTask {
                operation_id,
                task_id,
                now
            }
        )
    }
    fn delete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            DeleteTask {
                operation_id,
                task_id,
                now
            }
        )
    }
    fn move_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        target: MoveTarget,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            MoveTask {
                operation_id,
                task_id,
                target,
                now
            }
        )
    }
    fn reorder_tasks(
        &self,
        operation_id: OperationId,
        scope: ReorderScope,
        ordered_ids: Vec<TaskId>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            ReorderTasks {
                operation_id,
                scope,
                ordered_ids,
                now
            }
        )
    }
    fn bulk_tasks(
        &self,
        operation_id: OperationId,
        task_ids: Vec<TaskId>,
        action: BulkAction,
        now: Timestamp,
        temporal: TemporalContext,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            BulkTasks {
                operation_id,
                task_ids,
                action,
                now,
                temporal
            }
        )
    }
    fn list_tasks(
        &self,
        query: TaskQuery,
        as_of: TaskListAsOf,
    ) -> RepositoryFuture<'_, TaskListPage> {
        mut_cmd!(self, ListTasks { query, as_of })
    }
    fn list_catalog(&self) -> RepositoryFuture<'_, CatalogSnapshot> {
        self.request(Command::ListCatalog)
    }
    fn create_project(
        &self,
        operation_id: OperationId,
        project_id: ProjectId,
        draft: ProjectDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CreateProject {
                operation_id,
                project_id,
                draft,
                now
            }
        )
    }
    fn patch_project(
        &self,
        operation_id: OperationId,
        project_id: ProjectId,
        patch: ProjectPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            PatchProject {
                operation_id,
                project_id,
                patch,
                now
            }
        )
    }
    fn delete_project(
        &self,
        operation_id: OperationId,
        project_id: ProjectId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            DeleteProject {
                operation_id,
                project_id,
                now
            }
        )
    }
    fn create_section(
        &self,
        operation_id: OperationId,
        section_id: SectionId,
        draft: SectionDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CreateSection {
                operation_id,
                section_id,
                draft,
                now
            }
        )
    }
    fn patch_section(
        &self,
        operation_id: OperationId,
        section_id: SectionId,
        patch: SectionPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            PatchSection {
                operation_id,
                section_id,
                patch,
                now
            }
        )
    }
    fn delete_section(
        &self,
        operation_id: OperationId,
        section_id: SectionId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            DeleteSection {
                operation_id,
                section_id,
                now
            }
        )
    }
    fn create_tag(
        &self,
        operation_id: OperationId,
        tag_id: TagId,
        draft: TagDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CreateTag {
                operation_id,
                tag_id,
                draft,
                now
            }
        )
    }
    fn patch_tag(
        &self,
        operation_id: OperationId,
        tag_id: TagId,
        patch: TagPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            PatchTag {
                operation_id,
                tag_id,
                patch,
                now
            }
        )
    }
    fn delete_tag(
        &self,
        operation_id: OperationId,
        tag_id: TagId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            DeleteTag {
                operation_id,
                tag_id,
                now
            }
        )
    }
    fn create_template(
        &self,
        operation_id: OperationId,
        template_id: TemplateId,
        draft: TemplateDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CreateTemplate {
                operation_id,
                template_id,
                draft,
                now
            }
        )
    }
    fn patch_template(
        &self,
        operation_id: OperationId,
        template_id: TemplateId,
        patch: TemplatePatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            PatchTemplate {
                operation_id,
                template_id,
                patch,
                now
            }
        )
    }
    fn delete_template(
        &self,
        operation_id: OperationId,
        template_id: TemplateId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            DeleteTemplate {
                operation_id,
                template_id,
                now
            }
        )
    }
    fn apply_template(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        apply: TemplateApply,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            ApplyTemplate {
                operation_id,
                task_id,
                apply,
                now
            }
        )
    }
    fn create_saved_filter(
        &self,
        operation_id: OperationId,
        filter_id: SavedFilterId,
        draft: SavedFilterDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CreateSavedFilter {
                operation_id,
                filter_id,
                draft,
                now
            }
        )
    }
    fn patch_saved_filter(
        &self,
        operation_id: OperationId,
        filter_id: SavedFilterId,
        patch: SavedFilterPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            PatchSavedFilter {
                operation_id,
                filter_id,
                patch,
                now
            }
        )
    }
    fn delete_saved_filter(
        &self,
        operation_id: OperationId,
        filter_id: SavedFilterId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            DeleteSavedFilter {
                operation_id,
                filter_id,
                now
            }
        )
    }
    fn create_comment(
        &self,
        operation_id: OperationId,
        comment_id: CommentId,
        task_id: TaskId,
        content: CommentBody,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CreateComment {
                operation_id,
                comment_id,
                task_id,
                content,
                now
            }
        )
    }
    fn patch_comment(
        &self,
        operation_id: OperationId,
        comment_id: CommentId,
        patch: CommentPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            PatchComment {
                operation_id,
                comment_id,
                patch,
                now
            }
        )
    }
    fn delete_comment(
        &self,
        operation_id: OperationId,
        comment_id: CommentId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            DeleteComment {
                operation_id,
                comment_id,
                now
            }
        )
    }
    fn list_comments(&self, task_id: TaskId) -> RepositoryFuture<'_, Vec<Comment>> {
        mut_cmd!(self, ListComments { task_id })
    }
    fn add_relation(
        &self,
        operation_id: OperationId,
        from_task_id: TaskId,
        to_task_id: TaskId,
        kind: RelationKind,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            AddRelation {
                operation_id,
                from_task_id,
                to_task_id,
                kind,
                now
            }
        )
    }
    fn remove_relation(
        &self,
        operation_id: OperationId,
        from_task_id: TaskId,
        to_task_id: TaskId,
        kind: RelationKind,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            RemoveRelation {
                operation_id,
                from_task_id,
                to_task_id,
                kind,
                now
            }
        )
    }
    fn list_relations(&self, task_id: TaskId) -> RepositoryFuture<'_, Vec<TaskRelation>> {
        mut_cmd!(self, ListRelations { task_id })
    }
    fn list_task_activity(
        &self,
        task_id: TaskId,
        after_revision: Option<u64>,
        after_sequence: Option<u32>,
        limit: u32,
    ) -> RepositoryFuture<'_, Vec<TaskActivity>> {
        mut_cmd!(
            self,
            ListTaskActivity {
                task_id,
                after_revision,
                after_sequence,
                limit
            }
        )
    }
    fn list_events(&self, since: u64) -> RepositoryFuture<'_, EventCatchUp> {
        mut_cmd!(self, ListEvents { since })
    }
    fn undo(
        &self,
        source_operation_id: OperationId,
        new_operation_id: OperationId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            Undo {
                source_operation_id,
                new_operation_id,
                now
            }
        )
    }
}

#[allow(clippy::large_enum_variant)]
enum Command {
    CreateTask {
        operation_id: OperationId,
        task_id: TaskId,
        draft: TaskDraft,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    GetTask {
        task_id: TaskId,
        reply: oneshot::Sender<Result<Task, RepositoryError>>,
    },
    PatchTask {
        operation_id: OperationId,
        task_id: TaskId,
        patch: TaskPatch,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    CompleteTask {
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
        temporal: TemporalContext,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    UncompleteTask {
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
        temporal: TemporalContext,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    CancelTask {
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    ReopenTask {
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    DeleteTask {
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    MoveTask {
        operation_id: OperationId,
        task_id: TaskId,
        target: MoveTarget,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    ReorderTasks {
        operation_id: OperationId,
        scope: ReorderScope,
        ordered_ids: Vec<TaskId>,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    BulkTasks {
        operation_id: OperationId,
        task_ids: Vec<TaskId>,
        action: BulkAction,
        now: Timestamp,
        temporal: TemporalContext,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    ListTasks {
        query: TaskQuery,
        as_of: TaskListAsOf,
        reply: oneshot::Sender<Result<TaskListPage, RepositoryError>>,
    },
    ListCatalog(oneshot::Sender<Result<CatalogSnapshot, RepositoryError>>),
    CreateProject {
        operation_id: OperationId,
        project_id: ProjectId,
        draft: ProjectDraft,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    PatchProject {
        operation_id: OperationId,
        project_id: ProjectId,
        patch: ProjectPatch,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    DeleteProject {
        operation_id: OperationId,
        project_id: ProjectId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    CreateSection {
        operation_id: OperationId,
        section_id: SectionId,
        draft: SectionDraft,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    PatchSection {
        operation_id: OperationId,
        section_id: SectionId,
        patch: SectionPatch,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    DeleteSection {
        operation_id: OperationId,
        section_id: SectionId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    CreateTag {
        operation_id: OperationId,
        tag_id: TagId,
        draft: TagDraft,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    PatchTag {
        operation_id: OperationId,
        tag_id: TagId,
        patch: TagPatch,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    DeleteTag {
        operation_id: OperationId,
        tag_id: TagId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    CreateTemplate {
        operation_id: OperationId,
        template_id: TemplateId,
        draft: TemplateDraft,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    PatchTemplate {
        operation_id: OperationId,
        template_id: TemplateId,
        patch: TemplatePatch,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    DeleteTemplate {
        operation_id: OperationId,
        template_id: TemplateId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    ApplyTemplate {
        operation_id: OperationId,
        task_id: TaskId,
        apply: TemplateApply,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    CreateSavedFilter {
        operation_id: OperationId,
        filter_id: SavedFilterId,
        draft: SavedFilterDraft,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    PatchSavedFilter {
        operation_id: OperationId,
        filter_id: SavedFilterId,
        patch: SavedFilterPatch,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    DeleteSavedFilter {
        operation_id: OperationId,
        filter_id: SavedFilterId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    CreateComment {
        operation_id: OperationId,
        comment_id: CommentId,
        task_id: TaskId,
        content: CommentBody,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    PatchComment {
        operation_id: OperationId,
        comment_id: CommentId,
        patch: CommentPatch,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    DeleteComment {
        operation_id: OperationId,
        comment_id: CommentId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    ListComments {
        task_id: TaskId,
        reply: oneshot::Sender<Result<Vec<Comment>, RepositoryError>>,
    },
    AddRelation {
        operation_id: OperationId,
        from_task_id: TaskId,
        to_task_id: TaskId,
        kind: RelationKind,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    RemoveRelation {
        operation_id: OperationId,
        from_task_id: TaskId,
        to_task_id: TaskId,
        kind: RelationKind,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    ListRelations {
        task_id: TaskId,
        reply: oneshot::Sender<Result<Vec<TaskRelation>, RepositoryError>>,
    },
    ListTaskActivity {
        task_id: TaskId,
        after_revision: Option<u64>,
        after_sequence: Option<u32>,
        limit: u32,
        reply: oneshot::Sender<Result<Vec<TaskActivity>, RepositoryError>>,
    },
    ListEvents {
        since: u64,
        reply: oneshot::Sender<Result<EventCatchUp, RepositoryError>>,
    },
    Undo {
        source_operation_id: OperationId,
        new_operation_id: OperationId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    #[cfg(test)]
    Diagnostics(oneshot::Sender<Result<Diagnostics, RepositoryError>>),
    #[cfg(test)]
    ExecuteBatch {
        sql: String,
        reply: oneshot::Sender<Result<(), RepositoryError>>,
    },
}

fn run_worker(connection: &mut Connection, receiver: mpsc::Receiver<Command>) {
    for command in receiver {
        match command {
            Command::CreateTask {
                operation_id,
                task_id,
                draft,
                now,
                reply,
            } => {
                let _ = reply.send(task_ops::create_task(
                    connection,
                    operation_id,
                    task_id,
                    draft,
                    now,
                ));
            }
            Command::GetTask { task_id, reply } => {
                let _ = reply.send(task_ops::get_task(connection, task_id));
            }
            Command::PatchTask {
                operation_id,
                task_id,
                patch,
                now,
                reply,
            } => {
                let _ = reply.send(task_ops::patch_task(
                    connection,
                    operation_id,
                    task_id,
                    patch,
                    now,
                ));
            }
            Command::CompleteTask {
                operation_id,
                task_id,
                now,
                temporal,
                reply,
            } => {
                let _ = reply.send(task_ops::complete_task(
                    connection,
                    operation_id,
                    task_id,
                    now,
                    temporal,
                ));
            }
            Command::UncompleteTask {
                operation_id,
                task_id,
                now,
                temporal,
                reply,
            } => {
                let _ = reply.send(task_ops::uncomplete_task(
                    connection,
                    operation_id,
                    task_id,
                    now,
                    temporal,
                ));
            }
            Command::CancelTask {
                operation_id,
                task_id,
                now,
                reply,
            } => {
                let _ = reply.send(task_ops::cancel_task(
                    connection,
                    operation_id,
                    task_id,
                    now,
                ));
            }
            Command::ReopenTask {
                operation_id,
                task_id,
                now,
                reply,
            } => {
                let _ = reply.send(task_ops::reopen_task(
                    connection,
                    operation_id,
                    task_id,
                    now,
                ));
            }
            Command::DeleteTask {
                operation_id,
                task_id,
                now,
                reply,
            } => {
                let _ = reply.send(task_ops::delete_task(
                    connection,
                    operation_id,
                    task_id,
                    now,
                ));
            }
            Command::MoveTask {
                operation_id,
                task_id,
                target,
                now,
                reply,
            } => {
                let _ = reply.send(task_ops::move_task(
                    connection,
                    operation_id,
                    task_id,
                    target,
                    now,
                ));
            }
            Command::ReorderTasks {
                operation_id,
                scope,
                ordered_ids,
                now,
                reply,
            } => {
                let _ = reply.send(task_ops::reorder_tasks(
                    connection,
                    operation_id,
                    scope,
                    ordered_ids,
                    now,
                ));
            }
            Command::BulkTasks {
                operation_id,
                task_ids,
                action,
                now,
                temporal,
                reply,
            } => {
                let _ = reply.send(task_ops::bulk_tasks(
                    connection,
                    operation_id,
                    task_ids,
                    action,
                    now,
                    temporal,
                ));
            }
            Command::ListTasks {
                query,
                as_of,
                reply,
            } => {
                let _ = reply.send(query_ops::list_tasks(connection, query, as_of));
            }
            Command::ListCatalog(reply) => {
                let _ = reply.send(catalog_ops::list_catalog(connection));
            }
            Command::CreateProject {
                operation_id,
                project_id,
                draft,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::create_project(
                    connection,
                    operation_id,
                    project_id,
                    draft,
                    now,
                ));
            }
            Command::PatchProject {
                operation_id,
                project_id,
                patch,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::patch_project(
                    connection,
                    operation_id,
                    project_id,
                    patch,
                    now,
                ));
            }
            Command::DeleteProject {
                operation_id,
                project_id,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::delete_project(
                    connection,
                    operation_id,
                    project_id,
                    now,
                ));
            }
            Command::CreateSection {
                operation_id,
                section_id,
                draft,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::create_section(
                    connection,
                    operation_id,
                    section_id,
                    draft,
                    now,
                ));
            }
            Command::PatchSection {
                operation_id,
                section_id,
                patch,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::patch_section(
                    connection,
                    operation_id,
                    section_id,
                    patch,
                    now,
                ));
            }
            Command::DeleteSection {
                operation_id,
                section_id,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::delete_section(
                    connection,
                    operation_id,
                    section_id,
                    now,
                ));
            }
            Command::CreateTag {
                operation_id,
                tag_id,
                draft,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::create_tag(
                    connection,
                    operation_id,
                    tag_id,
                    draft,
                    now,
                ));
            }
            Command::PatchTag {
                operation_id,
                tag_id,
                patch,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::patch_tag(
                    connection,
                    operation_id,
                    tag_id,
                    patch,
                    now,
                ));
            }
            Command::DeleteTag {
                operation_id,
                tag_id,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::delete_tag(
                    connection,
                    operation_id,
                    tag_id,
                    now,
                ));
            }
            Command::CreateTemplate {
                operation_id,
                template_id,
                draft,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::create_template(
                    connection,
                    operation_id,
                    template_id,
                    draft,
                    now,
                ));
            }
            Command::PatchTemplate {
                operation_id,
                template_id,
                patch,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::patch_template(
                    connection,
                    operation_id,
                    template_id,
                    patch,
                    now,
                ));
            }
            Command::DeleteTemplate {
                operation_id,
                template_id,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::delete_template(
                    connection,
                    operation_id,
                    template_id,
                    now,
                ));
            }
            Command::ApplyTemplate {
                operation_id,
                task_id,
                apply,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::apply_template(
                    connection,
                    operation_id,
                    task_id,
                    apply,
                    now,
                ));
            }
            Command::CreateSavedFilter {
                operation_id,
                filter_id,
                draft,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::create_saved_filter(
                    connection,
                    operation_id,
                    filter_id,
                    draft,
                    now,
                ));
            }
            Command::PatchSavedFilter {
                operation_id,
                filter_id,
                patch,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::patch_saved_filter(
                    connection,
                    operation_id,
                    filter_id,
                    patch,
                    now,
                ));
            }
            Command::DeleteSavedFilter {
                operation_id,
                filter_id,
                now,
                reply,
            } => {
                let _ = reply.send(catalog_ops::delete_saved_filter(
                    connection,
                    operation_id,
                    filter_id,
                    now,
                ));
            }
            Command::CreateComment {
                operation_id,
                comment_id,
                task_id,
                content,
                now,
                reply,
            } => {
                let _ = reply.send(detail_ops::create_comment(
                    connection,
                    operation_id,
                    comment_id,
                    task_id,
                    content,
                    now,
                ));
            }
            Command::PatchComment {
                operation_id,
                comment_id,
                patch,
                now,
                reply,
            } => {
                let _ = reply.send(detail_ops::patch_comment(
                    connection,
                    operation_id,
                    comment_id,
                    patch,
                    now,
                ));
            }
            Command::DeleteComment {
                operation_id,
                comment_id,
                now,
                reply,
            } => {
                let _ = reply.send(detail_ops::delete_comment(
                    connection,
                    operation_id,
                    comment_id,
                    now,
                ));
            }
            Command::ListComments { task_id, reply } => {
                let _ = reply.send(detail_ops::list_comments(connection, task_id));
            }
            Command::AddRelation {
                operation_id,
                from_task_id,
                to_task_id,
                kind,
                now,
                reply,
            } => {
                let _ = reply.send(detail_ops::add_relation(
                    connection,
                    operation_id,
                    from_task_id,
                    to_task_id,
                    kind,
                    now,
                ));
            }
            Command::RemoveRelation {
                operation_id,
                from_task_id,
                to_task_id,
                kind,
                now,
                reply,
            } => {
                let _ = reply.send(detail_ops::remove_relation(
                    connection,
                    operation_id,
                    from_task_id,
                    to_task_id,
                    kind,
                    now,
                ));
            }
            Command::ListRelations { task_id, reply } => {
                let _ = reply.send(detail_ops::list_relations(connection, task_id));
            }
            Command::ListTaskActivity {
                task_id,
                after_revision,
                after_sequence,
                limit,
                reply,
            } => {
                let _ = reply.send(detail_ops::list_task_activity(
                    connection,
                    task_id,
                    after_revision,
                    after_sequence,
                    limit,
                ));
            }
            Command::ListEvents { since, reply } => {
                let _ = reply.send(detail_ops::list_events(connection, since));
            }
            Command::Undo {
                source_operation_id,
                new_operation_id,
                now,
                reply,
            } => {
                let _ = reply.send(undo_ops::undo(
                    connection,
                    source_operation_id,
                    new_operation_id,
                    now,
                ));
            }
            #[cfg(test)]
            Command::Diagnostics(reply) => {
                let _ = reply.send(read_diagnostics(connection));
            }
            #[cfg(test)]
            Command::ExecuteBatch { sql, reply } => {
                let result = connection
                    .execute_batch(&sql)
                    .map_err(|e| RepositoryError::Storage(e.to_string()));
                let _ = reply.send(result);
            }
        }
    }
}

fn open_connection(path: &Path) -> rusqlite::Result<Connection> {
    let mut connection = Connection::open(path)?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "wal_autocheckpoint", WAL_AUTOCHECKPOINT_PAGES)?;
    connection.pragma_update(None, "journal_size_limit", WAL_JOURNAL_SIZE_LIMIT_BYTES)?;
    // Profile ownership is held by ProfileOwner before this runs. migrate needs the
    // profile directory so an existing v2 database can write a verified pre-v3 backup
    // beside the live DB under backups/pre-migration/.
    let profile_dir = path.parent().ok_or_else(|| {
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::Unknown,
                extended_code: 1,
            },
            Some(format!(
                "database path '{}' has no parent profile directory",
                path.display()
            )),
        )
    })?;
    migration::migrate(&mut connection, profile_dir)?;
    Ok(connection)
}

#[cfg(test)]
#[derive(Debug)]
struct Diagnostics {
    migration: i64,
    journal_mode: String,
    foreign_keys: i64,
    busy_timeout: i64,
    synchronous: i64,
    wal_autocheckpoint: i64,
    journal_size_limit: i64,
    tasks: i64,
    receipts: i64,
    activity: i64,
    events: i64,
    revision: i64,
}

#[cfg(test)]
fn read_diagnostics(connection: &Connection) -> Result<Diagnostics, RepositoryError> {
    Ok(Diagnostics {
        migration: connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .map_err(|e| RepositoryError::Storage(e.to_string()))?,
        journal_mode: connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .map_err(|e| RepositoryError::Storage(e.to_string()))?,
        foreign_keys: connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .map_err(|e| RepositoryError::Storage(e.to_string()))?,
        busy_timeout: connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .map_err(|e| RepositoryError::Storage(e.to_string()))?,
        synchronous: connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .map_err(|e| RepositoryError::Storage(e.to_string()))?,
        wal_autocheckpoint: connection
            .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
            .map_err(|e| RepositoryError::Storage(e.to_string()))?,
        journal_size_limit: connection
            .query_row("PRAGMA journal_size_limit", [], |row| row.get(0))
            .map_err(|e| RepositoryError::Storage(e.to_string()))?,
        tasks: table_count(connection, "tasks")?,
        receipts: table_count(connection, "operation_receipts")?,
        activity: table_count(connection, "activity")?,
        events: table_count(connection, "events")?,
        revision: connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .map_err(|e| RepositoryError::Storage(e.to_string()))?,
    })
}

#[cfg(test)]
fn table_count(connection: &Connection, table: &str) -> Result<i64, RepositoryError> {
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(|e| RepositoryError::Storage(e.to_string()))
}

#[cfg(test)]
mod tests;
