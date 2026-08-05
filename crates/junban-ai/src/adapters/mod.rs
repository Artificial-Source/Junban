//! Wire-family request builders and stream consumers.

mod anthropic;
mod gemini;
mod openai_chat;
mod openai_responses;

use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use serde_json::Value;

use crate::auth::build_auth_headers;
use crate::error::ProviderError;
use crate::ids::ProviderKind;
use crate::request::{ProviderChatRequest, ProviderEndpoint};

pub use anthropic::build_anthropic_body;
pub use gemini::{build_gemini_body, gemini_stream_url, gemini_unary_url};
pub use openai_chat::build_chat_completions_body;
pub use openai_responses::build_responses_body;

/// Fully prepared outbound provider HTTP request (no secrets in Debug).
#[derive(Clone)]
pub struct PreparedRequest {
    pub url: String,
    pub headers: HeaderMap,
    pub body: Value,
    pub stream: bool,
    pub kind: ProviderKind,
}

impl std::fmt::Debug for PreparedRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedRequest")
            .field("url", &self.url)
            .field("stream", &self.stream)
            .field("kind", &self.kind)
            .field("headers", &"<redacted>")
            .field("body_keys", &body_keys(&self.body))
            .finish()
    }
}

fn body_keys(body: &Value) -> Vec<String> {
    body.as_object()
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default()
}

/// Build a wire-family request for the endpoint and chat payload.
pub fn prepare_chat_request(
    endpoint: &ProviderEndpoint,
    request: &ProviderChatRequest,
) -> Result<PreparedRequest, ProviderError> {
    request.validate_bounds()?;
    let stream = !request.force_non_stream(endpoint.descriptor);
    let kind = endpoint.descriptor.kind;
    let mut headers = build_auth_headers(endpoint.descriptor.auth, endpoint.credential.as_ref())?;
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if stream {
        headers.insert(
            reqwest::header::ACCEPT,
            HeaderValue::from_static("text/event-stream"),
        );
    } else {
        headers.insert(
            reqwest::header::ACCEPT,
            HeaderValue::from_static("application/json"),
        );
    }

    let (url, body) = match kind {
        ProviderKind::OpenAiResponses => {
            let url = crate::url_policy::join_base_path(
                &endpoint.base_url,
                endpoint.descriptor.chat_path,
            )?;
            (url, build_responses_body(request, stream)?)
        }
        ProviderKind::OpenAiChatCompletions => {
            let url = crate::url_policy::join_base_path(
                &endpoint.base_url,
                endpoint.descriptor.chat_path,
            )?;
            (url, build_chat_completions_body(request, stream)?)
        }
        ProviderKind::AnthropicMessages => {
            let url = crate::url_policy::join_base_path(
                &endpoint.base_url,
                endpoint.descriptor.chat_path,
            )?;
            (url, build_anthropic_body(request, stream)?)
        }
        ProviderKind::GeminiGenerateContent => {
            let url = if stream {
                gemini_stream_url(&endpoint.base_url, request.model.as_str())?
            } else {
                gemini_unary_url(&endpoint.base_url, request.model.as_str())?
            };
            (url, build_gemini_body(request)?)
        }
    };

    Ok(PreparedRequest {
        url,
        headers,
        body,
        stream,
        kind,
    })
}
