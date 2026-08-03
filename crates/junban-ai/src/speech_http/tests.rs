use super::*;
use crate::{ProviderErrorKind, SpeechAudio, SpeechAudioFormat, SpeechVoiceId};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use junban_domain::AiSecretKind;
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Notify, oneshot},
};

use super::inworld::INWORLD_TTS_CHAR_MAX;
use super::openai_compatible::{GROQ_TTS_CHAR_MAX, OPENAI_TTS_CHAR_MAX};
use super::shared::contains_secret;

fn credential(kind: AiSecretKind) -> SpeechCredential {
    let secret = match kind {
        AiSecretKind::InworldBasic => BASE64_STANDARD.encode("fixture-basic-secret-not-for-output"),
        AiSecretKind::InworldJwt => "fixture.header.signature".to_owned(),
        AiSecretKind::ApiKey | AiSecretKind::Bearer => "fixture-secret-not-for-output".to_owned(),
    };
    SpeechCredential::new(kind, SecretString::new(secret))
}

fn request(
    provider: SpeechProviderPreset,
    chars: usize,
    format: SpeechAudioFormat,
) -> SynthesisRequest {
    SynthesisRequest::for_rust_adapter(
        provider,
        crate::SynthesisText::new("🦀".repeat(chars)).unwrap(),
        format,
        Some(crate::ModelId::new("canopylabs/orpheus-v1-english").unwrap()),
        Some(SpeechVoiceId::new("alloy").unwrap()),
    )
    .unwrap()
}

#[test]
fn startup_is_lazy_and_credentials_are_redacted() {
    let runtime = SpeechRuntime::new();
    assert!(!runtime.is_client_constructed());
    assert_eq!(runtime.factory().construct_calls(), 0);
    let value = credential(AiSecretKind::Bearer);
    assert!(!format!("{value:?}").contains("fixture-secret"));
}

#[test]
fn provider_validation_precedes_client_construction() {
    let runtime = SpeechRuntime::new();
    let cancel = CancellationToken::new();
    let invalid = request(SpeechProviderPreset::Groq, 201, SpeechAudioFormat::Wav);
    let result = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(runtime.synthesize(&invalid, &credential(AiSecretKind::ApiKey), &cancel));
    assert!(matches!(
        result,
        Err(ProviderError::BoundExceeded {
            bound: "groq_tts_characters"
        })
    ));
    assert_eq!(runtime.factory().construct_calls(), 0);
}

#[tokio::test]
async fn credential_shape_validation_precedes_client_construction() {
    let runtime = SpeechRuntime::new();
    let invalid = SpeechCredential::new(
        AiSecretKind::InworldBasic,
        SecretString::new("not-a-base64-signature"),
    );
    let result = runtime
        .synthesize_at(
            "http://127.0.0.1:9/speech",
            &request(SpeechProviderPreset::Inworld, 1, SpeechAudioFormat::Wav),
            &invalid,
            &CancellationToken::new(),
        )
        .await;
    assert!(matches!(result, Err(ProviderError::Invalid { .. })));
    assert_eq!(runtime.factory().construct_calls(), 0);
}

#[test]
fn unicode_character_caps_are_exact() {
    for (provider, limit, format, kind) in [
        (
            SpeechProviderPreset::OpenAi,
            OPENAI_TTS_CHAR_MAX,
            SpeechAudioFormat::Mp3,
            AiSecretKind::ApiKey,
        ),
        (
            SpeechProviderPreset::Groq,
            GROQ_TTS_CHAR_MAX,
            SpeechAudioFormat::Wav,
            AiSecretKind::Bearer,
        ),
        (
            SpeechProviderPreset::Inworld,
            INWORLD_TTS_CHAR_MAX,
            SpeechAudioFormat::Wav,
            AiSecretKind::InworldJwt,
        ),
    ] {
        assert!(validate_synthesis_request(&request(provider, limit, format), kind).is_ok());
        assert!(matches!(
            validate_synthesis_request(&request(provider, limit + 1, format), kind),
            Err(ProviderError::BoundExceeded { .. })
        ));
    }
}

#[test]
fn active_secret_reflection_is_detected_in_binary_payloads() {
    assert!(contains_secret(
        b"audio-fixture-secret-not-for-output-tail",
        "fixture-secret-not-for-output"
    ));
    assert!(!contains_secret(b"ordinary-audio", "fixture-secret"));
    assert!(contains_secret(b"x", "x"));
}

#[test]
fn provider_format_and_credential_matrices_fail_closed() {
    let groq = request(SpeechProviderPreset::Groq, 1, SpeechAudioFormat::Mp3);
    assert!(validate_synthesis_request(&groq, AiSecretKind::ApiKey).is_err());
    let inworld = request(SpeechProviderPreset::Inworld, 1, SpeechAudioFormat::Wav);
    assert!(validate_synthesis_request(&inworld, AiSecretKind::ApiKey).is_err());
    let audio = SpeechAudio::new(SpeechAudioFormat::Flac, vec![1]).unwrap();
    let openai = TranscriptionRequest::for_rust_adapter(
        SpeechProviderPreset::OpenAi,
        audio,
        Some(crate::ModelId::new("whisper-1").unwrap()),
    )
    .unwrap();
    assert!(validate_transcription_request(&openai, AiSecretKind::ApiKey).is_err());
}

#[tokio::test]
async fn fragmented_loopback_stt_uses_one_multipart_request_and_redacted_auth() {
    let response = br#"{"text":"fragmented transcript"}"#.to_vec();
    let (url, captured, server) = response_fixture(
        "200 OK",
        "application/json; charset=utf-8",
        vec![response[..9].to_vec(), response[9..].to_vec()],
        None,
    )
    .await;
    let runtime = SpeechRuntime::new();
    let request = TranscriptionRequest::for_rust_adapter(
        SpeechProviderPreset::OpenAi,
        SpeechAudio::new(SpeechAudioFormat::Wav, vec![7; 1024]).unwrap(),
        Some(crate::ModelId::new("whisper-1").unwrap()),
    )
    .unwrap();
    let result = runtime
        .transcribe_at(
            &url,
            &request,
            &credential(AiSecretKind::ApiKey),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.text.as_str(), "fragmented transcript");
    let request_bytes = captured.await.unwrap();
    let request_text = String::from_utf8_lossy(&request_bytes);
    assert!(request_text.starts_with("POST /speech HTTP/1.1\r\n"));
    assert_eq!(request_text.matches("name=\"file\"").count(), 1);
    assert_eq!(request_text.matches("name=\"model\"").count(), 1);
    assert!(request_text.contains("authorization: Bearer "));
    let body_start = request_bytes
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .unwrap()
        + 4;
    assert!(!String::from_utf8_lossy(&request_bytes[body_start..]).contains("fixture-secret"));
    assert!(!format!("{result:?}").contains("fixture-secret"));
    server.await.unwrap();
}

#[tokio::test]
async fn raw_and_base64_one_mib_audio_are_bounded_and_fragment_safe() {
    let raw = vec![0x5a; 1024 * 1024];
    let (groq_url, _, groq_server) = response_fixture(
        "200 OK",
        "audio/wav",
        vec![
            raw[..1].to_vec(),
            raw[1..524_289].to_vec(),
            raw[524_289..].to_vec(),
        ],
        None,
    )
    .await;
    let runtime = SpeechRuntime::new();
    let result = runtime
        .synthesize_at(
            &groq_url,
            &request(SpeechProviderPreset::Groq, 2, SpeechAudioFormat::Wav),
            &credential(AiSecretKind::Bearer),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.audio.len(), 1024 * 1024);
    groq_server.await.unwrap();

    let encoded = BASE64_STANDARD.encode(&raw);
    let json = format!(r#"{{"audioContent":"{encoded}","usage":{{}}}}"#).into_bytes();
    let split = json.len() / 2;
    let (inworld_url, captured, inworld_server) = response_fixture(
        "200 OK",
        "application/json",
        vec![
            json[..13].to_vec(),
            json[13..split].to_vec(),
            json[split..].to_vec(),
        ],
        None,
    )
    .await;
    let result = runtime
        .synthesize_at(
            &inworld_url,
            &request(SpeechProviderPreset::Inworld, 2, SpeechAudioFormat::Wav),
            &credential(AiSecretKind::InworldBasic),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.audio.len(), 1024 * 1024);
    let request_bytes = captured.await.unwrap();
    let request_text = String::from_utf8_lossy(&request_bytes);
    assert!(request_text.starts_with("POST /speech HTTP/1.1\r\n"));
    assert!(request_text.contains("authorization: Basic "));
    assert!(request_text.contains("\"audioEncoding\":\"LINEAR16\""));
    inworld_server.await.unwrap();
}

#[tokio::test]
async fn malformed_content_json_base64_oversize_and_redirect_fail_closed() {
    for (status, content_type, body, expected_kind) in [
        (
            "200 OK",
            "text/html",
            br#"{"text":"no"}"#.to_vec(),
            ProviderErrorKind::Stream,
        ),
        (
            "200 OK",
            "application/json",
            b"not-json".to_vec(),
            ProviderErrorKind::Stream,
        ),
        (
            "302 Found",
            "application/json",
            Vec::new(),
            ProviderErrorKind::Stream,
        ),
    ] {
        let extra = (status == "302 Found").then_some("Location: http://127.0.0.1:9/redirect\r\n");
        let (url, _, server) = response_fixture(status, content_type, vec![body], extra).await;
        let request = TranscriptionRequest::for_rust_adapter(
            SpeechProviderPreset::OpenAi,
            SpeechAudio::new(SpeechAudioFormat::Wav, vec![1]).unwrap(),
            Some(crate::ModelId::new("whisper-1").unwrap()),
        )
        .unwrap();
        let error = SpeechRuntime::new()
            .transcribe_at(
                &url,
                &request,
                &credential(AiSecretKind::ApiKey),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.kind(), expected_kind);
        assert!(!error.to_string().contains("fixture-secret"));
        server.await.unwrap();
    }

    let invalid_base64 = br#"{"audioContent":"***"}"#.to_vec();
    let (url, _, server) =
        response_fixture("200 OK", "application/json", vec![invalid_base64], None).await;
    let error = SpeechRuntime::new()
        .synthesize_at(
            &url,
            &request(SpeechProviderPreset::Inworld, 1, SpeechAudioFormat::Wav),
            &credential(AiSecretKind::InworldJwt),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind(), ProviderErrorKind::Stream);
    server.await.unwrap();

    let (url, _, server) = response_fixture(
        "200 OK",
        "audio/wav",
        Vec::new(),
        Some("Content-Length: 26214401\r\n"),
    )
    .await;
    let error = SpeechRuntime::new()
        .synthesize_at(
            &url,
            &request(SpeechProviderPreset::Groq, 1, SpeechAudioFormat::Wav),
            &credential(AiSecretKind::ApiKey),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind(), ProviderErrorKind::BoundExceeded);
    server.await.unwrap();
}

#[tokio::test]
async fn cancellation_aborts_hanging_body_and_timeout_is_typed() {
    let release = Arc::new(Notify::new());
    let (url, headers_sent, server) = hanging_fixture(Arc::clone(&release)).await;
    let runtime = SpeechRuntime::new();
    let request = request(SpeechProviderPreset::Groq, 1, SpeechAudioFormat::Wav);
    let cancel = CancellationToken::new();
    let active_credential = credential(AiSecretKind::ApiKey);
    let future = runtime.synthesize_at(&url, &request, &active_credential, &cancel);
    tokio::pin!(future);
    tokio::select! {
        result = &mut future => panic!("provider ended before hanging response: {result:?}"),
        result = headers_sent => result.unwrap(),
    }
    cancel.cancel();
    assert!(matches!(future.await, Err(ProviderError::Cancelled)));
    release.notify_one();
    server.await.unwrap();

    fn short_timeout_client() -> Result<reqwest::Client, ProviderError> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_millis(20))
            .build()
            .map_err(|error| ProviderError::connect(error.to_string()))
    }
    let release = Arc::new(Notify::new());
    let (url, _, server) = hanging_fixture(Arc::clone(&release)).await;
    let runtime = SpeechRuntime::new();
    runtime.factory().set_test_builder(short_timeout_client);
    let error = runtime
        .synthesize_at(
            &url,
            &request,
            &credential(AiSecretKind::Bearer),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind(), ProviderErrorKind::Timeout);
    release.notify_one();
    server.await.unwrap();
}

async fn response_fixture(
    status: &'static str,
    content_type: &'static str,
    chunks: Vec<Vec<u8>>,
    extra_header: Option<&'static str>,
) -> (
    String,
    oneshot::Receiver<Vec<u8>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (request_tx, request_rx) = oneshot::channel();
    let handle = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_request(&mut stream).await;
        request_tx.send(request).ok();
        let body_len: usize = chunks.iter().map(Vec::len).sum();
        let mut headers =
            format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nConnection: close\r\n");
        if let Some(extra) = extra_header {
            headers.push_str(extra);
        }
        if !headers.to_ascii_lowercase().contains("content-length:") {
            headers.push_str(&format!("Content-Length: {body_len}\r\n"));
        }
        headers.push_str("\r\n");
        stream.write_all(headers.as_bytes()).await.unwrap();
        for chunk in chunks {
            stream.write_all(&chunk).await.unwrap();
            tokio::task::yield_now().await;
        }
    });
    (format!("http://{address}/speech"), request_rx, handle)
}

async fn hanging_fixture(
    release: Arc<Notify>,
) -> (String, oneshot::Receiver<()>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (headers_tx, headers_rx) = oneshot::channel();
    let handle = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let _ = read_request(&mut stream).await;
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: 10\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        headers_tx.send(()).ok();
        release.notified().await;
    });
    (format!("http://{address}/speech"), headers_rx, handle)
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0);
        request.extend_from_slice(&buffer[..read]);
        if let Some(position) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    let content_length = headers
        .lines()
        .find_map(|line| {
            line.split_once(':').and_then(|(name, value)| {
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
        })
        .unwrap_or(0);
    while request.len() < header_end + content_length {
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0);
        request.extend_from_slice(&buffer[..read]);
    }
    request
}
