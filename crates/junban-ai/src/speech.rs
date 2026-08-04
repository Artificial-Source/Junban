//! Provider-neutral speech data contracts for cloud STT/TTS adapters.
//!
//! Provider-neutral request/response shapes, audio/text bounds, content-type
//! validation, and explicit provider capability/ownership metadata live here.
//! Browser speech remains frontend-owned; the bounded cloud HTTP implementation
//! is isolated in `speech_http` for presets that declare
//! [`SpeechRuntimeOwner::RustNetworkAdapter`].

use std::fmt;

use bytes::Bytes;
use junban_domain::SpeechProviderPreset;

use crate::bounds::{
    MAX_MODEL_ID_BYTES, MAX_SPEECH_AUDIO_BYTES, MAX_SPEECH_SYNTHESIS_TEXT_BYTES,
    MAX_SPEECH_TRANSCRIPTION_TEXT_BYTES,
};
use crate::error::ProviderError;
use crate::ids::ModelId;

/// Runtime alias for the single domain speech-provider authority.
pub type SpeechPreset = SpeechProviderPreset;

/// Discrete speech capability. Unsupported actions fail as unavailable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SpeechCapability {
    /// Speech-to-text / transcription.
    SpeechToText,
    /// Text-to-speech / synthesis.
    TextToSpeech,
}

impl SpeechCapability {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SpeechToText => "speech_to_text",
            Self::TextToSpeech => "text_to_speech",
        }
    }
}

/// Which layer owns execution for a speech preset.
///
/// Browser work stays in the frontend. Cloud presets are served by future
/// Rust HTTP adapters; declaring ownership here prevents guessing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SpeechRuntimeOwner {
    /// Web Speech API / lazy local browser engines. No Rust network adapter.
    BrowserFrontend,
    /// Server-side bounded HTTP clients.
    RustNetworkAdapter,
}

/// Explicit STT/TTS support and ownership for one speech preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpeechProviderCapabilities {
    pub provider: SpeechProviderPreset,
    pub owner: SpeechRuntimeOwner,
    pub speech_to_text: bool,
    pub text_to_speech: bool,
}

impl SpeechProviderCapabilities {
    /// Frozen capability matrix. Never infers support from model catalogs.
    #[must_use]
    pub const fn for_preset(provider: SpeechProviderPreset) -> Self {
        match provider {
            SpeechProviderPreset::Browser => Self {
                provider,
                owner: SpeechRuntimeOwner::BrowserFrontend,
                speech_to_text: true,
                text_to_speech: true,
            },
            SpeechProviderPreset::OpenAi | SpeechProviderPreset::Groq => Self {
                provider,
                owner: SpeechRuntimeOwner::RustNetworkAdapter,
                speech_to_text: true,
                text_to_speech: true,
            },
            // Inworld is TTS-only in the frozen inventory.
            SpeechProviderPreset::Inworld => Self {
                provider,
                owner: SpeechRuntimeOwner::RustNetworkAdapter,
                speech_to_text: false,
                text_to_speech: true,
            },
        }
    }

    #[must_use]
    pub const fn supports(self, capability: SpeechCapability) -> bool {
        match capability {
            SpeechCapability::SpeechToText => self.speech_to_text,
            SpeechCapability::TextToSpeech => self.text_to_speech,
        }
    }

    /// Fail closed when a preset does not advertise the capability.
    pub fn require(self, capability: SpeechCapability) -> Result<(), ProviderError> {
        if self.supports(capability) {
            Ok(())
        } else {
            Err(ProviderError::Unavailable {
                capability: capability.as_str(),
            })
        }
    }

    /// Fail closed when work would require a Rust network adapter the preset
    /// does not own (browser remains frontend-only).
    pub fn require_rust_network_adapter(self) -> Result<(), ProviderError> {
        match self.owner {
            SpeechRuntimeOwner::RustNetworkAdapter => Ok(()),
            SpeechRuntimeOwner::BrowserFrontend => Err(ProviderError::Unavailable {
                capability: "rust_speech_adapter",
            }),
        }
    }
}

/// Allowlisted speech audio container / encoding.
///
/// Values cover the OpenAI/Groq transcription and speech formats plus common
/// browser capture containers. Arbitrary MIME parameters, paths, and URLs are
/// rejected at parse time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SpeechAudioFormat {
    Wav,
    Mp3,
    Mp4,
    Mpeg,
    Mpga,
    M4a,
    Ogg,
    Flac,
    Webm,
    Opus,
    Aac,
    Pcm,
}

impl SpeechAudioFormat {
    /// Parse a short format token or exact `audio/*` content type.
    pub fn parse(value: &str) -> Result<Self, ProviderError> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(ProviderError::invalid(
                "speech_audio_format",
                "must not be empty",
            ));
        }
        // Reject parameterized content types (boundary, codecs, paths, etc.).
        if trimmed.contains(';') || trimmed.contains(' ') {
            return Err(ProviderError::invalid(
                "speech_audio_format",
                "must not include parameters or whitespace",
            ));
        }

        let normalized = trimmed.to_ascii_lowercase();
        if normalized.contains('/') && !normalized.starts_with("audio/") {
            return Err(ProviderError::invalid(
                "speech_audio_format",
                "only audio content types are accepted",
            ));
        }

        let token = normalized
            .strip_prefix("audio/")
            .unwrap_or(normalized.as_str());

        match token {
            "wav" | "x-wav" | "wave" => Ok(Self::Wav),
            "mp3" => Ok(Self::Mp3),
            "mp4" | "x-m4a" => Ok(Self::Mp4),
            "mpeg" => Ok(Self::Mpeg),
            "mpga" => Ok(Self::Mpga),
            "m4a" => Ok(Self::M4a),
            "ogg" => Ok(Self::Ogg),
            "flac" => Ok(Self::Flac),
            "webm" => Ok(Self::Webm),
            "opus" => Ok(Self::Opus),
            "aac" => Ok(Self::Aac),
            "pcm" | "l16" => Ok(Self::Pcm),
            _ => Err(ProviderError::invalid(
                "speech_audio_format",
                "unsupported audio format",
            )),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Mp3 => "mp3",
            Self::Mp4 => "mp4",
            Self::Mpeg => "mpeg",
            Self::Mpga => "mpga",
            Self::M4a => "m4a",
            Self::Ogg => "ogg",
            Self::Flac => "flac",
            Self::Webm => "webm",
            Self::Opus => "opus",
            Self::Aac => "aac",
            Self::Pcm => "pcm",
        }
    }

    /// Exact content-type token without parameters.
    #[must_use]
    pub const fn content_type(self) -> &'static str {
        match self {
            Self::Wav => "audio/wav",
            Self::Mp3 => "audio/mpeg",
            Self::Mp4 => "audio/mp4",
            Self::Mpeg => "audio/mpeg",
            Self::Mpga => "audio/mpga",
            Self::M4a => "audio/m4a",
            Self::Ogg => "audio/ogg",
            Self::Flac => "audio/flac",
            Self::Webm => "audio/webm",
            Self::Opus => "audio/opus",
            Self::Aac => "audio/aac",
            Self::Pcm => "audio/pcm",
        }
    }
}

impl fmt::Display for SpeechAudioFormat {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Optional TTS voice identifier (same token bounds as model IDs).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SpeechVoiceId(String);

impl SpeechVoiceId {
    pub fn new(value: impl Into<String>) -> Result<Self, ProviderError> {
        let value = value.into();
        validate_speech_token(&value, "speech_voice_id", MAX_MODEL_ID_BYTES)?;
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SpeechVoiceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SpeechVoiceId")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for SpeechVoiceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Bounded audio payload. Construction enforces the 25 MiB ceiling before any
/// adapter can accept bytes. Debug never dumps payload contents.
#[derive(Clone, PartialEq, Eq)]
pub struct SpeechAudio {
    format: SpeechAudioFormat,
    bytes: Bytes,
}

impl SpeechAudio {
    /// Build audio from an allowlisted format and bounded byte payload.
    pub fn new(
        format: SpeechAudioFormat,
        bytes: impl Into<Vec<u8>>,
    ) -> Result<Self, ProviderError> {
        let bytes = bytes.into();
        if bytes.is_empty() {
            return Err(ProviderError::invalid("speech_audio", "must not be empty"));
        }
        if bytes.len() > MAX_SPEECH_AUDIO_BYTES {
            return Err(ProviderError::bound("speech_audio_bytes"));
        }
        Ok(Self {
            format,
            bytes: Bytes::from(bytes),
        })
    }

    /// Build audio from an already-owned shared byte region without copying.
    pub fn from_bytes(format: SpeechAudioFormat, bytes: Bytes) -> Result<Self, ProviderError> {
        if bytes.is_empty() {
            return Err(ProviderError::invalid("speech_audio", "must not be empty"));
        }
        if bytes.len() > MAX_SPEECH_AUDIO_BYTES {
            return Err(ProviderError::bound("speech_audio_bytes"));
        }
        Ok(Self { format, bytes })
    }

    /// Parse format from a short token or exact content type, then bound bytes.
    pub fn from_content_type(
        content_type: &str,
        bytes: impl Into<Vec<u8>>,
    ) -> Result<Self, ProviderError> {
        let format = SpeechAudioFormat::parse(content_type)?;
        Self::new(format, bytes)
    }

    #[must_use]
    pub fn format(&self) -> SpeechAudioFormat {
        self.format
    }

    #[must_use]
    pub fn content_type(&self) -> &'static str {
        self.format.content_type()
    }

    #[must_use]
    pub fn as_slice(&self) -> &[u8] {
        &self.bytes
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Clone the shared payload handle without copying audio bytes.
    #[must_use]
    pub fn bytes(&self) -> Bytes {
        self.bytes.clone()
    }

    /// Consume the payload for a binary response without copying audio bytes.
    #[must_use]
    pub fn into_bytes(self) -> Bytes {
        self.bytes
    }
}

impl fmt::Debug for SpeechAudio {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechAudio")
            .field("format", &self.format)
            .field("len", &self.bytes.len())
            .finish()
    }
}

/// Nonempty transcription text bounded by the frozen user-input ceiling.
/// Debug reports length only.
#[derive(Clone, PartialEq, Eq)]
pub struct TranscriptionText(String);

impl TranscriptionText {
    pub fn new(value: impl Into<String>) -> Result<Self, ProviderError> {
        let value = value.into();
        if value.is_empty() {
            return Err(ProviderError::invalid(
                "transcription_text",
                "must not be empty",
            ));
        }
        if value.len() > MAX_SPEECH_TRANSCRIPTION_TEXT_BYTES {
            return Err(ProviderError::bound("transcription_text_bytes"));
        }
        if value
            .chars()
            .any(|ch| ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t')
        {
            return Err(ProviderError::invalid(
                "transcription_text",
                "must not contain disallowed control characters",
            ));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Debug for TranscriptionText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TranscriptionText")
            .field("len", &self.0.len())
            .finish()
    }
}

impl fmt::Display for TranscriptionText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Nonempty synthesis input bounded by the frozen assistant-text ceiling.
/// Debug reports length only.
#[derive(Clone, PartialEq, Eq)]
pub struct SynthesisText(String);

impl SynthesisText {
    pub fn new(value: impl Into<String>) -> Result<Self, ProviderError> {
        let value = value.into();
        if value.is_empty() {
            return Err(ProviderError::invalid(
                "synthesis_text",
                "must not be empty",
            ));
        }
        if value.len() > MAX_SPEECH_SYNTHESIS_TEXT_BYTES {
            return Err(ProviderError::bound("synthesis_text_bytes"));
        }
        if value
            .chars()
            .any(|ch| ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t')
        {
            return Err(ProviderError::invalid(
                "synthesis_text",
                "must not contain disallowed control characters",
            ));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Debug for SynthesisText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SynthesisText")
            .field("len", &self.0.len())
            .finish()
    }
}

impl fmt::Display for SynthesisText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Provider-neutral speech-to-text request.
///
/// Contains no credentials, URLs, headers, paths, or query material. Adapters
/// receive auth and endpoint configuration from a separate authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptionRequest {
    pub provider: SpeechProviderPreset,
    pub model: Option<ModelId>,
    pub audio: SpeechAudio,
}

impl TranscriptionRequest {
    /// Construct a transcription request after capability and bound checks.
    pub fn new(
        provider: SpeechProviderPreset,
        audio: SpeechAudio,
        model: Option<ModelId>,
    ) -> Result<Self, ProviderError> {
        let caps = SpeechProviderCapabilities::for_preset(provider);
        caps.require(SpeechCapability::SpeechToText)?;
        Ok(Self {
            provider,
            model,
            audio,
        })
    }

    /// Require both STT support and Rust-network ownership (cloud adapters).
    pub fn for_rust_adapter(
        provider: SpeechProviderPreset,
        audio: SpeechAudio,
        model: Option<ModelId>,
    ) -> Result<Self, ProviderError> {
        let caps = SpeechProviderCapabilities::for_preset(provider);
        caps.require_rust_network_adapter()?;
        caps.require(SpeechCapability::SpeechToText)?;
        Ok(Self {
            provider,
            model,
            audio,
        })
    }
}

/// Provider-neutral transcription result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptionResult {
    pub text: TranscriptionText,
    pub model: Option<ModelId>,
}

impl TranscriptionResult {
    pub fn new(text: TranscriptionText, model: Option<ModelId>) -> Self {
        Self { text, model }
    }
}

/// Provider-neutral text-to-speech request.
///
/// Contains no credentials, URLs, headers, paths, or query material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SynthesisRequest {
    pub provider: SpeechProviderPreset,
    pub model: Option<ModelId>,
    pub voice: Option<SpeechVoiceId>,
    pub text: SynthesisText,
    pub output_format: SpeechAudioFormat,
}

impl SynthesisRequest {
    /// Construct a synthesis request after capability and bound checks.
    pub fn new(
        provider: SpeechProviderPreset,
        text: SynthesisText,
        output_format: SpeechAudioFormat,
        model: Option<ModelId>,
        voice: Option<SpeechVoiceId>,
    ) -> Result<Self, ProviderError> {
        let caps = SpeechProviderCapabilities::for_preset(provider);
        caps.require(SpeechCapability::TextToSpeech)?;
        Ok(Self {
            provider,
            model,
            voice,
            text,
            output_format,
        })
    }

    /// Require both TTS support and Rust-network ownership (cloud adapters).
    pub fn for_rust_adapter(
        provider: SpeechProviderPreset,
        text: SynthesisText,
        output_format: SpeechAudioFormat,
        model: Option<ModelId>,
        voice: Option<SpeechVoiceId>,
    ) -> Result<Self, ProviderError> {
        let caps = SpeechProviderCapabilities::for_preset(provider);
        caps.require_rust_network_adapter()?;
        caps.require(SpeechCapability::TextToSpeech)?;
        Ok(Self {
            provider,
            model,
            voice,
            text,
            output_format,
        })
    }
}

/// Provider-neutral synthesis result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SynthesisResult {
    pub audio: SpeechAudio,
    pub model: Option<ModelId>,
    pub voice: Option<SpeechVoiceId>,
}

impl SynthesisResult {
    pub fn new(audio: SpeechAudio, model: Option<ModelId>, voice: Option<SpeechVoiceId>) -> Self {
        Self {
            audio,
            model,
            voice,
        }
    }
}

fn validate_speech_token(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), ProviderError> {
    if value.is_empty() {
        return Err(ProviderError::invalid(field, "must not be empty"));
    }
    if value.len() > max_bytes {
        return Err(ProviderError::invalid(
            field,
            "exceeds maximum UTF-8 byte length",
        ));
    }
    if value.chars().any(|ch| ch.is_control()) {
        return Err(ProviderError::invalid(
            field,
            "must not contain control characters",
        ));
    }
    if value != value.trim() {
        return Err(ProviderError::invalid(
            field,
            "must not include leading or trailing whitespace",
        ));
    }
    // Reject values that look like URLs, paths, or query material.
    if value.contains("://")
        || value.contains('/')
        || value.contains('\\')
        || value.contains('?')
        || value.contains('#')
        || value.contains('&')
        || value.contains('=')
    {
        return Err(ProviderError::invalid(
            field,
            "must not contain URL, path, or query material",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ProviderErrorKind;

    fn sample_audio() -> SpeechAudio {
        SpeechAudio::new(SpeechAudioFormat::Wav, vec![0_u8; 64]).expect("sample audio")
    }

    #[test]
    fn audio_enforces_empty_and_25_mib_bounds() {
        assert!(matches!(
            SpeechAudio::new(SpeechAudioFormat::Mp3, Vec::<u8>::new()),
            Err(ProviderError::Invalid {
                field: "speech_audio",
                ..
            })
        ));

        let at_cap = SpeechAudio::new(SpeechAudioFormat::Wav, vec![1_u8; MAX_SPEECH_AUDIO_BYTES]);
        assert!(at_cap.is_ok());
        assert_eq!(at_cap.unwrap().len(), MAX_SPEECH_AUDIO_BYTES);

        let over = SpeechAudio::new(
            SpeechAudioFormat::Wav,
            vec![1_u8; MAX_SPEECH_AUDIO_BYTES + 1],
        );
        let over_err = over.expect_err("audio above 25 MiB must fail");
        assert!(matches!(
            over_err,
            ProviderError::BoundExceeded {
                bound: "speech_audio_bytes"
            }
        ));
        assert_eq!(over_err.kind(), ProviderErrorKind::BoundExceeded);
    }

    #[test]
    fn format_parse_accepts_tokens_and_exact_content_types() {
        assert_eq!(
            SpeechAudioFormat::parse("wav").unwrap(),
            SpeechAudioFormat::Wav
        );
        assert_eq!(
            SpeechAudioFormat::parse("audio/webm").unwrap(),
            SpeechAudioFormat::Webm
        );
        assert_eq!(
            SpeechAudioFormat::parse("AUDIO/MPEG").unwrap(),
            SpeechAudioFormat::Mpeg
        );
        assert_eq!(SpeechAudioFormat::Flac.content_type(), "audio/flac");
    }

    #[test]
    fn format_parse_rejects_parameters_paths_and_unknown() {
        assert!(matches!(
            SpeechAudioFormat::parse("audio/wav; codecs=1"),
            Err(ProviderError::Invalid {
                field: "speech_audio_format",
                ..
            })
        ));
        assert!(SpeechAudioFormat::parse("application/ogg").is_err());
        assert!(SpeechAudioFormat::parse("audio/../../../etc/passwd").is_err());
        assert!(SpeechAudioFormat::parse("not-a-format").is_err());
        assert!(SpeechAudioFormat::parse("").is_err());
    }

    #[test]
    fn transcription_and_synthesis_text_bounds() {
        assert!(TranscriptionText::new("").is_err());
        assert!(SynthesisText::new("").is_err());

        let ok_tx = TranscriptionText::new("hello from the mic").unwrap();
        assert_eq!(ok_tx.as_str(), "hello from the mic");
        let ok_sy = SynthesisText::new("assistant reply").unwrap();
        assert_eq!(ok_sy.as_str(), "assistant reply");

        let over_tx = "x".repeat(MAX_SPEECH_TRANSCRIPTION_TEXT_BYTES + 1);
        assert!(matches!(
            TranscriptionText::new(over_tx),
            Err(ProviderError::BoundExceeded {
                bound: "transcription_text_bytes"
            })
        ));

        let over_sy = "y".repeat(MAX_SPEECH_SYNTHESIS_TEXT_BYTES + 1);
        assert!(matches!(
            SynthesisText::new(over_sy),
            Err(ProviderError::BoundExceeded {
                bound: "synthesis_text_bytes"
            })
        ));

        let at_tx = TranscriptionText::new("z".repeat(MAX_SPEECH_TRANSCRIPTION_TEXT_BYTES));
        assert!(at_tx.is_ok());
        let at_sy = SynthesisText::new("z".repeat(MAX_SPEECH_SYNTHESIS_TEXT_BYTES));
        assert!(at_sy.is_ok());
    }

    #[test]
    fn voice_and_model_tokens_reject_url_path_and_control() {
        assert!(SpeechVoiceId::new("alloy").is_ok());
        assert!(SpeechVoiceId::new("").is_err());
        assert!(SpeechVoiceId::new("a".repeat(MAX_MODEL_ID_BYTES + 1)).is_err());
        assert!(SpeechVoiceId::new("bad/voice").is_err());
        assert!(SpeechVoiceId::new("https://evil.example/v").is_err());
        assert!(SpeechVoiceId::new("voice?x=1").is_err());
        assert!(SpeechVoiceId::new(" spaced ").is_err());
        assert!(ModelId::new("whisper-1").is_ok());
        assert!(ModelId::new("model\nname").is_err());
    }

    #[test]
    fn capability_matrix_is_explicit_and_fail_closed() {
        let browser = SpeechProviderCapabilities::for_preset(SpeechProviderPreset::Browser);
        assert_eq!(browser.owner, SpeechRuntimeOwner::BrowserFrontend);
        assert!(browser.supports(SpeechCapability::SpeechToText));
        assert!(browser.supports(SpeechCapability::TextToSpeech));
        assert!(matches!(
            browser.require_rust_network_adapter(),
            Err(ProviderError::Unavailable {
                capability: "rust_speech_adapter"
            })
        ));

        let openai = SpeechProviderCapabilities::for_preset(SpeechProviderPreset::OpenAi);
        assert_eq!(openai.owner, SpeechRuntimeOwner::RustNetworkAdapter);
        openai.require(SpeechCapability::SpeechToText).unwrap();
        openai.require(SpeechCapability::TextToSpeech).unwrap();
        openai.require_rust_network_adapter().unwrap();

        let groq = SpeechProviderCapabilities::for_preset(SpeechProviderPreset::Groq);
        assert!(groq.speech_to_text && groq.text_to_speech);
        groq.require_rust_network_adapter().unwrap();

        let inworld = SpeechProviderCapabilities::for_preset(SpeechProviderPreset::Inworld);
        assert_eq!(inworld.owner, SpeechRuntimeOwner::RustNetworkAdapter);
        assert!(!inworld.speech_to_text);
        assert!(inworld.text_to_speech);
        assert!(matches!(
            inworld.require(SpeechCapability::SpeechToText),
            Err(ProviderError::Unavailable {
                capability: "speech_to_text"
            })
        ));
        inworld.require(SpeechCapability::TextToSpeech).unwrap();
    }

    #[test]
    fn request_constructors_use_capabilities() {
        let audio = sample_audio();
        let text = SynthesisText::new("say this").unwrap();

        TranscriptionRequest::new(SpeechProviderPreset::OpenAi, audio.clone(), None).unwrap();
        TranscriptionRequest::for_rust_adapter(SpeechProviderPreset::Groq, audio.clone(), None)
            .unwrap();

        assert!(matches!(
            TranscriptionRequest::new(SpeechProviderPreset::Inworld, audio.clone(), None),
            Err(ProviderError::Unavailable {
                capability: "speech_to_text"
            })
        ));
        assert!(matches!(
            TranscriptionRequest::for_rust_adapter(SpeechProviderPreset::Browser, audio, None),
            Err(ProviderError::Unavailable {
                capability: "rust_speech_adapter"
            })
        ));

        // Browser may construct the neutral request (frontend-owned) but not
        // the rust-adapter constructor.
        let browser_audio = sample_audio();
        TranscriptionRequest::new(SpeechProviderPreset::Browser, browser_audio, None).unwrap();

        SynthesisRequest::new(
            SpeechProviderPreset::Inworld,
            text.clone(),
            SpeechAudioFormat::Mp3,
            None,
            Some(SpeechVoiceId::new("hades").unwrap()),
        )
        .unwrap();
        SynthesisRequest::for_rust_adapter(
            SpeechProviderPreset::OpenAi,
            text,
            SpeechAudioFormat::Wav,
            Some(ModelId::new("tts-1").unwrap()),
            Some(SpeechVoiceId::new("alloy").unwrap()),
        )
        .unwrap();

        let browser_text = SynthesisText::new("frontend only").unwrap();
        assert!(matches!(
            SynthesisRequest::for_rust_adapter(
                SpeechProviderPreset::Browser,
                browser_text,
                SpeechAudioFormat::Mp3,
                None,
                None,
            ),
            Err(ProviderError::Unavailable {
                capability: "rust_speech_adapter"
            })
        ));
    }

    #[test]
    fn debug_redacts_audio_bytes_and_raw_text() {
        let marker = "UNIQUE_PAYLOAD_BYTES_should_never_appear";
        let audio = SpeechAudio::new(SpeechAudioFormat::Ogg, marker.as_bytes().to_vec()).unwrap();
        let audio_dbg = format!("{audio:?}");
        assert!(!audio_dbg.contains(marker));
        assert!(audio_dbg.contains("len"));
        assert!(audio_dbg.contains("Ogg") || audio_dbg.contains("format"));

        let secret_line = "top-secret-transcript-content-zz99";
        let tx = TranscriptionText::new(secret_line).unwrap();
        let tx_dbg = format!("{tx:?}");
        assert!(!tx_dbg.contains(secret_line));
        assert!(tx_dbg.contains("len"));

        let synth_line = "top-secret-synthesis-content-aa11";
        let sy = SynthesisText::new(synth_line).unwrap();
        let sy_dbg = format!("{sy:?}");
        assert!(!sy_dbg.contains(synth_line));
        assert!(sy_dbg.contains("len"));

        let req = TranscriptionRequest::new(SpeechProviderPreset::OpenAi, audio, None).unwrap();
        let req_dbg = format!("{req:?}");
        assert!(!req_dbg.contains(marker));
    }

    #[test]
    fn domain_preset_identity_is_reused() {
        assert_eq!(
            std::any::TypeId::of::<SpeechPreset>(),
            std::any::TypeId::of::<SpeechProviderPreset>()
        );
        assert_eq!(
            SpeechProviderPreset::parse("openai").unwrap().as_str(),
            "openai"
        );
        assert_eq!(SpeechProviderPreset::Inworld.as_str(), "inworld");
        assert!(!SpeechProviderPreset::Browser.is_cloud());
        assert!(SpeechProviderPreset::Groq.is_cloud());
    }
}
