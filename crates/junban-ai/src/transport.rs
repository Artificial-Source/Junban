//! Streaming and unary transport helpers for provider responses.
//!
//! Used by adapters and the Wave 0/2 contract suites. Redirect refusal, body
//! bounds, generation-fence checks, and family-specific normalization live here.
//!
//! Error-body inspection is cancellation-aware and hard-capped at
//! [`MAX_PROVIDER_ERROR_BODY_BYTES`]. Arbitrary vendor bodies never enter
//! public [`ProviderError`] values.

use reqwest::Response;

use crate::bounds::{MAX_PROVIDER_ERROR_BODY_BYTES, MAX_PROVIDER_RESPONSE_BYTES};
use crate::cancel::RunCancel;
use crate::error::{ProviderError, extract_vendor_code};
use crate::ids::ProviderKind;
use crate::normalize::{
    FrameNormalizer, NormalizedProviderFrame, normalize_openai_compatible_data,
};
use crate::retry::{RequestBodyPhase, parse_retry_after};
use crate::sse::SseDecoder;
use crate::stream::NormalizedStreamEvent;

/// Stream and normalize an OpenAI-compatible SSE HTTP response body.
pub async fn consume_openai_compatible_sse(
    response: Response,
    run: &RunCancel,
) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
    consume_provider_sse(response, run, ProviderKind::OpenAiChatCompletions).await
}

/// Stream and normalize a provider SSE body for the given wire family.
pub async fn consume_provider_sse(
    response: Response,
    run: &RunCancel,
    kind: ProviderKind,
) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
    run.check_live()?;

    let status = response.status();
    if status.is_redirection() {
        return Err(ProviderError::stream(format!(
            "refusing provider HTTP redirect ({status})"
        )));
    }

    if !status.is_success() {
        return Err(map_http_error(response, run, None).await);
    }

    let mut decoder = SseDecoder::new();
    let mut normalizer = FrameNormalizer::new(kind);
    let mut events = Vec::new();
    let mut body_phase = RequestBodyPhase::PreBody;
    let mut response = response;
    let cancel = run.token();
    loop {
        run.check_live()?;
        let chunk = tokio::select! {
            biased;
            () = cancel.cancelled() => {
                return Err(ProviderError::Cancelled);
            }
            next = response.chunk() => {
                next.map_err(|error| map_body_error(error, body_phase))?
            }
        };

        let Some(chunk) = chunk else {
            break;
        };
        if chunk.is_empty() {
            continue;
        }
        body_phase = RequestBodyPhase::BodyAccepted;

        let sse_events = decoder.push(&chunk)?;
        append_normalized(&mut events, &mut normalizer, sse_events, run)?;
        // Effect boundary: generation fence must still be live after accepting frames.
        run.check_live()?;
    }

    run.check_live()?;
    let trailing = decoder.finish()?;
    append_normalized(&mut events, &mut normalizer, trailing, run)?;

    // Gemini SSE often ends without an explicit terminal event.
    if kind == ProviderKind::GeminiGenerateContent
        && !events.iter().any(NormalizedStreamEvent::is_terminal)
    {
        events.push(NormalizedStreamEvent::Completed);
    }

    Ok(events)
}

/// Read and normalize a non-streaming JSON provider response body.
pub async fn consume_provider_json(
    response: Response,
    run: &RunCancel,
    kind: ProviderKind,
) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
    run.check_live()?;

    let status = response.status();
    if status.is_redirection() {
        return Err(ProviderError::stream(format!(
            "refusing provider HTTP redirect ({status})"
        )));
    }
    if !status.is_success() {
        return Err(map_http_error(response, run, None).await);
    }

    let body = read_bounded_success_body(response, run).await?;
    run.check_live()?;
    let mut normalizer = FrameNormalizer::new(kind);
    match normalizer.push_json_body(&body)? {
        NormalizedProviderFrame::Events(events) => {
            run.check_live()?;
            Ok(events)
        }
        NormalizedProviderFrame::Ignored => Err(ProviderError::stream(
            "provider JSON body produced no events",
        )),
    }
}

fn append_normalized(
    out: &mut Vec<NormalizedStreamEvent>,
    normalizer: &mut FrameNormalizer,
    sse_events: Vec<crate::sse::SseEvent>,
    run: &RunCancel,
) -> Result<(), ProviderError> {
    for event in sse_events {
        run.check_live()?;
        match normalizer.push_data(&event.data)? {
            NormalizedProviderFrame::Events(items) => {
                for item in items {
                    run.check_live()?;
                    out.push(item);
                }
            }
            NormalizedProviderFrame::Ignored => {}
        }
    }
    Ok(())
}

/// Map a non-success HTTP response without embedding the vendor body.
pub(crate) async fn http_status_error(
    response: Response,
    run: &RunCancel,
    active_secret: Option<&str>,
) -> ProviderError {
    map_http_error(response, run, active_secret).await
}

async fn map_http_error(
    response: Response,
    run: &RunCancel,
    active_secret: Option<&str>,
) -> ProviderError {
    let status = response.status();
    let retry_after_ms = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX));

    // Inspect at most 64 KiB for an optional short vendor code, then discard.
    let inspected = match read_error_body_bounded(response, run).await {
        Ok(body) => body,
        Err(ProviderError::Cancelled) => return ProviderError::Cancelled,
        Err(_) => {
            return ProviderError::http_status(status.as_u16(), retry_after_ms)
                .scrub_secret_opt(active_secret);
        }
    };
    let code = extract_vendor_code(&inspected);
    ProviderError::http_status_code(status.as_u16(), code, retry_after_ms)
        .scrub_secret_opt(active_secret)
}

/// Cancellation-aware incremental error-body read. Hard-stops at the 64 KiB cap
/// without retaining further bytes. Returns the inspected prefix only.
pub async fn read_error_body_bounded(
    mut response: Response,
    run: &RunCancel,
) -> Result<String, ProviderError> {
    let mut collected = Vec::with_capacity(4096);
    let cancel = run.token();
    loop {
        if collected.len() >= MAX_PROVIDER_ERROR_BODY_BYTES {
            // Cap reached: drop the response immediately (no further buffering).
            drop(response);
            break;
        }
        run.check_live()?;
        let remaining = MAX_PROVIDER_ERROR_BODY_BYTES - collected.len();
        let chunk = tokio::select! {
            biased;
            () = cancel.cancelled() => {
                drop(response);
                return Err(ProviderError::Cancelled);
            }
            next = response.chunk() => {
                next.map_err(|error| {
                    if error.is_timeout() {
                        ProviderError::Timeout
                    } else {
                        ProviderError::connect(error.to_string())
                    }
                })?
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        if chunk.is_empty() {
            continue;
        }
        let take = remaining.min(chunk.len());
        collected.extend_from_slice(&chunk[..take]);
        if take < chunk.len() {
            // Cap reached mid-chunk: stop and drop remainder/connection.
            drop(response);
            break;
        }
    }
    Ok(String::from_utf8_lossy(&collected).into_owned())
}

async fn read_bounded_success_body(
    mut response: Response,
    run: &RunCancel,
) -> Result<String, ProviderError> {
    let mut collected = Vec::new();
    let cancel = run.token();
    loop {
        run.check_live()?;
        let chunk = tokio::select! {
            biased;
            () = cancel.cancelled() => {
                return Err(ProviderError::Cancelled);
            }
            next = response.chunk() => {
                next.map_err(|error| map_body_error(error, RequestBodyPhase::BodyAccepted))?
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        if chunk.is_empty() {
            continue;
        }
        if collected.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
            return Err(ProviderError::bound("provider_response_bytes"));
        }
        collected.extend_from_slice(&chunk);
    }
    String::from_utf8(collected)
        .map_err(|_| ProviderError::stream("provider response body is not valid UTF-8"))
}

fn map_body_error(error: reqwest::Error, phase: RequestBodyPhase) -> ProviderError {
    if error.is_timeout() {
        return ProviderError::Timeout;
    }
    if phase == RequestBodyPhase::PreBody && (error.is_connect() || error.is_request()) {
        return ProviderError::connect(error.to_string());
    }
    ProviderError::stream(error.to_string())
}

trait ScrubSecretOpt {
    fn scrub_secret_opt(self, secret: Option<&str>) -> Self;
}

impl ScrubSecretOpt for ProviderError {
    fn scrub_secret_opt(self, secret: Option<&str>) -> Self {
        match secret {
            Some(secret) if !secret.is_empty() => self.scrub_secret(secret),
            _ => self,
        }
    }
}

/// Compatibility helper retained for Wave 0 tests that call the pure normalizer.
#[allow(dead_code)]
fn normalize_one(data: &str) -> Result<NormalizedProviderFrame, ProviderError> {
    normalize_openai_compatible_data(data)
}
