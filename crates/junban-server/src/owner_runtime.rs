//! Reusable in-process API-only owner runtime for CLI/MCP no-server fallback.
//!
//! Hosted `junban-server` keeps serving the React shell; this path binds loopback,
//! constructs the normal service stack once, and never serves frontend assets.

use std::{
    ffi::OsStr,
    io,
    net::SocketAddr,
    path::{Path, PathBuf},
    time::Duration,
};

use thiserror::Error;
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use junban_storage::{OpenError, ProfileOwner};

use crate::{
    DiagnosticSeverity, RuntimeMetadataFile, ServerState, api_only_router, load_or_create_token,
};

/// OS family used to resolve the default private profile directory.
///
/// All variants are retained so unit tests can exercise every host path on any
/// builder; production `default_profile_dir` only constructs the current target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum DataDirPlatform {
    /// Linux, BSD, and other non-macOS Unix hosts using XDG data dirs.
    Unix,
    MacOs,
    Windows,
}

/// Resolve the default profile directory from explicit environment inputs.
///
/// Prefer OS conventions without depending on process-global env mutation in tests:
/// - Unix: `$XDG_DATA_HOME/junban`, else `$HOME/.local/share/junban`
/// - macOS: `$HOME/Library/Application Support/Junban`
/// - Windows: `%LOCALAPPDATA%/Junban`
/// - Fallback when required environment data is missing: `./data`
#[must_use]
pub fn resolve_default_profile_dir(
    platform: DataDirPlatform,
    xdg_data_home: Option<&OsStr>,
    home: Option<&OsStr>,
    local_app_data: Option<&OsStr>,
) -> PathBuf {
    match platform {
        DataDirPlatform::Unix => {
            if let Some(xdg) = xdg_data_home.filter(|path| !path.is_empty()) {
                return PathBuf::from(xdg).join("junban");
            }
            if let Some(home) = home.filter(|path| !path.is_empty()) {
                return PathBuf::from(home).join(".local/share/junban");
            }
            PathBuf::from("data")
        }
        DataDirPlatform::MacOs => {
            if let Some(home) = home.filter(|path| !path.is_empty()) {
                return PathBuf::from(home).join("Library/Application Support/Junban");
            }
            PathBuf::from("data")
        }
        DataDirPlatform::Windows => {
            if let Some(local) = local_app_data.filter(|path| !path.is_empty()) {
                return PathBuf::from(local).join("Junban");
            }
            PathBuf::from("data")
        }
    }
}

/// Default private profile directory for the current host OS.
#[must_use]
pub fn default_profile_dir() -> PathBuf {
    #[cfg(windows)]
    {
        resolve_default_profile_dir(
            DataDirPlatform::Windows,
            None,
            None,
            std::env::var_os("LOCALAPPDATA").as_deref(),
        )
    }
    #[cfg(target_os = "macos")]
    {
        resolve_default_profile_dir(
            DataDirPlatform::MacOs,
            None,
            std::env::var_os("HOME").as_deref(),
            None,
        )
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        resolve_default_profile_dir(
            DataDirPlatform::Unix,
            std::env::var_os("XDG_DATA_HOME").as_deref(),
            std::env::var_os("HOME").as_deref(),
            None,
        )
    }
}

/// Failure starting a temporary API-only owner.
#[derive(Debug, Error)]
pub enum LocalApiOwnerError {
    #[error("profile is already owned by another Junban process")]
    AlreadyOwned,
    #[error("profile requires recovery before normal admission: {0}")]
    RecoveryRequired(String),
    #[error("could not prepare profile: {0}")]
    Io(#[from] io::Error),
    #[error("could not open database: {0}")]
    Database(String),
}

impl From<OpenError> for LocalApiOwnerError {
    fn from(error: OpenError) -> Self {
        match error {
            OpenError::AlreadyOwned => Self::AlreadyOwned,
            OpenError::Io(error) => Self::Io(error),
            OpenError::Database(message) => {
                if message.contains("recovery") {
                    Self::RecoveryRequired(message)
                } else {
                    Self::Database(message)
                }
            }
        }
    }
}

/// In-process API-only owner that holds `ProfileOwner` for exactly its lifetime.
pub struct LocalApiOwner {
    profile_dir: PathBuf,
    address: SocketAddr,
    instance_id: String,
    state: Option<ServerState>,
    shutdown: CancellationToken,
    serve_handle: Option<JoinHandle<io::Result<()>>>,
    runtime_metadata: Option<RuntimeMetadataFile>,
    owner: Option<ProfileOwner>,
}

impl LocalApiOwner {
    /// Acquire the profile lock, bind loopback, serve the normal API, then publish metadata.
    pub async fn start(profile_dir: impl Into<PathBuf>) -> Result<Self, LocalApiOwnerError> {
        let profile_dir = profile_dir.into();
        // Lock before any database open — ProfileOwner enforces this ordering.
        let owner = ProfileOwner::open(&profile_dir)?;
        let token = load_or_create_token(&profile_dir)?;
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
        let address = listener.local_addr()?;

        let mut cli_hosts = vec![address.to_string()];
        if address.ip().is_loopback() {
            cli_hosts.push(format!("localhost:{}", address.port()));
        }
        let state = ServerState::new(owner.repository(), token, cli_hosts, &profile_dir)?;
        let instance_id = state.instance_id().to_owned();
        let shutdown = state.shutdown_token();
        assert!(
            state.start_reminder_coordinator(),
            "new API-only owner must start exactly one reminder coordinator"
        );
        state.log_diagnostic(
            DiagnosticSeverity::Info,
            "api_owner_starting",
            None,
            &format!("listening on {address}"),
        );

        let app = api_only_router(state.clone());
        let serve_shutdown = shutdown.clone();
        let mut serve_handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    serve_shutdown.cancelled().await;
                })
                .await
        });

        // Publish discovery metadata only after the listener/task is live. Roll back the
        // complete runtime if publication fails; dropping a JoinHandle would detach it.
        let runtime_metadata =
            match RuntimeMetadataFile::create(&profile_dir, address, &instance_id) {
                Ok(metadata) => metadata,
                Err(error) => {
                    shutdown.cancel();
                    if tokio::time::timeout(Duration::from_secs(5), &mut serve_handle)
                        .await
                        .is_err()
                    {
                        serve_handle.abort();
                        let _ = serve_handle.await;
                    }
                    state.stop_reminder_coordinator().await;
                    drop(state);
                    drop(owner);
                    return Err(error.into());
                }
            };

        Ok(Self {
            profile_dir,
            address,
            instance_id,
            state: Some(state),
            shutdown,
            serve_handle: Some(serve_handle),
            runtime_metadata: Some(runtime_metadata),
            owner: Some(owner),
        })
    }

    #[must_use]
    pub fn profile_dir(&self) -> &Path {
        &self.profile_dir
    }

    #[must_use]
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    #[must_use]
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    #[must_use]
    pub fn base_url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// Stop admission, listener, reminders, metadata, worker, then release the lock.
    pub async fn shutdown(mut self) {
        if let Some(state) = self.state.as_ref() {
            state.log_diagnostic(
                DiagnosticSeverity::Info,
                "api_owner_stopping",
                None,
                "graceful API-only owner shutdown",
            );
        }
        self.shutdown.cancel();
        if let Some(mut handle) = self.serve_handle.take() {
            match tokio::time::timeout(Duration::from_secs(5), &mut handle).await {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(error))) => {
                    tracing::warn!(%error, "API-only owner serve task returned error during shutdown");
                }
                Ok(Err(error)) => {
                    tracing::warn!(%error, "API-only owner serve task join failed during shutdown");
                }
                Err(_) => {
                    handle.abort();
                    let _ = handle.await;
                }
            }
        }
        if let Some(state) = self.state.take() {
            state.stop_reminder_coordinator().await;
            drop(state);
        }
        drop(self.runtime_metadata.take());
        drop(self.owner.take());
    }
}

impl Drop for LocalApiOwner {
    fn drop(&mut self) {
        self.shutdown.cancel();
        if let Some(handle) = self.serve_handle.take() {
            handle.abort();
        }
        drop(self.runtime_metadata.take());
        drop(self.state.take());
        // Best-effort: release ownership if shutdown() was not awaited.
        drop(self.owner.take());
    }
}

#[cfg(test)]
mod tests {
    use super::{DataDirPlatform, LocalApiOwner, resolve_default_profile_dir};
    use junban_storage::ProfileOwner;
    use std::ffi::OsStr;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn unix_prefers_xdg_data_home() {
        let path = resolve_default_profile_dir(
            DataDirPlatform::Unix,
            Some(OsStr::new("/custom/xdg")),
            Some(OsStr::new("/home/user")),
            None,
        );
        assert_eq!(path, PathBuf::from("/custom/xdg/junban"));
    }

    #[test]
    fn unix_falls_back_to_home_local_share() {
        let path = resolve_default_profile_dir(
            DataDirPlatform::Unix,
            None,
            Some(OsStr::new("/home/user")),
            None,
        );
        assert_eq!(path, PathBuf::from("/home/user/.local/share/junban"));
    }

    #[test]
    fn unix_ignores_empty_xdg_and_uses_home() {
        let path = resolve_default_profile_dir(
            DataDirPlatform::Unix,
            Some(OsStr::new("")),
            Some(OsStr::new("/home/user")),
            None,
        );
        assert_eq!(path, PathBuf::from("/home/user/.local/share/junban"));
    }

    #[test]
    fn unix_falls_back_to_relative_data_when_env_missing() {
        let path = resolve_default_profile_dir(DataDirPlatform::Unix, None, None, None);
        assert_eq!(path, PathBuf::from("data"));
    }

    #[test]
    fn macos_uses_application_support() {
        let path = resolve_default_profile_dir(
            DataDirPlatform::MacOs,
            Some(OsStr::new("/ignored/xdg")),
            Some(OsStr::new("/Users/ada")),
            None,
        );
        assert_eq!(
            path,
            PathBuf::from("/Users/ada/Library/Application Support/Junban")
        );
    }

    #[test]
    fn macos_falls_back_to_relative_data_when_home_missing() {
        let path = resolve_default_profile_dir(DataDirPlatform::MacOs, None, None, None);
        assert_eq!(path, PathBuf::from("data"));
    }

    #[test]
    fn windows_uses_local_app_data() {
        let local = PathBuf::from(r"C:\Users\ada\AppData\Local");
        let path = resolve_default_profile_dir(
            DataDirPlatform::Windows,
            None,
            None,
            Some(local.as_os_str()),
        );
        assert_eq!(path, local.join("Junban"));
    }

    #[test]
    fn windows_falls_back_to_relative_data_when_local_app_data_missing() {
        let path = resolve_default_profile_dir(DataDirPlatform::Windows, None, None, None);
        assert_eq!(path, PathBuf::from("data"));
    }

    #[tokio::test]
    async fn metadata_publication_failure_stops_runtime_and_releases_owner() {
        let profile = std::env::temp_dir().join(format!(
            "junban-owner-runtime-test-{}",
            uuid::Uuid::now_v7()
        ));
        fs::create_dir_all(&profile).expect("temp profile");
        fs::create_dir(profile.join(crate::RUNTIME_FILE))
            .expect("blocking runtime metadata directory");

        let error = match LocalApiOwner::start(&profile).await {
            Ok(owner) => {
                owner.shutdown().await;
                panic!("metadata publication must fail");
            }
            Err(error) => error,
        };
        assert!(error.to_string().contains("could not prepare profile"));

        fs::remove_dir(profile.join(crate::RUNTIME_FILE)).expect("remove blocking directory");
        let owner = ProfileOwner::open(&profile).expect("owner lock released after rollback");
        drop(owner);
        fs::remove_dir_all(profile).expect("remove temp profile");
    }
}
