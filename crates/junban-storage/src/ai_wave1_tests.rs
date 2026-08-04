//! Focused Phase 6 Wave 1 persistence, secret, restore, and non-undo tests.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use jiff::{Timestamp, ToSpan};
use junban_app::{
    AiCredentialBindingTarget, AiSecretBytes, EventType, Repository, RepositoryError, StagedFile,
};
use junban_domain::{
    AI_SECRETS_FILE, AI_SESSION_CONTENT_BYTES_MAX, AI_SESSIONS_PER_PROFILE_MAX, AiApprovalId,
    AiApprovalStatus, AiMemoryId, AiMessageContent, AiMessageId, AiMessageRole, AiMessageStatus,
    AiProviderPreset, AiRunId, AiRunPhase, AiRunState, AiSecretKind, AiSessionId, AiToolEvent,
    AiToolEventType, AiTurnId, OperationId, ProviderBaseUrl, SettingsPatch,
    ai_approval_action_hash, frame_backup_envelope, parse_backup_envelope, sha256_hex,
};
use rusqlite::{Connection, params};
use serde_json::json;
use uuid::Uuid;

use crate::ProfileOwner;
use crate::ai_ops;
use crate::ai_secrets::AiSecretStore;
use crate::migration::{self, CURRENT_SCHEMA_VERSION};
use crate::settings_ops;

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

fn create_assistant_placeholder(
    connection: &mut Connection,
    session_id: AiSessionId,
    turn_id: AiTurnId,
) -> AiMessageId {
    let assistant_message_id = AiMessageId::new();
    ai_ops::upsert_ai_message(
        connection,
        op(),
        assistant_message_id,
        session_id,
        turn_id,
        AiMessageRole::Assistant,
        AiMessageStatus::Streaming,
        AiMessageContent::text("").unwrap(),
        now(),
    )
    .unwrap();
    assistant_message_id
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
                'ai_tool_approvals','ai_run_state','ai_response_invalidations','ai_quota'
             )",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 8);
    let assistant_not_null: i64 = connection
        .query_row(
            "SELECT \"notnull\" FROM pragma_table_info('ai_run_state')
             WHERE name = 'assistant_message_id'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(assistant_not_null, 1);
    let approval_index_sql: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_ai_run_state_approval'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        approval_index_sql.contains("approval_id")
            && approval_index_sql.contains("WHERE")
            && approval_index_sql.contains("approval_id IS NOT NULL"),
        "fresh schema v6 must include partial ai_run_state.approval_id index: {approval_index_sql}"
    );
    let daily_plan: Vec<String> = connection
        .prepare(
            "EXPLAIN QUERY PLAN SELECT 1 FROM ai_messages
             WHERE role = 'assistant' AND status IN ('streaming', 'completed')
               AND json_type(content_json, '$.briefing_date') = 'text'
               AND json_extract(content_json, '$.briefing_date') = ?1",
        )
        .unwrap()
        .query_map(["2026-08-04"], |row| row.get::<_, String>(3))
        .unwrap()
        .map(|row| row.unwrap())
        .collect();
    assert!(
        daily_plan
            .iter()
            .any(|step| step.contains("idx_ai_messages_briefing_date")),
        "daily reservation must search the partial date index: {}",
        daily_plan.join(" | ")
    );
    let invalidation_foreign_keys: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('ai_response_invalidations')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(invalidation_foreign_keys, 0);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn current_v7_rejects_missing_v6_authority_without_repair() {
    for (name, drop_sql) in [
        (
            "idx_ai_run_state_state",
            "DROP INDEX idx_ai_run_state_state;",
        ),
        (
            "idx_ai_messages_daily_briefing_active",
            "DROP INDEX idx_ai_messages_daily_briefing_active;",
        ),
        (
            "idx_ai_messages_briefing_date",
            "DROP INDEX idx_ai_messages_briefing_date;",
        ),
        (
            "ai_response_invalidations",
            "DROP TABLE ai_response_invalidations;",
        ),
    ] {
        let profile = temp_profile();
        let connection = open_migrated(&profile);
        connection
            .execute(
                "INSERT INTO ai_response_invalidations(
                    run_id, session_id, invalidating_operation_id, expires_at
                 ) VALUES ('retained-run', 'retained-session', 'retained-operation',
                    '2026-08-04T12:00:00Z')",
                [],
            )
            .unwrap();
        connection.execute_batch(drop_sql).unwrap();
        drop(connection);

        assert!(
            matches!(
                ProfileOwner::open(&profile),
                Err(crate::OpenError::Database(_))
            ),
            "{name}"
        );
        let connection = Connection::open(profile.join("junban.sqlite3")).unwrap();
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = ?1)",
                [name],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!exists, "current-v7 open recreated {name}");
        if name != "ai_response_invalidations" {
            let retained: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM ai_response_invalidations",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(retained, 1, "{name}");
        }
        drop(connection);
        fs::remove_dir_all(profile).unwrap();
    }
}

#[test]
fn dispatch_recovery_uses_state_index() {
    let profile = temp_profile();
    let connection = open_migrated(&profile);
    let plan: Vec<String> = connection
        .prepare(
            "EXPLAIN QUERY PLAN SELECT a.id
             FROM ai_run_state AS r INDEXED BY idx_ai_run_state_state
             JOIN ai_tool_approvals AS a ON a.id = r.approval_id
             WHERE r.state = 'dispatching' AND a.status = 'consumed'
             ORDER BY r.run_id LIMIT 500",
        )
        .unwrap()
        .query_map([], |row| row.get::<_, String>(3))
        .unwrap()
        .map(|row| row.unwrap())
        .collect();
    assert!(
        plan.iter()
            .any(|step| { step.contains("idx_ai_run_state_state") && step.contains("SEARCH") }),
        "dispatch recovery must search the state index: {}",
        plan.join(" | ")
    );
    drop(connection);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn normal_open_rejects_malformed_response_invalidation_ids_and_timestamps() {
    for (run_id, expires_at) in [
        ("not-a-run".to_owned(), now().to_string()),
        (AiRunId::new().to_string(), "not-a-timestamp".to_owned()),
    ] {
        let profile = temp_profile();
        let mut connection = open_migrated(&profile);
        let session_id = AiSessionId::new();
        ai_ops::create_ai_session(
            &mut connection,
            op(),
            session_id,
            "invalidations".into(),
            now(),
        )
        .unwrap();
        connection
            .execute(
                "INSERT INTO ai_response_invalidations(
                    run_id, session_id, invalidating_operation_id, expires_at
                 ) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![run_id, session_id.to_string(), op().to_string(), expires_at,],
            )
            .unwrap();
        drop(connection);
        assert!(matches!(
            ProfileOwner::open(&profile),
            Err(crate::OpenError::Database(_))
        ));
        fs::remove_dir_all(profile).unwrap();
    }
}

#[tokio::test]
async fn restore_preflight_rejects_malformed_response_invalidation_ids_and_timestamps() {
    for (run_id, expires_at) in [
        ("not-a-run".to_owned(), now().to_string()),
        (AiRunId::new().to_string(), "not-a-timestamp".to_owned()),
    ] {
        let profile = temp_profile();
        let mut connection = open_migrated(&profile);
        let session_id = AiSessionId::new();
        ai_ops::create_ai_session(
            &mut connection,
            op(),
            session_id,
            "restore invalidation".into(),
            now(),
        )
        .unwrap();
        let backup = crate::backup_ops::create_backup(&connection, &profile).unwrap();
        let hostile =
            reframe_backup_with(&profile, &backup, "response-invalidation", |candidate| {
                candidate
                    .execute(
                        "INSERT INTO ai_response_invalidations(
                            run_id, session_id, invalidating_operation_id, expires_at
                         ) VALUES (?1, ?2, ?3, ?4)",
                        rusqlite::params![
                            run_id,
                            session_id.to_string(),
                            op().to_string(),
                            expires_at,
                        ],
                    )
                    .unwrap();
            });
        drop(connection);
        let owner = ProfileOwner::open(&profile).unwrap();
        let repo = owner.repository();
        assert!(matches!(
            repo.prepare_restore(hostile).await,
            Err(RepositoryError::Validation(_))
        ));
        drop(repo);
        drop(owner);
        fs::remove_dir_all(profile).unwrap();
    }
}

#[test]
fn terminal_approval_binding_lookup_uses_approval_id_index() {
    let profile = temp_profile();
    let connection = open_migrated(&profile);
    // Exact restore-validation probe used for rejected/expired approvals.
    let mut statement = connection
        .prepare(
            "EXPLAIN QUERY PLAN SELECT EXISTS(SELECT 1 FROM ai_run_state WHERE approval_id = ?1)",
        )
        .unwrap();
    let plan: Vec<String> = statement
        .query_map(["aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"], |row| {
            row.get::<_, String>(3)
        })
        .unwrap()
        .map(|row| row.unwrap())
        .collect();
    let joined = plan.join(" | ");
    assert!(
        plan.iter()
            .any(|step| { step.contains("idx_ai_run_state_approval") && step.contains("SEARCH") }),
        "terminal approval binding lookup must SEARCH idx_ai_run_state_approval; plan={joined}"
    );
    assert!(
        !plan
            .iter()
            .any(|step| { step.contains("SCAN ai_run_state") && !step.contains("INDEX") }),
        "terminal approval binding lookup must not table-scan ai_run_state; plan={joined}"
    );
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
    create_awaiting_approval(&mut connection, session_id);
    let turn_id = AiTurnId::new();
    let assistant_message_id = create_assistant_placeholder(&mut connection, session_id, turn_id);
    ai_ops::upsert_ai_run_state(
        &mut connection,
        op(),
        AiRunState {
            run_id: AiRunId::new(),
            session_id,
            turn_id,
            assistant_message_id,
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

fn create_awaiting_approval(
    connection: &mut Connection,
    session_id: AiSessionId,
) -> (AiRunId, AiTurnId, AiApprovalId) {
    let run_id = AiRunId::new();
    let turn_id = AiTurnId::new();
    let assistant_message_id = create_assistant_placeholder(connection, session_id, turn_id);
    ai_ops::upsert_ai_run_state(
        connection,
        op(),
        AiRunState {
            run_id,
            session_id,
            turn_id,
            assistant_message_id,
            generation: 1,
            state: AiRunPhase::Running,
            approval_id: None,
            created_at: now(),
            updated_at: now(),
        },
        now(),
    )
    .unwrap();
    let approval_id = AiApprovalId::new();
    ai_ops::propose_ai_approval(
        connection,
        op(),
        approval_id,
        session_id,
        turn_id,
        run_id,
        1,
        "create_task".into(),
        r#"{ "title": "x" }"#.into(),
        now(),
    )
    .unwrap();
    // Proposal itself atomically moves the exact run generation to AwaitingApproval
    // and binds the new authority; callers never issue a second run-state mutation.
    (run_id, turn_id, approval_id)
}

fn dispatch_result_content(
    connection: &Connection,
    assistant_message_id: AiMessageId,
    tool: &str,
    outcome: &str,
) -> AiMessageContent {
    let mut content = ai_ops::get_ai_message(connection, assistant_message_id)
        .unwrap()
        .content;
    let result = json!({
        "tool": tool,
        "outcome": outcome,
        "data": if outcome == "success" {
            json!({"applied": true})
        } else {
            json!({"code": "dispatch_failed", "message": "dispatch failed"})
        },
        "truncated": false,
    });
    content.tool_events.push(
        AiToolEvent::new(
            content.text.len(),
            AiToolEventType::ToolResult,
            result.clone(),
        )
        .unwrap(),
    );
    content.tool_result_json = Some(serde_json::to_string(&result).unwrap());
    content
}

fn revision(connection: &Connection) -> i64 {
    connection
        .query_row(
            "SELECT global_revision FROM app_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

fn pending_quota(connection: &Connection) -> (i64, i64) {
    connection
        .query_row(
            "SELECT pending_approval_count, pending_approval_content_bytes
             FROM ai_quota WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

fn reframe_backup_with(
    profile: &Path,
    backup: &StagedFile,
    label: &str,
    rewrite: impl FnOnce(&Connection),
) -> StagedFile {
    let bytes = fs::read(backup.path()).unwrap();
    let (mut manifest, payload) = parse_backup_envelope(&bytes).unwrap();
    let sqlite_path = profile.join(format!("{label}-payload.sqlite3"));
    fs::write(&sqlite_path, payload).unwrap();
    let connection = Connection::open(&sqlite_path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    rewrite(&connection);
    drop(connection);
    let payload = fs::read(&sqlite_path).unwrap();
    manifest.payload_sha256 = sha256_hex(&payload);
    let framed = frame_backup_envelope(&manifest, &payload).unwrap();
    let path = profile.join(format!("{label}.junban-backup"));
    fs::write(&path, &framed).unwrap();
    StagedFile::new(path, framed.len() as u64)
}

#[test]
fn proposal_atomically_binds_the_exact_running_generation() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();
    let run_id = AiRunId::new();
    let turn_id = AiTurnId::new();
    let assistant_message_id = create_assistant_placeholder(&mut connection, session_id, turn_id);
    ai_ops::upsert_ai_run_state(
        &mut connection,
        op(),
        AiRunState {
            run_id,
            session_id,
            turn_id,
            assistant_message_id,
            generation: 7,
            state: AiRunPhase::Running,
            approval_id: None,
            created_at: now(),
            updated_at: now(),
        },
        now(),
    )
    .unwrap();
    let approval_id = AiApprovalId::new();
    let before_revision = revision(&connection);
    let mutation = ai_ops::propose_ai_approval(
        &mut connection,
        op(),
        approval_id,
        session_id,
        turn_id,
        run_id,
        7,
        "create_task".into(),
        r#"{ "title": "x" }"#.into(),
        now(),
    )
    .unwrap();

    assert_eq!(revision(&connection), before_revision + 1);
    assert_eq!(
        mutation.event.event_type.as_str(),
        EventType::AI_APPROVAL_CHANGED
    );
    let approval = ai_ops::get_ai_approval(&connection, approval_id).unwrap();
    assert_eq!(approval.status, AiApprovalStatus::Pending);
    assert_eq!(approval.run_id, run_id);
    assert_eq!(approval.generation, 7);
    let run = ai_ops::get_ai_run_state(&connection, run_id).unwrap();
    assert_eq!(run.state, AiRunPhase::AwaitingApproval);
    assert_eq!(run.approval_id, Some(approval_id));
    assert_eq!(run.session_id, session_id);
    assert_eq!(run.turn_id, turn_id);
    assert_eq!(run.generation, 7);
    assert_ne!(pending_quota(&connection), (0, 0));
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn approval_rejects_expired_approve_without_changing_state_or_quota() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();
    let (_, _, approval_id) = create_awaiting_approval(&mut connection, session_id);
    let before_revision = revision(&connection);
    let before_quota = pending_quota(&connection);

    assert!(matches!(
        ai_ops::set_ai_approval_status(
            &mut connection,
            op(),
            approval_id,
            AiApprovalStatus::Approved,
            None,
            now() + 301.seconds(),
        ),
        Err(RepositoryError::Conflict)
    ));
    assert_eq!(
        ai_ops::get_ai_approval(&connection, approval_id)
            .unwrap()
            .status,
        AiApprovalStatus::Pending
    );
    assert_eq!(revision(&connection), before_revision);
    assert_eq!(pending_quota(&connection), before_quota);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn rejection_and_expiration_atomically_leave_crash_valid_run_pairs() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();

    let (rejected_run, _, rejected_approval) =
        create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        rejected_approval,
        AiApprovalStatus::Rejected,
        None,
        now(),
    )
    .unwrap();
    assert_eq!(
        ai_ops::get_ai_approval(&connection, rejected_approval)
            .unwrap()
            .status,
        AiApprovalStatus::Rejected
    );
    let rejected_run = ai_ops::get_ai_run_state(&connection, rejected_run).unwrap();
    assert_eq!(rejected_run.state, AiRunPhase::Running);
    assert!(rejected_run.approval_id.is_none());
    assert_eq!(pending_quota(&connection), (0, 0));

    let (pending_expired_run, _, pending_expired_approval) =
        create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        pending_expired_approval,
        AiApprovalStatus::Expired,
        None,
        now(),
    )
    .unwrap();
    assert_eq!(
        ai_ops::get_ai_approval(&connection, pending_expired_approval)
            .unwrap()
            .status,
        AiApprovalStatus::Expired
    );
    let pending_expired_run = ai_ops::get_ai_run_state(&connection, pending_expired_run).unwrap();
    assert_eq!(pending_expired_run.state, AiRunPhase::Cancelled);
    assert!(pending_expired_run.approval_id.is_none());
    assert_eq!(pending_quota(&connection), (0, 0));

    let (approved_expired_run, _, approved_expired_approval) =
        create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approved_expired_approval,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approved_expired_approval,
        AiApprovalStatus::Expired,
        None,
        now(),
    )
    .unwrap();
    let approved_expired_run = ai_ops::get_ai_run_state(&connection, approved_expired_run).unwrap();
    assert_eq!(approved_expired_run.state, AiRunPhase::Cancelled);
    assert!(approved_expired_run.approval_id.is_none());
    assert_eq!(pending_quota(&connection), (0, 0));

    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn direct_awaiting_cancel_or_fail_expires_bound_authority_atomically() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();

    for terminal in [AiRunPhase::Failed, AiRunPhase::Cancelled] {
        for approve_first in [false, true] {
            let (run_id, turn_id, approval_id) =
                create_awaiting_approval(&mut connection, session_id);
            if approve_first {
                ai_ops::set_ai_approval_status(
                    &mut connection,
                    op(),
                    approval_id,
                    AiApprovalStatus::Approved,
                    None,
                    now(),
                )
                .unwrap();
                assert_eq!(pending_quota(&connection), (0, 0));
            } else {
                assert_ne!(pending_quota(&connection), (0, 0));
            }
            let before_revision = revision(&connection);
            let assistant_message_id = ai_ops::get_ai_run_state(&connection, run_id)
                .unwrap()
                .assistant_message_id;
            ai_ops::upsert_ai_run_state(
                &mut connection,
                op(),
                AiRunState {
                    run_id,
                    session_id,
                    turn_id,
                    assistant_message_id,
                    generation: 1,
                    state: terminal,
                    approval_id: None,
                    created_at: now(),
                    updated_at: now(),
                },
                now(),
            )
            .unwrap();

            assert_eq!(revision(&connection), before_revision + 1);
            assert_eq!(
                ai_ops::get_ai_approval(&connection, approval_id)
                    .unwrap()
                    .status,
                AiApprovalStatus::Expired
            );
            let run = ai_ops::get_ai_run_state(&connection, run_id).unwrap();
            assert_eq!(run.state, terminal);
            assert!(run.approval_id.is_none());
            assert_eq!(pending_quota(&connection), (0, 0));
        }
    }

    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn approval_consumption_is_one_time_and_keeps_quota_exact() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();
    let (_, _, approval_id) = create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approval_id,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();
    assert_eq!(pending_quota(&connection), (0, 0));
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approval_id,
        AiApprovalStatus::Consumed,
        Some(op().to_string()),
        now(),
    )
    .unwrap();
    let before_revision = revision(&connection);
    assert!(matches!(
        ai_ops::set_ai_approval_status(
            &mut connection,
            op(),
            approval_id,
            AiApprovalStatus::Consumed,
            Some(op().to_string()),
            now(),
        ),
        Err(RepositoryError::Conflict)
    ));
    assert_eq!(revision(&connection), before_revision);
    assert_eq!(pending_quota(&connection), (0, 0));
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn approval_consumption_atomically_dispatches_bound_run() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();
    let (run_id, turn_id, approval_id) = create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approval_id,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();
    let before_revision = revision(&connection);
    let dispatch_operation_id = op();
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approval_id,
        AiApprovalStatus::Consumed,
        Some(dispatch_operation_id.to_string()),
        now(),
    )
    .unwrap();

    let approval = ai_ops::get_ai_approval(&connection, approval_id).unwrap();
    assert_eq!(approval.status, AiApprovalStatus::Consumed);
    assert_eq!(
        approval.operation_id.as_deref(),
        Some(dispatch_operation_id.to_string().as_str())
    );
    assert_eq!(approval.session_id, session_id);
    assert_eq!(approval.turn_id, turn_id);
    assert_eq!(approval.run_id, run_id);
    assert_eq!(approval.generation, 1);

    let run = ai_ops::get_ai_run_state(&connection, run_id).unwrap();
    assert_eq!(run.state, AiRunPhase::Dispatching);
    assert_eq!(run.approval_id, Some(approval_id));
    assert_eq!(run.session_id, session_id);
    assert_eq!(run.turn_id, turn_id);
    assert_eq!(run.generation, 1);
    assert_eq!(revision(&connection), before_revision + 1);
    assert_eq!(pending_quota(&connection), (0, 0));

    // Receipts created after a dispatch starts remain recoverable even after their
    // ordinary TTL. Cleanup triggered by another mutation must not erase exact
    // effect authority while the bound run is still Dispatching.
    let protected_operation_id = op();
    ai_ops::rename_ai_session(
        &mut connection,
        protected_operation_id,
        session_id,
        "dispatch effect".into(),
        now(),
    )
    .unwrap();
    connection
        .execute(
            "UPDATE operation_receipts SET expires_at = '2000-01-01T00:00:00Z'
             WHERE operation_id = ?1",
            [protected_operation_id.to_string()],
        )
        .unwrap();
    ai_ops::rename_ai_session(
        &mut connection,
        op(),
        session_id,
        "cleanup trigger".into(),
        now(),
    )
    .unwrap();
    let retained: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id = ?1)",
            [protected_operation_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        retained,
        "dispatch recovery receipt was cleaned before replay"
    );
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn approval_consumption_failure_leaves_approval_and_run_unchanged() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();
    let (run_id, _, approval_id) = create_awaiting_approval(&mut connection, session_id);

    // Pending is not a legal consume source state.
    let pending_revision = revision(&connection);
    assert!(matches!(
        ai_ops::set_ai_approval_status(
            &mut connection,
            op(),
            approval_id,
            AiApprovalStatus::Consumed,
            Some(op().to_string()),
            now(),
        ),
        Err(RepositoryError::Conflict)
    ));
    assert_eq!(
        ai_ops::get_ai_approval(&connection, approval_id)
            .unwrap()
            .status,
        AiApprovalStatus::Pending
    );
    assert_eq!(
        ai_ops::get_ai_run_state(&connection, run_id).unwrap().state,
        AiRunPhase::AwaitingApproval
    );
    assert_eq!(revision(&connection), pending_revision);

    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approval_id,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();
    // Force the bound run out of awaiting_approval so centralized authority
    // validation must fail closed before the consume CAS.
    connection
        .execute(
            "UPDATE ai_run_state SET state = 'running' WHERE run_id = ?1",
            [run_id.to_string()],
        )
        .unwrap();
    let approved_revision = revision(&connection);
    assert!(matches!(
        ai_ops::set_ai_approval_status(
            &mut connection,
            op(),
            approval_id,
            AiApprovalStatus::Consumed,
            Some(op().to_string()),
            now(),
        ),
        Err(RepositoryError::Storage(_))
    ));
    let approval = ai_ops::get_ai_approval(&connection, approval_id).unwrap();
    assert_eq!(approval.status, AiApprovalStatus::Approved);
    assert!(approval.operation_id.is_none());
    assert_eq!(
        ai_ops::get_ai_run_state(&connection, run_id).unwrap().state,
        AiRunPhase::Running
    );
    assert_eq!(revision(&connection), approved_revision);
    assert_eq!(pending_quota(&connection), (0, 0));
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn restore_preflight_accepts_consumed_dispatching_approval_pair() {
    let _serial = crate::backup_ops::RESTORE_FAULT_TEST_LOCK.lock().await;
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();
    let (run_id, _, approval_id) = create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approval_id,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();
    let dispatch_operation_id = op();
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approval_id,
        AiApprovalStatus::Consumed,
        Some(dispatch_operation_id.to_string()),
        now(),
    )
    .unwrap();
    assert_eq!(
        ai_ops::get_ai_approval(&connection, approval_id)
            .unwrap()
            .status,
        AiApprovalStatus::Consumed
    );
    assert_eq!(
        ai_ops::get_ai_run_state(&connection, run_id).unwrap().state,
        AiRunPhase::Dispatching
    );
    // Stage the authority before normal owner startup performs its own recovery.
    let backup = crate::backup_ops::create_backup(&connection, &profile).unwrap();
    drop(connection);

    let owner = ProfileOwner::open(&profile).unwrap();
    let repo = owner.repository();
    // validate_ai_rows admits consumed + dispatching before sanitize expires runtime state.
    let prepared = repo.prepare_restore(backup).await.expect(
        "restore preflight must accept a valid consumed approval bound to a dispatching run",
    );
    {
        let candidate = Connection::open(prepared.path()).unwrap();
        let approval = ai_ops::get_ai_approval(&candidate, approval_id).unwrap();
        assert_eq!(approval.status, AiApprovalStatus::Consumed);
        assert_eq!(
            approval.operation_id.as_deref(),
            Some(dispatch_operation_id.to_string().as_str())
        );
        // Candidate sanitization retains consumed dispatch authority for restart recovery.
        let run = ai_ops::get_ai_run_state(&candidate, run_id).unwrap();
        assert_eq!(run.state, AiRunPhase::Dispatching);
        assert_eq!(run.approval_id, Some(approval_id));
    }
    drop(prepared);
    drop(repo);
    drop(owner);
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn complete_backup_prepare_restore_accepts_and_sanitizes_all_approval_run_pairs() {
    let _serial = crate::backup_ops::RESTORE_FAULT_TEST_LOCK.lock().await;
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();

    let (pending_run, _, pending_approval) = create_awaiting_approval(&mut connection, session_id);

    let (approved_run, _, approved_approval) =
        create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approved_approval,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();

    let (rejected_run, _, rejected_approval) =
        create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        rejected_approval,
        AiApprovalStatus::Rejected,
        None,
        now(),
    )
    .unwrap();

    let (expired_run, _, expired_approval) = create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        expired_approval,
        AiApprovalStatus::Expired,
        None,
        now(),
    )
    .unwrap();

    let (consumed_run, _, consumed_approval) =
        create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        consumed_approval,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        consumed_approval,
        AiApprovalStatus::Consumed,
        Some(op().to_string()),
        now(),
    )
    .unwrap();
    // Preserve all valid pre-restart pairs in the staged backup; opening the live
    // owner below independently sanitizes its own runtime authority.
    let backup = crate::backup_ops::create_backup(&connection, &profile).unwrap();
    drop(connection);

    let owner = ProfileOwner::open(&profile).unwrap();
    let repo = owner.repository();
    let prepared = repo.prepare_restore(backup).await.unwrap();
    let candidate = Connection::open(prepared.path()).unwrap();

    for approval_id in [pending_approval, approved_approval, expired_approval] {
        assert_eq!(
            ai_ops::get_ai_approval(&candidate, approval_id)
                .unwrap()
                .status,
            AiApprovalStatus::Expired
        );
    }
    assert_eq!(
        ai_ops::get_ai_approval(&candidate, rejected_approval)
            .unwrap()
            .status,
        AiApprovalStatus::Rejected
    );
    assert_eq!(
        ai_ops::get_ai_approval(&candidate, consumed_approval)
            .unwrap()
            .status,
        AiApprovalStatus::Consumed
    );
    for run_id in [pending_run, approved_run, rejected_run, expired_run] {
        let run = ai_ops::get_ai_run_state(&candidate, run_id).unwrap();
        assert_eq!(run.state, AiRunPhase::Cancelled);
        assert!(run.approval_id.is_none());
    }
    let consumed = ai_ops::get_ai_run_state(&candidate, consumed_run).unwrap();
    assert_eq!(consumed.state, AiRunPhase::Dispatching);
    assert_eq!(consumed.approval_id, Some(consumed_approval));
    assert_eq!(pending_quota(&candidate), (0, 0));

    drop(candidate);
    drop(prepared);
    drop(repo);
    drop(owner);
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn restore_preflight_rejects_orphan_and_cross_bound_active_approval_authority() {
    let _serial = crate::backup_ops::RESTORE_FAULT_TEST_LOCK.lock().await;

    // A pending approval without its exact awaiting run is active orphan authority.
    {
        let profile = temp_profile();
        let mut connection = open_migrated(&profile);
        let session_id = AiSessionId::new();
        ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();
        let (run_id, _, _) = create_awaiting_approval(&mut connection, session_id);
        let backup = crate::backup_ops::create_backup(&connection, &profile).unwrap();
        let hostile = reframe_backup_with(&profile, &backup, "orphan-pending", |candidate| {
            candidate
                .execute(
                    "DELETE FROM ai_run_state WHERE run_id = ?1",
                    [run_id.to_string()],
                )
                .unwrap();
        });
        drop(connection);
        let owner = ProfileOwner::open(&profile).unwrap();
        let repo = owner.repository();
        assert!(matches!(
            repo.prepare_restore(hostile).await,
            Err(RepositoryError::Validation(_))
        ));
        drop(repo);
        drop(owner);
        fs::remove_dir_all(profile).unwrap();
    }

    // Keep every run row independently legal while cross-binding a second approved
    // approval to an awaiting run that is authoritatively bound to another ID.
    {
        let profile = temp_profile();
        let mut connection = open_migrated(&profile);
        let session_id = AiSessionId::new();
        ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();
        let (target_run, target_turn, _) = create_awaiting_approval(&mut connection, session_id);
        let (source_run, _, source_approval) =
            create_awaiting_approval(&mut connection, session_id);
        ai_ops::set_ai_approval_status(
            &mut connection,
            op(),
            source_approval,
            AiApprovalStatus::Approved,
            None,
            now(),
        )
        .unwrap();
        let backup = crate::backup_ops::create_backup(&connection, &profile).unwrap();
        let hostile = reframe_backup_with(&profile, &backup, "cross-bound-approved", |candidate| {
            let (tool_name, arguments_json): (String, String) = candidate
                .query_row(
                    "SELECT tool_name, arguments_json FROM ai_tool_approvals WHERE id = ?1",
                    [source_approval.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            let action_hash = ai_approval_action_hash(&tool_name, &arguments_json).unwrap();
            candidate
                .execute(
                    "UPDATE ai_run_state
                         SET state = 'cancelled', approval_id = NULL
                         WHERE run_id = ?1",
                    [source_run.to_string()],
                )
                .unwrap();
            candidate
                .execute(
                    "UPDATE ai_tool_approvals
                         SET session_id = ?1, turn_id = ?2, run_id = ?3,
                             generation = 1, action_hash = ?4
                         WHERE id = ?5",
                    params![
                        session_id.to_string(),
                        target_turn.to_string(),
                        target_run.to_string(),
                        action_hash,
                        source_approval.to_string(),
                    ],
                )
                .unwrap();
        });
        drop(connection);
        let owner = ProfileOwner::open(&profile).unwrap();
        let repo = owner.repository();
        assert!(matches!(
            repo.prepare_restore(hostile).await,
            Err(RepositoryError::Validation(_))
        ));
        drop(repo);
        drop(owner);
        fs::remove_dir_all(profile).unwrap();
    }

    // Consumed authority is historical only beside its exact dispatching/terminal run.
    {
        let profile = temp_profile();
        let mut connection = open_migrated(&profile);
        let session_id = AiSessionId::new();
        ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();
        let (run_id, _, approval_id) = create_awaiting_approval(&mut connection, session_id);
        ai_ops::set_ai_approval_status(
            &mut connection,
            op(),
            approval_id,
            AiApprovalStatus::Approved,
            None,
            now(),
        )
        .unwrap();
        ai_ops::set_ai_approval_status(
            &mut connection,
            op(),
            approval_id,
            AiApprovalStatus::Consumed,
            Some(op().to_string()),
            now(),
        )
        .unwrap();
        let backup = crate::backup_ops::create_backup(&connection, &profile).unwrap();
        let hostile = reframe_backup_with(&profile, &backup, "orphan-consumed", |candidate| {
            candidate
                .execute(
                    "DELETE FROM ai_run_state WHERE run_id = ?1",
                    [run_id.to_string()],
                )
                .unwrap();
        });
        drop(connection);
        let owner = ProfileOwner::open(&profile).unwrap();
        let repo = owner.repository();
        assert!(matches!(
            repo.prepare_restore(hostile).await,
            Err(RepositoryError::Validation(_))
        ));
        drop(repo);
        drop(owner);
        fs::remove_dir_all(profile).unwrap();
    }
}

#[test]
fn finish_ai_response_quota_failure_rolls_back_before_empty_failed_fallback() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    let turn_id = AiTurnId::new();
    let assistant_message_id = AiMessageId::new();
    let run_id = AiRunId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "quota".into(), now()).unwrap();
    ai_ops::upsert_ai_message(
        &mut connection,
        op(),
        assistant_message_id,
        session_id,
        turn_id,
        AiMessageRole::Assistant,
        AiMessageStatus::Streaming,
        AiMessageContent::text("").unwrap(),
        now(),
    )
    .unwrap();
    ai_ops::upsert_ai_run_state(
        &mut connection,
        op(),
        AiRunState {
            run_id,
            session_id,
            turn_id,
            assistant_message_id,
            generation: 1,
            state: AiRunPhase::Running,
            approval_id: None,
            created_at: now(),
            updated_at: now(),
        },
        now(),
    )
    .unwrap();
    connection
        .execute(
            "UPDATE ai_sessions SET content_bytes = ?1 WHERE id = ?2",
            params![AI_SESSION_CONTENT_BYTES_MAX as i64, session_id.to_string()],
        )
        .unwrap();
    let terminal_operation = op();
    let events_before: i64 = connection
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .unwrap();

    assert!(matches!(
        ai_ops::finish_ai_response(
            &mut connection,
            terminal_operation,
            assistant_message_id,
            session_id,
            turn_id,
            run_id,
            1,
            AiMessageStatus::Completed,
            AiMessageContent::text("would exceed quota").unwrap(),
            AiRunPhase::Completed,
            None,
            now(),
        ),
        Err(RepositoryError::Validation(_))
    ));
    assert_eq!(
        ai_ops::get_ai_message(&connection, assistant_message_id)
            .unwrap()
            .status,
        AiMessageStatus::Streaming
    );
    assert_eq!(
        ai_ops::get_ai_run_state(&connection, run_id).unwrap().state,
        AiRunPhase::Running
    );

    ai_ops::finish_ai_response(
        &mut connection,
        terminal_operation,
        assistant_message_id,
        session_id,
        turn_id,
        run_id,
        1,
        AiMessageStatus::Failed,
        AiMessageContent::text("").unwrap(),
        AiRunPhase::Failed,
        None,
        now(),
    )
    .unwrap();
    let assistant = ai_ops::get_ai_message(&connection, assistant_message_id).unwrap();
    assert_eq!(assistant.status, AiMessageStatus::Failed);
    assert!(assistant.content.text.is_empty());
    assert_eq!(
        ai_ops::get_ai_run_state(&connection, run_id).unwrap().state,
        AiRunPhase::Failed
    );
    let events_after: i64 = connection
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(events_after, events_before + 1);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn normal_open_recovers_all_nonterminal_ai_authority_without_global_mutation() {
    let profile = temp_profile();
    let database_path = profile.join(crate::DATABASE_FILE);
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();

    let (pending_run, _, pending_approval) = create_awaiting_approval(&mut connection, session_id);
    let (approved_run, _, approved_approval) =
        create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approved_approval,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();

    let running_run = AiRunId::new();
    let running_turn = AiTurnId::new();
    let running_assistant = create_assistant_placeholder(&mut connection, session_id, running_turn);
    ai_ops::upsert_ai_run_state(
        &mut connection,
        op(),
        AiRunState {
            run_id: running_run,
            session_id,
            turn_id: running_turn,
            assistant_message_id: running_assistant,
            generation: 1,
            state: AiRunPhase::Running,
            approval_id: None,
            created_at: now(),
            updated_at: now(),
        },
        now(),
    )
    .unwrap();

    let (dispatching_run, _, consumed_approval) =
        create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        consumed_approval,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        consumed_approval,
        AiApprovalStatus::Consumed,
        Some(op().to_string()),
        now(),
    )
    .unwrap();

    assert_ne!(pending_quota(&connection), (0, 0));
    let before_revision = revision(&connection);
    let before_events: i64 = connection
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .unwrap();
    let before_receipts: i64 = connection
        .query_row("SELECT COUNT(*) FROM operation_receipts", [], |row| {
            row.get(0)
        })
        .unwrap();
    drop(connection);

    let connection = crate::open_connection(&database_path).unwrap();
    for approval_id in [pending_approval, approved_approval] {
        assert_eq!(
            ai_ops::get_ai_approval(&connection, approval_id)
                .unwrap()
                .status,
            AiApprovalStatus::Expired
        );
    }
    assert_eq!(
        ai_ops::get_ai_approval(&connection, consumed_approval)
            .unwrap()
            .status,
        AiApprovalStatus::Consumed
    );
    for run_id in [pending_run, approved_run, running_run] {
        let run = ai_ops::get_ai_run_state(&connection, run_id).unwrap();
        assert_eq!(run.state, AiRunPhase::Cancelled);
        assert!(run.approval_id.is_none());
    }
    let dispatching = ai_ops::get_ai_run_state(&connection, dispatching_run).unwrap();
    assert_eq!(dispatching.state, AiRunPhase::Dispatching);
    assert_eq!(dispatching.approval_id, Some(consumed_approval));
    assert_eq!(pending_quota(&connection), (0, 0));
    assert_eq!(revision(&connection), before_revision);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM events", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        before_events
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM operation_receipts", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        before_receipts
    );

    drop(connection);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn terminal_approval_cannot_reopen_and_invalid_dispatch_id_is_rejected() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();
    let (_, _, rejected_id) = create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        rejected_id,
        AiApprovalStatus::Rejected,
        None,
        now(),
    )
    .unwrap();
    let rejected_revision = revision(&connection);
    assert!(matches!(
        ai_ops::set_ai_approval_status(
            &mut connection,
            op(),
            rejected_id,
            AiApprovalStatus::Pending,
            None,
            now(),
        ),
        Err(RepositoryError::Conflict)
    ));
    assert_eq!(revision(&connection), rejected_revision);

    let (_, _, approved_id) = create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approved_id,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();
    let approved_revision = revision(&connection);
    assert!(matches!(
        ai_ops::set_ai_approval_status(
            &mut connection,
            op(),
            approved_id,
            AiApprovalStatus::Consumed,
            Some("not-a-uuid".into()),
            now(),
        ),
        Err(RepositoryError::Validation(_))
    ));
    assert_eq!(
        ai_ops::get_ai_approval(&connection, approved_id)
            .unwrap()
            .status,
        AiApprovalStatus::Approved
    );
    assert_eq!(revision(&connection), approved_revision);
    assert_eq!(pending_quota(&connection), (0, 0));
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn run_state_rejects_stale_generation_and_terminal_reopening() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();
    let run_id = AiRunId::new();
    let turn_id = AiTurnId::new();
    let assistant_message_id = create_assistant_placeholder(&mut connection, session_id, turn_id);
    let state = |generation, phase| AiRunState {
        run_id,
        session_id,
        turn_id,
        assistant_message_id,
        generation,
        state: phase,
        approval_id: None,
        created_at: now(),
        updated_at: now(),
    };
    ai_ops::upsert_ai_run_state(&mut connection, op(), state(2, AiRunPhase::Running), now())
        .unwrap();
    let before_stale = revision(&connection);
    assert!(matches!(
        ai_ops::upsert_ai_run_state(
            &mut connection,
            op(),
            state(1, AiRunPhase::Cancelled),
            now(),
        ),
        Err(RepositoryError::Conflict)
    ));
    assert_eq!(revision(&connection), before_stale);
    ai_ops::upsert_ai_run_state(
        &mut connection,
        op(),
        state(2, AiRunPhase::Completed),
        now(),
    )
    .unwrap();
    let terminal_revision = revision(&connection);
    assert!(matches!(
        ai_ops::upsert_ai_run_state(&mut connection, op(), state(3, AiRunPhase::Running), now()),
        Err(RepositoryError::Conflict)
    ));
    let durable = ai_ops::get_ai_run_state(&connection, run_id).unwrap();
    assert_eq!(durable.generation, 2);
    assert_eq!(durable.state, AiRunPhase::Completed);
    assert_eq!(revision(&connection), terminal_revision);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn newer_generation_expires_bound_authority_and_rejects_dispatch_supersession() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();

    for approve_first in [false, true] {
        let (run_id, turn_id, approval_id) = create_awaiting_approval(&mut connection, session_id);
        if approve_first {
            ai_ops::set_ai_approval_status(
                &mut connection,
                op(),
                approval_id,
                AiApprovalStatus::Approved,
                None,
                now(),
            )
            .unwrap();
        } else {
            assert_ne!(pending_quota(&connection), (0, 0));
        }
        let assistant_message_id = ai_ops::get_ai_run_state(&connection, run_id)
            .unwrap()
            .assistant_message_id;
        ai_ops::upsert_ai_run_state(
            &mut connection,
            op(),
            AiRunState {
                run_id,
                session_id,
                turn_id,
                assistant_message_id,
                generation: 2,
                state: AiRunPhase::Running,
                approval_id: None,
                created_at: now(),
                updated_at: now(),
            },
            now(),
        )
        .unwrap();
        assert_eq!(
            ai_ops::get_ai_approval(&connection, approval_id)
                .unwrap()
                .status,
            AiApprovalStatus::Expired
        );
        let run = ai_ops::get_ai_run_state(&connection, run_id).unwrap();
        assert_eq!(run.generation, 2);
        assert_eq!(run.state, AiRunPhase::Running);
        assert!(run.approval_id.is_none());
        assert_eq!(pending_quota(&connection), (0, 0));
        let before_reuse = revision(&connection);
        assert!(matches!(
            ai_ops::set_ai_approval_status(
                &mut connection,
                op(),
                approval_id,
                AiApprovalStatus::Consumed,
                Some(op().to_string()),
                now(),
            ),
            Err(RepositoryError::Conflict)
        ));
        assert_eq!(revision(&connection), before_reuse);
    }

    let (dispatching_run_id, dispatching_turn_id, dispatching_approval_id) =
        create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        dispatching_approval_id,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        dispatching_approval_id,
        AiApprovalStatus::Consumed,
        Some(op().to_string()),
        now(),
    )
    .unwrap();
    let dispatching_assistant = ai_ops::get_ai_run_state(&connection, dispatching_run_id)
        .unwrap()
        .assistant_message_id;
    let before_dispatch_replacement = revision(&connection);
    assert!(matches!(
        ai_ops::upsert_ai_run_state(
            &mut connection,
            op(),
            AiRunState {
                run_id: dispatching_run_id,
                session_id,
                turn_id: dispatching_turn_id,
                assistant_message_id: dispatching_assistant,
                generation: 2,
                state: AiRunPhase::Running,
                approval_id: None,
                created_at: now(),
                updated_at: now(),
            },
            now(),
        ),
        Err(RepositoryError::Conflict)
    ));
    let dispatching = ai_ops::get_ai_run_state(&connection, dispatching_run_id).unwrap();
    assert_eq!(dispatching.generation, 1);
    assert_eq!(dispatching.state, AiRunPhase::Dispatching);
    assert_eq!(dispatching.approval_id, Some(dispatching_approval_id));
    assert_eq!(
        ai_ops::get_ai_approval(&connection, dispatching_approval_id)
            .unwrap()
            .status,
        AiApprovalStatus::Consumed
    );
    assert_eq!(revision(&connection), before_dispatch_replacement);

    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn run_identity_cannot_move_across_session_or_turn() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let first_session = AiSessionId::new();
    let second_session = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), first_session, "one".into(), now()).unwrap();
    ai_ops::create_ai_session(&mut connection, op(), second_session, "two".into(), now()).unwrap();
    let run_id = AiRunId::new();
    let turn_id = AiTurnId::new();
    let assistant_message_id =
        create_assistant_placeholder(&mut connection, first_session, turn_id);
    let make = |session_id, turn_id| AiRunState {
        run_id,
        session_id,
        turn_id,
        assistant_message_id,
        generation: 1,
        state: AiRunPhase::Running,
        approval_id: None,
        created_at: now(),
        updated_at: now(),
    };
    ai_ops::upsert_ai_run_state(&mut connection, op(), make(first_session, turn_id), now())
        .unwrap();
    let before = revision(&connection);
    assert!(matches!(
        ai_ops::upsert_ai_run_state(&mut connection, op(), make(second_session, turn_id), now()),
        Err(RepositoryError::Conflict)
    ));
    assert!(matches!(
        ai_ops::upsert_ai_run_state(
            &mut connection,
            op(),
            make(first_session, AiTurnId::new()),
            now(),
        ),
        Err(RepositoryError::Conflict)
    ));
    let durable = ai_ops::get_ai_run_state(&connection, run_id).unwrap();
    assert_eq!(durable.session_id, first_session);
    assert_eq!(durable.turn_id, turn_id);
    assert_eq!(revision(&connection), before);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn proposal_cas_failure_rolls_back_approval_quota_and_mutation_material() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "chat".into(), now()).unwrap();
    let run_id = AiRunId::new();
    let turn_id = AiTurnId::new();
    let assistant_message_id = create_assistant_placeholder(&mut connection, session_id, turn_id);
    ai_ops::upsert_ai_run_state(
        &mut connection,
        op(),
        AiRunState {
            run_id,
            session_id,
            turn_id,
            assistant_message_id,
            generation: 1,
            state: AiRunPhase::Running,
            approval_id: None,
            created_at: now(),
            updated_at: now(),
        },
        now(),
    )
    .unwrap();
    let approval_id = AiApprovalId::new();
    let before_revision = revision(&connection);
    let before_quota = pending_quota(&connection);
    let before_events: i64 = connection
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .unwrap();
    let before_receipts: i64 = connection
        .query_row("SELECT COUNT(*) FROM operation_receipts", [], |row| {
            row.get(0)
        })
        .unwrap();

    // The approval insert executes before this CAS against a nonexistent run ID.
    // Transaction rollback must remove every trace of that first step.
    assert!(matches!(
        ai_ops::propose_ai_approval(
            &mut connection,
            op(),
            approval_id,
            session_id,
            turn_id,
            AiRunId::new(),
            1,
            "create_task".into(),
            r#"{"title":"x"}"#.into(),
            now(),
        ),
        Err(RepositoryError::Conflict)
    ));
    assert!(matches!(
        ai_ops::get_ai_approval(&connection, approval_id),
        Err(RepositoryError::NotFound)
    ));
    let run = ai_ops::get_ai_run_state(&connection, run_id).unwrap();
    assert_eq!(run.state, AiRunPhase::Running);
    assert!(run.approval_id.is_none());
    assert_eq!(pending_quota(&connection), before_quota);
    assert_eq!(revision(&connection), before_revision);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM events", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        before_events
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM operation_receipts", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        before_receipts
    );
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn message_id_cannot_move_between_sessions() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let first_session = AiSessionId::new();
    let second_session = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), first_session, "one".into(), now()).unwrap();
    ai_ops::create_ai_session(&mut connection, op(), second_session, "two".into(), now()).unwrap();
    let message_id = AiMessageId::new();
    ai_ops::upsert_ai_message(
        &mut connection,
        op(),
        message_id,
        first_session,
        AiTurnId::new(),
        AiMessageRole::User,
        AiMessageStatus::Completed,
        AiMessageContent::text("first").unwrap(),
        now(),
    )
    .unwrap();
    let before_revision = revision(&connection);
    let before_events: i64 = connection
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .unwrap();
    let before_receipts: i64 = connection
        .query_row("SELECT COUNT(*) FROM operation_receipts", [], |row| {
            row.get(0)
        })
        .unwrap();
    let before_quota: i64 = connection
        .query_row(
            "SELECT total_content_bytes FROM ai_quota WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(matches!(
        ai_ops::upsert_ai_message(
            &mut connection,
            op(),
            message_id,
            second_session,
            AiTurnId::new(),
            AiMessageRole::Assistant,
            AiMessageStatus::Completed,
            AiMessageContent::text("moved").unwrap(),
            now(),
        ),
        Err(RepositoryError::Conflict)
    ));
    assert_eq!(revision(&connection), before_revision);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM events", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        before_events
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM operation_receipts", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        before_receipts
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT total_content_bytes FROM ai_quota WHERE singleton = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        before_quota
    );
    let messages = ai_ops::list_ai_messages(&connection, first_session, None, 10).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].content.text, "first");
    assert!(
        ai_ops::list_ai_messages(&connection, second_session, None, 10)
            .unwrap()
            .is_empty()
    );
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn secret_binding_retry_replays_before_random_publication() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    configure_openai(&mut connection, &profile);
    let operation_id = op();
    let (first, first_id) = settings_ops::bind_ai_credential(
        &mut connection,
        &profile,
        operation_id,
        AiCredentialBindingTarget::AiProvider,
        AiSecretKind::ApiKey,
        Some(AiSecretBytes::new("response-loss-fixture").unwrap()),
        now(),
    )
    .unwrap();
    let first_id = first_id.unwrap();
    let request_json: String = connection
        .query_row(
            "SELECT request_json FROM operation_receipts WHERE operation_id = ?1",
            [operation_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!request_json.contains(&first_id.to_string()));
    assert!(!request_json.contains("response-loss-fixture"));
    let unkeyed = sha256_hex(b"response-loss-fixture");
    assert!(!request_json.contains(&unkeyed));
    let request_value: serde_json::Value = serde_json::from_str(&request_json).unwrap();
    let verifier = request_value["secret_verifier"].as_str().unwrap();
    assert_eq!(verifier.len(), 64);
    assert_ne!(verifier, unkeyed);
    let file_before = fs::read(profile.join(AI_SECRETS_FILE)).unwrap();
    let secret_document: serde_json::Value = serde_json::from_slice(&file_before).unwrap();
    let verification_key = secret_document["verification_key"].as_str().unwrap();
    assert_eq!(verification_key.len(), 64);
    assert!(!request_json.contains(verification_key));
    let revision_before = revision(&connection);
    drop(connection);
    let mut connection = open_migrated(&profile);
    assert_eq!(revision(&connection), revision_before);

    let (replay, replay_id) = settings_ops::bind_ai_credential(
        &mut connection,
        &profile,
        operation_id,
        AiCredentialBindingTarget::AiProvider,
        AiSecretKind::ApiKey,
        Some(AiSecretBytes::new("response-loss-fixture").unwrap()),
        now(),
    )
    .unwrap();
    assert!(first.newly_committed);
    assert!(!replay.newly_committed);
    assert_eq!(replay.event.revision, first.event.revision);
    assert_eq!(replay_id, Some(first_id));
    assert_eq!(revision(&connection), revision_before);
    assert_eq!(
        fs::read(profile.join(AI_SECRETS_FILE)).unwrap(),
        file_before
    );
    assert_eq!(AiSecretStore::load(&profile).unwrap().len_for_test(), 1);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn secret_binding_mismatched_retry_fails_before_file_publication() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    configure_openai(&mut connection, &profile);
    let operation_id = op();
    settings_ops::bind_ai_credential(
        &mut connection,
        &profile,
        operation_id,
        AiCredentialBindingTarget::AiProvider,
        AiSecretKind::ApiKey,
        Some(AiSecretBytes::new("first-request-fixture").unwrap()),
        now(),
    )
    .unwrap();
    let file_before = fs::read(profile.join(AI_SECRETS_FILE)).unwrap();
    let revision_before = revision(&connection);
    assert!(matches!(
        settings_ops::bind_ai_credential(
            &mut connection,
            &profile,
            operation_id,
            AiCredentialBindingTarget::AiProvider,
            AiSecretKind::ApiKey,
            Some(AiSecretBytes::new("different-request-fixture").unwrap()),
            now(),
        ),
        Err(RepositoryError::IdempotencyMismatch)
    ));
    assert_eq!(revision(&connection), revision_before);
    assert_eq!(
        fs::read(profile.join(AI_SECRETS_FILE)).unwrap(),
        file_before
    );
    assert!(matches!(
        settings_ops::clear_ai_credential_binding(
            &mut connection,
            &profile,
            operation_id,
            AiCredentialBindingTarget::AiProvider,
            now(),
        ),
        Err(RepositoryError::IdempotencyMismatch)
    ));
    assert_eq!(revision(&connection), revision_before);
    assert_eq!(
        fs::read(profile.join(AI_SECRETS_FILE)).unwrap(),
        file_before
    );
    assert_eq!(AiSecretStore::load(&profile).unwrap().len_for_test(), 1);
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
    assert!(store.get_secret(&first_id).unwrap().is_some());
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
    assert!(store.get_secret(&first_id).unwrap().is_none());
    assert!(store.get_secret(&second_id).unwrap().is_some());

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
    assert!(store.get_secret(&orphan).unwrap().is_none());

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
            .unwrap()
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
    let _serial = crate::backup_ops::RESTORE_FAULT_TEST_LOCK.lock().await;
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    configure_openai(&mut connection, &profile);
    let bind_operation_id = op();
    let (_mutation, cred) = settings_ops::bind_ai_credential(
        &mut connection,
        &profile,
        bind_operation_id,
        AiCredentialBindingTarget::AiProvider,
        AiSecretKind::ApiKey,
        Some(AiSecretBytes::new("backup-must-not-include").unwrap()),
        now(),
    )
    .unwrap();
    let cred = cred.unwrap();
    let receipt_request: String = connection
        .query_row(
            "SELECT request_json FROM operation_receipts WHERE operation_id = ?1",
            [bind_operation_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    let receipt_value: serde_json::Value = serde_json::from_str(&receipt_request).unwrap();
    let receipt_verifier = receipt_value["secret_verifier"]
        .as_str()
        .unwrap()
        .to_owned();
    let unkeyed_digest = sha256_hex(b"backup-must-not-include");
    assert!(!receipt_request.contains("backup-must-not-include"));
    assert!(!receipt_request.contains(&unkeyed_digest));
    let secret_file = fs::read(profile.join(AI_SECRETS_FILE)).unwrap();
    let secret_document: serde_json::Value = serde_json::from_slice(&secret_file).unwrap();
    let verification_key = secret_document["verification_key"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(!receipt_request.contains(&verification_key));
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
    // The copied SQLite authority retains only the keyed verifier. Without the
    // excluded private key it cannot test an offline guess by hashing that guess.
    assert!(
        backup_bytes
            .windows(receipt_verifier.len())
            .any(|window| window == receipt_verifier.as_bytes())
    );
    assert!(
        !backup_bytes
            .windows(verification_key.len())
            .any(|window| window == verification_key.as_bytes())
    );
    assert!(
        !backup_bytes
            .windows(unkeyed_digest.len())
            .any(|window| window == unkeyed_digest.as_bytes())
    );
    assert!(profile.join(AI_SECRETS_FILE).exists());
    assert!(
        AiSecretStore::load(&profile)
            .unwrap()
            .get_secret(&cred)
            .unwrap()
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
            .unwrap()
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
            .unwrap()
            .is_some()
    );
    drop(repo);
    drop(owner);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn cancel_ai_response_is_atomic_replayable_and_wins_before_dispatch() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    let turn_id = AiTurnId::new();
    let run_id = AiRunId::new();
    let assistant_id = AiMessageId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "cancel".into(), now()).unwrap();
    ai_ops::upsert_ai_message(
        &mut connection,
        op(),
        assistant_id,
        session_id,
        turn_id,
        AiMessageRole::Assistant,
        AiMessageStatus::Streaming,
        AiMessageContent::text("").unwrap(),
        now(),
    )
    .unwrap();
    ai_ops::upsert_ai_run_state(
        &mut connection,
        op(),
        AiRunState {
            run_id,
            session_id,
            turn_id,
            assistant_message_id: assistant_id,
            generation: 3,
            state: AiRunPhase::Running,
            approval_id: None,
            created_at: now(),
            updated_at: now(),
        },
        now(),
    )
    .unwrap();
    let approval_id = AiApprovalId::new();
    ai_ops::propose_ai_approval(
        &mut connection,
        op(),
        approval_id,
        session_id,
        turn_id,
        run_id,
        3,
        "create_task".into(),
        r#"{"title":"x"}"#.into(),
        now(),
    )
    .unwrap();
    let before_mismatch = revision(&connection);
    assert!(matches!(
        ai_ops::cancel_ai_response(
            &mut connection,
            op(),
            assistant_id,
            session_id,
            AiTurnId::new(),
            run_id,
            3,
            AiMessageContent::text("").unwrap(),
            now()
        ),
        Err(RepositoryError::Conflict)
    ));
    assert_eq!(revision(&connection), before_mismatch);
    let operation_id = op();
    let committed = ai_ops::cancel_ai_response(
        &mut connection,
        operation_id,
        assistant_id,
        session_id,
        turn_id,
        run_id,
        3,
        AiMessageContent::text("").unwrap(),
        now(),
    )
    .unwrap();
    assert!(committed.newly_committed);
    assert_eq!(
        ai_ops::get_ai_message(&connection, assistant_id)
            .unwrap()
            .status,
        AiMessageStatus::Cancelled
    );
    assert_eq!(
        ai_ops::get_ai_run_state(&connection, run_id).unwrap().state,
        AiRunPhase::Cancelled
    );
    assert_eq!(
        ai_ops::get_ai_approval(&connection, approval_id)
            .unwrap()
            .status,
        AiApprovalStatus::Expired
    );
    assert_eq!(pending_quota(&connection), (0, 0));
    assert!(
        !ai_ops::cancel_ai_response(
            &mut connection,
            operation_id,
            assistant_id,
            session_id,
            turn_id,
            run_id,
            3,
            AiMessageContent::text("").unwrap(),
            now()
        )
        .unwrap()
        .newly_committed
    );
    assert!(matches!(
        ai_ops::cancel_ai_response(
            &mut connection,
            operation_id,
            assistant_id,
            session_id,
            AiTurnId::new(),
            run_id,
            3,
            AiMessageContent::text("").unwrap(),
            now()
        ),
        Err(RepositoryError::IdempotencyMismatch)
    ));
    assert!(matches!(
        ai_ops::set_ai_approval_status(
            &mut connection,
            op(),
            approval_id,
            AiApprovalStatus::Consumed,
            Some(op().to_string()),
            now()
        ),
        Err(RepositoryError::Conflict)
    ));
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn dispatching_finish_requires_exact_consumed_operation_and_replays() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    let turn_id = AiTurnId::new();
    let run_id = AiRunId::new();
    let assistant_id = AiMessageId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "dispatch".into(), now()).unwrap();
    ai_ops::upsert_ai_message(
        &mut connection,
        op(),
        assistant_id,
        session_id,
        turn_id,
        AiMessageRole::Assistant,
        AiMessageStatus::Streaming,
        AiMessageContent::text("").unwrap(),
        now(),
    )
    .unwrap();
    ai_ops::upsert_ai_run_state(
        &mut connection,
        op(),
        AiRunState {
            run_id,
            session_id,
            turn_id,
            assistant_message_id: assistant_id,
            generation: 1,
            state: AiRunPhase::Running,
            approval_id: None,
            created_at: now(),
            updated_at: now(),
        },
        now(),
    )
    .unwrap();
    let approval_id = AiApprovalId::new();
    ai_ops::propose_ai_approval(
        &mut connection,
        op(),
        approval_id,
        session_id,
        turn_id,
        run_id,
        1,
        "create_task".into(),
        r#"{"title":"x"}"#.into(),
        now(),
    )
    .unwrap();
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approval_id,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();
    let dispatch = op();
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approval_id,
        AiApprovalStatus::Consumed,
        Some(dispatch.to_string()),
        now(),
    )
    .unwrap();
    assert_eq!(
        ai_ops::list_dispatching_ai_approvals(&connection).unwrap()[0].id,
        approval_id
    );
    let completed_content =
        dispatch_result_content(&connection, assistant_id, "create_task", "success");
    assert!(matches!(
        ai_ops::cancel_ai_response(
            &mut connection,
            op(),
            assistant_id,
            session_id,
            turn_id,
            run_id,
            1,
            AiMessageContent::text("").unwrap(),
            now()
        ),
        Err(RepositoryError::Conflict)
    ));
    assert!(matches!(
        ai_ops::finish_ai_response(
            &mut connection,
            op(),
            assistant_id,
            session_id,
            turn_id,
            run_id,
            1,
            AiMessageStatus::Completed,
            completed_content.clone(),
            AiRunPhase::Completed,
            Some(op().to_string()),
            now()
        ),
        Err(RepositoryError::Conflict)
    ));
    let finish_op = op();
    let committed = ai_ops::finish_ai_response(
        &mut connection,
        finish_op,
        assistant_id,
        session_id,
        turn_id,
        run_id,
        1,
        AiMessageStatus::Completed,
        completed_content.clone(),
        AiRunPhase::Completed,
        Some(dispatch.to_string()),
        now(),
    )
    .unwrap();
    assert!(committed.newly_committed);
    assert!(
        !ai_ops::finish_ai_response(
            &mut connection,
            finish_op,
            assistant_id,
            session_id,
            turn_id,
            run_id,
            1,
            AiMessageStatus::Completed,
            completed_content,
            AiRunPhase::Completed,
            Some(dispatch.to_string()),
            now()
        )
        .unwrap()
        .newly_committed
    );
    assert!(matches!(
        ai_ops::finish_ai_response(
            &mut connection,
            finish_op,
            assistant_id,
            session_id,
            turn_id,
            run_id,
            1,
            AiMessageStatus::Failed,
            AiMessageContent::text("").unwrap(),
            AiRunPhase::Failed,
            Some(dispatch.to_string()),
            now()
        ),
        Err(RepositoryError::IdempotencyMismatch)
    ));
    assert!(
        ai_ops::list_dispatching_ai_approvals(&connection)
            .unwrap()
            .is_empty()
    );

    let failed_turn = AiTurnId::new();
    let failed_run = AiRunId::new();
    let failed_assistant = AiMessageId::new();
    ai_ops::upsert_ai_message(
        &mut connection,
        op(),
        failed_assistant,
        session_id,
        failed_turn,
        AiMessageRole::Assistant,
        AiMessageStatus::Streaming,
        AiMessageContent::text("").unwrap(),
        now(),
    )
    .unwrap();
    ai_ops::upsert_ai_run_state(
        &mut connection,
        op(),
        AiRunState {
            run_id: failed_run,
            session_id,
            turn_id: failed_turn,
            assistant_message_id: failed_assistant,
            generation: 1,
            state: AiRunPhase::Running,
            approval_id: None,
            created_at: now(),
            updated_at: now(),
        },
        now(),
    )
    .unwrap();
    let failed_approval = AiApprovalId::new();
    ai_ops::propose_ai_approval(
        &mut connection,
        op(),
        failed_approval,
        session_id,
        failed_turn,
        failed_run,
        1,
        "create_task".into(),
        r#"{"title":"y"}"#.into(),
        now(),
    )
    .unwrap();
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        failed_approval,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();
    let failed_dispatch = op();
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        failed_approval,
        AiApprovalStatus::Consumed,
        Some(failed_dispatch.to_string()),
        now(),
    )
    .unwrap();
    let failed_content =
        dispatch_result_content(&connection, failed_assistant, "create_task", "error");
    ai_ops::finish_ai_response(
        &mut connection,
        op(),
        failed_assistant,
        session_id,
        failed_turn,
        failed_run,
        1,
        AiMessageStatus::Failed,
        failed_content,
        AiRunPhase::Failed,
        Some(failed_dispatch.to_string()),
        now(),
    )
    .unwrap();
    assert_eq!(
        ai_ops::get_ai_run_state(&connection, failed_run)
            .unwrap()
            .state,
        AiRunPhase::Failed
    );
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn normal_open_atomically_terminalizes_streaming_placeholders_and_fails_closed_on_corrupt_pair()
 {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "recover".into(), now()).unwrap();
    let mut rows = Vec::new();
    for awaiting in [false, true] {
        let turn_id = AiTurnId::new();
        let run_id = AiRunId::new();
        let message_id = AiMessageId::new();
        ai_ops::upsert_ai_message(
            &mut connection,
            op(),
            message_id,
            session_id,
            turn_id,
            AiMessageRole::Assistant,
            AiMessageStatus::Streaming,
            AiMessageContent::text("").unwrap(),
            now(),
        )
        .unwrap();
        ai_ops::upsert_ai_run_state(
            &mut connection,
            op(),
            AiRunState {
                run_id,
                session_id,
                turn_id,
                assistant_message_id: message_id,
                generation: 1,
                state: AiRunPhase::Running,
                approval_id: None,
                created_at: now(),
                updated_at: now(),
            },
            now(),
        )
        .unwrap();
        let approval = if awaiting {
            let id = AiApprovalId::new();
            ai_ops::propose_ai_approval(
                &mut connection,
                op(),
                id,
                session_id,
                turn_id,
                run_id,
                1,
                "create_task".into(),
                r#"{"title":"x"}"#.into(),
                now(),
            )
            .unwrap();
            Some(id)
        } else {
            None
        };
        rows.push((run_id, message_id, approval));
    }
    drop(connection);
    let owner = ProfileOwner::open(&profile).unwrap();
    let repo = owner.repository();
    for (run_id, message_id, approval) in rows {
        assert_eq!(
            repo.get_ai_run_state(run_id).await.unwrap().state,
            AiRunPhase::Cancelled
        );
        assert_eq!(
            repo.get_ai_message(message_id).await.unwrap().status,
            AiMessageStatus::Cancelled
        );
        if let Some(id) = approval {
            assert_eq!(
                repo.get_ai_approval(id).await.unwrap().status,
                AiApprovalStatus::Expired
            );
        }
    }
    drop(repo);
    drop(owner);

    let mut connection = Connection::open(profile.join(crate::DATABASE_FILE)).unwrap();
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    let recovered_times: (String, String, String) = connection
        .query_row(
            "SELECT updated_at, last_message_at,
                    (SELECT MAX(updated_at) FROM ai_messages WHERE session_id = ?1)
             FROM ai_sessions WHERE id = ?1",
            [session_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(recovered_times.0, recovered_times.2);
    assert_eq!(recovered_times.1, recovered_times.2);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "corrupt".into(), now()).unwrap();
    let (run_id, _, approval_id) = create_awaiting_approval(&mut connection, session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approval_id,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approval_id,
        AiApprovalStatus::Consumed,
        Some(op().to_string()),
        now(),
    )
    .unwrap();
    connection
        .execute(
            "UPDATE ai_tool_approvals SET generation = 2 WHERE id = ?1",
            [approval_id.to_string()],
        )
        .unwrap();
    drop(connection);
    assert!(matches!(
        ProfileOwner::open(&profile),
        Err(crate::OpenError::Database(_))
    ));
    let connection = Connection::open(profile.join(crate::DATABASE_FILE)).unwrap();
    assert_eq!(
        ai_ops::get_ai_run_state(&connection, run_id).unwrap().state,
        AiRunPhase::Dispatching
    );
    fs::remove_dir_all(profile).unwrap();
}

fn insert_dispatching_fixture(
    connection: &Connection,
    session_id: AiSessionId,
    sequence: i64,
) -> (AiRunId, AiTurnId, AiMessageId, AiApprovalId) {
    let turn_id = AiTurnId::new();
    let run_id = AiRunId::new();
    let assistant_message_id = AiMessageId::new();
    let approval_id = AiApprovalId::new();
    let dispatch_operation_id = op();
    let arguments_json = "{}";
    let action_hash = ai_approval_action_hash("create_task", arguments_json).unwrap();
    let created_at = now();
    let expires_at = created_at + junban_domain::AI_APPROVAL_LIFETIME_SECS.seconds();
    let mut content = AiMessageContent::text("").unwrap();
    content.tool_name = Some("create_task".into());
    content.tool_arguments_json = Some(arguments_json.into());
    content.tool_events.push(
        AiToolEvent::new(
            0,
            AiToolEventType::ToolProposed,
            json!({
                "approval_id": approval_id.to_string(),
                "tool": "create_task",
                "arguments": {},
                "action_hash": action_hash.clone(),
                "expires_at": expires_at,
            }),
        )
        .unwrap(),
    );
    content.tool_events.push(
        AiToolEvent::new(
            0,
            AiToolEventType::ToolApproved,
            json!({"approval_id": approval_id.to_string()}),
        )
        .unwrap(),
    );
    let content_json = content.canonical_json().unwrap();
    connection
        .execute(
            "INSERT INTO ai_messages(
                id, session_id, turn_id, sequence, role, status, content_json,
                content_bytes, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'assistant', 'streaming', ?5, ?6, ?7, ?7)",
            params![
                assistant_message_id.to_string(),
                session_id.to_string(),
                turn_id.to_string(),
                sequence,
                content_json,
                content_json.len() as i64,
                created_at.to_string(),
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO ai_tool_approvals(
                id, session_id, turn_id, run_id, generation, tool_name, arguments_json,
                arguments_bytes, action_hash, status, expires_at, operation_id,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 1, 'create_task', ?5, ?6, ?7,
                       'consumed', ?8, ?9, ?10, ?10)",
            params![
                approval_id.to_string(),
                session_id.to_string(),
                turn_id.to_string(),
                run_id.to_string(),
                arguments_json,
                arguments_json.len() as i64,
                action_hash,
                expires_at.to_string(),
                dispatch_operation_id.to_string(),
                created_at.to_string(),
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO ai_run_state(
                run_id, session_id, turn_id, assistant_message_id, generation, state,
                approval_id, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 1, 'dispatching', ?5, ?6, ?6)",
            params![
                run_id.to_string(),
                session_id.to_string(),
                turn_id.to_string(),
                assistant_message_id.to_string(),
                approval_id.to_string(),
                created_at.to_string(),
            ],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE ai_sessions
             SET message_count = message_count + 1,
                 content_bytes = content_bytes + ?1,
                 updated_at = ?2,
                 last_message_at = ?2
             WHERE id = ?3",
            params![
                content_json.len() as i64,
                created_at.to_string(),
                session_id.to_string(),
            ],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE ai_quota SET total_content_bytes = total_content_bytes + ?1
             WHERE singleton = 1",
            [content_json.len() as i64],
        )
        .unwrap();
    (run_id, turn_id, assistant_message_id, approval_id)
}

#[test]
fn run_assistant_binding_is_exact_and_startup_only_terminalizes_bound_placeholders() {
    let profile = temp_profile();
    let database_path = profile.join(crate::DATABASE_FILE);
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    let turn_id = AiTurnId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "binding".into(), now()).unwrap();

    let first_assistant = create_assistant_placeholder(&mut connection, session_id, turn_id);
    let second_assistant = create_assistant_placeholder(&mut connection, session_id, turn_id);
    let unrelated_assistant = create_assistant_placeholder(&mut connection, session_id, turn_id);
    let first_run = AiRunId::new();
    let second_run = AiRunId::new();
    for (run_id, assistant_message_id) in
        [(first_run, first_assistant), (second_run, second_assistant)]
    {
        ai_ops::upsert_ai_run_state(
            &mut connection,
            op(),
            AiRunState {
                run_id,
                session_id,
                turn_id,
                assistant_message_id,
                generation: 1,
                state: AiRunPhase::Running,
                approval_id: None,
                created_at: now(),
                updated_at: now(),
            },
            now(),
        )
        .unwrap();
    }

    let before = revision(&connection);
    assert!(matches!(
        ai_ops::finish_ai_response(
            &mut connection,
            op(),
            second_assistant,
            session_id,
            turn_id,
            first_run,
            1,
            AiMessageStatus::Completed,
            AiMessageContent::text("wrong assistant").unwrap(),
            AiRunPhase::Completed,
            None,
            now(),
        ),
        Err(RepositoryError::Conflict)
    ));
    assert_eq!(revision(&connection), before);
    drop(connection);

    let connection = crate::open_connection(&database_path).unwrap();
    for (run_id, assistant_message_id) in
        [(first_run, first_assistant), (second_run, second_assistant)]
    {
        let run = ai_ops::get_ai_run_state(&connection, run_id).unwrap();
        assert_eq!(run.assistant_message_id, assistant_message_id);
        assert_eq!(run.state, AiRunPhase::Cancelled);
        assert_eq!(
            ai_ops::get_ai_message(&connection, assistant_message_id)
                .unwrap()
                .status,
            AiMessageStatus::Cancelled
        );
    }
    assert_eq!(
        ai_ops::get_ai_message(&connection, unrelated_assistant)
            .unwrap()
            .status,
        AiMessageStatus::Streaming,
        "startup must not terminalize every assistant in a shared turn"
    );
    drop(connection);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn dispatch_recovery_accepts_500_and_rejects_501st_consume_atomically() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(
        &mut connection,
        op(),
        session_id,
        "dispatch cap".into(),
        now(),
    )
    .unwrap();
    for sequence in 1..=junban_domain::AI_DISPATCHING_APPROVAL_RECOVERY_MAX {
        insert_dispatching_fixture(&connection, session_id, i64::from(sequence));
    }
    assert_eq!(
        ai_ops::list_dispatching_ai_approvals(&connection)
            .unwrap()
            .len(),
        junban_domain::AI_DISPATCHING_APPROVAL_RECOVERY_MAX as usize
    );

    let overflow_session_id = AiSessionId::new();
    ai_ops::create_ai_session(
        &mut connection,
        op(),
        overflow_session_id,
        "overflow".into(),
        now(),
    )
    .unwrap();
    let (run_id, _, approval_id) = create_awaiting_approval(&mut connection, overflow_session_id);
    ai_ops::set_ai_approval_status(
        &mut connection,
        op(),
        approval_id,
        AiApprovalStatus::Approved,
        None,
        now(),
    )
    .unwrap();
    let before_revision = revision(&connection);
    let before_quota = pending_quota(&connection);
    assert!(matches!(
        ai_ops::set_ai_approval_status(
            &mut connection,
            op(),
            approval_id,
            AiApprovalStatus::Consumed,
            Some(op().to_string()),
            now(),
        ),
        Err(RepositoryError::Validation(_))
    ));
    assert_eq!(revision(&connection), before_revision);
    assert_eq!(pending_quota(&connection), before_quota);
    assert_eq!(
        ai_ops::get_ai_approval(&connection, approval_id)
            .unwrap()
            .status,
        AiApprovalStatus::Approved
    );
    assert_eq!(
        ai_ops::get_ai_run_state(&connection, run_id).unwrap().state,
        AiRunPhase::AwaitingApproval
    );
    assert_eq!(
        ai_ops::list_dispatching_ai_approvals(&connection)
            .unwrap()
            .len(),
        junban_domain::AI_DISPATCHING_APPROVAL_RECOVERY_MAX as usize
    );
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn forged_501st_dispatch_pair_fails_normal_open_closed() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(
        &mut connection,
        op(),
        session_id,
        "forged cap".into(),
        now(),
    )
    .unwrap();
    for sequence in 1..=junban_domain::AI_DISPATCHING_APPROVAL_RECOVERY_MAX {
        insert_dispatching_fixture(&connection, session_id, i64::from(sequence));
    }
    let overflow_session_id = AiSessionId::new();
    ai_ops::create_ai_session(
        &mut connection,
        op(),
        overflow_session_id,
        "overflow".into(),
        now(),
    )
    .unwrap();
    insert_dispatching_fixture(&connection, overflow_session_id, 1);
    drop(connection);
    assert!(matches!(
        ProfileOwner::open(&profile),
        Err(crate::OpenError::Database(_))
    ));
    let connection = Connection::open(profile.join(crate::DATABASE_FILE)).unwrap();
    let dispatching: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM ai_run_state WHERE state = 'dispatching'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        dispatching,
        i64::from(junban_domain::AI_DISPATCHING_APPROVAL_RECOVERY_MAX + 1),
        "failed normal open must not partially terminalize over-limit authority"
    );
    drop(connection);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn stale_consumed_action_hash_fails_listing_and_normal_open_closed() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(&mut connection, op(), session_id, "hash".into(), now()).unwrap();
    let (_, _, _, approval_id) = insert_dispatching_fixture(&connection, session_id, 1);
    connection
        .execute(
            "UPDATE ai_tool_approvals
             SET arguments_json = '{\"title\":\"mutated\"}', arguments_bytes = 19
             WHERE id = ?1",
            [approval_id.to_string()],
        )
        .unwrap();
    assert!(matches!(
        ai_ops::list_dispatching_ai_approvals(&connection),
        Err(RepositoryError::Storage(_))
    ));
    drop(connection);
    assert!(matches!(
        ProfileOwner::open(&profile),
        Err(crate::OpenError::Database(_))
    ));
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn restore_preflight_rejects_501st_dispatch_recovery_pair() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    let overflow_session_id = AiSessionId::new();
    ai_ops::create_ai_session(
        &mut connection,
        op(),
        session_id,
        "restore cap".into(),
        now(),
    )
    .unwrap();
    ai_ops::create_ai_session(
        &mut connection,
        op(),
        overflow_session_id,
        "overflow".into(),
        now(),
    )
    .unwrap();
    for sequence in 1..=junban_domain::AI_DISPATCHING_APPROVAL_RECOVERY_MAX {
        insert_dispatching_fixture(&connection, session_id, i64::from(sequence));
    }
    let before_revision = revision(&connection);
    let backup = crate::backup_ops::create_backup(&connection, &profile).unwrap();
    let hostile = reframe_backup_with(&profile, &backup, "dispatch-overflow", |candidate| {
        insert_dispatching_fixture(candidate, overflow_session_id, 1);
    });
    drop(connection);
    let owner = ProfileOwner::open(&profile).unwrap();
    let repo = owner.repository();
    assert!(matches!(
        repo.prepare_restore(hostile).await,
        Err(RepositoryError::Validation(_))
    ));
    assert_eq!(
        repo.get_sync_state().await.unwrap().revision,
        u64::try_from(before_revision).unwrap()
    );
    assert_eq!(
        repo.list_dispatching_ai_approvals().await.unwrap().len(),
        junban_domain::AI_DISPATCHING_APPROVAL_RECOVERY_MAX as usize
    );
    drop(repo);
    drop(owner);
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn restore_preflight_rejects_mutated_consumed_arguments_with_stale_hash() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(
        &mut connection,
        op(),
        session_id,
        "restore hash".into(),
        now(),
    )
    .unwrap();
    let (_, _, _, approval_id) = insert_dispatching_fixture(&connection, session_id, 1);
    let backup = crate::backup_ops::create_backup(&connection, &profile).unwrap();
    let hostile = reframe_backup_with(&profile, &backup, "stale-action-hash", |candidate| {
        candidate
            .execute(
                "UPDATE ai_tool_approvals
                 SET arguments_json = '{\"title\":\"mutated\"}', arguments_bytes = 19
                 WHERE id = ?1",
                [approval_id.to_string()],
            )
            .unwrap();
    });
    drop(connection);
    let owner = ProfileOwner::open(&profile).unwrap();
    let repo = owner.repository();
    assert!(matches!(
        repo.prepare_restore(hostile).await,
        Err(RepositoryError::Validation(_))
    ));
    drop(repo);
    drop(owner);
    fs::remove_dir_all(profile).unwrap();
}

#[test]
fn normal_open_rejects_unknown_private_and_mismatched_tool_events() {
    for rewrite in 0_u8..3 {
        let profile = temp_profile();
        let mut connection = open_migrated(&profile);
        let session_id = AiSessionId::new();
        ai_ops::create_ai_session(
            &mut connection,
            op(),
            session_id,
            "semantic open".into(),
            now(),
        )
        .unwrap();
        let (run_id, turn_id, assistant_message_id, approval_id) =
            insert_dispatching_fixture(&connection, session_id, 1);
        let approval = ai_ops::get_ai_approval(&connection, approval_id).unwrap();
        let dispatch = OperationId::parse(approval.operation_id.as_deref().unwrap()).unwrap();
        let content =
            dispatch_result_content(&connection, assistant_message_id, "create_task", "success");
        ai_ops::finish_ai_response(
            &mut connection,
            op(),
            assistant_message_id,
            session_id,
            turn_id,
            run_id,
            1,
            AiMessageStatus::Completed,
            content,
            AiRunPhase::Completed,
            Some(dispatch.to_string()),
            now(),
        )
        .unwrap();
        let raw: String = connection
            .query_row(
                "SELECT content_json FROM ai_messages WHERE id = ?1",
                [assistant_message_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        let mut content: serde_json::Value = serde_json::from_str(&raw).unwrap();
        match rewrite {
            0 => content["tool_events"][1]["payload"]["unknown"] = json!(true),
            1 => {
                content["tool_events"][2]["payload"]["data"]["nested"] =
                    json!([{"provider_call_id": "private"}]);
            }
            2 => {
                content["tool_events"][1]["payload"]["approval_id"] =
                    json!(AiApprovalId::new().to_string());
            }
            _ => unreachable!(),
        }
        let content = serde_json::to_string(&content).unwrap();
        connection
            .execute(
                "UPDATE ai_messages SET content_json = ?1, content_bytes = ?2 WHERE id = ?3",
                params![
                    content,
                    content.len() as i64,
                    assistant_message_id.to_string()
                ],
            )
            .unwrap();
        drop(connection);

        assert!(matches!(
            ProfileOwner::open(&profile),
            Err(crate::OpenError::Database(_))
        ));
        fs::remove_dir_all(profile).unwrap();
    }
}

#[tokio::test]
async fn restore_preflight_rejects_unknown_and_private_tool_event_fields() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(
        &mut connection,
        op(),
        session_id,
        "semantic restore".into(),
        now(),
    )
    .unwrap();
    let (run_id, turn_id, assistant_message_id, approval_id) =
        insert_dispatching_fixture(&connection, session_id, 1);
    let approval = ai_ops::get_ai_approval(&connection, approval_id).unwrap();
    let dispatch = OperationId::parse(approval.operation_id.as_deref().unwrap()).unwrap();
    let content =
        dispatch_result_content(&connection, assistant_message_id, "create_task", "success");
    ai_ops::finish_ai_response(
        &mut connection,
        op(),
        assistant_message_id,
        session_id,
        turn_id,
        run_id,
        1,
        AiMessageStatus::Completed,
        content,
        AiRunPhase::Completed,
        Some(dispatch.to_string()),
        now(),
    )
    .unwrap();
    let backup = crate::backup_ops::create_backup(&connection, &profile).unwrap();
    drop(connection);
    let owner = ProfileOwner::open(&profile).unwrap();
    let repo = owner.repository();

    for (label, rewrite) in [
        ("unknown-approved-field", 0_u8),
        ("private-result-field", 1_u8),
        ("mismatched-approved-card", 2_u8),
    ] {
        let hostile = reframe_backup_with(&profile, &backup, label, |candidate| {
            let raw: String = candidate
                .query_row(
                    "SELECT content_json FROM ai_messages WHERE id = ?1",
                    [assistant_message_id.to_string()],
                    |row| row.get(0),
                )
                .unwrap();
            let mut content: serde_json::Value = serde_json::from_str(&raw).unwrap();
            match rewrite {
                0 => content["tool_events"][1]["payload"]["unknown"] = json!(true),
                1 => {
                    content["tool_events"][2]["payload"]["data"]["nested"] =
                        json!([{"raw_body": "private"}]);
                }
                2 => {
                    content["tool_events"][1]["payload"]["approval_id"] =
                        json!(AiApprovalId::new().to_string());
                }
                _ => unreachable!(),
            }
            let content = serde_json::to_string(&content).unwrap();
            candidate
                .execute(
                    "UPDATE ai_messages SET content_json = ?1, content_bytes = ?2 WHERE id = ?3",
                    params![
                        content,
                        content.len() as i64,
                        assistant_message_id.to_string()
                    ],
                )
                .unwrap();
            ai_ops::recompute_ai_quotas(candidate).unwrap();
        });
        assert!(
            repo.prepare_restore(hostile).await.is_err(),
            "{label} reached restore cutover"
        );
    }

    drop(repo);
    drop(owner);
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn restore_preflight_centrally_rejects_every_malformed_consumed_approval_field_class() {
    let profile = temp_profile();
    let mut connection = open_migrated(&profile);
    let session_id = AiSessionId::new();
    ai_ops::create_ai_session(
        &mut connection,
        op(),
        session_id,
        "approval rows".into(),
        now(),
    )
    .unwrap();
    insert_dispatching_fixture(&connection, session_id, 1);
    let backup = crate::backup_ops::create_backup(&connection, &profile).unwrap();
    drop(connection);
    let owner = ProfileOwner::open(&profile).unwrap();
    let repo = owner.repository();
    let attacks = [
        (
            "id",
            "PRAGMA foreign_keys=OFF;
             UPDATE ai_tool_approvals SET id = 'not-a-uuid';",
        ),
        (
            "status",
            "PRAGMA ignore_check_constraints=ON;
             UPDATE ai_tool_approvals SET status = 'unknown';",
        ),
        (
            "utf8",
            "UPDATE ai_tool_approvals SET tool_name = CAST(X'80' AS TEXT);",
        ),
        (
            "arguments-shape",
            "UPDATE ai_tool_approvals SET arguments_json = '[]', arguments_bytes = 2;",
        ),
        (
            "arguments-canonical",
            "UPDATE ai_tool_approvals
             SET arguments_json = '{ \"title\": \"x\" }', arguments_bytes = 16;",
        ),
        (
            "tool-name",
            "UPDATE ai_tool_approvals SET tool_name = 'CreateTask';",
        ),
        (
            "timestamp",
            "UPDATE ai_tool_approvals SET updated_at = 'not-a-timestamp';",
        ),
        (
            "expiry",
            "UPDATE ai_tool_approvals SET expires_at = created_at;",
        ),
        (
            "operation-id",
            "UPDATE ai_tool_approvals SET operation_id = 'not-an-operation';",
        ),
        (
            "action-hash",
            "UPDATE ai_tool_approvals
             SET action_hash = '0000000000000000000000000000000000000000000000000000000000000000';",
        ),
    ];
    for (label, attack) in attacks {
        let hostile = reframe_backup_with(&profile, &backup, label, |candidate| {
            candidate.execute_batch(attack).unwrap();
        });
        assert!(
            matches!(
                repo.prepare_restore(hostile).await,
                Err(RepositoryError::Validation(_))
            ),
            "malformed consumed approval field reached authority: {label}"
        );
    }
    drop(repo);
    drop(owner);
    fs::remove_dir_all(profile).unwrap();
}
