//! Cloud speech route handlers, DTOs, and confirmed-settings authority.

use axum::{
    Json,
    body::Bytes,
    extract::{
        Extension, State,
        rejection::{BytesRejection, JsonRejection},
    },
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
};
use junban_ai::{
    ModelId, SecretString, SpeechAudio, SpeechAudioFormat, SpeechCredential, SpeechVoiceId,
    SynthesisRequest, SynthesisText, TranscriptionRequest, validate_synthesis_request,
    validate_transcription_request,
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

use super::{
    error::{
        body_too_large, config_error, speech_cancelled, speech_error, speech_runtime_error,
        stale_credential,
    },
    multipart::parse_audio_multipart,
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

pub(super) fn synthesis_response(audio: SpeechAudio) -> Response {
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
