//! Pre-body retry classification for provider HTTP.
//!
//! Retry only occurs for connect failure, 408, 429, or 5xx before any response
//! body or provider tool/result effect is accepted. 401/403 never retry.
//! Attempts are capped at three and `Retry-After` is bounded.

use std::time::Duration;

use crate::bounds::{MAX_RETRY_AFTER, MAX_RETRY_ATTEMPTS};
use crate::error::{ProviderError, ProviderErrorKind};

/// Whether any response body bytes (or equivalent provider effect) were accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestBodyPhase {
    /// Headers may be known, but no body/effect has been accepted yet.
    PreBody,
    /// At least one body byte, stream event, or tool/result effect was accepted.
    BodyAccepted,
}

/// Outcome of retry classification for one failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryDecision {
    DoNotRetry,
    /// Sleep at most this long before the next attempt.
    RetryAfter(Duration),
}

/// Classify whether a failure may be retried.
///
/// `attempt` is the 1-based attempt that just failed. When `attempt` is already
/// at [`MAX_RETRY_ATTEMPTS`], the decision is always [`RetryDecision::DoNotRetry`].
#[must_use]
pub fn classify_retry(
    phase: RequestBodyPhase,
    error: &ProviderError,
    attempt: u32,
) -> RetryDecision {
    if attempt >= MAX_RETRY_ATTEMPTS || phase == RequestBodyPhase::BodyAccepted {
        return RetryDecision::DoNotRetry;
    }

    match error.kind() {
        ProviderErrorKind::Connect => RetryDecision::RetryAfter(Duration::from_millis(0)),
        ProviderErrorKind::HttpStatus => match error.status() {
            Some(408 | 429) | Some(500..=599) => {
                let wait = error
                    .retry_after_ms()
                    .map(Duration::from_millis)
                    .unwrap_or(Duration::from_millis(0));
                RetryDecision::RetryAfter(cap_retry_after(wait))
            }
            Some(401 | 403) => RetryDecision::DoNotRetry,
            _ => RetryDecision::DoNotRetry,
        },
        ProviderErrorKind::Timeout
        | ProviderErrorKind::Cancelled
        | ProviderErrorKind::Stream
        | ProviderErrorKind::BoundExceeded
        | ProviderErrorKind::Invalid
        | ProviderErrorKind::Unavailable => RetryDecision::DoNotRetry,
    }
}

/// Parse a `Retry-After` header value (delta-seconds only) and cap it.
#[must_use]
pub fn parse_retry_after(raw: &str) -> Option<Duration> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // HTTP-date forms are ignored; providers in scope emit delta-seconds.
    let seconds = trimmed.parse::<u64>().ok()?;
    Some(cap_retry_after(Duration::from_secs(seconds)))
}

#[must_use]
pub fn cap_retry_after(value: Duration) -> Duration {
    value.min(MAX_RETRY_AFTER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_only_pre_body_connect_and_selected_statuses() {
        let connect = ProviderError::connect("reset");
        assert_eq!(
            classify_retry(RequestBodyPhase::PreBody, &connect, 1),
            RetryDecision::RetryAfter(Duration::from_millis(0))
        );
        assert_eq!(
            classify_retry(RequestBodyPhase::BodyAccepted, &connect, 1),
            RetryDecision::DoNotRetry
        );

        let too_many = ProviderError::http_status(429, Some(120_000));
        assert_eq!(
            classify_retry(RequestBodyPhase::PreBody, &too_many, 1),
            RetryDecision::RetryAfter(MAX_RETRY_AFTER)
        );

        let unauthorized = ProviderError::http_status(401, None);
        assert_eq!(
            classify_retry(RequestBodyPhase::PreBody, &unauthorized, 1),
            RetryDecision::DoNotRetry
        );

        let server = ProviderError::http_status(503, None);
        assert_eq!(
            classify_retry(RequestBodyPhase::PreBody, &server, 3),
            RetryDecision::DoNotRetry
        );
    }

    #[test]
    fn parse_retry_after_caps_delta_seconds() {
        assert_eq!(parse_retry_after("120"), Some(MAX_RETRY_AFTER));
        assert_eq!(parse_retry_after("5"), Some(Duration::from_secs(5)));
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT"), None);
    }
}
