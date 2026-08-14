//! Operator-only AI provider registry, confirmed configuration, credentials, model discovery,
//! and durable session/message/memory resources.
//!
//! Raw credential material is accepted only by the write-only credential request and is
//! transiently resolved through the application/storage worker for endpoint construction.
//! Session message creation remains owned by later run orchestration; this module exposes
//! read/list only for messages.

use std::{fmt, future::Future, sync::Arc};

use axum::{
    Json,
    extract::{
        Extension, Path, Query, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::{HeaderMap, StatusCode},
};
use jiff::Timestamp;
use junban_ai::{
    OriginClass, ProviderCapability, ProviderError, ProviderErrorKind, ProviderPreset,
    SecretString, builtin_providers, descriptor,
};
use junban_app::{
    AiCredentialBindingTarget, AiSecretBytes, AppError, BindAiCredentialRequest,
    ClearAiCredentialRequest, ClearAiSessionRequest, CreateAiMemoryRequest, CreateAiSessionRequest,
    DeleteAiMemoryRequest, DeleteAiSessionRequest, ListAiMemoriesRequest, ListAiMessagesRequest,
    ListAiSessionsRequest, RenameAiSessionRequest, UpdateAiMemoryRequest,
};
use junban_domain::{
    AiCredentialId, AiMemory, AiMemoryId, AiMessage, AiMessageContent, AiModelId, AiProviderPreset,
    AiRunId, AiRunPhase, AiSecretKind, AiSecretMetadata, AiSession, AiSessionId, AiSessionStatus,
    AiSettings, CustomInstructions, GracePeriodMs, ProviderBaseUrl, SettingsPatch,
    SpeechProviderPreset, VoiceMode, VoiceSettings,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::OwnedMutexGuard;
use utoipa::{IntoParams, ToSchema};

use crate::cursor::{
    decode_ai_memory_cursor, decode_ai_session_cursor, encode_ai_memory_cursor,
    encode_ai_session_cursor,
};
use crate::diagnostics::DiagnosticSeverity;
use crate::dto::{CommittedEventDto, MutationResponse};
use crate::error::{
    ApiError, extract_json_with_limit, extract_query, operation_id, parse_path_id, validation_error,
};
use crate::{
    AI_RECONFIGURE_DRAIN_DEADLINE, MAX_AI_CONFIG_BODY_BYTES, MAX_AI_RESPONSE_BODY_BYTES, RequestId,
    ServerState,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AiProviderPresetDto {
    #[serde(rename = "openai")]
    OpenAi,
    Anthropic,
    Gemini,
    #[serde(rename = "openrouter")]
    OpenRouter,
    Ollama,
    LmStudio,
    #[serde(rename = "deepseek")]
    DeepSeek,
    Mistral,
    Kimi,
    #[serde(rename = "dashscope")]
    DashScope,
    Groq,
    ZAi,
    Custom,
}

impl From<AiProviderPreset> for AiProviderPresetDto {
    fn from(value: AiProviderPreset) -> Self {
        match value {
            AiProviderPreset::OpenAi => Self::OpenAi,
            AiProviderPreset::Anthropic => Self::Anthropic,
            AiProviderPreset::Gemini => Self::Gemini,
            AiProviderPreset::OpenRouter => Self::OpenRouter,
            AiProviderPreset::Ollama => Self::Ollama,
            AiProviderPreset::LmStudio => Self::LmStudio,
            AiProviderPreset::DeepSeek => Self::DeepSeek,
            AiProviderPreset::Mistral => Self::Mistral,
            AiProviderPreset::Kimi => Self::Kimi,
            AiProviderPreset::DashScope => Self::DashScope,
            AiProviderPreset::Groq => Self::Groq,
            AiProviderPreset::ZAi => Self::ZAi,
            AiProviderPreset::Custom => Self::Custom,
        }
    }
}

impl From<AiProviderPresetDto> for AiProviderPreset {
    fn from(value: AiProviderPresetDto) -> Self {
        match value {
            AiProviderPresetDto::OpenAi => Self::OpenAi,
            AiProviderPresetDto::Anthropic => Self::Anthropic,
            AiProviderPresetDto::Gemini => Self::Gemini,
            AiProviderPresetDto::OpenRouter => Self::OpenRouter,
            AiProviderPresetDto::Ollama => Self::Ollama,
            AiProviderPresetDto::LmStudio => Self::LmStudio,
            AiProviderPresetDto::DeepSeek => Self::DeepSeek,
            AiProviderPresetDto::Mistral => Self::Mistral,
            AiProviderPresetDto::Kimi => Self::Kimi,
            AiProviderPresetDto::DashScope => Self::DashScope,
            AiProviderPresetDto::Groq => Self::Groq,
            AiProviderPresetDto::ZAi => Self::ZAi,
            AiProviderPresetDto::Custom => Self::Custom,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpeechProviderPresetDto {
    Browser,
    #[serde(rename = "openai")]
    OpenAi,
    Groq,
    Inworld,
}

impl From<SpeechProviderPreset> for SpeechProviderPresetDto {
    fn from(value: SpeechProviderPreset) -> Self {
        match value {
            SpeechProviderPreset::Browser => Self::Browser,
            SpeechProviderPreset::OpenAi => Self::OpenAi,
            SpeechProviderPreset::Groq => Self::Groq,
            SpeechProviderPreset::Inworld => Self::Inworld,
        }
    }
}

impl From<SpeechProviderPresetDto> for SpeechProviderPreset {
    fn from(value: SpeechProviderPresetDto) -> Self {
        match value {
            SpeechProviderPresetDto::Browser => Self::Browser,
            SpeechProviderPresetDto::OpenAi => Self::OpenAi,
            SpeechProviderPresetDto::Groq => Self::Groq,
            SpeechProviderPresetDto::Inworld => Self::Inworld,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum VoiceModeDto {
    PushToTalk,
    HandsFree,
}

impl From<VoiceMode> for VoiceModeDto {
    fn from(value: VoiceMode) -> Self {
        match value {
            VoiceMode::PushToTalk => Self::PushToTalk,
            VoiceMode::HandsFree => Self::HandsFree,
        }
    }
}

impl From<VoiceModeDto> for VoiceMode {
    fn from(value: VoiceModeDto) -> Self {
        match value {
            VoiceModeDto::PushToTalk => Self::PushToTalk,
            VoiceModeDto::HandsFree => Self::HandsFree,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AiSecretKindDto {
    ApiKey,
    Bearer,
    InworldBasic,
    InworldJwt,
}

impl From<AiSecretKind> for AiSecretKindDto {
    fn from(value: AiSecretKind) -> Self {
        match value {
            AiSecretKind::ApiKey => Self::ApiKey,
            AiSecretKind::Bearer => Self::Bearer,
            AiSecretKind::InworldBasic => Self::InworldBasic,
            AiSecretKind::InworldJwt => Self::InworldJwt,
        }
    }
}

impl From<AiSecretKindDto> for AiSecretKind {
    fn from(value: AiSecretKindDto) -> Self {
        match value {
            AiSecretKindDto::ApiKey => Self::ApiKey,
            AiSecretKindDto::Bearer => Self::Bearer,
            AiSecretKindDto::InworldBasic => Self::InworldBasic,
            AiSecretKindDto::InworldJwt => Self::InworldJwt,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AiCredentialTargetDto {
    AiProvider,
    VoiceStt,
    VoiceTts,
}

impl AiCredentialTargetDto {
    fn parse(value: &str, request_id: &RequestId) -> Result<Self, ApiError> {
        match value {
            "ai_provider" => Ok(Self::AiProvider),
            "voice_stt" => Ok(Self::VoiceStt),
            "voice_tts" => Ok(Self::VoiceTts),
            _ => Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "AI credential target was not found",
                false,
                request_id,
            )),
        }
    }
}

impl From<AiCredentialTargetDto> for AiCredentialBindingTarget {
    fn from(value: AiCredentialTargetDto) -> Self {
        match value {
            AiCredentialTargetDto::AiProvider => Self::AiProvider,
            AiCredentialTargetDto::VoiceStt => Self::VoiceStt,
            AiCredentialTargetDto::VoiceTts => Self::VoiceTts,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderOriginClassDto {
    FixedCloudHttps,
    Loopback,
    OperatorCustom,
}

impl From<OriginClass> for ProviderOriginClassDto {
    fn from(value: OriginClass) -> Self {
        match value {
            OriginClass::FixedCloudHttps => Self::FixedCloudHttps,
            OriginClass::Loopback => Self::Loopback,
            OriginClass::OperatorCustom => Self::OperatorCustom,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCapabilityDto {
    ChatStreaming,
    ChatCompletion,
    Tools,
    StreamingTools,
    Vision,
    ReasoningStatus,
    ModelDiscovery,
}

impl From<ProviderCapability> for ProviderCapabilityDto {
    fn from(value: ProviderCapability) -> Self {
        match value {
            ProviderCapability::ChatStreaming => Self::ChatStreaming,
            ProviderCapability::ChatCompletion => Self::ChatCompletion,
            ProviderCapability::Tools => Self::Tools,
            ProviderCapability::StreamingTools => Self::StreamingTools,
            ProviderCapability::Vision => Self::Vision,
            ProviderCapability::ReasoningStatus => Self::ReasoningStatus,
            ProviderCapability::ModelDiscovery => Self::ModelDiscovery,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AiProviderRegistryEntry {
    pub id: AiProviderPresetDto,
    pub display_name: String,
    pub default_base_url: Option<String>,
    pub origin_class: ProviderOriginClassDto,
    pub auth_scheme: String,
    pub credential_required: bool,
    pub capabilities: Vec<ProviderCapabilityDto>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AiProviderRegistryResponse {
    pub providers: Vec<AiProviderRegistryEntry>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AiSettingsDto {
    pub enabled: bool,
    pub provider: Option<AiProviderPresetDto>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    pub credential_id: Option<String>,
    pub custom_instructions: String,
    pub daily_briefing_enabled: bool,
    pub default_energy: Option<u8>,
    pub auto_send: bool,
    pub smart_endpoint: bool,
}

impl From<&AiSettings> for AiSettingsDto {
    fn from(value: &AiSettings) -> Self {
        Self {
            enabled: value.enabled,
            provider: value.provider.map(Into::into),
            model: value.model.as_ref().map(ToString::to_string),
            base_url: value.base_url.as_ref().map(ToString::to_string),
            credential_id: value.credential_id.map(|id| id.to_string()),
            custom_instructions: value.custom_instructions.as_str().to_owned(),
            daily_briefing_enabled: value.daily_briefing_enabled,
            default_energy: value.default_energy,
            auto_send: value.auto_send,
            smart_endpoint: value.smart_endpoint,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct VoiceSettingsDto {
    pub cloud_speech_enabled: bool,
    pub stt_provider: SpeechProviderPresetDto,
    pub stt_model: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    pub stt_credential_id: Option<String>,
    pub tts_provider: SpeechProviderPresetDto,
    pub tts_model: Option<String>,
    pub tts_voice: Option<String>,
    #[schema(value_type = Option<String>, format = Uuid, nullable = true)]
    pub tts_credential_id: Option<String>,
    pub tts_enabled: bool,
    pub voice_mode: VoiceModeDto,
    pub grace_period_ms: u32,
}

impl From<&VoiceSettings> for VoiceSettingsDto {
    fn from(value: &VoiceSettings) -> Self {
        Self {
            cloud_speech_enabled: value.cloud_speech_enabled,
            stt_provider: value.stt_provider.into(),
            stt_model: value.stt_model.as_ref().map(ToString::to_string),
            stt_credential_id: value.stt_credential_id.map(|id| id.to_string()),
            tts_provider: value.tts_provider.into(),
            tts_model: value.tts_model.as_ref().map(ToString::to_string),
            tts_voice: value.tts_voice.clone(),
            tts_credential_id: value.tts_credential_id.map(|id| id.to_string()),
            tts_enabled: value.tts_enabled,
            voice_mode: value.voice_mode.into(),
            grace_period_ms: value.grace_period_ms.get(),
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AiCredentialMetadataDto {
    #[schema(value_type = String, format = Uuid)]
    pub id: String,
    pub kind: AiSecretKindDto,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
    pub present: bool,
}

impl From<AiSecretMetadata> for AiCredentialMetadataDto {
    fn from(value: AiSecretMetadata) -> Self {
        Self {
            id: value.id.to_string(),
            kind: value.kind.into(),
            updated_at: value.updated_at,
            present: value.present,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AiCredentialBindingsDto {
    pub ai_provider: Option<AiCredentialMetadataDto>,
    pub voice_stt: Option<AiCredentialMetadataDto>,
    pub voice_tts: Option<AiCredentialMetadataDto>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AiConfigResponse {
    pub ai: AiSettingsDto,
    pub voice: VoiceSettingsDto,
    pub credentials: AiCredentialBindingsDto,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AiConfigPutRequest {
    pub ai: AiConfigInput,
    pub voice: VoiceConfigInput,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AiConfigInput {
    pub enabled: bool,
    pub provider: Option<AiProviderPresetDto>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub custom_instructions: String,
    pub daily_briefing_enabled: bool,
    pub default_energy: Option<u8>,
    pub auto_send: bool,
    pub smart_endpoint: bool,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct VoiceConfigInput {
    pub cloud_speech_enabled: bool,
    pub stt_provider: SpeechProviderPresetDto,
    pub stt_model: Option<String>,
    pub tts_provider: SpeechProviderPresetDto,
    pub tts_model: Option<String>,
    pub tts_voice: Option<String>,
    pub tts_enabled: bool,
    pub voice_mode: VoiceModeDto,
    pub grace_period_ms: u32,
}

impl AiConfigPutRequest {
    fn into_patch(
        self,
        current_ai: &AiSettings,
        current_voice: &VoiceSettings,
        request_id: &RequestId,
    ) -> Result<SettingsPatch, ApiError> {
        let provider = self.ai.provider.map(Into::into);
        let base_url = match (provider, self.ai.base_url) {
            (Some(provider), Some(url)) => Some(
                ProviderBaseUrl::for_provider(provider, url)
                    .map_err(|error| validation_error(error, request_id))?,
            ),
            (Some(provider), None) => provider
                .official_base_url()
                .map(|url| ProviderBaseUrl::for_provider(provider, url))
                .transpose()
                .map_err(|error| validation_error(error, request_id))?,
            (None, Some(_)) => {
                return Err(validation_error(
                    junban_domain::ValidationError::Invalid {
                        field: "ai.base_url",
                        reason: "base URL requires a selected provider",
                    },
                    request_id,
                ));
            }
            (None, None) => None,
        };
        if current_ai.credential_id.is_some() {
            if provider != current_ai.provider {
                return Err(authority_change_requires_credential_delete(
                    "ai.provider",
                    request_id,
                ));
            }
            if base_url != current_ai.base_url {
                return Err(authority_change_requires_credential_delete(
                    "ai.base_url",
                    request_id,
                ));
            }
        }
        let stt_provider = self.voice.stt_provider.into();
        if current_voice.stt_credential_id.is_some() && stt_provider != current_voice.stt_provider {
            return Err(authority_change_requires_credential_delete(
                "voice.stt_provider",
                request_id,
            ));
        }
        let tts_provider = self.voice.tts_provider.into();
        if current_voice.tts_credential_id.is_some() && tts_provider != current_voice.tts_provider {
            return Err(authority_change_requires_credential_delete(
                "voice.tts_provider",
                request_id,
            ));
        }

        let ai = AiSettings {
            enabled: self.ai.enabled,
            provider,
            model: self
                .ai
                .model
                .map(AiModelId::new)
                .transpose()
                .map_err(|error| validation_error(error, request_id))?,
            base_url,
            credential_id: current_ai.credential_id,
            custom_instructions: CustomInstructions::new(self.ai.custom_instructions)
                .map_err(|error| validation_error(error, request_id))?,
            daily_briefing_enabled: self.ai.daily_briefing_enabled,
            default_energy: self.ai.default_energy,
            auto_send: self.ai.auto_send,
            smart_endpoint: self.ai.smart_endpoint,
        };
        let voice = VoiceSettings {
            cloud_speech_enabled: self.voice.cloud_speech_enabled,
            stt_provider,
            stt_model: self
                .voice
                .stt_model
                .map(AiModelId::new)
                .transpose()
                .map_err(|error| validation_error(error, request_id))?,
            stt_credential_id: current_voice.stt_credential_id,
            tts_provider,
            tts_model: self
                .voice
                .tts_model
                .map(AiModelId::new)
                .transpose()
                .map_err(|error| validation_error(error, request_id))?,
            tts_voice: self.voice.tts_voice,
            tts_credential_id: current_voice.tts_credential_id,
            tts_enabled: self.voice.tts_enabled,
            voice_mode: self.voice.voice_mode.into(),
            grace_period_ms: GracePeriodMs::new(self.voice.grace_period_ms)
                .map_err(|error| validation_error(error, request_id))?,
        };
        let patch = SettingsPatch {
            ai: Some(ai),
            voice: Some(voice),
            ..SettingsPatch::default()
        };
        patch
            .validate()
            .map_err(|error| validation_error(error, request_id))?;
        Ok(patch)
    }
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PutAiCredentialRequest {
    pub kind: AiSecretKindDto,
    #[schema(write_only, max_length = 8192)]
    pub secret: String,
}

impl fmt::Debug for PutAiCredentialRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PutAiCredentialRequest")
            .field("kind", &self.kind)
            .field("secret", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AiCredentialBindingResponse {
    pub target: AiCredentialTargetDto,
    pub credential: Option<AiCredentialMetadataDto>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DiscoveredModelDto {
    pub id: String,
    pub display_name: Option<String>,
    pub capabilities: Vec<ProviderCapabilityDto>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ModelDiscoveryResponse {
    pub provider: AiProviderPresetDto,
    pub models: Vec<DiscoveredModelDto>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateAiResponseRequest {
    pub message: String,
    #[schema(value_type = Option<String>, format = Uuid)]
    pub focused_task_id: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CancelAiRunResponse {
    #[schema(value_type = String, format = Uuid)]
    pub run_id: String,
    pub status: String,
}

#[utoipa::path(
    get,
    path = "/api/v1/ai/providers",
    operation_id = "list_ai_providers",
    responses(
        (status = 200, body = AiProviderRegistryResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn list_ai_providers() -> Json<AiProviderRegistryResponse> {
    Json(AiProviderRegistryResponse {
        providers: builtin_providers()
            .iter()
            .map(|entry| AiProviderRegistryEntry {
                id: entry.preset.into(),
                display_name: entry.preset.display_name().to_owned(),
                default_base_url: (!entry.default_base_url.is_empty())
                    .then(|| entry.default_base_url.to_owned()),
                origin_class: entry.origin_class.into(),
                auth_scheme: entry.auth.as_str().to_owned(),
                credential_required: entry.auth.requires_credential(),
                capabilities: entry.capabilities.iter().map(Into::into).collect(),
            })
            .collect(),
    })
}

#[utoipa::path(
    get,
    path = "/api/v1/ai/config",
    operation_id = "get_ai_config",
    responses(
        (status = 200, body = AiConfigResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn get_ai_config(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
) -> Result<Json<AiConfigResponse>, ApiError> {
    let _serial = state.ai_reconfigure.lock().await;
    load_config_response(&state, &request_id).await.map(Json)
}

#[utoipa::path(
    put,
    path = "/api/v1/ai/config",
    operation_id = "put_ai_config",
    request_body = AiConfigPutRequest,
    responses(
        (status = 200, body = AiConfigResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    params(("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")),
    security(("bearer_auth" = []))
)]
pub async fn put_ai_config(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
    payload: Result<Json<AiConfigPutRequest>, JsonRejection>,
) -> Result<Json<AiConfigResponse>, ApiError> {
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json_with_limit(payload, &request_id, MAX_AI_CONFIG_BODY_BYTES)?;
    let serial = Arc::clone(&state.ai_reconfigure).lock_owned().await;
    let current = state
        .service
        .get_settings()
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let patch = payload.into_patch(&current.ai, &current.voice, &request_id)?;
    let commit_state = state.clone();
    let commit_request_id = request_id.clone();
    reconfigure_owned(&state, &request_id, serial, async move {
        commit_state
            .service
            .patch_settings(operation_id, patch)
            .await
            .map_err(|error| ApiError::from_app(error, &commit_request_id))?;
        load_config_response(&commit_state, &commit_request_id).await
    })
    .await
    .map(Json)
}

#[utoipa::path(
    delete,
    path = "/api/v1/ai/config",
    operation_id = "delete_ai_config",
    responses(
        (status = 200, body = AiConfigResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    params(("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")),
    security(("bearer_auth" = []))
)]
pub async fn delete_ai_config(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
) -> Result<Json<AiConfigResponse>, ApiError> {
    let operation_id = operation_id(&headers, &request_id)?;
    let serial = Arc::clone(&state.ai_reconfigure).lock_owned().await;
    let current = state
        .service
        .get_settings()
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let mut ai = AiSettings::default_settings();
    ai.credential_id = current.ai.credential_id;
    if current.ai.credential_id.is_some()
        && (ai.provider != current.ai.provider || ai.base_url != current.ai.base_url)
    {
        return Err(authority_change_requires_credential_delete(
            "ai.provider",
            &request_id,
        ));
    }
    ai.validate()
        .map_err(|error| validation_error(error, &request_id))?;
    let patch = SettingsPatch {
        ai: Some(ai),
        ..SettingsPatch::default()
    };
    patch
        .validate()
        .map_err(|error| validation_error(error, &request_id))?;
    let commit_state = state.clone();
    let commit_request_id = request_id.clone();
    reconfigure_owned(&state, &request_id, serial, async move {
        commit_state
            .service
            .patch_settings(operation_id, patch)
            .await
            .map_err(|error| ApiError::from_app(error, &commit_request_id))?;
        load_config_response(&commit_state, &commit_request_id).await
    })
    .await
    .map(Json)
}

#[utoipa::path(
    put,
    path = "/api/v1/ai/credentials/{target}",
    operation_id = "put_ai_credential",
    request_body = PutAiCredentialRequest,
    responses(
        (status = 200, body = AiCredentialBindingResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    params(
        ("target" = AiCredentialTargetDto, Path, description = "credential binding target"),
        ("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")
    ),
    security(("bearer_auth" = []))
)]
pub async fn put_ai_credential(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(target): Path<String>,
    headers: HeaderMap,
    payload: Result<Json<PutAiCredentialRequest>, JsonRejection>,
) -> Result<Json<AiCredentialBindingResponse>, ApiError> {
    let target = AiCredentialTargetDto::parse(&target, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json_with_limit(payload, &request_id, MAX_AI_CONFIG_BODY_BYTES)?;
    let secret =
        AiSecretBytes::new(payload.secret).map_err(|error| validation_error(error, &request_id))?;
    let kind = payload.kind.into();
    let serial = Arc::clone(&state.ai_reconfigure).lock_owned().await;
    let current = state
        .service
        .get_settings()
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    validate_credential_authority(target, kind, &current.ai, &current.voice, &request_id)?;
    let commit_state = state.clone();
    let commit_request_id = request_id.clone();
    reconfigure_owned(&state, &request_id, serial, async move {
        let result = commit_state
            .service
            .bind_ai_credential(
                operation_id,
                BindAiCredentialRequest {
                    target: target.into(),
                    kind,
                    secret: Some(secret),
                },
            )
            .await
            .map_err(|error| ApiError::from_app(error, &commit_request_id))?;
        let credential = result.credential_id.ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "credential_unavailable",
                "confirmed credential metadata is unavailable",
                true,
                &commit_request_id,
            )
        })?;
        let metadata = commit_state
            .service
            .list_ai_secret_metadata()
            .await
            .map_err(|error| ApiError::from_app(error, &commit_request_id))?;
        let credential = metadata
            .into_iter()
            .find(|entry| entry.id == credential)
            .ok_or_else(|| stale_credential(&commit_request_id))?;
        Ok(AiCredentialBindingResponse {
            target,
            credential: Some(credential.into()),
        })
    })
    .await
    .map(Json)
}

#[utoipa::path(
    delete,
    path = "/api/v1/ai/credentials/{target}",
    operation_id = "delete_ai_credential",
    responses(
        (status = 200, body = AiCredentialBindingResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    params(
        ("target" = AiCredentialTargetDto, Path, description = "credential binding target"),
        ("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")
    ),
    security(("bearer_auth" = []))
)]
pub async fn delete_ai_credential(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(target): Path<String>,
    headers: HeaderMap,
) -> Result<Json<AiCredentialBindingResponse>, ApiError> {
    let target = AiCredentialTargetDto::parse(&target, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let serial = Arc::clone(&state.ai_reconfigure).lock_owned().await;
    let commit_state = state.clone();
    let commit_request_id = request_id.clone();
    reconfigure_owned(&state, &request_id, serial, async move {
        commit_state
            .service
            .clear_ai_credential(
                operation_id,
                ClearAiCredentialRequest {
                    target: target.into(),
                },
            )
            .await
            .map_err(|error| ApiError::from_app(error, &commit_request_id))?;
        Ok(AiCredentialBindingResponse {
            target,
            credential: None,
        })
    })
    .await
    .map(Json)
}

#[utoipa::path(
    get,
    path = "/api/v1/ai/providers/{provider}/models",
    operation_id = "discover_ai_provider_models",
    responses(
        (status = 200, body = ModelDiscoveryResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    params(("provider" = AiProviderPresetDto, Path, description = "canonical provider id")),
    security(("bearer_auth" = []))
)]
pub async fn discover_ai_provider_models(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(provider): Path<String>,
) -> Result<Json<ModelDiscoveryResponse>, ApiError> {
    let preset = ProviderPreset::parse(&provider)
        .ok()
        .filter(|preset| preset.as_str() == provider)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "provider_not_found",
                "AI provider was not found",
                false,
                &request_id,
            )
        })?;
    let serial = state.ai_reconfigure.lock().await;
    let settings = state
        .service
        .get_settings()
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    if settings.ai.provider != Some(preset) || !settings.ai.enabled {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "provider_not_configured",
            "requested provider is not the confirmed enabled provider",
            false,
            &request_id,
        ));
    }
    let base_url = settings.ai.base_url.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "provider_not_configured",
            "confirmed provider base URL is unavailable",
            false,
            &request_id,
        )
    })?;
    let descriptor = descriptor(preset);
    let credential = match settings.ai.credential_id {
        Some(id) => Some(state.service.resolve_ai_secret(id).await.map_err(
            |error| match error {
                AppError::NotFound => stale_credential(&request_id),
                other => ApiError::from_app(other, &request_id),
            },
        )?),
        None => None,
    };
    let endpoint = junban_ai::ProviderEndpoint::resolve(
        descriptor,
        Some(base_url.as_str()),
        credential.map(|secret| SecretString::new(secret.expose())),
    )
    .map_err(|error| provider_error(error, &request_id))?;
    let guard = state
        .ai_runtime()
        .admit_run(junban_domain::AiRunId::new(), 1)
        .map_err(|error| runtime_error(error, &request_id))?;
    // Admission and confirmed endpoint resolution are serialized with reconfiguration;
    // provider I/O is not, so a later mutation can cancel and drain this guard.
    drop(serial);
    let models = guard
        .discover_models(&endpoint)
        .await
        .map_err(|error| provider_error(error, &request_id))?;
    Ok(Json(ModelDiscoveryResponse {
        provider: preset.into(),
        models: models
            .into_iter()
            .map(|model| DiscoveredModelDto {
                id: model.id.to_string(),
                display_name: model.display_name,
                capabilities: model.capabilities.iter().map(Into::into).collect(),
            })
            .collect(),
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/ai/sessions/{session_id}/responses",
    operation_id = "create_ai_response",
    request_body = CreateAiResponseRequest,
    params(
        ("session_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")
    ),
    responses(
        (status = 200, content_type = "text/event-stream", body = crate::ai_chat::AiRunSseEnvelope),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn create_ai_response(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    payload: Result<Json<CreateAiResponseRequest>, JsonRejection>,
) -> Result<crate::ai_chat::AiSse, ApiError> {
    let session_id = parse_path_id(&session_id, AiSessionId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json_with_limit(payload, &request_id, MAX_AI_RESPONSE_BODY_BYTES)?;
    let permit = state.try_acquire_sse().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "sse_connection_limit",
            "too many concurrent event streams",
            true,
            &request_id,
        )
    })?;
    let serial = Arc::clone(&state.ai_reconfigure).lock_owned().await;
    crate::ai_chat::start_response(
        state.clone(),
        &request_id,
        session_id,
        operation_id,
        payload,
        permit,
        serial,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/v1/ai/runs/{run_id}/cancel",
    operation_id = "cancel_ai_run",
    params(("run_id" = String, Path, format = Uuid)),
    responses(
        (status = 200, body = CancelAiRunResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn cancel_ai_run(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(run_id): Path<String>,
) -> Result<Json<CancelAiRunResponse>, ApiError> {
    let run_id = parse_path_id(&run_id, AiRunId::parse, &request_id)?;
    let status = match state.ai_runtime().cancel_run(run_id) {
        Ok(()) => "cancel_requested",
        Err(crate::AiRuntimeError::Terminal) => "already_terminal",
        Err(crate::AiRuntimeError::NotFound) => {
            match state.service.get_ai_run_state(run_id).await {
                Ok(run)
                    if matches!(
                        run.state,
                        AiRunPhase::Completed | AiRunPhase::Cancelled | AiRunPhase::Failed
                    ) =>
                {
                    "already_terminal"
                }
                Ok(_) | Err(AppError::NotFound) => {
                    return Err(ApiError::new(
                        StatusCode::NOT_FOUND,
                        "ai_run_not_found",
                        "AI run was not found",
                        false,
                        &request_id,
                    ));
                }
                Err(error) => return Err(ApiError::from_app(error, &request_id)),
            }
        }
        Err(_) => {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "ai_runtime_unavailable",
                "AI runtime cancellation is unavailable",
                true,
                &request_id,
            ));
        }
    };
    Ok(Json(CancelAiRunResponse {
        run_id: run_id.to_string(),
        status: status.to_owned(),
    }))
}

// ── Durable sessions / messages / memories ─────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AiSessionStatusDto {
    Active,
    Archived,
}

impl From<AiSessionStatus> for AiSessionStatusDto {
    fn from(value: AiSessionStatus) -> Self {
        match value {
            AiSessionStatus::Active => Self::Active,
            AiSessionStatus::Archived => Self::Archived,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AiSessionDto {
    #[schema(value_type = String, format = Uuid)]
    pub id: String,
    pub title: String,
    pub status: AiSessionStatusDto,
    pub message_count: u32,
    pub content_bytes: u64,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
    #[schema(value_type = Option<String>, format = DateTime, nullable = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<Timestamp>,
}

impl From<AiSession> for AiSessionDto {
    fn from(value: AiSession) -> Self {
        Self {
            id: value.id.to_string(),
            title: value.title,
            status: value.status.into(),
            message_count: value.message_count,
            content_bytes: value.content_bytes,
            created_at: value.created_at,
            updated_at: value.updated_at,
            last_message_at: value.last_message_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AiMemoryDto {
    #[schema(value_type = String, format = Uuid)]
    pub id: String,
    pub content: String,
    pub content_bytes: u64,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
}

impl From<AiMemory> for AiMemoryDto {
    fn from(value: AiMemory) -> Self {
        Self {
            id: value.id.to_string(),
            content: value.content,
            content_bytes: value.content_bytes,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AiMessageRoleDto {
    User,
    Assistant,
    System,
    Tool,
}

impl From<junban_domain::AiMessageRole> for AiMessageRoleDto {
    fn from(value: junban_domain::AiMessageRole) -> Self {
        match value {
            junban_domain::AiMessageRole::User => Self::User,
            junban_domain::AiMessageRole::Assistant => Self::Assistant,
            junban_domain::AiMessageRole::System => Self::System,
            junban_domain::AiMessageRole::Tool => Self::Tool,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AiMessageStatusDto {
    Pending,
    Streaming,
    Completed,
    Failed,
    Cancelled,
}

impl From<junban_domain::AiMessageStatus> for AiMessageStatusDto {
    fn from(value: junban_domain::AiMessageStatus) -> Self {
        match value {
            junban_domain::AiMessageStatus::Pending => Self::Pending,
            junban_domain::AiMessageStatus::Streaming => Self::Streaming,
            junban_domain::AiMessageStatus::Completed => Self::Completed,
            junban_domain::AiMessageStatus::Failed => Self::Failed,
            junban_domain::AiMessageStatus::Cancelled => Self::Cancelled,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AiToolEventDto {
    pub version: u8,
    pub assistant_utf8_offset: u32,
    pub event_type: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AiMessageContentDto {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_events: Vec<AiToolEventDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_arguments_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_result_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub briefing_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<String>, format = Uuid)]
    pub focused_task_id: Option<String>,
}

impl From<AiMessageContent> for AiMessageContentDto {
    fn from(value: AiMessageContent) -> Self {
        Self {
            text: value.text,
            tool_events: value
                .tool_events
                .into_iter()
                .map(|event| AiToolEventDto {
                    version: event.version,
                    assistant_utf8_offset: event.assistant_utf8_offset,
                    event_type: event.event_type.as_str().to_owned(),
                    payload: event.payload,
                })
                .collect(),
            tool_name: value.tool_name,
            tool_arguments_json: value.tool_arguments_json,
            tool_result_json: value.tool_result_json,
            briefing_date: value.briefing_date,
            focused_task_id: value.focused_task_id.map(|id| id.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AiMessageDto {
    #[schema(value_type = String, format = Uuid)]
    pub id: String,
    #[schema(value_type = String, format = Uuid)]
    pub session_id: String,
    #[schema(value_type = String, format = Uuid)]
    pub turn_id: String,
    pub sequence: u32,
    pub role: AiMessageRoleDto,
    pub status: AiMessageStatusDto,
    pub content: AiMessageContentDto,
    pub content_bytes: u64,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
}

impl From<AiMessage> for AiMessageDto {
    fn from(value: AiMessage) -> Self {
        Self {
            id: value.id.to_string(),
            session_id: value.session_id.to_string(),
            turn_id: value.turn_id.to_string(),
            sequence: value.sequence,
            role: value.role.into(),
            status: value.status.into(),
            content: value.content.into(),
            content_bytes: value.content_bytes,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateAiSessionHttpRequest {
    pub title: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PatchAiSessionRequest {
    pub title: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateAiMemoryHttpRequest {
    pub content: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PatchAiMemoryRequest {
    pub content: String,
}

#[derive(Debug, Default, Deserialize, IntoParams)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct ListAiSessionsQuery {
    pub cursor: Option<String>,
    /// Page size in `1..=100`. Defaults to 100 when omitted.
    #[param(minimum = 1, maximum = 100)]
    pub limit: Option<u32>,
}

#[derive(Debug, Default, Deserialize, IntoParams)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct ListAiMessagesQuery {
    /// Return messages with `sequence` strictly greater than this value.
    pub after_sequence: Option<u32>,
    /// Page size in `1..=100`. Defaults to 100 when omitted.
    #[param(minimum = 1, maximum = 100)]
    pub limit: Option<u32>,
}

#[derive(Debug, Default, Deserialize, IntoParams)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct ListAiMemoriesQuery {
    pub cursor: Option<String>,
    /// Page size in `1..=100`. Defaults to 100 when omitted.
    #[param(minimum = 1, maximum = 100)]
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AiSessionListResponse {
    pub sessions: Vec<AiSessionDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AiMessageListResponse {
    pub messages: Vec<AiMessageDto>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AiMemoryListResponse {
    pub memories: Vec<AiMemoryDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// Create/rename/clear responses carry the canonical resource plus the committed event.
#[derive(Debug, Serialize, ToSchema)]
pub struct AiSessionMutationResponse {
    pub session: AiSessionDto,
    pub event: CommittedEventDto,
}

/// Create/update memory responses carry the canonical resource plus the committed event.
#[derive(Debug, Serialize, ToSchema)]
pub struct AiMemoryMutationResponse {
    pub memory: AiMemoryDto,
    pub event: CommittedEventDto,
}

#[utoipa::path(
    get,
    path = "/api/v1/ai/sessions",
    operation_id = "list_ai_sessions",
    params(ListAiSessionsQuery),
    responses(
        (status = 200, body = AiSessionListResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn list_ai_sessions(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    query: Result<Query<ListAiSessionsQuery>, QueryRejection>,
) -> Result<Json<AiSessionListResponse>, ApiError> {
    let params = extract_query(query, &request_id)?;
    let _serial = state.ai_reconfigure.lock().await;
    let cursor = params
        .cursor
        .as_deref()
        .map(|raw| decode_ai_session_cursor(raw, &request_id))
        .transpose()?;
    let page = state
        .service
        .list_ai_sessions(ListAiSessionsRequest {
            cursor,
            limit: params.limit,
        })
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let next_cursor = page
        .next_cursor
        .as_ref()
        .map(encode_ai_session_cursor)
        .transpose()
        .map_err(|error| validation_error(error, &request_id))?;
    Ok(Json(AiSessionListResponse {
        sessions: page.sessions.into_iter().map(Into::into).collect(),
        next_cursor,
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/ai/sessions",
    operation_id = "create_ai_session",
    request_body = CreateAiSessionHttpRequest,
    params(("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")),
    responses(
        (status = 201, body = AiSessionMutationResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn create_ai_session(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
    payload: Result<Json<CreateAiSessionHttpRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<AiSessionMutationResponse>), ApiError> {
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json_with_limit(payload, &request_id, MAX_AI_CONFIG_BODY_BYTES)?;
    // Hold the reconfigure serialize permit through commit + canonical fetch so a concurrent
    // delete cannot make a committed create appear as 404. No runtime drain on create.
    let _serial = state.ai_reconfigure.lock().await;
    let mutation = state
        .service
        .create_ai_session(
            operation_id,
            CreateAiSessionRequest {
                title: payload.title,
            },
        )
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    #[cfg(test)]
    state.ai_reconfigure_test_gate.pause_after_commit().await;
    let response = session_mutation_response(&state, mutation, &request_id).await?;
    Ok((StatusCode::CREATED, Json(response)))
}

#[utoipa::path(
    get,
    path = "/api/v1/ai/sessions/{session_id}",
    operation_id = "get_ai_session",
    params(("session_id" = String, Path, format = Uuid)),
    responses(
        (status = 200, body = AiSessionDto),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn get_ai_session(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(session_id): Path<String>,
) -> Result<Json<AiSessionDto>, ApiError> {
    let session_id = parse_path_id(&session_id, AiSessionId::parse, &request_id)?;
    let _serial = state.ai_reconfigure.lock().await;
    let session = state
        .service
        .get_ai_session(session_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(session.into()))
}

#[utoipa::path(
    patch,
    path = "/api/v1/ai/sessions/{session_id}",
    operation_id = "patch_ai_session",
    request_body = PatchAiSessionRequest,
    params(
        ("session_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")
    ),
    responses(
        (status = 200, body = AiSessionMutationResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn patch_ai_session(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    payload: Result<Json<PatchAiSessionRequest>, JsonRejection>,
) -> Result<Json<AiSessionMutationResponse>, ApiError> {
    let session_id = parse_path_id(&session_id, AiSessionId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json_with_limit(payload, &request_id, MAX_AI_CONFIG_BODY_BYTES)?;
    // Hold the reconfigure serialize permit through commit + canonical fetch so a concurrent
    // delete cannot make a committed rename appear as 404. No runtime drain on rename.
    let _serial = state.ai_reconfigure.lock().await;
    let mutation = state
        .service
        .rename_ai_session(
            operation_id,
            RenameAiSessionRequest {
                session_id,
                title: payload.title,
            },
        )
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    #[cfg(test)]
    state.ai_reconfigure_test_gate.pause_after_commit().await;
    Ok(Json(
        session_mutation_response(&state, mutation, &request_id).await?,
    ))
}

#[utoipa::path(
    delete,
    path = "/api/v1/ai/sessions/{session_id}",
    operation_id = "delete_ai_session",
    params(
        ("session_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")
    ),
    responses(
        (status = 200, body = MutationResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn delete_ai_session(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<MutationResponse>, ApiError> {
    let session_id = parse_path_id(&session_id, AiSessionId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let serial = Arc::clone(&state.ai_reconfigure).lock_owned().await;
    let commit_state = state.clone();
    let commit_request_id = request_id.clone();
    reconfigure_owned(&state, &request_id, serial, async move {
        let mutation = commit_state
            .service
            .delete_ai_session(operation_id, DeleteAiSessionRequest { session_id })
            .await
            .map_err(|error| ApiError::from_app(error, &commit_request_id))?;
        Ok(MutationResponse::from(mutation))
    })
    .await
    .map(Json)
}

#[utoipa::path(
    get,
    path = "/api/v1/ai/sessions/{session_id}/messages",
    operation_id = "list_ai_messages",
    params(
        ("session_id" = String, Path, format = Uuid),
        ListAiMessagesQuery
    ),
    responses(
        (status = 200, body = AiMessageListResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn list_ai_messages(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(session_id): Path<String>,
    query: Result<Query<ListAiMessagesQuery>, QueryRejection>,
) -> Result<Json<AiMessageListResponse>, ApiError> {
    let params = extract_query(query, &request_id)?;
    let session_id = parse_path_id(&session_id, AiSessionId::parse, &request_id)?;
    let _serial = state.ai_reconfigure.lock().await;
    // Fail closed on unknown sessions before paging messages.
    state
        .service
        .get_ai_session(session_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let messages = state
        .service
        .list_ai_messages(ListAiMessagesRequest {
            session_id,
            after_sequence: params.after_sequence,
            limit: params.limit,
        })
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(AiMessageListResponse {
        messages: messages.into_iter().map(Into::into).collect(),
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/ai/sessions/{session_id}/clear",
    operation_id = "clear_ai_session",
    params(
        ("session_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")
    ),
    responses(
        (status = 200, body = AiSessionMutationResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn clear_ai_session(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<AiSessionMutationResponse>, ApiError> {
    let session_id = parse_path_id(&session_id, AiSessionId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let serial = Arc::clone(&state.ai_reconfigure).lock_owned().await;
    let commit_state = state.clone();
    let commit_request_id = request_id.clone();
    reconfigure_owned(&state, &request_id, serial, async move {
        let mutation = commit_state
            .service
            .clear_ai_session(operation_id, ClearAiSessionRequest { session_id })
            .await
            .map_err(|error| ApiError::from_app(error, &commit_request_id))?;
        session_mutation_response(&commit_state, mutation, &commit_request_id).await
    })
    .await
    .map(Json)
}

#[utoipa::path(
    get,
    path = "/api/v1/ai/memories",
    operation_id = "list_ai_memories",
    params(ListAiMemoriesQuery),
    responses(
        (status = 200, body = AiMemoryListResponse),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn list_ai_memories(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    query: Result<Query<ListAiMemoriesQuery>, QueryRejection>,
) -> Result<Json<AiMemoryListResponse>, ApiError> {
    let params = extract_query(query, &request_id)?;
    let _serial = state.ai_reconfigure.lock().await;
    let cursor = params
        .cursor
        .as_deref()
        .map(|raw| decode_ai_memory_cursor(raw, &request_id))
        .transpose()?;
    let page = state
        .service
        .list_ai_memories(ListAiMemoriesRequest {
            cursor,
            limit: params.limit,
        })
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let next_cursor = page
        .next_cursor
        .as_ref()
        .map(encode_ai_memory_cursor)
        .transpose()
        .map_err(|error| validation_error(error, &request_id))?;
    Ok(Json(AiMemoryListResponse {
        memories: page.memories.into_iter().map(Into::into).collect(),
        next_cursor,
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/ai/memories",
    operation_id = "create_ai_memory",
    request_body = CreateAiMemoryHttpRequest,
    params(("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")),
    responses(
        (status = 201, body = AiMemoryMutationResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn create_ai_memory(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
    payload: Result<Json<CreateAiMemoryHttpRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<AiMemoryMutationResponse>), ApiError> {
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json_with_limit(payload, &request_id, MAX_AI_CONFIG_BODY_BYTES)?;
    // Validate content before drain so empty/oversize bodies never cancel the runtime.
    let content = AiMemory::new(AiMemoryId::new(), payload.content, Timestamp::now())
        .map_err(|error| validation_error(error, &request_id))?
        .content;
    let serial = Arc::clone(&state.ai_reconfigure).lock_owned().await;
    let commit_state = state.clone();
    let commit_request_id = request_id.clone();
    reconfigure_owned(&state, &request_id, serial, async move {
        let mutation = commit_state
            .service
            .create_ai_memory(operation_id, CreateAiMemoryRequest { content })
            .await
            .map_err(|error| ApiError::from_app(error, &commit_request_id))?;
        memory_mutation_response(&commit_state, mutation, &commit_request_id).await
    })
    .await
    .map(|response| (StatusCode::CREATED, Json(response)))
}

#[utoipa::path(
    get,
    path = "/api/v1/ai/memories/{memory_id}",
    operation_id = "get_ai_memory",
    params(("memory_id" = String, Path, format = Uuid)),
    responses(
        (status = 200, body = AiMemoryDto),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn get_ai_memory(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(memory_id): Path<String>,
) -> Result<Json<AiMemoryDto>, ApiError> {
    let memory_id = parse_path_id(&memory_id, AiMemoryId::parse, &request_id)?;
    let _serial = state.ai_reconfigure.lock().await;
    let memory = state
        .service
        .get_ai_memory(memory_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(memory.into()))
}

#[utoipa::path(
    patch,
    path = "/api/v1/ai/memories/{memory_id}",
    operation_id = "patch_ai_memory",
    request_body = PatchAiMemoryRequest,
    params(
        ("memory_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")
    ),
    responses(
        (status = 200, body = AiMemoryMutationResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 413, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn patch_ai_memory(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(memory_id): Path<String>,
    headers: HeaderMap,
    payload: Result<Json<PatchAiMemoryRequest>, JsonRejection>,
) -> Result<Json<AiMemoryMutationResponse>, ApiError> {
    let memory_id = parse_path_id(&memory_id, AiMemoryId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let payload = extract_json_with_limit(payload, &request_id, MAX_AI_CONFIG_BODY_BYTES)?;
    // Validate content before drain so empty/oversize bodies never cancel the runtime.
    let content = AiMemory::new(memory_id, payload.content, Timestamp::now())
        .map_err(|error| validation_error(error, &request_id))?
        .content;
    let serial = Arc::clone(&state.ai_reconfigure).lock_owned().await;
    let commit_state = state.clone();
    let commit_request_id = request_id.clone();
    reconfigure_owned(&state, &request_id, serial, async move {
        let mutation = commit_state
            .service
            .update_ai_memory(operation_id, UpdateAiMemoryRequest { memory_id, content })
            .await
            .map_err(|error| ApiError::from_app(error, &commit_request_id))?;
        memory_mutation_response(&commit_state, mutation, &commit_request_id).await
    })
    .await
    .map(Json)
}

#[utoipa::path(
    delete,
    path = "/api/v1/ai/memories/{memory_id}",
    operation_id = "delete_ai_memory",
    params(
        ("memory_id" = String, Path, format = Uuid),
        ("Idempotency-Key" = String, Header, format = Uuid, description = "UUID operation id")
    ),
    responses(
        (status = 200, body = MutationResponse),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 409, body = crate::error::ErrorEnvelope),
        (status = 422, body = crate::error::ErrorEnvelope),
        (status = 503, body = crate::error::ErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
pub async fn delete_ai_memory(
    State(state): State<ServerState>,
    Extension(request_id): Extension<RequestId>,
    Path(memory_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<MutationResponse>, ApiError> {
    let memory_id = parse_path_id(&memory_id, AiMemoryId::parse, &request_id)?;
    let operation_id = operation_id(&headers, &request_id)?;
    let serial = Arc::clone(&state.ai_reconfigure).lock_owned().await;
    let commit_state = state.clone();
    let commit_request_id = request_id.clone();
    reconfigure_owned(&state, &request_id, serial, async move {
        let mutation = commit_state
            .service
            .delete_ai_memory(operation_id, DeleteAiMemoryRequest { memory_id })
            .await
            .map_err(|error| ApiError::from_app(error, &commit_request_id))?;
        Ok(MutationResponse::from(mutation))
    })
    .await
    .map(Json)
}

async fn session_mutation_response(
    state: &ServerState,
    mutation: junban_app::CommittedMutation,
    request_id: &RequestId,
) -> Result<AiSessionMutationResponse, ApiError> {
    let session_id = mutation
        .event
        .primary
        .as_ref()
        .ok_or_else(|| missing_primary(request_id))
        .and_then(|primary| parse_path_id(&primary.id, AiSessionId::parse, request_id))?;
    let session = state
        .service
        .get_ai_session(session_id)
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?;
    Ok(AiSessionMutationResponse {
        session: session.into(),
        event: mutation.event.into(),
    })
}

async fn memory_mutation_response(
    state: &ServerState,
    mutation: junban_app::CommittedMutation,
    request_id: &RequestId,
) -> Result<AiMemoryMutationResponse, ApiError> {
    let memory_id = mutation
        .event
        .primary
        .as_ref()
        .ok_or_else(|| missing_primary(request_id))
        .and_then(|primary| parse_path_id(&primary.id, AiMemoryId::parse, request_id))?;
    let memory = state
        .service
        .get_ai_memory(memory_id)
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?;
    Ok(AiMemoryMutationResponse {
        memory: memory.into(),
        event: mutation.event.into(),
    })
}

fn missing_primary(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "ai_resource_unavailable",
        "committed AI resource identity is unavailable",
        true,
        request_id,
    )
}

async fn load_config_response(
    state: &ServerState,
    request_id: &RequestId,
) -> Result<AiConfigResponse, ApiError> {
    let settings = state
        .service
        .get_settings()
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?;
    let metadata = state
        .service
        .list_ai_secret_metadata()
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?;
    let find = |id: Option<AiCredentialId>| -> Result<Option<AiCredentialMetadataDto>, ApiError> {
        id.map(|id| {
            metadata
                .iter()
                .find(|entry| entry.id == id)
                .cloned()
                .map(Into::into)
                .ok_or_else(|| stale_credential(request_id))
        })
        .transpose()
    };
    Ok(AiConfigResponse {
        ai: (&settings.ai).into(),
        voice: (&settings.voice).into(),
        credentials: AiCredentialBindingsDto {
            ai_provider: find(settings.ai.credential_id)?,
            voice_stt: find(settings.voice.stt_credential_id)?,
            voice_tts: find(settings.voice.tts_credential_id)?,
        },
    })
}

/// Run a validated reconfiguration in an owned task that survives HTTP cancellation.
///
/// The caller acquires `serial`, reads confirmed settings, and validates while retaining the
/// same permit. A timeout never polls `commit` and leaves its epoch fail-closed. After a clean
/// runtime drop, both commit success and failure finish only that exact epoch.
pub(crate) async fn reconfigure_owned<T>(
    state: &ServerState,
    request_id: &RequestId,
    serial: OwnedMutexGuard<()>,
    commit: impl Future<Output = Result<T, ApiError>> + Send + 'static,
) -> Result<T, ApiError>
where
    T: Send + 'static,
{
    let worker_state = state.clone();
    let worker_request_id = request_id.clone();
    let worker = tokio::spawn(async move {
        let _serial = serial;
        let (ai_epoch, speech_epoch) = worker_state
            .begin_ai_speech_reconfigure()
            .map_err(|()| ai_runtime_unavailable(&worker_request_id))?;
        let (ai_drained, speech_drained) = tokio::join!(
            worker_state
                .ai_runtime()
                .wait_drained(AI_RECONFIGURE_DRAIN_DEADLINE),
            worker_state
                .speech_runtime()
                .wait_drained(AI_RECONFIGURE_DRAIN_DEADLINE),
        );
        if !ai_drained || !speech_drained {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "ai_reconfigure_timeout",
                "AI or speech runtime did not drain before the reconfiguration deadline",
                true,
                &worker_request_id,
            ));
        }
        worker_state
            .drop_ai_speech_reconfigure(ai_epoch, speech_epoch)
            .map_err(|()| ai_runtime_unavailable(&worker_request_id))?;

        let result = commit.await;
        #[cfg(test)]
        worker_state
            .ai_reconfigure_test_gate
            .pause_after_commit()
            .await;
        // After runtime drop + durable commit: best-effort pager reclaim. Must not
        // convert a committed settings mutation into an API failure. Allocator trim
        // already ran inside drop_ai_speech_reconfigure.
        match worker_state.service.release_cached_memory().await {
            Ok(()) => {
                #[cfg(test)]
                worker_state.record_pager_release_success();
            }
            Err(_) => {
                // Static, secret-free, non-authoritative diagnostic only.
                worker_state.log_diagnostic(
                    DiagnosticSeverity::Warning,
                    "sqlite_pager_release_failed",
                    Some(worker_request_id.0.as_str()),
                    "best-effort SQLite pager release after AI/speech reconfigure failed",
                );
            }
        }
        worker_state
            .finish_ai_speech_reconfigure(ai_epoch, speech_epoch)
            .map_err(|()| ai_runtime_unavailable(&worker_request_id))?;
        result
    });
    worker.await.map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "ai_reconfigure_worker_failed",
            "AI reconfiguration worker failed",
            true,
            request_id,
        )
    })?
}

fn authority_change_requires_credential_delete(
    field: &'static str,
    request_id: &RequestId,
) -> ApiError {
    validation_error(
        junban_domain::ValidationError::Invalid {
            field,
            reason: "credential must be deleted before changing provider authority",
        },
        request_id,
    )
}

fn validate_credential_authority(
    target: AiCredentialTargetDto,
    kind: AiSecretKind,
    ai: &AiSettings,
    voice: &VoiceSettings,
    request_id: &RequestId,
) -> Result<(), ApiError> {
    use junban_ai::AuthScheme;

    let valid = match target {
        AiCredentialTargetDto::AiProvider => {
            let provider = ai.provider.ok_or_else(|| {
                credential_authority_error(
                    "credential.target",
                    "AI provider must be selected before binding a credential",
                    request_id,
                )
            })?;
            match descriptor(provider).auth {
                AuthScheme::None => false,
                AuthScheme::Bearer => matches!(kind, AiSecretKind::ApiKey | AiSecretKind::Bearer),
                AuthScheme::AnthropicApiKey | AuthScheme::GoogleApiKey => {
                    kind == AiSecretKind::ApiKey
                }
            }
        }
        AiCredentialTargetDto::VoiceStt => match voice.stt_provider {
            SpeechProviderPreset::Browser | SpeechProviderPreset::Inworld => false,
            SpeechProviderPreset::OpenAi | SpeechProviderPreset::Groq => {
                matches!(kind, AiSecretKind::ApiKey | AiSecretKind::Bearer)
            }
        },
        AiCredentialTargetDto::VoiceTts => match voice.tts_provider {
            SpeechProviderPreset::Browser => false,
            SpeechProviderPreset::OpenAi | SpeechProviderPreset::Groq => {
                matches!(kind, AiSecretKind::ApiKey | AiSecretKind::Bearer)
            }
            SpeechProviderPreset::Inworld => {
                matches!(kind, AiSecretKind::InworldBasic | AiSecretKind::InworldJwt)
            }
        },
    };
    if valid {
        Ok(())
    } else {
        Err(credential_authority_error(
            "credential.kind",
            "credential kind is not accepted by the selected provider authority",
            request_id,
        ))
    }
}

fn credential_authority_error(
    field: &'static str,
    reason: &'static str,
    request_id: &RequestId,
) -> ApiError {
    validation_error(
        junban_domain::ValidationError::Invalid { field, reason },
        request_id,
    )
}

fn ai_runtime_unavailable(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "ai_runtime_unavailable",
        "AI runtime lifecycle is unavailable",
        true,
        request_id,
    )
}

fn stale_credential(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "credential_unavailable",
        "confirmed credential material is unavailable",
        false,
        request_id,
    )
}

fn runtime_error(error: crate::AiRuntimeError, request_id: &RequestId) -> ApiError {
    match error {
        crate::AiRuntimeError::Capacity | crate::AiRuntimeError::Duplicate => ApiError::new(
            StatusCode::CONFLICT,
            "ai_run_conflict",
            "AI runtime cannot admit model discovery",
            true,
            request_id,
        ),
        _ => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "ai_runtime_unavailable",
            "AI runtime is not accepting model discovery",
            true,
            request_id,
        ),
    }
}

fn provider_error(error: ProviderError, request_id: &RequestId) -> ApiError {
    match error.kind() {
        ProviderErrorKind::Invalid => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "provider_config_invalid",
            "confirmed provider configuration is invalid",
            false,
            request_id,
        ),
        ProviderErrorKind::Unavailable => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "model_discovery_unavailable",
            "provider model discovery is unavailable",
            false,
            request_id,
        ),
        ProviderErrorKind::BoundExceeded => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "provider_result_invalid",
            "provider model discovery exceeded a response bound",
            false,
            request_id,
        ),
        ProviderErrorKind::Connect
        | ProviderErrorKind::Timeout
        | ProviderErrorKind::Cancelled
        | ProviderErrorKind::HttpStatus
        | ProviderErrorKind::Stream => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider_unavailable",
            "provider model discovery is unavailable",
            true,
            request_id,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_request_debug_is_redacted() {
        let request = PutAiCredentialRequest {
            kind: AiSecretKindDto::ApiKey,
            secret: "route-secret-marker".to_owned(),
        };
        assert!(!format!("{request:?}").contains("route-secret-marker"));
    }

    #[test]
    fn config_request_is_strict_and_provider_ids_are_typed() {
        assert!(
            serde_json::from_str::<AiConfigPutRequest>(r#"{"ai":{},"voice":{},"x":1}"#).is_err()
        );
        assert!(serde_json::from_str::<AiProviderPresetDto>(r#""xai""#).is_err());
        assert!(serde_json::from_str::<AiProviderPresetDto>(r#""deep_seek""#).is_err());
    }

    #[test]
    fn credential_kind_matrix_is_bound_to_confirmed_authority() {
        let request_id = RequestId("credential-matrix".to_owned());
        let mut ai = AiSettings::default_settings();
        let mut voice = VoiceSettings::default_settings();

        assert!(
            validate_credential_authority(
                AiCredentialTargetDto::AiProvider,
                AiSecretKind::ApiKey,
                &ai,
                &voice,
                &request_id,
            )
            .is_err()
        );
        for (provider, accepted, rejected) in [
            (
                AiProviderPreset::OpenAi,
                AiSecretKind::Bearer,
                AiSecretKind::InworldJwt,
            ),
            (
                AiProviderPreset::Anthropic,
                AiSecretKind::ApiKey,
                AiSecretKind::Bearer,
            ),
            (
                AiProviderPreset::Gemini,
                AiSecretKind::ApiKey,
                AiSecretKind::Bearer,
            ),
        ] {
            ai.provider = Some(provider);
            assert!(
                validate_credential_authority(
                    AiCredentialTargetDto::AiProvider,
                    accepted,
                    &ai,
                    &voice,
                    &request_id,
                )
                .is_ok()
            );
            assert!(
                validate_credential_authority(
                    AiCredentialTargetDto::AiProvider,
                    rejected,
                    &ai,
                    &voice,
                    &request_id,
                )
                .is_err()
            );
        }
        ai.provider = Some(AiProviderPreset::Ollama);
        assert!(
            validate_credential_authority(
                AiCredentialTargetDto::AiProvider,
                AiSecretKind::Bearer,
                &ai,
                &voice,
                &request_id,
            )
            .is_err()
        );

        voice.stt_provider = SpeechProviderPreset::OpenAi;
        voice.tts_provider = SpeechProviderPreset::Groq;
        for target in [
            AiCredentialTargetDto::VoiceStt,
            AiCredentialTargetDto::VoiceTts,
        ] {
            assert!(
                validate_credential_authority(
                    target,
                    AiSecretKind::ApiKey,
                    &ai,
                    &voice,
                    &request_id,
                )
                .is_ok()
            );
            assert!(
                validate_credential_authority(
                    target,
                    AiSecretKind::InworldBasic,
                    &ai,
                    &voice,
                    &request_id,
                )
                .is_err()
            );
        }
        voice.stt_provider = SpeechProviderPreset::Inworld;
        assert!(
            validate_credential_authority(
                AiCredentialTargetDto::VoiceStt,
                AiSecretKind::InworldJwt,
                &ai,
                &voice,
                &request_id,
            )
            .is_err()
        );
        voice.tts_provider = SpeechProviderPreset::Inworld;
        assert!(
            validate_credential_authority(
                AiCredentialTargetDto::VoiceTts,
                AiSecretKind::InworldBasic,
                &ai,
                &voice,
                &request_id,
            )
            .is_ok()
        );
        assert!(
            validate_credential_authority(
                AiCredentialTargetDto::VoiceTts,
                AiSecretKind::ApiKey,
                &ai,
                &voice,
                &request_id,
            )
            .is_err()
        );
        voice.tts_provider = SpeechProviderPreset::Browser;
        assert!(
            validate_credential_authority(
                AiCredentialTargetDto::VoiceTts,
                AiSecretKind::Bearer,
                &ai,
                &voice,
                &request_id,
            )
            .is_err()
        );
    }
}
