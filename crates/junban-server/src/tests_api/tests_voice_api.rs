//! Wave 4c cloud speech route, CSP, OpenAPI, and lifecycle API regressions.

use super::*;

#[tokio::test]
async fn cloud_speech_routes_authorize_parse_and_validate_before_egress() {
    let context = TestContext::new();

    // Authentication is resolved before JSON or multipart parsing.
    for (path, content_type, body) in [
        ("/api/v1/voice/speech", "application/json", "{not-json}"),
        (
            "/api/v1/voice/transcriptions",
            "multipart/form-data; boundary=missing",
            "not-multipart",
        ),
    ] {
        let denied = context
            .request(
                request(Method::POST, path)
                    .header(header::CONTENT_TYPE, content_type)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            json(denied).await["error"]["code"],
            "authentication_required"
        );
    }

    let unknown = context
        .request(
            authenticated(Method::POST, "/api/v1/voice/speech")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"text":"hello","model":"caller-controlled"}"#,
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json(unknown).await["error"]["code"], "invalid_json");

    let config = json!({
        "ai": {
            "enabled": false,
            "provider": null,
            "model": null,
            "base_url": null,
            "custom_instructions": "",
            "daily_briefing_enabled": false,
            "default_energy": null,
            "auto_send": false,
            "smart_endpoint": false
        },
        "voice": {
            "cloud_speech_enabled": true,
            "stt_provider": "groq",
            "stt_model": "whisper-large-v3-turbo",
            "tts_provider": "groq",
            "tts_model": "canopylabs/orpheus-v1-english",
            "tts_voice": "autumn",
            "tts_enabled": true,
            "voice_mode": "push_to_talk",
            "grace_period_ms": 1000
        }
    });
    assert_eq!(
        context
            .request(
                operation_header(authenticated(Method::PUT, "/api/v1/ai/config"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(config.to_string()))
                    .unwrap(),
            )
            .await
            .status(),
        StatusCode::OK
    );
    for target in ["voice_stt", "voice_tts"] {
        assert_eq!(
            context
                .request(
                    operation_header(authenticated(
                        Method::PUT,
                        &format!("/api/v1/ai/credentials/{target}"),
                    ))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"kind":"api_key", "secret":format!("{target}-speech-secret")})
                            .to_string(),
                    ))
                    .unwrap(),
                )
                .await
                .status(),
            StatusCode::OK
        );
    }

    // Groq's official 200-character limit counts Unicode scalar values and
    // fails before the lazy HTTP client is constructed.
    let over_chars = context
        .request(
            authenticated(Method::POST, "/api/v1/voice/speech")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({"text":"🦀".repeat(201)}).to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(over_chars.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        json(over_chars).await["error"]["code"],
        "speech_request_invalid"
    );
    assert_eq!(context.state.speech_provider_client_construct_calls(), 0);

    // The neutral allowlist recognizes AAC, but Groq STT does not; provider
    // format validation still happens before secret resolution/client egress.
    let boundary = "speech-route-boundary";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"clip.aac\"\r\nContent-Type: audio/aac\r\n\r\naudio\r\n--{boundary}--\r\n"
    );
    let unsupported = context
        .request(
            authenticated(Method::POST, "/api/v1/voice/transcriptions")
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await;
    assert_eq!(unsupported.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        json(unsupported).await["error"]["code"],
        "speech_request_invalid"
    );
    assert_eq!(context.state.speech_provider_client_construct_calls(), 0);
}

#[tokio::test]
async fn cloud_speech_openapi_csp_and_catalog_authorities_are_exact() {
    const CSP: &str = "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://hf.co https://*.hf.co; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'self'";
    let context = TestContext::new();
    let health = context
        .request(
            request(Method::GET, "/api/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(health.headers()["content-security-policy"], CSP);
    for forbidden in [
        "api.openai.com",
        "api.groq.com",
        "api.inworld.ai",
        "cdn.jsdelivr.net",
        "cdnjs.cloudflare.com",
    ] {
        assert!(!CSP.contains(forbidden));
    }

    let document: Value = serde_json::from_str(&openapi_json()).unwrap();
    assert_eq!(
        document["paths"]["/api/v1/voice/transcriptions"]["post"]["operationId"],
        "create_voice_transcription"
    );
    assert_eq!(
        document["paths"]["/api/v1/voice/speech"]["post"]["operationId"],
        "create_voice_speech"
    );
    let audio_content =
        &document["paths"]["/api/v1/voice/speech"]["post"]["responses"]["200"]["content"];
    assert!(audio_content.get("audio/mpeg").is_some());
    assert!(audio_content.get("audio/wav").is_some());
    assert!(audio_content.get("application/json").is_none());

    let catalog = context
        .request(
            authenticated(Method::GET, "/api/v1/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    let catalog = String::from_utf8(response_bytes(catalog).await).unwrap();
    assert!(!catalog.contains("create_voice_transcription"));
    assert!(!catalog.contains("create_voice_speech"));
}

#[tokio::test]
async fn speech_and_ai_reconfigure_drop_both_lazy_runtimes_even_when_commit_fails() {
    let context = TestContext::new();
    let speech = context
        .state
        .speech_runtime()
        .admit(SpeechActivityKind::Synthesis)
        .unwrap();
    assert!(context.state.speech_runtime().runtime_constructed());
    drop(speech);
    assert_eq!(context.state.pager_release_calls(), 0);
    let serial = Arc::clone(&context.state.ai_reconfigure).lock_owned().await;
    let request_id = RequestId("speech-reconfigure-failure".into());
    let result: Result<(), ApiError> =
        crate::routes_ai::reconfigure_owned(&context.state, &request_id, serial, async {
            Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "fixture_commit_failed",
                "fixture commit failed",
                false,
                &RequestId("fixture-worker".into()),
            ))
        })
        .await;
    assert_eq!(
        result.unwrap_err().envelope.error.code,
        "fixture_commit_failed"
    );
    assert!(!context.state.speech_runtime().runtime_constructed());
    // Commit failure still reaches best-effort pager release after runtime drop.
    assert_eq!(context.state.pager_release_calls(), 1);
    assert_eq!(context.state.allocator_reclaim_calls(), 1);
    let fresh = context
        .state
        .speech_runtime()
        .admit(SpeechActivityKind::Transcription)
        .unwrap();
    assert!(fresh.commit_result(()).is_some());
}

#[tokio::test]
async fn reconfigure_owned_releases_sqlite_pager_only_after_commit_future() {
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

    let context = TestContext::new();
    let seen_release_during_commit = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&seen_release_during_commit);
    let state_for_commit = context.state.clone();

    assert_eq!(context.state.pager_release_calls(), 0);
    assert_eq!(context.state.allocator_reclaim_calls(), 0);

    let serial = Arc::clone(&context.state.ai_reconfigure).lock_owned().await;
    let request_id = RequestId("pager-release-order".into());
    let result: Result<&'static str, ApiError> =
        crate::routes_ai::reconfigure_owned(&context.state, &request_id, serial, async move {
            // Drop already finished (allocator reclaim runs there). Pager release must not.
            assert_eq!(state_for_commit.allocator_reclaim_calls(), 1);
            flag.store(
                state_for_commit.pager_release_calls() > 0,
                AtomicOrdering::SeqCst,
            );
            Ok("committed")
        })
        .await;

    assert_eq!(result.unwrap(), "committed");
    assert!(
        !seen_release_during_commit.load(AtomicOrdering::SeqCst),
        "pager release must run only after the commit future completes"
    );
    assert_eq!(context.state.pager_release_calls(), 1);
    assert_eq!(context.state.allocator_reclaim_calls(), 1);
    // Finish reopened admission: a fresh temporary epoch must begin cleanly.
    let (ai_epoch, speech_epoch) = context.state.begin_ai_speech_reconfigure().unwrap();
    context
        .state
        .drop_ai_speech_reconfigure(ai_epoch, speech_epoch)
        .unwrap();
    context
        .state
        .finish_ai_speech_reconfigure(ai_epoch, speech_epoch)
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn reconfigure_timeout_before_drop_does_not_release_pager() {
    let context = TestContext::new();
    let guard = context
        .state
        .ai_runtime()
        .admit_run(junban_domain::AiRunId::new(), 1)
        .unwrap();

    let serial = Arc::clone(&context.state.ai_reconfigure).lock_owned().await;
    let request_id = RequestId("pager-release-timeout".into());
    let state = context.state.clone();
    let pending = tokio::spawn(async move {
        crate::routes_ai::reconfigure_owned(&state, &request_id, serial, async { Ok(()) }).await
    });

    while guard.is_live() {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(AI_RECONFIGURE_DRAIN_DEADLINE).await;
    tokio::task::yield_now().await;

    let result = pending.await.unwrap();
    assert_eq!(
        result.unwrap_err().envelope.error.code,
        "ai_reconfigure_timeout"
    );
    assert_eq!(context.state.pager_release_calls(), 0);
    assert_eq!(context.state.allocator_reclaim_calls(), 0);
    drop(guard);
}
