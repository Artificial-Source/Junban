//! Streaming and unary transport helpers for provider responses.
//!
//! Used by adapters and the Wave 0/2/3e contract suites. Redirect refusal, body
//! bounds, generation-fence checks, and family-specific normalization live here.
//!
//! Incremental SSE/JSON consumers deliver each [`NormalizedStreamEvent`] through
//! an async sink as soon as a frame normalizes. Collecting helpers are thin
//! wrappers over that primitive. There is no unbounded event queue: the consumer
//! awaits the sink before reading further body bytes.
//!
//! Error-body inspection is cancellation-aware and hard-capped at
//! [`MAX_PROVIDER_ERROR_BODY_BYTES`]. Arbitrary vendor bodies never enter
//! public [`ProviderError`] values.

use std::future::Future;

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
///
/// Collects through [`stream_provider_sse`] so callers observe the same event
/// order as the incremental sink API.
pub async fn consume_provider_sse(
    response: Response,
    run: &RunCancel,
    kind: ProviderKind,
) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
    let mut events = Vec::new();
    stream_provider_sse(response, run, kind, |event| {
        events.push(event);
        std::future::ready(Ok(()))
    })
    .await?;
    Ok(events)
}

/// Incrementally stream and normalize a provider SSE body.
///
/// Each normalized event is delivered to `on_event` immediately after its frame
/// normalizes, before further body bytes are read. The sink is awaited (natural
/// backpressure); failures and cancellation are checked around every delivery.
///
/// Sink errors should be stable [`ProviderError`] values (typically
/// [`ProviderError::Cancelled`] or [`ProviderError::stream_failed`]) and must
/// not embed vendor bodies or secrets. Callbacks never run after the generation
/// fence is revoked.
pub async fn stream_provider_sse<F, Fut>(
    response: Response,
    run: &RunCancel,
    kind: ProviderKind,
    mut on_event: F,
) -> Result<(), ProviderError>
where
    F: FnMut(NormalizedStreamEvent) -> Fut,
    Fut: Future<Output = Result<(), ProviderError>>,
{
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
    let mut body_phase = RequestBodyPhase::PreBody;
    let mut saw_terminal = false;
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
        emit_normalized(
            &mut normalizer,
            sse_events,
            run,
            &mut on_event,
            &mut saw_terminal,
        )
        .await?;
        // Effect boundary: generation fence must still be live after accepting frames.
        run.check_live()?;
    }

    run.check_live()?;
    let trailing = decoder.finish()?;
    emit_normalized(
        &mut normalizer,
        trailing,
        run,
        &mut on_event,
        &mut saw_terminal,
    )
    .await?;

    // Gemini SSE often ends without an explicit terminal event.
    if kind == ProviderKind::GeminiGenerateContent && !saw_terminal {
        deliver_event(
            NormalizedStreamEvent::Completed,
            run,
            &mut on_event,
            &mut saw_terminal,
        )
        .await?;
    }

    Ok(())
}

/// Read and normalize a non-streaming JSON provider response body.
///
/// Collects through [`stream_provider_json`].
pub async fn consume_provider_json(
    response: Response,
    run: &RunCancel,
    kind: ProviderKind,
) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
    let mut events = Vec::new();
    stream_provider_json(response, run, kind, |event| {
        events.push(event);
        std::future::ready(Ok(()))
    })
    .await?;
    Ok(events)
}

/// Normalize a non-streaming JSON provider body, then deliver events in order.
///
/// The bounded body is fully read before any sink delivery (JSON is not framed).
pub async fn stream_provider_json<F, Fut>(
    response: Response,
    run: &RunCancel,
    kind: ProviderKind,
    mut on_event: F,
) -> Result<(), ProviderError>
where
    F: FnMut(NormalizedStreamEvent) -> Fut,
    Fut: Future<Output = Result<(), ProviderError>>,
{
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
    let mut saw_terminal = false;
    match normalizer.push_json_body(&body)? {
        NormalizedProviderFrame::Events(events) => {
            for event in events {
                deliver_event(event, run, &mut on_event, &mut saw_terminal).await?;
            }
            Ok(())
        }
        NormalizedProviderFrame::Ignored => Err(ProviderError::stream(
            "provider JSON body produced no events",
        )),
    }
}

async fn emit_normalized<F, Fut>(
    normalizer: &mut FrameNormalizer,
    sse_events: Vec<crate::sse::SseEvent>,
    run: &RunCancel,
    on_event: &mut F,
    saw_terminal: &mut bool,
) -> Result<(), ProviderError>
where
    F: FnMut(NormalizedStreamEvent) -> Fut,
    Fut: Future<Output = Result<(), ProviderError>>,
{
    for event in sse_events {
        run.check_live()?;
        match normalizer.push_data(&event.data)? {
            NormalizedProviderFrame::Events(items) => {
                for item in items {
                    deliver_event(item, run, on_event, saw_terminal).await?;
                }
            }
            NormalizedProviderFrame::Ignored => {}
        }
    }
    Ok(())
}

async fn deliver_event<F, Fut>(
    event: NormalizedStreamEvent,
    run: &RunCancel,
    on_event: &mut F,
    saw_terminal: &mut bool,
) -> Result<(), ProviderError>
where
    F: FnMut(NormalizedStreamEvent) -> Fut,
    Fut: Future<Output = Result<(), ProviderError>>,
{
    // Fence before delivery: revocation forbids the callback entirely.
    run.check_live()?;
    if event.is_terminal() {
        *saw_terminal = true;
    }
    let sink_result = on_event(event).await;
    // Fence after delivery: cancel during the sink await is terminal and
    // forbids treating a successful sink result as authorization to continue.
    run.check_live()?;
    // Map sink failures to stable variants without attaching payload material.
    match sink_result {
        Ok(()) => Ok(()),
        Err(ProviderError::Cancelled) => Err(ProviderError::Cancelled),
        Err(ProviderError::BoundExceeded { bound }) => Err(ProviderError::BoundExceeded { bound }),
        Err(ProviderError::Timeout) => Err(ProviderError::Timeout),
        Err(ProviderError::Unavailable { capability }) => {
            Err(ProviderError::Unavailable { capability })
        }
        Err(ProviderError::HttpStatus {
            status,
            code,
            retry_after_ms,
        }) => Err(ProviderError::HttpStatus {
            status,
            code,
            retry_after_ms,
        }),
        Err(ProviderError::Invalid { field, reason }) => {
            Err(ProviderError::Invalid { field, reason })
        }
        // Connect/Stream (and any unexpected) sink failures collapse to a stable
        // stream failure so backpressure/close paths cannot reflect body bytes.
        Err(ProviderError::Connect { .. } | ProviderError::Stream { .. }) => {
            Err(ProviderError::stream_failed())
        }
    }
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

/// Await a reqwest response-headers future until headers arrive or the run is
/// cancelled. Cancellation drops the send future immediately so a provider that
/// accepts the connection but withholds headers cannot pin the run until the
/// client timeout.
pub(crate) async fn await_response_headers<F>(
    future: F,
    run: &RunCancel,
    active_secret: Option<&str>,
) -> Result<Response, ProviderError>
where
    F: Future<Output = Result<Response, reqwest::Error>>,
{
    let cancel = run.token();
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(ProviderError::Cancelled),
        result = future => result.map_err(|error| {
            let err = if error.is_timeout() {
                ProviderError::Timeout
            } else {
                ProviderError::connect(error.to_string())
            };
            err.scrub_secret_opt(active_secret)
        }),
    }
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
