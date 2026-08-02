//! Lazy provider HTTP client factory.
//!
//! Default construction allocates no `reqwest::Client` and no TLS pool. The
//! first configured operation builds one client with redirects and ambient
//! proxies disabled. Authorization header values are marked sensitive.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use reqwest::{
    Client,
    header::{HeaderName, HeaderValue},
    redirect::Policy,
};

use crate::error::ProviderError;

/// Default overall request timeout for provider calls.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Default connect timeout for provider calls.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Default idle pool timeout for provider connections.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Build the shared provider HTTP client policy.
pub fn build_provider_client() -> Result<Client, ProviderError> {
    Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .timeout(DEFAULT_REQUEST_TIMEOUT)
        .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
        .pool_idle_timeout(DEFAULT_IDLE_TIMEOUT)
        .pool_max_idle_per_host(2)
        .build()
        .map_err(|error| ProviderError::connect(error.to_string()))
}

/// Mark an arbitrary header value sensitive so Debug/logs omit its contents.
pub fn sensitive_header(value: &str) -> Result<HeaderValue, ProviderError> {
    let mut header = HeaderValue::from_str(value)
        .map_err(|_| ProviderError::invalid("header_value", "must be a valid HTTP header value"))?;
    header.set_sensitive(true);
    Ok(header)
}

/// Build a sensitive `Authorization: Bearer …` header value.
pub fn bearer_authorization_header(
    token: &str,
) -> Result<(HeaderName, HeaderValue), ProviderError> {
    if token.is_empty() {
        return Err(ProviderError::invalid(
            "authorization",
            "token must not be empty",
        ));
    }
    if token
        .chars()
        .any(|ch| ch.is_control() || ch == '\r' || ch == '\n')
    {
        return Err(ProviderError::invalid(
            "authorization",
            "token must not contain control characters",
        ));
    }
    let value = sensitive_header(&format!("Bearer {token}"))?;
    Ok((reqwest::header::AUTHORIZATION, value))
}

type ClientBuilderFn = fn() -> Result<Client, ProviderError>;

/// Process-local lazy factory. Safe to keep on the server startup path unused.
#[derive(Debug, Default)]
pub struct ProviderHttpFactory {
    client: OnceLock<Result<Client, ProviderError>>,
    /// Test/observation counter: increments exactly once per successful construction.
    constructed: AtomicBool,
    /// Optional construction hook counter for tests that inject builders.
    construct_calls: AtomicUsize,
    /// Optional replacement builder used only by tests.
    test_builder: Mutex<Option<ClientBuilderFn>>,
}

impl ProviderHttpFactory {
    /// Create a factory that has not constructed a client.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns true only after a successful client construction.
    #[must_use]
    pub fn is_client_constructed(&self) -> bool {
        self.constructed.load(Ordering::SeqCst)
    }

    /// Number of builder invocations observed (including failed test builders).
    #[must_use]
    pub fn construct_calls(&self) -> usize {
        self.construct_calls.load(Ordering::SeqCst)
    }

    /// Borrow the lazily constructed client, building it on first use.
    pub fn client(&self) -> Result<&Client, ProviderError> {
        match self.client.get_or_init(|| {
            self.construct_calls.fetch_add(1, Ordering::SeqCst);
            let builder = self
                .test_builder
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .unwrap_or(build_provider_client);
            builder()
        }) {
            Ok(client) => {
                self.constructed.store(true, Ordering::SeqCst);
                Ok(client)
            }
            Err(error) => Err(error.clone()),
        }
    }

    /// Install a test-only builder. Must be called before first [`Self::client`].
    #[cfg(test)]
    pub fn set_test_builder(&self, builder: ClientBuilderFn) {
        *self
            .test_builder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(builder);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_factory_constructs_no_client() {
        let factory = ProviderHttpFactory::new();
        assert!(!factory.is_client_constructed());
        assert_eq!(factory.construct_calls(), 0);
    }

    #[test]
    fn concurrent_first_use_constructs_exactly_one_client() {
        let factory = std::sync::Arc::new(ProviderHttpFactory::new());
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let factory = std::sync::Arc::clone(&factory);
                scope.spawn(move || {
                    factory.client().unwrap();
                });
            }
        });
        assert!(factory.is_client_constructed());
        assert_eq!(factory.construct_calls(), 1);
    }

    #[test]
    fn bearer_header_is_sensitive() {
        let (name, value) = bearer_authorization_header("super-secret").unwrap();
        assert_eq!(name, reqwest::header::AUTHORIZATION);
        assert!(value.is_sensitive());
        let debug = format!("{value:?}");
        assert!(!debug.contains("super-secret"));
    }
}
