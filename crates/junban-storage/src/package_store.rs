//! Private immutable content-addressed JBP1 package authority.

use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use junban_app::{PluginPackageAuthority, StagedFile};
use junban_plugin_sdk::{PACKAGE_BYTES_MAX, Sha256Digest};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

use crate::{
    create_private_artifact_temp, publish_private_artifact, remove_private_file_durable,
    set_private_file_permissions,
};

const PACKAGES_RELATIVE: &[&str] = &["plugins", "packages", "sha256"];
const PACKAGE_EXTENSION: &str = "jbp";
const ORPHAN_SCAN_MAX: usize = 1_024;
const ORPHAN_GRACE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Error)]
pub enum PackageStoreError {
    #[error("plugin package is invalid")]
    InvalidPackage,
    #[error("plugin package path is unsafe")]
    UnsafePath,
    #[error("plugin package content does not match its authority")]
    AuthorityMismatch,
    #[error("plugin package store I/O failed")]
    Io,
}

#[derive(Clone, Debug)]
pub struct PluginPackageStore {
    profile_dir: PathBuf,
    root: PathBuf,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct OrphanCleanup {
    pub removed: usize,
    pub truncated: bool,
}

impl PluginPackageStore {
    pub fn open(profile_dir: &Path) -> Result<Self, PackageStoreError> {
        let store = Self::open_for_reconciliation(profile_dir)?;
        store.ensure_root()?;
        Ok(store)
    }

    /// Validate any existing package path without creating plugin storage for an
    /// empty profile. Publication creates the private hierarchy on first use.
    pub(crate) fn open_for_reconciliation(profile_dir: &Path) -> Result<Self, PackageStoreError> {
        if !strict_private_directory_exists(profile_dir)? {
            return Err(PackageStoreError::Io);
        }
        let mut current = profile_dir.to_path_buf();
        let mut parent_exists = true;
        for component in PACKAGES_RELATIVE {
            current.push(component);
            if parent_exists {
                parent_exists = strict_private_directory_exists(&current)?;
            }
        }
        Ok(Self {
            profile_dir: profile_dir.to_path_buf(),
            root: current,
        })
    }

    fn ensure_root(&self) -> Result<(), PackageStoreError> {
        let mut current = self.profile_dir.clone();
        ensure_strict_private_directory(&current)?;
        for component in PACKAGES_RELATIVE {
            current.push(component);
            ensure_strict_private_directory(&current)?;
        }
        Ok(())
    }

    #[must_use]
    pub fn package_path(&self, digest: &Sha256Digest) -> PathBuf {
        self.root
            .join(format!("{}.{}", digest.as_str(), PACKAGE_EXTENSION))
    }

    /// Verify and durably publish one immutable staged package before metadata
    /// admission. Only bounded metadata and a staged path cross the worker
    /// queue; package and component bytes are streamed from strict open handles.
    pub fn publish(&self, staged: StagedFile) -> Result<PluginPackageAuthority, PackageStoreError> {
        self.publish_inner(staged, None)
    }

    /// Publish an admission authority already produced from this staged owner.
    /// Exact package hashing closes the inspection-to-publication race without
    /// repeating Component Model decoding on the SQLite worker.
    pub(crate) fn publish_expected(
        &self,
        staged: StagedFile,
        expected: &PluginPackageAuthority,
    ) -> Result<PluginPackageAuthority, PackageStoreError> {
        self.publish_inner(staged, Some(expected))
    }

    fn publish_inner(
        &self,
        staged: StagedFile,
        expected: Option<&PluginPackageAuthority>,
    ) -> Result<PluginPackageAuthority, PackageStoreError> {
        if staged.is_empty() || staged.len() > PACKAGE_BYTES_MAX as u64 {
            return Err(PackageStoreError::InvalidPackage);
        }
        let source_path = staged.path();
        let source_metadata = strict_regular_metadata(source_path)?;
        if source_metadata.len() != staged.len() {
            return Err(PackageStoreError::AuthorityMismatch);
        }
        let mut source = open_strict_regular(source_path, &source_metadata)?;
        let authority = match expected {
            Some(expected) => {
                if expected.package_size() != staged.len() {
                    return Err(PackageStoreError::AuthorityMismatch);
                }
                verify_open_digest(&mut source, staged.len(), expected.package_sha256())?;
                expected.clone()
            }
            None => PluginPackageAuthority::inspect_reader(&mut source, staged.len())
                .map_err(|_| PackageStoreError::InvalidPackage)?,
        };
        verify_stable_open_path(&source, source_path, &source_metadata)?;

        self.ensure_root()?;
        let destination = self.package_path(authority.package_sha256());
        match fs::symlink_metadata(&destination) {
            Ok(_) => {
                self.verify_exact_digest_file(
                    &destination,
                    authority.package_sha256(),
                    staged.len(),
                )?;
                crate::sync_directory(&self.root).map_err(|_| PackageStoreError::Io)?;
                return Ok(authority);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(PackageStoreError::Io),
        }

        let (mut file, temp) =
            create_private_artifact_temp(&destination).map_err(|_| PackageStoreError::Io)?;
        let publication = (|| {
            source
                .seek(SeekFrom::Start(0))
                .map_err(|_| PackageStoreError::Io)?;
            let copied = io::copy(&mut Read::by_ref(&mut source).take(staged.len()), &mut file)
                .map_err(|_| PackageStoreError::Io)?;
            if copied != staged.len() {
                return Err(PackageStoreError::AuthorityMismatch);
            }
            verify_stable_open_path(&source, source_path, &source_metadata)?;
            set_private_file_permissions(&temp).map_err(|_| PackageStoreError::Io)?;
            file.sync_all().map_err(|_| PackageStoreError::Io)?;
            drop(file);
            self.verify_exact_digest_file(&temp, authority.package_sha256(), staged.len())?;
            match publish_private_artifact(&temp, &destination, false) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let _ = remove_private_file_durable(&temp);
                }
                Err(_) => return Err(PackageStoreError::Io),
            }
            self.verify_exact_digest_file(&destination, authority.package_sha256(), staged.len())
        })();
        if publication.is_err() {
            let _ = remove_private_file_durable(&temp);
        }
        publication?;
        crate::sync_directory(&self.root).map_err(|_| PackageStoreError::Io)?;
        Ok(authority)
    }

    /// Validate one referenced package without constructing any runtime.
    pub(crate) fn read_authority(
        &self,
        digest: &Sha256Digest,
    ) -> Result<PluginPackageAuthority, PackageStoreError> {
        let path = self.package_path(digest);
        let authority = self.verify_exact_file(&path)?;
        if authority.package_sha256() != digest {
            return Err(PackageStoreError::AuthorityMismatch);
        }
        Ok(authority)
    }

    /// Delete content only after metadata no longer references it.
    pub(crate) fn remove_if_unreferenced(
        &self,
        connection: &Connection,
        digest: &Sha256Digest,
    ) -> Result<bool, PackageStoreError> {
        let referenced: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM plugins WHERE package_sha256 = ?1)",
                [digest.as_str()],
                |row| row.get(0),
            )
            .map_err(|_| PackageStoreError::Io)?;
        if referenced {
            return Ok(false);
        }
        let path = self.package_path(digest);
        match strict_regular_metadata(&path) {
            Ok(_) => {
                remove_private_file_durable(&path).map_err(|_| PackageStoreError::Io)?;
                Ok(true)
            }
            Err(PackageStoreError::Io)
                if fs::symlink_metadata(&path)
                    .is_err_and(|error| error.kind() == io::ErrorKind::NotFound) =>
            {
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) fn cleanup_orphans(
        &self,
        referenced: &HashSet<String>,
    ) -> Result<OrphanCleanup, PackageStoreError> {
        let mut cleanup = OrphanCleanup::default();
        if !strict_private_directory_exists(&self.root)? {
            return Ok(cleanup);
        }
        let entries = fs::read_dir(&self.root).map_err(|_| PackageStoreError::Io)?;
        for (seen, entry) in entries.enumerate() {
            if seen == ORPHAN_SCAN_MAX {
                cleanup.truncated = true;
                break;
            }
            let entry = entry.map_err(|_| PackageStoreError::Io)?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(digest) = strict_digest_file_name(&name) else {
                continue;
            };
            if referenced.contains(digest) {
                continue;
            }
            let path = entry.path();
            let Ok(metadata) = strict_regular_metadata(&path) else {
                continue;
            };
            let old_enough = metadata
                .modified()
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age >= ORPHAN_GRACE);
            if old_enough && remove_private_file_durable(&path).is_ok() {
                cleanup.removed += 1;
            }
        }
        Ok(cleanup)
    }

    fn verify_exact_digest_file(
        &self,
        path: &Path,
        expected: &Sha256Digest,
        expected_len: u64,
    ) -> Result<(), PackageStoreError> {
        let path_metadata = strict_regular_metadata(path)?;
        if path_metadata.len() != expected_len {
            return Err(PackageStoreError::AuthorityMismatch);
        }
        let mut file = open_strict_regular(path, &path_metadata)?;
        verify_open_digest(&mut file, expected_len, expected)?;
        verify_stable_open_path(&file, path, &path_metadata)
    }

    fn verify_exact_file(&self, path: &Path) -> Result<PluginPackageAuthority, PackageStoreError> {
        let path_metadata = strict_regular_metadata(path)?;
        if path_metadata.len() == 0 || path_metadata.len() > PACKAGE_BYTES_MAX as u64 {
            return Err(PackageStoreError::AuthorityMismatch);
        }
        let mut file = open_strict_regular(path, &path_metadata)?;
        let authority = PluginPackageAuthority::inspect_reader(&mut file, path_metadata.len())
            .map_err(|_| PackageStoreError::AuthorityMismatch)?;
        verify_stable_open_path(&file, path, &path_metadata)?;
        Ok(authority)
    }
}

fn open_strict_regular(
    path: &Path,
    path_metadata: &fs::Metadata,
) -> Result<File, PackageStoreError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open a reparse point itself instead of following it; strict metadata
        // validation below rejects links and other reparse objects.
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|_| PackageStoreError::Io)?;
    strict_open_file_metadata(&file, path_metadata)?;
    Ok(file)
}

fn verify_stable_open_path(
    file: &File,
    path: &Path,
    initial_metadata: &fs::Metadata,
) -> Result<(), PackageStoreError> {
    let final_metadata = file.metadata().map_err(|_| PackageStoreError::Io)?;
    let final_path_metadata = strict_regular_metadata(path)?;
    strict_open_file_metadata(file, &final_path_metadata)?;
    #[cfg(windows)]
    {
        let final_path_file = open_strict_regular(path, &final_path_metadata)?;
        if windows_file_identity(file)? != windows_file_identity(&final_path_file)? {
            return Err(PackageStoreError::UnsafePath);
        }
    }
    if final_metadata.len() != initial_metadata.len() {
        return Err(PackageStoreError::AuthorityMismatch);
    }
    Ok(())
}

fn strict_digest_file_name(name: &str) -> Option<&str> {
    let digest = name.strip_suffix(".jbp")?;
    (digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then_some(digest)
}

fn validate_strict_private_directory(metadata: &fs::Metadata) -> Result<(), PackageStoreError> {
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(PackageStoreError::UnsafePath);
    }
    #[cfg(windows)]
    if windows_metadata_is_reparse(metadata) {
        return Err(PackageStoreError::UnsafePath);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(PackageStoreError::UnsafePath);
        }
    }
    Ok(())
}

fn strict_private_directory_exists(path: &Path) -> Result<bool, PackageStoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            validate_strict_private_directory(&metadata)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(PackageStoreError::Io),
    }
}

fn ensure_strict_private_directory(path: &Path) -> Result<(), PackageStoreError> {
    if strict_private_directory_exists(path)? {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|_| PackageStoreError::Io)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| PackageStoreError::Io)?;
    }
    #[cfg(not(unix))]
    fs::create_dir(path).map_err(|_| PackageStoreError::Io)?;
    crate::sync_directory(path).map_err(|_| PackageStoreError::Io)?;
    if let Some(parent) = path.parent() {
        crate::sync_directory(parent).map_err(|_| PackageStoreError::Io)?;
    }
    Ok(())
}

fn verify_open_digest(
    file: &mut File,
    len: u64,
    expected: &Sha256Digest,
) -> Result<(), PackageStoreError> {
    file.seek(SeekFrom::Start(0))
        .map_err(|_| PackageStoreError::Io)?;
    let mut hasher = Sha256::new();
    let mut remaining = len;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining != 0 {
        let limit = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| PackageStoreError::AuthorityMismatch)?;
        let read = file
            .read(&mut buffer[..limit])
            .map_err(|_| PackageStoreError::Io)?;
        if read == 0 {
            return Err(PackageStoreError::AuthorityMismatch);
        }
        hasher.update(&buffer[..read]);
        remaining -= read as u64;
    }
    let mut trailing = [0_u8; 1];
    if file
        .read(&mut trailing)
        .map_err(|_| PackageStoreError::Io)?
        != 0
        || format!("{:x}", hasher.finalize()) != expected.as_str()
    {
        return Err(PackageStoreError::AuthorityMismatch);
    }
    Ok(())
}

fn strict_regular_metadata(path: &Path) -> Result<fs::Metadata, PackageStoreError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| PackageStoreError::Io)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PackageStoreError::UnsafePath);
    }
    validate_file_metadata(&metadata)?;
    Ok(metadata)
}

fn strict_open_file_metadata(
    file: &File,
    path_metadata: &fs::Metadata,
) -> Result<(), PackageStoreError> {
    let metadata = file.metadata().map_err(|_| PackageStoreError::Io)?;
    if !metadata.is_file() {
        return Err(PackageStoreError::UnsafePath);
    }
    #[cfg(windows)]
    {
        validate_windows_file_handle(file)?;
        if metadata.len() != path_metadata.len() {
            return Err(PackageStoreError::UnsafePath);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.dev() != path_metadata.dev() || metadata.ino() != path_metadata.ino() {
            return Err(PackageStoreError::UnsafePath);
        }
    }
    validate_file_metadata(&metadata)
}

#[cfg(windows)]
fn windows_metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(windows)]
#[derive(Eq, PartialEq)]
struct WindowsFileIdentity {
    volume_serial: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn windows_file_identity(file: &File) -> Result<WindowsFileIdentity, PackageStoreError> {
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, GetFileInformationByHandle,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a valid handle for the call and the output pointer
    // refers to an initialized, correctly sized structure.
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) };
    if succeeded == 0 {
        return Err(PackageStoreError::Io);
    }
    if information.nNumberOfLinks != 1
        || information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(PackageStoreError::UnsafePath);
    }
    Ok(WindowsFileIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index_high: information.nFileIndexHigh,
        file_index_low: information.nFileIndexLow,
    })
}

#[cfg(windows)]
fn validate_windows_file_handle(file: &File) -> Result<(), PackageStoreError> {
    windows_file_identity(file).map(|_| ())
}

fn validate_file_metadata(metadata: &fs::Metadata) -> Result<(), PackageStoreError> {
    #[cfg(windows)]
    if windows_metadata_is_reparse(metadata) {
        return Err(PackageStoreError::UnsafePath);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.nlink() != 1 || metadata.permissions().mode() & 0o7177 != 0 {
            return Err(PackageStoreError::UnsafePath);
        }
    }
    Ok(())
}
