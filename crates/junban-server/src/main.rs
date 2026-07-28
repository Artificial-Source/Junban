use std::{
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

#[cfg(not(windows))]
fn default_data_dir() -> PathBuf {
    PathBuf::from("data")
}

#[cfg(windows)]
fn default_data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("Junban"))
        .unwrap_or_else(|| PathBuf::from("data"))
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "could not install shutdown signal handler");
    }
}
