//! Typed built-in provider registry.
//!
//! Preset identity is owned by [`junban_domain::AiProviderPreset`]. This module
//! attaches runtime descriptors (wire family, auth, paths, capabilities) and
//! performs no network I/O on construction.

use std::sync::OnceLock;

use junban_domain::AiProviderPreset;

use crate::auth::AuthScheme;
use crate::capabilities::{ProviderCapabilities, ProviderCapability};
use crate::error::ProviderError;
use crate::ids::{ProviderId, ProviderKind};
use crate::url_policy::OriginClass;

/// Runtime alias for the single domain provider-preset authority.
pub type ProviderPreset = AiProviderPreset;

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
        ProviderId::new(self.preset.as_str()).expect("built-in provider id is valid")
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
    // Order follows AiProviderPreset::ALL. Lookup never indexes by discriminant.
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
            preset: ProviderPreset::DeepSeek,
            kind: ProviderKind::OpenAiChatCompletions,
            auth: AuthScheme::Bearer,
            origin_class: OriginClass::FixedCloudHttps,
            default_base_url: "https://api.deepseek.com",
            chat_path: "chat/completions",
            models_path: Some("models"),
            capabilities: caps(CLOUD_CHAT),
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
///
/// Lookup matches on preset identity rather than enum discriminant indices so
/// domain ordering and runtime registry ordering stay independently maintainable.
#[must_use]
pub fn descriptor(preset: ProviderPreset) -> &'static ProviderDescriptor {
    registry()
        .iter()
        .find(|entry| entry.preset == preset)
        .unwrap_or_else(|| {
            panic!(
                "missing runtime descriptor for domain preset {}",
                preset.as_str()
            )
        })
}

/// Look up a built-in descriptor by provider id string (canonical or safe alias).
pub fn descriptor_by_id(id: &str) -> Result<&'static ProviderDescriptor, ProviderError> {
    let preset = ProviderPreset::parse(id)
        .map_err(|_| ProviderError::invalid("provider_id", "unknown built-in provider preset"))?;
    Ok(descriptor(preset))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_contains_exact_builtins_without_network() {
        let all = builtin_providers();
        assert_eq!(all.len(), ProviderPreset::ALL.len());
        assert_eq!(all[0].preset, ProviderPreset::OpenAi);
        assert_eq!(all[0].kind, ProviderKind::OpenAiResponses);
        assert_eq!(
            descriptor(ProviderPreset::Anthropic).kind,
            ProviderKind::AnthropicMessages
        );
        assert_eq!(
            descriptor(ProviderPreset::Gemini).kind,
            ProviderKind::GeminiGenerateContent
        );
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
        assert_eq!(
            descriptor(ProviderPreset::DeepSeek).default_base_url,
            "https://api.deepseek.com"
        );
        assert_eq!(
            descriptor(ProviderPreset::LmStudio).id().as_str(),
            "lm_studio"
        );
        assert_eq!(descriptor(ProviderPreset::ZAi).id().as_str(), "z_ai");
        assert!(descriptor_by_id("xai").is_err());
        assert!(descriptor_by_id("deepseek").is_ok());
    }
}
