use std::{
    io,
    net::SocketAddr,
    path::{Path, PathBuf},
};

use clap::Parser;
use junban_server::{
    DiagnosticSeverity, RecoveryState, RuntimeMetadataFile, ServerState, default_profile_dir,
    load_or_create_token, recovery_router, router,
};
use junban_storage::{OpenError, ProfileOwner, RecoveryOwner, profile_recovery_required};

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
    let data_dir = config.data_dir.clone().unwrap_or_else(default_profile_dir);
    if profile_recovery_required(&data_dir)? {
        let recovery_owner = RecoveryOwner::open(&data_dir)?;
        ensure_separate_profile_and_web(&data_dir, &config.web_dir)?;
        tracing::error!("durable recovery marker present; starting recovery-only server");
        return run_recovery_server(&config, &data_dir, recovery_owner).await;
    }
    let owner = match ProfileOwner::open(&data_dir) {
        Ok(owner) => owner,
        Err(OpenError::Database(error)) => {
            let recovery_owner = RecoveryOwner::open(&data_dir)?;
            ensure_separate_profile_and_web(&data_dir, &config.web_dir)?;
            tracing::error!(%error, "database unavailable; starting recovery-only server");
            return run_recovery_server(&config, &data_dir, recovery_owner).await;
        }
        Err(error) => return Err(error.into()),
    };
    ensure_separate_profile_and_web(&data_dir, &config.web_dir)?;
    let token = load_or_create_token(&data_dir)?;
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    let address = listener.local_addr()?;

    let mut cli_hosts = config.additional_hosts;
    cli_hosts.push(address.to_string());
    if address.ip().is_loopback() {
        cli_hosts.push(format!("localhost:{}", address.port()));
    }
    // CLI hosts merge with any persisted Tailnet hostnames under the profile dir.
    let state = ServerState::new(owner.repository(), token, cli_hosts, &data_dir)?;
    let instance_id = state.instance_id().to_owned();
    let shutdown = state.shutdown_token();
    // Exactly one process-global reminder coordinator; not started by router tests.
    assert!(
        state.start_reminder_coordinator(),
        "new production state must start exactly one reminder coordinator"
    );
    state.log_diagnostic(
        DiagnosticSeverity::Info,
        "server_starting",
        None,
        &format!("listening on {address}"),
    );
    let app = router(state.clone(), config.web_dir);

    tracing::info!(%address, "Junban server listening");
    // Publish discovery metadata only after the listener is bound and the stack is ready.
    let runtime_metadata = RuntimeMetadataFile::create(&data_dir, address, &instance_id)?;
    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown({
            let shutdown = shutdown.clone();
            let state = state.clone();
            async move {
                shutdown_signal().await;
                state.log_diagnostic(
                    DiagnosticSeverity::Info,
                    "server_stopping",
                    None,
                    "graceful shutdown signal received",
                );
                // Cancel coordinator + SSE forwarders before Axum drains responses.
                shutdown.cancel();
            }
        })
        .await;
    // Idempotent if graceful shutdown already cancelled; covers serve errors too.
    shutdown.cancel();
    state.log_diagnostic(
        DiagnosticSeverity::Info,
        "server_stopped",
        None,
        "server event loop exited",
    );
    state.stop_reminder_coordinator().await;
    drop(runtime_metadata);
    drop(owner);
    serve_result?;
    Ok(())
}

async fn run_recovery_server(
    config: &Config,
    data_dir: &Path,
    owner: RecoveryOwner,
) -> Result<(), Box<dyn std::error::Error>> {
    let token = load_or_create_token(data_dir)?;
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    let address = listener.local_addr()?;
    let mut allowed_hosts = config.additional_hosts.clone();
    allowed_hosts.push(address.to_string());
    if address.ip().is_loopback() {
        allowed_hosts.push(format!("localhost:{}", address.port()));
    }
    let state = RecoveryState::new(owner, token, allowed_hosts)?;
    let instance_id = state.instance_id().to_owned();
    let app = recovery_router(state, config.web_dir.clone());

    tracing::warn!(%address, "Junban recovery-only server listening");
    let runtime_metadata = RuntimeMetadataFile::create(data_dir, address, &instance_id)?;
    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    drop(runtime_metadata);
    serve_result?;
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
