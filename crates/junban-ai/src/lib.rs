//! Optional provider-contract foundation for Junban AI.
//!
//! Wave 0 establishes provider-neutral identifiers, bounded SSE decoding,
//! retry classification, generation cancellation, and a lazy HTTP client
//! factory. No vendor SDK, storage, or server composition lives here yet.
//!
//! This crate performs no global runtime initialization. Constructing the
//! default [`ProviderHttpFactory`] must not create a `reqwest` client or TLS
//! pool.

mod bounds;
mod cancel;
mod capabilities;
mod client;
mod error;
mod ids;
mod normalize;
mod retry;
mod sse;
mod stream;
mod transport;

pub use bounds::{
    MAX_PROVIDER_ERROR_BODY_BYTES, MAX_PROVIDER_RESPONSE_BYTES, MAX_PROVIDER_STREAM_FRAME_BYTES,
    MAX_RETRY_AFTER, MAX_RETRY_ATTEMPTS,
};
pub use cancel::{Generation, GenerationFence, RunCancel, RunId};
pub use capabilities::{ProviderCapabilities, ProviderCapability};
pub use client::{
    ProviderHttpFactory, bearer_authorization_header, build_provider_client, sensitive_header,
};
pub use error::{ProviderError, ProviderErrorKind, redact_sensitive};
pub use ids::{ModelId, ProviderId, ProviderKind};
pub use normalize::{NormalizedProviderFrame, normalize_openai_compatible_data};
pub use retry::{RequestBodyPhase, RetryDecision, classify_retry, parse_retry_after};
pub use sse::{SseDecoder, SseEvent};
pub use stream::NormalizedStreamEvent;
pub use transport::consume_openai_compatible_sse;
