//! Lazy provider runtime: chat streaming/unary and model discovery.
//!
//! Uses only [`ProviderHttpFactory`]. No network occurs at construction or when
//! AI is unused. Retries are capped and never occur after body acceptance,
//! tool/result effect, 401/403, or mid-stream failure.

use std::time::Duration;

use crate::adapters::{PreparedRequest, prepare_chat_request};
use crate::cancel::RunCancel;
use crate::client::ProviderHttpFactory;
use crate::discovery::{DiscoveredModel, discover_models};
use crate::error::ProviderError;
use crate::request::{ProviderChatRequest, ProviderEndpoint};
use crate::retry::{RequestBodyPhase, RetryDecision, classify_retry};
use crate::stream::NormalizedStreamEvent;
use crate::transport::{consume_provider_json, consume_provider_sse};

/// Lazy provider runtime. Default construction allocates no HTTP client.
#[derive(Debug, Default)]
pub struct ProviderRuntime {
    factory: ProviderHttpFactory,
}

impl ProviderRuntime {
    #[must_use]
    pub fn new() -> Self {
        Self {
            factory: ProviderHttpFactory::new(),
        }
    }

    #[must_use]
    pub fn factory(&self) -> &ProviderHttpFactory {
        &self.factory
    }

    #[must_use]
    pub fn is_client_constructed(&self) -> bool {
        self.factory.is_client_constructed()
    }

    /// Execute a chat request, streaming when allowed by provider capabilities.
    pub async fn chat(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ProviderChatRequest,
        run: &RunCancel,
    ) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
        run.check_live()?;
        let prepared = prepare_chat_request(endpoint, request)?;
        let active_secret = endpoint
            .credential
            .as_ref()
            .map(crate::secret::SecretString::expose);
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            run.check_live()?;
            match self.chat_once(&prepared, run, active_secret).await {
                Ok(events) => return Ok(events),
                Err(error) => {
                    // Body acceptance / mid-stream failures are terminal.
                    let phase = if matches!(
                        error,
                        ProviderError::Stream { .. }
                            | ProviderError::BoundExceeded { .. }
                            | ProviderError::Cancelled
                    ) {
                        RequestBodyPhase::BodyAccepted
                    } else {
                        RequestBodyPhase::PreBody
                    };
                    match classify_retry(phase, &error, attempt) {
                        RetryDecision::DoNotRetry => return Err(error),
                        RetryDecision::RetryAfter(delay) => {
                            let delay = delay.saturating_add(jitter(attempt));
                            let cancel = run.token();
                            tokio::select! {
                                biased;
                                () = cancel.cancelled() => {
                                    return Err(ProviderError::Cancelled);
                                }
                                () = tokio::time::sleep(delay) => {}
                            }
                        }
                    }
                }
            }
        }
    }

    async fn chat_once(
        &self,
        prepared: &PreparedRequest,
        run: &RunCancel,
        active_secret: Option<&str>,
    ) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
        let client = self.factory.client()?.clone();
        run.check_live()?;
        let response = client
            .post(&prepared.url)
            .headers(prepared.headers.clone())
            .json(&prepared.body)
            .send()
            .await
            .map_err(|error| {
                let err = if error.is_timeout() {
                    ProviderError::Timeout
                } else {
                    ProviderError::connect(error.to_string())
                };
                match active_secret {
                    Some(secret) => err.scrub_secret(secret),
                    None => err,
                }
            })?;

        // Headers received — still pre-body until the first body byte is accepted.
        run.check_live()?;
        let status = response.status();
        if status.is_redirection() {
            return Err(ProviderError::stream(format!(
                "refusing provider HTTP redirect ({status})"
            )));
        }
        if !status.is_success() {
            return Err(crate::transport::http_status_error(response, run, active_secret).await);
        }
        if prepared.stream {
            consume_provider_sse(response, run, prepared.kind).await
        } else {
            consume_provider_json(response, run, prepared.kind).await
        }
    }

    /// Discover models for the endpoint.
    pub async fn discover_models(
        &self,
        endpoint: &ProviderEndpoint,
        run: &RunCancel,
    ) -> Result<Vec<DiscoveredModel>, ProviderError> {
        discover_models(&self.factory, endpoint, run).await
    }
}

fn jitter(attempt: u32) -> Duration {
    Duration::from_millis(u64::from(attempt.wrapping_mul(37) % 250))
}
