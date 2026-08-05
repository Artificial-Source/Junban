//! Wave 3g daily briefing and response-action API regressions.

use super::*;

#[tokio::test]
async fn daily_briefing_is_assistant_only_and_replays_after_disable() {
    use tokio::net::TcpListener;

    let context = TestContext::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let fixture = tokio::spawn(async move {
        let (first, _) = listener.accept().await.unwrap();
        let first = fragmented_chat_socket(
            first,
            &[
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"daily-plan\",\"function\":{\"name\":\"plan_my_day\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n",
            ],
        )
        .await;
        let (second, _) = listener.accept().await.unwrap();
        let second = fragmented_chat_socket(
            second,
            &[
                "data: {\"choices\":[{\"delta\":{\"content\":\"today\"}}]}\n\n",
                "data: [DONE]\n\n",
            ],
        )
        .await;
        (first, second)
    });
    let session_id = configure_loopback_ai_session(&context, address).await;
    let mut settings = context.state.service.get_settings().await.unwrap();
    settings.ai.daily_briefing_enabled = true;
    settings.ai.default_energy = Some(4);
    context
        .state
        .service
        .patch_settings(
            OperationId::new(),
            junban_domain::SettingsPatch {
                ai: Some(settings.ai.clone()),
                ..junban_domain::SettingsPatch::default()
            },
        )
        .await
        .unwrap();
    let operation = Uuid::now_v7().to_string();
    let uri = format!("/api/v1/ai/sessions/{session_id}/daily-briefing");
    let response = context
        .request(
            operation_header_key(authenticated(Method::POST, &uri), &operation)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let streamed = response_bytes(response).await;
    assert_eq!(
        ai_sse_envelopes(&streamed).last().unwrap()["type"],
        "run_completed"
    );
    let (provider_request, continuation_request) = fixture.await.unwrap();
    let provider_body: Value = serde_json::from_str(&provider_request).unwrap();
    let messages = provider_body["messages"].as_array().unwrap();
    let tools = provider_body["tools"].as_array().unwrap();
    assert!(
        tools
            .iter()
            .any(|tool| tool["function"]["name"] == "plan_my_day")
    );
    let user_messages: Vec<_> = messages
        .iter()
        .filter(|message| message["role"] == "user")
        .collect();
    assert_eq!(user_messages.len(), 1);
    let daily_instruction = user_messages[0]["content"].as_str().unwrap();
    let today = jiff::Zoned::now().date().to_string();
    assert!(daily_instruction.contains(&today));
    assert!(daily_instruction.contains("read-only plan_my_day tool first"));
    assert!(daily_instruction.contains("Do not apply or claim to apply"));
    assert!(daily_instruction.contains("4/5"));
    assert!(messages.iter().any(|message| {
        message["role"] == "system"
            && message["content"]
                .as_str()
                .is_some_and(|content| content.contains("Answer briefly."))
    }));
    let continuation: Value = serde_json::from_str(&continuation_request).unwrap();
    assert!(
        continuation["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "plan_my_day")
    );
    assert!(
        continuation["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "tool")
    );

    let identity =
        crate::ai_identity::AiResponseIdentity::derive(OperationId::parse(&operation).unwrap());
    let assistant = context
        .state
        .service
        .get_ai_message(identity.assistant_message_id)
        .await
        .unwrap();
    assert_eq!(
        assistant.content.briefing_date.as_deref(),
        Some(today.as_str())
    );
    let durable_messages = context
        .state
        .service
        .list_ai_messages(junban_app::ListAiMessagesRequest {
            session_id: junban_domain::AiSessionId::parse(&session_id).unwrap(),
            after_sequence: None,
            limit: Some(100),
        })
        .await
        .unwrap();
    assert_eq!(durable_messages.len(), 1);
    assert_eq!(
        durable_messages[0].role,
        junban_domain::AiMessageRole::Assistant
    );

    settings.ai.daily_briefing_enabled = false;
    context
        .state
        .service
        .patch_settings(
            OperationId::new(),
            junban_domain::SettingsPatch {
                ai: Some(settings.ai),
                ..junban_domain::SettingsPatch::default()
            },
        )
        .await
        .unwrap();
    let replay = context
        .request(
            operation_header_key(authenticated(Method::POST, &uri), &operation)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(
        ai_sse_envelopes(&response_bytes(replay).await)
            .last()
            .unwrap()["type"],
        "run_completed"
    );
}

#[tokio::test]
async fn regenerate_rewrites_the_turn_and_exactly_replays_without_provider() {
    use tokio::net::TcpListener;

    let context = TestContext::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let fixture = tokio::spawn(async move {
        let (first, _) = listener.accept().await.unwrap();
        let first = fragmented_chat_socket(
            first,
            &[
                "data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n",
                "data: [DONE]\n\n",
            ],
        )
        .await;
        let (second, _) = listener.accept().await.unwrap();
        let second = fragmented_chat_socket(
            second,
            &[
                "data: {\"choices\":[{\"delta\":{\"content\":\"second\"}}]}\n\n",
                "data: [DONE]\n\n",
            ],
        )
        .await;
        (first, second)
    });
    let session_id = configure_loopback_ai_session(&context, address).await;
    let original_operation = Uuid::now_v7().to_string();
    let response_uri = format!("/api/v1/ai/sessions/{session_id}/responses");
    let original = context
        .request(
            operation_header_key(
                authenticated(Method::POST, &response_uri),
                &original_operation,
            )
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({"message":"redo this"}).to_string()))
            .unwrap(),
        )
        .await;
    assert_eq!(original.status(), StatusCode::OK);
    assert_eq!(
        ai_sse_envelopes(&response_bytes(original).await)
            .last()
            .unwrap()["type"],
        "run_completed"
    );
    let original_identity = crate::ai_identity::AiResponseIdentity::derive(
        OperationId::parse(&original_operation).unwrap(),
    );
    let action_operation = Uuid::now_v7().to_string();
    let action_identity = crate::ai_identity::AiResponseIdentity::derive(
        OperationId::parse(&action_operation).unwrap(),
    );
    let action_uri = format!(
        "/api/v1/ai/sessions/{session_id}/messages/{}/regenerate",
        original_identity.assistant_message_id
    );
    let regenerated = context
        .request(
            operation_header_key(authenticated(Method::POST, &action_uri), &action_operation)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await;
    assert_eq!(regenerated.status(), StatusCode::OK);
    assert_eq!(
        ai_sse_envelopes(&response_bytes(regenerated).await)
            .last()
            .unwrap()["type"],
        "run_completed"
    );
    let (first_request, second_request) = fixture.await.unwrap();
    let first_request: Value = serde_json::from_str(&first_request).unwrap();
    let second_request: Value = serde_json::from_str(&second_request).unwrap();
    assert_eq!(first_request["model"], second_request["model"]);
    assert_eq!(first_request["messages"], second_request["messages"]);
    assert_eq!(first_request["tools"], second_request["tools"]);
    assert!(
        first_request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "user" && message["content"] == "redo this")
    );
    assert_eq!(
        context
            .state
            .service
            .ensure_ai_response_current(original_identity.run_id)
            .await
            .unwrap_err(),
        junban_app::AppError::Conflict
    );
    let replacement_user = context
        .state
        .service
        .get_ai_message(action_identity.user_message_id)
        .await
        .unwrap();
    assert_eq!(replacement_user.sequence, 1);
    assert_eq!(replacement_user.content.text, "redo this");
    let replacement_assistant = context
        .state
        .service
        .get_ai_message(action_identity.assistant_message_id)
        .await
        .unwrap();
    assert_eq!(replacement_assistant.sequence, 2);
    assert_eq!(replacement_assistant.content.text, "second");

    let mut settings = context.state.service.get_settings().await.unwrap();
    settings.ai.enabled = false;
    context
        .state
        .service
        .patch_settings(
            OperationId::new(),
            junban_domain::SettingsPatch {
                ai: Some(settings.ai),
                ..junban_domain::SettingsPatch::default()
            },
        )
        .await
        .unwrap();
    let replay = context
        .request(
            operation_header_key(authenticated(Method::POST, &action_uri), &action_operation)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(
        ai_sse_envelopes(&response_bytes(replay).await)
            .last()
            .unwrap()["type"],
        "run_completed"
    );
}

#[tokio::test]
async fn prepared_response_setup_survives_receiver_drop_at_every_barrier() {
    use tokio::net::TcpListener;

    let context = TestContext::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let session_id = configure_loopback_ai_session(&context, listener.local_addr().unwrap()).await;
    let (provider_barrier_tx, mut provider_barrier_rx) =
        mpsc::channel::<tokio::sync::oneshot::Sender<u64>>(4);
    let provider_fixture = tokio::spawn(async move {
        let mut accepted_connections = 0_u64;
        loop {
            tokio::select! {
                biased;
                accepted = listener.accept() => match accepted {
                    Ok((connection, _)) => {
                        accepted_connections += 1;
                        drop(connection);
                    }
                    Err(_) => break,
                },
                barrier = provider_barrier_rx.recv() => match barrier {
                    Some(reply) => {
                        let _ = reply.send(accepted_connections);
                    }
                    None => break,
                },
            }
        }
        accepted_connections
    });
    let mut settings = context.state.service.get_settings().await.unwrap();
    settings.ai.daily_briefing_enabled = true;
    context
        .state
        .service
        .patch_settings(
            OperationId::new(),
            junban_domain::SettingsPatch {
                ai: Some(settings.ai),
                ..junban_domain::SettingsPatch::default()
            },
        )
        .await
        .unwrap();
    let unrelated_id = junban_domain::AiRunId::new();
    let unrelated = context
        .state
        .ai_runtime()
        .admit_run(unrelated_id, 1)
        .unwrap();

    for stage in [
        crate::AiResponseSetupStage::BeforeCommit,
        crate::AiResponseSetupStage::AfterCommit,
        crate::AiResponseSetupStage::AfterAdmission,
    ] {
        context.state.ai_response_setup_test_gate.arm(stage);
        let operation = Uuid::now_v7().to_string();
        let identity =
            crate::ai_identity::AiResponseIdentity::derive(OperationId::parse(&operation).unwrap());
        let uri = format!("/api/v1/ai/sessions/{session_id}/daily-briefing");
        let request = operation_header_key(authenticated(Method::POST, &uri), &operation)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let app = context.app.clone();
        let handler = tokio::spawn(async move { app.oneshot(request).await });
        context
            .state
            .ai_response_setup_test_gate
            .wait_reached()
            .await;
        handler.abort();
        let _ = handler.await;
        context.state.ai_response_setup_test_gate.release();

        let deadline = Instant::now() + Duration::from_secs(2);
        let run = loop {
            match context
                .state
                .service
                .get_ai_run_state(identity.run_id)
                .await
            {
                Ok(run) if run.state.is_terminal() => break run,
                Ok(_) | Err(junban_app::AppError::NotFound) if Instant::now() < deadline => {
                    tokio::task::yield_now().await;
                }
                result => panic!("prepared setup did not terminalize: {result:?}"),
            }
        };
        assert!(matches!(
            run.state,
            junban_domain::AiRunPhase::Cancelled | junban_domain::AiRunPhase::Failed
        ));
        let (reply, accepted) = tokio::sync::oneshot::channel();
        provider_barrier_tx.send(reply).await.unwrap();
        assert_eq!(
            accepted.await.unwrap(),
            0,
            "receiver drop at {stage:?} reached provider transport"
        );
        assert!(
            context
                .state
                .ai_runtime()
                .is_active_generation(unrelated_id, 1),
            "dropping one prepared response must not cancel unrelated runs"
        );
    }
    drop(unrelated);
    drop(provider_barrier_tx);
    assert_eq!(provider_fixture.await.unwrap(), 0);
}
