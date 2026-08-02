//! Focused Phase 6 Wave 3a service/repository AI wiring tests.

use std::{
    collections::BTreeSet,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use jiff::Timestamp;
use junban_app::{
    AiCredentialBindingTarget, AiSecretBytes, BindAiCredentialRequest, ClearAiCredentialRequest,
    ClearAiSessionRequest, CommittedEvent, CreateAiMemoryRequest, CreateAiSessionRequest,
    EventSink, EventType, JunbanService, LinkAiSessionMemoryRequest, ListAiMemoriesRequest,
    ListAiSessionsRequest, ProposeAiApprovalRequest, SelectAiMemoriesRequest,
    SetAiApprovalStatusRequest, UpsertAiMessageRequest, UpsertAiRunStateRequest,
};
use junban_domain::{
    AI_CONTEXT_MEMORIES_MAX, AI_SECRETS_FILE, AiApprovalId, AiApprovalStatus, AiMemoryId,
    AiMessageContent, AiMessageId, AiMessageRole, AiMessageStatus, AiProviderPreset, AiRunId,
    AiRunPhase, AiRunState, AiSecretKind, AiSessionId, AiTurnId, OperationId, ProviderBaseUrl,
    SettingsPatch,
};
use uuid::Uuid;

use crate::{AiSecretStore, ProfileOwner, SqliteRepository};

fn temp_profile() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "junban-wave3a-{}-{}",
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

#[derive(Default)]
struct RecordingSink(Mutex<Vec<CommittedEvent>>);

impl EventSink for RecordingSink {
    fn publish(&self, event: CommittedEvent) {
        self.0.lock().unwrap().push(event);
    }
}

fn open_service(
    profile: &std::path::Path,
) -> (
    ProfileOwner,
    JunbanService<SqliteRepository, RecordingSink>,
    Arc<RecordingSink>,
) {
    let owner = ProfileOwner::open(profile).unwrap();
    let repo = Arc::new(owner.repository());
    let sink = Arc::new(RecordingSink::default());
    let service = JunbanService::new(repo, Arc::clone(&sink));
    (owner, service, sink)
}

async fn configure_openai(service: &JunbanService<SqliteRepository, RecordingSink>) {
    let mut settings = service.get_settings().await.unwrap();
    settings.ai.provider = Some(AiProviderPreset::OpenAi);
    settings.ai.base_url = Some(
        ProviderBaseUrl::for_provider(AiProviderPreset::OpenAi, "https://api.openai.com/v1")
            .unwrap(),
    );
    service
        .patch_settings(
            op(),
            SettingsPatch {
                ai: Some(settings.ai),
                ..SettingsPatch::default()
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn service_ai_session_publishes_once_and_receipt_replay_does_not() {
    let profile = temp_profile();
    let (owner, service, sink) = open_service(&profile);
    let operation_id = op();
    let first = service
        .create_ai_session(
            operation_id,
            CreateAiSessionRequest {
                title: "Wave 3a".into(),
            },
        )
        .await
        .unwrap();
    assert!(first.newly_committed);
    assert_eq!(
        first.event.event_type.as_str(),
        EventType::AI_SESSION_CHANGED
    );
    assert_eq!(sink.0.lock().unwrap().len(), 1);
    let original_id = first
        .event
        .primary
        .as_ref()
        .expect("session primary")
        .id
        .clone();

    let replay = service
        .create_ai_session(
            operation_id,
            CreateAiSessionRequest {
                title: "Wave 3a".into(),
            },
        )
        .await
        .unwrap();
    assert!(!replay.newly_committed);
    assert_eq!(replay.event, first.event);
    assert_eq!(
        replay.event.primary.as_ref().map(|p| p.id.as_str()),
        Some(original_id.as_str())
    );
    assert_eq!(sink.0.lock().unwrap().len(), 1);

    drop(service);
    drop(sink);
    drop(owner);
    let connection = rusqlite::Connection::open(profile.join("junban.sqlite3")).unwrap();
    let undo_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM operation_undo WHERE source_operation_id = ?1",
            [operation_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(undo_count, 0);
    let session_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM ai_sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(session_count, 1);
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn create_ai_session_exact_retry_survives_reopen_and_rejects_mismatched_title() {
    let profile = temp_profile();
    let operation_id = op();
    let original_id;
    let original_event;
    {
        let (owner, service, sink) = open_service(&profile);
        let first = service
            .create_ai_session(
                operation_id,
                CreateAiSessionRequest {
                    title: "Stable session".into(),
                },
            )
            .await
            .unwrap();
        assert!(first.newly_committed);
        original_id = first
            .event
            .primary
            .as_ref()
            .expect("session primary")
            .id
            .clone();
        original_event = first.event.clone();
        assert_eq!(sink.0.lock().unwrap().len(), 1);
        drop(service);
        drop(sink);
        drop(owner);
    }

    // Drop/reopen profile owner: retry with same operation + user input must replay.
    let (owner, service, sink) = open_service(&profile);
    let replay = service
        .create_ai_session(
            operation_id,
            CreateAiSessionRequest {
                title: "Stable session".into(),
            },
        )
        .await
        .unwrap();
    assert!(!replay.newly_committed);
    assert_eq!(replay.event, original_event);
    assert_eq!(
        replay.event.primary.as_ref().map(|p| p.id.as_str()),
        Some(original_id.as_str())
    );
    assert_eq!(sink.0.lock().unwrap().len(), 0, "replay must not publish");

    let mismatch = service
        .create_ai_session(
            operation_id,
            CreateAiSessionRequest {
                title: "Different title".into(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(mismatch, junban_app::AppError::IdempotencyMismatch);

    drop(service);
    drop(sink);
    drop(owner);
    let connection = rusqlite::Connection::open(profile.join("junban.sqlite3")).unwrap();
    let session_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM ai_sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(session_count, 1);
    let event_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(event_count, 1);
    let stored_id: String = connection
        .query_row("SELECT id FROM ai_sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(stored_id, original_id);
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn create_ai_memory_exact_retry_survives_reopen_and_rejects_mismatched_content() {
    let profile = temp_profile();
    let operation_id = op();
    let original_id;
    let original_event;
    {
        let (owner, service, sink) = open_service(&profile);
        let first = service
            .create_ai_memory(
                operation_id,
                CreateAiMemoryRequest {
                    content: "Stable memory".into(),
                },
            )
            .await
            .unwrap();
        assert!(first.newly_committed);
        original_id = first
            .event
            .primary
            .as_ref()
            .expect("memory primary")
            .id
            .clone();
        original_event = first.event.clone();
        assert_eq!(sink.0.lock().unwrap().len(), 1);
        drop(service);
        drop(sink);
        drop(owner);
    }

    let (owner, service, sink) = open_service(&profile);
    let replay = service
        .create_ai_memory(
            operation_id,
            CreateAiMemoryRequest {
                content: "Stable memory".into(),
            },
        )
        .await
        .unwrap();
    assert!(!replay.newly_committed);
    assert_eq!(replay.event, original_event);
    assert_eq!(
        replay.event.primary.as_ref().map(|p| p.id.as_str()),
        Some(original_id.as_str())
    );
    assert_eq!(sink.0.lock().unwrap().len(), 0, "replay must not publish");

    let mismatch = service
        .create_ai_memory(
            operation_id,
            CreateAiMemoryRequest {
                content: "Different content".into(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(mismatch, junban_app::AppError::IdempotencyMismatch);

    drop(service);
    drop(sink);
    drop(owner);
    let connection = rusqlite::Connection::open(profile.join("junban.sqlite3")).unwrap();
    let memory_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM ai_memories", [], |row| row.get(0))
        .unwrap();
    assert_eq!(memory_count, 1);
    let event_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(event_count, 1);
    let stored_id: String = connection
        .query_row("SELECT id FROM ai_memories", [], |row| row.get(0))
        .unwrap();
    assert_eq!(stored_id, original_id);
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn list_session_and_memory_cursors_are_stable_without_duplicates() {
    let profile = temp_profile();
    let (owner, service, _sink) = open_service(&profile);

    for index in 0..5 {
        service
            .create_ai_session(
                op(),
                CreateAiSessionRequest {
                    title: format!("session-{index}"),
                },
            )
            .await
            .unwrap();
    }
    for index in 0..5 {
        service
            .create_ai_memory(
                op(),
                CreateAiMemoryRequest {
                    content: format!("memory-{index}"),
                },
            )
            .await
            .unwrap();
    }

    let first_page = service
        .list_ai_sessions(ListAiSessionsRequest {
            cursor: None,
            limit: Some(2),
        })
        .await
        .unwrap();
    assert_eq!(first_page.sessions.len(), 2);
    let cursor = first_page.next_cursor.clone().expect("next cursor");
    let second_page = service
        .list_ai_sessions(ListAiSessionsRequest {
            cursor: Some(cursor),
            limit: Some(2),
        })
        .await
        .unwrap();
    assert_eq!(second_page.sessions.len(), 2);
    let first_ids: Vec<_> = first_page.sessions.iter().map(|s| s.id).collect();
    let second_ids: Vec<_> = second_page.sessions.iter().map(|s| s.id).collect();
    for id in &first_ids {
        assert!(!second_ids.contains(id), "session page overlap for {id}");
    }

    let mem_first = service
        .list_ai_memories(ListAiMemoriesRequest {
            cursor: None,
            limit: Some(2),
        })
        .await
        .unwrap();
    assert_eq!(mem_first.memories.len(), 2);
    let mem_cursor = mem_first.next_cursor.clone().expect("memory cursor");
    let mem_second = service
        .list_ai_memories(ListAiMemoriesRequest {
            cursor: Some(mem_cursor),
            limit: Some(2),
        })
        .await
        .unwrap();
    let mem_first_ids: Vec<_> = mem_first.memories.iter().map(|m| m.id).collect();
    let mem_second_ids: Vec<_> = mem_second.memories.iter().map(|m| m.id).collect();
    for id in &mem_first_ids {
        assert!(!mem_second_ids.contains(id), "memory page overlap for {id}");
    }

    drop(service);
    drop(owner);
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn memory_selection_prefers_session_links_and_caps_at_fifty() {
    let profile = temp_profile();
    let (owner, service, _sink) = open_service(&profile);
    let session = service
        .create_ai_session(
            op(),
            CreateAiSessionRequest {
                title: "context".into(),
            },
        )
        .await
        .unwrap();
    let session_id =
        AiSessionId::parse(&session.event.primary.as_ref().expect("session primary").id).unwrap();

    let mut linked_ids = BTreeSet::new();
    for index in 0..3 {
        let created = service
            .create_ai_memory(
                op(),
                CreateAiMemoryRequest {
                    content: format!("linked-{index}"),
                },
            )
            .await
            .unwrap();
        let memory_id =
            AiMemoryId::parse(&created.event.primary.as_ref().expect("memory primary").id).unwrap();
        linked_ids.insert(memory_id);
        service
            .link_ai_session_memory(
                op(),
                LinkAiSessionMemoryRequest {
                    session_id,
                    memory_id,
                },
            )
            .await
            .unwrap();
    }
    for index in 0..60 {
        service
            .create_ai_memory(
                op(),
                CreateAiMemoryRequest {
                    content: format!("other-{index}"),
                },
            )
            .await
            .unwrap();
    }

    let selected = service
        .select_ai_memories_for_context(SelectAiMemoriesRequest {
            session_id: Some(session_id),
            limit: Some(AI_CONTEXT_MEMORIES_MAX),
        })
        .await
        .unwrap();
    assert_eq!(selected.len(), AI_CONTEXT_MEMORIES_MAX as usize);
    let selected_ids: Vec<_> = selected.iter().map(|memory| memory.id).collect();
    for linked in &linked_ids {
        assert!(
            selected_ids.contains(linked),
            "session-linked memory missing from context selection"
        );
    }
    // Linked entries occupy the deterministic leading prefix.
    let leading: BTreeSet<_> = selected_ids
        .iter()
        .take(linked_ids.len())
        .copied()
        .collect();
    assert_eq!(leading, linked_ids);
    let unique: BTreeSet<_> = selected_ids.iter().copied().collect();
    assert_eq!(unique.len(), selected_ids.len());

    drop(service);
    drop(owner);
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn credential_bind_and_clear_replay_without_secret_multiplication() {
    let profile = temp_profile();
    let (owner, service, sink) = open_service(&profile);
    configure_openai(&service).await;
    sink.0.lock().unwrap().clear();

    let marker = "wave3a-secret-marker-value";
    let operation_id = op();
    let bound = service
        .bind_ai_credential(
            operation_id,
            BindAiCredentialRequest {
                target: AiCredentialBindingTarget::AiProvider,
                kind: AiSecretKind::ApiKey,
                secret: Some(AiSecretBytes::new(marker).unwrap()),
            },
        )
        .await
        .unwrap();
    assert!(bound.mutation.newly_committed);
    assert!(bound.credential_id.is_some());
    assert_eq!(sink.0.lock().unwrap().len(), 1);
    let debug = format!("{bound:?}");
    assert!(!debug.contains(marker));
    assert_eq!(AiSecretStore::load(&profile).unwrap().len_for_test(), 1);

    let event_count = sink.0.lock().unwrap().len();
    let metadata = service.list_ai_secret_metadata().await.unwrap();
    assert_eq!(metadata.len(), 1);
    assert_eq!(metadata[0].id, bound.credential_id.unwrap());
    assert!(metadata[0].present);
    let resolved = service
        .resolve_ai_secret(bound.credential_id.unwrap())
        .await
        .unwrap();
    assert_eq!(resolved.expose(), marker);
    assert!(matches!(
        service
            .resolve_ai_secret(junban_domain::AiCredentialId::new())
            .await,
        Err(junban_app::AppError::NotFound)
    ));
    assert_eq!(sink.0.lock().unwrap().len(), event_count);

    let replay = service
        .bind_ai_credential(
            operation_id,
            BindAiCredentialRequest {
                target: AiCredentialBindingTarget::AiProvider,
                kind: AiSecretKind::ApiKey,
                secret: Some(AiSecretBytes::new(marker).unwrap()),
            },
        )
        .await
        .unwrap();
    assert!(!replay.mutation.newly_committed);
    assert_eq!(replay.credential_id, bound.credential_id);
    assert_eq!(sink.0.lock().unwrap().len(), 1);
    assert_eq!(AiSecretStore::load(&profile).unwrap().len_for_test(), 1);

    let cleared = service
        .clear_ai_credential(
            op(),
            ClearAiCredentialRequest {
                target: AiCredentialBindingTarget::AiProvider,
            },
        )
        .await
        .unwrap();
    assert!(cleared.newly_committed);
    let settings = service.get_settings().await.unwrap();
    assert!(settings.ai.credential_id.is_none());
    assert_eq!(AiSecretStore::load(&profile).unwrap().len_for_test(), 0);

    let secrets_path = profile.join(AI_SECRETS_FILE);
    if secrets_path.exists() {
        let bytes = fs::read(&secrets_path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(marker));
    }

    drop(service);
    drop(sink);
    drop(owner);
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn approval_propose_consume_and_run_state_use_wave1_atomics_through_service() {
    let profile = temp_profile();
    let (owner, service, sink) = open_service(&profile);
    let session = service
        .create_ai_session(
            op(),
            CreateAiSessionRequest {
                title: "approval".into(),
            },
        )
        .await
        .unwrap();
    let session_id =
        AiSessionId::parse(&session.event.primary.as_ref().expect("session primary").id).unwrap();
    let turn_id = AiTurnId::new();
    let run_id = AiRunId::new();
    let now = Timestamp::now();
    let run_state = AiRunState {
        run_id,
        session_id,
        turn_id,
        generation: 1,
        state: AiRunPhase::Running,
        approval_id: None,
        created_at: now,
        updated_at: now,
    };
    service
        .upsert_ai_run_state(op(), UpsertAiRunStateRequest { state: run_state })
        .await
        .unwrap();
    let loaded = service.get_ai_run_state(run_id).await.unwrap();
    assert_eq!(loaded.state, AiRunPhase::Running);

    let approval_id = AiApprovalId::new();
    service
        .propose_ai_approval(
            op(),
            ProposeAiApprovalRequest {
                approval_id,
                session_id,
                turn_id,
                run_id,
                generation: 1,
                tool_name: "create_task".into(),
                arguments_json: r#"{"title":"x"}"#.into(),
            },
        )
        .await
        .unwrap();
    let awaiting = service.get_ai_run_state(run_id).await.unwrap();
    assert_eq!(awaiting.state, AiRunPhase::AwaitingApproval);
    assert_eq!(awaiting.approval_id, Some(approval_id));

    service
        .set_ai_approval_status(
            op(),
            SetAiApprovalStatusRequest {
                approval_id,
                status: AiApprovalStatus::Approved,
                dispatch_operation_id: None,
            },
        )
        .await
        .unwrap();
    let dispatch_op = op();
    service
        .set_ai_approval_status(
            op(),
            SetAiApprovalStatusRequest {
                approval_id,
                status: AiApprovalStatus::Consumed,
                dispatch_operation_id: Some(dispatch_op),
            },
        )
        .await
        .unwrap();
    let dispatching = service.get_ai_run_state(run_id).await.unwrap();
    assert_eq!(dispatching.state, AiRunPhase::Dispatching);
    let approval = service.get_ai_approval(approval_id).await.unwrap();
    assert_eq!(approval.status, AiApprovalStatus::Consumed);
    assert_eq!(
        approval.operation_id.as_deref(),
        Some(dispatch_op.to_string().as_str())
    );

    sink.0.lock().unwrap().clear();
    let message = service
        .upsert_ai_message(
            op(),
            UpsertAiMessageRequest {
                message_id: AiMessageId::new(),
                session_id,
                turn_id,
                role: AiMessageRole::User,
                status: AiMessageStatus::Completed,
                content: AiMessageContent::text("hello").unwrap(),
            },
        )
        .await
        .unwrap();
    assert!(message.newly_committed);
    assert_eq!(sink.0.lock().unwrap().len(), 1);

    service
        .clear_ai_session(op(), ClearAiSessionRequest { session_id })
        .await
        .unwrap();

    drop(service);
    drop(sink);
    drop(owner);
    let connection = rusqlite::Connection::open(profile.join("junban.sqlite3")).unwrap();
    let undo_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM operation_undo", [], |row| row.get(0))
        .unwrap();
    assert_eq!(undo_count, 0);
    fs::remove_dir_all(profile).unwrap();
}
