//! Minimal streaming transport helper for provider SSE responses.
//!
//! Used by the Wave 0 contract suite and later adapters. Does not implement
//! vendor request shaping.

use reqwest::Response;

use crate::cancel::RunCancel;
use crate::error::ProviderError;
use crate::normalize::{NormalizedProviderFrame, normalize_openai_compatible_data};
use crate::retry::{RequestBodyPhase, parse_retry_after};
use crate::sse::SseDecoder;
use crate::stream::NormalizedStreamEvent;

/// Stream and normalize an OpenAI-compatible SSE HTTP response body.
pub async fn consume_openai_compatible_sse(
    response: Response,
    run: &RunCancel,
) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
    run.check_live()?;

    let status = response.status();
    if status.is_redirection() {
        return Err(ProviderError::stream(format!(
            "refusing provider HTTP redirect ({status})"
        )));
    }

    if !status.is_success() {
        let retry_after_ms = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_retry_after)
            .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX));
        let body = read_error_body(response).await?;
        return Err(ProviderError::http_status(
            status.as_u16(),
            body,
            retry_after_ms,
        ));
    }

    let mut decoder = SseDecoder::new();
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
        append_normalized(&mut events, sse_events)?;
        run.check_live()?;
    }

    run.check_live()?;
    let trailing = decoder.finish()?;
    append_normalized(&mut events, trailing)?;
    Ok(events)
}

fn append_normalized(
    out: &mut Vec<NormalizedStreamEvent>,
    sse_events: Vec<crate::sse::SseEvent>,
) -> Result<(), ProviderError> {
    for event in sse_events {
        match normalize_openai_compatible_data(&event.data)? {
            NormalizedProviderFrame::Events(items) => out.extend(items),
            NormalizedProviderFrame::Ignored => {}
        }
    }
    Ok(())
}

async fn read_error_body(response: Response) -> Result<String, ProviderError> {
    use crate::bounds::MAX_PROVIDER_ERROR_BODY_BYTES;

    let bytes = response
        .bytes()
        .await
        .map_err(|error| ProviderError::connect(error.to_string()))?;
    let limited = if bytes.len() > MAX_PROVIDER_ERROR_BODY_BYTES {
        &bytes[..MAX_PROVIDER_ERROR_BODY_BYTES]
    } else {
        &bytes
    };
    Ok(String::from_utf8_lossy(limited).into_owned())
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
