//! Shared fixed-origin speech HTTP primitives.
//!
//! Only cancellation, bounded body reads, status/content-type checks, secret
//! reflection detection, and credential header construction live here. Provider
//! limits, wire maps, and request shapes stay with their owners.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use junban_domain::AiSecretKind;
use reqwest::{Response, header, header::HeaderValue};
use tokio_util::sync::CancellationToken;

use crate::{ProviderError, SpeechAudioFormat, bearer_authorization_header, sensitive_header};

use super::SpeechCredential;

pub(super) fn speech_authorization(
    credential: &SpeechCredential,
) -> Result<HeaderValue, ProviderError> {
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

pub(super) fn request_provider_credential(
    provider: junban_domain::SpeechProviderPreset,
    credential_kind: AiSecretKind,
    tts: bool,
) -> Result<(), ProviderError> {
    let valid = match provider {
        junban_domain::SpeechProviderPreset::OpenAi | junban_domain::SpeechProviderPreset::Groq => {
            matches!(credential_kind, AiSecretKind::ApiKey | AiSecretKind::Bearer)
        }
        junban_domain::SpeechProviderPreset::Inworld if tts => matches!(
            credential_kind,
            AiSecretKind::InworldBasic | AiSecretKind::InworldJwt
        ),
        junban_domain::SpeechProviderPreset::Browser
        | junban_domain::SpeechProviderPreset::Inworld => false,
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

pub(super) async fn await_cancelled<F>(
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

pub(super) async fn validate_status(
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

pub(super) fn require_json_content_type(response: &Response) -> Result<(), ProviderError> {
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

pub(super) fn require_audio_content_type(
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

pub(super) async fn read_bounded(
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

pub(super) fn contains_secret(bytes: &[u8], secret: &str) -> bool {
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

pub(super) fn check_cancel(cancel: &CancellationToken) -> Result<(), ProviderError> {
    if cancel.is_cancelled() {
        Err(ProviderError::Cancelled)
    } else {
        Ok(())
    }
}
