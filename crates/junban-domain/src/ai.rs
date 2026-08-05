//! Typed AI/voice settings, durable chat entities, and private credential metadata.
//!
//! Raw provider/speech secret bytes never appear in these types. Credential bindings
//! store only stable random IDs that reference the private `ai-secrets.json` file.

use std::{fmt, net::IpAddr, str::FromStr};

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ValidationError;

// ── Bounds (frozen Phase 6 Wave 1 contract) ─────────────────────────────────

/// Sessions returned per page.
pub const AI_SESSION_PAGE_MAX: u32 = 100;
/// Messages returned per page.
pub const AI_MESSAGE_PAGE_MAX: u32 = 100;
/// Memories returned per page.
pub const AI_MEMORY_PAGE_MAX: u32 = 100;
/// Explicit/session-linked memories considered for one run context pack.
pub const AI_CONTEXT_MEMORIES_MAX: u32 = 50;
/// Sessions retained per profile.
pub const AI_SESSIONS_PER_PROFILE_MAX: u32 = 500;
/// Messages retained per session.
pub const AI_MESSAGES_PER_SESSION_MAX: u32 = 500;
/// Durable message content bytes per session.
pub const AI_SESSION_CONTENT_BYTES_MAX: u64 = 32 * 1024 * 1024;
/// Total durable AI content bytes per profile.
pub const AI_PROFILE_CONTENT_BYTES_MAX: u64 = 128 * 1024 * 1024;
/// Memories retained per profile.
pub const AI_MEMORIES_PER_PROFILE_MAX: u32 = 500;
/// Total explicit memory content bytes per profile.
pub const AI_MEMORY_CONTENT_BYTES_MAX: u64 = 5 * 1024 * 1024;
/// Pending approvals retained per profile.
pub const AI_PENDING_APPROVALS_MAX: u32 = 128;
/// Dispatching approval/run pairs offered for bounded startup recovery.
pub const AI_DISPATCHING_APPROVAL_RECOVERY_MAX: u32 = 500;
/// Domain separator for approval action hashes.
pub const AI_APPROVAL_ACTION_HASH_DOMAIN: &[u8] = b"junban.ai.approval.action.v1\0";
/// Total pending approval content bytes per profile.
pub const AI_PENDING_APPROVAL_CONTENT_BYTES_MAX: u64 = 1024 * 1024;
/// Session title UTF-8 byte ceiling.
pub const AI_SESSION_TITLE_BYTES_MAX: usize = 200;
/// User message input UTF-8 byte ceiling.
pub const AI_USER_INPUT_BYTES_MAX: usize = 32 * 1024;
/// Custom instruction UTF-8 byte ceiling.
pub const AI_CUSTOM_INSTRUCTIONS_BYTES_MAX: usize = 16 * 1024;
/// Assistant text per completed turn.
pub const AI_ASSISTANT_TEXT_BYTES_MAX: usize = 512 * 1024;
/// Canonical tool arguments UTF-8 byte ceiling.
pub const AI_TOOL_ARGUMENTS_BYTES_MAX: usize = 128 * 1024;
/// One tool result UTF-8 byte ceiling.
pub const AI_TOOL_RESULT_BYTES_MAX: usize = 256 * 1024;
/// Canonical durable local tool-event transcript ceiling per assistant message.
pub const AI_TOOL_EVENT_TRANSCRIPT_BYTES_MAX: usize = 2 * 1024 * 1024;
/// Maximum canonical serialized bytes for one [`AiMessageContent`].
///
/// The bound covers the worst JSON string expansion for assistant text (six bytes
/// per input byte for `\u00XX` escapes), two bytes per byte for embedded canonical
/// tool JSON and the bounded tool name, the already-serialized transcript ceiling,
/// plus fixed field names, punctuation, and conservative structural headroom.
pub const AI_MESSAGE_CONTENT_JSON_BYTES_MAX: usize = AI_ASSISTANT_TEXT_BYTES_MAX * 6
    + AI_TOOL_ARGUMENTS_BYTES_MAX * 2
    + AI_TOOL_RESULT_BYTES_MAX * 2
    + AI_TOOL_EVENT_TRANSCRIPT_BYTES_MAX
    + AI_PROVIDER_ID_BYTES_MAX * 2
    + 2048;
/// One memory UTF-8 byte ceiling.
pub const AI_MEMORY_BYTES_MAX: usize = 10_000;
/// Provider identifier UTF-8 byte ceiling.
pub const AI_PROVIDER_ID_BYTES_MAX: usize = 64;
/// Model identifier UTF-8 byte ceiling.
pub const AI_MODEL_ID_BYTES_MAX: usize = 256;
/// Base URL UTF-8 byte ceiling.
pub const AI_BASE_URL_BYTES_MAX: usize = 2_048;
/// Private secret entries ceiling.
pub const AI_SECRETS_MAX: usize = 32;
/// Raw secret value UTF-8 byte ceiling.
pub const AI_SECRET_BYTES_MAX: usize = 8 * 1024;
/// Approval lifetime in seconds.
pub const AI_APPROVAL_LIFETIME_SECS: i64 = 5 * 60;
/// VAD/hands-free grace period lower bound (ms).
pub const AI_GRACE_PERIOD_MS_MIN: u32 = 500;
/// VAD/hands-free grace period upper bound (ms).
pub const AI_GRACE_PERIOD_MS_MAX: u32 = 3_000;
/// Default grace period (ms).
pub const AI_GRACE_PERIOD_MS_DEFAULT: u32 = 1_000;
/// Strict private secrets document version.
pub const AI_SECRETS_FILE_VERSION: u32 = 1;
/// Private profile file name beside other security artifacts.
pub const AI_SECRETS_FILE: &str = "ai-secrets.json";

// ── Identifiers ─────────────────────────────────────────────────────────────

macro_rules! ai_entity_id {
    ($name:ident, $field:literal) => {
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }

            pub fn parse(value: &str) -> Result<Self, ValidationError> {
                let uuid = Uuid::parse_str(value)
                    .map_err(|_| ValidationError::InvalidId { field: $field })?;
                Ok(Self(uuid))
            }

            #[must_use]
            pub const fn as_uuid(self) -> Uuid {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }

        impl FromStr for $name {
            type Err = ValidationError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::parse(value)
            }
        }
    };
}

ai_entity_id!(AiSessionId, "ai_session_id");
ai_entity_id!(AiMessageId, "ai_message_id");
ai_entity_id!(AiMemoryId, "ai_memory_id");
ai_entity_id!(AiApprovalId, "ai_approval_id");
ai_entity_id!(AiTurnId, "ai_turn_id");
ai_entity_id!(AiRunId, "ai_run_id");
ai_entity_id!(AiCredentialId, "ai_credential_id");

// ── Provider / speech enums ─────────────────────────────────────────────────

/// Built-in chat provider preset or an operator-authored custom endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProviderPreset {
    OpenAi,
    Anthropic,
    Gemini,
    OpenRouter,
    Ollama,
    LmStudio,
    DeepSeek,
    Mistral,
    Kimi,
    DashScope,
    Groq,
    ZAi,
    Custom,
}

impl AiProviderPreset {
    /// All built-in presets in stable display / inventory order.
    pub const ALL: [Self; 13] = [
        Self::OpenAi,
        Self::Anthropic,
        Self::OpenRouter,
        Self::Ollama,
        Self::LmStudio,
        Self::DeepSeek,
        Self::Gemini,
        Self::Mistral,
        Self::Kimi,
        Self::DashScope,
        Self::Groq,
        Self::ZAi,
        Self::Custom,
    ];

    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "anthropic" => Ok(Self::Anthropic),
            "gemini" => Ok(Self::Gemini),
            "openrouter" => Ok(Self::OpenRouter),
            "ollama" => Ok(Self::Ollama),
            // Canonical wire ID is `lm_studio`; accept common aliases on input only.
            "lm_studio" | "lmstudio" | "lm-studio" => Ok(Self::LmStudio),
            "deepseek" => Ok(Self::DeepSeek),
            "mistral" => Ok(Self::Mistral),
            // Canonical wire ID is `kimi`; `moonshot` is a safe input alias.
            "kimi" | "moonshot" => Ok(Self::Kimi),
            "dashscope" => Ok(Self::DashScope),
            "groq" => Ok(Self::Groq),
            // Canonical wire ID is `z_ai`; `zai` / `glm` are safe input aliases.
            "z_ai" | "zai" | "glm" => Ok(Self::ZAi),
            "custom" => Ok(Self::Custom),
            _ => Err(ValidationError::InvalidFormat {
                field: "ai.provider",
                expected: "openai|anthropic|gemini|openrouter|ollama|lm_studio|deepseek|mistral|kimi|dashscope|groq|z_ai|custom",
            }),
        }
    }

    /// Canonical persisted / wire identity (snake_case).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::OpenRouter => "openrouter",
            Self::Ollama => "ollama",
            Self::LmStudio => "lm_studio",
            Self::DeepSeek => "deepseek",
            Self::Mistral => "mistral",
            Self::Kimi => "kimi",
            Self::DashScope => "dashscope",
            Self::Groq => "groq",
            Self::ZAi => "z_ai",
            Self::Custom => "custom",
        }
    }

    /// Operator-facing display label for settings and registry surfaces.
    #[must_use]
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::OpenAi => "OpenAI",
            Self::Anthropic => "Anthropic",
            Self::Gemini => "Gemini",
            Self::OpenRouter => "OpenRouter",
            Self::Ollama => "Ollama",
            Self::LmStudio => "LM Studio",
            Self::DeepSeek => "DeepSeek",
            Self::Mistral => "Mistral",
            Self::Kimi => "Kimi / Moonshot",
            Self::DashScope => "DashScope",
            Self::Groq => "Groq",
            Self::ZAi => "Z.AI / GLM",
            Self::Custom => "Custom",
        }
    }

    /// Frozen official origin for built-in presets. `Custom` has no fixed origin.
    #[must_use]
    pub const fn official_base_url(self) -> Option<&'static str> {
        match self {
            Self::OpenAi => Some("https://api.openai.com/v1"),
            Self::Anthropic => Some("https://api.anthropic.com"),
            // Official Gemini REST base includes the `v1beta` version segment.
            Self::Gemini => Some("https://generativelanguage.googleapis.com/v1beta"),
            Self::OpenRouter => Some("https://openrouter.ai/api/v1"),
            Self::Ollama => Some("http://127.0.0.1:11434/v1"),
            Self::LmStudio => Some("http://127.0.0.1:1234/v1"),
            Self::DeepSeek => Some("https://api.deepseek.com"),
            Self::Mistral => Some("https://api.mistral.ai/v1"),
            Self::Kimi => Some("https://api.moonshot.ai/v1"),
            // Built-in uses the international compatible-mode origin; workspace-specific
            // regional domains remain available through the explicit Custom provider path.
            Self::DashScope => Some("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
            Self::Groq => Some("https://api.groq.com/openai/v1"),
            Self::ZAi => Some("https://api.z.ai/api/paas/v4"),
            Self::Custom => None,
        }
    }

    #[must_use]
    pub const fn allows_loopback_http(self) -> bool {
        matches!(self, Self::Ollama | Self::LmStudio | Self::Custom)
    }
}

/// Cloud speech provider presets used by STT/TTS settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechProviderPreset {
    Browser,
    OpenAi,
    Groq,
    Inworld,
}

impl SpeechProviderPreset {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "browser" => Ok(Self::Browser),
            "openai" => Ok(Self::OpenAi),
            "groq" => Ok(Self::Groq),
            "inworld" => Ok(Self::Inworld),
            _ => Err(ValidationError::InvalidFormat {
                field: "voice.provider",
                expected: "browser|openai|groq|inworld",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::OpenAi => "openai",
            Self::Groq => "groq",
            Self::Inworld => "inworld",
        }
    }

    #[must_use]
    pub const fn is_cloud(self) -> bool {
        !matches!(self, Self::Browser)
    }
}

/// Half-duplex voice interaction mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceMode {
    PushToTalk,
    HandsFree,
}

impl VoiceMode {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "push_to_talk" => Ok(Self::PushToTalk),
            "hands_free" => Ok(Self::HandsFree),
            _ => Err(ValidationError::InvalidFormat {
                field: "voice.voice_mode",
                expected: "push_to_talk|hands_free",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PushToTalk => "push_to_talk",
            Self::HandsFree => "hands_free",
        }
    }
}

/// Kind of private AI credential bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiSecretKind {
    ApiKey,
    Bearer,
    InworldBasic,
    InworldJwt,
}

impl AiSecretKind {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "api_key" => Ok(Self::ApiKey),
            "bearer" => Ok(Self::Bearer),
            "inworld_basic" => Ok(Self::InworldBasic),
            "inworld_jwt" => Ok(Self::InworldJwt),
            _ => Err(ValidationError::InvalidFormat {
                field: "ai_secret.kind",
                expected: "api_key|bearer|inworld_basic|inworld_jwt",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ApiKey => "api_key",
            Self::Bearer => "bearer",
            Self::InworldBasic => "inworld_basic",
            Self::InworldJwt => "inworld_jwt",
        }
    }
}

// ── Validated strings ───────────────────────────────────────────────────────

/// Provider/model token with a UTF-8 byte ceiling and no control characters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AiModelId(String);

impl AiModelId {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        validate_token(&value, "ai.model", AI_MODEL_ID_BYTES_MAX)?;
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AiModelId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Operator-authored or preset base URL under the frozen egress policy.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProviderBaseUrl(String);

impl ProviderBaseUrl {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        validate_base_url(&value)?;
        Ok(Self(value))
    }

    /// Validate a URL for a specific provider preset.
    pub fn for_provider(
        provider: AiProviderPreset,
        value: impl Into<String>,
    ) -> Result<Self, ValidationError> {
        let url = Self::new(value)?;
        match provider {
            AiProviderPreset::Custom => {
                // Custom may be HTTPS anywhere or loopback HTTP only.
                Ok(url)
            }
            AiProviderPreset::Ollama | AiProviderPreset::LmStudio => {
                // Local engines may listen on an operator-selected loopback port.
                let rest = url
                    .as_str()
                    .split_once("://")
                    .expect("validated base URL has a scheme")
                    .1;
                let authority = rest.split('/').next().unwrap_or(rest);
                let host = strip_port(authority)?;
                if is_loopback_host(host) {
                    Ok(url)
                } else {
                    Err(ValidationError::Invalid {
                        field: "ai.base_url",
                        reason: "local providers require a loopback host",
                    })
                }
            }
            other => {
                if let Some(official) = other.official_base_url() {
                    if url.as_str() == official {
                        return Ok(url);
                    }
                    // Built-in non-custom presets accept only their frozen origin.
                    return Err(ValidationError::Invalid {
                        field: "ai.base_url",
                        reason: "must match the official HTTPS/loopback origin for the selected provider",
                    });
                }
                Ok(url)
            }
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProviderBaseUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProviderBaseUrl(..)")
    }
}

impl fmt::Display for ProviderBaseUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Safe to display: URLs never carry userinfo/query/fragment secrets.
        self.0.fmt(f)
    }
}

/// Bounded custom-instruction text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CustomInstructions(String);

impl CustomInstructions {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.len() > AI_CUSTOM_INSTRUCTIONS_BYTES_MAX {
            return Err(ValidationError::TooLong {
                field: "ai.custom_instructions",
                max: AI_CUSTOM_INSTRUCTIONS_BYTES_MAX,
            });
        }
        if value
            .chars()
            .any(|ch| ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t')
        {
            return Err(ValidationError::Invalid {
                field: "ai.custom_instructions",
                reason: "must not contain control characters",
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Default for CustomInstructions {
    fn default() -> Self {
        Self::new(String::new()).expect("empty instructions are valid")
    }
}

/// Grace period in milliseconds for hands-free VAD silence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GracePeriodMs(u32);

impl GracePeriodMs {
    pub fn new(value: u32) -> Result<Self, ValidationError> {
        if !(AI_GRACE_PERIOD_MS_MIN..=AI_GRACE_PERIOD_MS_MAX).contains(&value) {
            return Err(ValidationError::OutOfRange {
                field: "voice.grace_period_ms",
                min: i64::from(AI_GRACE_PERIOD_MS_MIN),
                max: i64::from(AI_GRACE_PERIOD_MS_MAX),
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }

    #[must_use]
    pub fn default_value() -> Self {
        Self::new(AI_GRACE_PERIOD_MS_DEFAULT).expect("default grace period is valid")
    }
}

// ── Settings sections ───────────────────────────────────────────────────────

/// Non-secret AI configuration. Defaults leave cloud AI disabled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiSettings {
    /// Master enable for provider-backed AI. Default false.
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<AiProviderPreset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<AiModelId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<ProviderBaseUrl>,
    /// Binding to a private secret ID. Presence-only; never secret bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<AiCredentialId>,
    pub custom_instructions: CustomInstructions,
    pub daily_briefing_enabled: bool,
    /// Optional 1–5 energy preference for planning context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_energy: Option<u8>,
    pub auto_send: bool,
    pub smart_endpoint: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self::default_settings()
    }
}

impl AiSettings {
    #[must_use]
    pub fn default_settings() -> Self {
        Self {
            enabled: false,
            provider: None,
            model: None,
            base_url: None,
            credential_id: None,
            custom_instructions: CustomInstructions::default(),
            daily_briefing_enabled: false,
            default_energy: None,
            auto_send: false,
            smart_endpoint: false,
        }
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        if let Some(model) = &self.model {
            AiModelId::new(model.as_str())?;
        }
        if let Some(energy) = self.default_energy
            && !(1..=5).contains(&energy)
        {
            return Err(ValidationError::OutOfRange {
                field: "ai.default_energy",
                min: 1,
                max: 5,
            });
        }
        CustomInstructions::new(self.custom_instructions.as_str())?;

        match (self.provider, &self.base_url) {
            (Some(provider), Some(url)) => {
                ProviderBaseUrl::for_provider(provider, url.as_str())?;
            }
            (Some(AiProviderPreset::Custom), None) => {
                return Err(ValidationError::Invalid {
                    field: "ai.base_url",
                    reason: "custom provider requires an explicit base URL",
                });
            }
            (None, Some(_)) => {
                return Err(ValidationError::Invalid {
                    field: "ai.base_url",
                    reason: "base URL requires a selected provider",
                });
            }
            _ => {}
        }

        if self.enabled && self.provider.is_none() {
            return Err(ValidationError::Invalid {
                field: "ai.enabled",
                reason: "enabled AI requires a selected provider",
            });
        }
        // A credential may be staged while AI is disabled so operator-only
        // configuration and secret rotation remain independent operations.
        // Provider use still requires `enabled` plus a selected provider.
        Ok(())
    }

    /// Clear every credential binding and force AI disabled while keeping preferences.
    #[must_use]
    pub fn cleared_for_restore(&self) -> Self {
        Self {
            enabled: false,
            credential_id: None,
            provider: self.provider,
            model: self.model.clone(),
            base_url: self.base_url.clone(),
            custom_instructions: self.custom_instructions.clone(),
            daily_briefing_enabled: self.daily_briefing_enabled,
            default_energy: self.default_energy,
            auto_send: self.auto_send,
            smart_endpoint: self.smart_endpoint,
        }
    }

    /// Credential IDs referenced by confirmed settings.
    #[must_use]
    pub fn referenced_credential_ids(&self) -> Vec<AiCredentialId> {
        self.credential_id.into_iter().collect()
    }
}

/// Non-secret voice configuration. Defaults leave cloud speech disabled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceSettings {
    /// Master enable for cloud STT/TTS. Browser speech may still be used locally.
    pub cloud_speech_enabled: bool,
    pub stt_provider: SpeechProviderPreset,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_model: Option<AiModelId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_credential_id: Option<AiCredentialId>,
    pub tts_provider: SpeechProviderPreset,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts_model: Option<AiModelId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts_voice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts_credential_id: Option<AiCredentialId>,
    pub tts_enabled: bool,
    pub voice_mode: VoiceMode,
    pub grace_period_ms: GracePeriodMs,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self::default_settings()
    }
}

impl VoiceSettings {
    #[must_use]
    pub fn default_settings() -> Self {
        Self {
            cloud_speech_enabled: false,
            stt_provider: SpeechProviderPreset::Browser,
            stt_model: None,
            stt_credential_id: None,
            tts_provider: SpeechProviderPreset::Browser,
            tts_model: None,
            tts_voice: None,
            tts_credential_id: None,
            tts_enabled: true,
            voice_mode: VoiceMode::PushToTalk,
            grace_period_ms: GracePeriodMs::default_value(),
        }
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        if let Some(model) = &self.stt_model {
            AiModelId::new(model.as_str())?;
        }
        if let Some(model) = &self.tts_model {
            AiModelId::new(model.as_str())?;
        }
        if let Some(voice) = &self.tts_voice {
            validate_token(voice, "voice.tts_voice", AI_MODEL_ID_BYTES_MAX)?;
        }
        GracePeriodMs::new(self.grace_period_ms.get())?;

        if self.cloud_speech_enabled {
            if !self.stt_provider.is_cloud() && !self.tts_provider.is_cloud() {
                return Err(ValidationError::Invalid {
                    field: "voice.cloud_speech_enabled",
                    reason: "cloud speech requires a cloud STT or TTS provider",
                });
            }
        } else {
            // Disabled cloud speech may still record preferred cloud providers, but
            // must not keep live credential bindings that could authorize egress.
            if self.stt_credential_id.is_some() || self.tts_credential_id.is_some() {
                return Err(ValidationError::Invalid {
                    field: "voice.cloud_speech_enabled",
                    reason: "cloud speech credentials require cloud_speech_enabled",
                });
            }
        }

        if self.stt_credential_id.is_some() && !self.stt_provider.is_cloud() {
            return Err(ValidationError::Invalid {
                field: "voice.stt_credential_id",
                reason: "STT credential requires a cloud STT provider",
            });
        }
        if self.tts_credential_id.is_some() && !self.tts_provider.is_cloud() {
            return Err(ValidationError::Invalid {
                field: "voice.tts_credential_id",
                reason: "TTS credential requires a cloud TTS provider",
            });
        }
        Ok(())
    }

    /// Clear credential bindings and force cloud speech disabled.
    #[must_use]
    pub fn cleared_for_restore(&self) -> Self {
        Self {
            cloud_speech_enabled: false,
            stt_credential_id: None,
            tts_credential_id: None,
            stt_provider: self.stt_provider,
            stt_model: self.stt_model.clone(),
            tts_provider: self.tts_provider,
            tts_model: self.tts_model.clone(),
            tts_voice: self.tts_voice.clone(),
            tts_enabled: self.tts_enabled,
            voice_mode: self.voice_mode,
            grace_period_ms: self.grace_period_ms,
        }
    }

    #[must_use]
    pub fn referenced_credential_ids(&self) -> Vec<AiCredentialId> {
        self.stt_credential_id
            .into_iter()
            .chain(self.tts_credential_id)
            .collect()
    }
}

// ── Durable entities ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiSessionStatus {
    Active,
    Archived,
}

impl AiSessionStatus {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "active" => Ok(Self::Active),
            "archived" => Ok(Self::Archived),
            _ => Err(ValidationError::InvalidFormat {
                field: "ai_session.status",
                expected: "active|archived",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiSession {
    pub id: AiSessionId,
    pub title: String,
    pub status: AiSessionStatus,
    pub message_count: u32,
    pub content_bytes: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<Timestamp>,
}

impl AiSession {
    pub fn new(
        id: AiSessionId,
        title: impl Into<String>,
        now: Timestamp,
    ) -> Result<Self, ValidationError> {
        let title = validate_session_title(title.into())?;
        Ok(Self {
            id,
            title,
            status: AiSessionStatus::Active,
            message_count: 0,
            content_bytes: 0,
            created_at: now,
            updated_at: now,
            last_message_at: None,
        })
    }

    pub fn rename(
        &mut self,
        title: impl Into<String>,
        now: Timestamp,
    ) -> Result<(), ValidationError> {
        self.title = validate_session_title(title.into())?;
        self.updated_at = now;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiMessageRole {
    User,
    Assistant,
    System,
    Tool,
}

impl AiMessageRole {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "user" => Ok(Self::User),
            "assistant" => Ok(Self::Assistant),
            "system" => Ok(Self::System),
            "tool" => Ok(Self::Tool),
            _ => Err(ValidationError::InvalidFormat {
                field: "ai_message.role",
                expected: "user|assistant|system|tool",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
            Self::Tool => "tool",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiMessageStatus {
    Pending,
    Streaming,
    Completed,
    Failed,
    Cancelled,
}

impl AiMessageStatus {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "pending" => Ok(Self::Pending),
            "streaming" => Ok(Self::Streaming),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(ValidationError::InvalidFormat {
                field: "ai_message.status",
                expected: "pending|streaming|completed|failed|cancelled",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Streaming => "streaming",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Provider-neutral durable tool event types retained for exact local replay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiToolEventType {
    ToolProposed,
    ToolApproved,
    ToolRejected,
    ToolResult,
}

impl AiToolEventType {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ToolProposed => "tool_proposed",
            Self::ToolApproved => "tool_approved",
            Self::ToolRejected => "tool_rejected",
            Self::ToolResult => "tool_result",
        }
    }
}

/// One versioned durable local event positioned in assistant UTF-8 bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiToolEvent {
    pub version: u8,
    pub assistant_utf8_offset: u32,
    pub event_type: AiToolEventType,
    pub payload: serde_json::Value,
}

impl AiToolEvent {
    pub fn new(
        assistant_utf8_offset: usize,
        event_type: AiToolEventType,
        payload: serde_json::Value,
    ) -> Result<Self, ValidationError> {
        let assistant_utf8_offset =
            u32::try_from(assistant_utf8_offset).map_err(|_| ValidationError::Invalid {
                field: "ai_message.content.tool_events.assistant_utf8_offset",
                reason: "assistant UTF-8 offset is too large",
            })?;
        let event = Self {
            version: 1,
            assistant_utf8_offset,
            event_type,
            payload,
        };
        event.validate_payload()?;
        Ok(event)
    }

    fn validate_payload(&self) -> Result<(), ValidationError> {
        const FIELD: &str = "ai_message.content.tool_events.payload";
        match self.event_type {
            AiToolEventType::ToolProposed => {
                let payload: ProposedToolEventPayload =
                    serde_json::from_value(self.payload.clone())
                        .map_err(|_| invalid_tool_event_payload())?;
                validate_canonical_approval_id(&payload.approval_id)?;
                validate_ai_tool_name(&payload.tool)?;
                let canonical_arguments = serde_json::to_string(&payload.arguments)
                    .map_err(|_| invalid_tool_event_payload())?;
                if ai_approval_action_hash(&payload.tool, &canonical_arguments)?
                    != payload.action_hash
                    || !is_sha256_hex(&payload.action_hash)
                {
                    return Err(invalid_tool_event_payload());
                }
                let expires_at: Timestamp = payload
                    .expires_at
                    .parse()
                    .map_err(|_| invalid_tool_event_payload())?;
                if expires_at.to_string() != payload.expires_at {
                    return Err(invalid_tool_event_payload());
                }
            }
            AiToolEventType::ToolApproved | AiToolEventType::ToolRejected => {
                let payload: ApprovalToolEventPayload =
                    serde_json::from_value(self.payload.clone())
                        .map_err(|_| invalid_tool_event_payload())?;
                validate_canonical_approval_id(&payload.approval_id)?;
            }
            AiToolEventType::ToolResult => {
                let payload: ToolResultEventPayload = serde_json::from_value(self.payload.clone())
                    .map_err(|_| invalid_tool_event_payload())?;
                validate_ai_tool_name(&payload.tool)?;
                if !matches!(
                    payload.outcome.as_str(),
                    "success" | "error" | "unavailable"
                ) {
                    return Err(invalid_tool_event_payload());
                }
                if let Some(operation_id) = payload.operation_id {
                    let parsed = crate::OperationId::parse(&operation_id)?;
                    if parsed.to_string() != operation_id {
                        return Err(invalid_tool_event_payload());
                    }
                }
                if payload.revision == Some(0) || contains_private_result_key(&payload.data) {
                    return Err(invalid_tool_event_payload());
                }
                let _ = payload.truncated;
            }
        }
        if !self.payload.is_object() {
            return Err(ValidationError::Invalid {
                field: FIELD,
                reason: "tool event payload must be a valid local event object",
            });
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposedToolEventPayload {
    approval_id: String,
    tool: String,
    arguments: serde_json::Map<String, serde_json::Value>,
    action_hash: String,
    expires_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApprovalToolEventPayload {
    approval_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolResultEventPayload {
    tool: String,
    outcome: String,
    data: serde_json::Value,
    truncated: bool,
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    revision: Option<u64>,
}

fn invalid_tool_event_payload() -> ValidationError {
    ValidationError::Invalid {
        field: "ai_message.content.tool_events.payload",
        reason: "tool event payload does not match its canonical local schema",
    }
}

fn validate_canonical_approval_id(raw: &str) -> Result<(), ValidationError> {
    let id = AiApprovalId::parse(raw)?;
    if id.to_string() != raw {
        return Err(invalid_tool_event_payload());
    }
    Ok(())
}

fn is_sha256_hex(raw: &str) -> bool {
    raw.len() == 64
        && raw
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn contains_private_result_key(value: &serde_json::Value) -> bool {
    const PRIVATE_KEYS: [&str; 12] = [
        "dispatch_operation_id",
        "provider_call_id",
        "provider_call_ids",
        "raw",
        "raw_body",
        "response_body",
        "credential",
        "secret",
        "reasoning",
        "chain_of_thought",
        "chain-of-thought",
        "chainOfThought",
    ];
    match value {
        serde_json::Value::Object(object) => object.iter().any(|(key, value)| {
            PRIVATE_KEYS.contains(&key.as_str()) || contains_private_result_key(value)
        }),
        serde_json::Value::Array(values) => values.iter().any(contains_private_result_key),
        _ => false,
    }
}

/// Bounded structured message content stored as canonical JSON text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiMessageContent {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    /// Ordered provider-neutral tool cards for exact durable SSE reconstruction.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_events: Vec<AiToolEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_arguments_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_result_json: Option<String>,
    /// Local civil date for a daily-briefing assistant message (`YYYY-MM-DD`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub briefing_date: Option<String>,
    /// Optional focused-task binding captured on a user message.
    ///
    /// This is durable request identity for exact response replay; it is never
    /// accepted from a provider response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_task_id: Option<crate::TaskId>,
}

impl AiMessageContent {
    pub fn text(text: impl Into<String>) -> Result<Self, ValidationError> {
        let text = text.into();
        if text.len() > AI_ASSISTANT_TEXT_BYTES_MAX {
            return Err(ValidationError::TooLong {
                field: "ai_message.content.text",
                max: AI_ASSISTANT_TEXT_BYTES_MAX,
            });
        }
        Ok(Self {
            text,
            tool_events: Vec::new(),
            tool_name: None,
            tool_arguments_json: None,
            tool_result_json: None,
            briefing_date: None,
            focused_task_id: None,
        })
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.text.len() > AI_ASSISTANT_TEXT_BYTES_MAX {
            return Err(ValidationError::TooLong {
                field: "ai_message.content.text",
                max: AI_ASSISTANT_TEXT_BYTES_MAX,
            });
        }
        if let Some(args) = &self.tool_arguments_json
            && args.len() > AI_TOOL_ARGUMENTS_BYTES_MAX
        {
            return Err(ValidationError::TooLong {
                field: "ai_message.content.tool_arguments_json",
                max: AI_TOOL_ARGUMENTS_BYTES_MAX,
            });
        }
        if let Some(result) = &self.tool_result_json
            && result.len() > AI_TOOL_RESULT_BYTES_MAX
        {
            return Err(ValidationError::TooLong {
                field: "ai_message.content.tool_result_json",
                max: AI_TOOL_RESULT_BYTES_MAX,
            });
        }
        if let Some(name) = &self.tool_name {
            validate_token(
                name,
                "ai_message.content.tool_name",
                AI_PROVIDER_ID_BYTES_MAX,
            )?;
        }
        let mut previous_offset = 0_usize;
        for event in &self.tool_events {
            let offset = event.assistant_utf8_offset as usize;
            if event.version != 1
                || offset < previous_offset
                || offset > self.text.len()
                || !self.text.is_char_boundary(offset)
            {
                return Err(ValidationError::Invalid {
                    field: "ai_message.content.tool_events",
                    reason: "tool events must be version 1 with ordered assistant UTF-8 offsets and valid local payloads",
                });
            }
            event.validate_payload()?;
            previous_offset = offset;
        }
        let transcript_bytes =
            serde_json::to_vec(&self.tool_events).map_err(|_| ValidationError::Invalid {
                field: "ai_message.content.tool_events",
                reason: "tool events must be JSON-serializable",
            })?;
        if transcript_bytes.len() > AI_TOOL_EVENT_TRANSCRIPT_BYTES_MAX {
            return Err(ValidationError::TooLong {
                field: "ai_message.content.tool_events",
                max: AI_TOOL_EVENT_TRANSCRIPT_BYTES_MAX,
            });
        }
        if self
            .briefing_date
            .as_deref()
            .is_some_and(|date| date.len() != 10 || date.parse::<jiff::civil::Date>().is_err())
        {
            return Err(ValidationError::InvalidFormat {
                field: "ai_message.content.briefing_date",
                expected: "YYYY-MM-DD",
            });
        }
        Ok(())
    }

    pub fn canonical_json(&self) -> Result<String, ValidationError> {
        self.validate()?;
        serde_json::to_string(self).map_err(|_| ValidationError::Invalid {
            field: "ai_message.content",
            reason: "content must be JSON-serializable",
        })
    }

    #[must_use]
    pub fn byte_len(canonical_json: &str) -> u64 {
        canonical_json.len() as u64
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiMessage {
    pub id: AiMessageId,
    pub session_id: AiSessionId,
    pub turn_id: AiTurnId,
    pub sequence: u32,
    pub role: AiMessageRole,
    pub status: AiMessageStatus,
    pub content: AiMessageContent,
    pub content_bytes: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiMemory {
    pub id: AiMemoryId,
    pub content: String,
    pub content_bytes: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl AiMemory {
    pub fn new(
        id: AiMemoryId,
        content: impl Into<String>,
        now: Timestamp,
    ) -> Result<Self, ValidationError> {
        let content = validate_memory_content(content.into())?;
        let content_bytes = content.len() as u64;
        Ok(Self {
            id,
            content,
            content_bytes,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn update_content(
        &mut self,
        content: impl Into<String>,
        now: Timestamp,
    ) -> Result<(), ValidationError> {
        self.content = validate_memory_content(content.into())?;
        self.content_bytes = self.content.len() as u64;
        self.updated_at = now;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiApprovalStatus {
    Pending,
    Approved,
    Rejected,
    Expired,
    Consumed,
}

impl AiApprovalStatus {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "rejected" => Ok(Self::Rejected),
            "expired" => Ok(Self::Expired),
            "consumed" => Ok(Self::Consumed),
            _ => Err(ValidationError::InvalidFormat {
                field: "ai_approval.status",
                expected: "pending|approved|rejected|expired|consumed",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Expired => "expired",
            Self::Consumed => "consumed",
        }
    }

    #[must_use]
    pub const fn is_pending(self) -> bool {
        matches!(self, Self::Pending)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiToolApproval {
    pub id: AiApprovalId,
    pub session_id: AiSessionId,
    pub turn_id: AiTurnId,
    pub run_id: AiRunId,
    pub generation: u64,
    pub tool_name: String,
    pub arguments_json: String,
    pub arguments_bytes: u64,
    pub action_hash: String,
    pub status: AiApprovalStatus,
    pub expires_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Typed history action that replaces one conversation suffix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiResponseRewriteKind {
    Edit,
    Retry,
    Regenerate,
}

impl AiResponseRewriteKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Edit => "edit",
            Self::Retry => "retry",
            Self::Regenerate => "regenerate",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiRunPhase {
    Running,
    AwaitingApproval,
    Dispatching,
    Completed,
    Failed,
    Cancelled,
}

impl AiRunPhase {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "running" => Ok(Self::Running),
            "awaiting_approval" => Ok(Self::AwaitingApproval),
            "dispatching" => Ok(Self::Dispatching),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(ValidationError::InvalidFormat {
                field: "ai_run.state",
                expected: "running|awaiting_approval|dispatching|completed|failed|cancelled",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::AwaitingApproval => "awaiting_approval",
            Self::Dispatching => "dispatching",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiRunState {
    pub run_id: AiRunId,
    pub session_id: AiSessionId,
    pub turn_id: AiTurnId,
    /// Exact durable assistant placeholder owned by this run.
    pub assistant_message_id: AiMessageId,
    pub generation: u64,
    pub state: AiRunPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<AiApprovalId>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Presence-only public metadata for one private AI secret.
///
/// Raw secret bytes are intentionally absent. This type is safe for Debug/serde.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiSecretMetadata {
    pub id: AiCredentialId,
    pub kind: AiSecretKind,
    pub updated_at: Timestamp,
    /// Always true for listed entries; retained for stable API shape.
    pub present: bool,
}

/// Validate storage-level canonical tool-name syntax without assigning semantics.
pub fn validate_ai_tool_name(value: &str) -> Result<(), ValidationError> {
    validate_token(value, "ai_approval.tool_name", AI_PROVIDER_ID_BYTES_MAX)?;
    let mut bytes = value.bytes();
    if !bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
        || bytes.any(|byte| !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'))
    {
        return Err(ValidationError::InvalidFormat {
            field: "ai_approval.tool_name",
            expected: "canonical lowercase snake_case token",
        });
    }
    Ok(())
}

/// Hash one canonical approval action independent of run/session identities.
///
/// Length framing plus an explicit domain separator prevents ambiguous concatenation.
pub fn ai_approval_action_hash(
    tool_name: &str,
    canonical_arguments_json: &str,
) -> Result<String, ValidationError> {
    validate_ai_tool_name(tool_name)?;
    if canonical_arguments_json.len() > AI_TOOL_ARGUMENTS_BYTES_MAX {
        return Err(ValidationError::TooLong {
            field: "ai_approval.arguments_json",
            max: AI_TOOL_ARGUMENTS_BYTES_MAX,
        });
    }
    let arguments: serde_json::Value =
        serde_json::from_str(canonical_arguments_json).map_err(|_| ValidationError::Invalid {
            field: "ai_approval.arguments_json",
            reason: "must be valid JSON",
        })?;
    if !arguments.is_object() {
        return Err(ValidationError::Invalid {
            field: "ai_approval.arguments_json",
            reason: "must be a JSON object",
        });
    }
    if serde_json::to_string(&arguments).ok().as_deref() != Some(canonical_arguments_json) {
        return Err(ValidationError::Invalid {
            field: "ai_approval.arguments_json",
            reason: "must be canonical JSON",
        });
    }
    let tool_len = u64::try_from(tool_name.len()).expect("tool name bound fits u64");
    let arguments_len =
        u64::try_from(canonical_arguments_json.len()).expect("tool arguments bound fits u64");
    let mut material = Vec::with_capacity(
        AI_APPROVAL_ACTION_HASH_DOMAIN.len()
            + 16
            + tool_name.len()
            + canonical_arguments_json.len(),
    );
    material.extend_from_slice(AI_APPROVAL_ACTION_HASH_DOMAIN);
    material.extend_from_slice(&tool_len.to_be_bytes());
    material.extend_from_slice(tool_name.as_bytes());
    material.extend_from_slice(&arguments_len.to_be_bytes());
    material.extend_from_slice(canonical_arguments_json.as_bytes());
    Ok(crate::sha256_hex(&material))
}

// ── Validation helpers ──────────────────────────────────────────────────────

fn validate_token(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), ValidationError> {
    if value.is_empty() {
        return Err(ValidationError::Empty { field });
    }
    if value.len() > max_bytes {
        return Err(ValidationError::TooLong {
            field,
            max: max_bytes,
        });
    }
    if value.chars().any(char::is_control) {
        return Err(ValidationError::Invalid {
            field,
            reason: "must not contain control characters",
        });
    }
    if value != value.trim() {
        return Err(ValidationError::Invalid {
            field,
            reason: "must not include leading or trailing whitespace",
        });
    }
    Ok(())
}

fn validate_session_title(title: String) -> Result<String, ValidationError> {
    let title = title.trim().to_owned();
    if title.is_empty() {
        return Err(ValidationError::Empty {
            field: "ai_session.title",
        });
    }
    if title.len() > AI_SESSION_TITLE_BYTES_MAX {
        return Err(ValidationError::TooLong {
            field: "ai_session.title",
            max: AI_SESSION_TITLE_BYTES_MAX,
        });
    }
    Ok(title)
}

fn validate_memory_content(content: String) -> Result<String, ValidationError> {
    let content = content.trim().to_owned();
    if content.is_empty() {
        return Err(ValidationError::Empty {
            field: "ai_memory.content",
        });
    }
    if content.len() > AI_MEMORY_BYTES_MAX {
        return Err(ValidationError::TooLong {
            field: "ai_memory.content",
            max: AI_MEMORY_BYTES_MAX,
        });
    }
    Ok(content)
}

/// Validate operator/preset base URLs under the frozen egress policy.
///
/// Rules:
/// - max 2048 UTF-8 bytes
/// - scheme `https` (anywhere) or `http` (loopback only)
/// - no userinfo, query, or fragment
/// - host required
pub fn validate_base_url(raw: &str) -> Result<(), ValidationError> {
    if raw.is_empty() {
        return Err(ValidationError::Empty {
            field: "ai.base_url",
        });
    }
    if raw.len() > AI_BASE_URL_BYTES_MAX {
        return Err(ValidationError::TooLong {
            field: "ai.base_url",
            max: AI_BASE_URL_BYTES_MAX,
        });
    }
    if raw.chars().any(char::is_control) {
        return Err(ValidationError::Invalid {
            field: "ai.base_url",
            reason: "must not contain control characters",
        });
    }
    if raw != raw.trim() {
        return Err(ValidationError::Invalid {
            field: "ai.base_url",
            reason: "must not include leading or trailing whitespace",
        });
    }
    if raw.contains('?') {
        return Err(ValidationError::Invalid {
            field: "ai.base_url",
            reason: "must not contain a query string",
        });
    }
    if raw.contains('#') {
        return Err(ValidationError::Invalid {
            field: "ai.base_url",
            reason: "must not contain a fragment",
        });
    }

    let (scheme, rest) = raw
        .split_once("://")
        .ok_or(ValidationError::InvalidFormat {
            field: "ai.base_url",
            expected: "https://host[/path] or http://loopback[/path]",
        })?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return Err(ValidationError::InvalidFormat {
            field: "ai.base_url",
            expected: "https://host[/path] or http://loopback[/path]",
        });
    }
    if rest.is_empty() {
        return Err(ValidationError::Invalid {
            field: "ai.base_url",
            reason: "host is required",
        });
    }
    // Reject userinfo: authority may not contain '@'.
    let authority = rest.split('/').next().unwrap_or(rest);
    if authority.contains('@') {
        return Err(ValidationError::Invalid {
            field: "ai.base_url",
            reason: "must not contain userinfo",
        });
    }
    if authority.is_empty() {
        return Err(ValidationError::Invalid {
            field: "ai.base_url",
            reason: "host is required",
        });
    }

    let host = strip_port(authority)?;
    if host.is_empty() {
        return Err(ValidationError::Invalid {
            field: "ai.base_url",
            reason: "host is required",
        });
    }

    if scheme == "http" && !is_loopback_host(host) {
        return Err(ValidationError::Invalid {
            field: "ai.base_url",
            reason: "http is allowed only for loopback hosts",
        });
    }
    Ok(())
}

fn strip_port(authority: &str) -> Result<&str, ValidationError> {
    if let Some(host) = authority.strip_prefix('[') {
        // IPv6 literal [::1] or [::1]:port
        let (inside, rest) = host.split_once(']').ok_or(ValidationError::Invalid {
            field: "ai.base_url",
            reason: "invalid IPv6 host",
        })?;
        if !rest.is_empty() && !rest.starts_with(':') {
            return Err(ValidationError::Invalid {
                field: "ai.base_url",
                reason: "invalid IPv6 host",
            });
        }
        if let Some(port) = rest.strip_prefix(':') {
            validate_port(port)?;
        }
        return Ok(inside);
    }
    // hostname or IPv4, optional :port
    if let Some((host, port)) = authority.rsplit_once(':') {
        if host.contains(':') {
            // Unbracketed IPv6 is rejected.
            return Err(ValidationError::Invalid {
                field: "ai.base_url",
                reason: "IPv6 hosts must be bracketed",
            });
        }
        validate_port(port)?;
        return Ok(host);
    }
    Ok(authority)
}

fn validate_port(port: &str) -> Result<(), ValidationError> {
    if port.parse::<u16>().ok().filter(|port| *port > 0).is_none() {
        return Err(ValidationError::Invalid {
            field: "ai.base_url",
            reason: "invalid port",
        });
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

/// Collect every credential ID referenced by AI/voice settings.
#[must_use]
pub fn referenced_ai_credential_ids(ai: &AiSettings, voice: &VoiceSettings) -> Vec<AiCredentialId> {
    let mut ids = ai.referenced_credential_ids();
    ids.extend(voice.referenced_credential_ids());
    ids.sort();
    ids.dedup();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_action_hash_has_stable_domain_separated_vector() {
        assert_eq!(
            ai_approval_action_hash("create_task", r#"{"title":"x"}"#).unwrap(),
            "68758525b764c7d537de378915c8da97c9234b12e781d20ea0dfa7e1f1a945d3"
        );
        assert_ne!(
            ai_approval_action_hash("create_task", r#"{"title":"x"}"#).unwrap(),
            crate::sha256_hex(b"create_task\n{\"title\":\"x\"}")
        );
        assert!(ai_approval_action_hash("CreateTask", "{}").is_err());
        assert!(ai_approval_action_hash("create_task", "[]").is_err());
        assert!(ai_approval_action_hash("create_task", r#"{ "title": "x" }"#).is_err());
    }

    #[test]
    fn disabled_ai_may_hold_an_unassigned_credential() {
        let mut ai = AiSettings::default_settings();
        ai.credential_id = Some(AiCredentialId::new());
        ai.validate().unwrap();
        ai.enabled = true;
        assert!(ai.validate().is_err());
    }

    #[test]
    fn defaults_leave_cloud_ai_and_speech_disabled() {
        let ai = AiSettings::default_settings();
        let voice = VoiceSettings::default_settings();
        ai.validate().unwrap();
        voice.validate().unwrap();
        assert!(!ai.enabled);
        assert!(ai.provider.is_none());
        assert!(ai.credential_id.is_none());
        assert!(!voice.cloud_speech_enabled);
        assert_eq!(voice.stt_provider, SpeechProviderPreset::Browser);
        assert_eq!(voice.tts_provider, SpeechProviderPreset::Browser);
        assert!(voice.stt_credential_id.is_none());
        assert!(voice.tts_credential_id.is_none());
        assert_eq!(voice.grace_period_ms.get(), AI_GRACE_PERIOD_MS_DEFAULT);
    }

    #[test]
    fn base_url_rejects_userinfo_query_fragment_and_non_loopback_http() {
        assert!(validate_base_url("https://user:pass@api.example.com").is_err());
        assert!(validate_base_url("https://api.example.com?key=1").is_err());
        assert!(validate_base_url("https://api.example.com#frag").is_err());
        assert!(validate_base_url("http://example.com/v1").is_err());
        assert!(validate_base_url("http://127.0.0.1:11434/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.2:11434/v1").is_ok());
        assert!(validate_base_url("http://localhost:1234/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1:bad/v1").is_err());
        assert!(validate_base_url("http://[::1]:70000/v1").is_err());
        assert!(validate_base_url("https://api.openai.com/v1").is_ok());
    }

    #[test]
    fn preset_base_url_must_match_official_origin() {
        assert!(
            ProviderBaseUrl::for_provider(AiProviderPreset::OpenAi, "https://api.openai.com/v1")
                .is_ok()
        );
        assert!(
            ProviderBaseUrl::for_provider(AiProviderPreset::OpenAi, "https://evil.example/v1")
                .is_err()
        );
        assert!(
            ProviderBaseUrl::for_provider(AiProviderPreset::Custom, "https://tailnet-host/v1")
                .is_ok()
        );
        assert!(
            ProviderBaseUrl::for_provider(AiProviderPreset::Custom, "http://10.0.0.5/v1").is_err()
        );
        assert!(
            ProviderBaseUrl::for_provider(AiProviderPreset::Ollama, "http://127.0.0.1:11434/v1")
                .is_ok()
        );
        assert!(
            ProviderBaseUrl::for_provider(AiProviderPreset::Ollama, "http://127.0.0.1:42191/v1")
                .is_ok()
        );
        assert!(
            ProviderBaseUrl::for_provider(AiProviderPreset::Ollama, "https://remote.example/v1")
                .is_err()
        );
        assert!(
            ProviderBaseUrl::for_provider(
                AiProviderPreset::Gemini,
                "https://generativelanguage.googleapis.com/v1beta",
            )
            .is_ok()
        );
        assert!(
            ProviderBaseUrl::for_provider(
                AiProviderPreset::Gemini,
                "https://generativelanguage.googleapis.com",
            )
            .is_err()
        );
        assert!(
            ProviderBaseUrl::for_provider(
                AiProviderPreset::DashScope,
                "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            )
            .is_ok()
        );
        assert!(
            ProviderBaseUrl::for_provider(
                AiProviderPreset::DashScope,
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
            )
            .is_err()
        );
        assert!(
            ProviderBaseUrl::for_provider(AiProviderPreset::DeepSeek, "https://api.deepseek.com",)
                .is_ok()
        );
    }

    #[test]
    fn provider_preset_canonical_identity_and_aliases() {
        assert_eq!(AiProviderPreset::ALL.len(), 13);
        assert_eq!(AiProviderPreset::LmStudio.as_str(), "lm_studio");
        assert_eq!(AiProviderPreset::ZAi.as_str(), "z_ai");
        assert_eq!(AiProviderPreset::DeepSeek.display_name(), "DeepSeek");
        assert_eq!(
            AiProviderPreset::parse("lmstudio").unwrap().as_str(),
            "lm_studio"
        );
        assert_eq!(
            AiProviderPreset::parse("lm-studio").unwrap().as_str(),
            "lm_studio"
        );
        assert_eq!(AiProviderPreset::parse("zai").unwrap().as_str(), "z_ai");
        assert_eq!(AiProviderPreset::parse("glm").unwrap().as_str(), "z_ai");
        assert_eq!(
            AiProviderPreset::parse("moonshot").unwrap(),
            AiProviderPreset::Kimi
        );
        assert!(AiProviderPreset::parse("xai").is_err());
        assert!(AiProviderPreset::ALL.contains(&AiProviderPreset::DeepSeek));
        assert!(!AiProviderPreset::ALL.iter().any(|p| p.as_str() == "xai"));

        let lm = serde_json::to_string(&AiProviderPreset::LmStudio).unwrap();
        assert_eq!(lm, "\"lm_studio\"");
        let zai = serde_json::to_string(&AiProviderPreset::ZAi).unwrap();
        assert_eq!(zai, "\"z_ai\"");
        assert_eq!(
            serde_json::from_str::<AiProviderPreset>("\"lm_studio\"").unwrap(),
            AiProviderPreset::LmStudio
        );
    }

    #[test]
    fn provider_base_url_debug_redacts_value() {
        let url = ProviderBaseUrl::new("https://api.openai.com/v1").unwrap();
        assert_eq!(format!("{url:?}"), "ProviderBaseUrl(..)");
    }

    #[test]
    fn restore_clearing_preserves_preferences() {
        let mut ai = AiSettings::default_settings();
        ai.enabled = true;
        ai.provider = Some(AiProviderPreset::OpenAi);
        ai.model = Some(AiModelId::new("gpt-test").unwrap());
        ai.base_url = Some(
            ProviderBaseUrl::for_provider(AiProviderPreset::OpenAi, "https://api.openai.com/v1")
                .unwrap(),
        );
        ai.credential_id = Some(AiCredentialId::new());
        ai.custom_instructions = CustomInstructions::new("be brief").unwrap();
        let cleared = ai.cleared_for_restore();
        assert!(!cleared.enabled);
        assert!(cleared.credential_id.is_none());
        assert_eq!(cleared.provider, Some(AiProviderPreset::OpenAi));
        assert_eq!(cleared.custom_instructions.as_str(), "be brief");
    }

    #[test]
    fn canonical_message_content_fits_serialized_row_bound() {
        let content = AiMessageContent {
            text: "\0".repeat(AI_ASSISTANT_TEXT_BYTES_MAX),
            tool_events: vec![
                AiToolEvent::new(
                    AI_ASSISTANT_TEXT_BYTES_MAX,
                    AiToolEventType::ToolResult,
                    serde_json::json!({
                        "tool": "query_tasks",
                        "outcome": "success",
                        "data": {
                            "value": "x".repeat(AI_TOOL_EVENT_TRANSCRIPT_BYTES_MAX - 256)
                        },
                        "truncated": false
                    }),
                )
                .unwrap(),
            ],
            tool_name: Some("\\".repeat(AI_PROVIDER_ID_BYTES_MAX)),
            tool_arguments_json: Some("\\".repeat(AI_TOOL_ARGUMENTS_BYTES_MAX)),
            tool_result_json: Some("\\".repeat(AI_TOOL_RESULT_BYTES_MAX)),
            briefing_date: Some("9999-12-31".to_owned()),
            focused_task_id: Some(crate::TaskId::new()),
        };
        let canonical = content.canonical_json().unwrap();
        assert!(canonical.len() <= AI_MESSAGE_CONTENT_JSON_BYTES_MAX);
        assert!(AI_MESSAGE_CONTENT_JSON_BYTES_MAX < AI_SESSION_CONTENT_BYTES_MAX as usize);
    }

    #[test]
    fn durable_tool_events_require_ordered_utf8_offsets_and_semantic_payloads() {
        let approval_id = AiApprovalId::new();
        let arguments = r#"{"title":"x"}"#;
        let mut content = AiMessageContent::text("a📅b").unwrap();
        content.tool_events.push(
            AiToolEvent::new(
                1,
                AiToolEventType::ToolProposed,
                serde_json::json!({
                    "approval_id": approval_id.to_string(),
                    "tool": "create_task",
                    "arguments": {"title": "x"},
                    "action_hash": ai_approval_action_hash("create_task", arguments).unwrap(),
                    "expires_at": "2026-04-01T00:00:00Z"
                }),
            )
            .unwrap(),
        );
        content.tool_events.push(
            AiToolEvent::new(
                5,
                AiToolEventType::ToolResult,
                serde_json::json!({
                    "tool": "create_task",
                    "outcome": "success",
                    "data": {"primary": {"kind": "task", "id": crate::TaskId::new()}},
                    "truncated": false
                }),
            )
            .unwrap(),
        );
        assert!(content.validate().is_ok());

        let mut split_utf8 = content.clone();
        split_utf8.tool_events[1].assistant_utf8_offset = 2;
        assert!(split_utf8.validate().is_err());
        let mut out_of_order = content.clone();
        out_of_order.tool_events[1].assistant_utf8_offset = 0;
        assert!(out_of_order.validate().is_err());
        let mut unknown_version = content;
        unknown_version.tool_events[0].version = 2;
        assert!(unknown_version.validate().is_err());
        assert!(
            AiToolEvent::new(0, AiToolEventType::ToolResult, serde_json::json!([1, 2])).is_err()
        );
        assert!(
            AiToolEvent::new(
                0,
                AiToolEventType::ToolApproved,
                serde_json::json!({"approval_id": approval_id, "unknown": true}),
            )
            .is_err()
        );
        assert!(
            AiToolEvent::new(
                0,
                AiToolEventType::ToolResult,
                serde_json::json!({
                    "tool": "create_task",
                    "outcome": "success",
                    "data": {"nested": [{"provider_call_id": "private"}]},
                    "truncated": false
                }),
            )
            .is_err()
        );
    }

    #[test]
    fn memory_and_session_bounds() {
        assert!(
            AiMemory::new(
                AiMemoryId::new(),
                "x".repeat(AI_MEMORY_BYTES_MAX + 1),
                Timestamp::now()
            )
            .is_err()
        );
        assert!(
            AiSession::new(
                AiSessionId::new(),
                "t".repeat(AI_SESSION_TITLE_BYTES_MAX + 1),
                Timestamp::now()
            )
            .is_err()
        );
        assert!(GracePeriodMs::new(499).is_err());
        assert!(GracePeriodMs::new(3001).is_err());
    }
}
