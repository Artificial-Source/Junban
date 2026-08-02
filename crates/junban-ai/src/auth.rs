//! Provider authentication header construction.
//!
//! OAuth is not emulated. Supported schemes are bearer tokens, Anthropic
//! `x-api-key`, Gemini `x-goog-api-key`, and optional none for local runtimes.

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::client::{bearer_authorization_header, sensitive_header};
use crate::error::ProviderError;
use crate::secret::SecretString;

/// Reviewed authentication schemes for built-in providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AuthScheme {
    /// `Authorization: Bearer <token>`
    Bearer,
    /// Anthropic `x-api-key` plus fixed `anthropic-version`.
    AnthropicApiKey,
    /// Gemini `x-goog-api-key` header (never query credentials).
    GoogleApiKey,
    /// No credential required (loopback local servers).
    None,
}

impl AuthScheme {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Bearer => "bearer",
            Self::AnthropicApiKey => "anthropic_api_key",
            Self::GoogleApiKey => "google_api_key",
            Self::None => "none",
        }
    }

    #[must_use]
    pub const fn requires_credential(self) -> bool {
        !matches!(self, Self::None)
    }
}

/// Anthropic Messages API version header value (current stable contract).
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Build request headers for the given auth scheme and optional credential.
pub fn build_auth_headers(
    scheme: AuthScheme,
    credential: Option<&SecretString>,
) -> Result<HeaderMap, ProviderError> {
    let mut headers = HeaderMap::new();
    match scheme {
        AuthScheme::None => {
            if let Some(credential) = credential.filter(|value| !value.is_empty()) {
                // Local servers may still accept an optional bearer.
                let (name, value) = bearer_authorization_header(credential.expose())?;
                headers.insert(name, value);
            }
        }
        AuthScheme::Bearer => {
            let token = require_credential(credential)?;
            let (name, value) = bearer_authorization_header(token.expose())?;
            headers.insert(name, value);
        }
        AuthScheme::AnthropicApiKey => {
            let token = require_credential(credential)?;
            headers.insert(
                HeaderName::from_static("x-api-key"),
                sensitive_header(token.expose())?,
            );
            headers.insert(
                HeaderName::from_static("anthropic-version"),
                HeaderValue::from_static(ANTHROPIC_VERSION),
            );
        }
        AuthScheme::GoogleApiKey => {
            let token = require_credential(credential)?;
            headers.insert(
                HeaderName::from_static("x-goog-api-key"),
                sensitive_header(token.expose())?,
            );
        }
    }
    Ok(headers)
}

fn require_credential(credential: Option<&SecretString>) -> Result<&SecretString, ProviderError> {
    match credential {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(ProviderError::invalid(
            "credential",
            "provider requires a credential",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_and_vendor_headers_are_sensitive() {
        let secret = SecretString::new("synthetic-credential-value");
        let headers = build_auth_headers(AuthScheme::Bearer, Some(&secret)).unwrap();
        let value = headers.get(reqwest::header::AUTHORIZATION).unwrap();
        assert!(value.is_sensitive());
        assert!(!format!("{value:?}").contains("synthetic-credential-value"));

        let headers = build_auth_headers(AuthScheme::AnthropicApiKey, Some(&secret)).unwrap();
        let value = headers.get("x-api-key").unwrap();
        assert!(value.is_sensitive());

        let headers = build_auth_headers(AuthScheme::GoogleApiKey, Some(&secret)).unwrap();
        let value = headers.get("x-goog-api-key").unwrap();
        assert!(value.is_sensitive());
    }

    #[test]
    fn none_allows_missing_credential() {
        let headers = build_auth_headers(AuthScheme::None, None).unwrap();
        assert!(headers.get(reqwest::header::AUTHORIZATION).is_none());
    }
}
