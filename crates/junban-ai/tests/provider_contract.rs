//! Wave 0 provider-contract spike tests against a deterministic loopback mock.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use junban_ai::{
    MAX_PROVIDER_RESPONSE_BYTES, MAX_PROVIDER_STREAM_FRAME_BYTES, MAX_RETRY_AFTER,
    NormalizedStreamEvent, ProviderError, ProviderHttpFactory, RequestBodyPhase, RetryDecision,
    RunCancel, bearer_authorization_header, classify_retry, consume_openai_compatible_sse,
    redact_sensitive,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

#[tokio::test]
async fn default_factory_has_zero_client_construction() {
    let factory = ProviderHttpFactory::new();
    assert!(!factory.is_client_constructed());
    assert_eq!(factory.construct_calls(), 0);

    // Constructing the crate surface must not build a client either.
    let _run = RunCancel::new();
    assert!(!factory.is_client_constructed());
}

#[tokio::test]
async fn fragmented_openai_sse_normalizes_across_utf8_and_chunk_boundaries() {
    // "世界" = e4 b8 96 e7 95 8c — deliberately split mid-codepoint across TCP writes.
    let body = b"data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"content\":\"\xe4\xb8\x96\xe7\x95\x8c\"}}]}\n\n\
data: [DONE]\n\n";

    let chunks = split_body_mid_utf8(body);
    let url = spawn_chunked_sse_server(chunks, Duration::from_millis(5)).await;

    let factory = ProviderHttpFactory::new();
    assert!(!factory.is_client_constructed());
    let client = factory.client().expect("lazy client");
    assert!(factory.is_client_constructed());
    assert_eq!(factory.construct_calls(), 1);

    let (header_name, header_value) =
        bearer_authorization_header("test-secret-key-not-for-logs").unwrap();
    assert!(header_value.is_sensitive());

    let run = RunCancel::new();
    let response = client
        .post(format!("{url}/v1/chat/completions"))
        .header(header_name, header_value)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .body("{}")
        .send()
        .await
        .expect("mock response");

    let events = consume_openai_compatible_sse(response, &run)
        .await
        .expect("normalized stream");

    assert_eq!(
        events,
        vec![
            NormalizedStreamEvent::RunStarted,
            NormalizedStreamEvent::TextDelta {
                text: "Hello ".into()
            },
            NormalizedStreamEvent::TextDelta {
                text: "世界".into()
            },
            NormalizedStreamEvent::Completed,
        ]
    );
}

#[tokio::test]
async fn rejects_malformed_unknown_and_oversized_frames() {
    // Unknown SSE field.
    let url = spawn_chunked_sse_server(vec![b"foo: bar\n\n".to_vec()], Duration::ZERO).await;
    let err = stream_url(&url).await.unwrap_err();
    assert!(
        matches!(err, ProviderError::Stream { .. }),
        "expected stream error, got {err:?}"
    );

    // Unknown JSON frame shape.
    let url =
        spawn_chunked_sse_server(vec![b"data: {\"nope\":true}\n\n".to_vec()], Duration::ZERO).await;
    let err = stream_url(&url).await.unwrap_err();
    assert!(
        matches!(err, ProviderError::Stream { .. }),
        "expected unknown frame rejection, got {err:?}"
    );

    // Oversized single frame.
    let oversized = format!(
        "data: {}\n\n",
        "x".repeat(MAX_PROVIDER_STREAM_FRAME_BYTES + 8)
    );
    let url = spawn_chunked_sse_server(vec![oversized.into_bytes()], Duration::ZERO).await;
    let err = stream_url(&url).await.unwrap_err();
    assert!(
        matches!(
            err,
            ProviderError::BoundExceeded {
                bound: "provider_stream_frame_bytes"
            }
        ),
        "expected frame bound error, got {err:?}"
    );

    // Oversized complete response (many small frames).
    let mut huge = String::new();
    while huge.len() <= MAX_PROVIDER_RESPONSE_BYTES {
        huge.push_str("data: {\"choices\":[{\"delta\":{\"content\":\"aaaaaaaa\"}}]}\n\n");
    }
    let url = spawn_chunked_sse_server(vec![huge.into_bytes()], Duration::ZERO).await;
    let err = stream_url(&url).await.unwrap_err();
    assert!(
        matches!(
            err,
            ProviderError::BoundExceeded {
                bound: "provider_response_bytes"
            }
        ),
        "expected response bound error, got {err:?}"
    );
}

#[tokio::test]
async fn done_terminates_and_timeout_maps_cleanly() {
    let url = spawn_chunked_sse_server(vec![b"data: [DONE]\n\n".to_vec()], Duration::ZERO).await;
    let events = stream_url(&url).await.expect("done stream");
    assert_eq!(events, vec![NormalizedStreamEvent::Completed]);

    // Server accepts then never writes the body.
    let url = spawn_hanging_body_server().await;
    let factory = ProviderHttpFactory::new();
    let client = factory.client().unwrap();
    let run = RunCancel::new();
    let result = tokio::time::timeout(Duration::from_millis(200), async {
        let response = client
            .get(format!("{url}/hang"))
            .timeout(Duration::from_millis(50))
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    ProviderError::Timeout
                } else {
                    ProviderError::connect(error.to_string())
                }
            })?;
        consume_openai_compatible_sse(response, &run).await
    })
    .await;

    match result {
        Ok(Err(ProviderError::Timeout)) => {}
        Ok(other) => panic!("expected timeout error, got {other:?}"),
        Err(_) => panic!("test harness timed out waiting for provider timeout"),
    }
}

#[tokio::test]
async fn cancel_stops_stream_before_late_effects() {
    let (gate_tx, gate_rx) = oneshot::channel::<()>();
    let url = spawn_gated_sse_server(gate_rx).await;

    let factory = ProviderHttpFactory::new();
    let client = factory.client().unwrap().clone();
    let run = Arc::new(RunCancel::new());
    let generation = run.generation();

    let run_for_task = Arc::clone(&run);
    let join = tokio::spawn(async move {
        let response = client
            .get(format!("{url}/stream"))
            .send()
            .await
            .expect("headers");
        consume_openai_compatible_sse(response, &run_for_task).await
    });

    // Allow the handler to emit the first event, then cancel before late bytes.
    tokio::time::sleep(Duration::from_millis(30)).await;
    run.cancel();
    let _ = gate_tx.send(());

    let err = join.await.expect("task").expect_err("cancelled");
    assert!(matches!(err, ProviderError::Cancelled));
    assert!(!run.is_live());
    assert!(run.token().is_cancelled());
    // The handle's captured generation is no longer authoritative after revoke.
    assert_eq!(run.generation(), generation);
    assert!(matches!(run.check_live(), Err(ProviderError::Cancelled)));
}

#[tokio::test]
async fn no_retry_after_body_acceptance_and_retry_after_is_capped() {
    let pre_body = ProviderError::http_status(429, Some(120_000));
    assert_eq!(
        classify_retry(RequestBodyPhase::PreBody, &pre_body, 1),
        RetryDecision::RetryAfter(MAX_RETRY_AFTER)
    );

    let after_body = ProviderError::connect("reset after accept");
    assert_eq!(
        classify_retry(RequestBodyPhase::BodyAccepted, &after_body, 1),
        RetryDecision::DoNotRetry
    );

    // End-to-end: once a body chunk is accepted mid-stream, classify as non-retryable.
    let url = spawn_chunked_sse_server(
        vec![
            b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n".to_vec(),
            // Malformed trailing frame after body acceptance.
            b"data: {\"nope\":true}\n\n".to_vec(),
        ],
        Duration::from_millis(5),
    )
    .await;
    let err = stream_url(&url).await.unwrap_err();
    assert_eq!(
        classify_retry(RequestBodyPhase::BodyAccepted, &err, 1),
        RetryDecision::DoNotRetry
    );
}

#[tokio::test]
async fn sensitive_error_redaction_strips_secrets() {
    let message =
        "upstream 401 for Authorization Bearer sk-live-super-secret and api_key=abcdEFGH1234";
    let error = ProviderError::connect(message);
    let display = error.to_string();
    let debug = format!("{error:?}");
    assert!(!display.contains("sk-live-super-secret"));
    assert!(!debug.contains("sk-live-super-secret"));
    assert!(!display.contains("abcdEFGH1234"));
    assert!(!debug.contains("abcdEFGH1234"));
    assert!(redact_sensitive(message).contains("[REDACTED]"));

    let (_name, value) = bearer_authorization_header("sk-live-super-secret").unwrap();
    assert!(value.is_sensitive());
    assert!(!format!("{value:?}").contains("sk-live-super-secret"));
}

async fn stream_url(url: &str) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
    let factory = ProviderHttpFactory::new();
    let client = factory.client()?;
    let run = RunCancel::new();
    let response = client
        .get(format!("{url}/v1/chat/completions"))
        .send()
        .await
        .map_err(|error| ProviderError::connect(error.to_string()))?;
    consume_openai_compatible_sse(response, &run).await
}

fn split_body_mid_utf8(body: &[u8]) -> Vec<Vec<u8>> {
    // Fixed awkward splits including mid-multibyte boundaries.
    let mut chunks = Vec::new();
    let mut index = 0;
    let pattern = [1usize, 2, 3, 5, 8, 13, 21, 34, 55];
    let mut step = 0;
    while index < body.len() {
        let width = pattern[step % pattern.len()].min(body.len() - index);
        chunks.push(body[index..index + width].to_vec());
        index += width;
        step += 1;
    }
    chunks
}

async fn spawn_chunked_sse_server(chunks: Vec<Vec<u8>>, delay: Duration) -> String {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut buf = vec![0u8; 4096];
        let _ = socket.read(&mut buf).await;
        let header =
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
        if socket.write_all(header).await.is_err() {
            return;
        }
        for chunk in chunks {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            if socket.write_all(&chunk).await.is_err() {
                return;
            }
            let _ = socket.flush().await;
        }
    });
    format!("http://{addr}")
}

async fn spawn_hanging_body_server() -> String {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut buf = vec![0u8; 4096];
        let _ = socket.read(&mut buf).await;
        let header = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
        let _ = socket.write_all(header).await;
        // Never write body chunks; hold the connection until client times out.
        tokio::time::sleep(Duration::from_secs(5)).await;
    });
    format!("http://{addr}")
}

async fn spawn_gated_sse_server(gate: oneshot::Receiver<()>) -> String {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut buf = vec![0u8; 4096];
        let _ = socket.read(&mut buf).await;
        let header =
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
        if socket.write_all(header).await.is_err() {
            return;
        }
        let first = b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n";
        if socket.write_all(first).await.is_err() {
            return;
        }
        let _ = socket.flush().await;
        let _ = gate.await;
        // Late effect that must not be applied after cancel.
        let late = b"data: {\"choices\":[{\"delta\":{\"content\":\"LATE\"}}]}\n\ndata: [DONE]\n\n";
        let _ = socket.write_all(late).await;
    });
    format!("http://{addr}")
}
