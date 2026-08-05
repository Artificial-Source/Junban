//! Focused Phase 6 Wave 3a service/repository AI wiring tests.

use std::{
    collections::BTreeSet,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use jiff::{Timestamp, ToSpan};
use junban_app::{
    AiCredentialBindingTarget, AiSecretBytes, BindAiCredentialRequest, ClearAiCredentialRequest,
    ClearAiSessionRequest, CommittedEvent, CreateAiMemoryRequest, CreateAiSessionRequest,
    DeleteAiSessionRequest, EventSink, EventType, FinishAiResponseRequest, JunbanService,
    LinkAiSessionMemoryRequest, ListAiMemoriesRequest, ListAiSessionsRequest,
    ProposeAiApprovalRequest, ReserveDailyAiResponseRequest, RewriteAiResponseRequest,
    SelectAiMemoriesRequest, SetAiApprovalStatusRequest, UpsertAiMessageRequest,
    UpsertAiRunStateRequest,
};
use junban_domain::{
    AI_CONTEXT_MEMORIES_MAX, AI_SECRETS_FILE, AiApprovalId, AiApprovalStatus, AiMemoryId,
    AiMessageContent, AiMessageId, AiMessageRole, AiMessageStatus, AiProviderPreset,
    AiResponseRewriteKind, AiRunId, AiRunPhase, AiRunState, AiSecretKind, AiSessionId, AiToolEvent,
    AiToolEventType, AiTurnId, OperationId, ProviderBaseUrl, SettingsPatch,
};
use serde_json::json;
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
async fn finish_ai_response_is_one_atomic_replayable_service_mutation() {
    let profile = temp_profile();
    let (owner, service, sink) = open_service(&profile);
    let created = service
        .create_ai_session(
            op(),
            CreateAiSessionRequest {
                title: "response".into(),
            },
        )
        .await
        .unwrap();
    let session_id =
        AiSessionId::parse(&created.event.primary.as_ref().expect("session primary").id).unwrap();
    let assistant_message_id = AiMessageId::new();
    let turn_id = AiTurnId::new();
    let run_id = AiRunId::new();
    service
        .upsert_ai_message(
            op(),
            UpsertAiMessageRequest {
                message_id: assistant_message_id,
                session_id,
                turn_id,
                role: AiMessageRole::Assistant,
                status: AiMessageStatus::Streaming,
                content: AiMessageContent::text("").unwrap(),
            },
        )
        .await
        .unwrap();
    let timestamp = Timestamp::now();
    service
        .upsert_ai_run_state(
            op(),
            UpsertAiRunStateRequest {
                state: AiRunState {
                    run_id,
                    session_id,
                    turn_id,
                    assistant_message_id,
                    generation: 1,
                    state: AiRunPhase::Running,
                    approval_id: None,
                    created_at: timestamp,
                    updated_at: timestamp,
                },
            },
        )
        .await
        .unwrap();

    sink.0.lock().unwrap().clear();
    let wrong_identity = FinishAiResponseRequest {
        assistant_message_id,
        session_id,
        turn_id: AiTurnId::new(),
        run_id,
        generation: 1,
        message_status: AiMessageStatus::Completed,
        content: AiMessageContent::text("wrong").unwrap(),
        run_phase: AiRunPhase::Completed,
        dispatch_operation_id: None,
    };
    assert_eq!(
        service
            .finish_ai_response(op(), wrong_identity.clone())
            .await
            .unwrap_err(),
        junban_app::AppError::Conflict
    );
    assert_eq!(
        service
            .get_ai_message(assistant_message_id)
            .await
            .unwrap()
            .status,
        AiMessageStatus::Streaming
    );
    assert_eq!(
        service.get_ai_run_state(run_id).await.unwrap().state,
        AiRunPhase::Running
    );

    let operation_id = op();
    let request = FinishAiResponseRequest {
        assistant_message_id,
        session_id,
        turn_id,
        run_id,
        generation: 1,
        message_status: AiMessageStatus::Completed,
        content: AiMessageContent::text("done").unwrap(),
        run_phase: AiRunPhase::Completed,
        dispatch_operation_id: None,
    };
    let committed = service
        .finish_ai_response(operation_id, request.clone())
        .await
        .unwrap();
    assert!(committed.newly_committed);
    assert_eq!(sink.0.lock().unwrap().len(), 1);
    assert_eq!(
        service
            .get_ai_message(assistant_message_id)
            .await
            .unwrap()
            .status,
        AiMessageStatus::Completed
    );
    assert_eq!(
        service.get_ai_run_state(run_id).await.unwrap().state,
        AiRunPhase::Completed
    );

    let replay = service
        .finish_ai_response(operation_id, request.clone())
        .await
        .unwrap();
    assert!(!replay.newly_committed);
    assert_eq!(replay.event, committed.event);
    assert_eq!(sink.0.lock().unwrap().len(), 1);
    let mut mismatch = request;
    mismatch.content = AiMessageContent::text("changed").unwrap();
    assert_eq!(
        service
            .finish_ai_response(operation_id, mismatch)
            .await
            .unwrap_err(),
        junban_app::AppError::IdempotencyMismatch
    );

    drop(service);
    drop(sink);
    drop(owner);
    let connection = rusqlite::Connection::open(profile.join("junban.sqlite3")).unwrap();
    let terminal_receipts: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM operation_receipts WHERE operation_id = ?1",
            [operation_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(terminal_receipts, 1);
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
    let assistant_message_id = AiMessageId::new();
    service
        .upsert_ai_message(
            op(),
            UpsertAiMessageRequest {
                message_id: assistant_message_id,
                session_id,
                turn_id,
                role: AiMessageRole::Assistant,
                status: AiMessageStatus::Streaming,
                content: AiMessageContent::text("").unwrap(),
            },
        )
        .await
        .unwrap();
    let now = Timestamp::now();
    let run_state = AiRunState {
        run_id,
        session_id,
        turn_id,
        assistant_message_id,
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
                assistant_content: {
                    let mut content = AiMessageContent::text("").unwrap();
                    content.tool_name = Some("create_task".into());
                    content.tool_arguments_json = Some(r#"{"title":"x"}"#.into());
                    content
                },
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
                assistant_content: None,
            },
        )
        .await
        .unwrap();
    let mut approved_content = service
        .get_ai_message(assistant_message_id)
        .await
        .unwrap()
        .content;
    approved_content.tool_events.push(
        AiToolEvent::new(
            approved_content.text.len(),
            AiToolEventType::ToolApproved,
            json!({"approval_id": approval_id.to_string()}),
        )
        .unwrap(),
    );
    let dispatch_op = op();
    let consume_op = op();
    service
        .set_ai_approval_status(
            consume_op,
            SetAiApprovalStatusRequest {
                approval_id,
                status: AiApprovalStatus::Consumed,
                dispatch_operation_id: Some(dispatch_op),
                assistant_content: Some(approved_content.clone()),
            },
        )
        .await
        .unwrap();
    assert!(
        !service
            .set_ai_approval_status(
                consume_op,
                SetAiApprovalStatusRequest {
                    approval_id,
                    status: AiApprovalStatus::Consumed,
                    dispatch_operation_id: Some(dispatch_op),
                    assistant_content: Some(approved_content.clone()),
                },
            )
            .await
            .unwrap()
            .newly_committed
    );
    let mut mismatched_checkpoint = approved_content.clone();
    mismatched_checkpoint.text.push('x');
    assert_eq!(
        service
            .set_ai_approval_status(
                consume_op,
                SetAiApprovalStatusRequest {
                    approval_id,
                    status: AiApprovalStatus::Consumed,
                    dispatch_operation_id: Some(dispatch_op),
                    assistant_content: Some(mismatched_checkpoint),
                },
            )
            .await
            .unwrap_err(),
        junban_app::AppError::IdempotencyMismatch
    );
    let dispatching = service.get_ai_run_state(run_id).await.unwrap();
    assert_eq!(dispatching.state, AiRunPhase::Dispatching);
    let stopped_after_consume = service.get_ai_message(assistant_message_id).await.unwrap();
    assert_eq!(stopped_after_consume.content, approved_content);
    assert_eq!(
        stopped_after_consume
            .content
            .tool_events
            .iter()
            .filter(|event| event.event_type == AiToolEventType::ToolApproved)
            .count(),
        1
    );
    assert_eq!(
        stopped_after_consume
            .content
            .tool_events
            .last()
            .unwrap()
            .payload,
        json!({"approval_id": approval_id.to_string()})
    );
    let approval = service.get_ai_approval(approval_id).await.unwrap();
    assert_eq!(approval.status, AiApprovalStatus::Consumed);
    assert_eq!(
        service.list_dispatching_ai_approvals().await.unwrap(),
        vec![approval.clone()]
    );
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

#[tokio::test]
async fn cancel_ai_response_service_replays_and_rejects_mismatch() {
    let profile = temp_profile();
    let (owner, service, sink) = open_service(&profile);
    let created = service
        .create_ai_session(
            op(),
            CreateAiSessionRequest {
                title: "cancel".into(),
            },
        )
        .await
        .unwrap();
    let session_id = AiSessionId::parse(&created.event.primary.unwrap().id).unwrap();
    let assistant_message_id = AiMessageId::new();
    let turn_id = AiTurnId::new();
    let run_id = AiRunId::new();
    service
        .upsert_ai_message(
            op(),
            UpsertAiMessageRequest {
                message_id: assistant_message_id,
                session_id,
                turn_id,
                role: AiMessageRole::Assistant,
                status: AiMessageStatus::Streaming,
                content: AiMessageContent::text("").unwrap(),
            },
        )
        .await
        .unwrap();
    let timestamp = Timestamp::now();
    service
        .upsert_ai_run_state(
            op(),
            UpsertAiRunStateRequest {
                state: AiRunState {
                    run_id,
                    session_id,
                    turn_id,
                    assistant_message_id,
                    generation: 1,
                    state: AiRunPhase::Running,
                    approval_id: None,
                    created_at: timestamp,
                    updated_at: timestamp,
                },
            },
        )
        .await
        .unwrap();
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
                assistant_content: {
                    let mut content = AiMessageContent::text("").unwrap();
                    content.tool_name = Some("create_task".into());
                    content.tool_arguments_json = Some(r#"{"title":"x"}"#.into());
                    content
                },
            },
        )
        .await
        .unwrap();
    service
        .set_ai_approval_status(
            op(),
            SetAiApprovalStatusRequest {
                approval_id,
                status: AiApprovalStatus::Approved,
                dispatch_operation_id: None,
                assistant_content: None,
            },
        )
        .await
        .unwrap();
    sink.0.lock().unwrap().clear();
    let operation_id = op();
    let request = junban_app::CancelAiResponseRequest {
        assistant_message_id,
        session_id,
        turn_id,
        run_id,
        generation: 1,
        content: AiMessageContent::text("").unwrap(),
    };
    let committed = service
        .cancel_ai_response(operation_id, request.clone())
        .await
        .unwrap();
    assert!(committed.newly_committed);
    assert_eq!(sink.0.lock().unwrap().len(), 1);
    assert!(
        !service
            .cancel_ai_response(operation_id, request.clone())
            .await
            .unwrap()
            .newly_committed
    );
    let mut mismatch = request;
    mismatch.generation = 2;
    assert_eq!(
        service
            .cancel_ai_response(operation_id, mismatch)
            .await
            .unwrap_err(),
        junban_app::AppError::IdempotencyMismatch
    );
    assert_eq!(
        service
            .get_ai_message(assistant_message_id)
            .await
            .unwrap()
            .status,
        AiMessageStatus::Cancelled
    );
    assert_eq!(
        service.get_ai_approval(approval_id).await.unwrap().status,
        AiApprovalStatus::Expired
    );
    drop(service);
    drop(sink);
    drop(owner);
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn daily_reservation_is_profile_date_unique_replayable_and_preserves_date() {
    let profile = temp_profile();
    let (owner, service, sink) = open_service(&profile);
    let created = service
        .create_ai_session(
            op(),
            CreateAiSessionRequest {
                title: "Daily".into(),
            },
        )
        .await
        .unwrap();
    let session_id = AiSessionId::parse(
        created
            .event
            .primary
            .as_ref()
            .expect("session primary")
            .id
            .as_str(),
    )
    .unwrap();
    let operation_id = op();
    let request = ReserveDailyAiResponseRequest {
        session_id,
        briefing_date: "2026-08-04".into(),
        turn_id: AiTurnId::new(),
        assistant_message_id: AiMessageId::new(),
        run_id: AiRunId::new(),
        generation: 1,
    };
    let first = service
        .reserve_daily_ai_response(operation_id, request.clone())
        .await
        .unwrap();
    assert!(first.mutation.newly_committed);
    assert!(first.user_message.is_none());
    assert_eq!(
        first.assistant_message.content.briefing_date.as_deref(),
        Some("2026-08-04")
    );
    assert!(
        !service
            .reserve_daily_ai_response(operation_id, request.clone())
            .await
            .unwrap()
            .mutation
            .newly_committed
    );
    let duplicate = ReserveDailyAiResponseRequest {
        turn_id: AiTurnId::new(),
        assistant_message_id: AiMessageId::new(),
        run_id: AiRunId::new(),
        ..request.clone()
    };
    assert_eq!(
        service
            .reserve_daily_ai_response(op(), duplicate)
            .await
            .unwrap_err(),
        junban_app::AppError::Conflict
    );
    service
        .finish_ai_response(
            op(),
            FinishAiResponseRequest {
                assistant_message_id: request.assistant_message_id,
                session_id,
                turn_id: request.turn_id,
                run_id: request.run_id,
                generation: 1,
                message_status: AiMessageStatus::Failed,
                content: AiMessageContent::text("").unwrap(),
                run_phase: AiRunPhase::Failed,
                dispatch_operation_id: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .get_ai_message(request.assistant_message_id)
            .await
            .unwrap()
            .content
            .briefing_date
            .as_deref(),
        Some("2026-08-04")
    );
    let next = ReserveDailyAiResponseRequest {
        turn_id: AiTurnId::new(),
        assistant_message_id: AiMessageId::new(),
        run_id: AiRunId::new(),
        ..request
    };
    service.reserve_daily_ai_response(op(), next).await.unwrap();
    drop(service);
    drop(sink);
    drop(owner);
    let reopened = ProfileOwner::open(&profile).unwrap();
    drop(reopened);
    fs::remove_dir_all(profile).unwrap();
}

#[tokio::test]
async fn regenerate_replaces_exact_suffix_and_tombstones_old_run() {
    let profile = temp_profile();
    let (owner, service, sink) = open_service(&profile);
    let created = service
        .create_ai_session(
            op(),
            CreateAiSessionRequest {
                title: "Rewrite".into(),
            },
        )
        .await
        .unwrap();
    let session_id = AiSessionId::parse(
        created
            .event
            .primary
            .as_ref()
            .expect("session primary")
            .id
            .as_str(),
    )
    .unwrap();
    let old_turn = AiTurnId::new();
    let old_user = AiMessageId::new();
    let old_assistant = AiMessageId::new();
    let old_run = AiRunId::new();
    service
        .upsert_ai_message(
            op(),
            UpsertAiMessageRequest {
                message_id: old_user,
                session_id,
                turn_id: old_turn,
                role: AiMessageRole::User,
                status: AiMessageStatus::Completed,
                content: AiMessageContent::text("original").unwrap(),
            },
        )
        .await
        .unwrap();
    service
        .upsert_ai_message(
            op(),
            UpsertAiMessageRequest {
                message_id: old_assistant,
                session_id,
                turn_id: old_turn,
                role: AiMessageRole::Assistant,
                status: AiMessageStatus::Streaming,
                content: AiMessageContent::text("").unwrap(),
            },
        )
        .await
        .unwrap();
    let started = Timestamp::now();
    service
        .upsert_ai_run_state(
            op(),
            UpsertAiRunStateRequest {
                state: AiRunState {
                    run_id: old_run,
                    session_id,
                    turn_id: old_turn,
                    assistant_message_id: old_assistant,
                    generation: 1,
                    state: AiRunPhase::Running,
                    approval_id: None,
                    created_at: started,
                    updated_at: started,
                },
            },
        )
        .await
        .unwrap();
    service
        .finish_ai_response(
            op(),
            FinishAiResponseRequest {
                assistant_message_id: old_assistant,
                session_id,
                turn_id: old_turn,
                run_id: old_run,
                generation: 1,
                message_status: AiMessageStatus::Completed,
                content: AiMessageContent::text("old response").unwrap(),
                run_phase: AiRunPhase::Completed,
                dispatch_operation_id: None,
            },
        )
        .await
        .unwrap();

    let operation_id = op();
    let request = RewriteAiResponseRequest {
        kind: AiResponseRewriteKind::Regenerate,
        session_id,
        target_message_id: old_assistant,
        message: "original".into(),
        focused_task_id: None,
        turn_id: AiTurnId::new(),
        user_message_id: AiMessageId::new(),
        assistant_message_id: AiMessageId::new(),
        run_id: AiRunId::new(),
        generation: 1,
    };
    let fault = rusqlite::Connection::open(profile.join("junban.sqlite3")).unwrap();
    fault
        .execute_batch(
            "CREATE TRIGGER fail_ai_rewrite_event
             BEFORE INSERT ON events
             WHEN NEW.event_type = 'ai.session.changed'
             BEGIN SELECT RAISE(FAIL, 'injected AI rewrite failure'); END;",
        )
        .unwrap();
    assert_eq!(
        service
            .rewrite_ai_response(operation_id, request.clone())
            .await
            .unwrap_err(),
        junban_app::AppError::Storage
    );
    assert_eq!(
        service
            .get_ai_message(old_assistant)
            .await
            .unwrap()
            .content
            .text,
        "old response"
    );
    service.ensure_ai_response_current(old_run).await.unwrap();
    assert_eq!(
        service.get_ai_run_state(request.run_id).await.unwrap_err(),
        junban_app::AppError::NotFound
    );
    fault
        .execute_batch("DROP TRIGGER fail_ai_rewrite_event")
        .unwrap();
    drop(fault);

    let prepared = service
        .rewrite_ai_response(operation_id, request.clone())
        .await
        .unwrap();
    let regenerated_user = prepared.user_message.as_ref().unwrap().id;
    let regenerated_assistant = prepared.assistant_message.id;
    let regenerated_turn = prepared.run.turn_id;
    let regenerated_run = prepared.run.run_id;
    assert_eq!(prepared.user_message.as_ref().unwrap().sequence, 1);
    assert_eq!(prepared.assistant_message.sequence, 2);
    assert_eq!(
        service
            .ensure_ai_response_current(old_run)
            .await
            .unwrap_err(),
        junban_app::AppError::Conflict
    );
    assert_eq!(
        service.get_ai_message(old_assistant).await.unwrap_err(),
        junban_app::AppError::NotFound
    );
    assert!(
        !service
            .rewrite_ai_response(operation_id, request.clone())
            .await
            .unwrap()
            .mutation
            .newly_committed
    );
    let mut mismatch = request;
    mismatch.message = "changed".into();
    assert_eq!(
        service
            .rewrite_ai_response(operation_id, mismatch)
            .await
            .unwrap_err(),
        junban_app::AppError::IdempotencyMismatch
    );
    drop(service);
    drop(sink);
    drop(owner);
    let reopened = ProfileOwner::open(&profile).unwrap();
    drop(reopened);

    let (owner, service, sink) = open_service(&profile);
    assert_eq!(
        service
            .get_ai_run_state(regenerated_run)
            .await
            .unwrap()
            .state,
        AiRunPhase::Cancelled
    );
    let retry = service
        .rewrite_ai_response(
            op(),
            RewriteAiResponseRequest {
                kind: AiResponseRewriteKind::Retry,
                session_id,
                target_message_id: regenerated_assistant,
                message: "original".into(),
                focused_task_id: None,
                turn_id: AiTurnId::new(),
                user_message_id: AiMessageId::new(),
                assistant_message_id: AiMessageId::new(),
                run_id: AiRunId::new(),
                generation: 1,
            },
        )
        .await
        .unwrap();
    assert_ne!(retry.run.turn_id, regenerated_turn);
    service
        .finish_ai_response(
            op(),
            FinishAiResponseRequest {
                assistant_message_id: retry.assistant_message.id,
                session_id,
                turn_id: retry.run.turn_id,
                run_id: retry.run.run_id,
                generation: 1,
                message_status: AiMessageStatus::Completed,
                content: AiMessageContent::text("retried").unwrap(),
                run_phase: AiRunPhase::Completed,
                dispatch_operation_id: None,
            },
        )
        .await
        .unwrap();
    let edited = service
        .rewrite_ai_response(
            op(),
            RewriteAiResponseRequest {
                kind: AiResponseRewriteKind::Edit,
                session_id,
                target_message_id: retry.user_message.as_ref().unwrap().id,
                message: "edited".into(),
                focused_task_id: None,
                turn_id: AiTurnId::new(),
                user_message_id: AiMessageId::new(),
                assistant_message_id: AiMessageId::new(),
                run_id: AiRunId::new(),
                generation: 1,
            },
        )
        .await
        .unwrap();
    assert_eq!(edited.user_message.unwrap().content.text, "edited");
    assert_eq!(
        service.get_ai_message(regenerated_user).await.unwrap_err(),
        junban_app::AppError::NotFound
    );

    service
        .delete_ai_session(op(), DeleteAiSessionRequest { session_id })
        .await
        .unwrap();
    assert_eq!(
        service
            .ensure_ai_response_current(old_run)
            .await
            .unwrap_err(),
        junban_app::AppError::Conflict
    );
    let backup = service.create_backup().await.unwrap();
    let candidate = service.prepare_restore(backup).await.unwrap();
    service.restore_backup(candidate).await.unwrap();
    assert_eq!(
        service
            .ensure_ai_response_current(old_run)
            .await
            .unwrap_err(),
        junban_app::AppError::Conflict
    );

    drop(service);
    drop(sink);
    drop(owner);
    let (reopened_owner, reopened_service, reopened_sink) = open_service(&profile);
    assert_eq!(
        reopened_service
            .ensure_ai_response_current(old_run)
            .await
            .unwrap_err(),
        junban_app::AppError::Conflict
    );
    drop(reopened_service);
    drop(reopened_sink);
    drop(reopened_owner);

    let mut connection = rusqlite::Connection::open(profile.join("junban.sqlite3")).unwrap();
    let (old_invalidation, sessions): (i64, i64) = connection
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM ai_response_invalidations WHERE run_id = ?1),
                (SELECT COUNT(*) FROM ai_sessions)",
            [old_run.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((old_invalidation, sessions), (1, 0));
    let receipt_request: String = connection
        .query_row(
            "SELECT request_json FROM operation_receipts WHERE operation_id = ?1",
            [operation_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(receipt_request.contains("message_sha256"));
    assert!(!receipt_request.contains("original"));
    for generated in [
        regenerated_user.to_string(),
        regenerated_assistant.to_string(),
        regenerated_turn.to_string(),
        regenerated_run.to_string(),
    ] {
        assert!(!receipt_request.contains(&generated));
    }
    crate::ai_ops::create_ai_session(
        &mut connection,
        op(),
        AiSessionId::new(),
        "cleanup".into(),
        Timestamp::now().checked_add((31 * 24).hours()).unwrap(),
    )
    .unwrap();
    let retained: i64 = connection
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM ai_response_invalidations)
              + (SELECT COUNT(*) FROM operation_receipts WHERE operation_id = ?1)",
            [operation_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, 0);
    drop(connection);
    fs::remove_dir_all(profile).unwrap();
}
