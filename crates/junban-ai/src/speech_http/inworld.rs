//! Inworld synchronous cloud TTS.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use junban_domain::{AiSecretKind, SpeechProviderPreset};
use reqwest::header;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{
    ProviderError, ProviderHttpFactory, SpeechAudio, SpeechAudioFormat, SynthesisRequest,
    SynthesisResult,
};

use super::{
    SpeechCredential,
    shared::{
        await_cancelled, check_cancel, contains_secret, read_bounded, request_provider_credential,
        require_json_content_type, speech_authorization, validate_status,
    },
};

pub(super) const INWORLD_ORIGIN: &str = "https://api.inworld.ai";
pub(super) const INWORLD_TTS_CHAR_MAX: usize = 2_000;
/// Inworld's documented decoded synchronous response ceiling.
pub const MAX_INWORLD_AUDIO_BYTES: usize = 16 * 1024 * 1024;
const MAX_INWORLD_BASE64_BYTES: usize = MAX_INWORLD_AUDIO_BYTES.div_ceil(3) * 4;
const MAX_INWORLD_JSON_BYTES: usize = MAX_INWORLD_BASE64_BYTES + 16 * 1024;

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

pub(super) fn validate_synthesis(
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
    if request.provider != SpeechProviderPreset::Inworld {
        return Err(ProviderError::invalid(
            "speech_credential_kind",
            "is not accepted by the selected provider",
        ));
    }
    let chars = request.text.as_str().chars().count();
    if chars > INWORLD_TTS_CHAR_MAX {
        return Err(ProviderError::bound("inworld_tts_characters"));
    }
    if request.output_format != SpeechAudioFormat::Wav {
        return Err(ProviderError::invalid(
            "speech_audio_format",
            "Inworld synchronous speech uses wav output",
        ));
    }
    Ok(())
}

pub(super) async fn synthesize(
    factory: &ProviderHttpFactory,
    url: &str,
    request: &SynthesisRequest,
    credential: &SpeechCredential,
    cancel: &CancellationToken,
) -> Result<SynthesisResult, ProviderError> {
    validate_synthesis(request, credential.kind())?;
    check_cancel(cancel)?;
    let authorization = speech_authorization(credential)?;
    let client = factory.client()?.clone();
    let body = InworldSpeechRequest {
        text: request.text.as_str(),
        voice_id: request.voice.as_ref().expect("validated voice").as_str(),
        model_id: request.model.as_ref().expect("validated model").as_str(),
        audio_config: InworldAudioConfig {
            audio_encoding: "LINEAR16",
        },
    };
    let response = await_cancelled(
        client
            .post(url)
            .header(header::AUTHORIZATION, authorization)
            .json(&body)
            .send(),
        cancel,
        credential,
    )
    .await?;
    validate_status(&response, cancel, credential).await?;
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
    let audio = SpeechAudio::new(SpeechAudioFormat::Wav, bytes)?;
    check_cancel(cancel)?;
    Ok(SynthesisResult::new(
        audio,
        request.model.clone(),
        request.voice.clone(),
    ))
}
