//! OpenAI-compatible SSE data payload normalization.
//!
//! Accepts Chat Completions chunk frames and the `[DONE]` terminator. Unknown
//! JSON shapes are rejected rather than silently dropped. No vendor model
//! catalog is embedded.

use serde_json::Value;

use crate::error::ProviderError;
use crate::stream::NormalizedStreamEvent;

/// Result of normalizing one SSE `data:` payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizedProviderFrame {
    /// One or more normalized events extracted from the payload.
    Events(Vec<NormalizedStreamEvent>),
    /// Payload carried no user-visible content (e.g. role-only delta).
    Ignored,
}

/// Normalize one OpenAI-compatible SSE data payload.
pub fn normalize_openai_compatible_data(
    data: &str,
) -> Result<NormalizedProviderFrame, ProviderError> {
    let trimmed = data.trim();
    if trimmed.is_empty() {
        return Ok(NormalizedProviderFrame::Ignored);
    }
    if trimmed == "[DONE]" {
        return Ok(NormalizedProviderFrame::Events(vec![
            NormalizedStreamEvent::Completed,
        ]));
    }

    let value: Value = serde_json::from_str(trimmed)
        .map_err(|_| ProviderError::stream("provider SSE data is not valid JSON or [DONE]"))?;

    if let Some(events) = normalize_chat_completion_chunk(&value)? {
        return Ok(events);
    }
    if let Some(events) = normalize_responses_style(&value)? {
        return Ok(events);
    }

    Err(ProviderError::stream(
        "unknown provider SSE JSON frame shape",
    ))
}

fn normalize_chat_completion_chunk(
    value: &Value,
) -> Result<Option<NormalizedProviderFrame>, ProviderError> {
    let object = match value.as_object() {
        Some(object) => object,
        None => return Ok(None),
    };

    // Chat Completions chunks expose choices[]; plain error objects do not.
    let Some(choices) = object.get("choices").and_then(Value::as_array) else {
        // error: { "error": { "message": "..." } }
        if let Some(error) = object.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("provider error frame");
            return Err(ProviderError::stream(message));
        }
        return Ok(None);
    };

    if choices.is_empty() {
        return Ok(Some(NormalizedProviderFrame::Ignored));
    }

    let mut events = Vec::new();
    for choice in choices {
        let delta = choice.get("delta").unwrap_or(&Value::Null);
        if let Some(content) = delta.get("content").and_then(Value::as_str)
            && !content.is_empty()
        {
            events.push(NormalizedStreamEvent::TextDelta {
                text: content.to_owned(),
            });
        }
        // reasoning_content is intentionally not forwarded as hidden CoT.
        if delta.get("reasoning_content").is_some() {
            events.push(NormalizedStreamEvent::ReasoningStatus {
                label: "reasoning".to_owned(),
            });
        }
        if let Some(finish) = choice.get("finish_reason").and_then(Value::as_str)
            && finish == "stop"
        {
            // Completion is signaled by [DONE] or explicit Completed; finish_reason
            // alone is not terminal for all compatible servers.
        }
    }

    if let Some(usage) = object.get("usage") {
        events.push(NormalizedStreamEvent::Usage {
            input_tokens: usage.get("prompt_tokens").and_then(Value::as_u64),
            output_tokens: usage.get("completion_tokens").and_then(Value::as_u64),
        });
    }

    if events.is_empty() {
        Ok(Some(NormalizedProviderFrame::Ignored))
    } else {
        Ok(Some(NormalizedProviderFrame::Events(events)))
    }
}

fn normalize_responses_style(
    value: &Value,
) -> Result<Option<NormalizedProviderFrame>, ProviderError> {
    let object = match value.as_object() {
        Some(object) => object,
        None => return Ok(None),
    };
    let Some(frame_type) = object.get("type").and_then(Value::as_str) else {
        return Ok(None);
    };

    match frame_type {
        "response.output_text.delta" => {
            let text = object.get("delta").and_then(Value::as_str).unwrap_or("");
            if text.is_empty() {
                Ok(Some(NormalizedProviderFrame::Ignored))
            } else {
                Ok(Some(NormalizedProviderFrame::Events(vec![
                    NormalizedStreamEvent::TextDelta {
                        text: text.to_owned(),
                    },
                ])))
            }
        }
        "response.completed" => Ok(Some(NormalizedProviderFrame::Events(vec![
            NormalizedStreamEvent::Completed,
        ]))),
        "response.reasoning_summary_text.delta" | "response.reasoning.delta" => {
            // Never forward hidden chain-of-thought content.
            Ok(Some(NormalizedProviderFrame::Events(vec![
                NormalizedStreamEvent::ReasoningStatus {
                    label: "reasoning".to_owned(),
                },
            ])))
        }
        "error" => {
            let message = object
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("provider error frame");
            Err(ProviderError::stream(message))
        }
        _ => Err(ProviderError::stream(format!(
            "unknown provider SSE frame type `{frame_type}`"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_chat_chunk_done_and_rejects_unknown() {
        let frame = normalize_openai_compatible_data(
            r#"{"id":"x","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi"}}]}"#,
        )
        .unwrap();
        assert_eq!(
            frame,
            NormalizedProviderFrame::Events(vec![NormalizedStreamEvent::TextDelta {
                text: "Hi".into()
            }])
        );

        assert_eq!(
            normalize_openai_compatible_data("[DONE]").unwrap(),
            NormalizedProviderFrame::Events(vec![NormalizedStreamEvent::Completed])
        );

        let err = normalize_openai_compatible_data(r#"{"foo":1}"#).unwrap_err();
        assert!(matches!(err, ProviderError::Stream { .. }));
    }
}
