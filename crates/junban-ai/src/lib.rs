//! Optional provider-contract foundation for Junban AI.
//!
//! Wave 0 established provider-neutral identifiers, bounded SSE decoding,
//! retry classification, generation cancellation, and a lazy HTTP client
//! factory. Wave 2 adds the typed provider registry, four wire adapters,
//! model discovery, fixture-driven runtime tests, and provider-neutral
//! speech data contracts (no HTTP speech adapters or routes yet). Wave 3e
//! adds incremental normalized event delivery via async sinks so a server
//! POST-SSE orchestrator can forward deltas before the provider response ends.
//!
//! This crate performs no global runtime initialization. Constructing the
//! default [`ProviderHttpFactory`] or [`ProviderRuntime`] must not create a
//! `reqwest` client or TLS pool.

mod adapters;
mod auth;
mod bounds;
mod cancel;
mod capabilities;
mod client;
mod discovery;
mod error;
mod ids;
mod normalize;
mod registry;
mod request;
mod retry;
mod runtime;
mod secret;
mod speech;
mod speech_http;
mod sse;
mod stream;
mod transport;
mod url_policy;

pub use adapters::{PreparedRequest, prepare_chat_request};
pub use auth::{ANTHROPIC_VERSION, AuthScheme, build_auth_headers};
pub use bounds::{
    MAX_BASE_URL_BYTES, MAX_DISCOVERED_MODELS, MAX_PROVIDER_ERROR_BODY_BYTES,
    MAX_PROVIDER_RESPONSE_BYTES, MAX_PROVIDER_STREAM_FRAME_BYTES, MAX_RETRY_AFTER,
    MAX_RETRY_ATTEMPTS, MAX_SPEECH_AUDIO_BYTES, MAX_SPEECH_SYNTHESIS_TEXT_BYTES,
    MAX_SPEECH_TRANSCRIPTION_TEXT_BYTES, MAX_TEXT_DELTA_BYTES, MAX_TOOL_ARGUMENTS_BYTES,
};
pub use cancel::{Generation, GenerationFence, RunCancel, RunId};
pub use capabilities::{ProviderCapabilities, ProviderCapability};
pub use client::{
    DEFAULT_CONNECT_TIMEOUT, DEFAULT_IDLE_TIMEOUT, DEFAULT_REQUEST_TIMEOUT, ProviderHttpFactory,
    bearer_authorization_header, build_provider_client, sensitive_header,
};
pub use discovery::{DiscoveredModel, discover_models, parse_models_body};
pub use error::{
    ProviderError, ProviderErrorKind, extract_vendor_code, redact_sensitive, sanitize_vendor_code,
    scrub_active_secret,
};
/// Contract alias used by higher layers; identical to [`ProviderError`].
pub type AiError = ProviderError;
pub use ids::{ModelId, ProviderId, ProviderKind};
pub use junban_domain::{AiProviderPreset, SpeechProviderPreset};
pub use normalize::{
    FrameNormalizer, NormalizedProviderFrame, bound_redact_error_body,
    normalize_openai_compatible_data,
};
pub use registry::{
    ProviderDescriptor, ProviderPreset, builtin_providers, descriptor, descriptor_by_id,
};
pub use request::{
    ChatMessage, ChatRole, ProviderChatRequest, ProviderEndpoint, ToolCall, ToolSpec,
};
pub use retry::{
    RequestBodyPhase, RetryDecision, cap_retry_after, classify_retry, parse_retry_after,
};
pub use runtime::ProviderRuntime;
pub use secret::SecretString;
pub use speech::{
    SpeechAudio, SpeechAudioFormat, SpeechCapability, SpeechPreset, SpeechProviderCapabilities,
    SpeechRuntimeOwner, SpeechVoiceId, SynthesisRequest, SynthesisResult, SynthesisText,
    TranscriptionRequest, TranscriptionResult, TranscriptionText,
};
pub use speech_http::{
    MAX_INWORLD_AUDIO_BYTES, SpeechCredential, SpeechRuntime, validate_synthesis_request,
    validate_transcription_request,
};
pub use sse::{SseDecoder, SseEvent};
pub use stream::NormalizedStreamEvent;
pub use transport::{
    consume_openai_compatible_sse, consume_provider_json, consume_provider_sse,
    read_error_body_bounded, stream_provider_json, stream_provider_sse,
};
pub use url_policy::{OriginClass, host_is_loopback, join_base_path, validate_base_url};
