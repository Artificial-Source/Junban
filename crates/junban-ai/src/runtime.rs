//! Lazy provider runtime: chat streaming/unary and model discovery.
//!
//! Uses only [`ProviderHttpFactory`]. No network occurs at construction or when
//! AI is unused. Retries are capped and never occur after body acceptance,
//! tool/result effect, 401/403, or mid-stream failure.
//!
//! [`ProviderRuntime::chat_stream`] delivers normalized events to an async sink
//! as frames complete. Retry is allowed only before any sink event is accepted;
//! after the first effect (including status/tool/usage), failures are terminal.

use std::future::Future;
use std::time::Duration;

use crate::adapters::{PreparedRequest, prepare_chat_request};
use crate::cancel::RunCancel;
use crate::client::ProviderHttpFactory;
use crate::discovery::{DiscoveredModel, discover_models};
use crate::error::ProviderError;
use crate::request::{ProviderChatRequest, ProviderEndpoint};
use crate::retry::{RequestBodyPhase, RetryDecision, classify_retry};
use crate::stream::NormalizedStreamEvent;
use crate::transport::{await_response_headers, stream_provider_json, stream_provider_sse};

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

    /// Execute a chat request, collecting normalized events through
    /// [`Self::chat_stream`].
    pub async fn chat(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ProviderChatRequest,
        run: &RunCancel,
    ) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
        let mut events = Vec::new();
        self.chat_stream(endpoint, request, run, |event| {
            events.push(event);
            std::future::ready(Ok(()))
        })
        .await?;
        Ok(events)
    }

    /// Execute a chat request, delivering each normalized event to `on_event`
    /// as soon as its frame normalizes (SSE) or after the bounded JSON body
    /// completes (non-stream).
    ///
    /// Retry occurs only before any event is accepted by the sink. Once the
    /// sink has received any event — including status, tool, or usage — transport
    /// and sink failures are terminal and no second vendor request is issued.
    /// The sink runs behind generation-fence checks; cancellation/revocation
    /// forbids all later callbacks.
    pub async fn chat_stream<F, Fut>(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ProviderChatRequest,
        run: &RunCancel,
        mut on_event: F,
    ) -> Result<(), ProviderError>
    where
        F: FnMut(NormalizedStreamEvent) -> Fut,
        Fut: Future<Output = Result<(), ProviderError>>,
    {
        run.check_live()?;
        let prepared = prepare_chat_request(endpoint, request)?;
        let active_secret = endpoint
            .credential
            .as_ref()
            .map(crate::secret::SecretString::expose);
        let mut attempt = 0u32;
        let mut effect_started = false;
        loop {
            attempt += 1;
            run.check_live()?;
            match self
                .chat_once_stream(&prepared, run, active_secret, |event| {
                    effect_started = true;
                    on_event(event)
                })
                .await
            {
                Ok(()) => return Ok(()),
                Err(error) => {
                    // Once any sink event was accepted, never open a second request.
                    // Body acceptance / mid-stream failures remain terminal even
                    // when no normalized event was emitted yet.
                    let phase = if effect_started
                        || matches!(
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

    async fn chat_once_stream<F, Fut>(
        &self,
        prepared: &PreparedRequest,
        run: &RunCancel,
        active_secret: Option<&str>,
        on_event: F,
    ) -> Result<(), ProviderError>
    where
        F: FnMut(NormalizedStreamEvent) -> Fut,
        Fut: Future<Output = Result<(), ProviderError>>,
    {
        let client = self.factory.client()?.clone();
        run.check_live()?;
        // Race headers against the exact run token so cancel drops the send
        // future when a provider accepts the socket but withholds response headers.
        let response = await_response_headers(
            client
                .post(&prepared.url)
                .headers(prepared.headers.clone())
                .json(&prepared.body)
                .send(),
            run,
            active_secret,
        )
        .await?;

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
            stream_provider_sse(response, run, prepared.kind, on_event).await
        } else {
            stream_provider_json(response, run, prepared.kind, on_event).await
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
