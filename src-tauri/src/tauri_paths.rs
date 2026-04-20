use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const DESKTOP_SIDECAR_ENTRY: &str = "gen/sidecar/backend/server.js";

fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data directory: {err}"))?;
    Ok(app_data.join("ASF Junban"))
}

pub(crate) fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join("junban.db"))
}

pub(crate) fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join("remote-access.json"))
}

pub(crate) fn resource_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map_err(|err| format!("Failed to resolve resource directory: {err}"))
}

pub(crate) fn desktop_plugin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join("plugins"))
}

pub(crate) fn desktop_markdown_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join("tasks"))
}

pub(crate) fn desktop_sidecar_entry_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resource_dir(app)?.join(DESKTOP_SIDECAR_ENTRY))
}
