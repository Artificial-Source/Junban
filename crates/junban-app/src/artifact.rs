//! Cleanup-owning private staged files passed across application boundaries.

use std::{
    fs,
    path::{Path, PathBuf},
};

/// A private staged file whose contents are deleted when the last owner is dropped.
///
/// Storage creates these for bounded backup/export results and prepared restores.
/// Transports may stream the path, but must retain the value for the stream lifetime.
#[derive(Debug)]
pub struct StagedFile {
    path: PathBuf,
    len: u64,
}

impl StagedFile {
    /// Take cleanup ownership of an existing private staged file.
    #[must_use]
    pub fn new(path: PathBuf, len: u64) -> Self {
        Self { path, len }
    }

    /// Path to the staged file while this owner remains alive.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Exact staged file length in bytes.
    #[must_use]
    pub const fn len(&self) -> u64 {
        self.len
    }

    /// Whether the staged file is empty.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
