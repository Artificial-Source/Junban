//! Bounded fixed-origin cloud speech HTTP adapters.
//!
//! This runtime is deliberately separate from chat. Construction is lazy, every
//! operation performs exactly one request, redirects and ambient proxies are
//! disabled by the shared client policy, and callers cannot supply an endpoint.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use bytes::Bytes;
use futures_util::stream;
use junban_domain::{AiSecretKind, SpeechProviderPreset};
use reqwest::{Response, header, header::HeaderValue};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{
    ModelId, ProviderError, ProviderHttpFactory, SecretString, SpeechAudio, SpeechAudioFormat,
    SynthesisRequest, SynthesisResult, TranscriptionRequest, TranscriptionResult,
    TranscriptionText, bearer_authorization_header, sensitive_header,
};

const OPENAI_ORIGIN: &str = "https://api.openai.com/v1";
const GROQ_ORIGIN: &str = "https://api.groq.com/openai/v1";
const INWORLD_ORIGIN: &str = "https://api.inworld.ai";
const OPENAI_TTS_CHAR_MAX: usize = 4_096;
const GROQ_TTS_CHAR_MAX: usize = 200;
const INWORLD_TTS_CHAR_MAX: usize = 2_000;
/// Inworld's documented decoded synchronous response ceiling.
pub const MAX_INWORLD_AUDIO_BYTES: usize = 16 * 1024 * 1024;
const MAX_INWORLD_BASE64_BYTES: usize = MAX_INWORLD_AUDIO_BYTES.div_ceil(3) * 4;
const MAX_INWORLD_JSON_BYTES: usize = MAX_INWORLD_BASE64_BYTES + 16 * 1024;

/// Credential kind and opaque material used only while constructing one request.
#[derive(Clone)]
pub struct SpeechCredential {
    kind: AiSecretKind,
    secret: SecretString,
}

impl SpeechCredential {
    #[must_use]
    pub fn new(kind: AiSecretKind, secret: SecretString) -> Self {
        Self { kind, secret }
    }

    #[must_use]
    pub const fn kind(&self) -> AiSecretKind {
        self.kind
    }
}

impl std::fmt::Debug for SpeechCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SpeechCredential")
            .field("kind", &self.kind)
            .field("secret", &"[REDACTED]")
            .finish()
    }
}

/// Lazy cloud speech runtime. Default construction creates no HTTP client.
#[derive(Debug, Default)]
pub struct SpeechRuntime {
    factory: ProviderHttpFactory,
}

impl SpeechRuntime {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn factory(&self) -> &ProviderHttpFactory {
        &self.factory
    }

    #[must_use]
    pub fn is_client_constructed(&self) -> bool {
        self.factory.is_client_constructed()
    }

    /// Transcribe through the selected provider's fixed official origin.
    pub async fn transcribe(
        &self,
        request: &TranscriptionRequest,
        credential: &SpeechCredential,
        cancel: &CancellationToken,
    ) -> Result<TranscriptionResult, ProviderError> {
        let url = match request.provider {
            SpeechProviderPreset::OpenAi => format!("{OPENAI_ORIGIN}/audio/transcriptions"),
            SpeechProviderPreset::Groq => format!("{GROQ_ORIGIN}/audio/transcriptions"),
            SpeechProviderPreset::Browser | SpeechProviderPreset::Inworld => {
                return Err(ProviderError::Unavailable {
                    capability: "speech_to_text",
                });
            }
        };
        self.transcribe_at(&url, request, credential, cancel).await
    }

    /// Synthesize through the selected provider's fixed official origin.
    pub async fn synthesize(
        &self,
        request: &SynthesisRequest,
        credential: &SpeechCredential,
        cancel: &CancellationToken,
    ) -> Result<SynthesisResult, ProviderError> {
        let url = match request.provider {
            SpeechProviderPreset::OpenAi => format!("{OPENAI_ORIGIN}/audio/speech"),
            SpeechProviderPreset::Groq => format!("{GROQ_ORIGIN}/audio/speech"),
            SpeechProviderPreset::Inworld => format!("{INWORLD_ORIGIN}/tts/v1/voice"),
            SpeechProviderPreset::Browser => {
                return Err(ProviderError::Unavailable {
                    capability: "rust_speech_adapter",
                });
            }
        };
        self.synthesize_at(&url, request, credential, cancel).await
    }

    async fn transcribe_at(
        &self,
        url: &str,
        request: &TranscriptionRequest,
        credential: &SpeechCredential,
        cancel: &CancellationToken,
    ) -> Result<TranscriptionResult, ProviderError> {
        validate_transcription_request(request, credential.kind())?;
        check_cancel(cancel)?;
        let model = request.model.as_ref().expect("validated model");
        let authorization = speech_authorization(credential)?;
        let (body, content_length, boundary) = transcription_multipart(model, &request.audio);
        let client = self.factory.client()?.clone();
        check_cancel(cancel)?;
        let send = client
            .post(url)
            .header(header::AUTHORIZATION, authorization)
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .header(header::CONTENT_LENGTH, content_length)
            .body(body)
            .send();
        let response = await_cancelled(send, cancel, credential).await?;
        validate_status(&response, cancel, credential).await?;
        require_json_content_type(&response)?;
        let body = read_bounded(response, crate::MAX_PROVIDER_RESPONSE_BYTES, cancel).await?;
        let parsed: TranscriptionWireResponse = serde_json::from_slice(&body)
            .map_err(|_| ProviderError::stream("speech response was not valid JSON"))?;
        if parsed.text.contains(credential.secret.expose()) {
            return Err(ProviderError::stream_failed());
        }
        let text = TranscriptionText::new(parsed.text)?;
        check_cancel(cancel)?;
        Ok(TranscriptionResult::new(text, request.model.clone()))
    }

    async fn synthesize_at(
        &self,
        url: &str,
        request: &SynthesisRequest,
        credential: &SpeechCredential,
        cancel: &CancellationToken,
    ) -> Result<SynthesisResult, ProviderError> {
        validate_synthesis_request(request, credential.kind())?;
        check_cancel(cancel)?;
        let authorization = speech_authorization(credential)?;
        let client = self.factory.client()?.clone();
        let builder = client
            .post(url)
            .header(header::AUTHORIZATION, authorization);

        let response = match request.provider {
            SpeechProviderPreset::OpenAi | SpeechProviderPreset::Groq => {
                let body = OpenAiSpeechRequest {
                    model: request.model.as_ref().expect("validated model").as_str(),
                    input: request.text.as_str(),
                    voice: request.voice.as_ref().expect("validated voice").as_str(),
                    response_format: request.output_format.as_str(),
                };
                await_cancelled(builder.json(&body).send(), cancel, credential).await?
            }
            SpeechProviderPreset::Inworld => {
                let body = InworldSpeechRequest {
                    text: request.text.as_str(),
                    voice_id: request.voice.as_ref().expect("validated voice").as_str(),
                    model_id: request.model.as_ref().expect("validated model").as_str(),
                    audio_config: InworldAudioConfig {
                        audio_encoding: "LINEAR16",
                    },
                };
                await_cancelled(builder.json(&body).send(), cancel, credential).await?
            }
            SpeechProviderPreset::Browser => unreachable!("validated browser provider"),
        };
        validate_status(&response, cancel, credential).await?;

        let audio = if request.provider == SpeechProviderPreset::Inworld {
            require_json_content_type(&response)?;
            let body = read_bounded(response, MAX_INWORLD_JSON_BYTES, cancel).await?;
            let parsed: InworldSpeechResponse = serde_json::from_slice(&body)
                .map_err(|_| ProviderError::stream("speech response was not valid JSON"))?;
            if parsed.audio_content.len() > MAX_INWORLD_BASE64_BYTES {
                return Err(ProviderError::bound("inworld_audio_bytes"));
            }
            let padding = parsed
                .audio_content
                .as_bytes()
                .iter()
                .rev()
                .take_while(|byte| **byte == b'=')
                .count()
                .min(2);
            let decoded_len = parsed
                .audio_content
                .len()
                .div_ceil(4)
                .saturating_mul(3)
                .saturating_sub(padding);
            if decoded_len > MAX_INWORLD_AUDIO_BYTES {
                return Err(ProviderError::bound("inworld_audio_bytes"));
            }
            let bytes = BASE64_STANDARD
                .decode(parsed.audio_content.as_bytes())
                .map_err(|_| ProviderError::stream("speech response audio was not valid base64"))?;
            if contains_secret(&bytes, credential.secret.expose()) {
                return Err(ProviderError::stream_failed());
            }
            if bytes.len() > MAX_INWORLD_AUDIO_BYTES {
                return Err(ProviderError::bound("inworld_audio_bytes"));
            }
            SpeechAudio::new(SpeechAudioFormat::Wav, bytes)?
        } else {
            require_audio_content_type(&response, request.output_format)?;
            let bytes = read_bounded(response, crate::MAX_SPEECH_AUDIO_BYTES, cancel).await?;
            if contains_secret(&bytes, credential.secret.expose()) {
                return Err(ProviderError::stream_failed());
            }
            SpeechAudio::new(request.output_format, bytes)?
        };
        check_cancel(cancel)?;
        Ok(SynthesisResult::new(
            audio,
            request.model.clone(),
            request.voice.clone(),
        ))
    }
}

/// Validate all provider-specific STT rules without constructing a client or
/// resolving secret bytes. The server calls this before private secret lookup.
pub fn validate_transcription_request(
    request: &TranscriptionRequest,
    credential_kind: AiSecretKind,
) -> Result<(), ProviderError> {
    request_provider_credential(request.provider, credential_kind, false)?;
    let _ = request
        .model
        .as_ref()
        .ok_or_else(|| ProviderError::invalid("speech_model", "is required"))?;
    let supported = match request.provider {
        SpeechProviderPreset::OpenAi => matches!(
            request.audio.format(),
            SpeechAudioFormat::Mp3
                | SpeechAudioFormat::Mp4
                | SpeechAudioFormat::Mpeg
                | SpeechAudioFormat::Mpga
                | SpeechAudioFormat::M4a
                | SpeechAudioFormat::Wav
                | SpeechAudioFormat::Webm
        ),
        SpeechProviderPreset::Groq => matches!(
            request.audio.format(),
            SpeechAudioFormat::Flac
                | SpeechAudioFormat::Mp3
                | SpeechAudioFormat::Mp4
                | SpeechAudioFormat::Mpeg
                | SpeechAudioFormat::Mpga
                | SpeechAudioFormat::M4a
                | SpeechAudioFormat::Ogg
                | SpeechAudioFormat::Wav
                | SpeechAudioFormat::Webm
        ),
        SpeechProviderPreset::Browser | SpeechProviderPreset::Inworld => false,
    };
    if !supported {
        return Err(ProviderError::invalid(
            "speech_audio_format",
            "format is not supported by the selected provider",
        ));
    }
    Ok(())
}

/// Validate all provider-specific TTS rules without constructing a client or
/// resolving secret bytes. The server calls this before private secret lookup.
pub fn validate_synthesis_request(
    request: &SynthesisRequest,
    credential_kind: AiSecretKind,
) -> Result<(), ProviderError> {
    request_provider_credential(request.provider, credential_kind, true)?;
    let _ = request
        .model
        .as_ref()
        .ok_or_else(|| ProviderError::invalid("speech_model", "is required"))?;
    let _ = request
        .voice
        .as_ref()
        .ok_or_else(|| ProviderError::invalid("speech_voice", "is required"))?;
    let chars = request.text.as_str().chars().count();
    match request.provider {
        SpeechProviderPreset::OpenAi => {
            if chars > OPENAI_TTS_CHAR_MAX {
                return Err(ProviderError::bound("openai_tts_characters"));
            }
            if !matches!(
                request.output_format,
                SpeechAudioFormat::Mp3
                    | SpeechAudioFormat::Opus
                    | SpeechAudioFormat::Aac
                    | SpeechAudioFormat::Flac
                    | SpeechAudioFormat::Wav
                    | SpeechAudioFormat::Pcm
            ) {
                return Err(ProviderError::invalid(
                    "speech_audio_format",
                    "format is not supported by the selected provider",
                ));
            }
        }
        SpeechProviderPreset::Groq => {
            if chars > GROQ_TTS_CHAR_MAX {
                return Err(ProviderError::bound("groq_tts_characters"));
            }
            if request.output_format != SpeechAudioFormat::Wav {
                return Err(ProviderError::invalid(
                    "speech_audio_format",
                    "Groq speech supports wav only",
                ));
            }
        }
        SpeechProviderPreset::Inworld => {
            if chars > INWORLD_TTS_CHAR_MAX {
                return Err(ProviderError::bound("inworld_tts_characters"));
            }
            if request.output_format != SpeechAudioFormat::Wav {
                return Err(ProviderError::invalid(
                    "speech_audio_format",
                    "Inworld synchronous speech uses wav output",
                ));
            }
        }
        SpeechProviderPreset::Browser => {
            return Err(ProviderError::Unavailable {
                capability: "rust_speech_adapter",
            });
        }
    }
    Ok(())
}

fn speech_authorization(credential: &SpeechCredential) -> Result<HeaderValue, ProviderError> {
    match credential.kind {
        AiSecretKind::ApiKey | AiSecretKind::Bearer => {
            bearer_authorization_header(credential.secret.expose()).map(|(_, value)| value)
        }
        AiSecretKind::InworldBasic => {
            let raw = credential.secret.expose();
            if raw.is_empty()
                || raw.chars().any(char::is_whitespace)
                || !BASE64_STANDARD
                    .decode(raw.as_bytes())
                    .is_ok_and(|decoded| !decoded.is_empty())
            {
                return Err(ProviderError::invalid(
                    "speech_credential",
                    "Inworld Basic credential must be a nonempty Base64 signature",
                ));
            }
            sensitive_header(&format!("Basic {raw}"))
        }
        AiSecretKind::InworldJwt => {
            let raw = credential.secret.expose();
            if raw.split('.').count() != 3
                || raw.split('.').any(|part| part.is_empty())
                || raw
                    .chars()
                    .any(|ch| !(ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.')))
            {
                return Err(ProviderError::invalid(
                    "speech_credential",
                    "Inworld JWT credential was invalid",
                ));
            }
            bearer_authorization_header(raw).map(|(_, value)| value)
        }
    }
}

fn request_provider_credential(
    provider: SpeechProviderPreset,
    credential_kind: AiSecretKind,
    tts: bool,
) -> Result<(), ProviderError> {
    let valid = match provider {
        SpeechProviderPreset::OpenAi | SpeechProviderPreset::Groq => {
            matches!(credential_kind, AiSecretKind::ApiKey | AiSecretKind::Bearer)
        }
        SpeechProviderPreset::Inworld if tts => matches!(
            credential_kind,
            AiSecretKind::InworldBasic | AiSecretKind::InworldJwt
        ),
        SpeechProviderPreset::Browser | SpeechProviderPreset::Inworld => false,
    };
    if valid {
        Ok(())
    } else {
        Err(ProviderError::invalid(
            "speech_credential_kind",
            "is not accepted by the selected provider",
        ))
    }
}

fn transcription_multipart(model: &ModelId, audio: &SpeechAudio) -> (reqwest::Body, usize, String) {
    let boundary = format!("junban-speech-{}", uuid::Uuid::new_v4().simple());
    let prefix = Bytes::from(format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.{}\"\r\nContent-Type: {}\r\n\r\n",
        model.as_str(),
        audio.format().as_str(),
        audio.content_type(),
    ));
    let suffix = Bytes::from(format!("\r\n--{boundary}--\r\n"));
    let content_length = prefix.len() + audio.len() + suffix.len();
    let chunks = vec![prefix, audio.bytes(), suffix]
        .into_iter()
        .map(Ok::<Bytes, std::io::Error>);
    (
        reqwest::Body::wrap_stream(stream::iter(chunks)),
        content_length,
        boundary,
    )
}

async fn await_cancelled<F>(
    future: F,
    cancel: &CancellationToken,
    credential: &SpeechCredential,
) -> Result<Response, ProviderError>
where
    F: std::future::Future<Output = Result<Response, reqwest::Error>>,
{
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(ProviderError::Cancelled),
        result = future => result.map_err(|error| {
            let mapped = if error.is_timeout() {
                ProviderError::Timeout
            } else {
                ProviderError::connect(error.to_string())
            };
            mapped.scrub_secret(credential.secret.expose())
        }),
    }
}

async fn validate_status(
    response: &Response,
    cancel: &CancellationToken,
    credential: &SpeechCredential,
) -> Result<(), ProviderError> {
    let status = response.status();
    if status.is_redirection() {
        return Err(ProviderError::stream("refusing speech HTTP redirect"));
    }
    if status.is_success() {
        return Ok(());
    }
    let retry_after_ms = response
        .headers()
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(crate::parse_retry_after)
        .map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX));
    // Speech never retries and never retains arbitrary provider error bodies.
    check_cancel(cancel)?;
    Err(ProviderError::http_status(status.as_u16(), retry_after_ms)
        .scrub_secret(credential.secret.expose()))
}

fn require_json_content_type(response: &Response) -> Result<(), ProviderError> {
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ProviderError::stream("speech response content type was missing"))?;
    let media_type = content_type.split(';').next().unwrap_or("").trim();
    if media_type.eq_ignore_ascii_case("application/json") {
        Ok(())
    } else {
        Err(ProviderError::stream(
            "speech response content type was invalid",
        ))
    }
}

fn require_audio_content_type(
    response: &Response,
    format: SpeechAudioFormat,
) -> Result<(), ProviderError> {
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ProviderError::stream("speech response content type was missing"))?;
    let media_type = content_type.split(';').next().unwrap_or("").trim();
    let valid = match format {
        SpeechAudioFormat::Mp3 => matches!(media_type, "audio/mpeg" | "audio/mp3"),
        SpeechAudioFormat::Wav => matches!(media_type, "audio/wav" | "audio/x-wav"),
        _ => media_type == format.content_type(),
    };
    if valid {
        Ok(())
    } else {
        Err(ProviderError::stream(
            "speech response content type was invalid",
        ))
    }
}

async fn read_bounded(
    mut response: Response,
    max: usize,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, ProviderError> {
    let content_length = response.content_length();
    if content_length.is_some_and(|length| length > max as u64) {
        return Err(ProviderError::bound("speech_response_bytes"));
    }
    let capacity = content_length
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or(0);
    let mut collected = Vec::with_capacity(capacity);
    loop {
        let chunk = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ProviderError::Cancelled),
            chunk = response.chunk() => chunk.map_err(|error| {
                if error.is_timeout() { ProviderError::Timeout } else { ProviderError::stream_failed() }
            })?,
        };
        let Some(chunk) = chunk else { break };
        if collected.len().saturating_add(chunk.len()) > max {
            return Err(ProviderError::bound("speech_response_bytes"));
        }
        collected.extend_from_slice(&chunk);
    }
    Ok(collected)
}

fn contains_secret(bytes: &[u8], secret: &str) -> bool {
    let secret = secret.as_bytes();
    if secret.is_empty() || secret.len() > bytes.len() {
        return false;
    }
    // Linear-time KMP avoids making malicious binary responses a prefix-heavy
    // quadratic scan while still refusing active-credential reflection.
    let mut prefix = vec![0_usize; secret.len()];
    let mut matched = 0;
    for index in 1..secret.len() {
        while matched > 0 && secret[index] != secret[matched] {
            matched = prefix[matched - 1];
        }
        if secret[index] == secret[matched] {
            matched += 1;
            prefix[index] = matched;
        }
    }
    matched = 0;
    for byte in bytes {
        while matched > 0 && *byte != secret[matched] {
            matched = prefix[matched - 1];
        }
        if *byte == secret[matched] {
            matched += 1;
            if matched == secret.len() {
                return true;
            }
        }
    }
    false
}

fn check_cancel(cancel: &CancellationToken) -> Result<(), ProviderError> {
    if cancel.is_cancelled() {
        Err(ProviderError::Cancelled)
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
struct TranscriptionWireResponse {
    text: String,
}

#[derive(Serialize)]
struct OpenAiSpeechRequest<'a> {
    model: &'a str,
    input: &'a str,
    voice: &'a str,
    response_format: &'a str,
}

#[derive(Serialize)]
struct InworldSpeechRequest<'a> {
    text: &'a str,
    #[serde(rename = "voiceId")]
    voice_id: &'a str,
    #[serde(rename = "modelId")]
    model_id: &'a str,
    #[serde(rename = "audioConfig")]
    audio_config: InworldAudioConfig,
}

#[derive(Serialize)]
struct InworldAudioConfig {
    #[serde(rename = "audioEncoding")]
    audio_encoding: &'static str,
}

#[derive(Deserialize)]
struct InworldSpeechResponse {
    #[serde(rename = "audioContent")]
    audio_content: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ProviderErrorKind, SpeechVoiceId};
    use std::{sync::Arc, time::Duration};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::{Notify, oneshot},
    };

    fn credential(kind: AiSecretKind) -> SpeechCredential {
        let secret = match kind {
            AiSecretKind::InworldBasic => {
                BASE64_STANDARD.encode("fixture-basic-secret-not-for-output")
            }
            AiSecretKind::InworldJwt => "fixture.header.signature".to_owned(),
            AiSecretKind::ApiKey | AiSecretKind::Bearer => {
                "fixture-secret-not-for-output".to_owned()
            }
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
            Some(ModelId::new("canopylabs/orpheus-v1-english").unwrap()),
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
            Some(ModelId::new("whisper-1").unwrap()),
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
            Some(ModelId::new("whisper-1").unwrap()),
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
            let extra =
                (status == "302 Found").then_some("Location: http://127.0.0.1:9/redirect\r\n");
            let (url, _, server) = response_fixture(status, content_type, vec![body], extra).await;
            let request = TranscriptionRequest::for_rust_adapter(
                SpeechProviderPreset::OpenAi,
                SpeechAudio::new(SpeechAudioFormat::Wav, vec![1]).unwrap(),
                Some(ModelId::new("whisper-1").unwrap()),
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
            let mut headers = format!(
                "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nConnection: close\r\n"
            );
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
}
