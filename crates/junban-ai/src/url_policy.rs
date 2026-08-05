//! Provider base-URL egress policy.
//!
//! Built-in cloud presets use fixed official HTTPS origins. Ollama and LM Studio
//! default to loopback HTTP. Custom URLs are operator-authored and must not
//! contain userinfo, fragments, or query credentials.

use std::net::IpAddr;

use url::Url;

use crate::bounds::MAX_BASE_URL_BYTES;
use crate::error::ProviderError;

/// Reviewed origin class for a provider configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginClass {
    /// Fixed official HTTPS cloud origin.
    FixedCloudHttps,
    /// Loopback-only HTTP(S) local runtime.
    Loopback,
    /// Operator-authored custom endpoint under the egress policy.
    OperatorCustom,
}

/// Normalize and validate a provider base URL under the given origin class.
pub fn validate_base_url(raw: &str, class: OriginClass) -> Result<String, ProviderError> {
    if raw.is_empty() {
        return Err(ProviderError::invalid("base_url", "must not be empty"));
    }
    if raw.len() > MAX_BASE_URL_BYTES {
        return Err(ProviderError::invalid(
            "base_url",
            "exceeds maximum UTF-8 byte length",
        ));
    }
    if raw.chars().any(|ch| ch.is_control()) {
        return Err(ProviderError::invalid(
            "base_url",
            "must not contain control characters",
        ));
    }

    let url = Url::parse(raw)
        .map_err(|_| ProviderError::invalid("base_url", "must be an absolute URL"))?;

    if !url.username().is_empty() || url.password().is_some() {
        return Err(ProviderError::invalid(
            "base_url",
            "must not include URL userinfo",
        ));
    }
    if url.fragment().is_some() {
        return Err(ProviderError::invalid(
            "base_url",
            "must not include a URL fragment",
        ));
    }
    if url.query().is_some() {
        // Query credentials and any query material are rejected for provider bases.
        return Err(ProviderError::invalid(
            "base_url",
            "must not include a URL query string",
        ));
    }

    let host = url
        .host_str()
        .ok_or_else(|| ProviderError::invalid("base_url", "must include a host"))?;
    let loopback = host_is_loopback(host);

    match url.scheme() {
        "https" => match class {
            OriginClass::FixedCloudHttps | OriginClass::OperatorCustom => {}
            OriginClass::Loopback if loopback => {}
            OriginClass::Loopback => {
                return Err(ProviderError::invalid(
                    "base_url",
                    "loopback providers require a loopback host",
                ));
            }
        },
        "http" if loopback => match class {
            OriginClass::Loopback | OriginClass::OperatorCustom => {}
            OriginClass::FixedCloudHttps => {
                return Err(ProviderError::invalid(
                    "base_url",
                    "cloud providers require https",
                ));
            }
        },
        "http" => {
            return Err(ProviderError::invalid(
                "base_url",
                "non-loopback provider bases require https",
            ));
        }
        _ => {
            return Err(ProviderError::invalid("base_url", "unsupported URL scheme"));
        }
    }

    // Reject path traversal tricks and credential-looking path segments softly by
    // keeping the operator path but forbidding empty host (already handled).
    let mut normalized = url.clone();
    normalized.set_fragment(None);
    normalized.set_query(None);
    let mut out = normalized.to_string();
    if out.ends_with('/') {
        out.pop();
    }
    if out.len() > MAX_BASE_URL_BYTES {
        return Err(ProviderError::invalid(
            "base_url",
            "exceeds maximum UTF-8 byte length",
        ));
    }
    Ok(out)
}

/// Join a validated base URL with a relative API path (leading slash optional).
pub fn join_base_path(base: &str, path: &str) -> Result<String, ProviderError> {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        return Ok(base.to_owned());
    }
    let joined = format!("{base}/{path}");
    if joined.len() > MAX_BASE_URL_BYTES.saturating_mul(2) {
        return Err(ProviderError::invalid(
            "request_url",
            "exceeds maximum UTF-8 byte length",
        ));
    }
    Ok(joined)
}

#[must_use]
pub fn host_is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_userinfo_fragment_query_and_cleartext_remote() {
        assert!(
            validate_base_url(
                "https://user:pass@api.openai.com/v1",
                OriginClass::FixedCloudHttps
            )
            .is_err()
        );
        assert!(
            validate_base_url(
                "https://api.openai.com/v1#frag",
                OriginClass::FixedCloudHttps
            )
            .is_err()
        );
        assert!(
            validate_base_url(
                "https://api.openai.com/v1?api_key=secret",
                OriginClass::FixedCloudHttps
            )
            .is_err()
        );
        assert!(validate_base_url("http://example.com/v1", OriginClass::OperatorCustom).is_err());
        assert_eq!(
            validate_base_url("https://api.openai.com/v1/", OriginClass::FixedCloudHttps).unwrap(),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            validate_base_url("http://127.0.0.1:11434/v1", OriginClass::Loopback).unwrap(),
            "http://127.0.0.1:11434/v1"
        );
    }
}
