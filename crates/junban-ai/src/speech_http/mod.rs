//! Bounded fixed-origin cloud speech HTTP adapters.
//!
//! This runtime is deliberately separate from chat. Construction is lazy, every
//! operation performs exactly one request, redirects and ambient proxies are
//! disabled by the shared client policy, and callers cannot supply an endpoint.

mod inworld;
mod openai_compatible;
mod shared;

#[cfg(test)]
mod tests;

use junban_domain::{AiSecretKind, SpeechProviderPreset};
use tokio_util::sync::CancellationToken;

use crate::{
    ProviderError, ProviderHttpFactory, SecretString, SynthesisRequest, SynthesisResult,
    TranscriptionRequest, TranscriptionResult,
};

pub use inworld::MAX_INWORLD_AUDIO_BYTES;

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
            SpeechProviderPreset::OpenAi => {
                format!("{}/audio/transcriptions", openai_compatible::OPENAI_ORIGIN)
            }
            SpeechProviderPreset::Groq => {
                format!("{}/audio/transcriptions", openai_compatible::GROQ_ORIGIN)
            }
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
            SpeechProviderPreset::OpenAi => {
                format!("{}/audio/speech", openai_compatible::OPENAI_ORIGIN)
            }
            SpeechProviderPreset::Groq => {
                format!("{}/audio/speech", openai_compatible::GROQ_ORIGIN)
            }
            SpeechProviderPreset::Inworld => {
                format!("{}/tts/v1/voice", inworld::INWORLD_ORIGIN)
            }
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
        openai_compatible::transcribe(&self.factory, url, request, credential, cancel).await
    }

    async fn synthesize_at(
        &self,
        url: &str,
        request: &SynthesisRequest,
        credential: &SpeechCredential,
        cancel: &CancellationToken,
    ) -> Result<SynthesisResult, ProviderError> {
        match request.provider {
            SpeechProviderPreset::OpenAi | SpeechProviderPreset::Groq => {
                openai_compatible::synthesize(&self.factory, url, request, credential, cancel).await
            }
            SpeechProviderPreset::Inworld => {
                inworld::synthesize(&self.factory, url, request, credential, cancel).await
            }
            SpeechProviderPreset::Browser => unreachable!("validated browser provider"),
        }
    }
}

/// Validate all provider-specific STT rules without constructing a client or
/// resolving secret bytes. The server calls this before private secret lookup.
pub fn validate_transcription_request(
    request: &TranscriptionRequest,
    credential_kind: AiSecretKind,
) -> Result<(), ProviderError> {
    // OpenAI-compatible owns the STT matrix; browser/Inworld fail closed through
    // the same credential-then-format checks without constructing a client.
    openai_compatible::validate_transcription(request, credential_kind)
}

/// Validate all provider-specific TTS rules without constructing a client or
/// resolving secret bytes. The server calls this before private secret lookup.
pub fn validate_synthesis_request(
    request: &SynthesisRequest,
    credential_kind: AiSecretKind,
) -> Result<(), ProviderError> {
    match request.provider {
        SpeechProviderPreset::OpenAi | SpeechProviderPreset::Groq => {
            openai_compatible::validate_synthesis(request, credential_kind)
        }
        SpeechProviderPreset::Inworld => inworld::validate_synthesis(request, credential_kind),
        SpeechProviderPreset::Browser => Err(ProviderError::Unavailable {
            capability: "rust_speech_adapter",
        }),
    }
}
