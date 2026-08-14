//! Operator server/host/diagnostics/maintenance commands.

use std::path::PathBuf;

use serde_json::json;

use crate::commands::{call_and_emit, require_confirm};
use crate::error::CliError;
use crate::output::OutputMode;
use crate::session::Session;

pub async fn hosts_get(session: &mut Session, mode: OutputMode) -> Result<(), CliError> {
    call_and_emit(session, mode, "get_allowed_hosts", json!({})).await
}

pub async fn hosts_set(
    session: &mut Session,
    mode: OutputMode,
    hosts: Vec<String>,
) -> Result<(), CliError> {
    call_and_emit(
        session,
        mode,
        "put_allowed_hosts",
        json!({ "hosts": hosts }),
    )
    .await
}

pub async fn rotate_token(
    session: &mut Session,
    mode: OutputMode,
    write_token: PathBuf,
    confirm: bool,
) -> Result<(), CliError> {
    require_confirm(confirm, "rotate-token")?;
    call_and_emit(
        session,
        mode,
        "rotate_token",
        json!({
            "write_token": write_token.display().to_string(),
            "confirm": "rotate-token",
        }),
    )
    .await
}

pub async fn diagnostics_get(session: &mut Session, mode: OutputMode) -> Result<(), CliError> {
    call_and_emit(session, mode, "get_diagnostics", json!({})).await
}

pub async fn diagnostics_clear(
    session: &mut Session,
    mode: OutputMode,
    confirm: bool,
) -> Result<(), CliError> {
    require_confirm(confirm, "clear")?;
    call_and_emit(
        session,
        mode,
        "clear_diagnostics",
        json!({ "confirm": "clear" }),
    )
    .await
}

pub async fn maintenance(session: &mut Session, mode: OutputMode) -> Result<(), CliError> {
    call_and_emit(session, mode, "get_maintenance_status", json!({})).await
}

pub async fn recovery_status(session: &mut Session, mode: OutputMode) -> Result<(), CliError> {
    call_and_emit(session, mode, "get_recovery_status", json!({})).await
}
