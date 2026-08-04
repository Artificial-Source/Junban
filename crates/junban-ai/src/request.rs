//! Provider-neutral chat request types used by wire adapters.

use crate::bounds::MAX_TOOL_ARGUMENTS_BYTES;
use crate::error::ProviderError;
use crate::ids::ModelId;
use crate::registry::ProviderDescriptor;
use crate::secret::SecretString;
use crate::url_policy::{OriginClass, validate_base_url};

/// One chat message role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRole {
    System,
    User,
    Assistant,
    Tool,
}

/// One tool call attached to an assistant message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub arguments: String,
}

/// One provider-neutral chat message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
    pub tool_call_id: Option<String>,
    pub tool_calls: Vec<ToolCall>,
}

impl ChatMessage {
    #[must_use]
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::System,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    #[must_use]
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::User,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    #[must_use]
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Assistant,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    #[must_use]
    pub fn tool_result(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Tool,
            content: content.into(),
            tool_call_id: Some(call_id.into()),
            tool_calls: Vec::new(),
        }
    }
}

/// One advertised tool schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema object for parameters.
    pub parameters: serde_json::Value,
}

/// Resolved provider endpoint configuration for one call.
#[derive(Debug, Clone)]
pub struct ProviderEndpoint {
    pub descriptor: &'static ProviderDescriptor,
    pub base_url: String,
    pub credential: Option<SecretString>,
}

impl ProviderEndpoint {
    /// Resolve a built-in preset with optional operator base-URL override.
    pub fn resolve(
        descriptor: &'static ProviderDescriptor,
        base_url_override: Option<&str>,
        credential: Option<SecretString>,
    ) -> Result<Self, ProviderError> {
        let base_url = match descriptor.origin_class {
            OriginClass::FixedCloudHttps => {
                if let Some(raw) = base_url_override.filter(|value| !value.is_empty()) {
                    let normalized = validate_base_url(raw, OriginClass::FixedCloudHttps)?;
                    let default = validate_base_url(
                        descriptor.default_base_url,
                        OriginClass::FixedCloudHttps,
                    )?;
                    if normalized != default {
                        return Err(ProviderError::invalid(
                            "base_url",
                            "cloud provider base URL is fixed and cannot be overridden",
                        ));
                    }
                    normalized
                } else {
                    validate_base_url(descriptor.default_base_url, OriginClass::FixedCloudHttps)?
                }
            }
            OriginClass::Loopback => {
                if let Some(raw) = base_url_override.filter(|value| !value.is_empty()) {
                    validate_base_url(raw, OriginClass::Loopback)?
                } else {
                    validate_base_url(descriptor.default_base_url, OriginClass::Loopback)?
                }
            }
            OriginClass::OperatorCustom => {
                let raw = base_url_override
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        ProviderError::invalid(
                            "base_url",
                            "custom provider requires an operator base URL",
                        )
                    })?;
                validate_base_url(raw, OriginClass::OperatorCustom)?
            }
        };

        if descriptor.auth.requires_credential()
            && credential.as_ref().is_none_or(SecretString::is_empty)
        {
            return Err(ProviderError::invalid(
                "credential",
                "provider requires a credential",
            ));
        }
        if !descriptor.auth.requires_credential() && credential.is_some() {
            return Err(ProviderError::invalid(
                "credential",
                "credential-free provider rejects credential material",
            ));
        }

        Ok(Self {
            descriptor,
            base_url,
            credential,
        })
    }
}

/// Provider-neutral chat request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderChatRequest {
    pub model: ModelId,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSpec>,
    pub max_output_tokens: Option<u32>,
}

impl ProviderChatRequest {
    /// Whether this request should force a non-streaming round for the descriptor.
    #[must_use]
    pub fn force_non_stream(&self, descriptor: &ProviderDescriptor) -> bool {
        !self.tools.is_empty() && descriptor.must_disable_stream_with_tools()
    }

    pub fn validate_bounds(&self) -> Result<(), ProviderError> {
        for tool in &self.tools {
            if tool.name.is_empty() {
                return Err(ProviderError::invalid("tool_name", "must not be empty"));
            }
        }
        for message in &self.messages {
            for call in &message.tool_calls {
                if call.arguments.len() > MAX_TOOL_ARGUMENTS_BYTES {
                    return Err(ProviderError::bound("tool_arguments_bytes"));
                }
            }
        }
        Ok(())
    }
}
