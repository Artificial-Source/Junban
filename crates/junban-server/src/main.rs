use std::{
    ffi::OsStr,
    io,
    net::SocketAddr,
    path::{Path, PathBuf},
};

use clap::Parser;
use junban_server::{RuntimeMetadataFile, ServerState, load_or_create_token, router};
use junban_storage::ProfileOwner;

#[derive(Debug, Parser)]
#[command(name = "junban-server", version, about = "Junban hosted task server")]
struct Config {
    /// Address to listen on. Loopback is the secure default.
    #[arg(long, default_value = "127.0.0.1:4219")]
    bind: SocketAddr,
    /// Private profile directory containing SQLite, token, lock, and runtime metadata.
    #[arg(long)]
    data_dir: Option<PathBuf>,
    /// Directory containing the built React application.
    #[arg(long, default_value = "dist")]
    web_dir: PathBuf,
    /// Additional exact raw Host header value to permit (repeatable, including port).
    #[arg(long = "host")]
    additional_hosts: Vec<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_target(false)
        .compact()
        .init();
    let config = Config::parse();
    let data_dir = config.data_dir.unwrap_or_else(default_data_dir);
    let owner = ProfileOwner::open(&data_dir)?;
    ensure_separate_profile_and_web(&data_dir, &config.web_dir)?;
    let token = load_or_create_token(&data_dir)?;
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    let address = listener.local_addr()?;

    let mut allowed_hosts = config.additional_hosts;
    allowed_hosts.push(address.to_string());
    if address.ip().is_loopback() {
        allowed_hosts.push(format!("localhost:{}", address.port()));
    }
    let state = ServerState::new(owner.repository(), token, allowed_hosts);
    let app = router(state, config.web_dir);
    let runtime_metadata = RuntimeMetadataFile::create(&data_dir, address)?;

    tracing::info!(%address, "Junban server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    drop(runtime_metadata);
    drop(owner);
    Ok(())
}

fn ensure_separate_profile_and_web(data_dir: &Path, web_dir: &Path) -> io::Result<()> {
    let data_dir = data_dir.canonicalize()?;
    let web_dir = web_dir.canonicalize()?;
    if data_dir.starts_with(&web_dir) || web_dir.starts_with(&data_dir) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "data-dir and web-dir must not overlap",
        ));
    }
    Ok(())
}

/// OS family used to resolve the default private profile directory.
///
/// All variants are retained so unit tests can exercise every host path on any
/// builder; production `default_data_dir` only constructs the current target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum DataDirPlatform {
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
fn resolve_default_data_dir(
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

fn default_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        resolve_default_data_dir(
            DataDirPlatform::Windows,
            None,
            None,
            std::env::var_os("LOCALAPPDATA").as_deref(),
        )
    }
    #[cfg(target_os = "macos")]
    {
        resolve_default_data_dir(
            DataDirPlatform::MacOs,
            None,
            std::env::var_os("HOME").as_deref(),
            None,
        )
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        resolve_default_data_dir(
            DataDirPlatform::Unix,
            std::env::var_os("XDG_DATA_HOME").as_deref(),
            std::env::var_os("HOME").as_deref(),
            None,
        )
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "could not install Ctrl-C handler");
        }
    };

    #[cfg(unix)]
    {
        let mut sigterm =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(signal) => signal,
                Err(error) => {
                    tracing::error!(%error, "could not install SIGTERM handler");
                    ctrl_c.await;
                    return;
                }
            };

        tokio::select! {
            () = ctrl_c => {}
            _ = sigterm.recv() => {}
        }
    }

    #[cfg(not(unix))]
    {
        ctrl_c.await;
    }
}

#[cfg(test)]
mod tests {
    use super::{DataDirPlatform, resolve_default_data_dir};
    use std::ffi::OsStr;
    use std::path::PathBuf;

    #[test]
    fn unix_prefers_xdg_data_home() {
        let path = resolve_default_data_dir(
            DataDirPlatform::Unix,
            Some(OsStr::new("/custom/xdg")),
            Some(OsStr::new("/home/user")),
            None,
        );
        assert_eq!(path, PathBuf::from("/custom/xdg/junban"));
    }

    #[test]
    fn unix_falls_back_to_home_local_share() {
        let path = resolve_default_data_dir(
            DataDirPlatform::Unix,
            None,
            Some(OsStr::new("/home/user")),
            None,
        );
        assert_eq!(path, PathBuf::from("/home/user/.local/share/junban"));
    }

    #[test]
    fn unix_ignores_empty_xdg_and_uses_home() {
        let path = resolve_default_data_dir(
            DataDirPlatform::Unix,
            Some(OsStr::new("")),
            Some(OsStr::new("/home/user")),
            None,
        );
        assert_eq!(path, PathBuf::from("/home/user/.local/share/junban"));
    }

    #[test]
    fn unix_falls_back_to_relative_data_when_env_missing() {
        let path = resolve_default_data_dir(DataDirPlatform::Unix, None, None, None);
        assert_eq!(path, PathBuf::from("data"));
    }

    #[test]
    fn macos_uses_application_support() {
        let path = resolve_default_data_dir(
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
        let path = resolve_default_data_dir(DataDirPlatform::MacOs, None, None, None);
        assert_eq!(path, PathBuf::from("data"));
    }

    #[test]
    fn windows_uses_local_app_data() {
        let local = PathBuf::from(r"C:\Users\ada\AppData\Local");
        let path = resolve_default_data_dir(
            DataDirPlatform::Windows,
            None,
            None,
            Some(local.as_os_str()),
        );
        assert_eq!(path, local.join("Junban"));
    }

    #[test]
    fn windows_falls_back_to_relative_data_when_local_app_data_missing() {
        let path = resolve_default_data_dir(DataDirPlatform::Windows, None, None, None);
        assert_eq!(path, PathBuf::from("data"));
    }
}
