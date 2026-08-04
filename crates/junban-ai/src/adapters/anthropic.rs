//! Anthropic Messages API wire adapter.

use serde_json::{Value, json};

use crate::error::ProviderError;
use crate::request::{ChatRole, ProviderChatRequest, ToolSpec};

pub fn build_anthropic_body(
    request: &ProviderChatRequest,
    stream: bool,
) -> Result<Value, ProviderError> {
    let mut system = None;
    let mut messages = Vec::new();
    for message in &request.messages {
        match message.role {
            ChatRole::System => {
                system = Some(message.content.clone());
            }
            ChatRole::User => {
                messages.push(json!({
                    "role": "user",
                    "content": message.content,
                }));
            }
            ChatRole::Assistant => {
                let mut content = Vec::new();
                if !message.content.is_empty() {
                    content.push(json!({
                        "type": "text",
                        "text": message.content,
                    }));
                }
                for call in &message.tool_calls {
                    let input = serde_json::from_str::<Value>(&call.arguments)
                        .unwrap_or_else(|_| json!({}));
                    content.push(json!({
                        "type": "tool_use",
                        "id": call.call_id,
                        "name": call.name,
                        "input": input,
                    }));
                }
                messages.push(json!({
                    "role": "assistant",
                    "content": content,
                }));
            }
            ChatRole::Tool => {
                let tool_use_id = message
                    .tool_call_id
                    .clone()
                    .unwrap_or_else(|| "tool".to_owned());
                // Anthropic expects tool results as user content blocks.
                messages.push(json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": message.content,
                    }],
                }));
            }
        }
    }

    if messages.is_empty() {
        return Err(ProviderError::invalid(
            "messages",
            "anthropic request requires at least one non-system message",
        ));
    }

    let mut body = json!({
        "model": request.model.as_str(),
        "messages": messages,
        "max_tokens": request.max_output_tokens.unwrap_or(4096),
        "stream": stream,
    });
    if let Some(system) = system {
        body["system"] = json!(system);
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(request.tools.iter().map(tool_json).collect());
    }
    Ok(body)
}

fn tool_json(tool: &ToolSpec) -> Value {
    json!({
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.parameters,
    })
}
