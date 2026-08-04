//! Private immutable content-addressed JBP1 package authority.

use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use junban_app::PluginPackageAuthority;
use junban_plugin_sdk::{PACKAGE_BYTES_MAX, Sha256Digest};
use rusqlite::Connection;
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

    /// Verify and durably publish one immutable package before metadata admission.
    pub fn publish(&self, bytes: &[u8]) -> Result<PluginPackageAuthority, PackageStoreError> {
        let authority = PluginPackageAuthority::inspect(bytes)
            .map_err(|_| PackageStoreError::InvalidPackage)?;
        self.ensure_root()?;
        let destination = self.package_path(authority.package_sha256());
        match fs::symlink_metadata(&destination) {
            Ok(_) => {
                self.verify_exact_file(&destination, Some(bytes), Some(&authority))?;
                crate::sync_directory(&self.root).map_err(|_| PackageStoreError::Io)?;
                return Ok(authority);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(PackageStoreError::Io),
        }

        let (mut file, temp) =
            create_private_artifact_temp(&destination).map_err(|_| PackageStoreError::Io)?;
        let publication = (|| {
            file.write_all(bytes).map_err(|_| PackageStoreError::Io)?;
            set_private_file_permissions(&temp).map_err(|_| PackageStoreError::Io)?;
            file.sync_all().map_err(|_| PackageStoreError::Io)?;
            drop(file);
            match publish_private_artifact(&temp, &destination, false) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let _ = remove_private_file_durable(&temp);
                }
                Err(_) => return Err(PackageStoreError::Io),
            }
            self.verify_exact_file(&destination, Some(bytes), Some(&authority))
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
        let authority = self.verify_exact_file(&path, None, None)?;
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

    fn verify_exact_file(
        &self,
        path: &Path,
        expected_bytes: Option<&[u8]>,
        expected_authority: Option<&PluginPackageAuthority>,
    ) -> Result<PluginPackageAuthority, PackageStoreError> {
        let path_metadata = strict_regular_metadata(path)?;
        if path_metadata.len() > PACKAGE_BYTES_MAX as u64 {
            return Err(PackageStoreError::AuthorityMismatch);
        }
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
            // Open a reparse point itself instead of following it; the regular-file
            // metadata check below then rejects links and other reparse objects.
            const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
            options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let mut file = options.open(path).map_err(|_| PackageStoreError::Io)?;
        strict_open_file_metadata(&file, &path_metadata)?;
        if let Some(expected) = expected_bytes {
            if expected.len() as u64 != path_metadata.len() {
                return Err(PackageStoreError::AuthorityMismatch);
            }
            let mut offset = 0_usize;
            let mut buffer = [0_u8; 64 * 1024];
            while offset < expected.len() {
                let count = file.read(&mut buffer).map_err(|_| PackageStoreError::Io)?;
                if count == 0
                    || expected[offset..]
                        .get(..count)
                        .is_none_or(|chunk| chunk != &buffer[..count])
                {
                    return Err(PackageStoreError::AuthorityMismatch);
                }
                offset += count;
            }
            let mut trailing = [0_u8; 1];
            if file
                .read(&mut trailing)
                .map_err(|_| PackageStoreError::Io)?
                != 0
            {
                return Err(PackageStoreError::AuthorityMismatch);
            }
            verify_stable_open_path(&file, path, &path_metadata)?;
            return expected_authority
                .cloned()
                .ok_or(PackageStoreError::AuthorityMismatch);
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take((PACKAGE_BYTES_MAX + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| PackageStoreError::Io)?;
        if bytes.len() > PACKAGE_BYTES_MAX || bytes.len() as u64 != path_metadata.len() {
            return Err(PackageStoreError::AuthorityMismatch);
        }
        verify_stable_open_path(&file, path, &path_metadata)?;
        let authority = PluginPackageAuthority::inspect(&bytes)
            .map_err(|_| PackageStoreError::AuthorityMismatch)?;
        if expected_authority.is_some_and(|expected| expected != &authority) {
            return Err(PackageStoreError::AuthorityMismatch);
        }
        Ok(authority)
    }
}

fn verify_stable_open_path(
    file: &File,
    path: &Path,
    initial_metadata: &fs::Metadata,
) -> Result<(), PackageStoreError> {
    let final_metadata = file.metadata().map_err(|_| PackageStoreError::Io)?;
    let final_path_metadata = strict_regular_metadata(path)?;
    strict_open_file_metadata(file, &final_path_metadata)?;
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
        use std::os::windows::fs::MetadataExt;

        validate_windows_file_handle(file)?;
        if metadata.volume_serial_number().is_none()
            || metadata.volume_serial_number() != path_metadata.volume_serial_number()
            || metadata.file_index().is_none()
            || metadata.file_index() != path_metadata.file_index()
        {
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
fn validate_windows_file_handle(file: &File) -> Result<(), PackageStoreError> {
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
    Ok(())
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
