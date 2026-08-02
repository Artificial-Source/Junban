//! Typed built-in provider registry.
//!
//! Each preset freezes origin, auth scheme, wire family, model-discovery path,
//! and provider-level capabilities. Construction performs no network I/O.

use std::sync::OnceLock;

use crate::auth::AuthScheme;
use crate::capabilities::{ProviderCapabilities, ProviderCapability};
use crate::error::ProviderError;
use crate::ids::{ProviderId, ProviderKind};
use crate::url_policy::OriginClass;

/// Stable built-in provider preset identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProviderPreset {
    OpenAi = 0,
    Anthropic = 1,
    Gemini = 2,
    Groq = 3,
    XAi = 4,
    Mistral = 5,
    OpenRouter = 6,
    Kimi = 7,
    ZAi = 8,
    DashScope = 9,
    Ollama = 10,
    LmStudio = 11,
    Custom = 12,
}

impl ProviderPreset {
    /// All built-in presets in stable display order.
    pub const ALL: [Self; 13] = [
        Self::OpenAi,
        Self::Anthropic,
        Self::Gemini,
        Self::Groq,
        Self::XAi,
        Self::Mistral,
        Self::OpenRouter,
        Self::Kimi,
        Self::ZAi,
        Self::DashScope,
        Self::Ollama,
        Self::LmStudio,
        Self::Custom,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::Groq => "groq",
            Self::XAi => "xai",
            Self::Mistral => "mistral",
            Self::OpenRouter => "openrouter",
            Self::Kimi => "kimi",
            Self::ZAi => "zai",
            Self::DashScope => "dashscope",
            Self::Ollama => "ollama",
            Self::LmStudio => "lmstudio",
            Self::Custom => "custom",
        }
    }

    #[must_use]
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::OpenAi => "OpenAI",
            Self::Anthropic => "Anthropic",
            Self::Gemini => "Gemini",
            Self::Groq => "Groq",
            Self::XAi => "xAI",
            Self::Mistral => "Mistral",
            Self::OpenRouter => "OpenRouter",
            Self::Kimi => "Kimi / Moonshot",
            Self::ZAi => "Z.AI / GLM",
            Self::DashScope => "DashScope",
            Self::Ollama => "Ollama",
            Self::LmStudio => "LM Studio",
            Self::Custom => "Custom",
        }
    }

    pub fn parse(id: &str) -> Result<Self, ProviderError> {
        match id {
            "openai" => Ok(Self::OpenAi),
            "anthropic" => Ok(Self::Anthropic),
            "gemini" => Ok(Self::Gemini),
            "groq" => Ok(Self::Groq),
            "xai" => Ok(Self::XAi),
            "mistral" => Ok(Self::Mistral),
            "openrouter" => Ok(Self::OpenRouter),
            "kimi" | "moonshot" => Ok(Self::Kimi),
            "zai" | "glm" => Ok(Self::ZAi),
            "dashscope" => Ok(Self::DashScope),
            "ollama" => Ok(Self::Ollama),
            "lmstudio" | "lm-studio" => Ok(Self::LmStudio),
            "custom" => Ok(Self::Custom),
            _ => Err(ProviderError::invalid(
                "provider_id",
                "unknown built-in provider preset",
            )),
        }
    }

    #[must_use]
    pub fn provider_id(self) -> ProviderId {
        ProviderId::new(self.as_str()).expect("built-in provider id is valid")
    }
}

/// Static descriptor for one built-in provider preset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderDescriptor {
    pub preset: ProviderPreset,
    pub kind: ProviderKind,
    pub auth: AuthScheme,
    pub origin_class: OriginClass,
    /// Default base URL when the operator does not override (empty for Custom).
    pub default_base_url: &'static str,
    /// Relative path for chat inference, when a fixed path applies.
    pub chat_path: &'static str,
    /// Relative path for model listing, when discovery is supported.
    pub models_path: Option<&'static str>,
    pub capabilities: ProviderCapabilities,
}

impl ProviderDescriptor {
    #[must_use]
    pub fn id(&self) -> ProviderId {
        self.preset.provider_id()
    }

    /// True when streaming must be disabled because tools are advertised.
    #[must_use]
    pub fn must_disable_stream_with_tools(&self) -> bool {
        self.capabilities.contains(ProviderCapability::Tools)
            && !self
                .capabilities
                .contains(ProviderCapability::StreamingTools)
    }
}

fn caps(items: &[ProviderCapability]) -> ProviderCapabilities {
    ProviderCapabilities::new(items.iter().copied())
}

const CLOUD_CHAT: &[ProviderCapability] = &[
    ProviderCapability::ChatStreaming,
    ProviderCapability::ChatCompletion,
    ProviderCapability::Tools,
    ProviderCapability::StreamingTools,
    ProviderCapability::ModelDiscovery,
];

const CLOUD_CHAT_REASONING: &[ProviderCapability] = &[
    ProviderCapability::ChatStreaming,
    ProviderCapability::ChatCompletion,
    ProviderCapability::Tools,
    ProviderCapability::StreamingTools,
    ProviderCapability::ReasoningStatus,
    ProviderCapability::ModelDiscovery,
];

const DASHSCOPE_CAPS: &[ProviderCapability] = &[
    ProviderCapability::ChatStreaming,
    ProviderCapability::ChatCompletion,
    ProviderCapability::Tools,
    // StreamingTools deliberately absent: DashScope documents stream+tools incompatibility.
    ProviderCapability::ModelDiscovery,
];

const LOCAL_OR_CUSTOM: &[ProviderCapability] = &[
    ProviderCapability::ChatStreaming,
    ProviderCapability::ChatCompletion,
    ProviderCapability::Tools,
    ProviderCapability::StreamingTools,
    ProviderCapability::ModelDiscovery,
];

fn build_registry() -> Vec<ProviderDescriptor> {
    vec![
        ProviderDescriptor {
            preset: ProviderPreset::OpenAi,
            kind: ProviderKind::OpenAiResponses,
            auth: AuthScheme::Bearer,
            origin_class: OriginClass::FixedCloudHttps,
            default_base_url: "https://api.openai.com/v1",
            chat_path: "responses",
            models_path: Some("models"),
            capabilities: caps(CLOUD_CHAT_REASONING),
        },
        ProviderDescriptor {
            preset: ProviderPreset::Anthropic,
            kind: ProviderKind::AnthropicMessages,
            auth: AuthScheme::AnthropicApiKey,
            origin_class: OriginClass::FixedCloudHttps,
            default_base_url: "https://api.anthropic.com",
            chat_path: "v1/messages",
            models_path: Some("v1/models"),
            capabilities: caps(CLOUD_CHAT_REASONING),
        },
        ProviderDescriptor {
            preset: ProviderPreset::Gemini,
            kind: ProviderKind::GeminiGenerateContent,
            auth: AuthScheme::GoogleApiKey,
            origin_class: OriginClass::FixedCloudHttps,
            default_base_url: "https://generativelanguage.googleapis.com/v1beta",
            chat_path: "",
            models_path: Some("models"),
            capabilities: caps(CLOUD_CHAT),
        },
        ProviderDescriptor {
            preset: ProviderPreset::Groq,
            kind: ProviderKind::OpenAiChatCompletions,
            auth: AuthScheme::Bearer,
            origin_class: OriginClass::FixedCloudHttps,
            default_base_url: "https://api.groq.com/openai/v1",
            chat_path: "chat/completions",
            models_path: Some("models"),
            capabilities: caps(CLOUD_CHAT),
        },
        ProviderDescriptor {
            preset: ProviderPreset::XAi,
            kind: ProviderKind::OpenAiChatCompletions,
            auth: AuthScheme::Bearer,
            origin_class: OriginClass::FixedCloudHttps,
            default_base_url: "https://api.x.ai/v1",
            chat_path: "chat/completions",
            models_path: Some("models"),
            capabilities: caps(CLOUD_CHAT),
        },
        ProviderDescriptor {
            preset: ProviderPreset::Mistral,
            kind: ProviderKind::OpenAiChatCompletions,
            auth: AuthScheme::Bearer,
            origin_class: OriginClass::FixedCloudHttps,
            default_base_url: "https://api.mistral.ai/v1",
            chat_path: "chat/completions",
            models_path: Some("models"),
            capabilities: caps(CLOUD_CHAT),
        },
        ProviderDescriptor {
            preset: ProviderPreset::OpenRouter,
            kind: ProviderKind::OpenAiChatCompletions,
            auth: AuthScheme::Bearer,
            origin_class: OriginClass::FixedCloudHttps,
            default_base_url: "https://openrouter.ai/api/v1",
            chat_path: "chat/completions",
            models_path: Some("models"),
            capabilities: caps(CLOUD_CHAT),
        },
        ProviderDescriptor {
            preset: ProviderPreset::Kimi,
            kind: ProviderKind::OpenAiChatCompletions,
            auth: AuthScheme::Bearer,
            origin_class: OriginClass::FixedCloudHttps,
            default_base_url: "https://api.moonshot.ai/v1",
            chat_path: "chat/completions",
            models_path: Some("models"),
            capabilities: caps(CLOUD_CHAT),
        },
        ProviderDescriptor {
            preset: ProviderPreset::ZAi,
            kind: ProviderKind::OpenAiChatCompletions,
            auth: AuthScheme::Bearer,
            origin_class: OriginClass::FixedCloudHttps,
            default_base_url: "https://api.z.ai/api/paas/v4",
            chat_path: "chat/completions",
            models_path: Some("models"),
            capabilities: caps(CLOUD_CHAT),
        },
        ProviderDescriptor {
            preset: ProviderPreset::DashScope,
            kind: ProviderKind::OpenAiChatCompletions,
            auth: AuthScheme::Bearer,
            origin_class: OriginClass::FixedCloudHttps,
            default_base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            chat_path: "chat/completions",
            models_path: Some("models"),
            capabilities: caps(DASHSCOPE_CAPS),
        },
        ProviderDescriptor {
            preset: ProviderPreset::Ollama,
            kind: ProviderKind::OpenAiChatCompletions,
            auth: AuthScheme::None,
            origin_class: OriginClass::Loopback,
            default_base_url: "http://127.0.0.1:11434/v1",
            chat_path: "chat/completions",
            models_path: Some("models"),
            capabilities: caps(LOCAL_OR_CUSTOM),
        },
        ProviderDescriptor {
            preset: ProviderPreset::LmStudio,
            kind: ProviderKind::OpenAiChatCompletions,
            auth: AuthScheme::None,
            origin_class: OriginClass::Loopback,
            default_base_url: "http://127.0.0.1:1234/v1",
            chat_path: "chat/completions",
            models_path: Some("models"),
            capabilities: caps(LOCAL_OR_CUSTOM),
        },
        ProviderDescriptor {
            preset: ProviderPreset::Custom,
            kind: ProviderKind::OpenAiChatCompletions,
            auth: AuthScheme::Bearer,
            origin_class: OriginClass::OperatorCustom,
            default_base_url: "",
            chat_path: "chat/completions",
            models_path: Some("models"),
            capabilities: caps(LOCAL_OR_CUSTOM),
        },
    ]
}

fn registry() -> &'static [ProviderDescriptor] {
    static REGISTRY: OnceLock<Vec<ProviderDescriptor>> = OnceLock::new();
    REGISTRY.get_or_init(build_registry).as_slice()
}

/// Return the static registry of built-in providers.
#[must_use]
pub fn builtin_providers() -> &'static [ProviderDescriptor] {
    registry()
}

/// Look up a built-in descriptor by preset.
#[must_use]
pub fn descriptor(preset: ProviderPreset) -> &'static ProviderDescriptor {
    &registry()[preset as usize]
}

/// Look up a built-in descriptor by provider id string.
pub fn descriptor_by_id(id: &str) -> Result<&'static ProviderDescriptor, ProviderError> {
    let preset = ProviderPreset::parse(id)?;
    Ok(descriptor(preset))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_contains_exact_builtins_without_network() {
        let all = builtin_providers();
        assert_eq!(all.len(), 13);
        assert_eq!(all[0].preset, ProviderPreset::OpenAi);
        assert_eq!(all[0].kind, ProviderKind::OpenAiResponses);
        assert_eq!(all[1].kind, ProviderKind::AnthropicMessages);
        assert_eq!(all[2].kind, ProviderKind::GeminiGenerateContent);
        let dash = descriptor(ProviderPreset::DashScope);
        assert!(dash.must_disable_stream_with_tools());
        assert!(
            !dash
                .capabilities
                .contains(ProviderCapability::StreamingTools)
        );
        assert!(
            descriptor(ProviderPreset::OpenAi)
                .capabilities
                .contains(ProviderCapability::StreamingTools)
        );
        assert_eq!(
            ProviderPreset::parse("moonshot").unwrap(),
            ProviderPreset::Kimi
        );
        assert_eq!(ProviderPreset::parse("glm").unwrap(), ProviderPreset::ZAi);
    }
}
