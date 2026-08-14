//! Operator-only HTTP composition for the accepted plugin authorities.

#[rustfmt::skip]
#[path = "bundled_registry_include.rs"]
mod bundled_registry_include;

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use self::bundled_registry_include::BUNDLED_REGISTRY_PACKAGES;
use axum::{
    Json,
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode, header},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use http_body_util::BodyExt as _;
use jiff::Timestamp;
use junban_app::{
    AppError, CommittedPluginInvocation, DeletePluginSettingRequest, InstalledPlugin,
    PluginHookKind, PluginInstallSource, PluginInvocationPublicOutcome, PluginManifestEntry,
    PluginMutationOutcome, PluginMutationRequestIdentity, PluginOperatorRequestIdentity,
    PluginPackageAdmission, PluginPackageAuthority, PluginRuntimeState, PluginSetting,
    PublisherTrustStatus, ReplacePluginGrantsRequest, RevokePluginGrantsRequest,
    SetPluginSettingRequest, StagedFile, TrustPublisherRequest,
};
use junban_domain::OperationId;
use junban_plugin_sdk::{
    AuthorityFence, Capability, EventKind, HttpMethod, InvocationOutcome as GuestInvocationOutcome,
    InvocationRequest, Permission, PermissionScope, PluginId, RuntimeManifest, SettingSchema,
    SettingValue as ManifestSettingValue, Sha256Digest, canonical_permission_hash,
    permission_set_hash,
    private_body_types::{
        CommandCall, DataValue, NamedSetting, NamedValue, ScalarNamedValue, ScalarValue,
        SettingValue as GuestSettingValue, SettingValues, SurfaceAction, SurfaceRequest, WitResult,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncWriteExt as _;
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    RequestId, ServerState,
    error::{ApiError, extract_json_with_limit, operation_id},
    plugin_runtime::{
        InvocationOutcome, PluginInvocationDispatch, PluginRuntimeError, PluginRuntimeLifecycle,
    },
};

const PLUGIN_PACKAGE_UPLOAD_MAX: usize = junban_plugin_sdk::PACKAGE_BYTES_MAX;
const DELIVERY_OPERATION_DOMAIN: &[u8] = b"junban.plugin.http.delivery.v1\0";
const BUNDLED_REGISTRY_ROOT_KEY: &[u8; 32] =
    include_bytes!("../../../plugins/registry/root-public-key.bin");
const BUNDLED_REGISTRY_INDEX: &[u8] = include_bytes!("../../../plugins/registry/index.jri");
const PLUGIN_REQUEST_ITEMS_MAX: usize = 128;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PluginCapabilityDto {
    #[serde(rename = "tasks:read")]
    TasksRead,
    #[serde(rename = "tasks:write")]
    TasksWrite,
    #[serde(rename = "projects:read")]
    ProjectsRead,
    #[serde(rename = "projects:write")]
    ProjectsWrite,
    #[serde(rename = "tags:read")]
    TagsRead,
    #[serde(rename = "tags:write")]
    TagsWrite,
    #[serde(rename = "events:subscribe")]
    EventsSubscribe,
    Settings,
    Storage,
    Commands,
    #[serde(rename = "ui:view")]
    UiView,
    #[serde(rename = "ui:panel")]
    UiPanel,
    #[serde(rename = "ui:status")]
    UiStatus,
    #[serde(rename = "services:provide")]
    ServicesProvide,
    #[serde(rename = "services:consume")]
    ServicesConsume,
    Http,
    Logging,
}

impl From<Capability> for PluginCapabilityDto {
    fn from(value: Capability) -> Self {
        match value {
            Capability::TasksRead => Self::TasksRead,
            Capability::TasksWrite => Self::TasksWrite,
            Capability::ProjectsRead => Self::ProjectsRead,
            Capability::ProjectsWrite => Self::ProjectsWrite,
            Capability::TagsRead => Self::TagsRead,
            Capability::TagsWrite => Self::TagsWrite,
            Capability::EventsSubscribe => Self::EventsSubscribe,
            Capability::Settings => Self::Settings,
            Capability::Storage => Self::Storage,
            Capability::Commands => Self::Commands,
            Capability::UiView => Self::UiView,
            Capability::UiPanel => Self::UiPanel,
            Capability::UiStatus => Self::UiStatus,
            Capability::ServicesProvide => Self::ServicesProvide,
            Capability::ServicesConsume => Self::ServicesConsume,
            Capability::Http => Self::Http,
            Capability::Logging => Self::Logging,
        }
    }
}

impl From<PluginCapabilityDto> for Capability {
    fn from(value: PluginCapabilityDto) -> Self {
        match value {
            PluginCapabilityDto::TasksRead => Self::TasksRead,
            PluginCapabilityDto::TasksWrite => Self::TasksWrite,
            PluginCapabilityDto::ProjectsRead => Self::ProjectsRead,
            PluginCapabilityDto::ProjectsWrite => Self::ProjectsWrite,
            PluginCapabilityDto::TagsRead => Self::TagsRead,
            PluginCapabilityDto::TagsWrite => Self::TagsWrite,
            PluginCapabilityDto::EventsSubscribe => Self::EventsSubscribe,
            PluginCapabilityDto::Settings => Self::Settings,
            PluginCapabilityDto::Storage => Self::Storage,
            PluginCapabilityDto::Commands => Self::Commands,
            PluginCapabilityDto::UiView => Self::UiView,
            PluginCapabilityDto::UiPanel => Self::UiPanel,
            PluginCapabilityDto::UiStatus => Self::UiStatus,
            PluginCapabilityDto::ServicesProvide => Self::ServicesProvide,
            PluginCapabilityDto::ServicesConsume => Self::ServicesConsume,
            PluginCapabilityDto::Http => Self::Http,
            PluginCapabilityDto::Logging => Self::Logging,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PluginEventKindDto {
    TaskCreated,
    TaskUpdated,
    TaskCompleted,
    TaskUncompleted,
    TaskCancelled,
    TaskReopened,
    TaskDeleted,
    ProjectCreated,
    ProjectUpdated,
    ProjectDeleted,
    TagCreated,
    TagUpdated,
    TagDeleted,
    SectionCreated,
    SectionUpdated,
    SectionDeleted,
}

impl From<EventKind> for PluginEventKindDto {
    fn from(value: EventKind) -> Self {
        match value {
            EventKind::TaskCreated => Self::TaskCreated,
            EventKind::TaskUpdated => Self::TaskUpdated,
            EventKind::TaskCompleted => Self::TaskCompleted,
            EventKind::TaskUncompleted => Self::TaskUncompleted,
            EventKind::TaskCancelled => Self::TaskCancelled,
            EventKind::TaskReopened => Self::TaskReopened,
            EventKind::TaskDeleted => Self::TaskDeleted,
            EventKind::ProjectCreated => Self::ProjectCreated,
            EventKind::ProjectUpdated => Self::ProjectUpdated,
            EventKind::ProjectDeleted => Self::ProjectDeleted,
            EventKind::TagCreated => Self::TagCreated,
            EventKind::TagUpdated => Self::TagUpdated,
            EventKind::TagDeleted => Self::TagDeleted,
            EventKind::SectionCreated => Self::SectionCreated,
            EventKind::SectionUpdated => Self::SectionUpdated,
            EventKind::SectionDeleted => Self::SectionDeleted,
        }
    }
}

impl From<PluginEventKindDto> for EventKind {
    fn from(value: PluginEventKindDto) -> Self {
        match value {
            PluginEventKindDto::TaskCreated => Self::TaskCreated,
            PluginEventKindDto::TaskUpdated => Self::TaskUpdated,
            PluginEventKindDto::TaskCompleted => Self::TaskCompleted,
            PluginEventKindDto::TaskUncompleted => Self::TaskUncompleted,
            PluginEventKindDto::TaskCancelled => Self::TaskCancelled,
            PluginEventKindDto::TaskReopened => Self::TaskReopened,
            PluginEventKindDto::TaskDeleted => Self::TaskDeleted,
            PluginEventKindDto::ProjectCreated => Self::ProjectCreated,
            PluginEventKindDto::ProjectUpdated => Self::ProjectUpdated,
            PluginEventKindDto::ProjectDeleted => Self::ProjectDeleted,
            PluginEventKindDto::TagCreated => Self::TagCreated,
            PluginEventKindDto::TagUpdated => Self::TagUpdated,
            PluginEventKindDto::TagDeleted => Self::TagDeleted,
            PluginEventKindDto::SectionCreated => Self::SectionCreated,
            PluginEventKindDto::SectionUpdated => Self::SectionUpdated,
            PluginEventKindDto::SectionDeleted => Self::SectionDeleted,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, ToSchema)]
pub enum PluginHttpMethodDto {
    #[serde(rename = "DELETE")]
    Delete,
    #[serde(rename = "GET")]
    Get,
    #[serde(rename = "PATCH")]
    Patch,
    #[serde(rename = "POST")]
    Post,
    #[serde(rename = "PUT")]
    Put,
}

impl From<HttpMethod> for PluginHttpMethodDto {
    fn from(value: HttpMethod) -> Self {
        match value {
            HttpMethod::Delete => Self::Delete,
            HttpMethod::Get => Self::Get,
            HttpMethod::Patch => Self::Patch,
            HttpMethod::Post => Self::Post,
            HttpMethod::Put => Self::Put,
        }
    }
}

impl From<PluginHttpMethodDto> for HttpMethod {
    fn from(value: PluginHttpMethodDto) -> Self {
        match value {
            PluginHttpMethodDto::Delete => Self::Delete,
            PluginHttpMethodDto::Get => Self::Get,
            PluginHttpMethodDto::Patch => Self::Patch,
            PluginHttpMethodDto::Post => Self::Post,
            PluginHttpMethodDto::Put => Self::Put,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginUnscopedPermissionDto {}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginEventScopeDto {
    pub event_kinds: Vec<PluginEventKindDto>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginServiceReferenceDto {
    pub plugin_id: String,
    pub service_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginServiceScopeDto {
    pub services: Vec<PluginServiceReferenceDto>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginHttpScopeDto {
    pub origins: Vec<String>,
    pub methods: Vec<PluginHttpMethodDto>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(untagged)]
pub enum PluginPermissionScopeDto {
    Unscoped(PluginUnscopedPermissionDto),
    Events(PluginEventScopeDto),
    Services(PluginServiceScopeDto),
    Http(PluginHttpScopeDto),
}

impl From<&PermissionScope> for PluginPermissionScopeDto {
    fn from(value: &PermissionScope) -> Self {
        match value {
            PermissionScope::Unscoped(_) => Self::Unscoped(PluginUnscopedPermissionDto {}),
            PermissionScope::Events(scope) => Self::Events(PluginEventScopeDto {
                event_kinds: scope.event_kinds.iter().copied().map(Into::into).collect(),
            }),
            PermissionScope::Services(scope) => Self::Services(PluginServiceScopeDto {
                services: scope
                    .services
                    .iter()
                    .map(|service| PluginServiceReferenceDto {
                        plugin_id: service.plugin_id.clone(),
                        service_id: service.service_id.clone(),
                    })
                    .collect(),
            }),
            PermissionScope::Http(scope) => Self::Http(PluginHttpScopeDto {
                origins: scope
                    .origins
                    .iter()
                    .map(|origin| origin.0.clone())
                    .collect(),
                methods: scope.methods.iter().copied().map(Into::into).collect(),
            }),
        }
    }
}

impl From<PluginPermissionScopeDto> for PermissionScope {
    fn from(value: PluginPermissionScopeDto) -> Self {
        match value {
            PluginPermissionScopeDto::Unscoped(_) => {
                Self::Unscoped(junban_plugin_sdk::UnscopedPermission {})
            }
            PluginPermissionScopeDto::Events(scope) => {
                Self::Events(junban_plugin_sdk::EventScope {
                    event_kinds: scope.event_kinds.into_iter().map(Into::into).collect(),
                })
            }
            PluginPermissionScopeDto::Services(scope) => {
                Self::Services(junban_plugin_sdk::ServiceConsumeScope {
                    services: scope
                        .services
                        .into_iter()
                        .map(|service| junban_plugin_sdk::ServiceReference {
                            plugin_id: service.plugin_id,
                            service_id: service.service_id,
                        })
                        .collect(),
                })
            }
            PluginPermissionScopeDto::Http(scope) => Self::Http(junban_plugin_sdk::HttpScope {
                origins: scope
                    .origins
                    .into_iter()
                    .map(junban_plugin_sdk::HttpOrigin)
                    .collect(),
                methods: scope.methods.into_iter().map(Into::into).collect(),
            }),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginPermissionDto {
    pub capability: PluginCapabilityDto,
    pub scope: PluginPermissionScopeDto,
}

impl From<&Permission> for PluginPermissionDto {
    fn from(value: &Permission) -> Self {
        Self {
            capability: value.capability.into(),
            scope: (&value.scope).into(),
        }
    }
}

impl From<PluginPermissionDto> for Permission {
    fn from(value: PluginPermissionDto) -> Self {
        Self {
            capability: value.capability.into(),
            scope: value.scope.into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginPackagePreviewResponse {
    pub plugin_id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub junban_compatibility: String,
    pub runtime_profile: String,
    pub package_sha256: String,
    pub package_size: u64,
    pub component_sha256: String,
    pub component_size: u64,
    pub publisher_key_id: String,
    pub publisher_public_key_base64: String,
    pub publisher_trust: String,
    pub permission_hash: String,
    pub permissions: Vec<PluginPermissionDto>,
    pub dependencies: serde_json::Value,
    pub commands: serde_json::Value,
    pub surfaces: serde_json::Value,
    pub settings: serde_json::Value,
    pub services: serde_json::Value,
}

#[derive(Clone, Copy, Debug, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PluginTextSettingSchemaTypeDto {
    Text,
}

#[derive(Clone, Copy, Debug, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PluginIntegerSettingSchemaTypeDto {
    Integer,
}

#[derive(Clone, Copy, Debug, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PluginBooleanSettingSchemaTypeDto {
    Boolean,
}

#[derive(Clone, Copy, Debug, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PluginSelectSettingSchemaTypeDto {
    Select,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginTextSettingSchemaDto {
    #[serde(rename = "type")]
    pub schema_type: PluginTextSettingSchemaTypeDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    pub min_bytes: u16,
    pub max_bytes: u16,
    pub secret: bool,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginIntegerSettingSchemaDto {
    #[serde(rename = "type")]
    pub schema_type: PluginIntegerSettingSchemaTypeDto,
    pub default: i64,
    pub min: i64,
    pub max: i64,
    pub step: i64,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginBooleanSettingSchemaDto {
    #[serde(rename = "type")]
    pub schema_type: PluginBooleanSettingSchemaTypeDto,
    pub default: bool,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginSelectSettingSchemaDto {
    #[serde(rename = "type")]
    pub schema_type: PluginSelectSettingSchemaTypeDto,
    pub default: String,
    pub options: Vec<PluginSettingOptionDto>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginSettingOptionDto {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(untagged)]
#[schema(discriminator(
    property_name = "type",
    mapping(
        ("text" = "#/components/schemas/PluginTextSettingSchemaDto"),
        ("integer" = "#/components/schemas/PluginIntegerSettingSchemaDto"),
        ("boolean" = "#/components/schemas/PluginBooleanSettingSchemaDto"),
        ("select" = "#/components/schemas/PluginSelectSettingSchemaDto")
    )
))]
pub enum PluginSettingSchemaDto {
    Text(PluginTextSettingSchemaDto),
    Integer(PluginIntegerSettingSchemaDto),
    Boolean(PluginBooleanSettingSchemaDto),
    Select(PluginSelectSettingSchemaDto),
}

impl From<&SettingSchema> for PluginSettingSchemaDto {
    fn from(value: &SettingSchema) -> Self {
        match value {
            SettingSchema::Text {
                default,
                min_bytes,
                max_bytes,
                secret,
            } => Self::Text(PluginTextSettingSchemaDto {
                schema_type: PluginTextSettingSchemaTypeDto::Text,
                // A manifest default on a secret declaration can itself contain a secret.
                // Preserve the input shape while never returning those bytes.
                default: (!secret).then(|| default.clone()),
                min_bytes: *min_bytes,
                max_bytes: *max_bytes,
                secret: *secret,
            }),
            SettingSchema::Integer {
                default,
                min,
                max,
                step,
            } => Self::Integer(PluginIntegerSettingSchemaDto {
                schema_type: PluginIntegerSettingSchemaTypeDto::Integer,
                default: *default,
                min: *min,
                max: *max,
                step: *step,
            }),
            SettingSchema::Boolean { default } => Self::Boolean(PluginBooleanSettingSchemaDto {
                schema_type: PluginBooleanSettingSchemaTypeDto::Boolean,
                default: *default,
            }),
            SettingSchema::Select { default, options } => {
                Self::Select(PluginSelectSettingSchemaDto {
                    schema_type: PluginSelectSettingSchemaTypeDto::Select,
                    default: default.clone(),
                    options: options
                        .iter()
                        .map(|option| PluginSettingOptionDto {
                            id: option.id.clone(),
                            label: option.label.clone(),
                        })
                        .collect(),
                })
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginSettingDeclarationDto {
    pub id: String,
    pub label: String,
    pub description: String,
    pub schema: PluginSettingSchemaDto,
}

impl From<&junban_plugin_sdk::SettingDeclaration> for PluginSettingDeclarationDto {
    fn from(value: &junban_plugin_sdk::SettingDeclaration) -> Self {
        Self {
            id: value.id.clone(),
            label: value.label.clone(),
            description: value.description.clone(),
            schema: (&value.schema).into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct InstalledPluginDto {
    pub plugin_id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub package_sha256: String,
    pub publisher_key_id: String,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub desired_enabled: bool,
    pub runtime_state: String,
    pub requested_permissions: Vec<PluginPermissionDto>,
    pub granted_permissions: Vec<PluginPermissionDto>,
    pub dependencies: Vec<String>,
    pub dependencies_satisfied: bool,
    pub settings: Vec<PluginSettingDeclarationDto>,
    pub failure_count: u32,
    pub last_error_code: Option<String>,
    pub next_retry_at: Option<String>,
    pub installed_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginListResponse {
    pub plugins: Vec<InstalledPluginDto>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginMutationResponse {
    pub event: crate::dto::CommittedEventDto,
}

impl From<junban_app::CommittedMutation> for PluginMutationResponse {
    fn from(value: junban_app::CommittedMutation) -> Self {
        Self {
            event: value.event.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, IntoParams, ToSchema)]
#[into_params(parameter_in = Query)]
#[serde(deny_unknown_fields)]
pub struct PluginInstallConfirmation {
    pub expected_plugin_id: String,
    pub expected_version: String,
    pub expected_package_sha256: String,
    pub expected_publisher_key_id: String,
    pub expected_permission_hash: String,
    pub expected_compatibility: String,
    #[serde(default)]
    pub replace_existing: bool,
    #[serde(default)]
    pub allow_downgrade: bool,
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TrustPublisherBody {
    pub public_key_base64: String,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PublisherTrustDto {
    pub key_id: String,
    pub public_key_base64: String,
    pub status: String,
    pub trusted_at: String,
    pub revoked_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PublisherTrustListResponse {
    pub publishers: Vec<PublisherTrustDto>,
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CommunityPolicyBody {
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct CommunityPolicyResponse {
    pub enabled: bool,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ReplacePluginGrantsBody {
    pub package_generation: u64,
    #[schema(max_items = 128)]
    pub permissions: Vec<PluginPermissionDto>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginGrantDto {
    pub package_generation: u64,
    pub permission_hash: String,
    pub permission: PluginPermissionDto,
    pub granted_at: String,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginGrantListResponse {
    pub grants: Vec<PluginGrantDto>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(untagged)]
pub enum PluginSettingValueDto {
    Text(String),
    Integer(i64),
    Boolean(bool),
}

impl From<&ManifestSettingValue> for PluginSettingValueDto {
    fn from(value: &ManifestSettingValue) -> Self {
        match value {
            ManifestSettingValue::Text(value) => Self::Text(value.clone()),
            ManifestSettingValue::Integer(value) => Self::Integer(*value),
            ManifestSettingValue::Boolean(value) => Self::Boolean(*value),
        }
    }
}

impl From<PluginSettingValueDto> for ManifestSettingValue {
    fn from(value: PluginSettingValueDto) -> Self {
        match value {
            PluginSettingValueDto::Text(value) => Self::Text(value),
            PluginSettingValueDto::Integer(value) => Self::Integer(value),
            PluginSettingValueDto::Boolean(value) => Self::Boolean(value),
        }
    }
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginSettingDto {
    pub key: String,
    pub value: PluginSettingValueDto,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginSettingListResponse {
    pub settings: Vec<PluginSettingDto>,
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SetPluginSettingBody {
    pub package_generation: u64,
    pub value: PluginSettingValueDto,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginContributionDto {
    pub contribution_id: String,
    pub plugin_id: String,
    pub local_id: String,
    pub kind: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub actions: Vec<String>,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub host_session_id: String,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginContributionListResponse {
    pub contributions: Vec<PluginContributionDto>,
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ContributionFenceBody {
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub host_session_id: String,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct RenderPluginContributionResponse {
    pub plugin_id: String,
    pub surface_id: String,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub host_session_id: String,
    pub surface: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(tag = "tag", content = "val", deny_unknown_fields)]
pub enum PluginScalarValueDto {
    #[serde(rename = "string-value")]
    StringValue(String),
    #[serde(rename = "integer-value")]
    IntegerValue(i64),
    #[serde(rename = "boolean-value")]
    BooleanValue(bool),
    #[serde(rename = "date-value")]
    DateValue(String),
    #[serde(rename = "timestamp-value")]
    TimestampValue(String),
    #[serde(rename = "task-id")]
    TaskId(String),
    #[serde(rename = "project-id")]
    ProjectId(String),
    #[serde(rename = "tag-id")]
    TagId(String),
    #[serde(rename = "plugin-id")]
    PluginId(String),
    #[serde(rename = "option-id")]
    OptionId(String),
}

impl From<PluginScalarValueDto> for ScalarValue {
    fn from(value: PluginScalarValueDto) -> Self {
        match value {
            PluginScalarValueDto::StringValue(value) => Self::StringValue(value),
            PluginScalarValueDto::IntegerValue(value) => Self::IntegerValue(value),
            PluginScalarValueDto::BooleanValue(value) => Self::BooleanValue(value),
            PluginScalarValueDto::DateValue(value) => Self::DateValue(value),
            PluginScalarValueDto::TimestampValue(value) => Self::TimestampValue(value),
            PluginScalarValueDto::TaskId(value) => Self::TaskId(value),
            PluginScalarValueDto::ProjectId(value) => Self::ProjectId(value),
            PluginScalarValueDto::TagId(value) => Self::TagId(value),
            PluginScalarValueDto::PluginId(value) => Self::PluginId(value),
            PluginScalarValueDto::OptionId(value) => Self::OptionId(value),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(tag = "tag", content = "val", deny_unknown_fields)]
pub enum PluginDataValueDto {
    #[serde(rename = "scalar")]
    Scalar(PluginScalarValueDto),
    #[serde(rename = "string-list")]
    StringList(Vec<String>),
    #[serde(rename = "integer-list")]
    IntegerList(Vec<i64>),
    #[serde(rename = "boolean-list")]
    BooleanList(Vec<bool>),
    #[serde(rename = "date-list")]
    DateList(Vec<String>),
    #[serde(rename = "timestamp-list")]
    TimestampList(Vec<String>),
    #[serde(rename = "task-id-list")]
    TaskIdList(Vec<String>),
    #[serde(rename = "project-id-list")]
    ProjectIdList(Vec<String>),
    #[serde(rename = "tag-id-list")]
    TagIdList(Vec<String>),
    #[serde(rename = "plugin-id-list")]
    PluginIdList(Vec<String>),
    #[serde(rename = "option-id-list")]
    OptionIdList(Vec<String>),
}

impl From<PluginDataValueDto> for DataValue {
    fn from(value: PluginDataValueDto) -> Self {
        match value {
            PluginDataValueDto::Scalar(value) => Self::Scalar(value.into()),
            PluginDataValueDto::StringList(value) => Self::StringList(value),
            PluginDataValueDto::IntegerList(value) => Self::IntegerList(value),
            PluginDataValueDto::BooleanList(value) => Self::BooleanList(value),
            PluginDataValueDto::DateList(value) => Self::DateList(value),
            PluginDataValueDto::TimestampList(value) => Self::TimestampList(value),
            PluginDataValueDto::TaskIdList(value) => Self::TaskIdList(value),
            PluginDataValueDto::ProjectIdList(value) => Self::ProjectIdList(value),
            PluginDataValueDto::TagIdList(value) => Self::TagIdList(value),
            PluginDataValueDto::PluginIdList(value) => Self::PluginIdList(value),
            PluginDataValueDto::OptionIdList(value) => Self::OptionIdList(value),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginNamedValueDto {
    pub name: String,
    pub value: PluginDataValueDto,
}

impl From<PluginNamedValueDto> for NamedValue {
    fn from(value: PluginNamedValueDto) -> Self {
        Self {
            name: value.name,
            value: value.value.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginScalarNamedValueDto {
    pub name: String,
    pub value: PluginScalarValueDto,
}

impl From<PluginScalarNamedValueDto> for ScalarNamedValue {
    fn from(value: PluginScalarNamedValueDto) -> Self {
        Self {
            name: value.name,
            value: value.value.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct InvokePluginCommandBody {
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub host_session_id: String,
    #[schema(max_items = 128)]
    pub values: Vec<PluginNamedValueDto>,
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct InvokePluginActionBody {
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub host_session_id: String,
    #[schema(max_items = 128)]
    pub values: Vec<PluginScalarNamedValueDto>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PluginInvocationResponse {
    pub status: String,
    pub terminal_kind: Option<String>,
    pub revision: Option<u64>,
    pub rejection: Option<String>,
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
pub struct RegistrySearchQuery {
    pub query: Option<String>,
    pub capability: Option<String>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct RegistryEntryDto {
    pub plugin_id: String,
    pub version: String,
    pub package_sha256: String,
    pub package_size: u64,
    pub publisher_key_id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub license: String,
    pub search_tags: Vec<String>,
    pub runtime_profile: String,
    pub requested_capabilities: Vec<String>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct RegistryListResponse {
    pub index_sha256: String,
    pub entries: Vec<RegistryEntryDto>,
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RegistryInstallBody {
    pub version: String,
    pub expected_package_sha256: String,
    #[serde(default)]
    pub replace_existing: bool,
    #[serde(default)]
    pub allow_downgrade: bool,
}

fn runtime_state(value: PluginRuntimeState) -> &'static str {
    match value {
        PluginRuntimeState::Disabled => "disabled",
        PluginRuntimeState::Starting => "starting",
        PluginRuntimeState::Active => "active",
        PluginRuntimeState::Degraded => "degraded",
        PluginRuntimeState::Failed => "failed",
        PluginRuntimeState::Suspended => "suspended",
        PluginRuntimeState::ReverifyRequired => "reverify_required",
    }
}

fn installed_dto(plugin: &InstalledPlugin) -> InstalledPluginDto {
    InstalledPluginDto {
        plugin_id: plugin.plugin_id.to_string(),
        name: plugin.manifest.name.clone(),
        description: plugin.manifest.description.clone(),
        version: plugin.version.clone(),
        package_sha256: plugin.package_sha256.to_string(),
        publisher_key_id: plugin.publisher_key_id.to_string(),
        package_generation: plugin.package_generation,
        activation_epoch: plugin.activation_epoch,
        desired_enabled: plugin.desired_enabled,
        runtime_state: runtime_state(plugin.runtime_state).to_owned(),
        requested_permissions: plugin
            .manifest
            .permissions
            .iter()
            .map(PluginPermissionDto::from)
            .collect(),
        granted_permissions: plugin
            .manifest
            .permissions
            .iter()
            .filter(|permission| plugin.granted_capabilities.contains(&permission.capability))
            .map(PluginPermissionDto::from)
            .collect(),
        dependencies: plugin
            .manifest
            .dependencies
            .iter()
            .map(|dependency| dependency.id.clone())
            .collect(),
        dependencies_satisfied: plugin.dependencies_satisfied,
        settings: plugin
            .manifest
            .settings
            .iter()
            .map(PluginSettingDeclarationDto::from)
            .collect(),
        failure_count: plugin.failure_count,
        last_error_code: plugin.last_error_code.clone(),
        next_retry_at: plugin.next_retry_at.map(|value| value.to_string()),
        installed_at: plugin.installed_at.to_string(),
        updated_at: plugin.updated_at.to_string(),
    }
}

fn verified_registry(
    request_id: &RequestId,
) -> Result<junban_plugin_sdk::VerifiedRegistry, ApiError> {
    junban_plugin_sdk::parse_and_verify_registry(BUNDLED_REGISTRY_INDEX, BUNDLED_REGISTRY_ROOT_KEY)
        .map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "bundled_registry_invalid",
                "bundled plugin registry failed verification",
                false,
                request_id,
            )
        })
}

fn registry_dto(entry: &junban_plugin_sdk::RegistryEntry) -> RegistryEntryDto {
    RegistryEntryDto {
        plugin_id: entry.plugin_id.clone(),
        version: entry.version.clone(),
        package_sha256: entry.package_sha256.clone(),
        package_size: entry.package_size,
        publisher_key_id: entry.publisher_key_id.clone(),
        name: entry.name.clone(),
        description: entry.description.clone(),
        author: entry.author.clone(),
        license: entry.license.clone(),
        search_tags: entry.search_tags.clone(),
        runtime_profile: match entry.runtime_profile {
            junban_plugin_sdk::RuntimeProfile::Rust => "rust",
            junban_plugin_sdk::RuntimeProfile::Typescript => "typescript",
        }
        .to_owned(),
        requested_capabilities: entry
            .requested_capabilities
            .iter()
            .map(|value| value.as_str().to_owned())
            .collect(),
    }
}

fn parse_plugin_id(value: &str, request_id: &RequestId) -> Result<PluginId, ApiError> {
    PluginId::parse(value.to_owned()).map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "plugin id is invalid",
            false,
            request_id,
        )
        .with_field("plugin_id", "must be a canonical plugin id")
    })
}

fn parse_digest(
    value: &str,
    field: &'static str,
    request_id: &RequestId,
) -> Result<Sha256Digest, ApiError> {
    Sha256Digest::parse(value.to_owned()).map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "digest is invalid",
            false,
            request_id,
        )
        .with_field(field, "must be a lowercase SHA-256 digest")
    })
}

fn plugin_error(error: PluginRuntimeError, request_id: &RequestId) -> ApiError {
    match error {
        PluginRuntimeError::AuthorityRejected | PluginRuntimeError::NotAdmitting => ApiError::new(
            StatusCode::CONFLICT,
            "stale_plugin_authority",
            "plugin authority is stale; refresh and retry",
            false,
            request_id,
        ),
        PluginRuntimeError::Dormant => ApiError::new(
            StatusCode::CONFLICT,
            "plugin_not_active",
            "plugin is not active",
            false,
            request_id,
        ),
        PluginRuntimeError::Busy
        | PluginRuntimeError::InvocationLimit
        | PluginRuntimeError::PluginBusy => ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "plugin_busy",
            "plugin runtime is busy",
            true,
            request_id,
        ),
        _ => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "plugin_runtime_unavailable",
            "plugin runtime is unavailable",
            true,
            request_id,
        ),
    }
}

fn mutation_error(
    outcome: PluginMutationOutcome,
    request_id: &RequestId,
) -> Result<junban_app::CommittedMutation, ApiError> {
    match outcome {
        PluginMutationOutcome::Committed(mutation) => Ok(*mutation),
        PluginMutationOutcome::BlockedByDependents(_) => Err(ApiError::new(
            StatusCode::CONFLICT,
            "plugin_has_dependents",
            "plugin has installed dependents",
            false,
            request_id,
        )),
        PluginMutationOutcome::GraphRejected(_) => Err(ApiError::new(
            StatusCode::CONFLICT,
            "plugin_graph_rejected",
            "plugin dependency graph was rejected",
            false,
            request_id,
        )),
    }
}

fn json_value<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

async fn trust_status(
    state: &ServerState,
    package: &PluginPackageAuthority,
) -> Result<&'static str, AppError> {
    let trusts = state.service.list_publisher_trust().await?;
    Ok(
        match trusts
            .iter()
            .find(|trust| trust.key_id == *package.publisher_key_id())
        {
            Some(trust) if trust.status == PublisherTrustStatus::Active => "trusted",
            Some(_) => "revoked",
            None => "unknown",
        },
    )
}

async fn preview_from_admission(
    state: &ServerState,
    admission: &PluginPackageAdmission,
) -> Result<PluginPackagePreviewResponse, AppError> {
    let package = admission.package();
    let manifest = package.manifest();
    let permission_hash = Sha256Digest::from_bytes(
        permission_set_hash(&manifest.permissions).map_err(|_| AppError::Conflict)?,
    );
    Ok(PluginPackagePreviewResponse {
        plugin_id: package.plugin_id().to_string(),
        name: manifest.name.clone(),
        description: manifest.description.clone(),
        version: manifest.version.clone(),
        junban_compatibility: manifest.junban_compatibility.clone(),
        runtime_profile: format!("{:?}", manifest.runtime_profile).to_ascii_lowercase(),
        package_sha256: package.package_sha256().to_string(),
        package_size: package.package_size(),
        component_sha256: package.component_sha256().to_string(),
        component_size: package.component_size(),
        publisher_key_id: package.publisher_key_id().to_string(),
        publisher_public_key_base64: STANDARD.encode(package.publisher_public_key()),
        publisher_trust: trust_status(state, package).await?.to_owned(),
        permission_hash: permission_hash.to_string(),
        permissions: manifest
            .permissions
            .iter()
            .map(PluginPermissionDto::from)
            .collect(),
        dependencies: json_value(&manifest.dependencies),
        commands: json_value(&manifest.commands),
        surfaces: json_value(&manifest.surfaces),
        settings: json_value(&manifest.settings),
        services: json_value(&manifest.services),
    })
}

fn private_directory_exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(io::Error::other("unsafe plugin staging directory"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                if metadata.permissions().mode() & 0o077 != 0 {
                    return Err(io::Error::other("unsafe plugin staging permissions"));
                }
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt as _;
                const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
                if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return Err(io::Error::other("unsafe plugin staging reparse point"));
                }
            }
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn ensure_private_directory(path: &Path) -> io::Result<()> {
    if private_directory_exists(path)? {
        return Ok(());
    }
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt as _;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder
    };
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    match builder.create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    if private_directory_exists(path)? {
        Ok(())
    } else {
        Err(io::Error::other("plugin staging directory was not created"))
    }
}

fn prepare_plugin_staging(profile_dir: &Path) -> io::Result<PathBuf> {
    let plugins = profile_dir.join("plugins");
    ensure_private_directory(&plugins)?;
    let staging = plugins.join("staging");
    ensure_private_directory(&staging)?;
    Ok(staging)
}

async fn stage_package_upload(
    state: &ServerState,
    headers: &HeaderMap,
    mut body: Body,
    request_id: &RequestId,
) -> Result<(StagedFile, crate::StagedArtifactPermit), ApiError> {
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/octet-stream")
    {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "plugin packages require application/octet-stream",
            false,
            request_id,
        ));
    }
    let declared_length = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if declared_length.is_some_and(|length| length > PLUGIN_PACKAGE_UPLOAD_MAX) {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "plugin package exceeds the allowed size",
            false,
            request_id,
        ));
    }
    let permit = state.try_acquire_staged_artifact().ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "staged_artifact_busy",
            "another staged artifact operation is active",
            true,
            request_id,
        )
    })?;
    let directory = prepare_plugin_staging(&state.profile_dir).map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "storage_error",
            "could not prepare plugin staging",
            true,
            request_id,
        )
    })?;
    let path = directory.join(format!(".upload-{}.jbp", Uuid::now_v7()));
    let guard = StagedUploadGuard(path.clone());
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options.open(&path).await.map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "storage_error",
            "could not create plugin staging file",
            true,
            request_id,
        )
    })?;
    let mut length = 0_usize;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_body",
                "could not read plugin package",
                false,
                request_id,
            )
        })?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        length = length.saturating_add(data.len());
        if length > PLUGIN_PACKAGE_UPLOAD_MAX {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "plugin package exceeds the allowed size",
                false,
                request_id,
            ));
        }
        file.write_all(&data).await.map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "storage_error",
                "could not stage plugin package",
                true,
                request_id,
            )
        })?;
    }
    if declared_length.is_some_and(|declared| declared != length) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "plugin package length did not match content-length",
            false,
            request_id,
        ));
    }
    if length == 0 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "plugin package is empty",
            false,
            request_id,
        ));
    }
    file.sync_all().await.map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "storage_error",
            "could not durably stage plugin package",
            true,
            request_id,
        )
    })?;
    drop(file);
    Ok((guard.into_staged(length as u64), permit))
}

struct StagedUploadGuard(std::path::PathBuf);

impl StagedUploadGuard {
    fn into_staged(self, length: u64) -> StagedFile {
        let path = self.0.clone();
        std::mem::forget(self);
        StagedFile::new(path, length)
    }
}

impl Drop for StagedUploadGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

async fn inspect_staged(
    state: &ServerState,
    staged: StagedFile,
    request_id: &RequestId,
) -> Result<PluginPackageAdmission, ApiError> {
    let service = state.service.clone();
    tokio::task::spawn_blocking(move || service.inspect_plugin_package(staged))
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "plugin_inspection_unavailable",
                "plugin inspection worker failed",
                true,
                request_id,
            )
        })?
        .map_err(|error| ApiError::from_app(error, request_id))
}

fn exact_confirmation(
    package: &PluginPackageAuthority,
    confirmation: &PluginInstallConfirmation,
    request_id: &RequestId,
) -> Result<(), ApiError> {
    let permission_hash = Sha256Digest::from_bytes(
        permission_set_hash(&package.manifest().permissions).map_err(|_| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_plugin_package",
                "plugin permission authority is invalid",
                false,
                request_id,
            )
        })?,
    );
    if package.plugin_id().as_str() != confirmation.expected_plugin_id
        || package.manifest().version != confirmation.expected_version
        || package.package_sha256().as_str() != confirmation.expected_package_sha256
        || package.publisher_key_id().as_str() != confirmation.expected_publisher_key_id
        || permission_hash.as_str() != confirmation.expected_permission_hash
        || package.manifest().junban_compatibility != confirmation.expected_compatibility
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "plugin_confirmation_mismatch",
            "uploaded package does not match the exact inspected authority",
            false,
            request_id,
        ));
    }
    Ok(())
}

async fn resume_runtime(state: &ServerState, request_id: &RequestId) -> Result<(), ApiError> {
    state
        .start_plugin_runtime()
        .await
        .map_err(|error| plugin_error(error, request_id))
}

async fn stop_runtime(state: &ServerState, request_id: &RequestId) -> Result<(), ApiError> {
    state
        .plugin_runtime
        .shutdown()
        .await
        .map_err(|error| plugin_error(error, request_id))
}

fn deterministic_delivery_operation(root: OperationId) -> OperationId {
    let mut hasher = Sha256::new();
    hasher.update(DELIVERY_OPERATION_DOMAIN);
    hasher.update(root.as_uuid().as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    OperationId::parse(&Uuid::from_bytes(bytes).to_string()).expect("derived operation id")
}

fn canonical_invocation_body(
    request: &InvocationRequest,
    operation: OperationId,
) -> Result<Vec<u8>, PluginRuntimeError> {
    let (_, body) = request
        .clone()
        .into_parent_message(
            AuthorityFence {
                plugin_id: "payload-hash".to_owned(),
                package_generation: 1,
                activation_epoch: 1,
                host_session_id: operation.to_string(),
                invocation_id: operation.to_string(),
            },
            canonical_permission_hash(&[]).ok_or(PluginRuntimeError::AuthorityRejected)?,
        )
        .map_err(|_| PluginRuntimeError::AuthorityRejected)?
        .into_parts();
    Ok(body)
}

fn committed_invocation_response(committed: CommittedPluginInvocation) -> PluginInvocationResponse {
    let (status, rejection) = match committed.outcome {
        PluginInvocationPublicOutcome::Completed => ("completed", None),
        PluginInvocationPublicOutcome::Cancelled => ("cancelled", None),
        outcome => ("failed", Some(format!("{outcome:?}").to_ascii_lowercase())),
    };
    PluginInvocationResponse {
        status: status.to_owned(),
        terminal_kind: Some(format!("{:?}", committed.terminal_kind).to_ascii_lowercase()),
        revision: committed
            .mutation
            .as_ref()
            .map(|mutation| mutation.event.revision),
        rejection,
    }
}

fn reject_non_durable_invocation_terminal(
    _outcome: InvocationOutcome,
    request_id: &RequestId,
) -> Result<PluginInvocationResponse, ApiError> {
    Err(plugin_error(PluginRuntimeError::SessionLost, request_id))
}

async fn terminal_invocation_response(
    state: &ServerState,
    identity: PluginOperatorRequestIdentity,
    outcome: InvocationOutcome,
    request_id: &RequestId,
) -> Result<PluginInvocationResponse, ApiError> {
    if let Some(committed) = state
        .service
        .replay_completed_plugin_operator(identity, Timestamp::now())
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?
    {
        return Ok(committed_invocation_response(committed));
    }
    reject_non_durable_invocation_terminal(outcome, request_id)
}

#[utoipa::path(get, path = "/api/v1/plugins", operation_id = "list_plugins", responses((status = 200, body = PluginListResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn list_plugins(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
) -> Result<Json<PluginListResponse>, ApiError> {
    let profile = state
        .service
        .get_installed_plugin_profile()
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(PluginListResponse {
        plugins: profile.plugins.iter().map(installed_dto).collect(),
    }))
}

#[utoipa::path(get, path = "/api/v1/plugins/registry", operation_id = "list_plugin_registry", params(("query" = Option<String>, Query), ("capability" = Option<String>, Query)), responses((status = 200, body = RegistryListResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 503, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn list_plugin_registry(
    axum::Extension(request_id): axum::Extension<RequestId>,
    Query(query): Query<RegistrySearchQuery>,
) -> Result<Json<RegistryListResponse>, ApiError> {
    if query
        .query
        .as_ref()
        .is_some_and(|value| value.len() > 256 || value.chars().any(char::is_control))
        || query.capability.as_ref().is_some_and(|value| {
            value.len() > 64 || value.is_empty() || value.chars().any(char::is_control)
        })
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "registry search query is invalid",
            false,
            &request_id,
        ));
    }
    let registry = verified_registry(&request_id)?;
    let needle = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    let entries = registry
        .index()
        .entries
        .iter()
        .filter(|entry| {
            let text_matches = needle.as_ref().is_none_or(|needle| {
                entry.plugin_id.to_ascii_lowercase().contains(needle)
                    || entry.name.to_ascii_lowercase().contains(needle)
                    || entry.description.to_ascii_lowercase().contains(needle)
                    || entry.author.to_ascii_lowercase().contains(needle)
                    || entry.search_tags.iter().any(|tag| tag.contains(needle))
            });
            let capability_matches = query.capability.as_ref().is_none_or(|capability| {
                entry
                    .requested_capabilities
                    .iter()
                    .any(|value| value.as_str() == capability)
            });
            text_matches && capability_matches
        })
        .map(registry_dto)
        .collect();
    Ok(Json(RegistryListResponse {
        index_sha256: registry.index_sha256().to_owned(),
        entries,
    }))
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
pub struct RegistryVersionQuery {
    pub version: String,
}

#[utoipa::path(get, path = "/api/v1/plugins/registry/{plugin_id}", operation_id = "get_plugin_registry_entry", params(("plugin_id" = String, Path), ("version" = String, Query)), responses((status = 200, body = RegistryEntryDto), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 404, body = crate::error::ErrorEnvelope), (status = 503, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn get_plugin_registry_entry(
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath(plugin_id): AxumPath<String>,
    Query(version): Query<RegistryVersionQuery>,
) -> Result<Json<RegistryEntryDto>, ApiError> {
    parse_plugin_id(&plugin_id, &request_id)?;
    let registry = verified_registry(&request_id)?;
    let entry = registry
        .index()
        .entries
        .iter()
        .find(|entry| entry.plugin_id == plugin_id && entry.version == version.version)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "registry_entry_not_found",
                "bundled registry entry was not found",
                false,
                &request_id,
            )
        })?;
    Ok(Json(registry_dto(entry)))
}

#[utoipa::path(post, path = "/api/v1/plugins/registry/{plugin_id}/install", operation_id = "install_plugin_registry_entry", params(("plugin_id" = String, Path), ("Idempotency-Key" = String, Header, format = Uuid)), request_body = RegistryInstallBody, responses((status = 413, body = crate::error::ErrorEnvelope), (status = 200, body = PluginMutationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 404, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope), (status = 503, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn install_plugin_registry_entry(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath(plugin_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<RegistryInstallBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    let body = extract_json_with_limit(payload, &request_id, 32 * 1024)?;
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    let expected = parse_digest(
        &body.expected_package_sha256,
        "expected_package_sha256",
        &request_id,
    )?;
    let registry = verified_registry(&request_id)?;
    let entry = registry
        .index()
        .entries
        .iter()
        .find(|entry| entry.plugin_id == plugin_id.as_str() && entry.version == body.version)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "registry_entry_not_found",
                "bundled registry entry was not found",
                false,
                &request_id,
            )
        })?;
    if entry.package_sha256 != expected.as_str() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "registry_confirmation_mismatch",
            "registry entry does not match the exact confirmation",
            false,
            &request_id,
        ));
    }
    let package_bytes = BUNDLED_REGISTRY_PACKAGES
        .iter()
        .find_map(|(filename, bytes)| (*filename == entry.filename).then_some(*bytes))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "registry_package_unavailable",
                "bundled registry package is unavailable",
                false,
                &request_id,
            )
        })?;
    if package_bytes.len() as u64 != entry.package_size {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "registry_package_invalid",
            "bundled registry package is invalid",
            false,
            &request_id,
        ));
    }
    let permit = state.try_acquire_staged_artifact().ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "staged_artifact_busy",
            "another staged artifact operation is active",
            true,
            &request_id,
        )
    })?;
    let staging = prepare_plugin_staging(&state.profile_dir).map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "storage_error",
            "could not prepare plugin staging",
            true,
            &request_id,
        )
    })?;
    let staged_path = staging.join(format!(".registry-{}.jbp", Uuid::now_v7()));
    let staged_guard = StagedUploadGuard(staged_path.clone());
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut staged_file = options.open(&staged_path).await.map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "registry_package_unavailable",
            "could not create bundled registry staging file",
            true,
            &request_id,
        )
    })?;
    staged_file.write_all(package_bytes).await.map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "registry_package_unavailable",
            "could not stage bundled registry package",
            true,
            &request_id,
        )
    })?;
    staged_file.sync_all().await.map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "registry_package_unavailable",
            "could not durably stage bundled registry package",
            true,
            &request_id,
        )
    })?;
    drop(staged_file);
    let admission = inspect_staged(
        &state,
        staged_guard.into_staged(entry.package_size),
        &request_id,
    )
    .await?;
    let verified = junban_app::VerifiedBundledPluginAdmission::new(
        admission,
        &registry,
        &plugin_id,
        &body.version,
    )
    .map_err(|_| {
        ApiError::new(
            StatusCode::CONFLICT,
            "registry_package_mismatch",
            "bundled registry package does not match the signed index",
            false,
            &request_id,
        )
    })?;
    let _transition = state.plugin_reconfigure.lock().await;
    stop_runtime(&state, &request_id).await?;
    let result = state
        .service
        .install_bundled_plugin_admission(
            operation,
            verified,
            body.replace_existing,
            body.allow_downgrade,
            Timestamp::now(),
        )
        .await
        .map_err(|error| ApiError::from_app(error, &request_id));
    drop(permit);
    let resume = resume_runtime(&state, &request_id).await;
    let mutation = mutation_error(result?, &request_id)?;
    resume?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(get, path = "/api/v1/plugins/{plugin_id}", operation_id = "get_plugin", params(("plugin_id" = String, Path)), responses((status = 200, body = InstalledPluginDto), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 404, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn get_plugin(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath(plugin_id): AxumPath<String>,
) -> Result<Json<InstalledPluginDto>, ApiError> {
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    let plugin = state
        .service
        .get_installed_plugin(plugin_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(installed_dto(&plugin)))
}

#[utoipa::path(post, path = "/api/v1/plugins/packages/inspect", operation_id = "inspect_plugin_package", request_body(content_type = "application/octet-stream"), responses((status = 200, body = PluginPackagePreviewResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 413, body = crate::error::ErrorEnvelope), (status = 422, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn inspect_plugin_package(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<PluginPackagePreviewResponse>, ApiError> {
    let (staged, _permit) = stage_package_upload(&state, &headers, body, &request_id).await?;
    let admission = inspect_staged(&state, staged, &request_id).await?;
    let preview = preview_from_admission(&state, &admission)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(preview))
}

#[utoipa::path(post, path = "/api/v1/plugins/packages/install", operation_id = "install_plugin_package", params(PluginInstallConfirmation, ("Idempotency-Key" = String, Header, format = Uuid)), request_body(content_type = "application/octet-stream"), responses((status = 200, body = PluginMutationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope), (status = 413, body = crate::error::ErrorEnvelope), (status = 422, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn install_plugin_package(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    Query(confirmation): Query<PluginInstallConfirmation>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    parse_plugin_id(&confirmation.expected_plugin_id, &request_id)?;
    parse_digest(
        &confirmation.expected_package_sha256,
        "expected_package_sha256",
        &request_id,
    )?;
    parse_digest(
        &confirmation.expected_publisher_key_id,
        "expected_publisher_key_id",
        &request_id,
    )?;
    parse_digest(
        &confirmation.expected_permission_hash,
        "expected_permission_hash",
        &request_id,
    )?;
    let (staged, _permit) = stage_package_upload(&state, &headers, body, &request_id).await?;
    let admission = inspect_staged(&state, staged, &request_id).await?;
    exact_confirmation(admission.package(), &confirmation, &request_id)?;
    let _transition = state.plugin_reconfigure.lock().await;
    stop_runtime(&state, &request_id).await?;
    let outcome = state
        .service
        .install_plugin_admission(
            operation,
            admission,
            PluginInstallSource::LocalPackage,
            confirmation.replace_existing,
            confirmation.allow_downgrade,
            Timestamp::now(),
        )
        .await;
    let result = match outcome {
        Ok(outcome) => mutation_error(outcome, &request_id),
        Err(error) => Err(ApiError::from_app(error, &request_id)),
    };
    let resume = resume_runtime(&state, &request_id).await;
    let mutation = result?;
    resume?;
    Ok(Json(mutation.into()))
}

async fn desired_enabled(
    state: ServerState,
    request_id: RequestId,
    plugin_id: String,
    headers: HeaderMap,
    enabled: bool,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    let _transition = state.plugin_reconfigure.lock().await;
    stop_runtime(&state, &request_id).await?;
    let outcome = state
        .service
        .set_plugin_desired_enabled(operation, plugin_id.clone(), enabled, Timestamp::now())
        .await;
    let result = match outcome {
        Ok(value) => mutation_error(value, &request_id),
        Err(error) => Err(ApiError::from_app(error, &request_id)),
    };
    let resume = resume_runtime(&state, &request_id).await;
    let mutation = result?;
    resume?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(post, path = "/api/v1/plugins/{plugin_id}/enable", operation_id = "enable_plugin", params(("plugin_id" = String, Path), ("Idempotency-Key" = String, Header, format = Uuid)), responses((status = 200, body = PluginMutationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn enable_plugin(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath(plugin_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    desired_enabled(state, request_id, plugin_id, headers, true).await
}

#[utoipa::path(post, path = "/api/v1/plugins/{plugin_id}/disable", operation_id = "disable_plugin", params(("plugin_id" = String, Path), ("Idempotency-Key" = String, Header, format = Uuid)), responses((status = 200, body = PluginMutationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn disable_plugin(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath(plugin_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    desired_enabled(state, request_id, plugin_id, headers, false).await
}

#[utoipa::path(post, path = "/api/v1/plugins/{plugin_id}/retry", operation_id = "retry_plugin", params(("plugin_id" = String, Path), ("Idempotency-Key" = String, Header, format = Uuid)), responses((status = 200, body = PluginMutationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn retry_plugin(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath(plugin_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    let _transition = state.plugin_reconfigure.lock().await;
    stop_runtime(&state, &request_id).await?;
    let result = state
        .service
        .retry_plugin(operation, plugin_id.clone(), Timestamp::now())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id));
    let resume = resume_runtime(&state, &request_id).await;
    let mutation = result?;
    resume?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(delete, path = "/api/v1/plugins/{plugin_id}", operation_id = "uninstall_plugin", params(("plugin_id" = String, Path), ("Idempotency-Key" = String, Header, format = Uuid)), responses((status = 200, body = PluginMutationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn uninstall_plugin(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath(plugin_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    let _transition = state.plugin_reconfigure.lock().await;
    stop_runtime(&state, &request_id).await?;
    let outcome = state
        .service
        .uninstall_plugin(operation, plugin_id, Timestamp::now())
        .await;
    let result = match outcome {
        Ok(value) => mutation_error(value, &request_id),
        Err(error) => Err(ApiError::from_app(error, &request_id)),
    };
    let resume = resume_runtime(&state, &request_id).await;
    let mutation = result?;
    resume?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(get, path = "/api/v1/plugins/publishers", operation_id = "list_plugin_publishers", responses((status = 200, body = PublisherTrustListResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn list_plugin_publishers(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
) -> Result<Json<PublisherTrustListResponse>, ApiError> {
    let values = state
        .service
        .list_publisher_trust()
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(PublisherTrustListResponse {
        publishers: values
            .iter()
            .map(|value| PublisherTrustDto {
                key_id: value.key_id.to_string(),
                public_key_base64: STANDARD.encode(value.public_key),
                status: match value.status {
                    PublisherTrustStatus::Active => "active",
                    PublisherTrustStatus::Revoked => "revoked",
                }
                .to_owned(),
                trusted_at: value.trusted_at.to_string(),
                revoked_at: value.revoked_at.map(|time| time.to_string()),
            })
            .collect(),
    }))
}

#[utoipa::path(put, path = "/api/v1/plugins/publishers/{key_id}", operation_id = "trust_plugin_publisher", params(("key_id" = String, Path), ("Idempotency-Key" = String, Header, format = Uuid)), request_body = TrustPublisherBody, responses((status = 413, body = crate::error::ErrorEnvelope), (status = 200, body = PluginMutationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 422, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn trust_plugin_publisher(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath(key_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<TrustPublisherBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    let body = extract_json_with_limit(payload, &request_id, 32 * 1024)?;
    let key_id = parse_digest(&key_id, "key_id", &request_id)?;
    let decoded = STANDARD
        .decode(body.public_key_base64.as_bytes())
        .map_err(|_| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                "publisher public key is invalid",
                false,
                &request_id,
            )
        })?;
    let public_key: [u8; 32] = decoded.try_into().map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "publisher public key is invalid",
            false,
            &request_id,
        )
    })?;
    let request = TrustPublisherRequest::new(public_key);
    if request.key_id != key_id {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "publisher_key_mismatch",
            "publisher key does not match its fingerprint",
            false,
            &request_id,
        ));
    }
    let mutation = state
        .service
        .trust_publisher(operation, request, Timestamp::now())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(delete, path = "/api/v1/plugins/publishers/{key_id}", operation_id = "revoke_plugin_publisher", params(("key_id" = String, Path), ("Idempotency-Key" = String, Header, format = Uuid)), responses((status = 200, body = PluginMutationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn revoke_plugin_publisher(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath(key_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    let key_id = parse_digest(&key_id, "key_id", &request_id)?;
    let _transition = state.plugin_reconfigure.lock().await;
    stop_runtime(&state, &request_id).await?;
    let result = state
        .service
        .revoke_publisher(operation, key_id, Timestamp::now())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id));
    let resume = resume_runtime(&state, &request_id).await;
    let mutation = result?;
    resume?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(get, path = "/api/v1/plugins/community-policy", operation_id = "get_plugin_community_policy", responses((status = 200, body = CommunityPolicyResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn get_plugin_community_policy(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
) -> Result<Json<CommunityPolicyResponse>, ApiError> {
    let policy = state
        .service
        .get_community_plugin_policy()
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(CommunityPolicyResponse {
        enabled: policy.community_registry_enabled,
        updated_at: policy.updated_at.to_string(),
    }))
}

#[utoipa::path(put, path = "/api/v1/plugins/community-policy", operation_id = "set_plugin_community_policy", params(("Idempotency-Key" = String, Header, format = Uuid)), request_body = CommunityPolicyBody, responses((status = 413, body = crate::error::ErrorEnvelope), (status = 200, body = PluginMutationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn set_plugin_community_policy(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    headers: HeaderMap,
    payload: Result<Json<CommunityPolicyBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    let body = extract_json_with_limit(payload, &request_id, 32 * 1024)?;
    let mutation = state
        .service
        .set_community_plugin_policy(operation, body.enabled, Timestamp::now())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(get, path = "/api/v1/plugins/{plugin_id}/grants", operation_id = "list_plugin_grants", params(("plugin_id" = String, Path)), responses((status = 200, body = PluginGrantListResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn list_plugin_grants(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath(plugin_id): AxumPath<String>,
) -> Result<Json<PluginGrantListResponse>, ApiError> {
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    let values = state
        .service
        .list_plugin_grants(plugin_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(PluginGrantListResponse {
        grants: values
            .iter()
            .map(|value| PluginGrantDto {
                package_generation: value.package_generation,
                permission_hash: value.permission_hash.to_string(),
                permission: PluginPermissionDto::from(&value.permission),
                granted_at: value.granted_at.to_string(),
            })
            .collect(),
    }))
}

#[utoipa::path(put, path = "/api/v1/plugins/{plugin_id}/grants", operation_id = "replace_plugin_grants", params(("plugin_id" = String, Path), ("Idempotency-Key" = String, Header, format = Uuid)), request_body = ReplacePluginGrantsBody, responses((status = 413, body = crate::error::ErrorEnvelope), (status = 200, body = PluginMutationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope), (status = 422, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn replace_plugin_grants(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath(plugin_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Result<Json<ReplacePluginGrantsBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    let body = extract_json_with_limit(payload, &request_id, 32 * 1024)?;
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    if body.permissions.len() > PLUGIN_REQUEST_ITEMS_MAX {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "too many plugin grants were provided",
            false,
            &request_id,
        ));
    }
    let permissions: Vec<Permission> = body.permissions.into_iter().map(Into::into).collect();
    if let Some(mutation) = state
        .service
        .replay_plugin_mutation(
            PluginMutationRequestIdentity::ReplaceGrants {
                operation_id: operation,
                plugin_id: plugin_id.clone(),
                package_generation: body.package_generation,
                permissions: permissions.clone(),
            },
            Timestamp::now(),
        )
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?
    {
        return Ok(Json(mutation.into()));
    }
    let plugin = state
        .service
        .get_installed_plugin(plugin_id.clone())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let request = ReplacePluginGrantsRequest::new(
        plugin_id.clone(),
        body.package_generation,
        &plugin.manifest.permissions,
        permissions,
    )
    .map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "permission grants are invalid",
            false,
            &request_id,
        )
    })?;
    let _transition = state.plugin_reconfigure.lock().await;
    stop_runtime(&state, &request_id).await?;
    let result = state
        .service
        .replace_plugin_grants(operation, request, Timestamp::now())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id));
    let resume = resume_runtime(&state, &request_id).await;
    let mutation = result?;
    resume?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(delete, path = "/api/v1/plugins/{plugin_id}/grants", operation_id = "revoke_plugin_grants", params(("plugin_id" = String, Path), ("package_generation" = u64, Query), ("Idempotency-Key" = String, Header, format = Uuid)), responses((status = 200, body = PluginMutationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn revoke_plugin_grants(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath(plugin_id): AxumPath<String>,
    Query(query): Query<GenerationQuery>,
    headers: HeaderMap,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    if let Some(mutation) = state
        .service
        .replay_plugin_mutation(
            PluginMutationRequestIdentity::RevokeGrants {
                operation_id: operation,
                plugin_id: plugin_id.clone(),
                package_generation: query.package_generation,
            },
            Timestamp::now(),
        )
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?
    {
        return Ok(Json(mutation.into()));
    }
    let plugin = state
        .service
        .get_installed_plugin(plugin_id.clone())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let request = RevokePluginGrantsRequest {
        plugin_id: plugin_id.clone(),
        package_generation: query.package_generation,
        permission_hash: Sha256Digest::from_bytes(
            permission_set_hash(&plugin.manifest.permissions).map_err(|_| {
                ApiError::new(
                    StatusCode::CONFLICT,
                    "plugin_authority_invalid",
                    "plugin authority is invalid",
                    false,
                    &request_id,
                )
            })?,
        ),
    };
    let _transition = state.plugin_reconfigure.lock().await;
    stop_runtime(&state, &request_id).await?;
    let result = state
        .service
        .revoke_plugin_grants(operation, request, Timestamp::now())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id));
    let resume = resume_runtime(&state, &request_id).await;
    let mutation = result?;
    resume?;
    Ok(Json(mutation.into()))
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
pub struct GenerationQuery {
    pub package_generation: u64,
}

#[utoipa::path(get, path = "/api/v1/plugins/{plugin_id}/settings", operation_id = "list_plugin_settings", params(("plugin_id" = String, Path)), responses((status = 200, body = PluginSettingListResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn list_plugin_settings(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath(plugin_id): AxumPath<String>,
) -> Result<Json<PluginSettingListResponse>, ApiError> {
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    let values = state
        .service
        .list_plugin_settings(plugin_id)
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    Ok(Json(PluginSettingListResponse {
        settings: values
            .iter()
            .map(|value| PluginSettingDto {
                key: value.key.to_string(),
                value: (&value.value).into(),
                updated_at: value.updated_at.to_string(),
            })
            .collect(),
    }))
}

fn manifest_setting_default(schema: &SettingSchema) -> Option<ManifestSettingValue> {
    match schema {
        SettingSchema::Text {
            default,
            secret: false,
            ..
        } => Some(ManifestSettingValue::Text(default.clone())),
        SettingSchema::Integer { default, .. } => Some(ManifestSettingValue::Integer(*default)),
        SettingSchema::Boolean { default } => Some(ManifestSettingValue::Boolean(*default)),
        SettingSchema::Select { default, .. } => Some(ManifestSettingValue::Text(default.clone())),
        SettingSchema::Text { secret: true, .. } => None,
    }
}

fn guest_setting_value(
    schema: &SettingSchema,
    value: ManifestSettingValue,
) -> Option<GuestSettingValue> {
    match (schema, value) {
        (SettingSchema::Text { secret: false, .. }, ManifestSettingValue::Text(value)) => {
            Some(GuestSettingValue::Text(value))
        }
        (SettingSchema::Integer { .. }, ManifestSettingValue::Integer(value)) => {
            Some(GuestSettingValue::Integer(value))
        }
        (SettingSchema::Boolean { .. }, ManifestSettingValue::Boolean(value)) => {
            Some(GuestSettingValue::Boolean(value))
        }
        (SettingSchema::Select { .. }, ManifestSettingValue::Text(value)) => {
            Some(GuestSettingValue::OptionId(value))
        }
        _ => None,
    }
}

fn plugin_settings_authority_invalid(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "plugin_settings_authority_invalid",
        "plugin settings authority is invalid",
        false,
        request_id,
    )
}

fn effective_candidate_settings(
    manifest: &RuntimeManifest,
    persisted: &[PluginSetting],
    key: &PluginId,
    value: Option<&ManifestSettingValue>,
    request_id: &RequestId,
) -> Result<SettingValues, ApiError> {
    manifest
        .validate()
        .map_err(|_| plugin_settings_authority_invalid(request_id))?;
    let candidate = manifest
        .settings
        .iter()
        .find(|declaration| declaration.id == key.as_str())
        .ok_or_else(|| plugin_settings_authority_invalid(request_id))?;
    if value.is_some_and(|value| candidate.schema.validate_persisted_value(value).is_err()) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "plugin_settings_rejected",
            "plugin rejected candidate settings",
            false,
            request_id,
        ));
    }

    let mut seen = std::collections::BTreeSet::new();
    for setting in persisted {
        if !seen.insert(setting.key.as_str())
            || manifest
                .validate_persisted_setting(setting.key.as_str(), &setting.value)
                .is_err()
        {
            return Err(plugin_settings_authority_invalid(request_id));
        }
    }

    let values = manifest
        .settings
        .iter()
        .map(|declaration| {
            let effective = if declaration.id == key.as_str() {
                value
                    .cloned()
                    .or_else(|| manifest_setting_default(&declaration.schema))
            } else {
                persisted
                    .iter()
                    .find(|setting| setting.key.as_str() == declaration.id)
                    .map(|setting| setting.value.clone())
                    .or_else(|| manifest_setting_default(&declaration.schema))
            }
            .ok_or_else(|| plugin_settings_authority_invalid(request_id))?;
            let value = guest_setting_value(&declaration.schema, effective)
                .ok_or_else(|| plugin_settings_authority_invalid(request_id))?;
            Ok(NamedSetting {
                id: declaration.id.clone(),
                value,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(SettingValues { values })
}

async fn validate_candidate_settings(
    state: &ServerState,
    plugin: &InstalledPlugin,
    key: PluginId,
    value: Option<ManifestSettingValue>,
    request_id: &RequestId,
) -> Result<(), ApiError> {
    let settings = state
        .service
        .list_plugin_settings(plugin.plugin_id.clone())
        .await
        .map_err(|error| ApiError::from_app(error, request_id))?;
    let request = InvocationRequest::validate_settings(
        None,
        effective_candidate_settings(
            &plugin.manifest,
            &settings,
            &key,
            value.as_ref(),
            request_id,
        )?,
    );
    let handle = state
        .plugin_runtime
        .invoke_transient(plugin.plugin_id.clone(), request)
        .await
        .map_err(|error| plugin_error(error, request_id))?;
    let outcome = handle
        .outcome()
        .await
        .map_err(|error| plugin_error(error, request_id))?;
    match outcome {
        InvocationOutcome::Completed(outcome) => match *outcome {
            GuestInvocationOutcome::ValidateSettings(WitResult::Ok(issues))
                if issues.is_empty() =>
            {
                Ok(())
            }
            GuestInvocationOutcome::ValidateSettings(WitResult::Ok(_)) => Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "plugin_settings_rejected",
                "plugin rejected candidate settings",
                false,
                request_id,
            )),
            GuestInvocationOutcome::ValidateSettings(WitResult::Err(_)) => Err(ApiError::new(
                StatusCode::CONFLICT,
                "plugin_settings_validation_failed",
                "plugin could not validate candidate settings",
                false,
                request_id,
            )),
            _ => Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "plugin_runtime_invalid_output",
                "plugin returned an invalid settings result",
                false,
                request_id,
            )),
        },
        _ => Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "plugin_runtime_unavailable",
            "plugin settings validation failed",
            true,
            request_id,
        )),
    }
}

#[utoipa::path(put, path = "/api/v1/plugins/{plugin_id}/settings/{key}", operation_id = "set_plugin_setting", params(("plugin_id" = String, Path), ("key" = String, Path), ("Idempotency-Key" = String, Header, format = Uuid)), request_body = SetPluginSettingBody, responses((status = 413, body = crate::error::ErrorEnvelope), (status = 200, body = PluginMutationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope), (status = 422, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn set_plugin_setting(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath((plugin_id, key)): AxumPath<(String, String)>,
    headers: HeaderMap,
    payload: Result<Json<SetPluginSettingBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    let body = extract_json_with_limit(payload, &request_id, 64 * 1024)?;
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    let key = parse_plugin_id(&key, &request_id)?;
    let value: ManifestSettingValue = body.value.into();
    let setting_request = SetPluginSettingRequest {
        plugin_id: plugin_id.clone(),
        package_generation: body.package_generation,
        key: key.clone(),
        value: value.clone(),
    };
    if let Some(mutation) = state
        .service
        .replay_plugin_mutation(
            PluginMutationRequestIdentity::SetSetting {
                operation_id: operation,
                request: setting_request.clone(),
            },
            Timestamp::now(),
        )
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?
    {
        return Ok(Json(mutation.into()));
    }
    let _transition = state.plugin_reconfigure.lock().await;
    let plugin = state
        .service
        .get_installed_plugin(plugin_id.clone())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    if plugin.package_generation != body.package_generation {
        return Err(plugin_error(
            PluginRuntimeError::AuthorityRejected,
            &request_id,
        ));
    }
    validate_candidate_settings(
        &state,
        &plugin,
        key.clone(),
        Some(value.clone()),
        &request_id,
    )
    .await?;
    stop_runtime(&state, &request_id).await?;
    let result = state
        .service
        .set_plugin_setting(operation, setting_request, Timestamp::now())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id));
    let resume = resume_runtime(&state, &request_id).await;
    let mutation = result?;
    resume?;
    Ok(Json(mutation.into()))
}

#[utoipa::path(delete, path = "/api/v1/plugins/{plugin_id}/settings/{key}", operation_id = "delete_plugin_setting", params(("plugin_id" = String, Path), ("key" = String, Path), ("package_generation" = u64, Query), ("Idempotency-Key" = String, Header, format = Uuid)), responses((status = 200, body = PluginMutationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn delete_plugin_setting(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath((plugin_id, key)): AxumPath<(String, String)>,
    Query(query): Query<GenerationQuery>,
    headers: HeaderMap,
) -> Result<Json<PluginMutationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    let key = parse_plugin_id(&key, &request_id)?;
    let setting_request = DeletePluginSettingRequest {
        plugin_id: plugin_id.clone(),
        package_generation: query.package_generation,
        key: key.clone(),
    };
    if let Some(mutation) = state
        .service
        .replay_plugin_mutation(
            PluginMutationRequestIdentity::DeleteSetting {
                operation_id: operation,
                request: setting_request.clone(),
            },
            Timestamp::now(),
        )
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?
    {
        return Ok(Json(mutation.into()));
    }
    let _transition = state.plugin_reconfigure.lock().await;
    let plugin = state
        .service
        .get_installed_plugin(plugin_id.clone())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    if plugin.package_generation != query.package_generation {
        return Err(plugin_error(
            PluginRuntimeError::AuthorityRejected,
            &request_id,
        ));
    }
    validate_candidate_settings(&state, &plugin, key.clone(), None, &request_id).await?;
    stop_runtime(&state, &request_id).await?;
    let result = state
        .service
        .delete_plugin_setting(operation, setting_request, Timestamp::now())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id));
    let resume = resume_runtime(&state, &request_id).await;
    let mutation = result?;
    resume?;
    Ok(Json(mutation.into()))
}

fn contributions(
    plugin: &InstalledPlugin,
    host_session_id: OperationId,
) -> Vec<PluginContributionDto> {
    let mut result = Vec::new();
    for command in &plugin.manifest.commands {
        result.push(PluginContributionDto {
            contribution_id: format!("{}:{}", plugin.plugin_id, command.id),
            plugin_id: plugin.plugin_id.to_string(),
            local_id: command.id.clone(),
            kind: "command".to_owned(),
            title: command.title.clone(),
            description: Some(command.description.clone()),
            location: None,
            actions: Vec::new(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            host_session_id: host_session_id.to_string(),
        });
    }
    for surface in &plugin.manifest.surfaces {
        result.push(PluginContributionDto {
            contribution_id: format!("{}:{}", plugin.plugin_id, surface.id),
            plugin_id: plugin.plugin_id.to_string(),
            local_id: surface.id.clone(),
            kind: format!("{:?}", surface.kind).to_ascii_lowercase(),
            title: surface.title.clone(),
            description: None,
            location: Some(format!("{:?}", surface.location).to_ascii_lowercase()),
            actions: surface.actions.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            host_session_id: host_session_id.to_string(),
        });
    }
    result
}

#[utoipa::path(get, path = "/api/v1/plugins/contributions", operation_id = "list_plugin_contributions", responses((status = 200, body = PluginContributionListResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 503, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn list_plugin_contributions(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
) -> Result<Json<PluginContributionListResponse>, ApiError> {
    let _transition = state.plugin_reconfigure.lock().await;
    let snapshot = state
        .plugin_runtime
        .reconcile()
        .await
        .map_err(|error| plugin_error(error, &request_id))?;
    if snapshot.lifecycle == PluginRuntimeLifecycle::Dormant {
        return Ok(Json(PluginContributionListResponse {
            contributions: Vec::new(),
        }));
    }
    let session = snapshot
        .host_session_id
        .ok_or_else(|| plugin_error(PluginRuntimeError::Dormant, &request_id))?;
    let profile = state
        .service
        .get_installed_plugin_profile()
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    let mut values = Vec::new();
    for plugin in &profile.plugins {
        if snapshot.admitting_plugins.contains(&plugin.plugin_id) {
            values.extend(contributions(plugin, session));
        }
    }
    values.sort_by(|left, right| left.contribution_id.cmp(&right.contribution_id));
    Ok(Json(PluginContributionListResponse {
        contributions: values,
    }))
}

#[utoipa::path(post, path = "/api/v1/plugins/{plugin_id}/surfaces/{surface_id}/render", operation_id = "render_plugin_surface", params(("plugin_id" = String, Path), ("surface_id" = String, Path)), request_body = ContributionFenceBody, responses((status = 413, body = crate::error::ErrorEnvelope), (status = 200, body = RenderPluginContributionResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn render_plugin_surface(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath((plugin_id, surface_id)): AxumPath<(String, String)>,
    payload: Result<Json<ContributionFenceBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<RenderPluginContributionResponse>, ApiError> {
    let body = extract_json_with_limit(payload, &request_id, 32 * 1024)?;
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    let surface_id = parse_plugin_id(&surface_id, &request_id)?;
    let session = OperationId::parse(&body.host_session_id)
        .map_err(|_| plugin_error(PluginRuntimeError::AuthorityRejected, &request_id))?;
    let _transition = state.plugin_reconfigure.lock().await;
    let plugin = state
        .service
        .get_installed_plugin(plugin_id.clone())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    if plugin.package_generation != body.package_generation
        || plugin.activation_epoch != body.activation_epoch
    {
        return Err(plugin_error(
            PluginRuntimeError::AuthorityRejected,
            &request_id,
        ));
    }
    let request = InvocationRequest::render_surface(
        Some(surface_id.to_string()),
        SurfaceRequest {
            surface_id: surface_id.to_string(),
        },
    );
    let handle = state
        .plugin_runtime
        .invoke_transient_fenced(plugin_id.clone(), Some(session), request)
        .await
        .map_err(|error| plugin_error(error, &request_id))?;
    let outcome = handle
        .outcome()
        .await
        .map_err(|error| plugin_error(error, &request_id))?;
    let surface = match outcome {
        InvocationOutcome::Completed(outcome) => match *outcome {
            GuestInvocationOutcome::RenderSurface(WitResult::Ok(surface)) => surface,
            _ => {
                return Err(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "plugin_render_failed",
                    "plugin could not render the contribution",
                    false,
                    &request_id,
                ));
            }
        },
        _ => {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "plugin_render_failed",
                "plugin could not render the contribution",
                true,
                &request_id,
            ));
        }
    };
    Ok(Json(RenderPluginContributionResponse {
        plugin_id: plugin_id.to_string(),
        surface_id: surface_id.to_string(),
        package_generation: plugin.package_generation,
        activation_epoch: plugin.activation_epoch,
        host_session_id: session.to_string(),
        surface: json_value(&surface),
    }))
}

#[utoipa::path(post, path = "/api/v1/plugins/{plugin_id}/commands/{command_id}", operation_id = "invoke_plugin_command", params(("plugin_id" = String, Path), ("command_id" = String, Path), ("Idempotency-Key" = String, Header, format = Uuid)), request_body = InvokePluginCommandBody, responses((status = 413, body = crate::error::ErrorEnvelope), (status = 200, body = PluginInvocationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope), (status = 503, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn invoke_plugin_command(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath((plugin_id, command_id)): AxumPath<(String, String)>,
    headers: HeaderMap,
    payload: Result<Json<InvokePluginCommandBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<PluginInvocationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    let body = extract_json_with_limit(payload, &request_id, 32 * 1024)?;
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    let command_id = parse_plugin_id(&command_id, &request_id)?;
    if body.values.len() > PLUGIN_REQUEST_ITEMS_MAX {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "too many command values were provided",
            false,
            &request_id,
        ));
    }
    let values: Vec<NamedValue> = body.values.into_iter().map(Into::into).collect();
    let request = InvocationRequest::invoke_command(
        Some(command_id.to_string()),
        CommandCall {
            command_id: command_id.to_string(),
            values,
        },
    );
    let private_body = canonical_invocation_body(&request, operation)
        .map_err(|error| plugin_error(error, &request_id))?;
    let identity = PluginOperatorRequestIdentity::from_canonical_private_body(
        operation,
        plugin_id.clone(),
        PluginHookKind::InvokeCommand,
        command_id.clone(),
        command_id.as_str(),
        &private_body,
    )
    .map_err(|_| plugin_error(PluginRuntimeError::AuthorityRejected, &request_id))?;
    if let Some(committed) = state
        .service
        .replay_completed_plugin_operator(identity.clone(), Timestamp::now())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?
    {
        return Ok(Json(committed_invocation_response(committed)));
    }
    let session = OperationId::parse(&body.host_session_id)
        .map_err(|_| plugin_error(PluginRuntimeError::AuthorityRejected, &request_id))?;
    let payload_sha256 = Sha256Digest::of(&private_body);
    let _transition = state.plugin_reconfigure.lock().await;
    let plugin = state
        .service
        .get_installed_plugin(plugin_id.clone())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    if plugin.package_generation != body.package_generation
        || plugin.activation_epoch != body.activation_epoch
    {
        return Err(plugin_error(
            PluginRuntimeError::AuthorityRejected,
            &request_id,
        ));
    }
    let handle = state
        .plugin_runtime
        .invoke(PluginInvocationDispatch {
            operation_id: operation,
            plugin_id,
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::InvokeCommand,
            entry: PluginManifestEntry::Command { command_id },
            payload_sha256,
            delivery_operation_id: deterministic_delivery_operation(operation),
            mode: junban_app::PluginDeliveryMode::Active,
            retained_event_source: None,
            expected_host_session_id: Some(session),
            request,
        })
        .await
        .map_err(|error| plugin_error(error, &request_id))?;
    let outcome = handle
        .outcome()
        .await
        .map_err(|error| plugin_error(error, &request_id))?;
    Ok(Json(
        terminal_invocation_response(&state, identity, outcome, &request_id).await?,
    ))
}

#[utoipa::path(post, path = "/api/v1/plugins/{plugin_id}/surfaces/{surface_id}/actions/{action_id}", operation_id = "invoke_plugin_surface_action", params(("plugin_id" = String, Path), ("surface_id" = String, Path), ("action_id" = String, Path), ("Idempotency-Key" = String, Header, format = Uuid)), request_body = InvokePluginActionBody, responses((status = 413, body = crate::error::ErrorEnvelope), (status = 200, body = PluginInvocationResponse), (status = 401, body = crate::error::ErrorEnvelope), (status = 403, body = crate::error::ErrorEnvelope), (status = 409, body = crate::error::ErrorEnvelope), (status = 503, body = crate::error::ErrorEnvelope)), security(("bearer_auth" = [])))]
pub async fn invoke_plugin_surface_action(
    State(state): State<ServerState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    AxumPath((plugin_id, surface_id, action_id)): AxumPath<(String, String, String)>,
    headers: HeaderMap,
    payload: Result<Json<InvokePluginActionBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<PluginInvocationResponse>, ApiError> {
    let operation = operation_id(&headers, &request_id)?;
    let body = extract_json_with_limit(payload, &request_id, 32 * 1024)?;
    let plugin_id = parse_plugin_id(&plugin_id, &request_id)?;
    let surface_id = parse_plugin_id(&surface_id, &request_id)?;
    let action_id = parse_plugin_id(&action_id, &request_id)?;
    if body.values.len() > PLUGIN_REQUEST_ITEMS_MAX {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "too many action values were provided",
            false,
            &request_id,
        ));
    }
    let values: Vec<ScalarNamedValue> = body.values.into_iter().map(Into::into).collect();
    let entry = PluginManifestEntry::SurfaceAction {
        surface_id: surface_id.clone(),
        action_id: action_id.clone(),
    };
    let persisted_entry_id = junban_app::plugin_manifest_entry_persisted_id(&entry)
        .ok_or_else(|| plugin_error(PluginRuntimeError::AuthorityRejected, &request_id))?;
    let request = InvocationRequest::handle_surface_action(
        Some(surface_id.to_string()),
        SurfaceAction {
            surface_id: surface_id.to_string(),
            action_id: action_id.to_string(),
            values,
        },
    );
    let private_body = canonical_invocation_body(&request, operation)
        .map_err(|error| plugin_error(error, &request_id))?;
    let identity = PluginOperatorRequestIdentity::from_canonical_private_body(
        operation,
        plugin_id.clone(),
        PluginHookKind::HandleSurfaceAction,
        persisted_entry_id,
        surface_id.as_str(),
        &private_body,
    )
    .map_err(|_| plugin_error(PluginRuntimeError::AuthorityRejected, &request_id))?;
    if let Some(committed) = state
        .service
        .replay_completed_plugin_operator(identity.clone(), Timestamp::now())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?
    {
        return Ok(Json(committed_invocation_response(committed)));
    }
    let session = OperationId::parse(&body.host_session_id)
        .map_err(|_| plugin_error(PluginRuntimeError::AuthorityRejected, &request_id))?;
    let payload_sha256 = Sha256Digest::of(&private_body);
    let _transition = state.plugin_reconfigure.lock().await;
    let plugin = state
        .service
        .get_installed_plugin(plugin_id.clone())
        .await
        .map_err(|error| ApiError::from_app(error, &request_id))?;
    if plugin.package_generation != body.package_generation
        || plugin.activation_epoch != body.activation_epoch
    {
        return Err(plugin_error(
            PluginRuntimeError::AuthorityRejected,
            &request_id,
        ));
    }
    let handle = state
        .plugin_runtime
        .invoke(PluginInvocationDispatch {
            operation_id: operation,
            plugin_id,
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::HandleSurfaceAction,
            entry,
            payload_sha256,
            delivery_operation_id: deterministic_delivery_operation(operation),
            mode: junban_app::PluginDeliveryMode::Active,
            retained_event_source: None,
            expected_host_session_id: Some(session),
            request,
        })
        .await
        .map_err(|error| plugin_error(error, &request_id))?;
    let outcome = handle
        .outcome()
        .await
        .map_err(|error| plugin_error(error, &request_id))?;
    Ok(Json(
        terminal_invocation_response(&state, identity, outcome, &request_id).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use junban_app::{
        AffectedIds, CommittedEvent, CommittedMutation, EventType, PluginGuestEffectRejection,
        PluginInvocationTerminalKind, ResyncScope,
    };
    use junban_plugin_sdk::{
        PermissionScope, Publisher, RuntimeProfile, SettingDeclaration, SettingOption,
        UnscopedPermission, WitAuthority, private_body_types::PluginOutcome,
    };

    fn committed(
        outcome: PluginInvocationPublicOutcome,
        terminal_kind: PluginInvocationTerminalKind,
    ) -> CommittedPluginInvocation {
        CommittedPluginInvocation {
            outcome,
            terminal_kind,
            mutation: None,
            cursor: None,
            rejection: None,
            replayed: false,
        }
    }

    fn response_bytes(committed: CommittedPluginInvocation) -> Vec<u8> {
        serde_json::to_vec(&committed_invocation_response(committed)).unwrap()
    }

    fn assert_initial_and_replay_bytes(
        initial: CommittedPluginInvocation,
        expected: serde_json::Value,
    ) {
        let initial_bytes = response_bytes(initial.clone());
        let mut replay = initial;
        replay.replayed = true;
        assert_eq!(response_bytes(replay), initial_bytes);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&initial_bytes).unwrap(),
            expected
        );
    }

    fn pomodoro_settings_manifest() -> RuntimeManifest {
        RuntimeManifest {
            schema_version: 1,
            id: "pomodoro-settings".to_owned(),
            name: "Pomodoro settings".to_owned(),
            description: "Settings validation fixture".to_owned(),
            version: "1.0.0".to_owned(),
            publisher: Publisher {
                id: "publisher".to_owned(),
                name: "Publisher".to_owned(),
                key_id: "1".repeat(64),
            },
            license: "MIT".to_owned(),
            junban_compatibility: "^0.1".to_owned(),
            wit: WitAuthority {
                package: "junban:plugin".to_owned(),
                world: "plugin".to_owned(),
                version: "0.1.0".to_owned(),
            },
            runtime_profile: RuntimeProfile::Rust,
            component_sha256: "2".repeat(64),
            permissions: vec![Permission {
                capability: Capability::Settings,
                scope: PermissionScope::Unscoped(UnscopedPermission {}),
            }],
            dependencies: Vec::new(),
            commands: Vec::new(),
            subscriptions: Vec::new(),
            surfaces: Vec::new(),
            settings: [
                ("break-minutes", 5, 1, 60),
                ("long-break-minutes", 15, 1, 60),
                ("sessions-before-long-break", 4, 1, 10),
                ("work-minutes", 25, 1, 120),
            ]
            .into_iter()
            .map(|(id, default, min, max)| SettingDeclaration {
                id: id.to_owned(),
                label: id.to_owned(),
                description: String::new(),
                schema: SettingSchema::Integer {
                    default,
                    min,
                    max,
                    step: 1,
                },
            })
            .collect(),
            services: Vec::new(),
        }
    }

    fn setting(key: &str, value: ManifestSettingValue) -> PluginSetting {
        PluginSetting {
            key: PluginId::parse(key).unwrap(),
            value,
            updated_at: "2026-08-04T15:00:00Z".parse().unwrap(),
        }
    }

    fn effective_integer_values(values: SettingValues) -> Vec<(String, i64)> {
        values
            .values
            .into_iter()
            .map(|setting| match setting.value {
                GuestSettingValue::Integer(value) => (setting.id, value),
                other => panic!("unexpected effective value {other:?}"),
            })
            .collect()
    }

    #[test]
    fn manifest_setting_defaults_cover_every_persistable_schema_type() {
        assert_eq!(
            manifest_setting_default(&SettingSchema::Text {
                default: "text".to_owned(),
                min_bytes: 0,
                max_bytes: 16,
                secret: false,
            }),
            Some(ManifestSettingValue::Text("text".to_owned()))
        );
        assert_eq!(
            manifest_setting_default(&SettingSchema::Integer {
                default: 3,
                min: 1,
                max: 5,
                step: 1,
            }),
            Some(ManifestSettingValue::Integer(3))
        );
        assert_eq!(
            manifest_setting_default(&SettingSchema::Boolean { default: true }),
            Some(ManifestSettingValue::Boolean(true))
        );
        let select = SettingSchema::Select {
            default: "first".to_owned(),
            options: vec![SettingOption {
                id: "first".to_owned(),
                label: "First".to_owned(),
            }],
        };
        assert_eq!(
            manifest_setting_default(&select),
            Some(ManifestSettingValue::Text("first".to_owned()))
        );
        assert_eq!(
            guest_setting_value(&select, ManifestSettingValue::Text("first".to_owned())),
            Some(GuestSettingValue::OptionId("first".to_owned()))
        );
        assert_eq!(
            manifest_setting_default(&SettingSchema::Text {
                default: "secret".to_owned(),
                min_bytes: 0,
                max_bytes: 16,
                secret: true,
            }),
            None
        );
    }

    #[test]
    fn effective_candidate_settings_fill_defaults_overlay_prior_values_and_restore_on_delete() {
        let manifest = pomodoro_settings_manifest();
        let request_id = RequestId("settings-test".to_owned());
        let work = PluginId::parse("work-minutes").unwrap();
        let fresh = effective_candidate_settings(
            &manifest,
            &[],
            &work,
            Some(&ManifestSettingValue::Integer(30)),
            &request_id,
        )
        .unwrap();
        assert_eq!(
            effective_integer_values(fresh),
            [
                ("break-minutes".to_owned(), 5),
                ("long-break-minutes".to_owned(), 15),
                ("sessions-before-long-break".to_owned(), 4),
                ("work-minutes".to_owned(), 30),
            ]
        );

        let persisted = vec![
            setting("break-minutes", ManifestSettingValue::Integer(10)),
            setting("work-minutes", ManifestSettingValue::Integer(30)),
        ];
        let sessions = PluginId::parse("sessions-before-long-break").unwrap();
        let second = effective_candidate_settings(
            &manifest,
            &persisted,
            &sessions,
            Some(&ManifestSettingValue::Integer(6)),
            &request_id,
        )
        .unwrap();
        assert_eq!(
            effective_integer_values(second),
            [
                ("break-minutes".to_owned(), 10),
                ("long-break-minutes".to_owned(), 15),
                ("sessions-before-long-break".to_owned(), 6),
                ("work-minutes".to_owned(), 30),
            ]
        );

        let deleted =
            effective_candidate_settings(&manifest, &persisted, &work, None, &request_id).unwrap();
        assert_eq!(
            effective_integer_values(deleted),
            [
                ("break-minutes".to_owned(), 10),
                ("long-break-minutes".to_owned(), 15),
                ("sessions-before-long-break".to_owned(), 4),
                ("work-minutes".to_owned(), 25),
            ]
        );
    }

    #[test]
    fn effective_candidate_settings_reject_malformed_persisted_authority() {
        let manifest = pomodoro_settings_manifest();
        let request_id = RequestId("settings-test".to_owned());
        let work = PluginId::parse("work-minutes").unwrap();
        for persisted in [
            vec![
                setting("break-minutes", ManifestSettingValue::Integer(5)),
                setting("break-minutes", ManifestSettingValue::Integer(6)),
            ],
            vec![setting("unknown", ManifestSettingValue::Integer(5))],
            vec![setting(
                "break-minutes",
                ManifestSettingValue::Boolean(true),
            )],
        ] {
            let error = effective_candidate_settings(
                &manifest,
                &persisted,
                &work,
                Some(&ManifestSettingValue::Integer(30)),
                &request_id,
            )
            .unwrap_err();
            assert_eq!(error.status, StatusCode::CONFLICT);
            assert_eq!(
                error.envelope.error.code,
                "plugin_settings_authority_invalid"
            );
        }
    }

    #[test]
    fn effective_candidate_settings_fail_closed_for_secret_declarations() {
        let mut manifest = pomodoro_settings_manifest();
        manifest.settings[0].schema = SettingSchema::Text {
            default: "must-not-reach-guest".to_owned(),
            min_bytes: 0,
            max_bytes: 64,
            secret: true,
        };
        let request_id = RequestId("settings-test".to_owned());
        let error = effective_candidate_settings(
            &manifest,
            &[],
            &PluginId::parse("work-minutes").unwrap(),
            Some(&ManifestSettingValue::Integer(30)),
            &request_id,
        )
        .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(
            error.envelope.error.code,
            "plugin_settings_authority_invalid"
        );
    }

    #[test]
    fn installed_plugin_dto_projects_concrete_manifest_setting_authority() {
        let secret_default = "package-secret-default";
        let manifest = RuntimeManifest {
            schema_version: 1,
            id: "settings-plugin".to_owned(),
            name: "Settings plugin".to_owned(),
            description: "Exercises installed setting declarations".to_owned(),
            version: "1.0.0".to_owned(),
            publisher: Publisher {
                id: "publisher".to_owned(),
                name: "Publisher".to_owned(),
                key_id: "1".repeat(64),
            },
            license: "MIT".to_owned(),
            junban_compatibility: "^0.1".to_owned(),
            wit: WitAuthority {
                package: "junban:plugin".to_owned(),
                world: "plugin".to_owned(),
                version: "0.1.0".to_owned(),
            },
            runtime_profile: RuntimeProfile::Rust,
            component_sha256: "2".repeat(64),
            permissions: Vec::new(),
            dependencies: Vec::new(),
            commands: Vec::new(),
            subscriptions: Vec::new(),
            surfaces: Vec::new(),
            settings: vec![
                SettingDeclaration {
                    id: "visible-text".to_owned(),
                    label: "Visible text".to_owned(),
                    description: "Visible default".to_owned(),
                    schema: SettingSchema::Text {
                        default: "hello".to_owned(),
                        min_bytes: 1,
                        max_bytes: 32,
                        secret: false,
                    },
                },
                SettingDeclaration {
                    id: "secret-text".to_owned(),
                    label: "Secret text".to_owned(),
                    description: "Secret input metadata".to_owned(),
                    schema: SettingSchema::Text {
                        default: secret_default.to_owned(),
                        min_bytes: 0,
                        max_bytes: 128,
                        secret: true,
                    },
                },
                SettingDeclaration {
                    id: "integer".to_owned(),
                    label: "Integer".to_owned(),
                    description: String::new(),
                    schema: SettingSchema::Integer {
                        default: 3,
                        min: 1,
                        max: 9,
                        step: 2,
                    },
                },
                SettingDeclaration {
                    id: "boolean".to_owned(),
                    label: "Boolean".to_owned(),
                    description: String::new(),
                    schema: SettingSchema::Boolean { default: true },
                },
                SettingDeclaration {
                    id: "select".to_owned(),
                    label: "Select".to_owned(),
                    description: String::new(),
                    schema: SettingSchema::Select {
                        default: "first".to_owned(),
                        options: vec![SettingOption {
                            id: "first".to_owned(),
                            label: "First".to_owned(),
                        }],
                    },
                },
            ],
            services: Vec::new(),
        };
        let plugin = InstalledPlugin {
            plugin_id: PluginId::parse("settings-plugin").unwrap(),
            manifest,
            version: "1.0.0".to_owned(),
            package_sha256: Sha256Digest::parse("3".repeat(64)).unwrap(),
            component_sha256: Sha256Digest::parse("2".repeat(64)).unwrap(),
            publisher_key_id: Sha256Digest::parse("1".repeat(64)).unwrap(),
            package_generation: 7,
            activation_epoch: 4,
            desired_enabled: true,
            runtime_state: PluginRuntimeState::Active,
            granted_capabilities: Vec::new(),
            dependencies_satisfied: true,
            failure_count: 0,
            last_error_code: None,
            next_retry_at: None,
            installed_at: "2026-08-04T15:00:00Z".parse().unwrap(),
            updated_at: "2026-08-04T15:00:00Z".parse().unwrap(),
        };

        let value = serde_json::to_value(installed_dto(&plugin)).unwrap();
        assert_eq!(
            value["settings"],
            serde_json::json!([
                {
                    "id": "visible-text",
                    "label": "Visible text",
                    "description": "Visible default",
                    "schema": {
                        "type": "text",
                        "default": "hello",
                        "min_bytes": 1,
                        "max_bytes": 32,
                        "secret": false
                    }
                },
                {
                    "id": "secret-text",
                    "label": "Secret text",
                    "description": "Secret input metadata",
                    "schema": {
                        "type": "text",
                        "min_bytes": 0,
                        "max_bytes": 128,
                        "secret": true
                    }
                },
                {
                    "id": "integer",
                    "label": "Integer",
                    "description": "",
                    "schema": { "type": "integer", "default": 3, "min": 1, "max": 9, "step": 2 }
                },
                {
                    "id": "boolean",
                    "label": "Boolean",
                    "description": "",
                    "schema": { "type": "boolean", "default": true }
                },
                {
                    "id": "select",
                    "label": "Select",
                    "description": "",
                    "schema": {
                        "type": "select",
                        "default": "first",
                        "options": [{ "id": "first", "label": "First" }]
                    }
                }
            ])
        );
        assert!(!value.to_string().contains(secret_default));
    }

    #[test]
    fn durable_invocation_projection_is_byte_stable_for_every_public_outcome() {
        let mut mutation = committed(
            PluginInvocationPublicOutcome::Completed,
            PluginInvocationTerminalKind::DomainEffect,
        );
        mutation.mutation = Some(CommittedMutation {
            event: CommittedEvent {
                revision: 42,
                operation_id: OperationId::new(),
                event_type: EventType::new(EventType::TASK_UPDATED),
                occurred_at: Timestamp::now(),
                primary: None,
                snapshot: None,
                affected: AffectedIds::default(),
                resync: ResyncScope::NONE,
            },
            uncomplete_outcome: None,
            newly_committed: false,
        });
        assert_initial_and_replay_bytes(
            mutation,
            serde_json::json!({
                "status": "completed",
                "terminal_kind": "domaineffect",
                "revision": 42,
                "rejection": null
            }),
        );

        // Effect-free success durably terminalizes as a read-only receipt.
        assert_initial_and_replay_bytes(
            committed(
                PluginInvocationPublicOutcome::Completed,
                PluginInvocationTerminalKind::ReadOnly,
            ),
            serde_json::json!({
                "status": "completed",
                "terminal_kind": "readonly",
                "revision": null,
                "rejection": null
            }),
        );

        let mut rejection = committed(
            PluginInvocationPublicOutcome::InvalidOutput,
            PluginInvocationTerminalKind::DomainEffect,
        );
        rejection.rejection = Some(PluginGuestEffectRejection::Validation);
        assert_initial_and_replay_bytes(
            rejection,
            serde_json::json!({
                "status": "failed",
                "terminal_kind": "domaineffect",
                "revision": null,
                "rejection": "invalidoutput"
            }),
        );

        for (outcome, status, rejection) in [
            (PluginInvocationPublicOutcome::Cancelled, "cancelled", None),
            (
                PluginInvocationPublicOutcome::GuestTrap,
                "failed",
                Some("guesttrap"),
            ),
            (
                PluginInvocationPublicOutcome::Timeout,
                "failed",
                Some("timeout"),
            ),
            (
                PluginInvocationPublicOutcome::ResourceLimit,
                "failed",
                Some("resourcelimit"),
            ),
            (
                PluginInvocationPublicOutcome::InvalidOutput,
                "failed",
                Some("invalidoutput"),
            ),
        ] {
            assert_initial_and_replay_bytes(
                committed(outcome, PluginInvocationTerminalKind::ReadOnly),
                serde_json::json!({
                    "status": status,
                    "terminal_kind": "readonly",
                    "revision": null,
                    "rejection": rejection
                }),
            );
        }
    }

    #[test]
    fn successful_runtime_outcome_cannot_bypass_durable_projection() {
        let request_id = RequestId("projection-test".to_owned());
        let outcome = InvocationOutcome::Completed(Box::new(
            GuestInvocationOutcome::InvokeCommand(WitResult::Ok(PluginOutcome { effect: None })),
        ));
        for outcome in [
            outcome,
            InvocationOutcome::Cancelled,
            InvocationOutcome::Failed(crate::plugin_runtime::InvocationFailure::GuestTrap),
        ] {
            let error = reject_non_durable_invocation_terminal(outcome, &request_id).unwrap_err();
            assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        }
    }
}
