//! OpenAI Responses API wire adapter.

use serde_json::{Value, json};

use crate::error::ProviderError;
use crate::request::{ChatRole, ProviderChatRequest, ToolSpec};

pub fn build_responses_body(
    request: &ProviderChatRequest,
    stream: bool,
) -> Result<Value, ProviderError> {
    let mut input = Vec::new();
    let mut instructions = None;
    for message in &request.messages {
        match message.role {
            ChatRole::System => {
                // Responses API prefers top-level instructions for system text.
                instructions = Some(message.content.clone());
            }
            ChatRole::User => {
                input.push(json!({
                    "role": "user",
                    "content": [{ "type": "input_text", "text": message.content }],
                }));
            }
            ChatRole::Assistant => {
                if !message.content.is_empty() {
                    input.push(json!({
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": message.content }],
                    }));
                }
                for call in &message.tool_calls {
                    input.push(json!({
                        "type": "function_call",
                        "call_id": call.call_id,
                        "name": call.name,
                        "arguments": call.arguments,
                    }));
                }
            }
            ChatRole::Tool => {
                let call_id = message
                    .tool_call_id
                    .clone()
                    .unwrap_or_else(|| "call".to_owned());
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": message.content,
                }));
            }
        }
    }

    let mut body = json!({
        "model": request.model.as_str(),
        "input": input,
        "stream": stream,
    });
    if let Some(instructions) = instructions {
        body["instructions"] = json!(instructions);
    }
    if let Some(max_tokens) = request.max_output_tokens {
        body["max_output_tokens"] = json!(max_tokens);
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(request.tools.iter().map(tool_json).collect());
    }
    Ok(body)
}

fn tool_json(tool: &ToolSpec) -> Value {
    json!({
        "type": "function",
        "name": tool.name,
        "description": tool.description,
        "parameters": tool.parameters,
    })
}
