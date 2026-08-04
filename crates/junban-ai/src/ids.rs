//! Strict provider-neutral identifiers.
//!
//! Identifiers are validated strings with frozen byte ceilings. Model catalogs
//! are never hard-coded here; discovery and configuration supply model IDs.

use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};

use crate::bounds::{MAX_MODEL_ID_BYTES, MAX_PROVIDER_ID_BYTES};
use crate::error::ProviderError;

/// Wire-family kind used by adapters. Presets map onto these families.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// OpenAI Responses API.
    OpenAiResponses,
    /// OpenAI Chat Completions and official compatibility endpoints.
    OpenAiChatCompletions,
    /// Anthropic Messages API.
    AnthropicMessages,
    /// Gemini `generateContent` / `streamGenerateContent`.
    GeminiGenerateContent,
}

impl ProviderKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiResponses => "openai_responses",
            Self::OpenAiChatCompletions => "openai_chat_completions",
            Self::AnthropicMessages => "anthropic_messages",
            Self::GeminiGenerateContent => "gemini_generate_content",
        }
    }
}

impl fmt::Display for ProviderKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Stable provider preset or custom endpoint identifier (max 64 UTF-8 bytes).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProviderId(String);

impl ProviderId {
    pub fn new(value: impl Into<String>) -> Result<Self, ProviderError> {
        let value = value.into();
        validate_token(&value, "provider_id", MAX_PROVIDER_ID_BYTES)?;
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for ProviderId {
    type Err = ProviderError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

/// Provider-reported or operator-selected model identifier (max 256 UTF-8 bytes).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ModelId(String);

impl ModelId {
    pub fn new(value: impl Into<String>) -> Result<Self, ProviderError> {
        let value = value.into();
        validate_token(&value, "model_id", MAX_MODEL_ID_BYTES)?;
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ModelId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for ModelId {
    type Err = ProviderError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

fn validate_token(value: &str, field: &'static str, max_bytes: usize) -> Result<(), ProviderError> {
    if value.is_empty() {
        return Err(ProviderError::invalid(field, "must not be empty"));
    }
    if value.len() > max_bytes {
        return Err(ProviderError::invalid(
            field,
            "exceeds maximum UTF-8 byte length",
        ));
    }
    if value.chars().any(|ch| ch.is_control()) {
        return Err(ProviderError::invalid(
            field,
            "must not contain control characters",
        ));
    }
    if value != value.trim() {
        return Err(ProviderError::invalid(
            field,
            "must not include leading or trailing whitespace",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_oversized_ids() {
        assert!(ProviderId::new("").is_err());
        assert!(ProviderId::new("a".repeat(65)).is_err());
        assert!(ProviderId::new("openai").is_ok());
        assert!(ModelId::new("a".repeat(257)).is_err());
        assert!(ModelId::new("gpt-test").is_ok());
    }
}
