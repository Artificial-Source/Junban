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

/// Cancellation-safe owner teardown. If this future is dropped before AI and
/// reminders drain, its lock-owning values are deliberately retained forever.
struct LocalOwnerCleanup {
    state: Option<ServerState>,
    serve_handle: Option<JoinHandle<io::Result<()>>>,
    runtime_metadata: Option<RuntimeMetadataFile>,
    owner: Option<ProfileOwner>,
    release_allowed: bool,
}

impl LocalOwnerCleanup {
    fn new(
        state: Option<ServerState>,
        serve_handle: Option<JoinHandle<io::Result<()>>>,
        runtime_metadata: Option<RuntimeMetadataFile>,
        owner: Option<ProfileOwner>,
    ) -> Self {
        Self {
            state,
            serve_handle,
            runtime_metadata,
            owner,
            release_allowed: false,
        }
    }

    async fn finish(mut self) {
        if let Some(handle) = self.serve_handle.take() {
            let _ = handle.await;
        }
        if let Some(state) = self.state.as_ref() {
            loop {
                if state
                    .drain_ai_runtime(crate::AI_SHUTDOWN_DRAIN_DEADLINE)
                    .await
                {
                    break;
                }
                tracing::warn!(
                    "AI runtime remains active during API-only owner shutdown; retaining profile ownership"
                );
            }
            state.stop_reminder_coordinator().await;
        }
        self.release_allowed = true;
    }
}

impl Drop for LocalOwnerCleanup {
    fn drop(&mut self) {
        if self.release_allowed {
            return;
        }
        // Losing the async cleanup future must never unlock a profile while AI
        // authority may remain. Leaking is exceptional, explicit, and fail-closed.
        if let Some(state) = self.state.take() {
            std::mem::forget(state);
        }
        if let Some(metadata) = self.runtime_metadata.take() {
            std::mem::forget(metadata);
        }
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}

impl LocalApiOwner {
    /// Acquire the profile lock, recover dispatches, bind loopback, then publish metadata.
    pub async fn start(profile_dir: impl Into<PathBuf>) -> Result<Self, LocalApiOwnerError> {
        let profile_dir = profile_dir.into();
        // Lock before any database open — ProfileOwner enforces this ordering.
        let owner = ProfileOwner::open(&profile_dir)?;
        let token = load_or_create_token(&profile_dir)?;
        let state = ServerState::new(
            owner.repository(),
            token,
            Vec::<String>::new(),
            &profile_dir,
        )?;
        state.recover_ai_dispatches().await?;

        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
        let address = listener.local_addr()?;
        let mut listener_hosts = vec![address.to_string()];
        if address.ip().is_loopback() {
            listener_hosts.push(format!("localhost:{}", address.port()));
        }
        state.add_cli_hosts(listener_hosts);
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
        let serve_handle = tokio::spawn(async move {
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
                    // Revoke AI and speech before general shutdown and before awaiting Axum.
                    state.begin_ai_shutdown();
                    shutdown.cancel();
                    serve_handle.abort();
                    LocalOwnerCleanup::new(Some(state), Some(serve_handle), None, Some(owner))
                        .finish()
                        .await;
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
            state.begin_ai_shutdown();
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
        LocalOwnerCleanup::new(
            self.state.take(),
            None,
            self.runtime_metadata.take(),
            self.owner.take(),
        )
        .finish()
        .await;
    }
}

impl Drop for LocalApiOwner {
    fn drop(&mut self) {
        if let Some(state) = self.state.as_ref() {
            state.begin_ai_shutdown();
        }
        self.shutdown.cancel();
        let serve_handle = self.serve_handle.take();
        if let Some(handle) = serve_handle.as_ref() {
            handle.abort();
        }
        let cleanup = LocalOwnerCleanup::new(
            self.state.take(),
            serve_handle,
            self.runtime_metadata.take(),
            self.owner.take(),
        );
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(cleanup.finish());
            }
            Err(_) => {
                // No executor can complete drain/join. Retain the lock-owning
                // cleanup values rather than releasing ownership unsafely.
                std::mem::forget(cleanup);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{DataDirPlatform, LocalApiOwner, resolve_default_profile_dir};
    use junban_storage::{OpenError, ProfileOwner};
    use std::ffi::OsStr;
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

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
    async fn explicit_shutdown_cancels_ai_before_completion_and_retains_profile_lock() {
        let profile = std::env::temp_dir().join(format!(
            "junban-owner-explicit-cleanup-test-{}",
            uuid::Uuid::now_v7()
        ));
        let owner = LocalApiOwner::start(&profile).await.expect("start owner");
        let guard = owner
            .state
            .as_ref()
            .expect("state")
            .ai_runtime()
            .admit_run(junban_domain::AiRunId::new(), 1)
            .expect("admit held AI run");

        let shutdown = tokio::spawn(owner.shutdown());
        tokio::task::yield_now().await;
        assert!(!guard.is_live(), "AI cancellation must begin synchronously");
        assert!(!shutdown.is_finished(), "held AI guard must block cleanup");
        assert!(matches!(
            ProfileOwner::open(&profile),
            Err(OpenError::AlreadyOwned)
        ));

        drop(guard);
        tokio::time::timeout(Duration::from_secs(2), shutdown)
            .await
            .expect("shutdown released after guard drop")
            .expect("shutdown task");
        let reopened = ProfileOwner::open(&profile).expect("profile released after full drain");
        drop(reopened);
        fs::remove_dir_all(profile).expect("remove temp profile");
    }

    #[tokio::test]
    async fn drop_cleanup_retains_profile_lock_until_held_ai_guard_drops() {
        let profile = std::env::temp_dir().join(format!(
            "junban-owner-drop-cleanup-test-{}",
            uuid::Uuid::now_v7()
        ));
        let owner = LocalApiOwner::start(&profile).await.expect("start owner");
        let guard = owner
            .state
            .as_ref()
            .expect("state")
            .ai_runtime()
            .admit_run(junban_domain::AiRunId::new(), 1)
            .expect("admit held AI run");

        drop(owner);
        assert!(!guard.is_live(), "Drop must synchronously cancel AI");
        assert!(matches!(
            ProfileOwner::open(&profile),
            Err(OpenError::AlreadyOwned)
        ));
        drop(guard);

        let reopened = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match ProfileOwner::open(&profile) {
                    Ok(owner) => break owner,
                    Err(OpenError::AlreadyOwned) => tokio::task::yield_now().await,
                    Err(error) => panic!("unexpected profile reopen error: {error}"),
                }
            }
        })
        .await
        .expect("drop cleanup released after guard drop");
        drop(reopened);
        fs::remove_dir_all(profile).expect("remove temp profile");
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
