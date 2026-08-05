//! OpenAI-compatible cloud speech (OpenAI and Groq STT/TTS).

use bytes::Bytes;
use futures_util::stream;
use junban_domain::{AiSecretKind, SpeechProviderPreset};
use reqwest::header;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{
    ModelId, ProviderError, ProviderHttpFactory, SpeechAudio, SpeechAudioFormat, SynthesisRequest,
    SynthesisResult, TranscriptionRequest, TranscriptionResult, TranscriptionText,
};

use super::{
    SpeechCredential,
    shared::{
        await_cancelled, check_cancel, contains_secret, read_bounded, request_provider_credential,
        require_audio_content_type, require_json_content_type, speech_authorization,
        validate_status,
    },
};

pub(super) const OPENAI_ORIGIN: &str = "https://api.openai.com/v1";
pub(super) const GROQ_ORIGIN: &str = "https://api.groq.com/openai/v1";
pub(super) const OPENAI_TTS_CHAR_MAX: usize = 4_096;
pub(super) const GROQ_TTS_CHAR_MAX: usize = 200;

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

pub(super) fn validate_transcription(
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
        SpeechProviderPreset::Browser | SpeechProviderPreset::Inworld => {
            return Err(ProviderError::invalid(
                "speech_credential_kind",
                "is not accepted by the selected provider",
            ));
        }
    }
    Ok(())
}

pub(super) async fn transcribe(
    factory: &ProviderHttpFactory,
    url: &str,
    request: &TranscriptionRequest,
    credential: &SpeechCredential,
    cancel: &CancellationToken,
) -> Result<TranscriptionResult, ProviderError> {
    validate_transcription(request, credential.kind())?;
    check_cancel(cancel)?;
    let model = request.model.as_ref().expect("validated model");
    let authorization = speech_authorization(credential)?;
    let (body, content_length, boundary) = transcription_multipart(model, &request.audio);
    let client = factory.client()?.clone();
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
    let body = OpenAiSpeechRequest {
        model: request.model.as_ref().expect("validated model").as_str(),
        input: request.text.as_str(),
        voice: request.voice.as_ref().expect("validated voice").as_str(),
        response_format: request.output_format.as_str(),
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
    require_audio_content_type(&response, request.output_format)?;
    let bytes = read_bounded(response, crate::MAX_SPEECH_AUDIO_BYTES, cancel).await?;
    if contains_secret(&bytes, credential.secret.expose()) {
        return Err(ProviderError::stream_failed());
    }
    let audio = SpeechAudio::new(request.output_format, bytes)?;
    check_cancel(cancel)?;
    Ok(SynthesisResult::new(
        audio,
        request.model.clone(),
        request.voice.clone(),
    ))
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
