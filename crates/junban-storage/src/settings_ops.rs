//! Settings aggregate read/write operations.

use jiff::Timestamp;
use junban_app::{
    AffectedIds, AppSettings, CommittedMutation, EventType, RepositoryError, ResourceRef,
    ResyncScope, SettingsPatch,
};
use junban_domain::OperationId;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::helpers::validation;
use crate::rows::storage_error;
use crate::tx::{MutationEffect, canonical_json, mutate};

const SETTINGS_KEY: &str = "settings_json";

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Req<'a> {
    PatchSettings { patch: &'a SettingsPatch },
}

pub(crate) fn get_settings(connection: &Connection) -> Result<AppSettings, RepositoryError> {
    let json: String = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = ?1",
            [SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| RepositoryError::Storage("settings_json row is missing".to_owned()))?;
    let settings: AppSettings = serde_json::from_str(&json).map_err(storage_error)?;
    settings.validate().map_err(validation)?;
    Ok(settings)
}

pub(crate) fn patch_settings(
    connection: &mut Connection,
    operation_id: OperationId,
    patch: SettingsPatch,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::PatchSettings { patch: &patch })?;
    mutate(connection, operation_id, request, now, move |tx, _| {
        let current = load_settings_tx(tx)?;
        let next = current.apply_patch(&patch).map_err(validation)?;
        let json = serde_json::to_string(&next).map_err(storage_error)?;
        let updated = tx
            .execute(
                "UPDATE app_settings SET value_json = ?1, updated_at = ?2 WHERE key = ?3",
                params![json, now.to_string(), SETTINGS_KEY],
            )
            .map_err(storage_error)?;
        if updated != 1 {
            // Fresh migrate always inserts the row; treat absence as storage corruption.
            return Err(RepositoryError::Storage(
                "settings_json row is missing".to_owned(),
            ));
        }
        Ok(MutationEffect {
            event_type: EventType::new(EventType::SETTINGS_UPDATED),
            primary: Some(ResourceRef::settings()),
            snapshot: None,
            affected: AffectedIds::default(),
            resync: ResyncScope::SETTINGS,
            task_activity: Vec::new(),
            summary_subject: Some(("settings".into(), "settings".into())),
            undo: None,
            mark_undone: None,
            uncomplete_outcome: None,
        })
    })
}

/// Load and validate the typed settings aggregate inside an open transaction.
/// Reused only by storage mutations that must read defaults atomically with their write.
pub(crate) fn load_settings_tx(
    tx: &rusqlite::Transaction<'_>,
) -> Result<AppSettings, RepositoryError> {
    let json: String = tx
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = ?1",
            [SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| RepositoryError::Storage("settings_json row is missing".to_owned()))?;
    let settings: AppSettings = serde_json::from_str(&json).map_err(storage_error)?;
    settings.validate().map_err(validation)?;
    Ok(settings)
}
