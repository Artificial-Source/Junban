//! Settings aggregate read/write operations.

#![allow(dead_code)]

use std::path::Path;

use jiff::Timestamp;
use junban_app::{
    AffectedIds, AiCredentialBindingTarget, AiSecretBytes, AppSettings, CommittedMutation,
    EventType, RepositoryError, ResourceRef, ResyncScope, SettingsPatch,
};
use junban_domain::{AiCredentialId, AiSecretKind, OperationId};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::ai_secrets::{AiSecretStore, AiSecretStoreError};
use crate::helpers::validation;
use crate::rows::storage_error;
use crate::tx::{MutationEffect, canonical_json, mutate};

const SETTINGS_KEY: &str = "settings_json";

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Req<'a> {
    PatchSettings {
        patch: &'a SettingsPatch,
    },
    BindAiCredential {
        target: &'a str,
        kind: AiSecretKind,
        secret_verifier: Option<String>,
    },
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

/// Receipt-first secret binding:
/// 1. publish new unreferenced secret durably (when `secret` is `Some`)
/// 2. commit one settings binding/event under `operation_id`
/// 3. remove the superseded unreferenced secret (cleanup failure is diagnostic-only)
///
/// Failed publication leaves settings unchanged. Failed binding leaves only an orphan
/// secret ID. In-memory authority follows the confirmed binding only.
pub(crate) fn bind_ai_credential(
    connection: &mut Connection,
    profile_dir: &Path,
    operation_id: OperationId,
    target: AiCredentialBindingTarget,
    kind: AiSecretKind,
    secret: Option<AiSecretBytes>,
    now: Timestamp,
) -> Result<(CommittedMutation, Option<AiCredentialId>), RepositoryError> {
    let target_name = match target {
        AiCredentialBindingTarget::AiProvider => "ai_provider",
        AiCredentialBindingTarget::VoiceStt => "voice_stt",
        AiCredentialBindingTarget::VoiceTts => "voice_tts",
    };
    // Establish the profile-private verifier key durably before a receipt can
    // reference it. The HMAC preserves exact-request mismatch protection without
    // leaving an offline secret verifier in SQLite or complete backups.
    let has_secret = secret.is_some();
    let preloaded_store = secret
        .as_ref()
        .map(|_| AiSecretStore::load_or_create(profile_dir))
        .transpose()
        .map_err(|error| RepositoryError::Storage(format!("ai-secrets load failed: {error}")))?;
    let secret_verifier = match (&preloaded_store, &secret) {
        (Some(store), Some(secret)) => {
            Some(store.receipt_verifier(secret).map_err(map_secret_error)?)
        }
        (None, None) => None,
        _ => {
            return Err(RepositoryError::Storage(
                "AI secret verifier authority is inconsistent".to_owned(),
            ));
        }
    };
    let request = canonical_json(&Req::BindAiCredential {
        target: target_name,
        kind,
        secret_verifier,
    })?;

    let mut published_id = None;
    let mut previous_id = None;
    let mutation = mutate(connection, operation_id, request, now, |tx, _| {
        // Receipt replay returns before this closure, so a lost response can never
        // publish another random credential entry.
        let store = match preloaded_store {
            Some(store) => store,
            None => AiSecretStore::load(profile_dir).map_err(|error| {
                RepositoryError::Storage(format!("ai-secrets load failed: {error}"))
            })?,
        };
        let current = load_settings_tx(tx)?;
        previous_id = Some(match target {
            AiCredentialBindingTarget::AiProvider => current.ai.credential_id,
            AiCredentialBindingTarget::VoiceStt => current.voice.stt_credential_id,
            AiCredentialBindingTarget::VoiceTts => current.voice.tts_credential_id,
        });
        let new_id = secret
            .map(|secret| store.publish(kind, secret, now).map_err(map_secret_error))
            .transpose()?;
        published_id = Some(new_id);

        let mut next = current;
        match target {
            AiCredentialBindingTarget::AiProvider => {
                next.ai.credential_id = new_id;
            }
            AiCredentialBindingTarget::VoiceStt => {
                next.voice.stt_credential_id = new_id;
                if new_id.is_some() {
                    next.voice.cloud_speech_enabled = true;
                } else if next.voice.tts_credential_id.is_none() {
                    next.voice.cloud_speech_enabled = false;
                }
            }
            AiCredentialBindingTarget::VoiceTts => {
                next.voice.tts_credential_id = new_id;
                if new_id.is_some() {
                    next.voice.cloud_speech_enabled = true;
                } else if next.voice.stt_credential_id.is_none() {
                    next.voice.cloud_speech_enabled = false;
                }
            }
        }
        next.validate().map_err(validation)?;
        let json = serde_json::to_string(&next).map_err(storage_error)?;
        let updated = tx
            .execute(
                "UPDATE app_settings SET value_json = ?1, updated_at = ?2 WHERE key = ?3",
                params![json, now.to_string(), SETTINGS_KEY],
            )
            .map_err(storage_error)?;
        if updated != 1 {
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
            summary_subject: Some(match new_id {
                Some(id) => ("ai_credential".into(), id.to_string()),
                None => ("settings".into(), "settings".into()),
            }),
            undo: None,
            mark_undone: None,
            uncomplete_outcome: None,
        })
    })?;

    let new_id = if mutation.newly_committed {
        published_id.flatten()
    } else if has_secret {
        let raw: String = connection
            .query_row(
                "SELECT subject_id FROM activity
                 WHERE revision = ?1 AND operation_id = ?2 AND subject_type = 'ai_credential'",
                params![
                    i64::try_from(mutation.event.revision).map_err(storage_error)?,
                    operation_id.to_string(),
                ],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        Some(AiCredentialId::parse(&raw).map_err(storage_error)?)
    } else {
        None
    };

    // Remove superseded unreferenced secret after successful binding. Cleanup
    // failure is diagnostic-only because only the new ID is reachable.
    if mutation.newly_committed
        && let Some(previous) = previous_id.flatten()
        && Some(previous) != new_id
        && let Ok(store) = AiSecretStore::load(profile_dir)
    {
        let _ = store.delete(&previous);
    }

    Ok((mutation, new_id))
}

/// Clear a credential binding in settings first, then delete private bytes.
/// Any deletion failure leaves only an unreachable orphan.
pub(crate) fn clear_ai_credential_binding(
    connection: &mut Connection,
    profile_dir: &Path,
    operation_id: OperationId,
    target: AiCredentialBindingTarget,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let (mutation, _) = bind_ai_credential(
        connection,
        profile_dir,
        operation_id,
        target,
        AiSecretKind::ApiKey,
        None,
        now,
    )?;
    Ok(mutation)
}

fn map_secret_error(error: AiSecretStoreError) -> RepositoryError {
    match error {
        AiSecretStoreError::BoundExceeded => RepositoryError::OperationTooLarge,
        AiSecretStoreError::Invalid(message) => {
            RepositoryError::Validation(junban_domain::ValidationError::Invalid {
                field: "ai_secret",
                reason: message,
            })
        }
        AiSecretStoreError::Conflict => RepositoryError::Conflict,
        AiSecretStoreError::Io(error) => {
            RepositoryError::Storage(format!("ai-secrets durability failure: {error}"))
        }
    }
}

/// Load and validate the typed settings aggregate inside an open transaction.
/// Reused only by storage mutations that must read defaults atomically with their write.
pub(crate) fn load_settings_tx(tx: &rusqlite::Connection) -> Result<AppSettings, RepositoryError> {
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
