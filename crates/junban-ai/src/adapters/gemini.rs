//! Gemini `generateContent` / `streamGenerateContent?alt=sse` wire adapter.

use serde_json::{Value, json};

use crate::error::ProviderError;
use crate::request::{ChatRole, ProviderChatRequest, ToolSpec};
use crate::url_policy::join_base_path;

pub fn gemini_stream_url(base: &str, model: &str) -> Result<String, ProviderError> {
    let model = normalize_model_path(model);
    // alt=sse is a fixed non-credential query required by the streaming contract.
    let path = format!("{model}:streamGenerateContent");
    let url = join_base_path(base, &path)?;
    Ok(format!("{url}?alt=sse"))
}

pub fn gemini_unary_url(base: &str, model: &str) -> Result<String, ProviderError> {
    let model = normalize_model_path(model);
    let path = format!("{model}:generateContent");
    join_base_path(base, &path)
}

fn normalize_model_path(model: &str) -> String {
    if model.starts_with("models/") {
        model.to_owned()
    } else {
        format!("models/{model}")
    }
}

pub fn build_gemini_body(request: &ProviderChatRequest) -> Result<Value, ProviderError> {
    let mut system_instruction = None;
    let mut contents = Vec::new();
    for message in &request.messages {
        match message.role {
            ChatRole::System => {
                system_instruction = Some(json!({
                    "parts": [{ "text": message.content }],
                }));
            }
            ChatRole::User => {
                contents.push(json!({
                    "role": "user",
                    "parts": [{ "text": message.content }],
                }));
            }
            ChatRole::Assistant => {
                let mut parts = Vec::new();
                if !message.content.is_empty() {
                    parts.push(json!({ "text": message.content }));
                }
                for call in &message.tool_calls {
                    let args = serde_json::from_str::<Value>(&call.arguments)
                        .unwrap_or_else(|_| json!({}));
                    parts.push(json!({
                        "functionCall": {
                            "name": call.name,
                            "args": args,
                        }
                    }));
                }
                contents.push(json!({
                    "role": "model",
                    "parts": parts,
                }));
            }
            ChatRole::Tool => {
                let name = message
                    .tool_call_id
                    .clone()
                    .unwrap_or_else(|| "tool".to_owned());
                let response = serde_json::from_str::<Value>(&message.content)
                    .unwrap_or_else(|_| json!({ "result": message.content }));
                contents.push(json!({
                    "role": "user",
                    "parts": [{
                        "functionResponse": {
                            "name": name,
                            "response": response,
                        }
                    }],
                }));
            }
        }
    }

    if contents.is_empty() {
        return Err(ProviderError::invalid(
            "messages",
            "gemini request requires at least one non-system message",
        ));
    }

    let mut body = json!({
        "contents": contents,
    });
    if let Some(system_instruction) = system_instruction {
        body["systemInstruction"] = system_instruction;
    }
    if let Some(max_tokens) = request.max_output_tokens {
        body["generationConfig"] = json!({ "maxOutputTokens": max_tokens });
    }
    if !request.tools.is_empty() {
        body["tools"] = json!([{
            "functionDeclarations": request.tools.iter().map(tool_json).collect::<Vec<_>>(),
        }]);
    }
    Ok(body)
}

fn tool_json(tool: &ToolSpec) -> Value {
    json!({
        "name": tool.name,
        "description": tool.description,
        "parameters": tool.parameters,
    })
}
