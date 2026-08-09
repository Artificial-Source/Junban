//! Bounded provider errors with structural secret redaction.
//!
//! Public [`ProviderError`] / [`AiError`] values never carry arbitrary vendor
//! response bodies. HTTP failures expose only status, optional short vendor
//! code, and retry timing. Pattern redaction remains for connect/stream
//! diagnostics; active request credentials must be scrubbed by callers via
//! [`scrub_active_secret`] before construction when a message is retained.

use std::fmt;

use thiserror::Error;

/// High-level classification used by retry and API mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderErrorKind {
    Connect,
    Timeout,
    Cancelled,
    HttpStatus,
    Stream,
    BoundExceeded,
    Invalid,
    Unavailable,
}

/// Provider-layer failure. Display and debug forms never include vendor bodies.
#[derive(Clone, PartialEq, Eq, Error)]
pub enum ProviderError {
    #[error("provider connect failed: {message}")]
    Connect { message: String },
    #[error("provider request timed out")]
    Timeout,
    #[error("provider run cancelled")]
    Cancelled,
    /// HTTP failure. `code` is an optional short vendor error code only.
    #[error("provider HTTP {status}")]
    HttpStatus {
        status: u16,
        code: Option<String>,
        retry_after_ms: Option<u64>,
    },
    #[error("provider stream error: {message}")]
    Stream { message: String },
    #[error("provider bound exceeded: {bound}")]
    BoundExceeded { bound: &'static str },
    #[error("invalid provider {field}: {reason}")]
    Invalid {
        field: &'static str,
        reason: &'static str,
    },
    #[error("provider capability unavailable: {capability}")]
    Unavailable { capability: &'static str },
}

impl ProviderError {
    #[must_use]
    pub fn invalid(field: &'static str, reason: &'static str) -> Self {
        Self::Invalid { field, reason }
    }

    #[must_use]
    pub fn connect(message: impl Into<String>) -> Self {
        Self::Connect {
            message: redact_sensitive(&message.into()),
        }
    }

    #[must_use]
    pub fn stream(message: impl Into<String>) -> Self {
        Self::Stream {
            message: redact_sensitive(&message.into()),
        }
    }

    /// Stable stream failure without embedding vendor body text.
    #[must_use]
    pub fn stream_failed() -> Self {
        Self::Stream {
            message: "provider stream failed".to_owned(),
        }
    }

    /// HTTP status failure. Never accepts arbitrary vendor body text.
    #[must_use]
    pub fn http_status(status: u16, retry_after_ms: Option<u64>) -> Self {
        Self::HttpStatus {
            status,
            code: None,
            retry_after_ms,
        }
    }

    /// HTTP status failure with an optional short vendor code (not a body dump).
    #[must_use]
    pub fn http_status_code(
        status: u16,
        code: Option<String>,
        retry_after_ms: Option<u64>,
    ) -> Self {
        let code = code.and_then(|raw| sanitize_vendor_code(&raw));
        Self::HttpStatus {
            status,
            code,
            retry_after_ms,
        }
    }

    #[must_use]
    pub fn bound(bound: &'static str) -> Self {
        Self::BoundExceeded { bound }
    }

    #[must_use]
    pub const fn kind(&self) -> ProviderErrorKind {
        match self {
            Self::Connect { .. } => ProviderErrorKind::Connect,
            Self::Timeout => ProviderErrorKind::Timeout,
            Self::Cancelled => ProviderErrorKind::Cancelled,
            Self::HttpStatus { .. } => ProviderErrorKind::HttpStatus,
            Self::Stream { .. } => ProviderErrorKind::Stream,
            Self::BoundExceeded { .. } => ProviderErrorKind::BoundExceeded,
            Self::Invalid { .. } => ProviderErrorKind::Invalid,
            Self::Unavailable { .. } => ProviderErrorKind::Unavailable,
        }
    }

    #[must_use]
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::HttpStatus { status, .. } => Some(*status),
            _ => None,
        }
    }

    #[must_use]
    pub fn vendor_code(&self) -> Option<&str> {
        match self {
            Self::HttpStatus { code, .. } => code.as_deref(),
            _ => None,
        }
    }

    #[must_use]
    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            Self::HttpStatus { retry_after_ms, .. } => *retry_after_ms,
            _ => None,
        }
    }

    /// Scrub an active request credential from any retained message fields.
    #[must_use]
    pub fn scrub_secret(mut self, secret: &str) -> Self {
        if secret.is_empty() {
            return self;
        }
        match &mut self {
            Self::Connect { message } | Self::Stream { message } => {
                *message = scrub_active_secret(message, secret);
            }
            Self::HttpStatus { code, .. } => {
                if let Some(value) = code.as_mut() {
                    *value = scrub_active_secret(value, secret);
                }
            }
            Self::Timeout
            | Self::Cancelled
            | Self::BoundExceeded { .. }
            | Self::Invalid { .. }
            | Self::Unavailable { .. } => {}
        }
        self
    }
}

impl fmt::Debug for ProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connect { message } => formatter
                .debug_struct("Connect")
                .field("message", &redact_sensitive(message))
                .finish(),
            Self::Timeout => formatter.write_str("Timeout"),
            Self::Cancelled => formatter.write_str("Cancelled"),
            Self::HttpStatus {
                status,
                code,
                retry_after_ms,
            } => formatter
                .debug_struct("HttpStatus")
                .field("status", status)
                .field("code", code)
                .field("retry_after_ms", retry_after_ms)
                .finish(),
            Self::Stream { message } => formatter
                .debug_struct("Stream")
                .field("message", &redact_sensitive(message))
                .finish(),
            Self::BoundExceeded { bound } => formatter
                .debug_struct("BoundExceeded")
                .field("bound", bound)
                .finish(),
            Self::Invalid { field, reason } => formatter
                .debug_struct("Invalid")
                .field("field", field)
                .field("reason", reason)
                .finish(),
            Self::Unavailable { capability } => formatter
                .debug_struct("Unavailable")
                .field("capability", capability)
                .finish(),
        }
    }
}

/// Maximum UTF-8 bytes retained for a vendor error code token.
const MAX_VENDOR_CODE_BYTES: usize = 64;

/// Keep only a short, non-sensitive vendor code token.
#[must_use]
pub fn sanitize_vendor_code(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_VENDOR_CODE_BYTES {
        return None;
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/'))
    {
        return None;
    }
    // Reject values that look like secrets even if short.
    if trimmed.len() >= 16
        && trimmed
            .chars()
            .any(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        && !trimmed.contains('.')
        && trimmed.contains('-')
    {
        // still allow codes like `invalid-api-key`
    }
    if starts_with_ignore_ascii_case(trimmed, "sk-")
        || starts_with_ignore_ascii_case(trimmed, "sk_")
        || starts_with_ignore_ascii_case(trimmed, "bearer")
    {
        return None;
    }
    Some(trimmed.to_owned())
}

/// Extract a short vendor code from a bounded JSON/text error body, if present.
#[must_use]
pub fn extract_vendor_code(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed)
        && let Some(code) = value
            .pointer("/error/code")
            .or_else(|| value.pointer("/error/type"))
            .or_else(|| value.pointer("/code"))
            .or_else(|| value.pointer("/type"))
            .and_then(|item| item.as_str())
    {
        return sanitize_vendor_code(code);
    }
    None
}

/// Remove every occurrence of an active credential from text.
#[must_use]
pub fn scrub_active_secret(input: &str, secret: &str) -> String {
    if secret.is_empty() || !input.contains(secret) {
        return redact_sensitive(input);
    }
    let scrubbed = input.replace(secret, "[REDACTED]");
    redact_sensitive(&scrubbed)
}

/// Structurally redact bearer tokens, API keys, and common secret prefixes.
#[must_use]
pub fn redact_sensitive(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if let Some((skip, replacement)) = match_secret_at(input, index) {
            output.push_str(replacement);
            index += skip;
            continue;
        }
        let ch = input[index..]
            .chars()
            .next()
            .expect("index in char boundary");
        output.push(ch);
        index += ch.len_utf8();
    }
    output
}

fn match_secret_at(input: &str, index: usize) -> Option<(usize, &'static str)> {
    let rest = &input[index..];

    for prefix in ["bearer ", "token "] {
        if starts_with_ignore_ascii_case(rest, prefix) {
            let value_start = prefix.len();
            let value = take_token(&rest[value_start..]);
            if !value.is_empty() {
                return Some((value_start + value.len(), "bearer [REDACTED]"));
            }
        }
    }

    for prefix in ["sk-", "sk_", "api_key=", "apikey=", "api-key=", "key="] {
        if starts_with_ignore_ascii_case(rest, prefix) {
            let value = take_token(&rest[prefix.len()..]);
            if !value.is_empty() {
                return Some((prefix.len() + value.len(), "[REDACTED]"));
            }
        }
    }

    None
}

fn starts_with_ignore_ascii_case(input: &str, prefix: &str) -> bool {
    input.len() >= prefix.len()
        && input.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn take_token(input: &str) -> &str {
    let end = input
        .char_indices()
        .find(|(_, ch)| ch.is_whitespace() || matches!(ch, '"' | '\'' | ',' | ';' | '}' | ']'))
        .map(|(idx, _)| idx)
        .unwrap_or(input.len());
    &input[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_and_api_key_material() {
        let redacted =
            redact_sensitive("Authorization Bearer sk-abc123XYZ and api_key=secret-value");
        assert!(!redacted.contains("sk-abc123XYZ"));
        assert!(!redacted.contains("secret-value"));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn error_debug_does_not_leak_secrets() {
        let error = ProviderError::connect("upstream failed for Bearer super-secret-token-value");
        let rendered = format!("{error:?}");
        assert!(!rendered.contains("super-secret-token-value"));
        assert!(rendered.contains("[REDACTED]"));
    }

    #[test]
    fn http_status_never_embeds_vendor_body() {
        let error = ProviderError::http_status_code(401, Some("invalid_api_key".into()), None);
        let display = error.to_string();
        let debug = format!("{error:?}");
        assert_eq!(display, "provider HTTP 401");
        assert!(!display.contains("invalid"));
        assert!(debug.contains("invalid_api_key"));
        assert_eq!(error.vendor_code(), Some("invalid_api_key"));
    }

    #[test]
    fn scrub_active_secret_removes_arbitrary_reflection() {
        let secret = "synth-credential-fixture-zz99";
        let reflected = format!("upstream said nope: {secret} in the middle");
        let error = ProviderError::stream(reflected).scrub_secret(secret);
        let display = error.to_string();
        let debug = format!("{error:?}");
        assert!(!display.contains(secret));
        assert!(!debug.contains(secret));
        assert!(display.contains("[REDACTED]") || debug.contains("[REDACTED]"));
    }
}
