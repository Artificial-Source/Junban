//! Ergonomic import/export/backup/restore commands.

use std::path::PathBuf;

use serde_json::json;

use crate::commands::{call_and_emit, emit_value_view, require_confirm};
use crate::error::CliError;
use crate::output::OutputMode;
use crate::render::HumanView;
use crate::session::Session;

pub async fn export(
    session: &mut Session,
    mode: OutputMode,
    format: String,
    output: PathBuf,
    overwrite: bool,
) -> Result<(), CliError> {
    match format.as_str() {
        "json" | "csv" | "markdown" => {}
        other => {
            return Err(CliError::usage(
                "invalid_export_format",
                format!("format must be json, csv, or markdown (got {other})"),
            ));
        }
    }
    call_and_emit(
        session,
        mode,
        "export_tasks",
        json!({
            "format": format,
            "output_path": output.display().to_string(),
            "overwrite": overwrite,
        }),
    )
    .await
}

pub async fn import_preview(
    session: &mut Session,
    mode: OutputMode,
    format: String,
    file: PathBuf,
) -> Result<(), CliError> {
    let content = read_transfer_file(&file)?;
    call_and_emit(
        session,
        mode,
        "preview_import",
        json!({
            "format": format,
            "content": content,
        }),
    )
    .await
}

pub async fn import_apply(
    session: &mut Session,
    mode: OutputMode,
    format: String,
    file: PathBuf,
    fingerprint: String,
) -> Result<(), CliError> {
    let content = read_transfer_file(&file)?;
    call_and_emit(
        session,
        mode,
        "apply_import",
        json!({
            "format": format,
            "content": content,
            "fingerprint": fingerprint,
        }),
    )
    .await
}

pub async fn backup(
    session: &mut Session,
    mode: OutputMode,
    output: PathBuf,
    overwrite: bool,
) -> Result<(), CliError> {
    call_and_emit(
        session,
        mode,
        "create_backup",
        json!({
            "output_path": output.display().to_string(),
            "overwrite": overwrite,
        }),
    )
    .await
}

pub async fn restore(
    session: &mut Session,
    mode: OutputMode,
    input: PathBuf,
    confirm: bool,
) -> Result<(), CliError> {
    require_confirm(confirm, "restore")?;
    let result = session
        .call_tool(
            "restore_backup",
            json!({
                "input_path": input.display().to_string(),
                "confirm": "restore",
            }),
        )
        .await?;
    // Preserve restart-required semantics; human mode stays concise.
    emit_value_view(mode, &result.value, HumanView::Auto)
}

fn read_transfer_file(path: &std::path::Path) -> Result<String, CliError> {
    let meta = std::fs::metadata(path).map_err(|error| {
        CliError::usage(
            "input_file_unreadable",
            format!("could not read {}: {error}", path.display()),
        )
    })?;
    if meta.len() as usize > junban_server::MAX_TRANSFER_BODY_BYTES {
        return Err(CliError::usage(
            "input_too_large",
            format!(
                "{} exceeds transfer limit of {} bytes",
                path.display(),
                junban_server::MAX_TRANSFER_BODY_BYTES
            ),
        ));
    }
    std::fs::read_to_string(path).map_err(|error| {
        CliError::usage(
            "input_file_unreadable",
            format!("could not read {}: {error}", path.display()),
        )
    })
}
