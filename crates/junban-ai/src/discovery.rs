//! Bounded model discovery and capability mapping.
//!
//! Discovery performs no network I/O at construction time. Unsupported or
//! unavailable listing fails explicitly rather than guessing a model catalog.

use std::time::Duration;

use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use serde_json::Value;

use crate::auth::build_auth_headers;
use crate::bounds::MAX_DISCOVERED_MODELS;
use crate::cancel::RunCancel;
use crate::capabilities::{ProviderCapabilities, ProviderCapability};
use crate::client::ProviderHttpFactory;
use crate::error::ProviderError;
use crate::ids::{ModelId, ProviderKind};
use crate::registry::ProviderDescriptor;
use crate::request::ProviderEndpoint;
use crate::retry::{RequestBodyPhase, RetryDecision, classify_retry};
use crate::transport::{await_response_headers, http_status_error};
use crate::url_policy::join_base_path;

/// One discovered model with mapped capabilities (never a guessed full catalog).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredModel {
    pub id: ModelId,
    pub display_name: Option<String>,
    pub capabilities: ProviderCapabilities,
}

/// Discover models for an endpoint. Returns [`ProviderError::Unavailable`] when
/// the preset does not expose model listing.
pub async fn discover_models(
    factory: &ProviderHttpFactory,
    endpoint: &ProviderEndpoint,
    run: &RunCancel,
) -> Result<Vec<DiscoveredModel>, ProviderError> {
    run.check_live()?;
    let descriptor = endpoint.descriptor;
    if !descriptor
        .capabilities
        .contains(ProviderCapability::ModelDiscovery)
    {
        return Err(ProviderError::Unavailable {
            capability: "model_discovery",
        });
    }
    let Some(models_path) = descriptor.models_path else {
        return Err(ProviderError::Unavailable {
            capability: "model_discovery",
        });
    };

    let url = join_base_path(&endpoint.base_url, models_path)?;
    let mut headers = build_auth_headers(descriptor.auth, endpoint.credential.as_ref())?;
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("application/json"),
    );

    let active_secret = endpoint
        .credential
        .as_ref()
        .map(crate::secret::SecretString::expose);

    let mut attempt = 0u32;
    loop {
        attempt += 1;
        run.check_live()?;
        match discover_once(factory, &url, &headers, descriptor, run, active_secret).await {
            Ok(models) => return Ok(models),
            Err(error) => {
                let error = match active_secret {
                    Some(secret) => error.scrub_secret(secret),
                    None => error,
                };
                match classify_retry(RequestBodyPhase::PreBody, &error, attempt) {
                    RetryDecision::DoNotRetry => return Err(error),
                    RetryDecision::RetryAfter(delay) => {
                        let delay = delay.saturating_add(jitter(attempt));
                        let cancel = run.token();
                        tokio::select! {
                            biased;
                            () = cancel.cancelled() => return Err(ProviderError::Cancelled),
                            () = tokio::time::sleep(delay) => {}
                        }
                    }
                }
            }
        }
    }
}

async fn discover_once(
    factory: &ProviderHttpFactory,
    url: &str,
    headers: &HeaderMap,
    descriptor: &ProviderDescriptor,
    run: &RunCancel,
    active_secret: Option<&str>,
) -> Result<Vec<DiscoveredModel>, ProviderError> {
    let client = factory.client()?.clone();
    run.check_live()?;
    let response = await_response_headers(
        client.get(url).headers(headers.clone()).send(),
        run,
        active_secret,
    )
    .await?;

    run.check_live()?;
    let status = response.status();
    if status.is_redirection() {
        return Err(ProviderError::stream(format!(
            "refusing provider HTTP redirect ({status})"
        )));
    }
    if !status.is_success() {
        return Err(http_status_error(response, run, active_secret).await);
    }

    let text = read_success_body_bounded(response, run).await?;
    run.check_live()?;
    parse_models_body_for_request(&text, descriptor, active_secret)
}

async fn read_success_body_bounded(
    mut response: reqwest::Response,
    run: &RunCancel,
) -> Result<String, ProviderError> {
    use crate::bounds::MAX_PROVIDER_RESPONSE_BYTES;
    let mut collected = Vec::new();
    let cancel = run.token();
    loop {
        run.check_live()?;
        let chunk = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ProviderError::Cancelled),
            next = response.chunk() => next.map_err(|error| {
                if error.is_timeout() {
                    ProviderError::Timeout
                } else {
                    ProviderError::stream(error.to_string())
                }
            })?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        if chunk.is_empty() {
            continue;
        }
        if collected.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
            return Err(ProviderError::bound("provider_response_bytes"));
        }
        collected.extend_from_slice(&chunk);
    }
    String::from_utf8(collected)
        .map_err(|_| ProviderError::stream("model list body is not valid UTF-8"))
}

/// Parse a provider model-list JSON body into bounded discovered models.
pub fn parse_models_body(
    body: &str,
    descriptor: &ProviderDescriptor,
) -> Result<Vec<DiscoveredModel>, ProviderError> {
    parse_models_body_for_request(body, descriptor, None)
}

fn parse_models_body_for_request(
    body: &str,
    descriptor: &ProviderDescriptor,
    active_secret: Option<&str>,
) -> Result<Vec<DiscoveredModel>, ProviderError> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| ProviderError::stream("model list body is not valid JSON"))?;

    let mut models = Vec::new();
    match descriptor.kind {
        ProviderKind::GeminiGenerateContent => {
            let list = value
                .get("models")
                .and_then(Value::as_array)
                .ok_or_else(|| ProviderError::stream("gemini model list missing models"))?;
            reject_reflected_fields(list, &["name", "displayName"], active_secret)?;
            for item in list {
                let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
                let id_raw = name.strip_prefix("models/").unwrap_or(name);
                if id_raw.is_empty() {
                    continue;
                }
                let Ok(id) = ModelId::new(id_raw) else {
                    continue;
                };
                let display_name = item
                    .get("displayName")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let mut capabilities = descriptor.capabilities.clone();
                if let Some(methods) = item
                    .get("supportedGenerationMethods")
                    .and_then(Value::as_array)
                {
                    let methods: Vec<&str> = methods.iter().filter_map(Value::as_str).collect();
                    if !methods.iter().any(|method| {
                        *method == "generateContent" || *method == "streamGenerateContent"
                    }) {
                        continue;
                    }
                    if !methods.contains(&"streamGenerateContent") {
                        capabilities =
                            ProviderCapabilities::new(capabilities.iter().filter(|cap| {
                                *cap != ProviderCapability::ChatStreaming
                                    && *cap != ProviderCapability::StreamingTools
                            }));
                    }
                }
                models.push(DiscoveredModel {
                    id,
                    display_name,
                    capabilities,
                });
                if models.len() >= MAX_DISCOVERED_MODELS {
                    break;
                }
            }
        }
        ProviderKind::AnthropicMessages
        | ProviderKind::OpenAiChatCompletions
        | ProviderKind::OpenAiResponses => {
            let list = value
                .get("data")
                .and_then(Value::as_array)
                .or_else(|| value.as_array())
                .ok_or_else(|| ProviderError::stream("model list missing data array"))?;
            reject_reflected_fields(list, &["id", "name", "display_name"], active_secret)?;
            for item in list {
                let id_raw = item.get("id").and_then(Value::as_str).unwrap_or_default();
                if id_raw.is_empty() {
                    continue;
                }
                let Ok(id) = ModelId::new(id_raw) else {
                    continue;
                };
                let display_name = item
                    .get("name")
                    .or_else(|| item.get("display_name"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                // Do not invent per-model tool/vision support; inherit provider caps only.
                models.push(DiscoveredModel {
                    id,
                    display_name,
                    capabilities: descriptor.capabilities.clone(),
                });
                if models.len() >= MAX_DISCOVERED_MODELS {
                    break;
                }
            }
        }
    }

    if models.is_empty() {
        return Err(ProviderError::Unavailable {
            capability: "model_discovery",
        });
    }
    Ok(models)
}

fn reject_reflected_fields(
    list: &[Value],
    fields: &[&str],
    active_secret: Option<&str>,
) -> Result<(), ProviderError> {
    let Some(secret) = active_secret.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if list.iter().any(|item| {
        fields.iter().any(|field| {
            item.get(*field)
                .and_then(Value::as_str)
                .is_some_and(|value| value.contains(secret))
        })
    }) {
        return Err(ProviderError::stream(
            "provider model list reflected active credential",
        ));
    }
    Ok(())
}

fn jitter(attempt: u32) -> Duration {
    Duration::from_millis(u64::from(attempt.wrapping_mul(37) % 250))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ProviderPreset, descriptor};

    const MARKER: &str = "reflected-discovery-credential-marker";

    #[test]
    fn every_model_list_shape_rejects_reflection_without_rendering_secret() {
        let fixtures = [
            (
                ProviderPreset::OpenAi,
                format!(r#"{{"data":[{{"id":"model-{MARKER}"}}]}}"#),
            ),
            (
                ProviderPreset::Anthropic,
                format!(r#"[{{"id":"model","name":"name-{MARKER}"}}]"#),
            ),
            (
                ProviderPreset::Groq,
                format!(r#"{{"data":[{{"id":"model","display_name":"{MARKER}"}}]}}"#),
            ),
            (
                ProviderPreset::Gemini,
                format!(
                    r#"{{"models":[{{"name":"models/model","displayName":"Gemini {MARKER}"}}]}}"#
                ),
            ),
            (
                ProviderPreset::Gemini,
                format!(r#"{{"models":[{{"name":"models/{MARKER}"}}]}}"#),
            ),
        ];

        for (preset, body) in fixtures {
            let error =
                parse_models_body_for_request(&body, descriptor(preset), Some(MARKER)).unwrap_err();
            assert!(matches!(error, ProviderError::Stream { .. }));
            assert!(!error.to_string().contains(MARKER));
            assert!(!format!("{error:?}").contains(MARKER));
        }
    }

    #[test]
    fn unrelated_model_fields_do_not_trigger_active_credential_rejection() {
        let body =
            format!(r#"{{"data":[{{"id":"safe-model","description":"ignored {MARKER}"}}]}}"#);
        let models =
            parse_models_body_for_request(&body, descriptor(ProviderPreset::OpenAi), Some(MARKER))
                .expect("unrelated field is not returned");
        assert_eq!(models.len(), 1);
    }
}
