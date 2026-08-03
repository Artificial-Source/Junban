//! Operator-only bounded cloud speech routes.

use axum::{
    Json,
    body::Bytes,
    extract::{
        Extension, State,
        rejection::{BytesRejection, JsonRejection},
    },
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use junban_ai::{
    ModelId, ProviderError, ProviderErrorKind, SecretString, SpeechAudio, SpeechAudioFormat,
    SpeechCredential, SpeechVoiceId, SynthesisRequest, SynthesisText, TranscriptionRequest,
    validate_synthesis_request, validate_transcription_request,
};
use junban_app::AppError;
use junban_domain::{AiCredentialId, AiSecretMetadata, SpeechProviderPreset};
use serde::{Deserialize, Serialize};
use utoipa::{
    PartialSchema, ToSchema,
    openapi::{
        RefOr,
        schema::{KnownFormat, ObjectBuilder, Schema, SchemaFormat, Type},
    },
};

use crate::{
    MAX_SPEECH_MULTIPART_BODY_BYTES, MAX_SPEECH_SYNTHESIS_BODY_BYTES, RequestId, ServerState,
    SpeechActivityKind,
    error::{ApiError, extract_json_with_limit},
};

#[derive(Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TranscriptionResponse {
    pub text: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SpeechSynthesisRequest {
    pub text: String,
}

/// OpenAPI-only strict multipart shape. Runtime parsing enforces exactly this
/// one field, its media type, and the independent 25 MiB payload ceiling.
#[allow(dead_code)]
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SpeechTranscriptionMultipart {
    #[schema(value_type = String, format = Binary)]
    pub audio: Vec<u8>,
}

/// OpenAPI-only binary response marker.
pub struct SpeechBinaryResponse;

impl PartialSchema for SpeechBinaryResponse {
    fn schema() -> RefOr<Schema> {
        ObjectBuilder::new()
            .schema_type(Type::String)
            .format(Some(SchemaFormat::KnownFormat(KnownFormat::Binary)))
            .into()
    }
}

impl ToSchema for SpeechBinaryResponse {}

#[utoipa::path(
    post,
    path = "/api/v1/voice/transcriptions",
    operation_id = "create_voice_transcription",
    request_body(content = SpeechTranscriptionMultipart, content_type = "multipart/form-data"),
    responses(
        (status = 200, body = TranscriptionResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 415, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn create_voice_transcription(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<TranscriptionResponse>, ApiError> {
    let body = body.map_err(|_| body_too_large(&request_id))?;
    if body.len() > MAX_SPEECH_MULTIPART_BODY_BYTES {
        return Err(body_too_large(&request_id));
    }
    let (format, audio) = parse_audio_multipart(&headers, &body, &request_id)?;
    let serial = state.ai_reconfigure.lock().await;
    let settings = state
        .service
        .get_settings()
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let voice = &settings.voice;
    if !voice.cloud_speech_enabled {
        return Err(config_error(
            "confirmed cloud speech is disabled",
            &request_id,
        ));
    }
    let provider = voice.stt_provider;
    if !matches!(
        provider,
        SpeechProviderPreset::OpenAi | SpeechProviderPreset::Groq
    ) {
        return Err(config_error(
            "confirmed provider does not support server transcription",
            &request_id,
        ));
    }
    let model = voice.stt_model.as_ref().ok_or_else(|| {
        config_error(
            "confirmed speech transcription model is unavailable",
            &request_id,
        )
    })?;
    let credential_id = voice.stt_credential_id.ok_or_else(|| {
        config_error(
            "confirmed speech transcription credential is unavailable",
            &request_id,
        )
    })?;
    let metadata = credential_metadata(&state, credential_id, &request_id).await?;
    let request = TranscriptionRequest::for_rust_adapter(
        provider,
        SpeechAudio::from_bytes(format, audio).map_err(|error| speech_error(error, &request_id))?,
        Some(ModelId::new(model.as_str()).map_err(|error| speech_error(error, &request_id))?),
    )
    .map_err(|error| speech_error(error, &request_id))?;
    // Provider, model, format, size, and credential kind are all validated
    // before private secret resolution or client construction.
    validate_transcription_request(&request, metadata.kind)
        .map_err(|error| speech_error(error, &request_id))?;
    let secret = resolve_secret(&state, credential_id, &request_id).await?;
    let credential = SpeechCredential::new(metadata.kind, SecretString::new(secret.expose()));
    let guard = state
        .speech_runtime()
        .admit(SpeechActivityKind::Transcription)
        .map_err(|error| speech_runtime_error(error, &request_id))?;
    // Admission remains serialized with confirmed config resolution; provider I/O does not.
    drop(serial);
    let result = guard
        .transcribe(&request, &credential)
        .await
        .map_err(|error| speech_error(error, &request_id))?;
    let result = guard
        .commit_result(result)
        .ok_or_else(|| speech_cancelled(&request_id))?;
    Ok(Json(TranscriptionResponse {
        text: result.text.into_string(),
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/voice/speech",
    operation_id = "create_voice_speech",
    request_body = SpeechSynthesisRequest,
    responses(
        (status = 200, description = "Canonical provider audio", content(
            (SpeechBinaryResponse = "audio/mpeg"),
            (SpeechBinaryResponse = "audio/wav")
        )),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 415, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn create_voice_speech(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    payload: Result<Json<SpeechSynthesisRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let payload = extract_json_with_limit(payload, &request_id, MAX_SPEECH_SYNTHESIS_BODY_BYTES)?;
    let text =
        SynthesisText::new(payload.text).map_err(|error| speech_error(error, &request_id))?;
    let serial = state.ai_reconfigure.lock().await;
    let settings = state
        .service
        .get_settings()
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let voice = &settings.voice;
    if !voice.cloud_speech_enabled || !voice.tts_enabled {
        return Err(config_error(
            "confirmed cloud speech synthesis is disabled",
            &request_id,
        ));
    }
    let provider = voice.tts_provider;
    if provider == SpeechProviderPreset::Browser {
        return Err(config_error(
            "browser speech is not available through the server route",
            &request_id,
        ));
    }
    let model = voice.tts_model.as_ref().ok_or_else(|| {
        config_error(
            "confirmed speech synthesis model is unavailable",
            &request_id,
        )
    })?;
    let voice_id = voice.tts_voice.as_ref().ok_or_else(|| {
        config_error(
            "confirmed speech synthesis voice is unavailable",
            &request_id,
        )
    })?;
    let credential_id = voice.tts_credential_id.ok_or_else(|| {
        config_error(
            "confirmed speech synthesis credential is unavailable",
            &request_id,
        )
    })?;
    let metadata = credential_metadata(&state, credential_id, &request_id).await?;
    let output_format = match provider {
        SpeechProviderPreset::OpenAi => SpeechAudioFormat::Mp3,
        SpeechProviderPreset::Groq | SpeechProviderPreset::Inworld => SpeechAudioFormat::Wav,
        SpeechProviderPreset::Browser => unreachable!("browser provider rejected above"),
    };
    let request = SynthesisRequest::for_rust_adapter(
        provider,
        text,
        output_format,
        Some(ModelId::new(model.as_str()).map_err(|error| speech_error(error, &request_id))?),
        Some(
            SpeechVoiceId::new(voice_id.clone())
                .map_err(|error| speech_error(error, &request_id))?,
        ),
    )
    .map_err(|error| speech_error(error, &request_id))?;
    // Includes the provider's Unicode scalar-value cap before secret lookup.
    validate_synthesis_request(&request, metadata.kind)
        .map_err(|error| speech_error(error, &request_id))?;
    let secret = resolve_secret(&state, credential_id, &request_id).await?;
    let credential = SpeechCredential::new(metadata.kind, SecretString::new(secret.expose()));
    let guard = state
        .speech_runtime()
        .admit(SpeechActivityKind::Synthesis)
        .map_err(|error| speech_runtime_error(error, &request_id))?;
    drop(serial);
    let result = guard
        .synthesize(&request, &credential)
        .await
        .map_err(|error| speech_error(error, &request_id))?;
    let result = guard
        .commit_result(result)
        .ok_or_else(|| speech_cancelled(&request_id))?;
    Ok(synthesis_response(result.audio))
}

fn synthesis_response(audio: SpeechAudio) -> Response {
    let content_type = audio.content_type();
    let content_length = audio.len();
    let mut response = audio.into_bytes().into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&content_length.to_string())
            .expect("bounded content length is a valid header"),
    );
    response
}

async fn credential_metadata(
    state: &ServerState,
    credential_id: AiCredentialId,
    request_id: &RequestId,
) -> Result<AiSecretMetadata, ApiError> {
    state
        .service
        .list_ai_secret_metadata()
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?
        .into_iter()
        .find(|metadata| metadata.id == credential_id)
        .ok_or_else(|| stale_credential(request_id))
}

async fn resolve_secret(
    state: &ServerState,
    credential_id: AiCredentialId,
    request_id: &RequestId,
) -> Result<junban_app::AiSecretBytes, ApiError> {
    state
        .service
        .resolve_ai_secret(credential_id)
        .await
        .map_err(|error| match error {
            AppError::NotFound => stale_credential(request_id),
            other => ApiError::from_app(other, request_id),
        })
}

fn parse_audio_multipart(
    headers: &HeaderMap,
    body: &Bytes,
    request_id: &RequestId,
) -> Result<(SpeechAudioFormat, Bytes), ApiError> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| unsupported_media_type(request_id))?;
    let boundary =
        parse_boundary(content_type).ok_or_else(|| unsupported_media_type(request_id))?;
    if boundary.is_empty() || boundary.len() > 70 || !boundary.bytes().all(is_boundary_byte) {
        return Err(unsupported_media_type(request_id));
    }
    let opening = format!("--{boundary}\r\n").into_bytes();
    if !body.starts_with(&opening) {
        return Err(invalid_multipart(request_id));
    }
    let rest = &body[opening.len()..];
    let header_end = find_bytes(rest, b"\r\n\r\n").ok_or_else(|| invalid_multipart(request_id))?;
    if header_end > 8 * 1024 {
        return Err(invalid_multipart(request_id));
    }
    let raw_headers =
        std::str::from_utf8(&rest[..header_end]).map_err(|_| invalid_multipart(request_id))?;
    let mut disposition = None;
    let mut part_content_type = None;
    for line in raw_headers.split("\r\n") {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| invalid_multipart(request_id))?;
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-disposition") && disposition.is_none() {
            disposition = Some(value);
        } else if name.eq_ignore_ascii_case("content-type") && part_content_type.is_none() {
            part_content_type = Some(value);
        } else {
            return Err(invalid_multipart(request_id));
        }
    }
    let disposition = disposition.ok_or_else(|| invalid_multipart(request_id))?;
    if !valid_audio_disposition(disposition) {
        return Err(invalid_multipart(request_id));
    }
    let part_content_type = part_content_type.ok_or_else(|| unsupported_media_type(request_id))?;
    // SpeechAudioFormat rejects parameters, whitespace, paths and unknown types.
    let format = SpeechAudioFormat::parse(part_content_type)
        .map_err(|_| unsupported_media_type(request_id))?;
    let audio_start = header_end + 4;
    let closing = format!("\r\n--{boundary}--").into_bytes();
    let audio_and_close = &rest[audio_start..];
    let close_at =
        find_bytes(audio_and_close, &closing).ok_or_else(|| invalid_multipart(request_id))?;
    let suffix = &audio_and_close[close_at + closing.len()..];
    if !matches!(suffix, b"" | b"\r\n") {
        // A second field, duplicate audio, epilogue, or malformed delimiter.
        return Err(invalid_multipart(request_id));
    }
    let audio = &audio_and_close[..close_at];
    if audio.is_empty() {
        return Err(invalid_multipart(request_id));
    }
    if audio.len() > junban_ai::MAX_SPEECH_AUDIO_BYTES {
        return Err(body_too_large(request_id));
    }
    let global_start = opening.len() + audio_start;
    Ok((format, body.slice(global_start..global_start + close_at)))
}

fn parse_boundary(content_type: &str) -> Option<&str> {
    let mut parts = content_type.split(';');
    if !parts
        .next()?
        .trim()
        .eq_ignore_ascii_case("multipart/form-data")
    {
        return None;
    }
    let mut boundary = None;
    for parameter in parts {
        let (name, value) = parameter.trim().split_once('=')?;
        if !name.trim().eq_ignore_ascii_case("boundary") || boundary.is_some() {
            return None;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(value);
        boundary = Some(value);
    }
    boundary
}

fn is_boundary_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'\'' | b'(' | b')' | b'+' | b'_' | b',' | b'-' | b'.' | b'/' | b':' | b'=' | b'?'
        )
}

fn valid_audio_disposition(value: &str) -> bool {
    let mut parts = value.split(';').map(str::trim);
    if !parts
        .next()
        .is_some_and(|value| value.eq_ignore_ascii_case("form-data"))
    {
        return false;
    }
    let mut name = None;
    let mut filename_seen = false;
    for part in parts {
        let Some((key, value)) = part.split_once('=') else {
            return false;
        };
        let key = key.trim();
        let value = value.trim();
        if key.eq_ignore_ascii_case("name") && name.is_none() {
            name = value
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'));
        } else if key.eq_ignore_ascii_case("filename") && !filename_seen {
            filename_seen = true;
            if value.is_empty() || value.contains(['\r', '\n']) {
                return false;
            }
        } else {
            return false;
        }
    }
    name == Some("audio")
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn speech_error(error: ProviderError, request_id: &RequestId) -> ApiError {
    match error.kind() {
        ProviderErrorKind::Invalid | ProviderErrorKind::BoundExceeded => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "speech_request_invalid",
            "speech request violates the selected provider contract",
            false,
            request_id,
        ),
        ProviderErrorKind::Cancelled => speech_cancelled(request_id),
        ProviderErrorKind::Unavailable => config_error(
            "confirmed speech provider does not support this operation",
            request_id,
        ),
        ProviderErrorKind::Connect
        | ProviderErrorKind::Timeout
        | ProviderErrorKind::HttpStatus
        | ProviderErrorKind::Stream => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "speech_provider_unavailable",
            "cloud speech provider is unavailable",
            true,
            request_id,
        ),
    }
}

fn speech_runtime_error(error: crate::SpeechRuntimeError, request_id: &RequestId) -> ApiError {
    let (status, code) = match error {
        crate::SpeechRuntimeError::Capacity => (StatusCode::CONFLICT, "speech_capacity_reached"),
        crate::SpeechRuntimeError::NotRunning
        | crate::SpeechRuntimeError::InvalidEpoch
        | crate::SpeechRuntimeError::NotDrained => (
            StatusCode::SERVICE_UNAVAILABLE,
            "speech_runtime_unavailable",
        ),
    };
    ApiError::new(
        status,
        code,
        "cloud speech runtime is not accepting activity",
        true,
        request_id,
    )
}

fn config_error(message: &'static str, request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "speech_not_configured",
        message,
        false,
        request_id,
    )
}

fn stale_credential(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "credential_unavailable",
        "confirmed credential material is unavailable",
        false,
        request_id,
    )
}

fn speech_cancelled(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "speech_cancelled",
        "cloud speech activity was cancelled",
        true,
        request_id,
    )
}

fn invalid_multipart(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_multipart",
        "request must contain exactly one bounded audio field",
        false,
        request_id,
    )
}

fn unsupported_media_type(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "unsupported_audio_type",
        "audio content type is not supported",
        false,
        request_id,
    )
}

fn body_too_large(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "body_too_large",
        "request body exceeds the configured limit",
        false,
        request_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn multipart(content_type: &str, bytes: &[u8]) -> (HeaderMap, Bytes) {
        let boundary = "strict-boundary";
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("multipart/form-data; boundary=strict-boundary"),
        );
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"voice\"\r\nContent-Type: {content_type}\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        (headers, Bytes::from(body))
    }

    #[test]
    fn multipart_accepts_exactly_one_bounded_audio_field() {
        let request_id = RequestId("multipart-test".into());
        let (headers, body) = multipart("audio/wav", b"audio");
        let (format, parsed) = parse_audio_multipart(&headers, &body, &request_id).unwrap();
        assert_eq!(format, SpeechAudioFormat::Wav);
        assert_eq!(&parsed[..], b"audio");
    }

    #[test]
    fn multipart_rejects_params_duplicates_unknown_fields_and_trailing_bytes() {
        let request_id = RequestId("multipart-test".into());
        let (headers, body) = multipart("audio/wav; codecs=pcm", b"audio");
        assert_eq!(
            parse_audio_multipart(&headers, &body, &request_id)
                .unwrap_err()
                .status,
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        let (headers, body) = multipart("audio/wav", b"audio");
        let mut body = body.to_vec();
        body.extend_from_slice(b"epilogue");
        let body = Bytes::from(body);
        assert_eq!(
            parse_audio_multipart(&headers, &body, &request_id)
                .unwrap_err()
                .status,
            StatusCode::BAD_REQUEST
        );
        let unknown = String::from_utf8(body.to_vec())
            .unwrap()
            .replace("name=\"audio\"", "name=\"other\"");
        assert!(parse_audio_multipart(&headers, &Bytes::from(unknown), &request_id).is_err());
    }

    #[tokio::test]
    async fn synthesis_response_is_canonical_bounded_binary() {
        let response = synthesis_response(
            SpeechAudio::new(SpeechAudioFormat::Mp3, b"canonical-audio".to_vec()).unwrap(),
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "audio/mpeg");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "15");
        let bytes = axum::body::to_bytes(response.into_body(), 32)
            .await
            .unwrap();
        assert_eq!(&bytes[..], b"canonical-audio");
    }

    #[test]
    fn synthesis_json_is_strict() {
        assert!(serde_json::from_str::<SpeechSynthesisRequest>(r#"{"text":"hello"}"#).is_ok());
        assert!(
            serde_json::from_str::<SpeechSynthesisRequest>(r#"{"text":"hello","model":"x"}"#)
                .is_err()
        );
    }
}
