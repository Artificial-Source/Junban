//! Family-specific SSE/JSON payload normalization into provider-neutral events.
//!
//! Unknown, malformed, and oversized frames fail closed. Hidden chain-of-thought
//! text is never forwarded — only a safe `reasoning_status` label.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::bounds::{MAX_TEXT_DELTA_BYTES, MAX_TOOL_ARGUMENTS_BYTES};
use crate::error::{ProviderError, redact_sensitive};
use crate::ids::ProviderKind;
use crate::stream::NormalizedStreamEvent;

/// Result of normalizing one SSE `data:` payload or non-stream JSON body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizedProviderFrame {
    /// One or more normalized events extracted from the payload.
    Events(Vec<NormalizedStreamEvent>),
    /// Payload carried no user-visible content (e.g. role-only delta).
    Ignored,
}

/// Stateful accumulator for wire families that stream tool arguments in pieces.
#[derive(Debug)]
pub struct FrameNormalizer {
    kind: ProviderKind,
    /// OpenAI chat-completions tool call fragments keyed by index.
    chat_tool_calls: BTreeMap<u32, PendingToolCall>,
    /// Anthropic tool_use blocks keyed by content index.
    anthropic_tools: BTreeMap<u32, PendingToolCall>,
    /// OpenAI Responses function-call fragments keyed by output_index.
    responses_tools: BTreeMap<u32, PendingToolCall>,
    emitted_run_started: bool,
}

#[derive(Debug, Default, Clone)]
struct PendingToolCall {
    call_id: String,
    name: String,
    arguments: String,
}

impl FrameNormalizer {
    #[must_use]
    pub fn new(kind: ProviderKind) -> Self {
        Self {
            kind,
            chat_tool_calls: BTreeMap::new(),
            anthropic_tools: BTreeMap::new(),
            responses_tools: BTreeMap::new(),
            emitted_run_started: false,
        }
    }

    /// Normalize one SSE data payload for the configured wire family.
    pub fn push_data(&mut self, data: &str) -> Result<NormalizedProviderFrame, ProviderError> {
        let trimmed = data.trim();
        if trimmed.is_empty() {
            return Ok(NormalizedProviderFrame::Ignored);
        }
        match self.kind {
            ProviderKind::OpenAiChatCompletions => self.normalize_chat_data(trimmed),
            ProviderKind::OpenAiResponses => self.normalize_responses_data(trimmed),
            ProviderKind::AnthropicMessages => self.normalize_anthropic_data(trimmed),
            ProviderKind::GeminiGenerateContent => self.normalize_gemini_data(trimmed),
        }
    }

    /// Normalize one complete non-streaming JSON response body.
    pub fn push_json_body(&mut self, body: &str) -> Result<NormalizedProviderFrame, ProviderError> {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return Err(ProviderError::stream("empty provider response body"));
        }
        let value: Value = serde_json::from_str(trimmed)
            .map_err(|_| ProviderError::stream("provider response body is not valid JSON"))?;
        match self.kind {
            ProviderKind::OpenAiChatCompletions => self.normalize_chat_completion_json(&value),
            ProviderKind::OpenAiResponses => self.normalize_responses_json(&value),
            ProviderKind::AnthropicMessages => self.normalize_anthropic_json(&value),
            ProviderKind::GeminiGenerateContent => self.normalize_gemini_json(&value),
        }
    }

    fn ensure_run_started(&mut self, events: &mut Vec<NormalizedStreamEvent>) {
        if !self.emitted_run_started {
            events.push(NormalizedStreamEvent::RunStarted);
            self.emitted_run_started = true;
        }
    }

    fn normalize_chat_data(
        &mut self,
        data: &str,
    ) -> Result<NormalizedProviderFrame, ProviderError> {
        if data == "[DONE]" {
            let mut events = Vec::new();
            self.flush_chat_tools(&mut events)?;
            events.push(NormalizedStreamEvent::Completed);
            return Ok(NormalizedProviderFrame::Events(events));
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|_| ProviderError::stream("provider SSE data is not valid JSON or [DONE]"))?;
        self.normalize_chat_chunk(&value)
    }

    fn normalize_chat_chunk(
        &mut self,
        value: &Value,
    ) -> Result<NormalizedProviderFrame, ProviderError> {
        let object = match value.as_object() {
            Some(object) => object,
            None => {
                return Err(ProviderError::stream(
                    "unknown provider SSE JSON frame shape",
                ));
            }
        };

        if object.get("error").is_some() {
            // Never embed arbitrary vendor body text in public errors.
            return Err(ProviderError::stream_failed());
        }

        let Some(choices) = object.get("choices").and_then(Value::as_array) else {
            return Err(ProviderError::stream(
                "unknown provider SSE JSON frame shape",
            ));
        };

        let mut events = Vec::new();
        if !choices.is_empty() {
            self.ensure_run_started(&mut events);
        }

        for choice in choices {
            let delta = choice.get("delta").unwrap_or(&Value::Null);
            if let Some(content) = delta.get("content").and_then(Value::as_str)
                && !content.is_empty()
            {
                events.push(text_delta(content)?);
            }
            // reasoning_content is intentionally not forwarded as hidden CoT.
            if delta.get("reasoning_content").is_some() || delta.get("reasoning").is_some() {
                events.push(NormalizedStreamEvent::ReasoningStatus {
                    label: "reasoning".to_owned(),
                });
            }
            if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    self.accumulate_chat_tool_delta(call)?;
                }
            }
            if let Some(finish) = choice.get("finish_reason").and_then(Value::as_str)
                && matches!(finish, "tool_calls" | "stop" | "length")
            {
                self.flush_chat_tools(&mut events)?;
            }
        }

        if let Some(usage) = object.get("usage") {
            events.push(usage_from_openai(usage));
        }

        if events.is_empty() {
            Ok(NormalizedProviderFrame::Ignored)
        } else {
            Ok(NormalizedProviderFrame::Events(events))
        }
    }

    fn normalize_chat_completion_json(
        &mut self,
        value: &Value,
    ) -> Result<NormalizedProviderFrame, ProviderError> {
        let object = value
            .as_object()
            .ok_or_else(|| ProviderError::stream("chat completion body must be a JSON object"))?;
        if object.get("error").is_some() {
            return Err(ProviderError::stream_failed());
        }
        let choices = object
            .get("choices")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::stream("chat completion body missing choices"))?;

        let mut events = Vec::new();
        self.ensure_run_started(&mut events);
        for choice in choices {
            let message = choice.get("message").unwrap_or(&Value::Null);
            if let Some(content) = message.get("content").and_then(Value::as_str)
                && !content.is_empty()
            {
                events.push(text_delta(content)?);
            }
            if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    let call_id = call
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    let name = call
                        .get("function")
                        .and_then(|function| function.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    let arguments = call
                        .get("function")
                        .and_then(|function| function.get("arguments"))
                        .and_then(Value::as_str)
                        .unwrap_or("{}")
                        .to_owned();
                    events.push(tool_proposed(call_id, name, arguments)?);
                }
            }
        }
        if let Some(usage) = object.get("usage") {
            events.push(usage_from_openai(usage));
        }
        events.push(NormalizedStreamEvent::Completed);
        Ok(NormalizedProviderFrame::Events(events))
    }

    fn accumulate_chat_tool_delta(&mut self, call: &Value) -> Result<(), ProviderError> {
        let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
        let entry = self.chat_tool_calls.entry(index).or_default();
        if let Some(id) = call.get("id").and_then(Value::as_str)
            && !id.is_empty()
        {
            entry.call_id = id.to_owned();
        }
        if let Some(function) = call.get("function") {
            if let Some(name) = function.get("name").and_then(Value::as_str)
                && !name.is_empty()
            {
                entry.name = name.to_owned();
            }
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                entry.arguments.push_str(arguments);
                if entry.arguments.len() > MAX_TOOL_ARGUMENTS_BYTES {
                    return Err(ProviderError::bound("tool_arguments_bytes"));
                }
            }
        }
        Ok(())
    }

    fn flush_chat_tools(
        &mut self,
        events: &mut Vec<NormalizedStreamEvent>,
    ) -> Result<(), ProviderError> {
        let pending = std::mem::take(&mut self.chat_tool_calls);
        for (_, call) in pending {
            if call.name.is_empty() {
                continue;
            }
            let call_id = if call.call_id.is_empty() {
                format!("call_{}", events.len())
            } else {
                call.call_id
            };
            let arguments = if call.arguments.is_empty() {
                "{}".to_owned()
            } else {
                call.arguments
            };
            events.push(tool_proposed(call_id, call.name, arguments)?);
        }
        Ok(())
    }

    fn normalize_responses_data(
        &mut self,
        data: &str,
    ) -> Result<NormalizedProviderFrame, ProviderError> {
        if data == "[DONE]" {
            return Ok(NormalizedProviderFrame::Events(vec![
                NormalizedStreamEvent::Completed,
            ]));
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|_| ProviderError::stream("provider SSE data is not valid JSON or [DONE]"))?;
        self.normalize_responses_event(&value)
    }

    fn normalize_responses_event(
        &mut self,
        value: &Value,
    ) -> Result<NormalizedProviderFrame, ProviderError> {
        let object = match value.as_object() {
            Some(object) => object,
            None => {
                return Err(ProviderError::stream(
                    "unknown provider SSE JSON frame shape",
                ));
            }
        };
        let Some(frame_type) = object.get("type").and_then(Value::as_str) else {
            return Err(ProviderError::stream(
                "unknown provider SSE JSON frame shape",
            ));
        };

        let mut events = Vec::new();
        match frame_type {
            "response.created" | "response.in_progress" => {
                self.ensure_run_started(&mut events);
            }
            "response.output_text.delta" => {
                self.ensure_run_started(&mut events);
                let text = object.get("delta").and_then(Value::as_str).unwrap_or("");
                if !text.is_empty() {
                    events.push(text_delta(text)?);
                }
            }
            "response.reasoning_summary_text.delta"
            | "response.reasoning.delta"
            | "response.reasoning_summary_part.added" => {
                self.ensure_run_started(&mut events);
                events.push(NormalizedStreamEvent::ReasoningStatus {
                    label: "reasoning".to_owned(),
                });
            }
            "response.output_item.added" => {
                self.ensure_run_started(&mut events);
                if let Some(item) = object.get("item")
                    && item.get("type").and_then(Value::as_str) == Some("function_call")
                {
                    let output_index = object
                        .get("output_index")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as u32;
                    let entry = self.responses_tools.entry(output_index).or_default();
                    entry.call_id = item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    entry.name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                        entry.arguments = arguments.to_owned();
                    }
                }
            }
            "response.function_call_arguments.delta" => {
                self.ensure_run_started(&mut events);
                let output_index = object
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as u32;
                let entry = self.responses_tools.entry(output_index).or_default();
                if let Some(delta) = object.get("delta").and_then(Value::as_str) {
                    entry.arguments.push_str(delta);
                    if entry.arguments.len() > MAX_TOOL_ARGUMENTS_BYTES {
                        return Err(ProviderError::bound("tool_arguments_bytes"));
                    }
                }
            }
            "response.function_call_arguments.done" | "response.output_item.done" => {
                self.ensure_run_started(&mut events);
                let output_index = object
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as u32;
                if let Some(mut call) = self.responses_tools.remove(&output_index) {
                    if let Some(item) = object.get("item") {
                        if call.name.is_empty() {
                            call.name = item
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned();
                        }
                        if call.call_id.is_empty() {
                            call.call_id = item
                                .get("call_id")
                                .or_else(|| item.get("id"))
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned();
                        }
                        if call.arguments.is_empty()
                            && let Some(arguments) = item.get("arguments").and_then(Value::as_str)
                        {
                            call.arguments = arguments.to_owned();
                        }
                    }
                    if let Some(arguments) = object.get("arguments").and_then(Value::as_str)
                        && call.arguments.is_empty()
                    {
                        call.arguments = arguments.to_owned();
                    }
                    if !call.name.is_empty() {
                        let arguments = if call.arguments.is_empty() {
                            "{}".to_owned()
                        } else {
                            call.arguments
                        };
                        events.push(tool_proposed(call.call_id, call.name, arguments)?);
                    }
                }
            }
            "response.completed" => {
                self.ensure_run_started(&mut events);
                if let Some(response) = object.get("response")
                    && let Some(usage) = response.get("usage")
                {
                    events.push(usage_from_responses(usage));
                } else if let Some(usage) = object.get("usage") {
                    events.push(usage_from_responses(usage));
                }
                events.push(NormalizedStreamEvent::Completed);
            }
            "response.failed" | "error" => {
                return Err(ProviderError::stream_failed());
            }
            // Reviewed no-op lifecycle events.
            "response.output_text.done"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.reasoning_summary_text.done"
            | "response.reasoning_summary_part.done" => {}
            other => {
                return Err(ProviderError::stream(format!(
                    "unknown provider SSE frame type `{other}`"
                )));
            }
        }

        if events.is_empty() {
            Ok(NormalizedProviderFrame::Ignored)
        } else {
            Ok(NormalizedProviderFrame::Events(events))
        }
    }

    fn normalize_responses_json(
        &mut self,
        value: &Value,
    ) -> Result<NormalizedProviderFrame, ProviderError> {
        let object = value
            .as_object()
            .ok_or_else(|| ProviderError::stream("responses body must be a JSON object"))?;
        if object.get("type").and_then(Value::as_str) == Some("error")
            || object.get("error").is_some()
        {
            return Err(ProviderError::stream_failed());
        }
        let mut events = Vec::new();
        self.ensure_run_started(&mut events);
        if let Some(output) = object.get("output").and_then(Value::as_array) {
            for item in output {
                match item.get("type").and_then(Value::as_str) {
                    Some("message") => {
                        if let Some(content) = item.get("content").and_then(Value::as_array) {
                            for part in content {
                                if part.get("type").and_then(Value::as_str) == Some("output_text")
                                    && let Some(text) = part.get("text").and_then(Value::as_str)
                                    && !text.is_empty()
                                {
                                    events.push(text_delta(text)?);
                                }
                            }
                        }
                    }
                    Some("function_call") => {
                        let call_id = item
                            .get("call_id")
                            .or_else(|| item.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        let name = item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        let arguments = item
                            .get("arguments")
                            .and_then(Value::as_str)
                            .unwrap_or("{}")
                            .to_owned();
                        events.push(tool_proposed(call_id, name, arguments)?);
                    }
                    Some("reasoning") => {
                        events.push(NormalizedStreamEvent::ReasoningStatus {
                            label: "reasoning".to_owned(),
                        });
                    }
                    _ => {}
                }
            }
        }
        if let Some(usage) = object.get("usage") {
            events.push(usage_from_responses(usage));
        }
        events.push(NormalizedStreamEvent::Completed);
        Ok(NormalizedProviderFrame::Events(events))
    }

    fn normalize_anthropic_data(
        &mut self,
        data: &str,
    ) -> Result<NormalizedProviderFrame, ProviderError> {
        let value: Value = serde_json::from_str(data)
            .map_err(|_| ProviderError::stream("provider SSE data is not valid JSON"))?;
        let object = value
            .as_object()
            .ok_or_else(|| ProviderError::stream("anthropic SSE frame must be a JSON object"))?;
        let frame_type = object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| ProviderError::stream("anthropic SSE frame missing type"))?;

        let mut events = Vec::new();
        match frame_type {
            "message_start" => {
                self.ensure_run_started(&mut events);
                if let Some(message) = object.get("message")
                    && let Some(usage) = message.get("usage")
                {
                    events.push(usage_from_anthropic(usage, None));
                }
            }
            "content_block_start" => {
                self.ensure_run_started(&mut events);
                let index = object.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
                if let Some(block) = object.get("content_block") {
                    match block.get("type").and_then(Value::as_str) {
                        Some("tool_use") => {
                            let entry = self.anthropic_tools.entry(index).or_default();
                            entry.call_id = block
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned();
                            entry.name = block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned();
                        }
                        Some("thinking") => {
                            events.push(NormalizedStreamEvent::ReasoningStatus {
                                label: "reasoning".to_owned(),
                            });
                        }
                        Some("text") | Some("fallback") => {}
                        Some(other) => {
                            return Err(ProviderError::stream(format!(
                                "unknown anthropic content block type `{other}`"
                            )));
                        }
                        None => {
                            return Err(ProviderError::stream(
                                "anthropic content block missing type",
                            ));
                        }
                    }
                }
            }
            "content_block_delta" => {
                self.ensure_run_started(&mut events);
                let index = object.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
                let delta = object.get("delta").unwrap_or(&Value::Null);
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        let text = delta.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            events.push(text_delta(text)?);
                        }
                    }
                    Some("input_json_delta") => {
                        let entry = self.anthropic_tools.entry(index).or_default();
                        if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                            entry.arguments.push_str(partial);
                            if entry.arguments.len() > MAX_TOOL_ARGUMENTS_BYTES {
                                return Err(ProviderError::bound("tool_arguments_bytes"));
                            }
                        }
                    }
                    Some("thinking_delta") | Some("signature_delta") => {
                        // Never forward hidden thinking text.
                        events.push(NormalizedStreamEvent::ReasoningStatus {
                            label: "reasoning".to_owned(),
                        });
                    }
                    Some("citations_delta") => {}
                    Some(other) => {
                        return Err(ProviderError::stream(format!(
                            "unknown anthropic delta type `{other}`"
                        )));
                    }
                    None => {
                        return Err(ProviderError::stream("anthropic delta missing type"));
                    }
                }
            }
            "content_block_stop" => {
                let index = object.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
                if let Some(call) = self.anthropic_tools.remove(&index)
                    && !call.name.is_empty()
                {
                    let arguments = if call.arguments.is_empty() {
                        "{}".to_owned()
                    } else {
                        call.arguments
                    };
                    events.push(tool_proposed(call.call_id, call.name, arguments)?);
                }
            }
            "message_delta" => {
                if let Some(usage) = object.get("usage") {
                    events.push(usage_from_anthropic(usage, object.get("delta")));
                }
            }
            "message_stop" => {
                events.push(NormalizedStreamEvent::Completed);
            }
            "ping" => {}
            "error" => {
                return Err(ProviderError::stream_failed());
            }
            other => {
                // Anthropic versioning may add event types; fail closed on unknown.
                return Err(ProviderError::stream(format!(
                    "unknown anthropic SSE frame type `{other}`"
                )));
            }
        }

        if events.is_empty() {
            Ok(NormalizedProviderFrame::Ignored)
        } else {
            Ok(NormalizedProviderFrame::Events(events))
        }
    }

    fn normalize_anthropic_json(
        &mut self,
        value: &Value,
    ) -> Result<NormalizedProviderFrame, ProviderError> {
        let object = value
            .as_object()
            .ok_or_else(|| ProviderError::stream("anthropic body must be a JSON object"))?;
        if object.get("type").and_then(Value::as_str) == Some("error")
            || object.get("error").is_some()
        {
            return Err(ProviderError::stream_failed());
        }
        let mut events = Vec::new();
        self.ensure_run_started(&mut events);
        if let Some(content) = object.get("content").and_then(Value::as_array) {
            for block in content {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str)
                            && !text.is_empty()
                        {
                            events.push(text_delta(text)?);
                        }
                    }
                    Some("tool_use") => {
                        let call_id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        let arguments = block
                            .get("input")
                            .map(|input| input.to_string())
                            .unwrap_or_else(|| "{}".to_owned());
                        events.push(tool_proposed(call_id, name, arguments)?);
                    }
                    Some("thinking") => {
                        events.push(NormalizedStreamEvent::ReasoningStatus {
                            label: "reasoning".to_owned(),
                        });
                    }
                    _ => {}
                }
            }
        }
        if let Some(usage) = object.get("usage") {
            events.push(usage_from_anthropic(usage, None));
        }
        events.push(NormalizedStreamEvent::Completed);
        Ok(NormalizedProviderFrame::Events(events))
    }

    fn normalize_gemini_data(
        &mut self,
        data: &str,
    ) -> Result<NormalizedProviderFrame, ProviderError> {
        let value: Value = serde_json::from_str(data)
            .map_err(|_| ProviderError::stream("provider SSE data is not valid JSON"))?;
        self.normalize_gemini_value(&value, false)
    }

    fn normalize_gemini_json(
        &mut self,
        value: &Value,
    ) -> Result<NormalizedProviderFrame, ProviderError> {
        self.normalize_gemini_value(value, true)
    }

    fn normalize_gemini_value(
        &mut self,
        value: &Value,
        terminal: bool,
    ) -> Result<NormalizedProviderFrame, ProviderError> {
        let object = value
            .as_object()
            .ok_or_else(|| ProviderError::stream("gemini body must be a JSON object"))?;
        if object.get("error").is_some() {
            // Never embed arbitrary vendor body text in public errors.
            return Err(ProviderError::stream_failed());
        }

        let mut events = Vec::new();
        let candidates = object
            .get("candidates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !candidates.is_empty() {
            self.ensure_run_started(&mut events);
        }
        for candidate in &candidates {
            let parts = candidate
                .get("content")
                .and_then(|content| content.get("parts"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for part in parts {
                if let Some(text) = part.get("text").and_then(Value::as_str)
                    && !text.is_empty()
                {
                    // Gemini may put thought text in parts with thought=true.
                    if part.get("thought").and_then(Value::as_bool) == Some(true) {
                        events.push(NormalizedStreamEvent::ReasoningStatus {
                            label: "reasoning".to_owned(),
                        });
                    } else {
                        events.push(text_delta(text)?);
                    }
                }
                if let Some(function_call) = part.get("functionCall") {
                    let name = function_call
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    let arguments = function_call
                        .get("args")
                        .map(|args| args.to_string())
                        .unwrap_or_else(|| "{}".to_owned());
                    let call_id = function_call
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    events.push(tool_proposed(call_id, name, arguments)?);
                }
            }
            if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str)
                && matches!(reason, "STOP" | "MAX_TOKENS" | "FINISH_REASON_STOP")
            {
                // Terminal marker may arrive on the last chunk.
            }
        }
        if let Some(usage) = object
            .get("usageMetadata")
            .or_else(|| object.get("usage_metadata"))
        {
            events.push(NormalizedStreamEvent::Usage {
                input_tokens: usage
                    .get("promptTokenCount")
                    .or_else(|| usage.get("prompt_token_count"))
                    .and_then(Value::as_u64),
                output_tokens: usage
                    .get("candidatesTokenCount")
                    .or_else(|| usage.get("candidates_token_count"))
                    .and_then(Value::as_u64),
            });
        }
        if terminal {
            if !self.emitted_run_started {
                self.ensure_run_started(&mut events);
            }
            events.push(NormalizedStreamEvent::Completed);
        }
        if events.is_empty() {
            Ok(NormalizedProviderFrame::Ignored)
        } else {
            Ok(NormalizedProviderFrame::Events(events))
        }
    }
}

/// Normalize one OpenAI-compatible SSE data payload (stateless convenience).
pub fn normalize_openai_compatible_data(
    data: &str,
) -> Result<NormalizedProviderFrame, ProviderError> {
    let mut normalizer = FrameNormalizer::new(ProviderKind::OpenAiChatCompletions);
    normalizer.push_data(data)
}

fn text_delta(text: &str) -> Result<NormalizedStreamEvent, ProviderError> {
    if text.len() > MAX_TEXT_DELTA_BYTES {
        return Err(ProviderError::bound("provider_stream_frame_bytes"));
    }
    Ok(NormalizedStreamEvent::TextDelta {
        text: text.to_owned(),
    })
}

fn tool_proposed(
    call_id: String,
    name: String,
    arguments: String,
) -> Result<NormalizedStreamEvent, ProviderError> {
    if name.is_empty() {
        return Err(ProviderError::stream("tool proposal missing name"));
    }
    if arguments.len() > MAX_TOOL_ARGUMENTS_BYTES {
        return Err(ProviderError::bound("tool_arguments_bytes"));
    }
    let call_id = if call_id.is_empty() {
        format!("call_{name}")
    } else {
        call_id
    };
    Ok(NormalizedStreamEvent::ToolProposed {
        call_id,
        name,
        arguments,
    })
}

fn usage_from_openai(usage: &Value) -> NormalizedStreamEvent {
    NormalizedStreamEvent::Usage {
        input_tokens: usage.get("prompt_tokens").and_then(Value::as_u64),
        output_tokens: usage.get("completion_tokens").and_then(Value::as_u64),
    }
}

fn usage_from_responses(usage: &Value) -> NormalizedStreamEvent {
    NormalizedStreamEvent::Usage {
        input_tokens: usage
            .get("input_tokens")
            .or_else(|| usage.get("prompt_tokens"))
            .and_then(Value::as_u64),
        output_tokens: usage
            .get("output_tokens")
            .or_else(|| usage.get("completion_tokens"))
            .and_then(Value::as_u64),
    }
}

fn usage_from_anthropic(usage: &Value, _delta: Option<&Value>) -> NormalizedStreamEvent {
    NormalizedStreamEvent::Usage {
        input_tokens: usage.get("input_tokens").and_then(Value::as_u64),
        output_tokens: usage.get("output_tokens").and_then(Value::as_u64),
    }
}

/// Redact and bound a vendor error body before mapping into [`ProviderError`].
#[must_use]
pub fn bound_redact_error_body(body: &str) -> String {
    use crate::bounds::MAX_PROVIDER_ERROR_BODY_BYTES;
    let limited = if body.len() > MAX_PROVIDER_ERROR_BODY_BYTES {
        &body[..MAX_PROVIDER_ERROR_BODY_BYTES]
    } else {
        body
    };
    redact_sensitive(limited)
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
            NormalizedProviderFrame::Events(vec![
                NormalizedStreamEvent::RunStarted,
                NormalizedStreamEvent::TextDelta { text: "Hi".into() }
            ])
        );

        assert_eq!(
            normalize_openai_compatible_data("[DONE]").unwrap(),
            NormalizedProviderFrame::Events(vec![NormalizedStreamEvent::Completed])
        );

        let err = normalize_openai_compatible_data(r#"{"foo":1}"#).unwrap_err();
        assert!(matches!(err, ProviderError::Stream { .. }));
    }

    #[test]
    fn anthropic_thinking_is_status_only() {
        let mut normalizer = FrameNormalizer::new(ProviderKind::AnthropicMessages);
        let frame = normalizer
            .push_data(
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret chain"}}"#,
            )
            .unwrap();
        match frame {
            NormalizedProviderFrame::Events(events) => {
                assert!(events.iter().any(|event| matches!(
                    event,
                    NormalizedStreamEvent::ReasoningStatus { label } if label == "reasoning"
                )));
                let rendered = format!("{events:?}");
                assert!(!rendered.contains("secret chain"));
            }
            NormalizedProviderFrame::Ignored => panic!("expected events"),
        }
    }
}
