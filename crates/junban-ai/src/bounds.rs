//! Frozen provider transport bounds from the Phase 6 contract.

use std::time::Duration;

/// Maximum UTF-8 bytes accepted for one SSE event frame (all field lines).
pub const MAX_PROVIDER_STREAM_FRAME_BYTES: usize = 64 * 1024;

/// Maximum total provider response body bytes inspected for one request.
pub const MAX_PROVIDER_RESPONSE_BYTES: usize = 1024 * 1024;

/// Maximum provider error body bytes retained for classification/redaction.
pub const MAX_PROVIDER_ERROR_BODY_BYTES: usize = 64 * 1024;

/// Maximum attempts for a single logical provider operation (initial + retries).
pub const MAX_RETRY_ATTEMPTS: u32 = 3;

/// Upper bound applied to provider `Retry-After` values.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

/// Maximum accepted length for a provider identifier.
pub const MAX_PROVIDER_ID_BYTES: usize = 64;

/// Maximum accepted length for a model identifier.
pub const MAX_MODEL_ID_BYTES: usize = 256;

/// Maximum accepted length for a provider base URL.
pub const MAX_BASE_URL_BYTES: usize = 2_048;

/// Maximum discovered models retained/returned from one listing.
pub const MAX_DISCOVERED_MODELS: usize = 1_000;

/// Maximum UTF-8 bytes accepted for one tool-call arguments JSON blob.
pub const MAX_TOOL_ARGUMENTS_BYTES: usize = 128 * 1024;

/// Maximum UTF-8 bytes accepted for one text delta fragment after normalization.
pub const MAX_TEXT_DELTA_BYTES: usize = 64 * 1024;

/// Cloud speech request/response audio ceiling (Phase 6 context map).
pub const MAX_SPEECH_AUDIO_BYTES: usize = 25 * 1024 * 1024;

/// Transcription text ceiling — frozen user-input bound.
pub const MAX_SPEECH_TRANSCRIPTION_TEXT_BYTES: usize = junban_domain::AI_USER_INPUT_BYTES_MAX;

/// Synthesis input text ceiling — frozen assistant-text bound.
pub const MAX_SPEECH_SYNTHESIS_TEXT_BYTES: usize = junban_domain::AI_ASSISTANT_TEXT_BYTES_MAX;
