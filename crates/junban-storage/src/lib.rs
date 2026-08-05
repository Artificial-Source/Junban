//! SQLite persistence with one profile owner and one dedicated connection thread.

mod ai_ops;
mod ai_secrets;
mod backup_ops;
mod catalog_ops;
mod detail_ops;
mod helpers;
mod migration;
mod ops_types;
mod package_store;
mod plugin_ops;
mod plugin_validation;
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

pub use ai_secrets::{AiSecretStore, AiSecretStoreError};
pub use junban_app::AiSecretBytes;
pub use package_store::{PackageStoreError, PluginPackageStore};

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
    AiCredentialBindResult, AiCredentialBindingTarget, AiMemoryCursor, AiMemoryListPage,
    AiSessionCursor, AiSessionListPage, AppSettings, BulkAction, CatalogSnapshot, CommentPatch,
    CommittedMutation, EventCatchUp, ExportFormat, MoveTarget, PluginRepository,
    PreparedAiResponse, ProjectDraft, ProjectListPage, ProjectPatch, ReorderScope,
    ReplanPastBlocksAction, ReplanPastBlocksPreview, Repository, RepositoryError, RepositoryFuture,
    ReserveDailyAiResponseRequest, RewriteAiResponseRequest, SavedFilterDraft, SavedFilterPatch,
    SectionDraft, SectionPatch, SettingsPatch, StagedFile, SyncState, TagDraft, TagListPage,
    TagPatch, TaskListAsOf, TaskListPage, TaskPatch, TemplateApply, TemplateDraft, TemplatePatch,
    TemporalContext, TimeBlockPatch, TimeBlockRangePatch, TimeSlotPatch, TimeblockingRangePage,
    TimeblockingRangeQuery,
};
use junban_domain::{
    AiApprovalId, AiApprovalStatus, AiCredentialId, AiMemory, AiMemoryId, AiMessage,
    AiMessageContent, AiMessageId, AiMessageRole, AiMessageStatus, AiRunId, AiRunState,
    AiSecretKind, AiSecretMetadata, AiSession, AiSessionId, AiToolApproval, AiTurnId,
    ClaimedReminder, Comment, CommentBody, CommentId, EntityName, OperationId, Project, ProjectId,
    RelationKind, ReminderChannel, ReminderDeliveryLease, ReminderFailureCode, ReminderFenceTerm,
    ReminderOccurrence, SavedFilterId, SectionId, Tag, TagId, TagName, Task, TaskActivity,
    TaskDraft, TaskId, TaskQuery, TaskRelation, TemplateId, TimeBlockDraft, TimeBlockId,
    TimeSlotDraft, TimeSlotId, TransferApply, TransferFormat, TransferPreview,
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
/// Bounds pending commands retained ahead of the single SQLite owner.
const WORKER_QUEUE_CAPACITY: usize = 8;

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

/// Create a new owner-private file without changing permissions on its parent.
///
/// The file is protected before callers can write bytes. This is used for
/// operator-selected artifact destinations, whose existing parent directories
/// must never be chmodded by Junban.
pub fn create_owner_private_file(path: &Path) -> io::Result<File> {
    create_owner_private_file_with(path, protect_file_owner_only)
}

fn create_owner_private_file_with(
    path: &Path,
    protect: impl FnOnce(&File) -> io::Result<()>,
) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create_new(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::{Foundation::GENERIC_WRITE, Storage::FileSystem::WRITE_DAC};
        options.access_mode(GENERIC_WRITE | WRITE_DAC);
    }
    let file = options.open(path)?;
    if let Err(error) = protect(&file) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    #[cfg(unix)]
    set_private_file_permissions(path)?;
    Ok(file)
}

/// Create a protected same-directory temporary file for a private artifact.
pub fn create_private_artifact_temp(destination: &Path) -> io::Result<(File, PathBuf)> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("artifact");
    static ARTIFACT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let temp = parent.join(format!(
        ".junban-{}-{}-{name}.part",
        std::process::id(),
        ARTIFACT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let file = create_owner_private_file(&temp)?;
    Ok((file, temp))
}

/// Atomically publish a synced private same-directory temporary artifact.
///
/// With `overwrite=false`, publication atomically fails if the destination has
/// appeared. With `overwrite=true`, the old destination remains intact unless
/// replacement succeeds.
pub fn publish_private_artifact(
    temp: &Path,
    destination: &Path,
    overwrite: bool,
) -> io::Result<()> {
    publish_private_artifact_with(temp, destination, overwrite, |source, target, replace| {
        publish_file(source, target, replace)
    })
}

fn publish_private_artifact_with(
    temp: &Path,
    destination: &Path,
    overwrite: bool,
    publish: impl FnOnce(&Path, &Path, bool) -> io::Result<()>,
) -> io::Result<()> {
    publish(temp, destination, overwrite)?;
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    sync_directory(parent)
}

/// Atomically publish private bytes without mutating an existing parent mode.
pub fn atomic_publish_private_bytes(
    destination: &Path,
    contents: &[u8],
    overwrite: bool,
) -> io::Result<()> {
    let (mut file, temp) = create_private_artifact_temp(destination)?;
    let result = (|| {
        io::Write::write_all(&mut file, contents)?;
        file.sync_all()?;
        drop(file);
        publish_private_artifact(&temp, destination, overwrite)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Remove a private state file and durably publish the directory update on Unix.
pub fn remove_private_file_durable(path: &Path) -> io::Result<()> {
    fs::remove_file(path)?;
    sync_directory(path.parent().unwrap_or_else(|| Path::new(".")))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn publish_file(source: &Path, destination: &Path, overwrite: bool) -> io::Result<()> {
    if overwrite {
        return fs::rename(source, destination);
    }

    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "source path contains NUL"))?;
    let destination = CString::new(destination.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination path contains NUL")
    })?;
    // SAFETY: both C strings are NUL-terminated and remain live for the call.
    #[allow(unsafe_code)]
    let renamed = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if renamed == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_vendor = "apple")]
fn publish_file(source: &Path, destination: &Path, overwrite: bool) -> io::Result<()> {
    if overwrite {
        return fs::rename(source, destination);
    }

    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "source path contains NUL"))?;
    let destination = CString::new(destination.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination path contains NUL")
    })?;
    // SAFETY: both C strings are NUL-terminated and remain live for this call.
    #[allow(unsafe_code)]
    let renamed =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if renamed == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android")),
    not(target_vendor = "apple")
))]
fn publish_file(source: &Path, destination: &Path, overwrite: bool) -> io::Result<()> {
    if overwrite {
        fs::rename(source, destination)
    } else {
        // Junban does not publish immutable private artifacts through a temporary
        // hard link. Unsupported Unix targets fail closed until they provide an
        // atomic no-replace rename primitive.
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "atomic no-replace publication is unavailable",
        ))
    }
}

#[cfg(windows)]
fn publish_file(source: &Path, destination: &Path, overwrite: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    fn wide(path: &Path) -> io::Result<Vec<u16>> {
        let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path contains NUL",
            ));
        }
        value.push(0);
        Ok(value)
    }

    let source = wide(source)?;
    let destination = wide(destination)?;
    let flags = MOVEFILE_WRITE_THROUGH
        | if overwrite {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };
    // SAFETY: both values are live NUL-terminated UTF-16 paths.
    #[allow(unsafe_code)]
    let moved = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), flags) };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
fn publish_file(source: &Path, destination: &Path, overwrite: bool) -> io::Result<()> {
    if overwrite {
        fs::rename(source, destination)
    } else {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "atomic no-replace publication is unavailable",
        ))
    }
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
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::{Foundation::GENERIC_WRITE, Storage::FileSystem::WRITE_DAC};
            options.access_mode(GENERIC_WRITE | WRITE_DAC);
        }
        let mut file = options.open(&temp_path)?;
        // On Windows, inherited ACLs are not necessarily private. Protect the empty
        // file before any secret or security-policy bytes are written.
        protect_file_owner_only(&file)?;
        io::Write::write_all(&mut file, contents)?;
        file.sync_all()?;
        drop(file);
        set_private_file_permissions(&temp_path)?;
        before_rename(&temp_path)?;
        replace_file(&temp_path, path)?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(unix)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Windows path contains a NUL code unit",
            ));
        }
        wide.push(0);
        Ok(wide)
    }

    let source = wide_path(source)?;
    let destination = wide_path(destination)?;
    // SAFETY: both vectors are live, NUL-terminated UTF-16 strings for this call.
    // MoveFileExW documents WRITE_THROUGH as not returning until the move is flushed.
    #[allow(unsafe_code)]
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
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

/// Protect an already-open file for its owner before private bytes are written.
///
/// Unix callers create files as `0600`; Windows callers replace inherited access
/// with one protected owner-only DACL.
pub fn protect_file_owner_only(file: &File) -> io::Result<()> {
    #[cfg(windows)]
    {
        protect_file_owner_only_windows(file)
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        Ok(())
    }
}

#[cfg(windows)]
fn protect_file_owner_only_windows(file: &File) -> io::Result<()> {
    use std::{mem, os::windows::io::AsRawHandle, ptr};
    use windows_sys::Win32::{
        Foundation::{ERROR_SUCCESS, LocalFree},
        Security::{
            ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, AddAccessAllowedAceEx,
            Authorization::{GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo},
            DACL_SECURITY_INFORMATION, GetLengthSid, InitializeAcl, OWNER_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        },
        Storage::FileSystem::FILE_ALL_ACCESS,
    };

    let handle = file.as_raw_handle();
    let mut owner: PSID = ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: `handle` is a live file handle. Windows allocates `descriptor` and
    // points `owner` inside it; all unused output pointers are null.
    #[allow(unsafe_code)]
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status.cast_signed()));
    }
    if owner.is_null() || descriptor.is_null() {
        if !descriptor.is_null() {
            // SAFETY: a non-null descriptor returned by GetSecurityInfo uses LocalAlloc.
            #[allow(unsafe_code)]
            let _ = unsafe { LocalFree(descriptor) };
        }
        return Err(io::Error::other(
            "Windows did not return a file owner security descriptor",
        ));
    }

    let result = (|| {
        // SAFETY: a successful GetSecurityInfo returned a valid owner SID that
        // remains live until `descriptor` is freed below.
        #[allow(unsafe_code)]
        let sid_len = unsafe { GetLengthSid(owner) } as usize;
        if sid_len == 0 {
            return Err(io::Error::last_os_error());
        }
        let acl_len = mem::size_of::<ACL>()
            .checked_add(mem::size_of::<ACCESS_ALLOWED_ACE>() - mem::size_of::<u32>())
            .and_then(|length| length.checked_add(sid_len))
            .ok_or_else(|| io::Error::other("owner-only ACL size overflow"))?;
        let word_len = acl_len.div_ceil(mem::size_of::<usize>());
        let mut acl_words = vec![0_usize; word_len];
        let acl = acl_words.as_mut_ptr().cast::<ACL>();
        // SAFETY: `acl_words` is aligned and has at least `acl_len` writable
        // bytes; `owner` is valid for the duration of these calls.
        #[allow(unsafe_code)]
        let initialized = unsafe { InitializeAcl(acl, acl_len as u32, ACL_REVISION) };
        if initialized == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the initialized ACL has enough room for exactly this owner ACE.
        #[allow(unsafe_code)]
        let added = unsafe { AddAccessAllowedAceEx(acl, ACL_REVISION, 0, FILE_ALL_ACCESS, owner) };
        if added == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the handle, owner SID, and ACL remain valid through the call.
        // A protected DACL disables inherited ACEs and this ACL contains only owner.
        #[allow(unsafe_code)]
        let status = unsafe {
            SetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                acl,
                ptr::null(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status.cast_signed()));
        }
        Ok(())
    })();

    // SAFETY: GetSecurityInfo allocated this security descriptor with LocalAlloc.
    #[allow(unsafe_code)]
    let _ = unsafe { LocalFree(descriptor) };
    result
}

/// Advise the kernel that clean pages for `file` may leave the page cache.
///
/// Used after restore stages a private rollback snapshot (fsync'd, then dropped
/// from cache so candidate + rollback + live images do not multiply cgroup file
/// charge) and after AI/speech reconfigure drains, when `PRAGMA shrink_memory`
/// has already released SQLite's heap pager cache but the kernel may still hold
/// clean DB/WAL pages. This is a Linux-authoritative optimization; other targets
/// are a documented no-op. Callers must not `sync_all` merely to enable advice:
/// DONTNEED discards clean pages and leaves dirty pages intact.
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

/// Release SQLite heap pager state, then drop clean live DB/WAL page-cache pages.
///
/// Does not checkpoint, truncate, sync, or open another connection. Profile paths
/// never appear in returned error strings.
fn release_cached_connection_memory(connection: &Connection) -> Result<(), RepositoryError> {
    connection
        .execute_batch("PRAGMA shrink_memory")
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let Some(db_path) = connection.path().filter(|path| !path.is_empty()) else {
        return Ok(());
    };
    advise_live_sqlite_page_cache(Path::new(db_path))
}

/// Issue DONTNEED against the live main database and its `-wal` sidecar.
///
/// The main database file must exist. A missing WAL is normal (pre-write or after
/// truncate). `-shm` is intentionally skipped: it is small, actively mmap'd by the
/// live connection, and advising it only forces immediate refaults. No `sync_all`.
fn advise_live_sqlite_page_cache(db_path: &Path) -> Result<(), RepositoryError> {
    advise_sqlite_file_pages(db_path, true)?;
    let mut wal_path = db_path.as_os_str().to_os_string();
    wal_path.push("-wal");
    advise_sqlite_file_pages(Path::new(&wal_path), false)?;
    Ok(())
}

fn advise_sqlite_file_pages(path: &Path, required: bool) -> Result<(), RepositoryError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if !required && error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(RepositoryError::Storage(format!(
                "live database page-cache open failed: {}",
                error.kind()
            )));
        }
    };
    advise_dont_need_pages(&file).map_err(|error| {
        RepositoryError::Storage(format!(
            "live database page-cache advice failed: {}",
            error.kind()
        ))
    })
}

#[derive(Clone)]
pub struct SqliteRepository {
    worker: Arc<Worker>,
}

struct Worker {
    _lock: File,
    sender: Mutex<Option<mpsc::SyncSender<Command>>>,
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
        let (sender, receiver) = mpsc::sync_channel(WORKER_QUEUE_CAPACITY);
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let join = thread::Builder::new()
            .name("junban-sqlite".to_owned())
            .spawn(move || {
                let connection = open_connection(&database_path);
                match connection {
                    Ok(mut connection) => {
                        let startup = PluginPackageStore::open_for_reconciliation(&profile_dir)
                            .map_err(|error| RepositoryError::Storage(error.to_string()))
                            .and_then(|store| {
                                plugin_ops::reconcile_packages(
                                    &mut connection,
                                    &store,
                                    Timestamp::now(),
                                )?;
                                Ok(store)
                            });
                        match startup {
                            Ok(package_store) => {
                                let _ = ready_sender.send(Ok(()));
                                run_worker(&mut connection, profile_dir, package_store, receiver);
                            }
                            Err(error) => {
                                let _ = ready_sender.send(Err(error.to_string()));
                            }
                        }
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
            match sender.try_send(command(reply_sender)) {
                Ok(()) => {}
                Err(std::sync::mpsc::TrySendError::Full(_)) => {
                    return Err(RepositoryError::Storage(
                        "database worker queue is full".to_owned(),
                    ));
                }
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                    return Err(RepositoryError::Storage(
                        "database worker has stopped".to_owned(),
                    ));
                }
            }
            reply_receiver
                .await
                .map_err(|_| RepositoryError::Storage("database worker did not reply".to_owned()))?
        })
    }

    fn plugin_request<T>(
        &self,
        operation: impl FnOnce(&mut Connection, &PluginPackageStore) -> Result<T, RepositoryError>
        + Send
        + 'static,
    ) -> RepositoryFuture<'_, T>
    where
        T: Send + 'static,
    {
        self.request(move |reply| Command::Plugin {
            job: Box::new(move |connection, store| {
                let _ = reply.send(operation(connection, store));
            }),
        })
    }

    #[cfg(test)]
    fn block_worker(
        &self,
        entered: std::sync::mpsc::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    ) -> RepositoryFuture<'_, ()> {
        self.plugin_request(move |_, _| {
            let _ = entered.send(());
            release
                .recv()
                .map_err(|_| RepositoryError::Storage("test worker release dropped".to_owned()))
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

impl PluginRepository for SqliteRepository {
    fn publish_plugin_package(
        &self,
        staged: StagedFile,
    ) -> RepositoryFuture<'_, junban_app::PluginPackageAuthority> {
        self.plugin_request(move |_, store| {
            store
                .publish(staged)
                .map_err(|error| RepositoryError::Storage(error.to_string()))
        })
    }

    fn install_plugin_admission(
        &self,
        operation_id: OperationId,
        admission: junban_app::PluginPackageAdmission,
        request: junban_app::InstallPluginRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, junban_app::PluginMutationOutcome> {
        self.plugin_request(move |connection, store| {
            plugin_ops::install_plugin_admission(
                connection,
                store,
                operation_id,
                admission,
                request,
                now,
            )
        })
    }

    fn reconcile_plugin_packages(
        &self,
        now: Timestamp,
    ) -> RepositoryFuture<'_, junban_app::PluginPackageReconciliation> {
        self.plugin_request(move |connection, store| {
            plugin_ops::reconcile_packages(connection, store, now)
        })
    }

    fn get_installed_plugin_profile(
        &self,
    ) -> RepositoryFuture<'_, junban_app::InstalledPluginProfile> {
        self.plugin_request(|connection, _| plugin_ops::get_installed_plugin_profile(connection))
    }

    fn get_installed_plugin(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
    ) -> RepositoryFuture<'_, junban_app::InstalledPlugin> {
        self.plugin_request(move |connection, _| {
            plugin_ops::get_installed_plugin(connection, plugin_id)
        })
    }

    fn install_plugin(
        &self,
        operation_id: OperationId,
        request: junban_app::InstallPluginRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, junban_app::PluginMutationOutcome> {
        self.plugin_request(move |connection, store| {
            plugin_ops::install_plugin(connection, store, operation_id, request, now)
        })
    }

    fn uninstall_plugin(
        &self,
        operation_id: OperationId,
        plugin_id: junban_plugin_sdk::PluginId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, junban_app::PluginMutationOutcome> {
        self.plugin_request(move |connection, store| {
            plugin_ops::uninstall_plugin(connection, store, operation_id, plugin_id, now)
        })
    }

    fn set_plugin_desired_enabled(
        &self,
        operation_id: OperationId,
        plugin_id: junban_plugin_sdk::PluginId,
        enabled: bool,
        now: Timestamp,
    ) -> RepositoryFuture<'_, junban_app::PluginMutationOutcome> {
        self.plugin_request(move |connection, store| {
            plugin_ops::set_plugin_desired_enabled(
                connection,
                store,
                operation_id,
                plugin_id,
                enabled,
                now,
            )
        })
    }

    fn retry_plugin(
        &self,
        operation_id: OperationId,
        plugin_id: junban_plugin_sdk::PluginId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.plugin_request(move |connection, store| {
            plugin_ops::retry_plugin(connection, store, operation_id, plugin_id, now)
        })
    }

    fn list_publisher_trust(&self) -> RepositoryFuture<'_, Vec<junban_app::PublisherTrust>> {
        self.plugin_request(|connection, _| plugin_ops::list_publisher_trust(connection))
    }

    fn trust_publisher(
        &self,
        operation_id: OperationId,
        request: junban_app::TrustPublisherRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.plugin_request(move |connection, _| {
            plugin_ops::trust_publisher(connection, operation_id, request, now)
        })
    }

    fn revoke_publisher(
        &self,
        operation_id: OperationId,
        key_id: junban_plugin_sdk::Sha256Digest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.plugin_request(move |connection, _| {
            plugin_ops::revoke_publisher(connection, operation_id, key_id, now)
        })
    }

    fn get_community_plugin_policy(
        &self,
    ) -> RepositoryFuture<'_, junban_app::CommunityPluginPolicy> {
        self.plugin_request(|connection, _| plugin_ops::get_community_plugin_policy(connection))
    }

    fn set_community_plugin_policy(
        &self,
        operation_id: OperationId,
        enabled: bool,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.plugin_request(move |connection, _| {
            plugin_ops::set_community_plugin_policy(connection, operation_id, enabled, now)
        })
    }

    fn list_plugin_grants(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
    ) -> RepositoryFuture<'_, Vec<junban_app::PluginGrant>> {
        self.plugin_request(move |connection, _| {
            plugin_ops::list_plugin_grants(connection, plugin_id)
        })
    }

    fn replace_plugin_grants(
        &self,
        operation_id: OperationId,
        request: junban_app::ReplacePluginGrantsRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.plugin_request(move |connection, _| {
            plugin_ops::replace_plugin_grants(connection, operation_id, request, now)
        })
    }

    fn revoke_plugin_grants(
        &self,
        operation_id: OperationId,
        request: junban_app::RevokePluginGrantsRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.plugin_request(move |connection, _| {
            plugin_ops::revoke_plugin_grants(connection, operation_id, request, now)
        })
    }

    fn list_plugin_settings(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
    ) -> RepositoryFuture<'_, Vec<junban_app::PluginSetting>> {
        self.plugin_request(move |connection, _| {
            plugin_ops::list_plugin_settings(connection, plugin_id)
        })
    }

    fn set_plugin_setting(
        &self,
        operation_id: OperationId,
        request: junban_app::SetPluginSettingRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.plugin_request(move |connection, _| {
            plugin_ops::set_plugin_setting(connection, operation_id, request, now)
        })
    }

    fn delete_plugin_setting(
        &self,
        operation_id: OperationId,
        request: junban_app::DeletePluginSettingRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.plugin_request(move |connection, _| {
            plugin_ops::delete_plugin_setting(connection, operation_id, request, now)
        })
    }

    fn list_plugin_kv(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
    ) -> RepositoryFuture<'_, Vec<junban_app::PluginKvEntry>> {
        self.plugin_request(move |connection, _| plugin_ops::list_plugin_kv(connection, plugin_id))
    }

    fn patch_plugin_kv(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
        package_generation: u64,
        activation_epoch: u64,
        patch: junban_app::PluginKvPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, Vec<junban_app::PluginKvEntry>> {
        self.plugin_request(move |connection, _| {
            plugin_ops::patch_plugin_kv(
                connection,
                plugin_id,
                package_generation,
                activation_epoch,
                patch,
                now,
            )
        })
    }

    fn get_plugin_cursor(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
    ) -> RepositoryFuture<'_, junban_app::PluginEventCursor> {
        self.plugin_request(move |connection, _| {
            plugin_ops::get_plugin_cursor(connection, plugin_id)
        })
    }

    fn begin_plugin_resync(
        &self,
        request: junban_app::BeginPluginResyncRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, junban_app::PluginResyncSession> {
        self.plugin_request(move |connection, _| {
            plugin_ops::begin_plugin_resync(connection, request, now)
        })
    }

    fn list_plugin_resync_page(
        &self,
        request: junban_app::PluginResyncPageRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, junban_app::PluginResyncPage> {
        self.plugin_request(move |connection, _| {
            plugin_ops::list_plugin_resync_page(connection, request, now)
        })
    }

    fn advance_plugin_cursor(
        &self,
        request: junban_app::AdvancePluginCursorRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, junban_app::PluginEventCursor> {
        self.plugin_request(move |connection, _| {
            plugin_ops::advance_plugin_cursor(connection, request, now)
        })
    }

    fn reserve_plugin_invocation(
        &self,
        request: junban_app::ReservePluginInvocationRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, junban_app::ReservedPluginInvocation> {
        self.plugin_request(move |connection, _| {
            plugin_ops::reserve_plugin_invocation(connection, request, now)
        })
    }

    fn transition_plugin_invocation(
        &self,
        request: junban_app::TransitionPluginInvocationRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, junban_app::PluginInvocation> {
        self.plugin_request(move |connection, _| {
            plugin_ops::transition_plugin_invocation(connection, request, now)
        })
    }

    fn list_plugin_invocations(&self) -> RepositoryFuture<'_, Vec<junban_app::PluginInvocation>> {
        self.plugin_request(|connection, _| plugin_ops::list_plugin_invocations(connection))
    }

    fn complete_plugin_invocation(
        &self,
        operation_id: OperationId,
        plugin_id: junban_plugin_sdk::PluginId,
        package_generation: u64,
        activation_epoch: u64,
        now: Timestamp,
    ) -> RepositoryFuture<'_, junban_app::CommittedPluginInvocation> {
        self.plugin_request(move |connection, _| {
            plugin_ops::complete_plugin_invocation(
                connection,
                operation_id,
                plugin_id,
                package_generation,
                activation_epoch,
                now,
            )
        })
    }

    fn commit_plugin_invocation(
        &self,
        request: junban_app::PlannedPluginInvocationCommit,
        now: Timestamp,
    ) -> RepositoryFuture<'_, junban_app::CommittedPluginInvocation> {
        self.plugin_request(move |connection, _| {
            plugin_ops::commit_plugin_invocation(connection, request, now)
        })
    }

    fn update_plugin_bookkeeping(
        &self,
        update: junban_app::PluginBookkeepingUpdate,
        now: Timestamp,
    ) -> RepositoryFuture<'_, junban_app::InstalledPlugin> {
        self.plugin_request(move |connection, _| {
            plugin_ops::update_plugin_bookkeeping(connection, update, now)
        })
    }

    fn transition_plugin_health(
        &self,
        operation_id: OperationId,
        update: junban_app::PluginBookkeepingUpdate,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.plugin_request(move |connection, _| {
            plugin_ops::transition_plugin_health(connection, operation_id, update, now)
        })
    }
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
    fn list_projects_bounded(&self, limit: u32) -> RepositoryFuture<'_, ProjectListPage> {
        mut_cmd!(self, ListProjectsBounded { limit })
    }
    fn list_tags_bounded(&self, limit: u32) -> RepositoryFuture<'_, TagListPage> {
        mut_cmd!(self, ListTagsBounded { limit })
    }
    fn get_project(&self, project_id: ProjectId) -> RepositoryFuture<'_, Project> {
        mut_cmd!(self, GetProject { project_id })
    }
    fn get_projects_by_ids(
        &self,
        project_ids: Vec<ProjectId>,
    ) -> RepositoryFuture<'_, ProjectListPage> {
        mut_cmd!(self, GetProjectsByIds { project_ids })
    }
    fn get_project_by_name(&self, name: EntityName) -> RepositoryFuture<'_, Project> {
        mut_cmd!(self, GetProjectByName { name })
    }
    fn resolve_tags_by_names(&self, names: Vec<TagName>) -> RepositoryFuture<'_, Vec<Tag>> {
        mut_cmd!(self, ResolveTagsByNames { names })
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

    fn create_ai_session(
        &self,
        operation_id: OperationId,
        session_id: AiSessionId,
        title: String,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CreateAiSession {
                operation_id,
                session_id,
                title,
                now
            }
        )
    }

    fn rename_ai_session(
        &self,
        operation_id: OperationId,
        session_id: AiSessionId,
        title: String,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            RenameAiSession {
                operation_id,
                session_id,
                title,
                now
            }
        )
    }

    fn delete_ai_session(
        &self,
        operation_id: OperationId,
        session_id: AiSessionId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            DeleteAiSession {
                operation_id,
                session_id,
                now
            }
        )
    }

    fn clear_ai_session(
        &self,
        operation_id: OperationId,
        session_id: AiSessionId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            ClearAiSession {
                operation_id,
                session_id,
                now
            }
        )
    }

    fn get_ai_session(&self, session_id: AiSessionId) -> RepositoryFuture<'_, AiSession> {
        mut_cmd!(self, GetAiSession { session_id })
    }

    fn list_ai_sessions(
        &self,
        cursor: Option<AiSessionCursor>,
        limit: u32,
    ) -> RepositoryFuture<'_, AiSessionListPage> {
        mut_cmd!(self, ListAiSessions { cursor, limit })
    }

    fn upsert_ai_message(
        &self,
        operation_id: OperationId,
        message_id: AiMessageId,
        session_id: AiSessionId,
        turn_id: AiTurnId,
        role: AiMessageRole,
        status: AiMessageStatus,
        content: AiMessageContent,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            UpsertAiMessage {
                operation_id,
                message_id,
                session_id,
                turn_id,
                role,
                status,
                content,
                now
            }
        )
    }

    fn get_ai_message(&self, message_id: AiMessageId) -> RepositoryFuture<'_, AiMessage> {
        mut_cmd!(self, GetAiMessage { message_id })
    }

    fn list_ai_messages(
        &self,
        session_id: AiSessionId,
        after_sequence: Option<u32>,
        limit: u32,
    ) -> RepositoryFuture<'_, Vec<AiMessage>> {
        mut_cmd!(
            self,
            ListAiMessages {
                session_id,
                after_sequence,
                limit
            }
        )
    }

    fn create_ai_memory(
        &self,
        operation_id: OperationId,
        memory_id: AiMemoryId,
        content: String,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CreateAiMemory {
                operation_id,
                memory_id,
                content,
                now
            }
        )
    }

    fn update_ai_memory(
        &self,
        operation_id: OperationId,
        memory_id: AiMemoryId,
        content: String,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            UpdateAiMemory {
                operation_id,
                memory_id,
                content,
                now
            }
        )
    }

    fn delete_ai_memory(
        &self,
        operation_id: OperationId,
        memory_id: AiMemoryId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            DeleteAiMemory {
                operation_id,
                memory_id,
                now
            }
        )
    }

    fn link_ai_session_memory(
        &self,
        operation_id: OperationId,
        session_id: AiSessionId,
        memory_id: AiMemoryId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            LinkAiSessionMemory {
                operation_id,
                session_id,
                memory_id,
                now
            }
        )
    }

    fn get_ai_memory(&self, memory_id: AiMemoryId) -> RepositoryFuture<'_, AiMemory> {
        mut_cmd!(self, GetAiMemory { memory_id })
    }

    fn list_ai_memories(
        &self,
        cursor: Option<AiMemoryCursor>,
        limit: u32,
    ) -> RepositoryFuture<'_, AiMemoryListPage> {
        mut_cmd!(self, ListAiMemories { cursor, limit })
    }

    fn select_ai_memories_for_context(
        &self,
        session_id: Option<AiSessionId>,
        limit: u32,
    ) -> RepositoryFuture<'_, Vec<AiMemory>> {
        mut_cmd!(self, SelectAiMemoriesForContext { session_id, limit })
    }

    fn propose_ai_approval(
        &self,
        operation_id: OperationId,
        approval_id: AiApprovalId,
        session_id: AiSessionId,
        turn_id: AiTurnId,
        run_id: AiRunId,
        generation: u64,
        tool_name: String,
        arguments_json: String,
        assistant_content: AiMessageContent,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            ProposeAiApproval {
                operation_id,
                approval_id,
                session_id,
                turn_id,
                run_id,
                generation,
                tool_name,
                arguments_json,
                assistant_content,
                now
            }
        )
    }

    fn set_ai_approval_status(
        &self,
        operation_id: OperationId,
        approval_id: AiApprovalId,
        status: AiApprovalStatus,
        dispatch_operation_id: Option<String>,
        assistant_content: Option<AiMessageContent>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            SetAiApprovalStatus {
                operation_id,
                approval_id,
                status,
                dispatch_operation_id,
                assistant_content,
                now
            }
        )
    }

    fn get_ai_approval(&self, approval_id: AiApprovalId) -> RepositoryFuture<'_, AiToolApproval> {
        mut_cmd!(self, GetAiApproval { approval_id })
    }

    fn list_dispatching_ai_approvals(&self) -> RepositoryFuture<'_, Vec<AiToolApproval>> {
        mut_cmd!(self, ListDispatchingAiApprovals {})
    }

    fn recover_operation_receipt(
        &self,
        operation_id: OperationId,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(self, RecoverOperationReceipt { operation_id })
    }

    fn upsert_ai_run_state(
        &self,
        operation_id: OperationId,
        state: AiRunState,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            UpsertAiRunState {
                operation_id,
                state,
                now
            }
        )
    }

    fn get_ai_run_state(&self, run_id: AiRunId) -> RepositoryFuture<'_, AiRunState> {
        mut_cmd!(self, GetAiRunState { run_id })
    }

    fn get_ai_run_for_assistant(
        &self,
        assistant_message_id: AiMessageId,
    ) -> RepositoryFuture<'_, AiRunState> {
        mut_cmd!(
            self,
            GetAiRunForAssistant {
                assistant_message_id
            }
        )
    }

    fn ensure_ai_response_current(&self, run_id: AiRunId) -> RepositoryFuture<'_, ()> {
        mut_cmd!(self, EnsureAiResponseCurrent { run_id })
    }

    fn reserve_daily_ai_response(
        &self,
        operation_id: OperationId,
        request: ReserveDailyAiResponseRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, PreparedAiResponse> {
        mut_cmd!(
            self,
            ReserveDailyAiResponse {
                operation_id,
                request,
                now
            }
        )
    }

    fn rewrite_ai_response(
        &self,
        operation_id: OperationId,
        request: RewriteAiResponseRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, PreparedAiResponse> {
        mut_cmd!(
            self,
            RewriteAiResponse {
                operation_id,
                request,
                now
            }
        )
    }

    fn cancel_ai_response(
        &self,
        operation_id: OperationId,
        assistant_message_id: AiMessageId,
        session_id: AiSessionId,
        turn_id: AiTurnId,
        run_id: AiRunId,
        generation: u64,
        content: AiMessageContent,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            CancelAiResponse {
                operation_id,
                assistant_message_id,
                session_id,
                turn_id,
                run_id,
                generation,
                content,
                now
            }
        )
    }

    fn finish_ai_response(
        &self,
        operation_id: OperationId,
        assistant_message_id: AiMessageId,
        session_id: AiSessionId,
        turn_id: AiTurnId,
        run_id: AiRunId,
        generation: u64,
        message_status: AiMessageStatus,
        content: AiMessageContent,
        run_phase: junban_domain::AiRunPhase,
        dispatch_operation_id: Option<String>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            FinishAiResponse {
                operation_id,
                assistant_message_id,
                session_id,
                turn_id,
                run_id,
                generation,
                message_status,
                content,
                run_phase,
                dispatch_operation_id,
                now
            }
        )
    }

    fn list_ai_secret_metadata(&self) -> RepositoryFuture<'_, Vec<AiSecretMetadata>> {
        mut_cmd!(self, ListAiSecretMetadata {})
    }

    fn resolve_ai_secret(
        &self,
        credential_id: AiCredentialId,
    ) -> RepositoryFuture<'_, AiSecretBytes> {
        mut_cmd!(self, ResolveAiSecret { credential_id })
    }

    fn bind_ai_credential(
        &self,
        operation_id: OperationId,
        target: AiCredentialBindingTarget,
        kind: AiSecretKind,
        secret: Option<AiSecretBytes>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, AiCredentialBindResult> {
        mut_cmd!(
            self,
            BindAiCredential {
                operation_id,
                target,
                kind,
                secret,
                now
            }
        )
    }

    fn clear_ai_credential_binding(
        &self,
        operation_id: OperationId,
        target: AiCredentialBindingTarget,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        mut_cmd!(
            self,
            ClearAiCredentialBinding {
                operation_id,
                target,
                now
            }
        )
    }

    fn release_cached_memory(&self) -> RepositoryFuture<'_, ()> {
        self.request(|reply| Command::ReleaseCachedMemory { reply })
    }
}

type PluginJob = Box<dyn FnOnce(&mut Connection, &PluginPackageStore) + Send>;

#[allow(clippy::large_enum_variant)]
enum Command {
    Plugin {
        job: PluginJob,
    },
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
    ListProjectsBounded {
        limit: u32,
        reply: oneshot::Sender<Result<ProjectListPage, RepositoryError>>,
    },
    ListTagsBounded {
        limit: u32,
        reply: oneshot::Sender<Result<TagListPage, RepositoryError>>,
    },
    GetProject {
        project_id: ProjectId,
        reply: oneshot::Sender<Result<Project, RepositoryError>>,
    },
    GetProjectsByIds {
        project_ids: Vec<ProjectId>,
        reply: oneshot::Sender<Result<ProjectListPage, RepositoryError>>,
    },
    GetProjectByName {
        name: EntityName,
        reply: oneshot::Sender<Result<Project, RepositoryError>>,
    },
    ResolveTagsByNames {
        names: Vec<TagName>,
        reply: oneshot::Sender<Result<Vec<Tag>, RepositoryError>>,
    },
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
    CreateAiSession {
        operation_id: OperationId,
        session_id: AiSessionId,
        title: String,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    RenameAiSession {
        operation_id: OperationId,
        session_id: AiSessionId,
        title: String,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    DeleteAiSession {
        operation_id: OperationId,
        session_id: AiSessionId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    ClearAiSession {
        operation_id: OperationId,
        session_id: AiSessionId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    GetAiSession {
        session_id: AiSessionId,
        reply: oneshot::Sender<Result<AiSession, RepositoryError>>,
    },
    ListAiSessions {
        cursor: Option<AiSessionCursor>,
        limit: u32,
        reply: oneshot::Sender<Result<AiSessionListPage, RepositoryError>>,
    },
    UpsertAiMessage {
        operation_id: OperationId,
        message_id: AiMessageId,
        session_id: AiSessionId,
        turn_id: AiTurnId,
        role: AiMessageRole,
        status: AiMessageStatus,
        content: AiMessageContent,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    GetAiMessage {
        message_id: AiMessageId,
        reply: oneshot::Sender<Result<AiMessage, RepositoryError>>,
    },
    ListAiMessages {
        session_id: AiSessionId,
        after_sequence: Option<u32>,
        limit: u32,
        reply: oneshot::Sender<Result<Vec<AiMessage>, RepositoryError>>,
    },
    CreateAiMemory {
        operation_id: OperationId,
        memory_id: AiMemoryId,
        content: String,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    UpdateAiMemory {
        operation_id: OperationId,
        memory_id: AiMemoryId,
        content: String,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    DeleteAiMemory {
        operation_id: OperationId,
        memory_id: AiMemoryId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    LinkAiSessionMemory {
        operation_id: OperationId,
        session_id: AiSessionId,
        memory_id: AiMemoryId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    GetAiMemory {
        memory_id: AiMemoryId,
        reply: oneshot::Sender<Result<AiMemory, RepositoryError>>,
    },
    ListAiMemories {
        cursor: Option<AiMemoryCursor>,
        limit: u32,
        reply: oneshot::Sender<Result<AiMemoryListPage, RepositoryError>>,
    },
    SelectAiMemoriesForContext {
        session_id: Option<AiSessionId>,
        limit: u32,
        reply: oneshot::Sender<Result<Vec<AiMemory>, RepositoryError>>,
    },
    ProposeAiApproval {
        operation_id: OperationId,
        approval_id: AiApprovalId,
        session_id: AiSessionId,
        turn_id: AiTurnId,
        run_id: AiRunId,
        generation: u64,
        tool_name: String,
        arguments_json: String,
        assistant_content: AiMessageContent,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    SetAiApprovalStatus {
        operation_id: OperationId,
        approval_id: AiApprovalId,
        status: AiApprovalStatus,
        dispatch_operation_id: Option<String>,
        assistant_content: Option<AiMessageContent>,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    GetAiApproval {
        approval_id: AiApprovalId,
        reply: oneshot::Sender<Result<AiToolApproval, RepositoryError>>,
    },
    ListDispatchingAiApprovals {
        reply: oneshot::Sender<Result<Vec<AiToolApproval>, RepositoryError>>,
    },
    RecoverOperationReceipt {
        operation_id: OperationId,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    UpsertAiRunState {
        operation_id: OperationId,
        state: AiRunState,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    GetAiRunState {
        run_id: AiRunId,
        reply: oneshot::Sender<Result<AiRunState, RepositoryError>>,
    },
    GetAiRunForAssistant {
        assistant_message_id: AiMessageId,
        reply: oneshot::Sender<Result<AiRunState, RepositoryError>>,
    },
    EnsureAiResponseCurrent {
        run_id: AiRunId,
        reply: oneshot::Sender<Result<(), RepositoryError>>,
    },
    ReserveDailyAiResponse {
        operation_id: OperationId,
        request: ReserveDailyAiResponseRequest,
        now: Timestamp,
        reply: oneshot::Sender<Result<PreparedAiResponse, RepositoryError>>,
    },
    RewriteAiResponse {
        operation_id: OperationId,
        request: RewriteAiResponseRequest,
        now: Timestamp,
        reply: oneshot::Sender<Result<PreparedAiResponse, RepositoryError>>,
    },
    CancelAiResponse {
        operation_id: OperationId,
        assistant_message_id: AiMessageId,
        session_id: AiSessionId,
        turn_id: AiTurnId,
        run_id: AiRunId,
        generation: u64,
        content: AiMessageContent,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    FinishAiResponse {
        operation_id: OperationId,
        assistant_message_id: AiMessageId,
        session_id: AiSessionId,
        turn_id: AiTurnId,
        run_id: AiRunId,
        generation: u64,
        message_status: AiMessageStatus,
        content: AiMessageContent,
        run_phase: junban_domain::AiRunPhase,
        dispatch_operation_id: Option<String>,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    ListAiSecretMetadata {
        reply: oneshot::Sender<Result<Vec<AiSecretMetadata>, RepositoryError>>,
    },
    ResolveAiSecret {
        credential_id: AiCredentialId,
        reply: oneshot::Sender<Result<AiSecretBytes, RepositoryError>>,
    },
    BindAiCredential {
        operation_id: OperationId,
        target: AiCredentialBindingTarget,
        kind: AiSecretKind,
        secret: Option<AiSecretBytes>,
        now: Timestamp,
        reply: oneshot::Sender<Result<AiCredentialBindResult, RepositoryError>>,
    },
    ClearAiCredentialBinding {
        operation_id: OperationId,
        target: AiCredentialBindingTarget,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    ReleaseCachedMemory {
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
    package_store: PluginPackageStore,
    receiver: mpsc::Receiver<Command>,
) {
    for command in receiver {
        match command {
            Command::Plugin { job } => job(connection, &package_store),
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
            Command::ListProjectsBounded { limit, reply } => {
                let _ = reply.send(catalog_ops::list_projects_bounded(connection, limit));
            }
            Command::ListTagsBounded { limit, reply } => {
                let _ = reply.send(catalog_ops::list_tags_bounded(connection, limit));
            }
            Command::GetProject { project_id, reply } => {
                let _ = reply.send(catalog_ops::get_project(connection, project_id));
            }
            Command::GetProjectsByIds { project_ids, reply } => {
                let _ = reply.send(catalog_ops::get_projects_by_ids(connection, &project_ids));
            }
            Command::GetProjectByName { name, reply } => {
                let _ = reply.send(catalog_ops::get_project_by_name(connection, &name));
            }
            Command::ResolveTagsByNames { names, reply } => {
                let _ = reply.send(catalog_ops::resolve_tags_by_names(connection, &names));
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
            Command::CreateAiSession {
                operation_id,
                session_id,
                title,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::create_ai_session(
                    connection,
                    operation_id,
                    session_id,
                    title,
                    now,
                ));
            }
            Command::RenameAiSession {
                operation_id,
                session_id,
                title,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::rename_ai_session(
                    connection,
                    operation_id,
                    session_id,
                    title,
                    now,
                ));
            }
            Command::DeleteAiSession {
                operation_id,
                session_id,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::delete_ai_session(
                    connection,
                    operation_id,
                    session_id,
                    now,
                ));
            }
            Command::ClearAiSession {
                operation_id,
                session_id,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::clear_ai_session(
                    connection,
                    operation_id,
                    session_id,
                    now,
                ));
            }
            Command::GetAiSession { session_id, reply } => {
                let _ = reply.send(ai_ops::get_ai_session(connection, session_id));
            }
            Command::ListAiSessions {
                cursor,
                limit,
                reply,
            } => {
                let _ = reply.send(ai_ops::list_ai_sessions(connection, cursor, limit));
            }
            Command::UpsertAiMessage {
                operation_id,
                message_id,
                session_id,
                turn_id,
                role,
                status,
                content,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::upsert_ai_message(
                    connection,
                    operation_id,
                    message_id,
                    session_id,
                    turn_id,
                    role,
                    status,
                    content,
                    now,
                ));
            }
            Command::GetAiMessage { message_id, reply } => {
                let _ = reply.send(ai_ops::get_ai_message(connection, message_id));
            }
            Command::ListAiMessages {
                session_id,
                after_sequence,
                limit,
                reply,
            } => {
                let _ = reply.send(ai_ops::list_ai_messages(
                    connection,
                    session_id,
                    after_sequence,
                    limit,
                ));
            }
            Command::CreateAiMemory {
                operation_id,
                memory_id,
                content,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::create_ai_memory(
                    connection,
                    operation_id,
                    memory_id,
                    content,
                    now,
                ));
            }
            Command::UpdateAiMemory {
                operation_id,
                memory_id,
                content,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::update_ai_memory(
                    connection,
                    operation_id,
                    memory_id,
                    content,
                    now,
                ));
            }
            Command::DeleteAiMemory {
                operation_id,
                memory_id,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::delete_ai_memory(
                    connection,
                    operation_id,
                    memory_id,
                    now,
                ));
            }
            Command::LinkAiSessionMemory {
                operation_id,
                session_id,
                memory_id,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::link_ai_session_memory(
                    connection,
                    operation_id,
                    session_id,
                    memory_id,
                    now,
                ));
            }
            Command::GetAiMemory { memory_id, reply } => {
                let _ = reply.send(ai_ops::get_ai_memory(connection, memory_id));
            }
            Command::ListAiMemories {
                cursor,
                limit,
                reply,
            } => {
                let _ = reply.send(ai_ops::list_ai_memories(connection, cursor, limit));
            }
            Command::SelectAiMemoriesForContext {
                session_id,
                limit,
                reply,
            } => {
                let _ = reply.send(ai_ops::select_ai_memories_for_context(
                    connection, session_id, limit,
                ));
            }
            Command::ProposeAiApproval {
                operation_id,
                approval_id,
                session_id,
                turn_id,
                run_id,
                generation,
                tool_name,
                arguments_json,
                assistant_content,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::propose_ai_approval_with_content(
                    connection,
                    operation_id,
                    approval_id,
                    session_id,
                    turn_id,
                    run_id,
                    generation,
                    tool_name,
                    arguments_json,
                    assistant_content,
                    now,
                ));
            }
            Command::SetAiApprovalStatus {
                operation_id,
                approval_id,
                status,
                dispatch_operation_id,
                assistant_content,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::set_ai_approval_status_with_content(
                    connection,
                    operation_id,
                    approval_id,
                    status,
                    dispatch_operation_id,
                    assistant_content,
                    now,
                ));
            }
            Command::GetAiApproval { approval_id, reply } => {
                let _ = reply.send(ai_ops::get_ai_approval(connection, approval_id));
            }
            Command::ListDispatchingAiApprovals { reply } => {
                let _ = reply.send(ai_ops::list_dispatching_ai_approvals(connection));
            }
            Command::RecoverOperationReceipt {
                operation_id,
                reply,
            } => {
                let _ = reply.send(tx::recover_operation_receipt(connection, operation_id));
            }
            Command::UpsertAiRunState {
                operation_id,
                state,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::upsert_ai_run_state(
                    connection,
                    operation_id,
                    state,
                    now,
                ));
            }
            Command::GetAiRunState { run_id, reply } => {
                let _ = reply.send(ai_ops::get_ai_run_state(connection, run_id));
            }
            Command::GetAiRunForAssistant {
                assistant_message_id,
                reply,
            } => {
                let _ = reply.send(ai_ops::get_ai_run_for_assistant(
                    connection,
                    assistant_message_id,
                ));
            }
            Command::EnsureAiResponseCurrent { run_id, reply } => {
                let _ = reply.send(ai_ops::ensure_ai_response_current(connection, run_id));
            }
            Command::ReserveDailyAiResponse {
                operation_id,
                request,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::reserve_daily_ai_response(
                    connection,
                    operation_id,
                    request,
                    now,
                ));
            }
            Command::RewriteAiResponse {
                operation_id,
                request,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::rewrite_ai_response(
                    connection,
                    operation_id,
                    request,
                    now,
                ));
            }
            Command::CancelAiResponse {
                operation_id,
                assistant_message_id,
                session_id,
                turn_id,
                run_id,
                generation,
                content,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::cancel_ai_response(
                    connection,
                    operation_id,
                    assistant_message_id,
                    session_id,
                    turn_id,
                    run_id,
                    generation,
                    content,
                    now,
                ));
            }
            Command::FinishAiResponse {
                operation_id,
                assistant_message_id,
                session_id,
                turn_id,
                run_id,
                generation,
                message_status,
                content,
                run_phase,
                dispatch_operation_id,
                now,
                reply,
            } => {
                let _ = reply.send(ai_ops::finish_ai_response(
                    connection,
                    operation_id,
                    assistant_message_id,
                    session_id,
                    turn_id,
                    run_id,
                    generation,
                    message_status,
                    content,
                    run_phase,
                    dispatch_operation_id,
                    now,
                ));
            }
            Command::ListAiSecretMetadata { reply } => {
                let result = AiSecretStore::load(&profile_dir)
                    .map(|store| store.list_metadata())
                    .map_err(|error| {
                        RepositoryError::Storage(format!("ai-secrets load failed: {error}"))
                    });
                let _ = reply.send(result);
            }
            Command::ResolveAiSecret {
                credential_id,
                reply,
            } => {
                let result = AiSecretStore::load(&profile_dir)
                    .map_err(|error| {
                        RepositoryError::Storage(format!("ai-secrets load failed: {error}"))
                    })
                    .and_then(|store| {
                        store
                            .get_secret(&credential_id)
                            .map_err(|error| {
                                RepositoryError::Storage(format!(
                                    "ai-secrets resolve failed: {error}"
                                ))
                            })?
                            .ok_or(RepositoryError::NotFound)
                    });
                let _ = reply.send(result);
            }
            Command::BindAiCredential {
                operation_id,
                target,
                kind,
                secret,
                now,
                reply,
            } => {
                let result = settings_ops::bind_ai_credential(
                    connection,
                    &profile_dir,
                    operation_id,
                    target,
                    kind,
                    secret,
                    now,
                )
                .map(|(mutation, credential_id)| AiCredentialBindResult {
                    mutation,
                    credential_id,
                });
                let _ = reply.send(result);
            }
            Command::ClearAiCredentialBinding {
                operation_id,
                target,
                now,
                reply,
            } => {
                let _ = reply.send(settings_ops::clear_ai_credential_binding(
                    connection,
                    &profile_dir,
                    operation_id,
                    target,
                    now,
                ));
            }
            Command::ReleaseCachedMemory { reply } => {
                // sqlite3_db_release_memory via PRAGMA, then Linux DONTNEED on the
                // live main DB + WAL page cache. No durable writes, checkpoint, or
                // WAL truncate; missing WAL is normal.
                let result = release_cached_connection_memory(connection);
                let _ = reply.send(result);
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
    // Recover ephemeral AI authority before final quota reconciliation on every normal
    // successful open. One timestamp makes the whole recovery transaction canonical;
    // neither recovery step emits a global event or operation receipt.
    let opened_at = Timestamp::now();
    if let Err(error) = ai_ops::validate_ai_response_authority(&connection) {
        return Err(ai_open_error("response authority validation", error));
    }
    if let Err(error) = ai_ops::expire_ai_runtime_state(&connection, opened_at) {
        return Err(ai_open_error("runtime expiration", error));
    }
    if let Err(error) = ai_ops::recompute_ai_quotas(&connection) {
        return Err(ai_open_error("quota recompute", error));
    }
    // Secret reconciliation is best-effort/diagnostic-only when the private file is dirty.
    let _ = reconcile_ai_secrets_on_open(&connection, profile_dir);
    Ok(connection)
}

fn ai_open_error(context: &str, error: RepositoryError) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error {
            code: rusqlite::ErrorCode::Unknown,
            extended_code: 1,
        },
        Some(format!("AI {context} failed: {error}")),
    )
}

fn reconcile_ai_secrets_on_open(
    connection: &Connection,
    profile_dir: &Path,
) -> Result<(), RepositoryError> {
    let settings = settings_ops::get_settings(connection)?;
    let referenced = junban_domain::referenced_ai_credential_ids(&settings.ai, &settings.voice);
    match AiSecretStore::load(profile_dir) {
        Ok(store) => {
            // Failure to clean unreferenced secrets is diagnostic-only: settings remain
            // the sole binding authority and cannot address orphan file entries.
            let _ = store.reconcile_unreferenced(&referenced);
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(RepositoryError::Storage(error.to_string())),
    }
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
mod ai_wave1_tests;
#[cfg(test)]
mod ai_wave3a_tests;
#[cfg(test)]
mod tests;
