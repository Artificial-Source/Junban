//! SQLite persistence with one profile owner and one dedicated connection thread.

mod backup_ops;
mod catalog_ops;
mod detail_ops;
mod helpers;
mod migration;
mod ops_types;
mod query_ops;
mod reminder_ops;
mod rows;
#[cfg(feature = "scale-bench")]
pub mod scale_seed;
mod settings_ops;
mod task_ops;
mod timeblock_ops;
mod transfer_ops;
mod tx;
mod undo_ops;

use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use fs4::FileExt;
use jiff::{Timestamp, civil::Date};
use junban_app::{
    AppSettings, BulkAction, CatalogSnapshot, CommentPatch, CommittedMutation, EventCatchUp,
    ExportFormat, MoveTarget, ProjectDraft, ProjectPatch, ReorderScope, ReplanPastBlocksAction,
    ReplanPastBlocksPreview, Repository, RepositoryError, RepositoryFuture, SavedFilterDraft,
    SavedFilterPatch, SectionDraft, SectionPatch, SettingsPatch, StagedFile, SyncState, TagDraft,
    TagPatch, TaskListAsOf, TaskListPage, TaskPatch, TemplateApply, TemplateDraft, TemplatePatch,
    TemporalContext, TimeBlockPatch, TimeBlockRangePatch, TimeSlotPatch, TimeblockingRangePage,
    TimeblockingRangeQuery,
};
use junban_domain::{
    ClaimedReminder, Comment, CommentBody, CommentId, OperationId, ProjectId, RelationKind,
    ReminderChannel, ReminderDeliveryLease, ReminderFailureCode, ReminderFenceTerm,
    ReminderOccurrence, SavedFilterId, SectionId, TagId, Task, TaskActivity, TaskDraft, TaskId,
    TaskQuery, TaskRelation, TemplateId, TimeBlockDraft, TimeBlockId, TimeSlotDraft, TimeSlotId,
    TransferApply, TransferFormat, TransferPreview,
};
use rusqlite::Connection;
use thiserror::Error;
use tokio::sync::oneshot;

const DATABASE_FILE: &str = "junban.sqlite3";
const LOCK_FILE: &str = "profile.lock";
/// Durable fail-closed flag left by a restore whose apply and rollback both failed.
pub const RECOVERY_REQUIRED_FILE: &str = "recovery-required.json";
const RECOVERY_CUTOVER_FILE: &str = "recovery-cutover.json";
const RECOVERY_MARKER_VERSION: u8 = 1;
const RECOVERY_CUTOVER_VERSION: u8 = 1;
const BUSY_TIMEOUT: Duration = Duration::from_millis(2_500);

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryRequiredMarker {
    version: u8,
    reason: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryCutoverMarker {
    version: u8,
    candidate_file: String,
    rollback_dir: String,
    candidate_len: u64,
    candidate_sha256: String,
    schema_version: i64,
    event_epoch: String,
}
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

/// Profile-lock owner used when the normal SQLite worker cannot be constructed.
///
/// Recovery mode deliberately has no repository or application service. It can only
/// preflight a complete backup and replace the unavailable database for next restart.
pub struct RecoveryOwner {
    profile_dir: PathBuf,
    _lock: File,
}

impl RecoveryOwner {
    pub fn open(profile_dir: impl AsRef<Path>) -> Result<Self, OpenError> {
        let profile_dir = profile_dir.as_ref().to_path_buf();
        ensure_private_dir(&profile_dir)?;
        let lock_path = profile_dir.join(LOCK_FILE);
        let lock = open_private_file(&lock_path)?;
        FileExt::try_lock(&lock).map_err(|error| match error {
            fs4::TryLockError::WouldBlock => OpenError::AlreadyOwned,
            fs4::TryLockError::Error(error) => OpenError::Io(error),
        })?;
        reconcile_recovery_cutover(&profile_dir)
            .map_err(|error| OpenError::Database(error.to_string()))?;
        Ok(Self {
            profile_dir,
            _lock: lock,
        })
    }

    #[must_use]
    pub fn profile_dir(&self) -> &Path {
        &self.profile_dir
    }

    /// Strictly validate and epoch-rotate a complete backup before cutover.
    pub fn prepare_restore(&self, upload: StagedFile) -> Result<StagedFile, RepositoryError> {
        backup_ops::prepare_restore(&self.profile_dir, upload)
    }

    /// Replace the unavailable database while retaining its exact files for rollback.
    pub fn complete_restore(&self, candidate: StagedFile) -> Result<(), RepositoryError> {
        recovery_replace_database(&self.profile_dir, &candidate)?;
        clear_recovery_required(&self.profile_dir)
    }
}

/// Whether startup must retain the profile lock without opening SQLite normally.
///
/// Both markers are checked before `ProfileOwner` can create a missing database.
pub fn profile_recovery_required(profile_dir: &Path) -> io::Result<bool> {
    marker_exists_and_valid::<RecoveryRequiredMarker>(
        &profile_dir.join(RECOVERY_REQUIRED_FILE),
        |marker| {
            marker.version == RECOVERY_MARKER_VERSION && marker.reason == "catastrophic_restore"
        },
    )
    .and_then(|required| {
        if required {
            Ok(true)
        } else {
            marker_exists_and_valid::<RecoveryCutoverMarker>(
                &profile_dir.join(RECOVERY_CUTOVER_FILE),
                validate_cutover_marker_basics,
            )
        }
    })
}

fn marker_exists_and_valid<T: serde::de::DeserializeOwned>(
    path: &Path,
    validate: impl FnOnce(&T) -> bool,
) -> io::Result<bool> {
    match fs::read(path) {
        Ok(bytes) => {
            let marker: T = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
            if validate(&marker) {
                Ok(true)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid recovery marker",
                ))
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
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
        if profile_recovery_required(profile_dir)? {
            return Err(OpenError::Database(
                "profile requires recovery before normal admission".to_owned(),
            ));
        }

        let database_path = profile_dir.join(DATABASE_FILE);
        open_private_file(&database_path)
            .map_err(|error| OpenError::Database(error.to_string()))?;
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

/// Durably replace a private file without exposing a truncated intermediate value.
pub fn atomic_replace_private_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    atomic_replace_private_file_with(path, contents, |_| Ok(()))
}

fn persist_recovery_required(profile_dir: &Path) -> Result<(), RepositoryError> {
    let marker = RecoveryRequiredMarker {
        version: RECOVERY_MARKER_VERSION,
        reason: "catastrophic_restore".to_owned(),
    };
    let mut bytes =
        serde_json::to_vec(&marker).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    bytes.push(b'\n');
    atomic_replace_private_file(&profile_dir.join(RECOVERY_REQUIRED_FILE), &bytes)
        .map_err(|error| RepositoryError::Storage(error.to_string()))
}

fn clear_recovery_required(profile_dir: &Path) -> Result<(), RepositoryError> {
    let path = profile_dir.join(RECOVERY_REQUIRED_FILE);
    match fs::remove_file(&path) {
        Ok(()) => {
            sync_directory(profile_dir).map_err(|error| RepositoryError::Storage(error.to_string()))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(RepositoryError::Storage(error.to_string())),
    }
}

fn atomic_replace_private_file_with(
    path: &Path,
    contents: &[u8],
    before_rename: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "private file has no parent"))?;
    ensure_private_dir(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "private file name is not UTF-8",
            )
        })?;

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let temp_path = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp_path)?;
        io::Write::write_all(&mut file, contents)?;
        file.sync_all()?;
        set_private_file_permissions(&temp_path)?;
        before_rename(&temp_path)?;
        fs::rename(&temp_path, path)?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Private profile file holding operator-added Host allowlist entries (JSON string array).
pub const ALLOWED_HOSTS_FILE: &str = "allowed-hosts.json";

/// Load the effective Host allowlist: immutable CLI hosts plus any persisted extras.
pub fn load_allowed_hosts(
    profile_dir: &Path,
    cli_hosts: Vec<String>,
) -> io::Result<HashSet<String>> {
    let mut hosts: HashSet<String> = cli_hosts.into_iter().collect();
    let path = profile_dir.join(ALLOWED_HOSTS_FILE);
    match fs::read_to_string(&path) {
        Ok(data) => {
            let persisted: Vec<String> = serde_json::from_str(&data).map_err(io::Error::other)?;
            hosts.extend(persisted);
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    Ok(hosts)
}

/// Persist only hosts that were not supplied on the CLI (CLI hosts stay immutable).
pub fn save_allowed_hosts(
    profile_dir: &Path,
    hosts: &HashSet<String>,
    cli_hosts: &[String],
) -> io::Result<()> {
    save_allowed_hosts_with(profile_dir, hosts, cli_hosts, |_| Ok(()))
}

fn save_allowed_hosts_with(
    profile_dir: &Path,
    hosts: &HashSet<String>,
    cli_hosts: &[String],
    before_rename: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let cli_set: HashSet<&str> = cli_hosts.iter().map(String::as_str).collect();
    let mut persisted: Vec<&String> = hosts
        .iter()
        .filter(|host| !cli_set.contains(host.as_str()))
        .collect();
    persisted.sort();
    let path = profile_dir.join(ALLOWED_HOSTS_FILE);
    let mut json = serde_json::to_vec(&persisted).map_err(io::Error::other)?;
    json.push(b'\n');
    atomic_replace_private_file_with(&path, &json, before_rename)
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

/// Advise the kernel that clean pages for `file` may leave the page cache.
///
/// Restore keeps a private rollback snapshot durable on disk until apply finishes.
/// Once that snapshot is fsync'd, its pages need not stay resident: Linux cgroup
/// memory includes page cache, and holding candidate + rollback + live images at
/// once is what pushed peak restore over the frozen budget. This is a
/// Linux-authoritative optimization; other targets are a documented no-op.
///
/// # Errors
///
/// On Linux, returns the OS error when `posix_fadvise` returns nonzero. The fd is
/// left open and the on-disk file is unchanged either way.
#[cfg(target_os = "linux")]
pub(crate) fn advise_dont_need_pages(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    // SAFETY: `file` is an open owned fd; offset and len of 0 mean the whole file
    // per POSIX; `POSIX_FADV_DONTNEED` is a valid advice constant. `posix_fadvise`
    // does not close the fd or free caller-owned memory. It returns an errno value
    // directly (does not set errno).
    #[allow(unsafe_code)]
    let rc = unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
    if rc != 0 {
        Err(io::Error::from_raw_os_error(rc))
    } else {
        Ok(())
    }
}

/// Non-Linux platforms have no equivalent cgroup page-cache budget to enforce.
#[cfg(not(target_os = "linux"))]
pub(crate) fn advise_dont_need_pages(_file: &File) -> io::Result<()> {
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
        let profile_dir = database_path
            .parent()
            .ok_or_else(|| {
                OpenError::Database(format!(
                    "database path '{}' has no parent profile directory",
                    database_path.display()
                ))
            })?
            .to_path_buf();
        let (sender, receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let join = thread::Builder::new()
            .name("junban-sqlite".to_owned())
            .spawn(move || {
                let connection = open_connection(&database_path);
                match connection {
                    Ok(mut connection) => {
                        let _ = ready_sender.send(Ok(()));
                        run_worker(&mut connection, profile_dir, receiver);
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
    fn list_analysis_tasks(&self, as_of: TaskListAsOf) -> RepositoryFuture<'_, TaskListPage> {
        mut_cmd!(self, ListAnalysisTasks { as_of })
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
    fn get_sync_state(&self) -> RepositoryFuture<'_, SyncState> {
        mut_cmd!(self, GetSyncState {})
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
    fn list_task_reminders(
        &self,
        task_id: TaskId,
    ) -> RepositoryFuture<'_, Vec<ReminderOccurrence>> {
        // Compaction uses a sampled instant; list remains control-plane bookkeeping.
        let now = Timestamp::now();
        mut_cmd!(self, ListTaskReminders { task_id, now })
    }
    fn reschedule_reminder(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        remind_at: Timestamp,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            RescheduleReminder {
                operation_id,
                task_id,
                remind_at,
                now
            }
        )
    }
    fn dismiss_reminder(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            DismissReminder {
                operation_id,
                task_id,
                now
            }
        )
    }
    fn acquire_reminder_lease(
        &self,
        now: Timestamp,
        lease_secs: u64,
    ) -> RepositoryFuture<'_, ReminderDeliveryLease> {
        mut_cmd!(self, AcquireReminderLease { now, lease_secs })
    }
    fn renew_reminder_lease(
        &self,
        fence_term: ReminderFenceTerm,
        now: Timestamp,
        lease_secs: u64,
    ) -> RepositoryFuture<'_, ReminderDeliveryLease> {
        mut_cmd!(
            self,
            RenewReminderLease {
                fence_term,
                now,
                lease_secs
            }
        )
    }
    fn release_reminder_lease(
        &self,
        fence_term: ReminderFenceTerm,
        now: Timestamp,
    ) -> RepositoryFuture<'_, ()> {
        mut_cmd!(self, ReleaseReminderLease { fence_term, now })
    }
    fn claim_due_reminders(
        &self,
        fence_term: ReminderFenceTerm,
        now: Timestamp,
        limit: u32,
        claim_secs: u64,
    ) -> RepositoryFuture<'_, Vec<ClaimedReminder>> {
        mut_cmd!(
            self,
            ClaimDueReminders {
                fence_term,
                now,
                limit,
                claim_secs
            }
        )
    }
    fn settle_reminder_delivered(
        &self,
        fence_term: ReminderFenceTerm,
        task_id: TaskId,
        remind_at: Timestamp,
        claim_attempt: u32,
        channel: ReminderChannel,
        now: Timestamp,
    ) -> RepositoryFuture<'_, ()> {
        mut_cmd!(
            self,
            SettleReminderDelivered {
                fence_term,
                task_id,
                remind_at,
                claim_attempt,
                channel,
                now
            }
        )
    }
    fn settle_reminder_failed(
        &self,
        fence_term: ReminderFenceTerm,
        task_id: TaskId,
        remind_at: Timestamp,
        claim_attempt: u32,
        error: ReminderFailureCode,
        now: Timestamp,
    ) -> RepositoryFuture<'_, ()> {
        mut_cmd!(
            self,
            SettleReminderFailed {
                fence_term,
                task_id,
                remind_at,
                claim_attempt,
                error,
                now
            }
        )
    }
    fn mark_owner_lost_reminders(
        &self,
        fence_term: ReminderFenceTerm,
        now: Timestamp,
        limit: u32,
    ) -> RepositoryFuture<'_, u32> {
        mut_cmd!(
            self,
            MarkOwnerLostReminders {
                fence_term,
                now,
                limit
            }
        )
    }
    fn next_reminder_wake_at(&self) -> RepositoryFuture<'_, Option<Timestamp>> {
        mut_cmd!(self, NextReminderWakeAt {})
    }
    fn list_timeblocking_range(
        &self,
        query: TimeblockingRangeQuery,
    ) -> RepositoryFuture<'_, TimeblockingRangePage> {
        mut_cmd!(self, ListTimeblockingRange { query })
    }
    fn create_time_block(
        &self,
        operation_id: OperationId,
        block_id: TimeBlockId,
        draft: TimeBlockDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CreateTimeBlock {
                operation_id,
                block_id,
                draft,
                now
            }
        )
    }
    fn patch_time_block(
        &self,
        operation_id: OperationId,
        block_id: TimeBlockId,
        patch: TimeBlockPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            PatchTimeBlock {
                operation_id,
                block_id,
                patch,
                now
            }
        )
    }
    fn delete_time_block(
        &self,
        operation_id: OperationId,
        block_id: TimeBlockId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            DeleteTimeBlock {
                operation_id,
                block_id,
                now
            }
        )
    }
    fn create_time_slot(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        draft: TimeSlotDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CreateTimeSlot {
                operation_id,
                slot_id,
                draft,
                now
            }
        )
    }
    fn patch_time_slot(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        patch: TimeSlotPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            PatchTimeSlot {
                operation_id,
                slot_id,
                patch,
                now
            }
        )
    }
    fn delete_time_slot(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            DeleteTimeSlot {
                operation_id,
                slot_id,
                now
            }
        )
    }
    fn append_slot_task(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            AppendSlotTask {
                operation_id,
                slot_id,
                task_id,
                now
            }
        )
    }
    fn remove_slot_task(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            RemoveSlotTask {
                operation_id,
                slot_id,
                task_id,
                now
            }
        )
    }
    fn reorder_slot_tasks(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        ordered_ids: Vec<TaskId>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            ReorderSlotTasks {
                operation_id,
                slot_id,
                ordered_ids,
                now
            }
        )
    }
    fn set_time_block_range(
        &self,
        operation_id: OperationId,
        block_id: TimeBlockId,
        range: TimeBlockRangePatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            SetTimeBlockRange {
                operation_id,
                block_id,
                range,
                now
            }
        )
    }
    fn preview_replan_past_blocks(
        &self,
        temporal: TemporalContext,
    ) -> RepositoryFuture<'_, ReplanPastBlocksPreview> {
        mut_cmd!(self, PreviewReplanPastBlocks { temporal })
    }
    fn replan_past_blocks(
        &self,
        operation_id: OperationId,
        action: ReplanPastBlocksAction,
        expected_as_of_date: Date,
        expected_candidate_ids: Vec<TimeBlockId>,
        now: Timestamp,
        temporal: TemporalContext,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            ReplanPastBlocks {
                operation_id,
                action,
                expected_as_of_date,
                expected_candidate_ids,
                now,
                temporal
            }
        )
    }
    fn get_settings(&self) -> RepositoryFuture<'_, AppSettings> {
        mut_cmd!(self, GetSettings {})
    }
    fn patch_settings(
        &self,
        operation_id: OperationId,
        patch: SettingsPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            PatchSettings {
                operation_id,
                patch,
                now
            }
        )
    }
    fn preview_import(
        &self,
        format: TransferFormat,
        content: String,
    ) -> RepositoryFuture<'_, TransferPreview> {
        mut_cmd!(self, PreviewImport { format, content })
    }
    fn apply_import(
        &self,
        operation_id: OperationId,
        apply: TransferApply,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            ApplyImport {
                operation_id,
                apply,
                now
            }
        )
    }
    fn create_export(&self, format: ExportFormat) -> RepositoryFuture<'_, StagedFile> {
        mut_cmd!(self, CreateExport { format })
    }
    fn create_backup(&self) -> RepositoryFuture<'_, StagedFile> {
        mut_cmd!(self, CreateBackup {})
    }
    fn prepare_restore(&self, upload: StagedFile) -> RepositoryFuture<'_, StagedFile> {
        mut_cmd!(self, PrepareRestore { upload })
    }
    fn restore_backup(&self, candidate: StagedFile) -> RepositoryFuture<'_, ()> {
        mut_cmd!(self, RestoreBackup { candidate })
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
    ListAnalysisTasks {
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
    GetSyncState {
        reply: oneshot::Sender<Result<SyncState, RepositoryError>>,
    },
    Undo {
        source_operation_id: OperationId,
        new_operation_id: OperationId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    ListTaskReminders {
        task_id: TaskId,
        now: Timestamp,
        reply: oneshot::Sender<Result<Vec<ReminderOccurrence>, RepositoryError>>,
    },
    RescheduleReminder {
        operation_id: OperationId,
        task_id: TaskId,
        remind_at: Timestamp,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    DismissReminder {
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    AcquireReminderLease {
        now: Timestamp,
        lease_secs: u64,
        reply: oneshot::Sender<Result<ReminderDeliveryLease, RepositoryError>>,
    },
    RenewReminderLease {
        fence_term: ReminderFenceTerm,
        now: Timestamp,
        lease_secs: u64,
        reply: oneshot::Sender<Result<ReminderDeliveryLease, RepositoryError>>,
    },
    ReleaseReminderLease {
        fence_term: ReminderFenceTerm,
        now: Timestamp,
        reply: oneshot::Sender<Result<(), RepositoryError>>,
    },
    ClaimDueReminders {
        fence_term: ReminderFenceTerm,
        now: Timestamp,
        limit: u32,
        claim_secs: u64,
        reply: oneshot::Sender<Result<Vec<ClaimedReminder>, RepositoryError>>,
    },
    SettleReminderDelivered {
        fence_term: ReminderFenceTerm,
        task_id: TaskId,
        remind_at: Timestamp,
        claim_attempt: u32,
        channel: ReminderChannel,
        now: Timestamp,
        reply: oneshot::Sender<Result<(), RepositoryError>>,
    },
    SettleReminderFailed {
        fence_term: ReminderFenceTerm,
        task_id: TaskId,
        remind_at: Timestamp,
        claim_attempt: u32,
        error: ReminderFailureCode,
        now: Timestamp,
        reply: oneshot::Sender<Result<(), RepositoryError>>,
    },
    MarkOwnerLostReminders {
        fence_term: ReminderFenceTerm,
        now: Timestamp,
        limit: u32,
        reply: oneshot::Sender<Result<u32, RepositoryError>>,
    },
    NextReminderWakeAt {
        reply: oneshot::Sender<Result<Option<Timestamp>, RepositoryError>>,
    },
    ListTimeblockingRange {
        query: TimeblockingRangeQuery,
        reply: oneshot::Sender<Result<TimeblockingRangePage, RepositoryError>>,
    },
    CreateTimeBlock {
        operation_id: OperationId,
        block_id: TimeBlockId,
        draft: TimeBlockDraft,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    PatchTimeBlock {
        operation_id: OperationId,
        block_id: TimeBlockId,
        patch: TimeBlockPatch,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    DeleteTimeBlock {
        operation_id: OperationId,
        block_id: TimeBlockId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    CreateTimeSlot {
        operation_id: OperationId,
        slot_id: TimeSlotId,
        draft: TimeSlotDraft,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    PatchTimeSlot {
        operation_id: OperationId,
        slot_id: TimeSlotId,
        patch: TimeSlotPatch,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    DeleteTimeSlot {
        operation_id: OperationId,
        slot_id: TimeSlotId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    AppendSlotTask {
        operation_id: OperationId,
        slot_id: TimeSlotId,
        task_id: TaskId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    RemoveSlotTask {
        operation_id: OperationId,
        slot_id: TimeSlotId,
        task_id: TaskId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    ReorderSlotTasks {
        operation_id: OperationId,
        slot_id: TimeSlotId,
        ordered_ids: Vec<TaskId>,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    SetTimeBlockRange {
        operation_id: OperationId,
        block_id: TimeBlockId,
        range: TimeBlockRangePatch,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    PreviewReplanPastBlocks {
        temporal: TemporalContext,
        reply: oneshot::Sender<Result<ReplanPastBlocksPreview, RepositoryError>>,
    },
    ReplanPastBlocks {
        operation_id: OperationId,
        action: ReplanPastBlocksAction,
        expected_as_of_date: Date,
        expected_candidate_ids: Vec<TimeBlockId>,
        now: Timestamp,
        temporal: TemporalContext,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    GetSettings {
        reply: oneshot::Sender<Result<AppSettings, RepositoryError>>,
    },
    PatchSettings {
        operation_id: OperationId,
        patch: SettingsPatch,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    PreviewImport {
        format: TransferFormat,
        content: String,
        reply: oneshot::Sender<Result<TransferPreview, RepositoryError>>,
    },
    ApplyImport {
        operation_id: OperationId,
        apply: TransferApply,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    CreateExport {
        format: ExportFormat,
        reply: oneshot::Sender<Result<StagedFile, RepositoryError>>,
    },
    CreateBackup {
        reply: oneshot::Sender<Result<StagedFile, RepositoryError>>,
    },
    PrepareRestore {
        upload: StagedFile,
        reply: oneshot::Sender<Result<StagedFile, RepositoryError>>,
    },
    RestoreBackup {
        candidate: StagedFile,
        reply: oneshot::Sender<Result<(), RepositoryError>>,
    },
    #[cfg(test)]
    Diagnostics(oneshot::Sender<Result<Diagnostics, RepositoryError>>),
    #[cfg(test)]
    ExecuteBatch {
        sql: String,
        reply: oneshot::Sender<Result<(), RepositoryError>>,
    },
}

fn run_worker(
    connection: &mut Connection,
    profile_dir: PathBuf,
    receiver: mpsc::Receiver<Command>,
) {
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
            Command::ListAnalysisTasks { as_of, reply } => {
                let _ = reply.send(query_ops::list_analysis_tasks(connection, as_of));
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
            Command::GetSyncState { reply } => {
                let _ = reply.send(read_sync_state(connection));
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
            Command::ListTaskReminders {
                task_id,
                now,
                reply,
            } => {
                let _ = reply.send(reminder_ops::list_task_reminders(connection, task_id, now));
            }
            Command::RescheduleReminder {
                operation_id,
                task_id,
                remind_at,
                now,
                reply,
            } => {
                let _ = reply.send(reminder_ops::reschedule_reminder(
                    connection,
                    operation_id,
                    task_id,
                    remind_at,
                    now,
                ));
            }
            Command::DismissReminder {
                operation_id,
                task_id,
                now,
                reply,
            } => {
                let _ = reply.send(reminder_ops::dismiss_reminder(
                    connection,
                    operation_id,
                    task_id,
                    now,
                ));
            }
            Command::AcquireReminderLease {
                now,
                lease_secs,
                reply,
            } => {
                let _ = reply.send(reminder_ops::acquire_reminder_lease(
                    connection, now, lease_secs,
                ));
            }
            Command::RenewReminderLease {
                fence_term,
                now,
                lease_secs,
                reply,
            } => {
                let _ = reply.send(reminder_ops::renew_reminder_lease(
                    connection, fence_term, now, lease_secs,
                ));
            }
            Command::ReleaseReminderLease {
                fence_term,
                now,
                reply,
            } => {
                let _ = reply.send(reminder_ops::release_reminder_lease(
                    connection, fence_term, now,
                ));
            }
            Command::ClaimDueReminders {
                fence_term,
                now,
                limit,
                claim_secs,
                reply,
            } => {
                let _ = reply.send(reminder_ops::claim_due_reminders(
                    connection, fence_term, now, limit, claim_secs,
                ));
            }
            Command::SettleReminderDelivered {
                fence_term,
                task_id,
                remind_at,
                claim_attempt,
                channel,
                now,
                reply,
            } => {
                let _ = reply.send(reminder_ops::settle_reminder_delivered(
                    connection,
                    fence_term,
                    task_id,
                    remind_at,
                    claim_attempt,
                    channel,
                    now,
                ));
            }
            Command::SettleReminderFailed {
                fence_term,
                task_id,
                remind_at,
                claim_attempt,
                error,
                now,
                reply,
            } => {
                let _ = reply.send(reminder_ops::settle_reminder_failed(
                    connection,
                    fence_term,
                    task_id,
                    remind_at,
                    claim_attempt,
                    error,
                    now,
                ));
            }
            Command::MarkOwnerLostReminders {
                fence_term,
                now,
                limit,
                reply,
            } => {
                let _ = reply.send(reminder_ops::mark_owner_lost_reminders(
                    connection, fence_term, now, limit,
                ));
            }
            Command::NextReminderWakeAt { reply } => {
                let _ = reply.send(reminder_ops::next_reminder_wake_at(connection));
            }
            Command::ListTimeblockingRange { query, reply } => {
                let _ = reply.send(timeblock_ops::list_timeblocking_range(connection, query));
            }
            Command::CreateTimeBlock {
                operation_id,
                block_id,
                draft,
                now,
                reply,
            } => {
                let _ = reply.send(timeblock_ops::create_time_block(
                    connection,
                    operation_id,
                    block_id,
                    draft,
                    now,
                ));
            }
            Command::PatchTimeBlock {
                operation_id,
                block_id,
                patch,
                now,
                reply,
            } => {
                let _ = reply.send(timeblock_ops::patch_time_block(
                    connection,
                    operation_id,
                    block_id,
                    patch,
                    now,
                ));
            }
            Command::DeleteTimeBlock {
                operation_id,
                block_id,
                now,
                reply,
            } => {
                let _ = reply.send(timeblock_ops::delete_time_block(
                    connection,
                    operation_id,
                    block_id,
                    now,
                ));
            }
            Command::CreateTimeSlot {
                operation_id,
                slot_id,
                draft,
                now,
                reply,
            } => {
                let _ = reply.send(timeblock_ops::create_time_slot(
                    connection,
                    operation_id,
                    slot_id,
                    draft,
                    now,
                ));
            }
            Command::PatchTimeSlot {
                operation_id,
                slot_id,
                patch,
                now,
                reply,
            } => {
                let _ = reply.send(timeblock_ops::patch_time_slot(
                    connection,
                    operation_id,
                    slot_id,
                    patch,
                    now,
                ));
            }
            Command::DeleteTimeSlot {
                operation_id,
                slot_id,
                now,
                reply,
            } => {
                let _ = reply.send(timeblock_ops::delete_time_slot(
                    connection,
                    operation_id,
                    slot_id,
                    now,
                ));
            }
            Command::AppendSlotTask {
                operation_id,
                slot_id,
                task_id,
                now,
                reply,
            } => {
                let _ = reply.send(timeblock_ops::append_slot_task(
                    connection,
                    operation_id,
                    slot_id,
                    task_id,
                    now,
                ));
            }
            Command::RemoveSlotTask {
                operation_id,
                slot_id,
                task_id,
                now,
                reply,
            } => {
                let _ = reply.send(timeblock_ops::remove_slot_task(
                    connection,
                    operation_id,
                    slot_id,
                    task_id,
                    now,
                ));
            }
            Command::ReorderSlotTasks {
                operation_id,
                slot_id,
                ordered_ids,
                now,
                reply,
            } => {
                let _ = reply.send(timeblock_ops::reorder_slot_tasks(
                    connection,
                    operation_id,
                    slot_id,
                    ordered_ids,
                    now,
                ));
            }
            Command::SetTimeBlockRange {
                operation_id,
                block_id,
                range,
                now,
                reply,
            } => {
                let _ = reply.send(timeblock_ops::set_time_block_range(
                    connection,
                    operation_id,
                    block_id,
                    range,
                    now,
                ));
            }
            Command::PreviewReplanPastBlocks { temporal, reply } => {
                let _ = reply.send(timeblock_ops::preview_replan_past_blocks(
                    connection, temporal,
                ));
            }
            Command::ReplanPastBlocks {
                operation_id,
                action,
                expected_as_of_date,
                expected_candidate_ids,
                now,
                temporal,
                reply,
            } => {
                let _ = reply.send(timeblock_ops::replan_past_blocks(
                    connection,
                    operation_id,
                    action,
                    expected_as_of_date,
                    expected_candidate_ids,
                    now,
                    temporal,
                ));
            }
            Command::GetSettings { reply } => {
                let _ = reply.send(settings_ops::get_settings(connection));
            }
            Command::PatchSettings {
                operation_id,
                patch,
                now,
                reply,
            } => {
                let _ = reply.send(settings_ops::patch_settings(
                    connection,
                    operation_id,
                    patch,
                    now,
                ));
            }
            Command::PreviewImport {
                format,
                content,
                reply,
            } => {
                let _ = reply.send(transfer_ops::preview_import(connection, format, &content));
            }
            Command::ApplyImport {
                operation_id,
                apply,
                now,
                reply,
            } => {
                let _ = reply.send(transfer_ops::apply_import(
                    connection,
                    operation_id,
                    apply,
                    now,
                ));
            }
            Command::CreateExport { format, reply } => {
                let _ = reply.send(transfer_ops::create_export(
                    connection,
                    &profile_dir,
                    format,
                ));
            }
            Command::CreateBackup { reply } => {
                let _ = reply.send(backup_ops::create_backup(connection, &profile_dir));
            }
            Command::PrepareRestore { upload, reply } => {
                let _ = reply.send(backup_ops::prepare_restore(&profile_dir, upload));
            }
            Command::RestoreBackup { candidate, reply } => {
                let _ = reply.send(backup_ops::restore_backup(
                    connection,
                    &profile_dir,
                    candidate,
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

fn recovery_replace_database(
    profile_dir: &Path,
    candidate: &StagedFile,
) -> Result<(), RepositoryError> {
    recovery_replace_database_with(profile_dir, candidate, |_| Ok(()))
}

fn recovery_replace_database_with(
    profile_dir: &Path,
    candidate: &StagedFile,
    mut after_rename: impl FnMut(usize) -> io::Result<()>,
) -> Result<(), RepositoryError> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let backups_dir = profile_dir.join("backups").join("pre-recovery");
    ensure_private_dir(&backups_dir)
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| RepositoryError::Storage(error.to_string()))?
        .as_nanos();
    let rollback_name = format!("{stamp}-{}", std::process::id());
    let rollback_dir = backups_dir.join(&rollback_name);
    ensure_private_dir(&rollback_dir)
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;

    let staged_name = format!(".{DATABASE_FILE}.recovery-new");
    let staged = profile_dir.join(&staged_name);
    if staged.exists() {
        return Err(RepositoryError::Storage(
            "an earlier recovery candidate still requires reconciliation".to_owned(),
        ));
    }
    fs::copy(candidate.path(), &staged)
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    set_private_file_permissions(&staged)
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    File::open(&staged)
        .and_then(|file| file.sync_all())
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let (candidate_len, candidate_sha256, schema_version, event_epoch) =
        backup_ops::recovery_candidate_identity(&staged, profile_dir)?;
    let marker = RecoveryCutoverMarker {
        version: RECOVERY_CUTOVER_VERSION,
        candidate_file: staged_name,
        rollback_dir: format!("backups/pre-recovery/{rollback_name}"),
        candidate_len,
        candidate_sha256,
        schema_version,
        event_epoch,
    };
    write_cutover_marker(profile_dir, &marker)?;
    finish_recovery_cutover(profile_dir, &marker, &mut after_rename)
}

fn write_cutover_marker(
    profile_dir: &Path,
    marker: &RecoveryCutoverMarker,
) -> Result<(), RepositoryError> {
    let mut bytes =
        serde_json::to_vec(marker).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    bytes.push(b'\n');
    atomic_replace_private_file(&profile_dir.join(RECOVERY_CUTOVER_FILE), &bytes)
        .map_err(|error| RepositoryError::Storage(error.to_string()))
}

fn validate_cutover_marker_basics(marker: &RecoveryCutoverMarker) -> bool {
    marker.version == RECOVERY_CUTOVER_VERSION
        && marker.candidate_file == format!(".{DATABASE_FILE}.recovery-new")
        && marker.schema_version == migration::CURRENT_SCHEMA_VERSION
        && marker.candidate_len > 0
        && marker.candidate_sha256.len() == 64
        && marker
            .candidate_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && TaskId::parse(&marker.event_epoch).is_ok()
        && {
            let path = Path::new(&marker.rollback_dir);
            !path.is_absolute()
                && path.components().all(|component| {
                    matches!(
                        component,
                        std::path::Component::Normal(_) | std::path::Component::CurDir
                    )
                })
                && path.starts_with("backups/pre-recovery")
                && path.components().count() == 3
        }
}

fn read_cutover_marker(
    profile_dir: &Path,
) -> Result<Option<RecoveryCutoverMarker>, RepositoryError> {
    let path = profile_dir.join(RECOVERY_CUTOVER_FILE);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(RepositoryError::Storage(error.to_string())),
    };
    let marker: RecoveryCutoverMarker = serde_json::from_slice(&bytes)
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    if !validate_cutover_marker_basics(&marker) {
        return Err(RepositoryError::Storage(
            "invalid recovery cutover marker".to_owned(),
        ));
    }
    Ok(Some(marker))
}

fn reconcile_recovery_cutover(profile_dir: &Path) -> Result<(), RepositoryError> {
    let Some(marker) = read_cutover_marker(profile_dir)? else {
        return Ok(());
    };
    finish_recovery_cutover(profile_dir, &marker, &mut |_| Ok(()))
}

fn finish_recovery_cutover(
    profile_dir: &Path,
    marker: &RecoveryCutoverMarker,
    after_rename: &mut impl FnMut(usize) -> io::Result<()>,
) -> Result<(), RepositoryError> {
    let live = profile_dir.join(DATABASE_FILE);
    let staged = profile_dir.join(&marker.candidate_file);
    let rollback_dir = profile_dir.join(&marker.rollback_dir);
    ensure_private_dir(&rollback_dir)
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;

    if !staged.exists() {
        if !live.exists() {
            return Err(RepositoryError::Storage(
                "recovery cutover lost both candidate and live database".to_owned(),
            ));
        }
        backup_ops::validate_recovery_candidate(
            &live,
            profile_dir,
            marker.candidate_len,
            &marker.candidate_sha256,
            marker.schema_version,
            &marker.event_epoch,
        )?;
        return finalize_recovery_cutover(profile_dir);
    }

    backup_ops::validate_recovery_candidate(
        &staged,
        profile_dir,
        marker.candidate_len,
        &marker.candidate_sha256,
        marker.schema_version,
        &marker.event_epoch,
    )?;
    let live_files = [
        (live.clone(), rollback_dir.join(DATABASE_FILE)),
        (
            profile_dir.join(format!("{DATABASE_FILE}-wal")),
            rollback_dir.join(format!("{DATABASE_FILE}-wal")),
        ),
        (
            profile_dir.join(format!("{DATABASE_FILE}-shm")),
            rollback_dir.join(format!("{DATABASE_FILE}-shm")),
        ),
    ];
    let mut boundary = 0usize;
    for (source, backup) in live_files {
        if source.exists() {
            if backup.exists() {
                return Err(RepositoryError::Storage(format!(
                    "recovery rollback destination already exists: {}",
                    backup.display()
                )));
            }
            fs::rename(&source, &backup)
                .map_err(|error| RepositoryError::Storage(error.to_string()))?;
            after_rename(boundary).map_err(|error| RepositoryError::Storage(error.to_string()))?;
            boundary += 1;
        }
    }
    sync_directory(&rollback_dir)
        .and_then(|()| sync_directory(profile_dir))
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    fs::rename(&staged, &live).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    after_rename(boundary).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    backup_ops::validate_recovery_candidate(
        &live,
        profile_dir,
        marker.candidate_len,
        &marker.candidate_sha256,
        marker.schema_version,
        &marker.event_epoch,
    )?;
    finalize_recovery_cutover(profile_dir)
}

fn finalize_recovery_cutover(profile_dir: &Path) -> Result<(), RepositoryError> {
    sync_directory(profile_dir).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    fs::remove_file(profile_dir.join(RECOVERY_CUTOVER_FILE))
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    sync_directory(profile_dir).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    clear_recovery_required(profile_dir)
}

fn read_sync_state(connection: &Connection) -> Result<SyncState, RepositoryError> {
    connection
        .query_row(
            "SELECT event_epoch, global_revision FROM app_state WHERE singleton = 1",
            [],
            |row| {
                let revision = row.get::<_, i64>(1)?;
                let revision = u64::try_from(revision).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Integer,
                        Box::new(error),
                    )
                })?;
                Ok(SyncState {
                    event_epoch: row.get(0)?,
                    revision,
                })
            },
        )
        .map_err(|error| RepositoryError::Storage(error.to_string()))
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
