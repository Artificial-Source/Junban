//! Focused Phase 6 Wave 1 persistence, secret, restore, and non-undo tests.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use jiff::Timestamp;
use junban_app::{EventType, Repository};
use junban_domain::{
    AI_SECRETS_FILE, AI_SESSIONS_PER_PROFILE_MAX, AiApprovalId, AiMemoryId, AiMessageContent,
    AiMessageId, AiMessageRole, AiMessageStatus, AiProviderPreset, AiRunId, AiRunPhase, AiRunState,
    AiSecretKind, AiSessionId, AiTurnId, OperationId, ProviderBaseUrl, SettingsPatch,
};
use rusqlite::Connection;
use uuid::Uuid;

use crate::ProfileOwner;
use crate::ai_ops;
use crate::ai_secrets::{AiSecretBytes, AiSecretStore};
use crate::migration::{self, CURRENT_SCHEMA_VERSION};
use crate::settings_ops::{self, AiCredentialBindingTarget};

fn temp_profile() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "junban-wave1-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn op() -> OperationId {
    OperationId::parse(&Uuid::new_v4().to_string()).unwrap()
}

fn now() -> Timestamp {
    Timestamp::from_second(1_720_000_000).unwrap()
}

fn open_migrated(profile: &Path) -> Connection {
    let mut connection = Connection::open(profile.join("junban.sqlite3")).unwrap();
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    migration::migrate(&mut connection, profile).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        CURRENT_SCHEMA_VERSION
    );
    connection
}

fn configure_openai(connection: &mut Connection, profile: &Path) {
    let _ = profile;
    let mut settings = settings_ops::get_settings(connection).unwrap();
    settings.ai.provider = Some(AiProviderPreset::OpenAi);
    settings.ai.base_url = Some(
        ProviderBaseUrl::for_provider(AiProviderPreset::OpenAi, "https://api.openai.com/v1")
            .unwrap(),
    );
    settings_ops::patch_settings(
        connection,
        op(),
        SettingsPatch {
            ai: Some(settings.ai),
            ..SettingsPatch::default()
        },
        now(),
    )
    .unwrap();
}

#[test]
fn fresh_migrate_reaches_v6_with_disabled_ai_defaults() {
    let profile = temp_profile();
    let connection = open_migrated(&profile);
    let settings = settings_ops::get_settings(&connection).unwrap();
    assert!(!settings.ai.enabled);
    assert!(!settings.voice.cloud_speech_enabled);
    assert!(settings.ai.credential_id.is_none());
    let tables: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN (
                'ai_sessions','ai_messages','ai_memories','ai_session_memories',
                'ai_tool_approvals','ai_run_state','ai_quota'
             )",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 7);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn ai_session_message_memory_are_non_undoable_and_quota_bounded() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    let created =
        ai_ops::create_ai_session(&mut connection, op(), session_id, "Planning".into(), now())
            .unwrap();
    assert_eq!(
        created.event.event_type.as_str(),
        EventType::AI_SESSION_CHANGED
    );
    assert!(!ai_ops::has_undo_record(&connection, created.event.operation_id).unwrap());

    let message = ai_ops::upsert_ai_message(
        &mut connection,
        op(),
        AiMessageId::new(),
        session_id,
        AiTurnId::new(),
        AiMessageRole::User,
        AiMessageStatus::Completed,
        AiMessageContent::text("hello").unwrap(),
        now(),
    )
    .unwrap();
    assert!(!ai_ops::has_undo_record(&connection, message.event.operation_id).unwrap());

    let memory = ai_ops::create_ai_memory(
        &mut connection,
        op(),
        AiMemoryId::new(),
        "remember the inbox rule".into(),
        now(),
    )
    .unwrap();
    assert_eq!(
        memory.event.event_type.as_str(),
        EventType::AI_MEMORY_CHANGED
    );
    assert!(!ai_ops::has_undo_record(&connection, memory.event.operation_id).unwrap());

    let replay = ai_ops::create_ai_session(
        &mut connection,
        created.event.operation_id,
        session_id,
        "Planning".into(),
        now(),
    )
    .unwrap();
    assert!(!replay.newly_committed);
    assert_eq!(replay.event.revision, created.event.revision);

    for _ in 0..(AI_SESSIONS_PER_PROFILE_MAX - 1) {
        ai_ops::create_ai_session(&mut connection, op(), AiSessionId::new(), "s".into(), now())
            .unwrap();
    }
    let err = ai_ops::create_ai_session(
        &mut connection,
        op(),
        AiSessionId::new(),
        "overflow".into(),
        now(),
    )
    .unwrap_err();
    assert!(matches!(err, junban_app::RepositoryError::Validation(_)));

    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn session_delete_cascades_messages_approvals_and_updates_quota() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();
    ai_ops::upsert_ai_message(
        &mut connection,
        op(),
        AiMessageId::new(),
        session_id,
        AiTurnId::new(),
        AiMessageRole::User,
        AiMessageStatus::Completed,
        AiMessageContent::text("body").unwrap(),
        now(),
    )
    .unwrap();
    ai_ops::propose_ai_approval(
        &mut connection,
        op(),
        AiApprovalId::new(),
        session_id,
        AiTurnId::new(),
        AiRunId::new(),
        1,
        "create_task".into(),
        r#"{"title":"x"}"#.into(),
        now(),
    )
    .unwrap();
    ai_ops::upsert_ai_run_state(
        &mut connection,
        op(),
        AiRunState {
            run_id: AiRunId::new(),
            session_id,
            turn_id: AiTurnId::new(),
            generation: 1,
            state: AiRunPhase::Running,
            approval_id: None,
            created_at: now(),
            updated_at: now(),
        },
        now(),
    )
    .unwrap();

    ai_ops::delete_ai_session(&mut connection, op(), session_id, now()).unwrap();
    let messages: i64 = connection
        .query_row("SELECT COUNT(*) FROM ai_messages", [], |row| row.get(0))
        .unwrap();
    let approvals: i64 = connection
        .query_row("SELECT COUNT(*) FROM ai_tool_approvals", [], |row| {
            row.get(0)
        })
        .unwrap();
    let runs: i64 = connection
        .query_row("SELECT COUNT(*) FROM ai_run_state", [], |row| row.get(0))
        .unwrap();
    assert_eq!((messages, approvals, runs), (0, 0, 0));
    let sessions: i64 = connection
        .query_row(
            "SELECT session_count FROM ai_quota WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(sessions, 0);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn secret_binding_is_receipt_first_and_reconciles_orphans() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    configure_openai(&mut connection, &profile);

    let (mutation, first_id) = settings_ops::bind_ai_credential(
        &mut connection,
        &profile,
        op(),
        AiCredentialBindingTarget::AiProvider,
        AiSecretKind::ApiKey,
        Some(AiSecretBytes::new("fixture-provider-material").unwrap()),
        now(),
    )
    .unwrap();
    assert_eq!(
        mutation.event.event_type.as_str(),
        EventType::SETTINGS_UPDATED
    );
    let first_id = first_id.unwrap();
    assert_eq!(
        settings_ops::get_settings(&connection)
            .unwrap()
            .ai
            .credential_id,
        Some(first_id)
    );

    let store = AiSecretStore::load(&profile).unwrap();
    assert!(store.get_secret(&first_id).is_some());
    let listed = serde_json::to_string(&store.list_metadata()).unwrap();
    assert!(!listed.contains("fixture-provider-material"));

    let (_mutation, second_id) = settings_ops::bind_ai_credential(
        &mut connection,
        &profile,
        op(),
        AiCredentialBindingTarget::AiProvider,
        AiSecretKind::ApiKey,
        Some(AiSecretBytes::new("fixture-provider-material-2").unwrap()),
        now(),
    )
    .unwrap();
    let second_id = second_id.unwrap();
    let store = AiSecretStore::load(&profile).unwrap();
    assert!(store.get_secret(&first_id).is_none());
    assert!(store.get_secret(&second_id).is_some());

    let orphan = store
        .publish(
            AiSecretKind::Bearer,
            AiSecretBytes::new("orphan-material").unwrap(),
            now(),
        )
        .unwrap();
    let settings = settings_ops::get_settings(&connection).unwrap();
    let removed = store
        .reconcile_unreferenced(&junban_domain::referenced_ai_credential_ids(
            &settings.ai,
            &settings.voice,
        ))
        .unwrap();
    assert_eq!(removed, 1);
    assert!(store.get_secret(&orphan).is_none());

    settings_ops::clear_ai_credential_binding(
        &mut connection,
        &profile,
        op(),
        AiCredentialBindingTarget::AiProvider,
        now(),
    )
    .unwrap();
    assert!(
        settings_ops::get_settings(&connection)
            .unwrap()
            .ai
            .credential_id
            .is_none()
    );
    assert!(
        AiSecretStore::load(&profile)
            .unwrap()
            .get_secret(&second_id)
            .is_none()
    );

    let path = profile.join(AI_SECRETS_FILE);
    if path.is_file() {
        fs::remove_file(&path).unwrap();
    }
    fs::create_dir(&path).unwrap();
    let before = settings_ops::get_settings(&connection).unwrap();
    let err = settings_ops::bind_ai_credential(
        &mut connection,
        &profile,
        op(),
        AiCredentialBindingTarget::AiProvider,
        AiSecretKind::ApiKey,
        Some(AiSecretBytes::new("should-fail").unwrap()),
        now(),
    )
    .unwrap_err();
    assert!(matches!(err, junban_app::RepositoryError::Storage(_)));
    assert_eq!(
        before.ai.credential_id,
        settings_ops::get_settings(&connection)
            .unwrap()
            .ai
            .credential_id
    );
    fs::remove_dir(&path).unwrap();
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn complete_backup_excludes_secrets_and_restore_clears_bindings() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    configure_openai(&mut connection, &profile);
    let (_mutation, cred) = settings_ops::bind_ai_credential(
        &mut connection,
        &profile,
        op(),
        AiCredentialBindingTarget::AiProvider,
        AiSecretKind::ApiKey,
        Some(AiSecretBytes::new("backup-must-not-include").unwrap()),
        now(),
    )
    .unwrap();
    let cred = cred.unwrap();
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "kept".into(), now()).unwrap();
    ai_ops::create_ai_memory(
        &mut connection,
        op(),
        AiMemoryId::new(),
        "kept memory".into(),
        now(),
    )
    .unwrap();
    drop(connection);

    let owner = ProfileOwner::open(&profile).unwrap();
    let repo = owner.repository();
    let backup = repo.create_backup().await.unwrap();
    let backup_bytes = fs::read(backup.path()).unwrap();
    assert!(
        !backup_bytes
            .windows(b"backup-must-not-include".len())
            .any(|window| window == b"backup-must-not-include")
    );
    assert!(
        !backup_bytes
            .windows(AI_SECRETS_FILE.len())
            .any(|window| window == AI_SECRETS_FILE.as_bytes())
    );
    assert!(profile.join(AI_SECRETS_FILE).exists());
    assert!(
        AiSecretStore::load(&profile)
            .unwrap()
            .get_secret(&cred)
            .is_some()
    );

    let prepared = repo.prepare_restore(backup).await.unwrap();
    {
        let candidate = Connection::open(prepared.path()).unwrap();
        let settings = settings_ops::get_settings(&candidate).unwrap();
        assert!(!settings.ai.enabled);
        assert!(settings.ai.credential_id.is_none());
        assert_eq!(settings.ai.provider, Some(AiProviderPreset::OpenAi));
        let sessions: i64 = candidate
            .query_row("SELECT COUNT(*) FROM ai_sessions", [], |row| row.get(0))
            .unwrap();
        let memories: i64 = candidate
            .query_row("SELECT COUNT(*) FROM ai_memories", [], |row| row.get(0))
            .unwrap();
        assert_eq!((sessions, memories), (1, 1));
    }

    repo.restore_backup(prepared).await.unwrap();
    drop(repo);
    drop(owner);

    let connection = Connection::open(profile.join("junban.sqlite3")).unwrap();
    let settings = settings_ops::get_settings(&connection).unwrap();
    assert!(settings.ai.credential_id.is_none());
    assert!(!settings.ai.enabled);
    drop(connection);

    // Post-cutover startup reconciliation removes now-unreferenced secrets.
    let owner = ProfileOwner::open(&profile).unwrap();
    let _repo = owner.repository();
    assert!(
        AiSecretStore::load(&profile)
            .unwrap()
            .get_secret(&cred)
            .is_none()
    );
    drop(owner);
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn failed_restore_does_not_touch_secret_file() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    configure_openai(&mut connection, &profile);
    let (_m, cred) = settings_ops::bind_ai_credential(
        &mut connection,
        &profile,
        op(),
        AiCredentialBindingTarget::AiProvider,
        AiSecretKind::ApiKey,
        Some(AiSecretBytes::new("must-remain").unwrap()),
        now(),
    )
    .unwrap();
    let cred = cred.unwrap();
    let before = fs::read(profile.join(AI_SECRETS_FILE)).unwrap();
    drop(connection);

    let owner = ProfileOwner::open(&profile).unwrap();
    let repo = owner.repository();
    let backup = repo.create_backup().await.unwrap();
    let mut bytes = fs::read(backup.path()).unwrap();
    bytes.truncate(bytes.len() / 2);
    fs::write(backup.path(), &bytes).unwrap();
    assert!(repo.prepare_restore(backup).await.is_err());
    let after = fs::read(profile.join(AI_SECRETS_FILE)).unwrap();
    assert_eq!(before, after);
    assert!(
        AiSecretStore::load(&profile)
            .unwrap()
            .get_secret(&cred)
            .is_some()
    );
    drop(repo);
    drop(owner);
    fs::remove_dir_all(profile).unwrap();
}
