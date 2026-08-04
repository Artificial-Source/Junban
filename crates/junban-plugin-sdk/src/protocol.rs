//! Pure private parent↔selected-child protocol authority.
//!
//! Headers are canonical JSON prefixed by one u32be length. Component, invocation,
//! outcome, and capability payloads follow as unencoded raw bodies whose exact
//! length and SHA-256 are in the header. There is no token, profile/DB path,
//! generic method name, JSON byte array, or process/runtime construction here.

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    error::{Result, SdkError},
    manifest::{Capability, Permission, RuntimeProfile},
    permission::permission_set_hash,
    util::{decode_hex_32, hex, is_canonical_id, sha256},
};

pub const HOST_PROTOCOL_VERSION: u16 = 1;
pub const HOST_FRAME_BYTES_MAX: usize = 256 * 1024;
pub const HOST_COMPONENT_BODY_BYTES_MAX: usize = crate::package::COMPONENT_BYTES_MAX;
pub const HOST_REQUEST_BODY_BYTES_MAX: usize = 256 * 1024;
pub const HOST_OUTCOME_BODY_BYTES_MAX: usize = 256 * 1024;
pub const HOST_CALLBACK_BODY_BYTES_MAX: usize = 4 * 1024 * 1024;
pub const HOST_CALLBACK_ID_MAX: u32 = 1_048_576;
pub const HOST_PROTOCOL_NAME: &str = "junban-plugin-host-v1";

pub const RUST_LINEAR_MEMORY_BYTES: u64 = 64 * 1024 * 1024;
pub const TYPESCRIPT_LINEAR_MEMORY_BYTES: u64 = 128 * 1024 * 1024;
pub const GUEST_STACK_BYTES: u64 = 2 * 1024 * 1024;
pub const TABLE_ELEMENTS_MAX: u32 = 10_000;
pub const COMPILE_TIMEOUT_MS: u32 = 10_000;
pub const COMMAND_TIMEOUT_MS: u32 = 1_000;
pub const EVENT_RENDER_TIMEOUT_MS: u32 = 250;
pub const HTTP_TIMEOUT_MS: u32 = 5_000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorityFence {
    pub plugin_id: String,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub host_session_id: String,
    pub invocation_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CallbackFence {
    pub plugin_id: String,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub host_session_id: String,
    pub invocation_id: String,
    pub callback_id: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InvocationKind {
    Activate,
    Deactivate,
    InvokeCommand,
    HandleEvent,
    RenderSurface,
    HandleSurfaceAction,
    ValidateSettings,
    Resync,
    CallService,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InvocationMode {
    Lifecycle,
    Effect,
    Render,
    ValidateSettings,
    Resync,
    Service,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostCallKind {
    QueryTasks,
    QueryProjects,
    QueryTags,
    GetSettings,
    GetKv,
    ListKv,
    WallNow,
    MonotonicMs,
    HttpRequest,
    Log,
    CallService,
}

pub const HOST_CALL_KINDS: &[HostCallKind] = &[
    HostCallKind::QueryTasks,
    HostCallKind::QueryProjects,
    HostCallKind::QueryTags,
    HostCallKind::GetSettings,
    HostCallKind::GetKv,
    HostCallKind::ListKv,
    HostCallKind::WallNow,
    HostCallKind::MonotonicMs,
    HostCallKind::HttpRequest,
    HostCallKind::Log,
    HostCallKind::CallService,
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityReplyKind {
    Success,
    Error,
    Cancelled,
}

/// Frozen store/invocation numeric authority. A load may not negotiate these.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeLimits {
    pub linear_memory_bytes: u64,
    pub guest_stack_bytes: u64,
    pub table_elements: u32,
    pub memories: u8,
    pub tables: u8,
    pub instances: u8,
    pub hostcall_copy_bytes: u32,
    pub output_bytes: u32,
    pub compile_timeout_ms: u32,
    pub command_timeout_ms: u32,
    pub event_render_timeout_ms: u32,
    pub http_timeout_ms: u32,
}

impl RuntimeLimits {
    #[must_use]
    pub const fn for_profile(profile: RuntimeProfile) -> Self {
        Self {
            linear_memory_bytes: match profile {
                RuntimeProfile::Rust => RUST_LINEAR_MEMORY_BYTES,
                RuntimeProfile::Typescript => TYPESCRIPT_LINEAR_MEMORY_BYTES,
            },
            guest_stack_bytes: GUEST_STACK_BYTES,
            table_elements: TABLE_ELEMENTS_MAX,
            memories: 1,
            tables: 1,
            instances: 1,
            hostcall_copy_bytes: HOST_CALLBACK_BODY_BYTES_MAX as u32,
            output_bytes: HOST_OUTCOME_BODY_BYTES_MAX as u32,
            compile_timeout_ms: COMPILE_TIMEOUT_MS,
            command_timeout_ms: COMMAND_TIMEOUT_MS,
            event_render_timeout_ms: EVENT_RENDER_TIMEOUT_MS,
            http_timeout_ms: HTTP_TIMEOUT_MS,
        }
    }

    pub fn validate(&self, profile: RuntimeProfile) -> Result<()> {
        if *self == Self::for_profile(profile) {
            Ok(())
        } else {
            Err(SdkError::Protocol {
                field: "runtime_limits",
            })
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ParentFrame {
    Hello {
        protocol_version: u16,
        host_session_id: String,
    },
    Load {
        fence: AuthorityFence,
        package_sha256: String,
        component_sha256: String,
        runtime_profile: RuntimeProfile,
        component_size: u64,
        grants: Vec<Permission>,
        permission_hash: String,
        limits: RuntimeLimits,
    },
    Invoke {
        fence: AuthorityFence,
        kind: InvocationKind,
        mode: InvocationMode,
        permission_hash: String,
        request_sha256: String,
        request_size: u32,
    },
    CapabilityReply {
        callback: CallbackFence,
        kind: HostCallKind,
        result: CapabilityReplyKind,
        response_sha256: String,
        response_size: u32,
    },
    Cancel {
        fence: AuthorityFence,
    },
    Unload {
        fence: AuthorityFence,
    },
    Shutdown {
        host_session_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChildFrame {
    Hello {
        protocol_version: u16,
        host_session_id: String,
    },
    Loaded {
        fence: AuthorityFence,
        import_export_fingerprint: String,
    },
    CapabilityRequest {
        callback: CallbackFence,
        kind: HostCallKind,
        request_sha256: String,
        request_size: u32,
    },
    Outcome {
        fence: AuthorityFence,
        outcome_sha256: String,
        outcome_size: u32,
    },
    Cancelled {
        fence: AuthorityFence,
    },
    Failed {
        fence: AuthorityFence,
        code: HostFailureCode,
    },
    Unloaded {
        fence: AuthorityFence,
    },
    ShutdownComplete {
        host_session_id: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostFailureCode {
    InvalidFrame,
    StaleAuthority,
    InvalidPackage,
    InvalidComponent,
    PermissionDenied,
    ResourceLimit,
    Timeout,
    Cancelled,
    GuestError,
    Unavailable,
    Internal,
}

impl AuthorityFence {
    pub fn validate(&self) -> Result<()> {
        if !is_canonical_id(&self.plugin_id) {
            return Err(SdkError::Protocol { field: "plugin_id" });
        }
        if self.package_generation == 0 {
            return Err(SdkError::Protocol {
                field: "package_generation",
            });
        }
        if self.activation_epoch == 0 {
            return Err(SdkError::Protocol {
                field: "activation_epoch",
            });
        }
        validate_uuid(&self.host_session_id, "host_session_id")?;
        validate_uuid(&self.invocation_id, "invocation_id")?;
        Ok(())
    }

    #[must_use]
    pub fn exact_matches(&self, current: &Self) -> bool {
        self == current
    }

    #[must_use]
    pub fn same_activation(&self, current: &Self) -> bool {
        self.plugin_id == current.plugin_id
            && self.package_generation == current.package_generation
            && self.activation_epoch == current.activation_epoch
            && self.host_session_id == current.host_session_id
    }
}

impl CallbackFence {
    pub fn authority(&self) -> AuthorityFence {
        AuthorityFence {
            plugin_id: self.plugin_id.clone(),
            package_generation: self.package_generation,
            activation_epoch: self.activation_epoch,
            host_session_id: self.host_session_id.clone(),
            invocation_id: self.invocation_id.clone(),
        }
    }

    pub fn validate(&self) -> Result<()> {
        self.authority().validate()?;
        if self.callback_id == 0 || self.callback_id > HOST_CALLBACK_ID_MAX {
            return Err(SdkError::Protocol {
                field: "callback_id",
            });
        }
        Ok(())
    }

    #[must_use]
    pub fn exact_matches(&self, current: &Self) -> bool {
        self == current
    }
}

impl InvocationKind {
    #[must_use]
    pub const fn mode(self) -> InvocationMode {
        match self {
            Self::Activate | Self::Deactivate => InvocationMode::Lifecycle,
            Self::InvokeCommand | Self::HandleEvent | Self::HandleSurfaceAction => {
                InvocationMode::Effect
            }
            Self::RenderSurface => InvocationMode::Render,
            Self::ValidateSettings => InvocationMode::ValidateSettings,
            Self::Resync => InvocationMode::Resync,
            Self::CallService => InvocationMode::Service,
        }
    }
}

impl HostCallKind {
    #[must_use]
    pub const fn capability(self) -> Option<Capability> {
        match self {
            Self::QueryTasks => Some(Capability::TasksRead),
            Self::QueryProjects => Some(Capability::ProjectsRead),
            Self::QueryTags => Some(Capability::TagsRead),
            Self::GetSettings => Some(Capability::Settings),
            Self::GetKv | Self::ListKv => Some(Capability::Storage),
            Self::WallNow | Self::MonotonicMs => None,
            Self::HttpRequest => Some(Capability::Http),
            Self::Log => Some(Capability::Logging),
            Self::CallService => Some(Capability::ServicesConsume),
        }
    }

    #[must_use]
    pub const fn allowed_in(self, mode: InvocationMode) -> bool {
        match mode {
            InvocationMode::Lifecycle => matches!(
                self,
                Self::GetSettings
                    | Self::GetKv
                    | Self::ListKv
                    | Self::WallNow
                    | Self::MonotonicMs
                    | Self::Log
            ),
            InvocationMode::Effect => true,
            InvocationMode::Render | InvocationMode::Service => !matches!(self, Self::HttpRequest),
            InvocationMode::ValidateSettings => {
                matches!(self, Self::WallNow | Self::MonotonicMs | Self::Log)
            }
            InvocationMode::Resync => matches!(
                self,
                Self::GetSettings
                    | Self::GetKv
                    | Self::ListKv
                    | Self::WallNow
                    | Self::MonotonicMs
                    | Self::Log
            ),
        }
    }
}

/// Check the exact mode row and current load-time grant. Scoped HTTP/service
/// values remain in the canonical grant list for the parent to exact-match
/// against the typed callback body; this function never broadens a scope.
pub fn validate_host_call_authority(
    kind: HostCallKind,
    mode: InvocationMode,
    grants: &[Permission],
) -> Result<()> {
    permission_set_hash(grants)?;
    if !kind.allowed_in(mode)
        || kind.capability().is_some_and(|required| {
            !grants
                .iter()
                .any(|permission| permission.capability == required)
        })
    {
        return Err(SdkError::Protocol {
            field: "host_call_authority",
        });
    }
    Ok(())
}

pub fn validate_permission_hash(grants: &[Permission], encoded_hash: &str) -> Result<()> {
    let actual = permission_set_hash(grants).map_err(|_| SdkError::Protocol { field: "grants" })?;
    if decode_hex_32(encoded_hash, "permission_hash")? != actual {
        return Err(SdkError::Protocol {
            field: "permission_hash",
        });
    }
    Ok(())
}

/// Bind one invoke and its host-call request to the exact loaded activation and
/// grant set. The load operation and guest invocation have distinct invocation
/// IDs, while plugin/generation/epoch/session authority must remain identical.
pub fn validate_capability_request_authority(
    load: &ParentFrame,
    invoke: &ParentFrame,
    request: &ChildFrame,
) -> Result<()> {
    validate_parent_frame(load)?;
    validate_parent_frame(invoke)?;
    validate_child_frame(request)?;
    let ParentFrame::Load {
        fence: load_fence,
        grants,
        permission_hash: loaded_hash,
        ..
    } = load
    else {
        return Err(SdkError::Protocol { field: "load" });
    };
    let ParentFrame::Invoke {
        fence: invoke_fence,
        mode,
        permission_hash: invoke_hash,
        ..
    } = invoke
    else {
        return Err(SdkError::Protocol { field: "invoke" });
    };
    let ChildFrame::CapabilityRequest { callback, kind, .. } = request else {
        return Err(SdkError::Protocol {
            field: "callback_request",
        });
    };
    if !load_fence.same_activation(invoke_fence)
        || loaded_hash != invoke_hash
        || !callback.authority().exact_matches(invoke_fence)
    {
        return Err(SdkError::Protocol {
            field: "loaded_authority",
        });
    }
    validate_permission_hash(grants, invoke_hash)?;
    validate_host_call_authority(*kind, *mode, grants)
}

pub fn validate_callback_correlation(
    expected_fence: &AuthorityFence,
    expected_callback_id: u32,
    callback: &CallbackFence,
) -> Result<()> {
    callback.validate()?;
    if !callback.authority().exact_matches(expected_fence)
        || callback.callback_id != expected_callback_id
    {
        return Err(SdkError::Protocol {
            field: "callback_correlation",
        });
    }
    Ok(())
}

/// Exact-match one reply to the outstanding closed-kind callback request.
pub fn validate_failed_correlation(
    failure: &ChildFrame,
    current_fence: &AuthorityFence,
) -> Result<()> {
    let ChildFrame::Failed { fence, .. } = failure else {
        return Err(SdkError::Protocol {
            field: "failure_frame",
        });
    };
    fence.validate()?;
    if !fence.exact_matches(current_fence) {
        return Err(SdkError::Protocol {
            field: "failure_correlation",
        });
    }
    Ok(())
}

pub fn validate_capability_reply(
    request: &ChildFrame,
    reply: &ParentFrame,
    current_fence: &AuthorityFence,
) -> Result<()> {
    let ChildFrame::CapabilityRequest {
        callback: requested,
        kind: requested_kind,
        ..
    } = request
    else {
        return Err(SdkError::Protocol {
            field: "callback_request",
        });
    };
    let ParentFrame::CapabilityReply {
        callback: replied,
        kind: replied_kind,
        ..
    } = reply
    else {
        return Err(SdkError::Protocol {
            field: "callback_reply",
        });
    };
    validate_callback_correlation(current_fence, requested.callback_id, requested)?;
    validate_callback_correlation(current_fence, requested.callback_id, replied)?;
    if requested != replied || requested_kind != replied_kind {
        return Err(SdkError::Protocol {
            field: "callback_correlation",
        });
    }
    Ok(())
}

fn encode_frame<T: Serialize>(frame: &T) -> Result<Vec<u8>> {
    let payload = serde_json::to_vec(frame).map_err(|_| SdkError::Protocol { field: "json" })?;
    if payload.is_empty() || payload.len() > HOST_FRAME_BYTES_MAX {
        return Err(SdkError::Protocol { field: "length" });
    }
    let mut encoded = Vec::with_capacity(4 + payload.len());
    encoded.extend_from_slice(
        &u32::try_from(payload.len())
            .map_err(|_| SdkError::Protocol { field: "length" })?
            .to_be_bytes(),
    );
    encoded.extend_from_slice(&payload);
    Ok(encoded)
}

fn decode_frame<T: DeserializeOwned + Serialize>(bytes: &[u8]) -> Result<T> {
    if bytes.len() < 4 {
        return Err(SdkError::Protocol { field: "truncated" });
    }
    let payload_len = usize::try_from(u32::from_be_bytes(
        bytes[..4]
            .try_into()
            .map_err(|_| SdkError::Protocol { field: "truncated" })?,
    ))
    .map_err(|_| SdkError::Protocol { field: "length" })?;
    if payload_len == 0 || payload_len > HOST_FRAME_BYTES_MAX {
        return Err(SdkError::Protocol { field: "length" });
    }
    let expected = 4_usize
        .checked_add(payload_len)
        .ok_or(SdkError::Protocol { field: "length" })?;
    if bytes.len() != expected {
        return Err(SdkError::Protocol { field: "length" });
    }
    let value: T =
        serde_json::from_slice(&bytes[4..]).map_err(|_| SdkError::Protocol { field: "json" })?;
    if serde_json::to_vec(&value).map_err(|_| SdkError::Protocol { field: "json" })? != bytes[4..] {
        return Err(SdkError::Protocol {
            field: "canonical json",
        });
    }
    Ok(value)
}

pub fn encode_parent_frame(frame: &ParentFrame) -> Result<Vec<u8>> {
    validate_parent_frame(frame)?;
    encode_frame(frame)
}

pub fn encode_child_frame(frame: &ChildFrame) -> Result<Vec<u8>> {
    validate_child_frame(frame)?;
    encode_frame(frame)
}

pub fn decode_parent_frame(bytes: &[u8]) -> Result<ParentFrame> {
    let frame = decode_frame(bytes)?;
    validate_parent_frame(&frame)?;
    Ok(frame)
}

pub fn decode_child_frame(bytes: &[u8]) -> Result<ChildFrame> {
    let frame = decode_frame(bytes)?;
    validate_child_frame(&frame)?;
    Ok(frame)
}

pub fn validate_parent_frame(frame: &ParentFrame) -> Result<()> {
    match frame {
        ParentFrame::Hello {
            protocol_version,
            host_session_id,
        } => {
            validate_version(*protocol_version)?;
            validate_uuid(host_session_id, "host_session_id")
        }
        ParentFrame::Load {
            fence,
            package_sha256,
            component_sha256,
            runtime_profile,
            component_size,
            grants,
            permission_hash,
            limits,
        } => {
            fence.validate()?;
            decode_hex_32(package_sha256, "package_sha256")?;
            decode_hex_32(component_sha256, "component_sha256")?;
            if *component_size == 0 || *component_size > HOST_COMPONENT_BODY_BYTES_MAX as u64 {
                return Err(SdkError::Protocol {
                    field: "component_size",
                });
            }
            validate_permission_hash(grants, permission_hash)?;
            limits.validate(*runtime_profile)
        }
        ParentFrame::Invoke {
            fence,
            kind,
            mode,
            permission_hash,
            request_sha256,
            request_size,
        } => {
            fence.validate()?;
            if kind.mode() != *mode {
                return Err(SdkError::Protocol {
                    field: "invocation_mode",
                });
            }
            decode_hex_32(permission_hash, "permission_hash")?;
            validate_sized_hash(
                request_sha256,
                usize::try_from(*request_size).unwrap_or(usize::MAX),
                HOST_REQUEST_BODY_BYTES_MAX,
                false,
                "request_size",
            )
        }
        ParentFrame::CapabilityReply {
            callback,
            kind: _,
            result,
            response_sha256,
            response_size,
        } => {
            callback.validate()?;
            if *result == CapabilityReplyKind::Cancelled && *response_size != 0 {
                return Err(SdkError::Protocol {
                    field: "cancelled_response_size",
                });
            }
            validate_sized_hash(
                response_sha256,
                usize::try_from(*response_size).unwrap_or(usize::MAX),
                HOST_CALLBACK_BODY_BYTES_MAX,
                true,
                "response_size",
            )
        }
        ParentFrame::Cancel { fence } | ParentFrame::Unload { fence } => fence.validate(),
        ParentFrame::Shutdown { host_session_id } => {
            validate_uuid(host_session_id, "host_session_id")
        }
    }
}

pub fn validate_child_frame(frame: &ChildFrame) -> Result<()> {
    match frame {
        ChildFrame::Hello {
            protocol_version,
            host_session_id,
        } => {
            validate_version(*protocol_version)?;
            validate_uuid(host_session_id, "host_session_id")
        }
        ChildFrame::Loaded {
            fence,
            import_export_fingerprint,
        } => {
            fence.validate()?;
            decode_hex_32(import_export_fingerprint, "import_export_fingerprint")?;
            Ok(())
        }
        ChildFrame::CapabilityRequest {
            callback,
            request_sha256,
            request_size,
            ..
        } => {
            callback.validate()?;
            validate_sized_hash(
                request_sha256,
                usize::try_from(*request_size).unwrap_or(usize::MAX),
                HOST_CALLBACK_BODY_BYTES_MAX,
                true,
                "callback_request_size",
            )
        }
        ChildFrame::Outcome {
            fence,
            outcome_sha256,
            outcome_size,
        } => {
            fence.validate()?;
            validate_sized_hash(
                outcome_sha256,
                usize::try_from(*outcome_size).unwrap_or(usize::MAX),
                HOST_OUTCOME_BODY_BYTES_MAX,
                false,
                "outcome_size",
            )
        }
        ChildFrame::Cancelled { fence }
        | ChildFrame::Failed { fence, .. }
        | ChildFrame::Unloaded { fence } => fence.validate(),
        ChildFrame::ShutdownComplete { host_session_id } => {
            validate_uuid(host_session_id, "host_session_id")
        }
    }
}

fn validate_sized_hash(
    encoded_hash: &str,
    size: usize,
    maximum: usize,
    empty_allowed: bool,
    size_field: &'static str,
) -> Result<()> {
    decode_hex_32(encoded_hash, "body_sha256")?;
    if (!empty_allowed && size == 0) || size > maximum {
        return Err(SdkError::Protocol { field: size_field });
    }
    Ok(())
}

/// Return the exact raw body length required immediately after a parent header.
pub fn parent_body_len(frame: &ParentFrame) -> Result<usize> {
    validate_parent_frame(frame)?;
    match frame {
        ParentFrame::Load { component_size, .. } => {
            usize::try_from(*component_size).map_err(|_| SdkError::Protocol {
                field: "component_size",
            })
        }
        ParentFrame::Invoke { request_size, .. } => Ok(*request_size as usize),
        ParentFrame::CapabilityReply { response_size, .. } => Ok(*response_size as usize),
        ParentFrame::Hello { .. }
        | ParentFrame::Cancel { .. }
        | ParentFrame::Unload { .. }
        | ParentFrame::Shutdown { .. } => Ok(0),
    }
}

/// Return the exact raw body length required immediately after a child header.
pub fn child_body_len(frame: &ChildFrame) -> Result<usize> {
    validate_child_frame(frame)?;
    match frame {
        ChildFrame::CapabilityRequest { request_size, .. } => Ok(*request_size as usize),
        ChildFrame::Outcome { outcome_size, .. } => Ok(*outcome_size as usize),
        ChildFrame::Hello { .. }
        | ChildFrame::Loaded { .. }
        | ChildFrame::Cancelled { .. }
        | ChildFrame::Failed { .. }
        | ChildFrame::Unloaded { .. }
        | ChildFrame::ShutdownComplete { .. } => Ok(0),
    }
}

/// Validate a caller-owned parent body without copying or encoding it.
pub fn validate_parent_body(frame: &ParentFrame, body: &[u8]) -> Result<()> {
    let expected_len = parent_body_len(frame)?;
    let expected_hash = match frame {
        ParentFrame::Load {
            component_sha256, ..
        } => Some(component_sha256.as_str()),
        ParentFrame::Invoke { request_sha256, .. } => Some(request_sha256.as_str()),
        ParentFrame::CapabilityReply {
            response_sha256, ..
        } => Some(response_sha256.as_str()),
        ParentFrame::Hello { .. }
        | ParentFrame::Cancel { .. }
        | ParentFrame::Unload { .. }
        | ParentFrame::Shutdown { .. } => None,
    };
    validate_body(expected_len, expected_hash, body)
}

/// Validate a caller-owned child body without copying or encoding it.
pub fn validate_child_body(frame: &ChildFrame, body: &[u8]) -> Result<()> {
    let expected_len = child_body_len(frame)?;
    let expected_hash = match frame {
        ChildFrame::CapabilityRequest { request_sha256, .. } => Some(request_sha256.as_str()),
        ChildFrame::Outcome { outcome_sha256, .. } => Some(outcome_sha256.as_str()),
        ChildFrame::Hello { .. }
        | ChildFrame::Loaded { .. }
        | ChildFrame::Cancelled { .. }
        | ChildFrame::Failed { .. }
        | ChildFrame::Unloaded { .. }
        | ChildFrame::ShutdownComplete { .. } => None,
    };
    validate_body(expected_len, expected_hash, body)
}

fn validate_body(expected_len: usize, expected_hash: Option<&str>, body: &[u8]) -> Result<()> {
    if body.len() != expected_len {
        return Err(SdkError::Protocol {
            field: "body length",
        });
    }
    if let Some(encoded_hash) = expected_hash
        && decode_hex_32(encoded_hash, "body_sha256")? != sha256(body)
    {
        return Err(SdkError::Protocol { field: "body hash" });
    }
    Ok(())
}

#[must_use]
pub fn canonical_permission_hash(grants: &[Permission]) -> Option<String> {
    permission_set_hash(grants).ok().map(|hash| hex(&hash))
}

fn validate_version(version: u16) -> Result<()> {
    if version == HOST_PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(SdkError::Protocol { field: "version" })
    }
}

fn validate_uuid(value: &str, field: &'static str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value).map_err(|_| SdkError::Protocol { field })?;
    if parsed.hyphenated().to_string() != value {
        return Err(SdkError::Protocol { field });
    }
    Ok(())
}
