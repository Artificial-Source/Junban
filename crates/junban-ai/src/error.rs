//! Bounded provider errors with structural secret redaction.

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

/// Provider-layer failure. Display and debug forms are redacted.
#[derive(Clone, PartialEq, Eq, Error)]
pub enum ProviderError {
    #[error("provider connect failed: {message}")]
    Connect { message: String },
    #[error("provider request timed out")]
    Timeout,
    #[error("provider run cancelled")]
    Cancelled,
    #[error("provider HTTP {status}")]
    HttpStatus {
        status: u16,
        message: String,
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

    #[must_use]
    pub fn http_status(
        status: u16,
        message: impl Into<String>,
        retry_after_ms: Option<u64>,
    ) -> Self {
        Self::HttpStatus {
            status,
            message: redact_sensitive(&message.into()),
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
    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            Self::HttpStatus { retry_after_ms, .. } => *retry_after_ms,
            _ => None,
        }
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
                message,
                retry_after_ms,
            } => formatter
                .debug_struct("HttpStatus")
                .field("status", status)
                .field("message", &redact_sensitive(message))
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
}
