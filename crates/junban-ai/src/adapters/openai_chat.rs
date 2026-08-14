//! OpenAI Chat Completions wire adapter (official compatibility endpoints).

use serde_json::{Value, json};

use crate::error::ProviderError;
use crate::request::{ChatMessage, ChatRole, ProviderChatRequest, ToolCall, ToolSpec};

pub fn build_chat_completions_body(
    request: &ProviderChatRequest,
    stream: bool,
) -> Result<Value, ProviderError> {
    let mut body = json!({
        "model": request.model.as_str(),
        "messages": request.messages.iter().map(message_json).collect::<Vec<_>>(),
        "stream": stream,
    });
    if let Some(max_tokens) = request.max_output_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(request.tools.iter().map(tool_json).collect());
    }
    if stream {
        body["stream_options"] = json!({ "include_usage": true });
    }
    Ok(body)
}

fn message_json(message: &ChatMessage) -> Value {
    let role = match message.role {
        ChatRole::System => "system",
        ChatRole::User => "user",
        ChatRole::Assistant => "assistant",
        ChatRole::Tool => "tool",
    };
    let mut object = json!({
        "role": role,
        "content": message.content,
    });
    if let Some(tool_call_id) = &message.tool_call_id {
        object["tool_call_id"] = json!(tool_call_id);
    }
    if !message.tool_calls.is_empty() {
        object["tool_calls"] =
            Value::Array(message.tool_calls.iter().map(tool_call_json).collect());
    }
    object
}

fn tool_call_json(call: &ToolCall) -> Value {
    json!({
        "id": call.call_id,
        "type": "function",
        "function": {
            "name": call.name,
            "arguments": call.arguments,
        }
    })
}

fn tool_json(tool: &ToolSpec) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        }
    })
}
